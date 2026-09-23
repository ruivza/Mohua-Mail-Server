import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export async function publicAddress(host, resolver = lookup) {
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !/^[a-z0-9.-]+$/i.test(host)
  )
    throw new Error("Invalid host");
  const addresses = await resolver(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !ipaddr.isValid(address) ||
        ipaddr.process(address).range() !== "unicast",
    )
  )
    throw new Error("Public mail host required");
  // Pin the checked address. TLS still verifies the original hostname.
  return addresses[0].address;
}

export class MailService {
  constructor({
    db,
    decrypt,
    resolveHost = publicAddress,
    imapFactory = (options) => new ImapFlow(options),
    smtpFactory = (options) => nodemailer.createTransport(options),
    timeoutMs = 30000,
    retryMs = 60000,
    onChange = () => {},
  }) {
    Object.assign(this, {
      db,
      decrypt,
      resolveHost,
      imapFactory,
      smtpFactory,
      timeoutMs,
      retryMs,
      onChange,
    });
    this.background = new Set();
    this.jobs = new Map();
    this.states = new Map();
    this.closed = false;
  }
  state(id) {
    return (
      this.states.get(id) || {
        connectionStatus: "not_connected",
        pushStatus: "not_configured",
      }
    );
  }
  status(id, connectionStatus, extra = {}) {
    this.states.set(id, {
      ...this.state(id),
      connectionStatus,
      ...extra,
      pushStatus: "not_configured",
    });
  }
  async active(id) {
    return await this.db
      .prepare(
        "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND u.active=1",
      )
      .get(id);
  }
  async imap(account, job) {
    if (account.imap_port !== 993)
      throw new Error("IMAP TLS requires port 993");
    const address = await this.resolveHost(account.imap_host);
    if (job.cancelled) throw new Error("Cancelled");
    const client = this.imapFactory({
      host: address,
      servername: account.imap_host,
      port: 993,
      secure: true,
      auth: { user: account.email, pass: this.decrypt(account.credential) },
      logger: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 300000,
      maxIdleTime: 120000,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    job.client = client;
    client.on("error", () => {
      if (!job.cancelled) client.close();
    });
    return client;
  }
  async deadline(job, operation) {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            job.cancelled = true;
            job.client?.close();
            job.smtp?.close();
            reject(new Error("Timeout"));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async verify(account) {
    if (this.jobs.has(account.id))
      throw Object.assign(new Error("Stop monitoring before testing"), {
        status: 409,
      });
    const job = { cancelled: false };
    this.jobs.set(account.id, job);
    this.status(account.id, "testing");
    try {
      await this.deadline(job, async () => {
        const client = await this.imap(account, job);
        await client.connect();
        await client.mailboxOpen("INBOX", { readOnly: true });
        await client.logout();
        if (![465, 587].includes(account.smtp_port))
          throw new Error("SMTP TLS requires port 465 or 587");
        const address = await this.resolveHost(account.smtp_host);
        if (job.cancelled) throw new Error("Cancelled");
        job.smtp = this.smtpFactory({
          host: address,
          port: account.smtp_port,
          secure: account.smtp_port === 465,
          requireTLS: true,
          auth: { user: account.email, pass: this.decrypt(account.credential) },
          tls: {
            servername: account.smtp_host,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
          },
          logger: false,
          debug: false,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        });
        await job.smtp.verify();
      });
      if (job.cancelled || !(await this.active(account.id)))
        throw new Error("Cancelled");
      this.status(account.id, "verified", {
        lastVerifiedAt: new Date().toISOString(),
        error: null,
      });
      return this.state(account.id);
    } catch {
      if (this.jobs.get(account.id) === job)
        this.status(account.id, "error", {
          error:
            "Connection verification failed. Check host, TLS and credentials.",
        });
      throw Object.assign(
        new Error(
          "Mailbox verification failed; check TLS, hosts and credentials",
        ),
        { status: 422 },
      );
    } finally {
      job.cancelled = true;
      job.client?.close();
      job.smtp?.close();
      if (this.jobs.get(account.id) === job) this.jobs.delete(account.id);
    }
  }
  async start(account) {
    if (this.closed || this.jobs.has(account.id)) return;
    const job = { cancelled: false };
    this.jobs.set(account.id, job);
    this.status(account.id, "connecting", { error: null });
    const retry = () => {
      if (job.cancelled || this.closed || this.jobs.get(account.id) !== job)
        return;
      job.cancelled = true;
      job.client?.close();
      this.status(account.id, "reconnecting");
      job.timer = setTimeout(
        () =>
          this.track(async () => {
            if (this.jobs.get(account.id) !== job || this.closed) return;
            const current = await this.active(account.id);
            if (this.jobs.get(account.id) !== job || this.closed) return;
            this.jobs.delete(account.id);
            if (current?.monitor_enabled) await this.start(current);
          }),
        this.retryMs,
      );
      job.timer.unref();
    };
    try {
      await this.deadline(job, async () => {
        const client = await this.imap(account, job);
        client.on("close", retry);
        for (const event of ["exists", "flags", "expunge"])
          client.on(event, (detail) =>
            this.track(async () => {
              if (job.cancelled || this.closed) return;
              const current = await this.active(account.id);
              if (!current || job.cancelled || this.closed) return;
              await this.onChange(account.id);
              if (event === "exists" && !job.cancelled && !this.closed)
                this.status(account.id, "listening", {
                  lastChangeAt: new Date().toISOString(),
                  messageCount: detail.count,
                });
            }),
          );
        await client.connect();
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        if (job.cancelled) throw new Error("Cancelled");
        await this.onChange(account.id);
        this.status(account.id, "listening", {
          messageCount: box.exists,
          uidValidity: String(box.uidValidity),
          lastConnectedAt: new Date().toISOString(),
        });
      });
    } catch {
      if (this.jobs.get(account.id) === job && !this.closed) {
        job.cancelled = false;
        retry();
      }
    }
  }
  stop(id) {
    const job = this.jobs.get(id);
    if (job) {
      job.cancelled = true;
      clearTimeout(job.timer);
      job.client?.close();
      job.smtp?.close();
      this.jobs.delete(id);
    }
    this.status(id, "stopped");
  }
  remove(id) {
    this.stop(id);
    this.states.delete(id);
  }
  async restore() {
    for (const a of await this.db
      .prepare(
        "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.monitor_enabled=1 AND u.active=1",
      )
      .all())
      this.start(a);
  }
  track(action) {
    const pending = Promise.resolve()
      .then(action)
      .catch(() => {})
      .finally(() => this.background.delete(pending));
    this.background.add(pending);
    return pending;
  }
  async close() {
    this.closed = true;
    for (const id of this.jobs.keys()) this.stop(id);
    await Promise.allSettled([...this.background]);
  }
}
