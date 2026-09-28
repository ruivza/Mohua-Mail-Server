import { encryptNotification, notificationAlgorithm } from "./notification-crypto.js";
import { GatewaySettings, GatewayProvider } from "./gateway.js";

// Honor bounded Retry-After values without accepting negative, infinite or invalid delays.
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) - now : 0;
  return Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0;
}

// One durable, coalesced hint per device. Preview content is stored only as ciphertext.
export class PushService {
  constructor({
    db,
    decrypt,
    officialURL = process.env.OFFICIAL_PUSH_GATEWAY_URL || "",
    transport,
    provider,
    now = Date.now,
    intervalMs = 20 * 60000,
    alertIntervalMs = 60000,
    coalesceMs = 5000,
    autoStart = true,
    random = Math.random,
  }) {
    Object.assign(this, { db, decrypt, now, intervalMs, alertIntervalMs, coalesceMs, random });
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
    const result = await this.provider.validate(device, input.credential, input.alertsEnabled === true ? "new_mail" : "sync");
    if (result.status !== 200)
      throw Object.assign(Error("Gateway credential rejected"), {
        status: result.status === 429 ? 429 : result.status >= 500 || result.status === 0 ? 503 : 400,
        retryAfter: Math.ceil(Math.max(60000, retryAfterMs(result.retryAfter, this.now())) / 1000),
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
  async capabilities() {
    const result = await this.provider.health();
    const supported = result.status === 200 && result.body?.kinds?.includes("encrypted_alert") && result.body?.notificationEncryption === notificationAlgorithm;
    return {kinds:supported ? ['sync','encrypted_alert'] : ['sync'], notificationEncryption:supported ? notificationAlgorithm : null};
  }
  async recipientDevices(account) {
    if (!(await this.settings.current()).gatewayUrl || this.closed) return [];
    return await this.db
      .prepare(
        `SELECT d.* FROM client_devices d
      JOIN users u ON u.id=d.user_id JOIN accounts a ON a.user_id=u.id
      WHERE a.id=? AND a.mode='proxy' AND u.active=1 AND d.revoked IS NULL AND d.push_credential IS NOT NULL AND d.push_enabled=1
      AND EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id
        WHERE ds.device_id=d.id AND s.expires>?)`,
      )
      .all(account, this.now());
  }
  async needsPreview(account) {
    return (await this.recipientDevices(account)).some(device => device.push_alerts && device.notification_key);
  }
  async enqueue(account, kind = "sync", notification) {
    for (const device of await this.recipientDevices(account)) await this.schedule(device, kind === "new_mail" && device.push_alerts ? "new_mail" : "sync", notification);
  }
  async schedule(device, kind = "sync", notification) {
    return this.db.transaction(async () => {
      // Match registration lock order; reject snapshots taken before a preference/key change.
      await this.db.prepare("SELECT id FROM push_settings WHERE id=1 FOR SHARE").get();
      await this.db.prepare("SELECT id FROM client_devices WHERE id=? FOR UPDATE").get(device.id);
      const current = await this.eligible(device.id);
      if (!current || current.push_registered !== device.push_registered) return;
      device = current;
      if (!device.push_alerts) kind = "sync";
      await this.scheduleLocked(device, kind, notification);
    });
  }
  async scheduleLocked(device, kind, notification) {
    if (
      !(await this.settings.current()).gatewayUrl ||
      !device.push_credential ||
      !device.push_enabled
    )
      return;
    const now = this.now();
    const config = await this.settings.current();
    const encrypted = kind === 'new_mail' && notification && device.notification_key
      ? JSON.stringify(encryptNotification(JSON.parse(device.notification_key), notification,
        {appId:config.appId,deviceId:device.id,serverId:config.serverId}, now)) : null;
    await this.db
      .prepare(
        `INSERT INTO push_jobs(device_id,next_at,expires,kind,alert_generation,notification) VALUES(?,?,?,?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET generation=push_jobs.generation+1, expires=CASE WHEN push_jobs.kind='new_mail' AND excluded.kind='sync' THEN push_jobs.expires ELSE excluded.expires END,
      next_at=CASE WHEN excluded.kind='new_mail' AND push_jobs.attempts=0 THEN LEAST(push_jobs.next_at,excluded.next_at) ELSE push_jobs.next_at END,
      kind=CASE WHEN excluded.kind='new_mail' THEN 'new_mail' ELSE push_jobs.kind END,
      alert_generation=CASE WHEN excluded.kind='new_mail' THEN push_jobs.generation+1 ELSE push_jobs.alert_generation END,
      notification=CASE WHEN excluded.kind='new_mail' THEN excluded.notification ELSE push_jobs.notification END`,
      )
      .run(
        device.id,
        Math.max(
          now + this.coalesceMs,
          (device.push_last_sent || 0) + (kind === "new_mail" ? this.alertIntervalMs : this.intervalMs),
          device.push_not_before || 0,
        ),
        now + 86400000,
        kind,
        kind === "new_mail" ? 1 : 0,
        encrypted,
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
      await this.db.prepare("DELETE FROM push_jobs WHERE expires<=?").run(this.now());
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
    const jobs = await this.db
      .prepare(
        "SELECT * FROM push_jobs WHERE next_at<=? ORDER BY next_at LIMIT 20",
      )
      .all(this.now());
    let next = 0;
    // Refill each slot as soon as its request completes; keep one job per device.
    // Await every worker even on database failure so flush/close never leave sends running.
    let failure;
    const worker = async () => {
      while (!this.closed && !failure && next < jobs.length) {
        const job = jobs[next++];
        try { await this.deliverJob(job); }
        catch (error) { failure = error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    if (failure) throw failure;
  }
  async deliverJob(job) {
    if (this.closed) return;
    const device = await this.eligible(job.device_id);
    if (!device) {
      await this.remove(job.device_id);
      return;
    }
    const revision = (await this.settings.current()).revision;
    let result;
    try {
      result = await this.provider.send(
        device,
        this.decrypt(device.push_credential),
        job.kind === "new_mail" && device.push_alerts ? "new_mail" : "sync",
        job.kind === "new_mail" && device.push_alerts && job.notification ? JSON.parse(job.notification) : undefined,
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
            "UPDATE push_jobs SET next_at=CASE WHEN kind='new_mail' AND alert_generation>? THEN CAST(? AS BIGINT) ELSE CAST(? AS BIGINT) END,attempts=0,kind=CASE WHEN kind='new_mail' AND alert_generation<=? THEN 'sync' ELSE kind END,notification=CASE WHEN alert_generation<=? THEN NULL ELSE notification END WHERE device_id=?",
          )
          .run(job.generation, this.now() + this.alertIntervalMs, this.now() + this.intervalMs, job.generation, job.generation, device.id);
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
      const delay = Math.max(
        !retry || exhausted ? 3600000 : Math.min(3600000, 60000 * 2 ** (attempts - 1)),
        retryAfterMs(result.retryAfter, this.now()),
      ) + Math.floor(this.random() * 5000);
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
