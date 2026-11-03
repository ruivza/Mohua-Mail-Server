import { verificationKey } from "./mail-verification.js";
import { RemoteDrafts } from "./remote-drafts.js";
import { ArchiveCrypto } from "./archive-crypto.js";
import { ArchiveReader } from "./archive-reader.js";
import { ArchiveSync } from "./archive-sync.js";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialLeases } from "./credential-leases.js";
import { MailService } from "./mail.js";
import { MailReader } from "./reader.js";
import { MailSender } from "./sender.js";
import { MailRemoteStore } from "./mail-remote-store.js";
import { jsonBody, reply, mailRoute, bodyLimit, bearer } from "./mail-protocol.js";
import { mailRoutes } from "./routes/mail.js";
import { fail } from "./errors.js";
import { SECOND, MINUTE, DAY, WORKER_HEARTBEAT, MAIL_REQUESTS_PER_MINUTE } from "./limits.js";
export async function createMailWorker({
  brokerUrl,
  brokerToken,
  mailOptions = {},
  pollMs = 1000,
  archiveKeyPath = process.env.MAIL_ARCHIVE_KEY_FILE || "data/mail-sync.key",
  onLost = () => {},
  onEmpty = () => {},
}) {
  const db = new MailRemoteStore({ url: brokerUrl, token: brokerToken });
  const registration = await db.call("register");
  // Same derivation as the control service, so receipts issued here are accepted there.
  const receiptKey = verificationKey(brokerToken);
  let mail,
    reader,
    sender,
    sync,
    closed = false,
    lastHeartbeat = 0,
    tick,
    previous = new Map(),
    invalidations = {},
    monitorStops = {},
    accounts = [],
    devices = new Set(),
    version,
    transitions = 0,
    emptyCheckPending = false;
  function checkEmpty() {
    if (!emptyCheckPending || closed || transitions) return;
    emptyCheckPending = false;
    if (!leases.entries.size && !accounts.some((a) => a.sync_enabled)) onEmpty();
  }
  const leases = new CredentialLeases({
    onRevoke: (id) => {
      sync?.invalidate(id);
      mail?.stop(id);
      reader?.invalidate(id);
      sender?.invalidate(id);
      mail?.status(id, "authorization_required");
      if (!leases.entries.size) {
        emptyCheckPending = true;
        setImmediate(checkEmpty);
      }
    },
  });
  mail = new MailService({
    db,
    leases,
    ...mailOptions,
    needsPreview: (id) => db.call("needsPreview", { accountId: id }),
    onSyncChange: (id) => sync?.wake(id),
    onChange: (id, kind, notification) => db.call("changed", { accountId: id, kind, notification }),
  });
  const live = new MailReader(mail),
    crypto = new ArchiveCrypto(archiveKeyPath);
  const archive = { call: (operation, values) => db.call("archive", { operation, values }) };
  const remoteDrafts = new RemoteDrafts(archive, crypto);
  sync = new ArchiveSync({ reader: live, store: archive, crypto, leases });
  reader = new ArchiveReader(live, archive, crypto);
  sender = new MailSender({ db, reader, mail });
  await sender.initialize();
  let inventoryTail = Promise.resolve();
  function inventory() {
    const run = inventoryTail.then(refreshInventory);
    inventoryTail = run.catch(() => {});
    return run;
  }
  async function refreshInventory() {
    transitions++;
    try {
      const snapshot = accounts.map((a) => ({
        id: a.id,
        ...mail.state(a.id),
        authorization: leases.status(a),
      }));
      const data = await db.call("inventory", { snapshot, seen: version });
      if (data.boot !== registration.boot) throw Error("Control service restarted");
      // Rows and live devices are omitted while the control service's version matches the copy held here.
      if (data.accounts) {
        accounts = data.accounts;
        devices = new Set(data.devices);
        version = data.version;
      }
      const present = new Map(accounts.map((a) => [a.id, a]));
      // A device lease ends when the device leaves the list: revoked, owner deactivated or no unexpired session.
      for (const [id, e] of leases.entries) {
        if (
          !present.has(id) ||
          present.get(id).credential !== e.credential ||
          (!e.persistent && !devices.has(e.device)) ||
          (e.persistent && present.get(id).sync_credential !== e.persistent) ||
          (data.invalidations[id] || 0) !== (invalidations[id] || 0)
        )
          leases.revoke(id);
      }
      // Monitoring switched off on the control side: close the listener, keep the authorization.
      for (const id of [...mail.jobs.keys()])
        if ((data.monitorStops[id] || 0) !== (monitorStops[id] || 0)) mail.stop(id);
      for (const old of previous.values())
        if (!present.has(old.id)) {
          mail.remove(old.id);
          reader.invalidate(old.id);
          sender.invalidate(old.id);
        }
      invalidations = data.invalidations;
      monitorStops = data.monitorStops;
      previous = present;
      for (const a of accounts) {
        try {
          sync.restore(a);
        } catch {
          await archive.call("state", { accountId: a.id, state: "authorization_required" });
        }
        if (a.sync_enabled ? !!a.sync_credential : a.monitor_enabled) void mail.start(a);
        else if (mail.jobs.has(a.id)) mail.stop(a.id);
        const status = leases.status(a);
        if (
          status.state !== "active" ||
          (status.expiresAt !== null && status.expiresAt - Date.now() < DAY)
        )
          await db.call("hint", { accountId: a.id });
      }
      lastHeartbeat = Date.now();
      sync.schedule(accounts);
      remoteDrafts.scheduleMigration(accounts);
    } finally {
      transitions--;
      setImmediate(checkEmpty);
    }
  }
  try {
    await inventory();
  } catch (e) {
    await sender.close();
    reader.close();
    await mail.close();
    throw e;
  }
  const timer = setInterval(() => {
    leases.sweep();
    if (tick || closed) return;
    tick = inventory()
      .catch((e) => {
        console.error("Mail worker inventory failed", {
          status: e.status || null,
          code: e.code || null,
        });
        leases.close();
        onLost();
      })
      .finally(() => (tick = null));
  }, pollMs);
  timer.unref();
  const limits = new Map();
  function limit(id) {
    const now = Date.now();
    for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    const v = limits.get(id) || { count: 0, until: now + MINUTE };
    if (++v.count > MAIL_REQUESTS_PER_MINUTE) fail(429, "Too many mail requests");
    limits.set(id, v);
  }
  // What routes/mail.js needs, answered through the broker. The control service stays the authority for
  // sessions, devices and mailbox ownership; the worker only holds the secrets.
  const context = (token, user, device) => ({
    user,
    device,
    leases,
    mail,
    reader,
    sender,
    sync,
    remoteDrafts,
    archive,
    mailOptions,
    verificationKey: receiptKey,
    throttle() {},
    mailbox: async (id) => (await db.call("authorize", { token, accountId: id })).account,
    async authorize(account) {
      const scope = await db.call("authorize", {
        token,
        ...(account ? { accountId: account.id, credential: account.credential } : {}),
      });
      if (scope.account?.purge_after) fail(409, "Mailbox deletion pending");
    },
    exclusive: (account, operation) => operation(account),
    configureSync: (account, settings) =>
      db.call("archiveConfigure", {
        token,
        accountId: account.id,
        credentialRevision: account.credential,
        settings,
      }),
    async resetSync(account) {
      // The old lease is revoked before the inventory restores the new one; do not exit in between.
      transitions++;
      try {
        sync.invalidate(account.id);
        leases.revoke(account.id);
        await inventory();
      } finally {
        transitions--;
        setImmediate(checkEmpty);
      }
    },
    changed: (accountId) => db.call("changed", { accountId }),
    outboxList: () => db.call("outboxList", { token }),
  });
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      reply(res, status, body);
      return true;
    };
    try {
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname;
      if (path === "/healthz" && req.method === "GET")
        return send(Date.now() - lastHeartbeat < WORKER_HEARTBEAT ? 200 : 503, {
          status: Date.now() - lastHeartbeat < WORKER_HEARTBEAT ? "ok" : "unavailable",
        });
      if (!mailRoute(path)) fail(404, "Not found");
      if (closed || Date.now() - lastHeartbeat >= WORKER_HEARTBEAT)
        fail(503, "Mail worker unavailable");
      const token = bearer(req);
      if (!token) fail(401, "Sign in required");
      const { user, device } = await db.call("authorize", { token });
      let body = {};
      if (
        ["POST", "PATCH"].includes(req.method) ||
        (req.method === "DELETE" &&
          /^\/api\/accounts\/[^/]+\/drafts\//.test(path) &&
          req.headers["content-type"])
      ) {
        limit(device.id);
        body = await jsonBody(req, bodyLimit(path));
      }
      await mailRoutes(context(token, user, device), { req, res, url, path, body, send });
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(e.status || 502, { error: e.status ? e.message : "Mail operation failed" });
    }
  });
  server.requestTimeout = 10 * MINUTE;
  server.headersTimeout = 10 * SECOND;
  let closing;
  const close = () =>
    (closing ||= (async () => {
      closed = true;
      clearInterval(timer);
      leases.close();
      await sync.close();
      await tick;
      await remoteDrafts.migrating;
      const stopped = new Promise((r) => server.close(r));
      server.closeAllConnections();
      reader.close();
      await mail.close();
      await sender.close();
      await db.call("release").catch(() => {});
      await stopped;
    })());
  return { server, close, leases, mail, reader, sender, db, inventory, sync, remoteDrafts };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of ["PGHOST", "PGPASSWORD", "DATABASE_URL", "MASTER_KEY_FILE", "SETUP_TOKEN"])
    if (process.env[key])
      throw Error("Mail worker must not receive database or master-key configuration");
  let app,
    stopping = false;
  const stop = (reason = "signal") => {
    if (stopping) return;
    stopping = true;
    console.info("Mail worker stopping", { reason });
    void app?.close().finally(() => process.exit(0));
  };
  app = await createMailWorker({
    brokerUrl: process.env.MAIL_BROKER_URL || "http://server:3210/internal/mail",
    brokerToken: process.env.MAIL_BROKER_TOKEN,
    onLost: () => stop("control_unavailable"),
    onEmpty: () => stop("no_authorized_accounts"),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  app.server.listen(Number(process.env.PORT || 3211), process.env.HOST || "0.0.0.0");
}
