import { MINUTE, DAY } from "./limits.js";

// Bounded, process-local HTTP diagnostics. Never retain URLs, user IDs or messages.
export class Operations {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.started = now();
    this.buckets = new Map();
    this.errors = [];
  }
  record({ method, path, status, duration, aborted = false }) {
    if (!path.startsWith("/api/") || path.startsWith("/api/admin/")) return;
    const at = this.now(),
      minute = Math.floor(at / MINUTE);
    for (const key of this.buckets.keys()) if (key < minute - 59) this.buckets.delete(key);
    const bucket = this.buckets.get(minute) || { requests: 0, errors: 0, aborted: 0, elapsed: 0 };
    bucket.requests++;
    bucket.elapsed += duration;
    bucket.errors += +(status >= 500);
    bucket.aborted += +aborted;
    this.buckets.set(minute, bucket);
    if (status >= 500 || aborted) {
      const operation =
        /^\/api\/accounts\/[^/]+\/outbox/.test(path) || path.startsWith("/api/outbox/")
          ? "send"
          : path.startsWith("/api/accounts/")
            ? "mailbox"
            : path.startsWith("/api/client")
              ? "client"
              : "api";
      this.errors.unshift({
        at,
        method: ["GET", "POST", "PATCH", "DELETE", "PUT"].includes(method) ? method : "OTHER",
        operation,
        status: aborted ? null : status,
        code: aborted ? "RESPONSE_ABORTED" : "HTTP_5XX",
      });
      this.errors.length = Math.min(this.errors.length, 50);
    }
  }
  snapshot() {
    const min = Math.floor(this.now() / MINUTE) - 59;
    const total = { requests: 0, errors: 0, aborted: 0, elapsed: 0 };
    for (const [key, b] of this.buckets) {
      if (key < min) {
        this.buckets.delete(key);
        continue;
      }
      for (const name of Object.keys(total)) total[name] += b[name];
    }
    this.errors = this.errors.filter((e) => e.at >= min * MINUTE);
    return {
      since: Math.max(this.started, min * MINUTE),
      ...total,
      averageMs: total.requests ? Math.round(total.elapsed / total.requests) : null,
      recent: this.errors,
    };
  }
}

export async function businessHealth(db, mail, push, now = Date.now()) {
  const accounts = await db
    .prepare(
      "SELECT a.id FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.monitor_enabled=1 AND u.active=1",
    )
    .all();
  const listeners = {
    expected: accounts.length,
    connected: 0,
    connecting: 0,
    reconnecting: 0,
    missing: 0,
    prolonged: 0,
  };
  for (const { id } of accounts) {
    const state = mail.state(id);
    const key =
      { listening: "connected", connecting: "connecting", reconnecting: "reconnecting" }[
        state.connectionStatus
      ] || "missing";
    listeners[key]++;
    if (
      key !== "connected" &&
      state.disconnectedSince &&
      now - state.disconnectedSince >= 5 * MINUTE
    )
      listeners.prolonged++;
  }
  const outgoing = await db
    .prepare(
      `SELECT count(*) total,
    count(*) FILTER(WHERE state='failed') failed,
    count(*) FILTER(WHERE state='unknown') unknown,
    count(*) FILTER(WHERE state='partial') partial,
    count(*) FILTER(WHERE state='sending') sending,
    count(*) FILTER(WHERE state IN ('sent','partial') AND result::jsonb->>'sentCopy' IN ('failed','failed_or_unknown')) copy_issues
    FROM outbox WHERE created>=?`,
    )
    .get(now - DAY);
  const config = await push.settings.current();
  const notification = {
    enabled: !!config.gatewayUrl,
    pending: 0,
    retrying: 0,
    overdue: 0,
    overdueSeconds: 0,
    failedDevices: 0,
  };
  if (notification.enabled) {
    // Scheduled throttling/backoff is not overdue until next_at has passed.
    const queue = await db
      .prepare(
        `SELECT count(*) pending,
      count(*) FILTER(WHERE j.attempts>0) retrying,
      count(*) FILTER(WHERE j.next_at<?) overdue,
      min(j.next_at) FILTER(WHERE j.next_at<?) oldest
      FROM push_jobs j JOIN client_devices d ON d.id=j.device_id JOIN users u ON u.id=d.user_id
      WHERE j.expires>? AND d.revoked IS NULL AND d.push_enabled=1 AND d.push_credential IS NOT NULL AND u.active=1
      AND EXISTS(SELECT 1 FROM accounts a WHERE a.user_id=u.id AND a.mode='proxy')
      AND EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id WHERE ds.device_id=d.id AND s.expires>?)`,
      )
      .get(now, now, now, now);
    Object.assign(notification, {
      pending: queue.pending,
      retrying: queue.retrying,
      overdue: queue.overdue,
      overdueSeconds:
        queue.oldest == null ? 0 : Math.max(0, Math.floor((now - queue.oldest) / 1000)),
    });
    notification.failedDevices = (
      await db
        .prepare(
          `SELECT count(*) n FROM client_devices d JOIN users u ON u.id=d.user_id
      WHERE d.revoked IS NULL AND d.push_enabled=1 AND u.active=1
      AND d.push_error IN ('configuration_error','rejected','retry_exhausted')
      AND EXISTS(SELECT 1 FROM device_sessions ds JOIN sessions s ON s.id=ds.session_id WHERE ds.device_id=d.id AND s.expires>?)`,
        )
        .get(now)
    ).n;
  }
  return { listeners, outgoing, notification };
}
