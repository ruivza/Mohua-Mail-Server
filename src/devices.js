import { randomUUID } from "node:crypto";
import { hashToken, newToken } from "./auth.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export class DeviceService {
  constructor({ db, seal }) {
    this.db = db;
    this.seal = seal;
  }

  name(value) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 80 ||
      /[\x00-\x1f]/.test(value)
    ) {
      fail(400, "Invalid device name");
    }
    return value.trim();
  }

  // Only called after password authentication. A device ID alone grants no access.
  async enroll(user, input) {
    const name = this.name(input.name);
    if (input.platform !== "ios") fail(400, "Invalid platform");
    if (
      input.deviceId !== undefined &&
      (typeof input.deviceId !== "string" || input.deviceId.length > 100)
    ) {
      fail(400, "Invalid device ID");
    }
    return this.db.transaction(async () => {
      const owner = await this.db
        .prepare("SELECT id FROM users WHERE id=? AND active=1 FOR UPDATE")
        .get(user);
      if (!owner) fail(401, "Access revoked");
      const previous = input.deviceId
        ? await this.db
            .prepare("SELECT * FROM client_devices WHERE id=? AND user_id=?")
            .get(input.deviceId, user)
        : null;
      const active = previous && previous.revoked === null;
      if (
        !active &&
        (
          await this.db
            .prepare(
              "SELECT COUNT(*) n FROM client_devices WHERE user_id=? AND revoked IS NULL",
            )
            .get(user)
        ).n >= 20
      ) {
        fail(409, "Maximum 20 devices; revoke an existing device first");
      }
      const deviceId = active ? previous.id : randomUUID();
      const sessionId = randomUUID();
      const token = newToken();
      const expires = Date.now() + 30 * 86400000;
      if (active) {
        await this.db
          .prepare(
            "DELETE FROM sessions WHERE id IN (SELECT session_id FROM device_sessions WHERE device_id=?)",
          )
          .run(deviceId);
        await this.db
          .prepare("UPDATE client_devices SET name=? WHERE id=?")
          .run(name, deviceId);
      } else {
        await this.db
          .prepare(
            "INSERT INTO client_devices(id,user_id,name,platform,created) VALUES(?,?,?,?,?)",
          )
          .run(deviceId, user, name, input.platform, Date.now());
      }
      await this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
        .run(sessionId, user, hashToken(token), name, expires);
      await this.db
        .prepare("INSERT INTO device_sessions VALUES(?,?)")
        .run(sessionId, deviceId);
      return { deviceId, sessionId, token, expires };
    });
  }

  async deviceForSession(session) {
    return await this.db
      .prepare(
        `SELECT d.* FROM client_devices d JOIN device_sessions s ON s.device_id=d.id
      WHERE s.session_id=? AND d.revoked IS NULL`,
      )
      .get(session);
  }

  async own(user, id) {
    const device = await this.db
      .prepare(
        "SELECT * FROM client_devices WHERE id=? AND user_id=? AND revoked IS NULL",
      )
      .get(id, user);
    if (!device) fail(404, "Device not found");
    return device;
  }

  async list(user) {
    return await Promise.all(
      (
        await this.db
          .prepare(
            `SELECT d.id,d.name,d.platform,d.created,
      EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id
        WHERE ds.device_id=d.id AND s.expires>?) "sessionActive"
      FROM client_devices d WHERE d.user_id=? AND d.revoked IS NULL ORDER BY d.created`,
          )
          .all(Date.now(), user)
      ).map(async (device) => ({
        ...device,
        sessionActive: Boolean(device.sessionActive),
        pushStatus:
          (await this.pushService?.status(await this.own(user, device.id))) ??
          "not_configured",
      })),
    );
  }

  async revoke(user, id) {
    await this.own(user, id);
    const result = await this.db.transaction(async () => {
      await this.db
        .prepare("SELECT id FROM client_devices WHERE id=? FOR UPDATE")
        .get(id);
      await this.db
        .prepare(
          "DELETE FROM sessions WHERE id IN (SELECT session_id FROM device_sessions WHERE device_id=?)",
        )
        .run(id);
      await this.db
        .prepare("DELETE FROM device_mailboxes WHERE device_id=?")
        .run(id);
      await this.pushService?.remove(id);
      await this.db
        .prepare(
          "UPDATE client_devices SET revoked=?,push_credential=NULL,push_token=NULL,push_environment=NULL,push_token_hash=NULL,push_error=NULL WHERE id=?",
        )
        .run(Date.now(), id);
    });
    this.onRevoke?.(id);
    return result;
  }

  // Mailbox ownership is user-wide. device_mailboxes stores sync progress, not permissions.
  async allowed(device, account) {
    return Boolean(
      await this.db
        .prepare(
          `SELECT 1 FROM client_devices d JOIN accounts a ON a.user_id=d.user_id
      WHERE d.id=? AND a.id=? AND d.revoked IS NULL`,
        )
        .get(device, account),
    );
  }

  async changed(account) {
    if (
      !(await this.db
        .prepare("SELECT id FROM accounts WHERE id=?")
        .get(account))
    )
      return;
    await this.db
      .prepare(
        `INSERT INTO mailbox_revisions VALUES(?,1)
      ON CONFLICT(account_id) DO UPDATE SET revision=mailbox_revisions.revision+1`,
      )
      .run(account);
    await this.pushService?.enqueue(account);
  }

  async sync(device) {
    const mailboxes = await this.db
      .prepare(
        `SELECT a.id,a.email,a.mode,a.imap_host,a.imap_port,a.smtp_host,a.smtp_port,
      COALESCE(m.acked,0) acked, COALESCE(r.revision,1) revision FROM accounts a
      LEFT JOIN device_mailboxes m ON m.account_id=a.id AND m.device_id=?
      LEFT JOIN mailbox_revisions r ON r.account_id=a.id WHERE a.user_id=?`,
      )
      .all(device.id, device.user_id);
    return {
      deviceId: device.id,
      pushStatus: (await this.pushService?.status(device)) ?? "not_configured",
      reconcileRequired: true,
      mailboxes: mailboxes.map((account) => ({
        ...account,
        syncPending: account.revision > account.acked,
      })),
    };
  }

  async ack(device, body) {
    if (!Number.isSafeInteger(body.revision) || body.revision < 1)
      fail(400, "Invalid revision");
    if (
      typeof body.accountId !== "string" ||
      !(await this.allowed(device.id, body.accountId))
    )
      fail(404, "Mailbox not found");
    const revision =
      (
        await this.db
          .prepare("SELECT revision FROM mailbox_revisions WHERE account_id=?")
          .get(body.accountId)
      )?.revision ?? 1;
    if (body.revision > revision) fail(409, "Revision is ahead of server");
    await this.db
      .prepare(
        `INSERT INTO device_mailboxes(device_id,account_id,acked) VALUES(?,?,?)
      ON CONFLICT(device_id,account_id) DO UPDATE SET acked=GREATEST(device_mailboxes.acked,excluded.acked)`,
      )
      .run(device.id, body.accountId, body.revision);
    return { acknowledged: true };
  }

  async push(device, body, sessionId) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail(400, "Invalid gateway registration");
    if (body.enabled === false || body.token === null) {
      await this.db
        .prepare(
          `UPDATE client_devices SET push_enabled=0,push_credential=NULL,push_token=NULL,
        push_environment=NULL,push_token_hash=NULL,push_error=NULL,push_registered=push_registered+1 WHERE id=?`,
        )
        .run(device.id);
      await this.pushService?.remove(device.id);
      return;
    }
    if (body.enabled === true && body.credential === undefined) {
      await this.db
        .prepare("UPDATE client_devices SET push_enabled=1 WHERE id=?")
        .run(device.id);
      return;
    }
    if (
      body.enabled !== true ||
      typeof body.credential !== "string" ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(body.credential) ||
      typeof body.revision !== "string"
    )
      fail(400, "Invalid gateway registration");
    const generation = (await this.own(device.user_id, device.id))
      .push_registered;
    await this.pushService.validate(device, body);
    await this.db.transaction(async () => {
      const config = await this.db
        .prepare("SELECT revision FROM push_settings WHERE id=1 FOR SHARE")
        .get();
      if (config.revision !== body.revision) fail(409, "Push gateway changed");
      await this.db
        .prepare("SELECT id FROM client_devices WHERE id=? FOR UPDATE")
        .get(device.id);

      if (
        sessionId &&
        !(await this.db
          .prepare("SELECT 1 FROM sessions WHERE id=? AND expires>?")
          .get(sessionId, Date.now()))
      )
        fail(401, "Access revoked");
      const current = await this.own(device.user_id, device.id);
      if (current.push_registered !== generation)
        fail(409, "Device push registration changed");
      const validSession = await this.db
        .prepare(
          `SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
      JOIN device_sessions ds ON ds.session_id=s.id WHERE u.id=? AND u.active=1 AND ds.device_id=? AND s.expires>?`,
        )
        .get(device.user_id, device.id, Date.now());
      if (!validSession) fail(401, "Access revoked");
      await this.db
        .prepare(
          `UPDATE client_devices SET push_enabled=1,push_credential=?,push_token=NULL,
      push_environment=NULL,push_token_hash=NULL,push_registered=?,push_error=NULL,push_not_before=0 WHERE id=?`,
        )
        .run(
          this.seal(body.credential),
          Math.max(Date.now(), generation + 1),
          device.id,
        );
      await this.pushService.remove(device.id);
      await this.pushService.schedule(
        await this.own(device.user_id, device.id),
      );
    });
  }
}
