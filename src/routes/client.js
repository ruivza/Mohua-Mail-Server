import { fail } from "../errors.js";

// iOS client endpoints: device sync state, push registration and device management.
export async function clientRoutes(app, { req, path, user, device, body, send }) {
  const { devices, push } = app;
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
    if (path === "/api/client/push/ticket" && req.method === "POST")
      return send(200, await push.provider.registrationTicket(device));
    if (path === "/api/client/push/config" && req.method === "GET")
      return send(200, {
        ...(await push.settings.current()),
        pushStatus: await push.status(device),
        enabled: Boolean(device.push_enabled),
        ...(await push.capabilities()),
      });
    if (path === "/api/client/push" && req.method === "POST") {
      await devices.push(device, body, user.session_id);
      return send(200, { pushStatus: await push.status(await devices.own(user.id, device.id)) });
    }
  }
  if (path === "/api/client-devices" && req.method === "GET")
    return send(200, await devices.list(user.id));
  const target = path.match(/^\/api\/client-devices\/([^/]+)$/);
  if (target && req.method === "DELETE") {
    await devices.revoke(user.id, target[1]);
    return send(200, { revoked: true });
  }
  return false;
}
