// SQL shared by the control routes and the mail broker. Keep the liveness rules in one place so the
// HTTP checks, the control lease tick and the worker inventory cannot drift apart.

// A device may keep a mailbox authorization only while it is not revoked, its user is active and at least
// one of its sessions is unexpired. Signing out or letting the session expire therefore ends its leases too.
const deviceAlive = `d.revoked IS NULL AND u.active=1 AND EXISTS(SELECT 1 FROM device_sessions ds
  JOIN sessions s ON s.id=ds.session_id WHERE ds.device_id=d.id AND s.expires>?)`;

export const liveDevices = (db, now = Date.now()) =>
  db
    .prepare(
      `SELECT d.id FROM client_devices d JOIN users u ON u.id=d.user_id WHERE ${deviceAlive} ORDER BY d.id`,
    )
    .all(now);

// Owner of each listed device that is still alive, in one query for every leased mailbox.
export async function liveDeviceOwners(db, ids, now = Date.now()) {
  if (!ids.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT d.id,d.user_id FROM client_devices d JOIN users u ON u.id=d.user_id WHERE d.id=ANY(?) AND ${deviceAlive}`,
    )
    .all(ids, now);
  return new Map(rows.map((row) => [row.id, row.user_id]));
}

// The caller's session is unexpired, its user active and its device not revoked. Callers that change
// mailbox authorization state lock the rows so a concurrent revocation waits for them.
export const liveSession = (db, session, now = Date.now(), lock = false) =>
  db
    .prepare(
      `SELECT s.id FROM sessions s
    JOIN users u ON u.id=s.user_id JOIN device_sessions ds ON ds.session_id=s.id
    JOIN client_devices d ON d.id=ds.device_id
    WHERE s.id=? AND s.expires>? AND u.active=1 AND d.revoked IS NULL${lock ? " FOR SHARE OF s,u,d" : ""}`,
    )
    .get(session, now);

// Re-checked during and after mailbox I/O: the device still belongs to the owner and is not revoked, and the
// session is alive while the mailbox keeps the mode and credential revision the request started with.
export const mailboxAccess = (db, { device, session, account, now = Date.now() }) =>
  db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM client_devices d JOIN accounts a ON a.user_id=d.user_id
      WHERE d.id=? AND a.id=? AND d.revoked IS NULL) AS device,
    EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id JOIN accounts a ON a.user_id=u.id
      WHERE s.id=? AND s.expires>? AND u.active=1 AND a.id=? AND a.mode=? AND a.credential IS NOT DISTINCT FROM ?) AS access`,
    )
    .get(device, account.id, session, now, account.id, account.mode, account.credential);
