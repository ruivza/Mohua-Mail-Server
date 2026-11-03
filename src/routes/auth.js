import { iosDeviceName } from "../device-name.js";

const SIGN_IN = new Set(["/api/setup", "/api/register", "/api/login", "/api/client/login"]);

// Unauthenticated endpoints. All of them are rate limited per client address.
export async function signInRoutes(app, { req, path, body, send }) {
  if (req.method !== "POST" || !SIGN_IN.has(path)) return false;
  app.limit(req);
  if (path === "/api/setup") return send(201, await app.auth.setup(body));
  if (path === "/api/register") return send(201, await app.auth.register(body));
  if (path === "/api/login")
    return send(200, await app.auth.adminLogin(body, req.headers["user-agent"]));
  const identity = await app.auth.login(body);
  const session = await app.devices.enroll(identity.id, {
    name: iosDeviceName(body.deviceInfo),
    platform: "ios",
    deviceId: body.deviceId,
  });
  return send(200, { ...session, user: { id: identity.id, email: identity.email, role: "user" } });
}

// Session endpoints shared by administrators and client users.
export const SESSION_ROUTES = ["/api/me", "/api/logout", "/api/devices"];
export const isSessionRoute = (path) =>
  SESSION_ROUTES.includes(path) || path.startsWith("/api/devices/");

export async function sessionRoutes(app, { req, path, user, device, administrator, send }) {
  const { db, devices } = app;
  if (path === "/api/me" && req.method === "GET")
    return send(200, {
      id: user.id,
      email: user.email,
      role: user.role,
      sessionId: user.session_id,
    });
  if (path === "/api/logout" && req.method === "POST") {
    if (device) await devices.revoke(user.id, device.id);
    else await db.prepare("DELETE FROM admin_sessions WHERE id=?").run(user.session_id);
    return send(200, { revoked: true });
  }
  if (path === "/api/devices" && req.method === "GET")
    return send(
      200,
      administrator
        ? await db
            .prepare("SELECT id,name,expires FROM admin_sessions WHERE admin_id=? AND expires>?")
            .all(user.id, Date.now())
        : await db
            .prepare("SELECT id,name,expires FROM sessions WHERE user_id=? AND expires>?")
            .all(user.id, Date.now()),
    );
  if (path.startsWith("/api/devices/") && req.method === "DELETE") {
    const id = path.split("/").at(-1);
    // A client session belongs to one device; ending it revokes that device and the mailbox leases it holds.
    if (administrator)
      await db.prepare("DELETE FROM admin_sessions WHERE id=? AND admin_id=?").run(id, user.id);
    else await devices.revokeSession(user.id, id);
    return send(200, { revoked: true });
  }
  return false;
}
