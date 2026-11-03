import { ArchiveStore, configureSync } from "./archive-store.js";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { queries, jsonBody, reply, bearer } from "./mail-protocol.js";
import { liveDevices, liveSession } from "./queries.js";
import { fail } from "./errors.js";
import { isUuid } from "./validate.js";
import { HOUR, WORKER_HEARTBEAT, WORKER_REGISTRATION } from "./limits.js";
const digest = (s) => createHash("sha256").update(s).digest();
export class MailBroker {
  constructor({ db, files, auth, devices, push, token, now = Date.now }) {
    if (typeof token !== "string" || token.length < 32)
      throw Error("Mail broker token must be at least 32 characters");
    Object.assign(this, { db, auth, devices, push, token, now });
    this.archive = new ArchiveStore(db, files, (id, kind, notification) =>
      devices.changed(id, kind, notification),
    );
    this.registerTail = Promise.resolve();
    this.boot = randomUUID();
    this.worker = null;
    this.last = 0;
    this.states = new Map();
    this.authorizations = new Map();
    this.invalidations = new Map();
    this.monitorStops = new Map();
    this.hints = new Map();
  }
  // Credential changed, mailbox removed or owner deactivated: the worker revokes the lease on its next inventory.
  invalidate(id) {
    this.invalidations.set(id, (this.invalidations.get(id) || 0) + 1);
    this.states.delete(id);
    this.authorizations.delete(id);
  }
  // Monitoring switched off: the worker closes the listener on its next inventory but keeps the lease.
  // Report "stopped" until the worker's next snapshot replaces it.
  stopMonitor(id) {
    this.monitorStops.set(id, (this.monitorStops.get(id) || 0) + 1);
    this.states.set(id, { ...this.states.get(id), connectionStatus: "stopped" });
  }
  state(id) {
    return this.now() - this.last < WORKER_HEARTBEAT
      ? this.states.get(id) || { connectionStatus: "authorization_required" }
      : { connectionStatus: "worker_unavailable" };
  }
  status(account) {
    const s = this.authorizations.get(account.id);
    return this.now() - this.last < WORKER_HEARTBEAT &&
      s &&
      s.state === "active" &&
      (s.expiresAt === null || s.expiresAt > this.now())
      ? s
      : { mode: "client", state: "locked", expiresAt: null };
  }
  async scope(token, id, credential) {
    const user = await this.auth.authenticate(token);
    if (user.role !== "user") fail(403, "Client user account required");
    if (!user.device) fail(403, "Device session required");
    let account;
    if (id) {
      account = await this.db
        .prepare("SELECT * FROM accounts WHERE id=? AND user_id=?")
        .get(id, user.id);
      if (!account) fail(404, "Mailbox not found");
      if (credential !== undefined && credential !== account.credential)
        fail(401, "Access revoked");
    }
    return {
      user: { id: user.id, session_id: user.session_id },
      device: { id: user.device.id },
      account,
    };
  }
  snapshot(items) {
    if (!Array.isArray(items) || items.length > 10000) fail(400, "Invalid snapshot");
    const states = new Map(),
      authorizations = new Map();
    for (const item of items) {
      if (typeof item.id !== "string" || item.id.length > 100) fail(400, "Invalid snapshot");
      const connectionStatus = [
        "not_connected",
        "authorization_required",
        "connecting",
        "listening",
        "reconnecting",
        "stopped",
        "testing",
        "verified",
        "error",
      ].includes(item.connectionStatus)
        ? item.connectionStatus
        : "error";
      const state = { connectionStatus };
      for (const k of ["messageCount", "disconnectedSince"])
        if (Number.isFinite(item[k]) || item[k] === null) state[k] = item[k];
      states.set(item.id, state);
      const a = item.authorization;
      if (
        a &&
        ["locked", "active"].includes(a.state) &&
        (a.expiresAt === null || Number.isSafeInteger(a.expiresAt))
      )
        authorizations.set(item.id, { mode: "client", state: a.state, expiresAt: a.expiresAt });
    }
    this.states = states;
    this.authorizations = authorizations;
  }
  // Accounts (including both credential columns) and live devices rarely change, but the worker polls every
  // second. The version is a digest of the ordered rows; a worker that already holds it gets only the signals.
  async inventory(seen) {
    const accounts = await this.db
      .prepare(
        "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE u.active=1 ORDER BY a.id",
      )
      .all();
    const devices = (await liveDevices(this.db, this.now())).map((d) => d.id);
    const version = createHash("sha256")
      .update(JSON.stringify([accounts, devices]))
      .digest("base64url");
    // Counters, always sent: the worker acts when one differs from the value it last applied.
    const signals = {
      boot: this.boot,
      version,
      invalidations: Object.fromEntries(this.invalidations),
      monitorStops: Object.fromEntries(this.monitorStops),
    };
    return seen === version ? signals : { ...signals, accounts, devices };
  }
  async handle(req, res) {
    try {
      const supplied = bearer(req) || "";
      if (!timingSafeEqual(digest(supplied), digest(this.token))) fail(403, "Worker access denied");
      if (req.method !== "POST") fail(405, "Method not allowed");
      const b = await jsonBody(req, 1048576),
        now = this.now();
      if (!isUuid(b.worker)) fail(400, "Invalid worker identity");
      if (b.op === "register") {
        const previous = this.registerTail;
        let release;
        this.registerTail = new Promise((r) => (release = r));
        await previous;
        try {
          if (
            this.worker &&
            this.worker !== b.worker &&
            this.now() - this.last < WORKER_REGISTRATION
          )
            fail(409, "Mail worker already active");
          if (this.worker !== b.worker) {
            await this.db.exec(
              "UPDATE outbox SET state='unknown' WHERE state='sending'; UPDATE outbox SET state='expired' WHERE state='prepared';",
            );
            this.states.clear();
            this.authorizations.clear();
            this.worker = b.worker;
          }
          this.last = this.now();
          return reply(res, 200, { boot: this.boot });
        } finally {
          release();
        }
      }
      if (this.worker !== b.worker || now - this.last >= WORKER_REGISTRATION)
        fail(409, "Mail worker registration expired");
      let result;
      if (b.op === "release") {
        this.worker = null;
        this.last = 0;
        this.states.clear();
        this.authorizations.clear();
        result = { ok: true };
      } else if (b.op === "inventory") {
        if (b.seen !== undefined && typeof b.seen !== "string")
          fail(400, "Invalid inventory version");
        this.snapshot(b.snapshot);
        this.last = now;
        result = await this.inventory(b.seen);
      } else if (b.op === "authorize")
        result = await this.scope(b.token, b.accountId, b.credential);
      else if (b.op === "needsPreview") {
        if (typeof b.accountId !== "string") fail(400, "Invalid mailbox");
        result = await this.push.needsPreview(b.accountId);
      } else if (b.op === "changed" || b.op === "hint") {
        if (typeof b.accountId !== "string") fail(400, "Invalid mailbox");
        if (b.op === "changed")
          await this.devices.changed(
            b.accountId,
            b.kind === "new_mail" ? "new_mail" : "sync",
            b.notification,
          );
        else if (now - (this.hints.get(b.accountId) || 0) > HOUR) {
          this.hints.set(b.accountId, now);
          await this.push.enqueue(b.accountId);
        }
        result = { ok: true };
      } else if (b.op === "outboxList") {
        const { user } = await this.scope(b.token);
        result = await this.db
          .prepare(
            "SELECT id,state,result FROM outbox WHERE user_id=? ORDER BY created DESC LIMIT 20",
          )
          .all(user.id);
      } else if (b.op === "archive") {
        result = await this.archive.call(b.operation, b.values || {});
      } else if (b.op === "archiveConfigure") {
        result = await this.db.transaction(async () => {
          const { account, user } = await this.scope(b.token, b.accountId, b.credentialRevision);
          if (!account) fail(400, "Mailbox required");
          if (!(await liveSession(this.db, user.session_id, this.now(), true)))
            fail(401, "Access revoked");
          return configureSync(this.db, account, b.settings);
        });
      } else if (b.op === "query") {
        const q = Object.hasOwn(queries, b.name) ? queries[b.name] : null;
        if (
          !q ||
          !Array.isArray(b.args) ||
          b.args.length !== (q[1].match(/\?/g) || []).length ||
          b.args.some((v) => !(v === null || typeof v === "string" || Number.isFinite(v)))
        )
          fail(400, "Unsupported mail store operation");
        if (b.name === "outboxResult") {
          if (!["unknown", "failed", "sent", "partial"].includes(b.args[0]))
            fail(400, "Invalid send state");
          let v;
          try {
            v = JSON.parse(b.args[1]);
          } catch {
            fail(400, "Invalid send result");
          }
          if (
            !v ||
            typeof v !== "object" ||
            Array.isArray(v) ||
            Object.keys(v).some(
              (k) => !["accepted", "rejected", "messageId", "sentCopy", "error"].includes(k),
            ) ||
            b.args[1].length > 4096
          )
            fail(400, "Invalid send result");
        }
        result = await this.db.prepare(q[1])[q[0]](...b.args);
      } else fail(400, "Unsupported mail broker operation");
      reply(res, 200, result ?? null);
    } catch (e) {
      reply(res, e.status || 500, { error: e.status ? e.message : "Mail broker operation failed" });
    }
  }
}
