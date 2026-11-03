import { verificationKey } from "./mail-verification.js";
import { MailFiles } from "./mail-files.js";
import { RemoteStorage } from "./remote-storage.js";
import { RemoteDrafts } from "./remote-drafts.js";
import { ArchiveStore } from "./archive-store.js";
import { ArchiveCrypto } from "./archive-crypto.js";
import { ArchiveReader } from "./archive-reader.js";
import { ArchiveSync } from "./archive-sync.js";
import { MailBroker } from "./mail-broker.js";
import { BrokerMailFacade } from "./broker-facade.js";
import { mailRoute, jsonBody, reply, bodyLimit, bearer } from "./mail-protocol.js";
import { CredentialLeases } from "./credential-leases.js";
import { Operations } from "./operations.js";
import { AuthService, newToken } from "./auth.js";
import { PushService } from "./push.js";
import { DeviceService } from "./devices.js";
import { MailSender } from "./sender.js";
import { MailReader } from "./reader.js";
import { HealthService } from "./health.js";
import { MailService } from "./mail.js";
import { Database } from "./database.js";
import { liveDeviceOwners } from "./queries.js";
import { fail } from "./errors.js";
import {
  SECOND,
  MINUTE,
  HOUR,
  DAY,
  OUTBOX_RETENTION,
  LOGIN_ATTEMPTS_PER_MINUTE,
} from "./limits.js";
import { consoleFiles } from "./routes/static.js";
import { signInRoutes, sessionRoutes, isSessionRoute } from "./routes/auth.js";
import { clientRoutes } from "./routes/client.js";
import { accountRoutes } from "./routes/accounts.js";
import { adminRoutes } from "./routes/admin.js";
import { mailRoutes } from "./routes/mail.js";
import { controlMailContext } from "./routes/control-mail.js";
import http from "node:http";
import ipaddr from "ipaddr.js";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Behind the bundled edge proxy every request arrives from the proxy's address, so per-address limits
// would be shared by every client. TRUSTED_PROXY_HOPS counts the proxies that append to X-Forwarded-For;
// the client is the entry that many places from the right. IPv6 clients are grouped by /64.
const proxyHops = (() => {
  const value = Number(process.env.TRUSTED_PROXY_HOPS || 0);
  if (!Number.isInteger(value) || value < 0 || value > 5)
    throw Error("TRUSTED_PROXY_HOPS must be an integer from 0 to 5");
  return value;
})();
export function clientAddress(req, hops = 0) {
  let address = req.socket?.remoteAddress || "";
  if (hops > 0) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = forwarded[forwarded.length - hops];
    if (candidate && ipaddr.isValid(candidate)) address = candidate;
  }
  if (!ipaddr.isValid(address)) return address;
  const parsed = ipaddr.process(address);
  return parsed.kind() === "ipv6"
    ? parsed.toNormalizedString().split(":").slice(0, 4).join(":") + "::/64"
    : parsed.toString();
}

// Rows that can no longer be used. Send records stay 90 days for idempotent retries and are kept while a
// draft still waits on them.
export async function sweepExpired(db, auth, now = Date.now()) {
  await auth.sweep(now);
  await db
    .prepare(
      `DELETE FROM outbox WHERE created<? AND state IN ('sent','partial','failed','expired','unknown')
    AND NOT EXISTS (SELECT 1 FROM remote_drafts d WHERE d.send_id=outbox.id AND d.deleted_at IS NULL)`,
    )
    .run(now - OUTBOX_RETENTION);
}

// Sign-in attempts per client address and minute. Windows are created in time order, so expired ones sit at
// the front and are evicted on every call; the table is also capped, oldest first, so a burst from many
// distinct addresses cannot grow it without bound.
const TRACKED_ADDRESSES = 10000;
function loginLimiter(now = Date.now) {
  const attempts = new Map();
  return (req) => {
    const ip = clientAddress(req, proxyHops),
      at = now();
    for (const [key, row] of attempts) {
      if (row.until > at) break;
      attempts.delete(key);
    }
    let row = attempts.get(ip);
    if (!row) {
      while (attempts.size >= TRACKED_ADDRESSES) attempts.delete(attempts.keys().next().value);
      row = { count: 0, until: at + MINUTE };
      attempts.set(ip, row);
    }
    if (++row.count > LOGIN_ATTEMPTS_PER_MINUTE) fail(429, "Try again later");
  };
}

