import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { publicAddress } from "./mail.js";

// Independent synthetic account. Never reads the users/accounts tables.
export function describeProbeError(error, aborted = false) {
  const code = String(error.code || ""),
    cause = String(error.cause?.code || "");
  if (
    ["EPERM", "EACCES"].includes(code) ||
    ["EPERM", "EACCES"].includes(cause) ||
    [-4048, -4092, -13, -1].includes(error.errno)
  )
    return {
      status: "error",
      detail: "服务器进程无出站网络权限，请检查启动环境或防火墙（本地权限）",
    };
  if (code === "EAUTH" || error.authenticationFailed)
    return {
      status: "external_error",
      detail: "测试服务认证失败，请检查测试账号是否仍有效（EAUTH）",
    };
  if (aborted || code === "ETIMEDOUT")
    return {
      status: "external_error",
      detail: "连接或读取测试服务超时（ETIMEDOUT），请稍后重试",
    };
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ESOCKET",
      "ETLS",
      "EEXTERNAL",
    ].includes(code)
  )
    return {
      status: "external_error",
      detail: "测试服务连接失败（" + code + "），请检查网络、DNS 或 TLS",
    };
  return { status: "error", detail: "邮件自检未完成，请查看失败阶段" };
}
export class HealthService {
  constructor({ db, seal, decrypt, mail, probe, intervalMs = 60000 }) {
    Object.assign(this, { db, seal, decrypt, mail, intervalMs });
    this.probe = probe || this.externalProbe.bind(this);
    this.running = false;
    this.closed = false;
    this.lastTick = Date.now();
    this.cpu = process.cpuUsage();
    this.cpuAt = performance.now();
  }
  async initialize() {
    const db = this.db,
      intervalMs = this.intervalMs;
    await db
      .prepare(
        "UPDATE selftest_runs SET status='unknown',stage='interrupted',detail='服务重启，自检中断' WHERE status='running'",
      )
      .run();
    await this.sample();
    this.timer = setInterval(() => {
      if (this.tick || this.closed) return;
      this.tick = (async () => {
        await this.sample();
        if (!this.closed) await this.scheduled();
      })()
        .catch(() => {})
        .finally(() => {
          this.tick = null;
        });
    }, intervalMs);
    this.timer.unref();
  }
  async get(key) {
    return (
      await this.db
        .prepare("SELECT value FROM service_settings WHERE key=?")
        .get(key)
    )?.value;
  }
  async put(key, value) {
    await this.db
      .prepare(
        "INSERT INTO service_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  async settings() {
    return {
      enabled: (await this.get("enabled")) === "true",
      intervalMinutes: Number((await this.get("interval")) || 60),
      accountReady: !!(await this.get("ethereal")),
    };
  }
  async configure(body) {
    if (
      typeof body.enabled !== "boolean" ||
      ![15, 30, 60, 180, 360].includes(body.intervalMinutes)
    )
      throw Object.assign(new Error("Choose a valid interval"), {
        status: 400,
      });
    await this.put("enabled", String(body.enabled));
    await this.put("interval", String(body.intervalMinutes));
    return await this.settings();
  }
  async sample() {
    if (this.closed) return;
    const at = Date.now(),
      start = performance.now();
    let database = "ok";
    try {
      await this.db
        .prepare(
          "INSERT INTO health_probe VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(at);
      if (
        (
          await this.db
            .prepare("SELECT value FROM health_probe WHERE id=1")
            .get()
        ).value !== at
      )
        throw Error();
    } catch {
      database = "error";
    }
    const now = performance.now(),
      usage = process.cpuUsage(),
      elapsed = now - this.cpuAt;
    const cpu =
      elapsed > 0
        ? Math.min(
            100,
            ((usage.user + usage.system - this.cpu.user - this.cpu.system) /
              (elapsed * 1000)) *
              100,
          )
        : 0;
    this.cpu = usage;
    this.cpuAt = now;
    const worker =
      !this.mail.closed && at - this.lastTick < this.intervalMs * 2.5
        ? "ok"
        : "error";
    this.lastTick = at;
    this.latest = {
      at,
      api: "ok",
      db: database,
      worker,
      latency: Math.round((performance.now() - start) * 100) / 100,
      memory: Math.round(process.memoryUsage().rss / 1048576),
      cpu: Math.round(cpu * 10) / 10,
    };
    try {
      await this.db
        .prepare(
          "INSERT INTO service_samples VALUES(?,?,?,?,?,?,?) ON CONFLICT(at) DO UPDATE SET api=excluded.api,db=excluded.db,worker=excluded.worker,latency=excluded.latency,memory=excluded.memory,cpu=excluded.cpu",
        )
        .run(
          at,
          "ok",
          database,
          worker,
          this.latest.latency,
          this.latest.memory,
          this.latest.cpu,
        );
      await this.db
        .prepare("DELETE FROM service_samples WHERE at<?")
        .run(at - 7 * 86400000);
      await this.db
        .prepare("DELETE FROM selftest_runs WHERE started<?")
        .run(at - 30 * 86400000);
    } catch {
      this.latest.db = "error";
    }
  }
  async scheduled() {
    const s = await this.settings();
    if (!s.enabled || this.running) return;
    const last = await this.db
      .prepare(
        "SELECT started FROM selftest_runs ORDER BY started DESC LIMIT 1",
      )
      .get();
    if (!last || Date.now() - last.started >= s.intervalMinutes * 60000)
      await this.run();
  }
  async summary() {
    return {
      now: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      latest: this.latest,
      settings: await this.settings(),
      running: this.running,
      push: "not_configured",
      samples: await this.db
        .prepare("SELECT * FROM service_samples WHERE at>? ORDER BY at")
        .all(Date.now() - 86400000),
      runs: await this.db
        .prepare("SELECT * FROM selftest_runs ORDER BY started DESC LIMIT 100")
        .all(),
    };
  }
  async run() {
    if (this.running)
      throw Object.assign(new Error("Self-test already running"), {
        status: 409,
      });
    if (this.closed)
      throw Object.assign(new Error("Service closing"), { status: 503 });
    const started = Date.now(),
      id = randomUUID();
    this.running = true;
    try {
      await this.db
        .prepare("INSERT INTO selftest_runs VALUES(?,?,?,?,?,?)")
        .run(id, started, "running", "account", 0, "正在准备独立测试账号");
    } catch (error) {
      this.running = false;
      throw error;
    }
    const controller = new AbortController();
    this.controller = controller;
    const update = async (stage) => {
      if (!this.closed && !controller.signal.aborted)
        await this.db
          .prepare("UPDATE selftest_runs SET stage=? WHERE id=?")
          .run(stage, id);
    };
    let timer;
    this.pending = (async () => {
      let result;
      try {
        await Promise.race([
          this.probe({ signal: controller.signal, stage: update }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
              );
            }, 60000);
          }),
        ]);
        result = { status: "ok", detail: "SMTP 提交与 IMAP 读取匹配成功" };
      } catch (error) {
        result = describeProbeError(error, controller.signal.aborted);
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (!this.closed)
          await this.db
            .prepare(
              "UPDATE selftest_runs SET status=?,duration=?,detail=? WHERE id=?",
            )
            .run(result.status, Date.now() - started, result.detail, id);
        this.running = false;
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.running = false;
      });
    return { id, status: "running" };
  }
  async externalProbe({ signal, stage }) {
    const guard = () => signal.throwIfAborted();
    let account;
    const saved = await this.get("ethereal");
    if (saved) account = JSON.parse(this.decrypt(saved));
    else {
      await stage("account");
      let response;
      try {
        response = await fetch("https://api.nodemailer.com/user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestor: "Mohua", version: "0.3.0" }),
          signal,
        });
        if (!response.ok) throw Error();
        account = await response.json();
        if (account.status !== "success" || !account.user || !account.pass)
          throw Error();
      } catch (e) {
        if (signal.aborted) throw e;
        throw Object.assign(new Error("Test provider unavailable"), {
          code: "EEXTERNAL",
        });
      }
      guard();
      await this.put(
        "ethereal",
        this.seal(JSON.stringify({ user: account.user, pass: account.pass })),
      );
    }
    guard();
    const messageId = `<mohua-${randomUUID()}@mohua.test>`,
      marker = randomUUID();
    let smtp, imap;
    const abort = () => {
      smtp?.close();
      imap?.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await stage("smtp_connect");
      const smtpIP = await publicAddress("smtp.ethereal.email");
      guard();
      smtp = nodemailer.createTransport({
        host: smtpIP,
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: account.user, pass: account.pass },
        tls: {
          servername: "smtp.ethereal.email",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        logger: false,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });
      await smtp.verify();
      guard();
      await stage("smtp_submit");
      await smtp.sendMail({
        from: account.user,
        to: account.user,
        messageId,
        subject: "Mohua synthetic health check",
        text: marker,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      guard();
      await stage("imap_connect");
      const imapIP = await publicAddress("imap.ethereal.email");
      guard();
      imap = new ImapFlow({
        host: imapIP,
        servername: "imap.ethereal.email",
        port: 993,
        secure: true,
        auth: { user: account.user, pass: account.pass },
        logger: false,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      });
      imap.on("error", () => {});
      await imap.connect();
      guard();
      await stage("imap_read");
      await imap.mailboxOpen("INBOX");
      let match = false;
      for (let attempt = 0; attempt < 8 && !match; attempt++) {
        guard();
        const ids = await imap.search(
          { header: { "Message-ID": messageId } },
          { uid: true },
        );
        if (ids.length) {
          const item = await imap.fetchOne(
            ids.at(-1),
            { source: { start: 0, maxLength: 16384 } },
            { uid: true },
          );
          match = !!item?.source?.toString().includes(marker);
          if (match) {
            await stage("cleanup");
            await imap.messageDelete(ids.at(-1), { uid: true });
          }
        }
        if (!match) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!match)
        throw Object.assign(new Error("Message not found"), {
          code: "EEXTERNAL",
        });
      guard();
      await stage("complete");
    } finally {
      signal.removeEventListener("abort", abort);
      smtp?.close();
      imap?.close();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.pending;
    await this.tick;
  }
}
