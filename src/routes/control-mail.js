import { configureSync } from "../archive-store.js";
import { liveSession, mailboxAccess } from "../queries.js";
import { fail } from "../errors.js";

// Context for mailRoutes() when the control service serves mail itself: in-process tests and fixtures only,
// since production startup requires the isolated worker. Every check goes straight to the database, the same
// rules the broker applies for the worker. `account` is the row the dispatcher already loaded for the path.
export function controlMailContext(app, { req, user, device, account }) {
  const {
    db,
    devices,
    leases,
    mail,
    reader,
    sender,
    sync,
    remoteDrafts,
    archive,
    mailOptions,
    verificationKey,
  } = app;
  const requireLiveSession = async (message = "Access revoked", lock = false) => {
    if (!(await liveSession(db, user.session_id, Date.now(), lock))) fail(401, message);
  };
  return {
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
    verificationKey,
    throttle: () => app.limit(req),
    async mailbox(id) {
      if (!account || account.id !== id) fail(404, "Mailbox not found");
      return account;
    },
    async authorize(target, message = "Access revoked") {
      if (!target) return requireLiveSession(message);
      const access = await mailboxAccess(db, {
        device: device?.id ?? null,
        session: user.session_id,
        account: target,
      });
      if (!access.device) fail(403, "Mailbox access denied");
      if (!access.access) fail(401, message);
    },
    exclusive: (target, operation) =>
      db.transaction(async () => {
        const current = await db
          .prepare("SELECT * FROM accounts WHERE id=? AND user_id=? FOR UPDATE")
          .get(target.id, user.id);
        if (!current) fail(404, "Mailbox not found");
        // Device row first, then its session rows: devices.revoke locks them in the same order.
        await db.prepare("SELECT id FROM client_devices WHERE id=? FOR SHARE").get(device.id);
        await requireLiveSession("Access revoked", true);
        return operation(current);
      }),
    configureSync: (target, settings) =>
      db.transaction(async () => {
        await requireLiveSession("Access revoked", true);
        return configureSync(db, target, settings);
      }),
    async resetSync(target) {
      sync.invalidate(target.id);
      leases.revoke(target.id);
      const fresh = await db.prepare("SELECT * FROM accounts WHERE id=?").get(target.id);
      sync.restore(fresh);
      sync.schedule([fresh]);
    },
    changed: (id) => devices.changed(id),
    outboxList: () =>
      db
        .prepare(
          "SELECT id,state,result FROM outbox WHERE user_id=? ORDER BY created DESC LIMIT 20",
        )
        .all(user.id),
  };
}