export async function createApp({
  databaseUrl = process.env.DATABASE_URL,
  databaseSchema = process.env.DATABASE_SCHEMA || "public",
  dataDir = process.env.DATA_DIR || "data",
  mailFilesDir = process.env.MAIL_FILES_DIR,
  keyPath = process.env.MASTER_KEY_FILE,
  setupToken = process.env.SETUP_TOKEN,
  brokerToken = process.env.MAIL_BROKER_TOKEN,
  mailOptions = {},
  requireMailboxVerification = true,
  healthOptions = {},
  pushOptions = {},
} = {}) {
  const assets = consoleFiles();
  mkdirSync(dataDir, { recursive: true });
  keyPath ||= resolve(dataDir, "master.key");
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("Master key must be 32 bytes");
  const seal = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  };
  const db = new Database(databaseUrl, databaseSchema);
  let closeOnLost = () => {};
  try {
    await db.initialize();
    await db.claimOwner(() => {
      console.error("Database ownership lost; shutting down");
      closeOnLost();
    });
    if (
      await db
        .prepare("SELECT 1 FROM accounts WHERE credential NOT LIKE 'client-v1:%' LIMIT 1")
        .get()
    )
      throw Error("Legacy mailbox configurations must be deleted before starting this version");
  } catch (error) {
    await db.close();
    throw error;
  }
  const decrypt = (value) => {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
  };
  try {
    const stored = await db.prepare("SELECT value FROM encryption_check WHERE id=1").get();
    if (stored) {
      if (decrypt(stored.value) !== "mohua-postgresql-key-check")
        throw Error("Invalid encryption key");
    } else
      await db
        .prepare("INSERT INTO encryption_check VALUES(1,?)")
        .run(seal("mohua-postgresql-key-check"));
  } catch {
    await db.close();
    throw Error("Database encryption key does not match. Restore the original master.key volume.");
  }
  let devices, push, mail, reader, sender, health, sync, remoteDrafts;
  const files = new MailFiles(db, mailFilesDir || resolve(dataDir, "mail-files"));
  try {
    await files.initialize();
  } catch (error) {
    await db.close();
    throw error;
  }
  const archive = new ArchiveStore(db, files, (id, kind, notification) =>
    devices.changed(id, kind, notification),
  );
  // Mailbox verification receipts; without a worker a random per-process secret is enough.
  const receiptKey = verificationKey(brokerToken || randomBytes(32).toString("hex"));
  let broker;
  // Isolated mode: the worker owns leases, listeners, reads and sends; one facade stands in for all four.
  const facade = brokerToken ? new BrokerMailFacade(() => broker) : null;
  const leases =
    facade ||
    new CredentialLeases({
      onRevoke: (id) => {
        sync?.invalidate(id);
        mail?.stop(id);
        reader?.invalidate(id);
        sender?.invalidate(id);
        mail?.status(id, "authorization_required");
      },
    });
  const leaseHints = new Map();
  let leaseTimer,
    leaseTickRunning = false,
    leaseTick,
    lastLeaseScan = 0;

  // In-process lease upkeep (no worker). A device lease ends with the device's last live session; the live
  // devices of every leased mailbox come from one query. Sync listeners and archive schedules follow the
  // account rows, and clients are reminded through push before their lease lapses.
  async function leaseCheck() {
    const now = Date.now();
    const leased = new Set(
      [...leases.entries.values()].filter((e) => !e.persistent).map((e) => e.device),
    );
    const owners = await liveDeviceOwners(db, [...leased], now);
    const active = await db
      .prepare("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.active=1")
      .all();
    const ownerOf = new Map(active.map((a) => [a.id, a.user_id]));
    for (const [id, entry] of [...leases.entries]) {
      // Leases installed after the device query are checked on the next tick.
      if (entry.persistent || !leased.has(entry.device)) continue;
      const owner = owners.get(entry.device);
      if (!owner || (ownerOf.has(id) && ownerOf.get(id) !== owner)) leases.revoke(id);
    }
    const accounts = active.filter((a) => a.credential?.startsWith("client-v1:"));
    for (const a of accounts) {
      if (a.sync_enabled && a.sync_credential) void mail.start(a);
      try {
        sync.restore(a);
      } catch {
        await archive.call("state", { accountId: a.id, state: "authorization_required" });
      }
      const current = leases.entries.get(a.id);
      if (
        (!current || (current.expires !== null && current.expires - now < DAY)) &&
        now - (leaseHints.get(a.id) || 0) >= HOUR
      ) {
        leaseHints.set(a.id, now);
        await push.enqueue(a.id);
      }
    }
    sync.schedule(accounts);
    if (remoteDrafts.migrationDue())
      remoteDrafts.scheduleMigration(active.filter((a) => a.purge_after == null));
  }

  try {
    devices = new DeviceService({ db, seal });
    push = new PushService({ db, decrypt, ...pushOptions });
    await push.initialize();
    devices.pushService = push;
    devices.onRevoke = (id) => leases.revokeDevice(id);
    if (facade) mail = reader = sender = facade;
    else {
      mail = new MailService({
        leases,
        db,
        ...mailOptions,
        needsPreview: (id) => push.needsPreview(id),
        onSyncChange: (id) => sync?.wake(id),
        onChange: async (id, kind, notification) => await devices.changed(id, kind, notification),
      });
      await mail.restore();
      const live = new MailReader(mail),
        crypto = new ArchiveCrypto(resolve(dataDir, "mail-sync.key"));
      remoteDrafts = new RemoteDrafts(archive, crypto);
      sync = new ArchiveSync({ reader: live, store: archive, crypto, leases });
      reader = new ArchiveReader(live, archive, crypto);
      sender = new MailSender({ mail, reader, db });
      await sender.initialize();
    }
    health = new HealthService({
      db,
      seal,
      decrypt,
      mail,
      ...healthOptions,
    });
    await health.initialize();
    if (!facade)
      leaseTimer = setInterval(() => {
        leases.sweep();
        if (leaseTickRunning || Date.now() - lastLeaseScan < SECOND) return;
        lastLeaseScan = Date.now();
        leaseTickRunning = true;
        leaseTick = leaseCheck()
          .catch(() => {})
          .finally(() => {
            leaseTickRunning = false;
          });
      }, SECOND);
    leaseTimer?.unref();
    if (db.ownerLost) throw Error("Database ownership lost during startup");
  } catch (error) {
    clearInterval(leaseTimer);
    leases.close();
    await leaseTick;
    await mail?.close();
    reader?.close();
    await sender?.close();
    await health?.close();
    await push?.close();
    await db.close();
    throw error;
  }
  setupToken ||= newToken();
  const auth = new AuthService(db, setupToken);
  if (brokerToken) broker = new MailBroker({ files, db, auth, devices, push, token: brokerToken });
  const storage = new RemoteStorage(
    db,
    (id) => {
      leases.revoke(id);
      mail.stop(id);
      reader.invalidate(id);
      sender.invalidate(id);
    },
    Date.now,
    files,
  );
  const storageFailed = (error) => {
    console.error("Remote storage cleanup failed", error.message);
  };
  // A large pending purge can take seconds per pass, so the startup pass runs in the background; close()
  // and the maintenance timer wait for it through storageTick.
  let storageTick = storage
    .sweep()
    .catch(storageFailed)
    .finally(() => (storageTick = null));
  const sweepStorage = () =>
    (storageTick ||= storage
      .sweep()
      .then(() => files.collect())
      .then(() => files.migrateArchive())
      .then(() => sweepExpired(db, auth))
      .catch(storageFailed)
      .finally(() => (storageTick = null)));
  const storageTimer = setInterval(sweepStorage, MINUTE);
  storageTimer.unref();
  // Everything a route module may use. Route modules receive this object and the per-request state.
  const app = {
    db,
    auth,
    devices,
    push,
    mail,
    reader,
    sender,
    health,
    sync,
    remoteDrafts,
    archive,
    leases,
    broker,
    storage,
    files,
    leaseHints,
    mailOptions,
    requireMailboxVerification,
    assets,
    verificationKey: receiptKey,
    operations: new Operations(),
    limit: loginLimiter(),
  };
  const server = http.createServer((req, res) => handleRequest(app, req, res));
  server.requestTimeout = 10 * MINUTE;
  server.headersTimeout = 10 * SECOND;
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(storageTimer);
      await storageTick;
      clearInterval(leaseTimer);
      leases.close();
      await leaseTick;
      await sync?.close();
      await remoteDrafts?.migrating;
      const stopped = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await mail.close();
      reader.close();
      await sender.close();
      await health.close();
      await push.close();
      await stopped;
      await db.close();
    })();
    return closing;
  }
  closeOnLost = () => {
    void close()
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  return {
    server,
    db,
    mail,
    health,
    devices,
    push,
    setupToken,
    leases,
    broker,
    storage,
    files,
    sync,
    close,
  };
}

