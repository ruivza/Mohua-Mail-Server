import { MailBroker } from "./mail-broker.js";
import { mailRoute } from "./mail-protocol.js";
import { CredentialLeases, encodeEnvelope, envelope } from "./credential-leases.js";
import { Operations, businessHealth } from "./operations.js";
import { iosDeviceName } from "./device-name.js";
import { AuthService } from "./auth.js";
import { PushService } from "./push.js";
import { DeviceService } from "./devices.js";
import { MailSender } from "./sender.js";
import http from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MailReader, readOptions } from "./reader.js";
import { HealthService } from "./health.js";
import { MailService } from "./mail.js";
import { Database } from "./database.js";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const string = (value, name, min = 1, max = 200) => {
  if (typeof value !== "string" || value.length < min || value.length > max)
    fail(400, `${name} invalid`);
  return value;
};

export async function createApp({
  databaseUrl = process.env.DATABASE_URL,
  databaseSchema = process.env.DATABASE_SCHEMA || "public",
  dataDir = process.env.DATA_DIR || "data",
  keyPath = process.env.MASTER_KEY_FILE,
  setupToken = process.env.SETUP_TOKEN,
  brokerToken = process.env.MAIL_BROKER_TOKEN,
  mailOptions = {},
  healthOptions = {},
  pushOptions = {},
} = {}) {
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
    if (await db.prepare("SELECT 1 FROM accounts WHERE credential NOT LIKE 'client-v1:%' LIMIT 1").get())
      throw Error("Legacy mailbox configurations must be deleted before starting this version");
  } catch (error) {
    await db.close();
    throw error;
  }
  const decrypt = (value) => {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      cipher.update(bytes.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8");
  };
  try {
    const stored = await db
      .prepare("SELECT value FROM encryption_check WHERE id=1")
      .get();
    if (stored) {
      if (decrypt(stored.value) !== "mohua-postgresql-key-check")
        throw Error("Invalid encryption key");
    } else
      await db
        .prepare("INSERT INTO encryption_check VALUES(1,?)")
        .run(seal("mohua-postgresql-key-check"));
  } catch {
    await db.close();
    throw Error(
      "Database encryption key does not match. Restore the original master.key volume.",
    );
  }
  let devices, push, mail, reader, sender, health;
  let broker;
  const leases = brokerToken ? { status:a=>broker?.status(a)||{mode:"client",state:"locked",expiresAt:null}, revoke:id=>broker?.invalidate(id), revokeDevice:()=>{}, close:()=>{} } : new CredentialLeases({ onRevoke: id => { mail?.stop(id); reader?.invalidate(id); sender?.invalidate(id); mail?.status(id, "authorization_required"); } });
  const leaseHints = new Map();
  let leaseTimer, leaseTickRunning = false, leaseTick, lastLeaseScan = 0;

  try {
    devices = new DeviceService({ db, seal });
    push = new PushService({ db, decrypt, ...pushOptions });
    await push.initialize();
    devices.pushService = push;
    devices.onRevoke = id => leases.revokeDevice(id);
    if (brokerToken) {
      mail = { state:id=>broker?.state(id)||{connectionStatus:"worker_unavailable"}, start:async()=>{}, stop:id=>broker?.invalidate(id), remove:id=>broker?.invalidate(id), close:async()=>{} };
      reader = { invalidate:id=>broker?.invalidate(id), close:()=>{} };
      sender = { invalidate:id=>broker?.invalidate(id), close:async()=>{} };
    } else {
    mail = new MailService({
      leases,
      db,
      ...mailOptions,
      onChange: async (id) => await devices.changed(id),
    });
    await mail.restore();
    reader = new MailReader(mail);
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
    if (!brokerToken) leaseTimer = setInterval(() => {
      leases.sweep();
      if (leaseTickRunning || Date.now() - lastLeaseScan < 60000) return;
      lastLeaseScan = Date.now();
      leaseTickRunning = true;
      leaseTick = (async () => {
        const accounts = await db.prepare("SELECT * FROM accounts WHERE credential LIKE 'client-v1:%'").all();
        const now = Date.now();
        for (const a of accounts) {
          const entry = leases.entries.get(a.id);
          if (entry && !(await devices.allowed(entry.device, a.id))) leases.revoke(a.id);
          const current = leases.entries.get(a.id);
          if ((!current || (current.expires !== null && current.expires - now < 86400000)) && now - (leaseHints.get(a.id) || 0) >= 3600000) {
            leaseHints.set(a.id, now); await push.enqueue(a.id);
          }
        }
      })().catch(() => {}).finally(() => { leaseTickRunning = false; });
    }, 1000);
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
  setupToken ||= token();
  const auth = new AuthService(db, setupToken);
  if (brokerToken) broker = new MailBroker({db,auth,devices,push,token:brokerToken});
  const attempts = new Map();
  const limit = (req) => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let row = attempts.get(ip);
    if (!row || now > row.until) {
      row = { count: 0, until: now + 60000 };
      attempts.set(ip, row);
    }
    if (++row.count > 20) fail(429, "Try again later");
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  };
  const publicAccount =
    "id,email,mode,imap_host,imap_port,smtp_host,smtp_port,monitor_enabled,credential";
  const operations = new Operations();
  const server = http.createServer(async (req, res) => {
    const requestStarted = performance.now();
    let recorded = false;
    const record = (aborted) => {
      if (recorded) return;
      recorded = true;
      let path;
      try { path = new URL(req.url, "http://localhost").pathname; } catch { return; }
      operations.record({ method: req.method, path, status: res.statusCode, duration: performance.now() - requestStarted, aborted });
    };
    res.once("finish", () => record(false));
    res.once("close", () => { if (!res.writableFinished) record(true); });
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      if (path === "/internal/mail") {
        if (!broker) return send(404,{error:"Not found"});
        return await broker.handle(req,res);
      }
      // Reject before reading a body: the control process must never ingest
      // mailbox unlock material, MIME bodies, compose text or attachment bytes.
      if (broker && mailRoute(path)) return send(421,{error:"Mail requests require the isolated mail entrypoint"});
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(readFileSync(new URL("../public/index.html", import.meta.url)));
        return;
      }
      if (
        req.method === "GET" &&
        ["/app.js", "/preferences.js", "/style.css", "/mohua.jpg", "/favicon.png"].includes(path)
      ) {
        res.writeHead(200, {
          "Content-Type": {
            "/app.js": "text/javascript",
            "/preferences.js": "text/javascript",
            "/style.css": "text/css",
            "/mohua.jpg": "image/jpeg",
            "/favicon.png": "image/png",
          }[path],
          "X-Content-Type-Options": "nosniff",
        });
        res.end(readFileSync(new URL("../public" + path, import.meta.url)));
        return;
      }
      if (
        [
          "/mail-test",
          "/device-test",
          "/mail-test.js",
          "/device-test.js",
        ].includes(path)
      )
        return send(404, { error: "Not found" });
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
      let body = {};
      if (["POST", "PATCH"].includes(req.method)) {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          fail(415, "Use application/json");
        const chunks = [];
        let size = 0;
        const max = /^\/api\/accounts\/[^/]+\/outbox$/.test(path)
          ? 400000
          : 16384;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > max) fail(413, "Body too large");
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          fail(400, "Invalid JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          fail(400, "Invalid body");
      }
      if (path === "/api/pairings" || path.startsWith("/api/pairings/"))
        return send(404, { error: "Not found" });
      if (
        req.method === "POST" &&
        [
          "/api/setup",
          "/api/register",
          "/api/login",
          "/api/client/login",
        ].includes(path)
      ) {
        limit(req);
        if (path === "/api/setup") return send(201, await auth.setup(body));
        if (path === "/api/register")
          return send(201, await auth.register(body));
        if (path === "/api/login")
          return send(200, await auth.adminLogin(body, req.headers["user-agent"]));
        const identity = await auth.login(body);
        const session = await devices.enroll(identity.id, {
          name: iosDeviceName(body.deviceInfo),
          platform: "ios",
          deviceId: body.deviceId,
        });
        return send(200, {
          ...session,
          user: { id: identity.id, email: identity.email, role: "user" },
        });
      }
      const secret = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const user = await auth.authenticate(secret);
      const administrator = user.role === "admin";
      const sharedRoute =
        ["/api/me", "/api/logout", "/api/devices"].includes(path) ||
        path.startsWith("/api/devices/");
      if (administrator && !sharedRoute && !path.startsWith("/api/admin/"))
        fail(403, "Client user account required");
      if (!administrator && path.startsWith("/api/admin/"))
        fail(403, "Administrator required");
      const device = administrator
        ? null
        : await devices.deviceForSession(user.session_id);
      const deviceAllowed = async (account) => {
        if (!device || !(await devices.allowed(device.id, account.id)))
          fail(403, "Mailbox access denied");
      };
      if (path.startsWith("/api/client/")) {
        if (!device) fail(403, "Device session required");
        if (path === "/api/client/leave" && req.method === "POST") {
          await devices.revoke(user.id, device.id);
          return send(200, { revoked: true });
        }
        if (path === "/api/client/sync" && req.method === "GET")
          return send(200, await devices.sync(device));
        if (path === "/api/client/ack" && req.method === "POST")
          return send(200, await devices.ack(device, body));
        if (path === "/api/client/push/config" && req.method === "GET")
          return send(200, {
            ...(await push.settings.current()),
            pushStatus: await push.status(device),
            enabled: Boolean(device.push_enabled),
          });
        if (path === "/api/client/push" && req.method === "POST") {
          await devices.push(device, body, user.session_id);
          return send(200, {
            pushStatus: await push.status(
              await devices.own(user.id, device.id),
            ),
          });
        }
      }
      if (path === "/api/client-devices" && req.method === "GET")
        return send(200, await devices.list(user.id));
      const deviceRoute = path.match(/^\/api\/client-devices\/([^/]+)$/);
      if (deviceRoute) {
        if (req.method === "DELETE") {
          await devices.revoke(user.id, deviceRoute[1]);
          return send(200, { revoked: true });
        }
      }
      const prepareRoute = path.match(/^\/api\/accounts\/([^/]+)\/outbox$/);
      if (prepareRoute && req.method === "POST") {
        limit(req);
        const a = await db
          .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
          .get(prepareRoute[1], user.id);
        if (!a) fail(404, "Mailbox not found");
        return send(
          201,
          await sender.prepare(
            a,
            user.id,
            req.headers["idempotency-key"],
            body,
          ),
        );
      }
      if (path === "/api/outbox" && req.method === "GET")
        return send(
          200,
          await Promise.all(
            (
              await db
                .prepare(
                  "SELECT id FROM outbox WHERE user_id=? ORDER BY created DESC LIMIT 20",
                )
                .all(user.id)
            ).map(async (r) => await sender.status(r.id, user.id)),
          ),
        );
      const sendRoute = path.match(/^\/api\/outbox\/([a-f0-9-]+)$/);
      if (sendRoute) {
        if (device) {
          const draft = await db
            .prepare("SELECT account_id FROM outbox WHERE id=? AND user_id=?")
            .get(sendRoute[1], user.id);
          if (!draft) fail(404, "Send record not found");
          await deviceAllowed({ id: draft.account_id });
        }
        if (req.method === "GET")
          return send(200, await sender.status(sendRoute[1], user.id));
        if (req.method === "PUT") {
          if (req.headers["content-type"] !== "application/octet-stream")
            fail(415, "Use application/octet-stream");
          const result = await sender.submit(
            sendRoute[1],
            user.id,
            req,
            async (a) => {
              await deviceAllowed(a);
              if (
                !(await db
                  .prepare(
                    "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN accounts a ON a.user_id=u.id WHERE s.id=? AND s.expires>? AND u.active=1 AND a.id=? AND a.mode=? AND a.credential=?",
                  )
                  .get(
                    user.session_id,
                    Date.now(),
                    a.id,
                    "proxy",
                    a.credential,
                  ))
              )
                fail(401, "Access revoked");
            },
          );
          if (["sent", "partial", "unknown"].includes(result.state)) {
            const draft = await db
              .prepare("SELECT account_id FROM outbox WHERE id=? AND user_id=?")
              .get(sendRoute[1], user.id);
            if (draft) await devices.changed(draft.account_id);
          }
          req.resume();
          return send(200, result);
        }
      }
      if (path === "/api/me" && req.method === "GET")
        return send(200, {
          id: user.id,
          email: user.email,
          role: user.role,
          sessionId: user.session_id,
        });
      const sessionTable = administrator ? "admin_sessions" : "sessions";
      const ownerColumn = administrator ? "admin_id" : "user_id";
      if (path === "/api/logout" && req.method === "POST") {
        if (device) await devices.revoke(user.id, device.id);
        else
          await db
            .prepare("DELETE FROM admin_sessions WHERE id=?")
            .run(user.session_id);
        return send(200, { revoked: true });
      }
      if (path === "/api/devices" && req.method === "GET")
        return send(
          200,
          await db
            .prepare(
              `SELECT id,name,expires FROM ${sessionTable} WHERE ${ownerColumn}=? AND expires>?`,
            )
            .all(user.id, Date.now()),
        );
      if (path.startsWith("/api/devices/") && req.method === "DELETE") {
        await db
          .prepare(
            `DELETE FROM ${sessionTable} WHERE id=? AND ${ownerColumn}=?`,
          )
          .run(path.split("/").at(-1), user.id);
        return send(200, { revoked: true });
      }
      if (path === "/api/accounts" && req.method === "GET")
        return send(
          200,
          (
            await db
              .prepare(`SELECT ${publicAccount} FROM accounts WHERE user_id=?`)
              .all(user.id)
          ).map((a) => ({ ...a, ...mail.state(a.id), credentialMode: "client", authorization: leases.status(a), credential: undefined })),
        );
      if (path === "/api/accounts" && req.method === "POST") {
        const email = string(body.email, "email").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          fail(400, "Invalid email");
        const mode = body.mode;
        if (!["proxy", "direct"].includes(mode)) fail(400, "Invalid mode");
        const imap = string(body.imapHost, "imapHost");
        const smtp = string(body.smtpHost, "smtpHost");
        for (const host of [imap, smtp])
          if (!/^[a-zA-Z0-9.-]+$/.test(host)) fail(400, "Invalid mail host");
        const imapPort = body.imapPort ?? 993,
          smtpPort = body.smtpPort ?? 465;
        for (const port of [imapPort, smtpPort])
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            fail(400, "Invalid port");
        if (!body.envelope || Object.hasOwn(body, "credential")) fail(409, "Client encrypted credential required");
        const credential = encodeEnvelope(body.envelope);
        const id = string(body.id, "id", 36, 36);
        if (!/^[a-f0-9-]{36}$/i.test(id)) fail(400, "Invalid mailbox ID");
        if (
          await db
            .prepare("SELECT id FROM accounts WHERE user_id=? AND email=?")
            .get(user.id, email)
        )
          fail(409, "Mailbox already added");
        await db
          .prepare(
            "INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            user.id,
            email,
            mode,
            imap,
            imapPort,
            smtp,
            smtpPort,
            credential,
          );
        await devices.changed(id);
        return send(201, { id, connectionStatus: "not_connected" });
      }
      const leaseRoute = path.match(/^\/api\/accounts\/([^/]+)\/credential$/);
      if (leaseRoute) {
        if (!device) fail(403, "Device session required");
        const result = await db.transaction(async () => {
          const account = await db.prepare("SELECT * FROM accounts WHERE id=? AND user_id=? FOR UPDATE").get(leaseRoute[1], user.id);
          if (!account) fail(404, "Mailbox not found");
          await db.prepare("SELECT id FROM client_devices WHERE id=? FOR SHARE").get(device.id);
          const activeSession = await db.prepare(`SELECT d.id FROM client_devices d
            JOIN device_sessions ds ON ds.device_id=d.id JOIN sessions s ON s.id=ds.session_id
            JOIN users u ON u.id=d.user_id WHERE s.id=? AND s.expires>? AND d.revoked IS NULL AND u.active=1
            FOR SHARE OF d,s,u`).get(user.session_id, Date.now());
          if (!activeSession) fail(401, "Access revoked");
          if (req.method === "GET") return { envelope: envelope(account.credential), authorization: leases.status(account), challenge: leases.challenge(account, device.id) };
          if (req.method === "POST") {
            const authorization = leases.install(account, device.id, body);
            return { authorized: true, authorization };
          }
          if (req.method === "DELETE") { leases.revoke(account.id); return { revoked: true }; }
          fail(405, "Method not allowed");
        });
        if (req.method === "POST") {
          const current = await mail.active(leaseRoute[1]);
          if (current?.monitor_enabled) void mail.start(current);
        }
        return send(200, result);
      }
      const mutation = path.match(
        /^\/api\/accounts\/([^/]+)\/messages\/([1-9]\d{0,9})\/actions$/,
      );
      if (mutation && req.method === "POST") {
        const account = await db
          .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
          .get(mutation[1], user.id);
        if (!account) fail(404, "Mailbox not found");
        const uid = Number(mutation[2]);
        if (uid > 4294967295) fail(400, "Invalid UID");
        const controller = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on("close", disconnected);
        try {
          return send(
            200,
            await reader.mutate(
              account,
              readOptions(url.searchParams),
              uid,
              body,
              controller.signal,
              async () => {
                await deviceAllowed(account);
                if (
                  !(await db
                    .prepare(
                      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN accounts a ON a.user_id=u.id WHERE s.id=? AND s.expires>? AND u.active=1 AND a.id=? AND a.mode=? AND a.credential=?",
                    )
                    .get(
                      user.session_id,
                      Date.now(),
                      account.id,
                      "proxy",
                      account.credential,
                    ))
                )
                  fail(401, "Access revoked");
              },
            ),
          );
        } finally {
          await devices.changed(account.id);
          res.off("close", disconnected);
        }
      }
      const readRoute = path.match(
        /^\/api\/accounts\/([^/]+)\/(folders|messages|sync)(?:\/([1-9]\d{0,9})(?:\/(body|attachments\/\d{1,3}))?)?$/,
      );
      if (
        readRoute &&
        ((req.method === "GET" && readRoute[2] !== "sync") ||
          (req.method === "POST" && readRoute[2] === "sync" && !readRoute[3]))
      ) {
        const account = await db
          .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
          .get(readRoute[1], user.id);
        if (!account) fail(404, "Mailbox not found");
        const controller = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on("close", disconnected);
        try {
          const o = readOptions(url.searchParams);
          let result;
          if (readRoute[2] === "sync")
            result = await reader.sync(account, body, controller.signal);
          else if (readRoute[2] === "folders" && !readRoute[3])
            result = await reader.folders(account, controller.signal);
          else if (readRoute[2] === "messages" && !readRoute[3])
            result = await reader.list(account, o, controller.signal);
          else if (
            readRoute[2] === "messages" &&
            Number(readRoute[3]) <= 4294967295
          )
            result = await reader.message(
              account,
              o,
              Number(readRoute[3]),
              readRoute[4] === undefined
                ? null
                : readRoute[4] === "body"
                  ? "body"
                  : Number(readRoute[4].split("/")[1]),
              controller.signal,
              async (file) => {
                await checkAccess();
                let lastCheck = 0;
                const permission = new Transform({
                  async transform(chunk, encoding, done) {
                    try {
                      if (Date.now() - lastCheck > 1000) {
                        await checkAccess();
                        lastCheck = Date.now();
                      }
                      done(null, chunk);
                    } catch (e) {
                      done(e);
                    }
                  },
                });
                res.writeHead(200, {
                  "Content-Type": "application/octet-stream",
                  "Content-Disposition":
                    "attachment; filename=attachment; filename*=UTF-8''" +
                    encodeURIComponent(file.filename).replace(
                      /[!'()*]/g,
                      (c) => "%" + c.charCodeAt(0).toString(16),
                    ),
                  "Cache-Control": "no-store",
                  "X-Content-Type-Options": "nosniff",
                });
                await pipeline(file.content, permission, res, {
                  signal: controller.signal,
                });
              },
            );
          else fail(400, "Invalid read request");
          async function checkAccess() {
            await deviceAllowed(account);
            const authorized = await db
              .prepare(
                "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id JOIN accounts a ON a.user_id=u.id WHERE s.id=? AND s.expires>? AND u.active=1 AND a.id=? AND a.mode=? AND a.credential=?",
              )
              .get(
                user.session_id,
                Date.now(),
                account.id,
                "proxy",
                account.credential,
              );
            if (!authorized) fail(401, "Access revoked; sign in again");
          }
          if (readRoute[4] !== undefined) return;
          await checkAccess();
          return send(200, result);
        } finally {
          res.off("close", disconnected);
        }
      }
      const accountRoute = path.match(
        /^\/api\/accounts\/([^/]+)(?:\/(verify|monitor|access))?$/,
      );
      if (accountRoute) {
        const account = await db
          .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
          .get(accountRoute[1], user.id);
        if (!account) fail(404, "Mailbox not found");
        const action = accountRoute[2];
        if (action === "access" && req.method === "GET") {
          if (account.mode !== "proxy")
            fail(409, "Direct mode: read mail on the device");
          return send(200, { authorized: true });
        }
        if (action === "verify" && req.method === "POST") {
          limit(req);
          const result = await mail.verify(account);
          const valid = await db
            .prepare("SELECT id FROM sessions WHERE id=?")
            .get(user.session_id);
          if (!valid) fail(401, "Session revoked");
          return send(200, result);
        }
        if (action === "monitor" && req.method === "POST") {
          if (typeof body.enabled !== "boolean")
            fail(400, "enabled must be boolean");
          await db
            .prepare("UPDATE accounts SET monitor_enabled=? WHERE id=?")
            .run(body.enabled ? 1 : 0, account.id);
          if (body.enabled) void mail.start({ ...account, monitor_enabled: 1 });
          else mail.stop(account.id);
          return send(200, mail.state(account.id));
        }
        if (!action && req.method === "PATCH") {
          if (!body.envelope || Object.hasOwn(body, "credential")) fail(409, "Client encrypted credential required");
          const credential = encodeEnvelope(body.envelope);
          await db.transaction(async () => {
            const fresh = await db.prepare("SELECT credential FROM accounts WHERE id=? FOR UPDATE").get(account.id);
            if (!fresh || fresh.credential !== account.credential) fail(409, "Credential authorization changed");
            await db.prepare("UPDATE accounts SET credential=? WHERE id=?").run(credential, account.id);
            leases.revoke(account.id);
          });
          if (account.monitor_enabled)
            void mail.start({ ...account, credential });
          return send(200, { updated: true });
        }
        if (!action && req.method === "DELETE") {
          await db.transaction(async () => {
            await db.prepare("SELECT id FROM accounts WHERE id=? FOR UPDATE").get(account.id);
            await db.prepare("DELETE FROM accounts WHERE id=?").run(account.id);
            leases.revoke(account.id);
            mail.remove(account.id);
          });
          leaseHints.delete(account.id);
          return send(200, { removed: true });
        }
      }
      if (path.startsWith("/api/admin/")) {
        if (user.role !== "admin") fail(403, "Administrator required");
        if (path === "/api/admin/push" && req.method === "GET")
          return send(200, await push.settings.current());
        if (path === "/api/admin/push" && req.method === "PATCH")
          return send(200, await push.configure(body));
        if (path === "/api/admin/push/test" && req.method === "POST")
          return send(200, await push.test());
        if (path === "/api/admin/health" && req.method === "GET")
          return send(200, {
            ...(await health.summary()),
            business: await businessHealth(db, mail, push),
            traffic: operations.snapshot(),
            counts: {
              users: (await db.prepare("SELECT COUNT(*) n FROM users").get()).n,
              activeUsers: (
                await db
                  .prepare("SELECT COUNT(*) n FROM users WHERE active=1")
                  .get()
              ).n,
              mailboxes: (
                await db.prepare("SELECT COUNT(*) n FROM accounts").get()
              ).n,
            },
          });
        if (path === "/api/admin/health/run" && req.method === "POST")
          return send(202, await health.run());

        if (path === "/api/admin/users" && req.method === "GET")
          return send(
            200,
            await db.prepare("SELECT id,email,role,active FROM users").all(),
          );
        if (path === "/api/admin/invites" && req.method === "POST") {
          const invite = token();
          const expires = Date.now() + 86400000;
          await db
            .prepare("INSERT INTO invites VALUES(?,?)")
            .run(hash(invite), expires);
          return send(201, { invite, expires });
        }
        if (path.startsWith("/api/admin/users/") && req.method === "PATCH") {
          const id = path.split("/").at(-1);
          if (!(await db.prepare("SELECT id FROM users WHERE id=?").get(id)))
            fail(404, "User not found");
          if (typeof body.active !== "boolean")
            fail(400, "active must be boolean");
          await db
            .prepare("UPDATE users SET active=? WHERE id=?")
            .run(body.active ? 1 : 0, id);
          if (!body.active) {
            for (const device of await devices.list(id))
              await devices.revoke(id, device.id);
            await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
            for (const a of await db
              .prepare("SELECT id FROM accounts WHERE user_id=?")
              .all(id)) {
              reader.invalidate(a.id);
              mail.stop(a.id);
            }
          } else {
            for (const a of await db
              .prepare(
                "SELECT * FROM accounts WHERE user_id=? AND monitor_enabled=1",
              )
              .all(id))
              void mail.start(a);
          }
          return send(200, { updated: true });
        }
      }
      fail(404, "Not found");
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      if ((error.status === 429 || error.status === 503) && Number.isFinite(error.retryAfter))
        res.setHeader('Retry-After', String(Math.max(1, Math.min(86400, Math.ceil(error.retryAfter)))));
      const conflict = error.code === "23505";
      send(error.status || (conflict ? 409 : 500), {
        error: error.status
          ? error.message
          : conflict
            ? "Record already exists"
            : "Internal server error",
      });
    }
  });
  server.requestTimeout = 600000;
  server.headersTimeout = 10000;
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(leaseTimer);
      leases.close();
      await leaseTick;
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
    close,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.MAIL_BROKER_TOKEN) throw Error("Production startup requires an isolated mail worker and MAIL_BROKER_TOKEN");
  const app = await createApp();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
  const port = Number(process.env.PORT || 3210);
  const host = process.env.HOST || "127.0.0.1";
  async function healthCheck() {
    await app.health.run();
    app.health.pending.then(async () =>
      console.log(
        "Self-test:",
        JSON.stringify((await app.health.summary()).runs[0]),
      ),
    );
  }
  app.server.listen(port, host, async () => {
    console.log(`Mohua: http://${host}:${port}`);
    if (process.argv.includes("--self-test")) {
      await healthCheck();
    }
    if (
      !(await app.db.prepare("SELECT COUNT(*) n FROM administrators").get()).n
    )
      console.log(
        process.env.SETUP_TOKEN
          ? "Create the first administrator using SETUP_TOKEN from your local .env file."
          : `One-time setup token: ${app.setupToken}`,
      );
  });
}
