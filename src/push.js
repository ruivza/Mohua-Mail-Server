import { GatewaySettings, GatewayProvider } from "./gateway.js";

// One durable, coalesced hint per device. It contains no mailbox content and grants no access.
export class PushService {
  constructor({
    db,
    decrypt,
    officialURL = process.env.OFFICIAL_PUSH_GATEWAY_URL || "",
    transport,
    provider,
    now = Date.now,
    intervalMs = 20 * 60000,
    coalesceMs = 5000,
    autoStart = true,
  }) {
    Object.assign(this, { db, decrypt, now, intervalMs, coalesceMs });
    this.settings = new GatewaySettings(db, officialURL);
    this.provider = provider ?? new GatewayProvider(this.settings, transport);
    this.autoStart = autoStart;
  }
  async initialize() {
    await this.settings.initialize();
    if (this.autoStart) {
      this.timer = setInterval(() => {
        void this.flush();
      }, 1000);
      this.timer.unref();
    }
  }
  async status(device) {
    if (!device?.push_enabled) return "device_disabled";
    if ((await this.settings.current()).mode === "disabled")
      return "server_disabled";
    if (!(await this.settings.current()).gatewayUrl) return "not_configured";
    if (!device?.push_credential) return "not_registered";
    return device.push_error || "ready";
  }
  async configure(input) {
    const previous = (await this.settings.current()).revision;
    const result = await this.settings.configure(input);
    if (previous !== result.revision) this.provider.close();
    return result;
  }
  async validate(device, input) {
    const settings = await this.settings.current();
    if (!settings.gatewayUrl)
      throw Object.assign(Error("Push gateway disabled or unconfigured"), {
        status: 409,
      });
    if (input.revision !== settings.revision)
      throw Object.assign(Error("Push gateway changed"), { status: 409 });
    const result = await this.provider.validate(device, input.credential);
    if (result.status !== 200)
      throw Object.assign(Error("Gateway credential rejected"), {
        status: result.status === 0 ? 502 : 400,
      });
    if (input.revision !== (await this.settings.current()).revision)
      throw Object.assign(Error("Push gateway changed"), { status: 409 });
  }
  async test() {
    const config = await this.settings.current();
    if (!config.gatewayUrl)
      return { reachable: false, ready: false, reason: "未启用或未配置网关" };
    const revision = config.revision;
    const result = await this.provider.health();
    if (revision !== (await this.settings.current()).revision)
      throw Object.assign(Error("Push gateway changed"), { status: 409 });
    const compatible = result.status === 200 && result.body?.protocol === 1;
    return {
      reachable: compatible,
      ready: compatible && result.body?.ready === true,
      reason: compatible
        ? result.body?.ready === true
          ? "网关可用；设备送达需由客户端验证"
          : "网关在线，但推送服务尚未就绪"
        : "无法连接兼容的推送网关",
    };
  }
  async enqueue(account) {
    if (!(await this.settings.current()).gatewayUrl || this.closed) return;
    const devices = await this.db
      .prepare(
        `SELECT d.* FROM client_devices d
      JOIN users u ON u.id=d.user_id JOIN accounts a ON a.user_id=u.id
      WHERE a.id=? AND a.mode='proxy' AND u.active=1 AND d.revoked IS NULL AND d.push_credential IS NOT NULL AND d.push_enabled=1
      AND EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id
        WHERE ds.device_id=d.id AND s.expires>?)`,
      )
      .all(account, this.now());
    for (const device of devices) await this.schedule(device);
  }
  async schedule(device) {
    if (
      !(await this.settings.current()).gatewayUrl ||
      !device.push_credential ||
      !device.push_enabled
    )
      return;
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO push_jobs(device_id,next_at,expires) VALUES(?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET generation=push_jobs.generation+1, expires=excluded.expires`,
      )
      .run(
        device.id,
        Math.max(
          now + this.coalesceMs,
          (device.push_last_sent || 0) + this.intervalMs,
          device.push_not_before || 0,
        ),
        now + 86400000,
      );
  }
  async eligible(id) {
    return await this.db
      .prepare(
        `SELECT d.* FROM client_devices d JOIN users u ON u.id=d.user_id
      WHERE d.id=? AND d.revoked IS NULL AND d.push_credential IS NOT NULL AND d.push_enabled=1 AND u.active=1
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.user_id=u.id AND a.mode='proxy')
      AND EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id
        WHERE ds.device_id=d.id AND s.expires>?)`,
      )
      .get(id, this.now());
  }
  flush() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = (async () => {
      if (!(await this.settings.current()).gatewayUrl || this.closed) return;
      await this.deliver();
    })()
      .catch(() => {
        // Keep durable jobs retryable when PostgreSQL or the gateway is unavailable.
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async deliver() {
    await this.db
      .prepare("DELETE FROM push_jobs WHERE expires<=?")
      .run(this.now());
    const jobs = await this.db
      .prepare(
        "SELECT * FROM push_jobs WHERE next_at<=? ORDER BY next_at LIMIT 20",
      )
      .all(this.now());
    for (const job of jobs) {
      if (this.closed) return;
      const device = await this.eligible(job.device_id);
      if (!device) {
        await this.remove(job.device_id);
        continue;
      }
      const revision = (await this.settings.current()).revision;
      let result;
      try {
        result = await this.provider.send(
          device,
          this.decrypt(device.push_credential),
        );
      } catch {
        result = { status: 0 };
      }
      await this.db.transaction(async () => {
        if (this.closed) return;
        await this.db
          .prepare("SELECT id FROM push_settings WHERE id=1 FOR SHARE")
          .get();
        await this.db
          .prepare("SELECT id FROM client_devices WHERE id=? FOR UPDATE")
          .get(device.id);
        if (revision !== (await this.settings.current()).revision) return;
        // A late rejection of an old registration cannot invalidate a newly registered token.
        const current = await this.eligible(device.id);
        if (!current) {
          await this.remove(device.id);
          return;
        }
        if (current.push_registered !== device.push_registered) return;
        if (result.status === 200) {
          await this.db
            .prepare(
              "UPDATE client_devices SET push_last_sent=?,push_error=NULL,push_not_before=0 WHERE id=?",
            )
            .run(this.now(), device.id);
          await this.db
            .prepare("DELETE FROM push_jobs WHERE device_id=? AND generation=?")
            .run(device.id, job.generation);
          await this.db
            .prepare(
              "UPDATE push_jobs SET next_at=?,attempts=0 WHERE device_id=?",
            )
            .run(this.now() + this.intervalMs, device.id);
          return;
        }
        const invalid =
          result.status === 410 ||
          ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(result.reason);
        if (
          invalid &&
          !(
            result.status === 410 &&
            Number.isFinite(result.timestamp) &&
            result.timestamp < device.push_registered
          )
        ) {
          await this.db
            .prepare(
              `UPDATE client_devices SET push_credential=NULL,push_token=NULL,push_environment=NULL,
          push_token_hash=NULL,push_error='not_registered' WHERE id=?`,
            )
            .run(device.id);
          await this.remove(device.id);
          return;
        }
        const retry =
          !result.status ||
          result.status === 429 ||
          result.status >= 500 ||
          result.status === 403 ||
          invalid;
        const attempts = job.attempts + 1;
        const exhausted = attempts >= 8;
        const delay =
          !retry || exhausted
            ? 3600000
            : Math.min(3600000, 60000 * 2 ** (attempts - 1));
        await this.db
          .prepare(
            "UPDATE client_devices SET push_error=?,push_not_before=? WHERE id=?",
          )
          .run(
            result.status === 403
              ? "configuration_error"
              : !retry
                ? "rejected"
                : exhausted
                  ? "retry_exhausted"
                  : "retrying",
            this.now() + delay,
            device.id,
          );
        if (!retry || exhausted) {
          await this.remove(device.id);
          return;
        }
        await this.db
          .prepare(
            "UPDATE push_jobs SET attempts=?,next_at=? WHERE device_id=?",
          )
          .run(attempts, this.now() + delay, device.id);
      });
    }
  }
  async remove(id) {
    await this.db.prepare("DELETE FROM push_jobs WHERE device_id=?").run(id);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.provider?.close();
    await this.running;
  }
}