// One dispatcher for the control service. Order matters only where noted; route modules own disjoint paths.
async function handleRequest(app, req, res) {
  const { db, broker } = app;
  const requestStarted = performance.now();
  let recorded = false;
  const record = (aborted) => {
    if (recorded) return;
    recorded = true;
    let path;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      return;
    }
    app.operations.record({
      method: req.method,
      path,
      status: res.statusCode,
      duration: performance.now() - requestStarted,
      aborted,
    });
  };
  res.once("finish", () => record(false));
  res.once("close", () => {
    if (!res.writableFinished) record(true);
  });
  const send = (status, body) => {
    reply(res, status, body);
    return true;
  };
  res.setHeader("Referrer-Policy", "no-referrer");
  let path;
  try {
    const url = new URL(req.url, "http://localhost");
    path = url.pathname;
    if (path === "/internal/mail") {
      if (!broker) return send(404, { error: "Not found" });
      return await broker.handle(req, res);
    }
    // Reject before reading a body: the control process must never ingest
    // mailbox unlock material, MIME bodies, compose text or attachment bytes.
    if (broker && mailRoute(path))
      return send(421, { error: "Mail requests require the isolated mail entrypoint" });
    if (app.assets(req, res, path, send)) return;
    // Public readiness probe: no credentials or external mail traffic.
    if (req.method === "GET" && path === "/healthz") {
      try {
        await db.query("SELECT 1");
        return send(200, { status: "ok" });
      } catch {
        return send(503, { status: "unavailable" });
      }
    }
    if (!path.startsWith("/api/")) return send(404, { error: "Not found" });
    const body =
      ["POST", "PATCH"].includes(req.method) ||
      (req.method === "DELETE" && req.headers["content-type"])
        ? await jsonBody(req, bodyLimit(path))
        : {};
    if (path === "/api/pairings" || path.startsWith("/api/pairings/"))
      return send(404, { error: "Not found" });
    const r = { req, res, url, path, body, send };
    if (await signInRoutes(app, r)) return;
    const user = await app.auth.authenticate(bearer(req));
    const administrator = user.role === "admin";
    if (administrator && !isSessionRoute(path) && !path.startsWith("/api/admin/"))
      fail(403, "Client user account required");
    if (!administrator && path.startsWith("/api/admin/")) fail(403, "Administrator required");
    Object.assign(r, { user, administrator, device: administrator ? null : user.device });
    if (await clientRoutes(app, r)) return;
    const scoped = path.match(/^\/api\/accounts\/([^/]+)(?:\/|$)/);
    if (scoped) {
      // Loaded once and handed to the route; routes re-read it only under a row lock.
      r.account = await db
        .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
        .get(scoped[1], user.id);
      // Pending deletion freezes the mailbox except for its storage lifecycle and sync-mode status.
      if (r.account?.purge_after && !/\/(remote-storage|sync-mode)$/.test(path))
        fail(409, "Mailbox deletion pending");
    }
    if (mailRoute(path)) return await mailRoutes(controlMailContext(app, r), r);
    for (const routes of [sessionRoutes, accountRoutes, adminRoutes])
      if (await routes(app, r)) return;
    fail(404, "Not found");
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    if ((error.status === 429 || error.status === 503) && Number.isFinite(error.retryAfter))
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.min(DAY / SECOND, Math.ceil(error.retryAfter)))),
      );
    const conflict = error.code === "23505";
    // One line per unexpected failure; identifiers are masked and messages may carry mail data, so omit them.
    if (!error.status && !conflict)
      console.error("Unexpected request failure", {
        method: req.method,
        route: String(path || "")
          .replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, "/:id")
          .replace(/\/\d+(?=\/|$)/g, "/:n")
          .slice(0, 200),
        code: typeof error.code === "string" ? error.code : error.name,
      });
    send(error.status || (conflict ? 409 : 500), {
      error: error.status
        ? error.message
        : conflict
          ? "Record already exists"
          : "Internal server error",
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.MAIL_BROKER_TOKEN)
    throw Error("Production startup requires an isolated mail worker and MAIL_BROKER_TOKEN");
  const app = await createApp();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
  const port = Number(process.env.PORT || 3210);
  const host = process.env.HOST || "127.0.0.1";
  async function healthCheck() {
    await app.health.run();
    app.health.pending.then(async () =>
      console.log("Self-test:", JSON.stringify((await app.health.summary()).runs[0])),
    );
  }
  app.server.listen(port, host, async () => {
    console.log(`Mohua: http://${host}:${port}`);
    if (process.argv.includes("--self-test")) {
      await healthCheck();
    }
    if (!(await app.db.prepare("SELECT COUNT(*) n FROM administrators").get()).n)
      console.log(
        process.env.SETUP_TOKEN
          ? "Create the first administrator using SETUP_TOKEN from your local .env file."
          : `One-time setup token: ${app.setupToken}`,
      );
  });
}
