import { businessHealth } from "../operations.js";
import { hashToken, newToken } from "../auth.js";
import { fail } from "../errors.js";
import { INVITE_TTL } from "../limits.js";

// Administration console API. Administrators never own mailboxes and never see mail content.
export async function adminRoutes(app, { req, path, user, body, send }) {
  if (!path.startsWith("/api/admin/")) return false;
  if (user.role !== "admin") fail(403, "Administrator required");
  const { db, push, health, mail, reader, devices } = app;
  if (path === "/api/admin/push" && req.method === "GET")
    return send(200, await push.settings.current());
  if (path === "/api/admin/push" && req.method === "PATCH")
    return send(200, await push.configure(body));
  if (path === "/api/admin/push/test" && req.method === "POST") return send(200, await push.test());
  if (path === "/api/admin/health" && req.method === "GET")
    return send(200, {
      ...(await health.summary()),
      business: await businessHealth(db, mail, push),
      traffic: app.operations.snapshot(),
      counts: {
        users: (await db.prepare("SELECT COUNT(*) n FROM users").get()).n,
        activeUsers: (await db.prepare("SELECT COUNT(*) n FROM users WHERE active=1").get()).n,
        mailboxes: (await db.prepare("SELECT COUNT(*) n FROM accounts").get()).n,
      },
    });
  if (path === "/api/admin/health/run" && req.method === "POST")
    return send(202, await health.run());
  if (path === "/api/admin/users" && req.method === "GET")
    return send(200, await db.prepare("SELECT id,email,role,active FROM users").all());
  if (path === "/api/admin/invites" && req.method === "POST") {
    const invite = newToken();
    const expires = Date.now() + INVITE_TTL;
    await db.prepare("INSERT INTO invites VALUES(?,?)").run(hashToken(invite), expires);
    return send(201, { invite, expires });
  }
  if (path.startsWith("/api/admin/users/") && req.method === "PATCH") {
    const id = path.split("/").at(-1);
    if (!(await db.prepare("SELECT id FROM users WHERE id=?").get(id))) fail(404, "User not found");
    if (typeof body.active !== "boolean") fail(400, "active must be boolean");
    await db.prepare("UPDATE users SET active=? WHERE id=?").run(body.active ? 1 : 0, id);
    if (!body.active) {
      for (const device of await devices.list(id)) await devices.revoke(id, device.id);
      await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      // Revoking the devices above ends in-process leases; in isolated mode invalidate makes the worker drop
      // them as well. stop closes the listeners.
      for (const a of await db.prepare("SELECT id FROM accounts WHERE user_id=?").all(id)) {
        reader.invalidate(a.id);
        mail.stop(a.id);
      }
    } else {
      for (const a of await db
        .prepare("SELECT * FROM accounts WHERE user_id=? AND monitor_enabled=1")
        .all(id))
        void mail.start(a);
    }
    return send(200, { updated: true });
  }
  return false;
}
