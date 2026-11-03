import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { MAIL_HOST, clean } from "./validate.js";
import { SECOND, MINUTE } from "./limits.js";

export async function publicAddress(host, resolver = lookup) {
  if (typeof host !== "string" || host.length > 253 || !MAIL_HOST.test(host))
    throw new Error("Invalid host");
  const addresses = await resolver(host, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast",
    )
  )
    throw new Error("Public mail host required");
  // Pin the checked address. TLS still verifies the original hostname.
  return addresses[0].address;
}

export class MailService {
  constructor({
    db,
    leases,
    resolveHost = publicAddress,
    imapFactory = (options) => new ImapFlow(options),
    smtpFactory = (options) => nodemailer.createTransport(options),
    timeoutMs = 30 * SECOND,
    retryMs = MINUTE,
    onChange = () => {},
    onSyncChange = () => {},
    needsPreview = async () => false,
    // Optional active-account lookup replacing the database query, for callers that check
    // one fixed candidate account (mailbox verification).
    active = null,
  }) {
    this.activeLookup = active;
    Object.assign(this, {
      db,
      leases,
      resolveHost,
      imapFactory,
      smtpFactory,
      timeoutMs,
      retryMs,
      onChange,
      onSyncChange,
      needsPreview,
    });
    // Drop known library references when transports close. This is not secure
    // erasure of JS strings or protection against a compromised runtime.
    this.smtpFactory = (options) => {
      const transport = smtpFactory(options),
        close = transport.close.bind(transport);
      transport.close = (...args) => {
        try {
          return close(...args);
        } finally {
          if (options.auth) options.auth.pass = "";
          if (transport.transporter?.options?.auth) transport.transporter.options.auth.pass = "";
          if (transport.transporter?.auth?.credentials)
            transport.transporter.auth.credentials.pass = "";
        }
      };
      return transport;
    };
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
      disconnectedSince:
        connectionStatus === "listening" || connectionStatus === "stopped"
          ? null
          : this.state(id).disconnectedSince || Date.now(),
      ...extra,
      pushStatus: "not_configured",
    });
  }
  async active(id) {
    if (this.activeLookup) return await this.activeLookup(id);
    return await this.db
      .prepare(
        "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND u.active=1",
      )
      .get(id);
  }
  password(account) {
    return this.leases.password(account);
  }
  async imap(account, job) {
    if (account.imap_port !== 993) throw new Error("IMAP TLS requires port 993");
    const address = await this.resolveHost(account.imap_host);
    if (job.cancelled) throw new Error("Cancelled");
    const auth = { user: account.email, pass: this.password(account) };
    const client = this.imapFactory({
      host: address,
      servername: account.imap_host,
      port: 993,
      secure: true,
      auth,
      logger: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 5 * MINUTE,
      maxIdleTime: 2 * MINUTE,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    const connect = client.connect.bind(client),
      close = client.close.bind(client);
    client.connect = async (...args) => {
      try {
        return await connect(...args);
      } finally {
        auth.pass = "";
      }
    };
    client.close = (...args) => {
      try {
        return close(...args);
      } finally {
        auth.pass = "";
      }
    };
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
    this.leases?.assert(account);
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
          auth: { user: account.email, pass: this.password(account) },
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
      if (job.cancelled || !(await this.active(account.id))) throw new Error("Cancelled");
      this.status(account.id, "verified", {
        lastVerifiedAt: new Date().toISOString(),
        error: null,
      });
      return this.state(account.id);
    } catch (error) {
      if (this.jobs.get(account.id) === job)
        this.status(account.id, "error", {
          error: "Connection verification failed. Check host, TLS and credentials.",
        });
      const auth = error.authenticationFailed || error.code === "EAUTH";
      const timeout = error.message === "Timeout" || ["ETIMEDOUT", "ETIMEOUT"].includes(error.code);
      throw Object.assign(
        new Error(
          auth
            ? "Mailbox authentication failed"
            : timeout
              ? "Mailbox connection timed out"
              : "Mailbox connection failed",
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
    try {
      this.leases?.assert(account);
    } catch {
      this.status(account.id, "authorization_required");
      return;
    }
    const job = { cancelled: false };
    this.jobs.set(account.id, job);
    this.status(account.id, "connecting", { error: null });
    const retry = () => {
      if (job.cancelled || this.closed || this.jobs.get(account.id) !== job) return;
      job.cancelled = true;
      job.client?.close();
      this.status(account.id, "reconnecting");
      const scheduleRetry = () => {
        job.timer = setTimeout(
          () =>
            this.track(async () => {
              if (this.jobs.get(account.id) !== job || this.closed) return;
              let current;
              try {
                current = await this.active(account.id);
              } catch {
                // Database outages must not permanently strand a cancelled watcher.
                if (this.jobs.get(account.id) === job && !this.closed) scheduleRetry();
                return;
              }
              if (this.jobs.get(account.id) !== job || this.closed) return;
              this.jobs.delete(account.id);
              if (
                current &&
                (current.sync_enabled ? current.sync_credential : current.monitor_enabled)
              )
                await this.start(current);
              else this.status(account.id, "stopped");
            }),
          this.retryMs,
        );
        job.timer.unref();
      };
      scheduleRetry();
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
              if (current.sync_enabled) {
                await this.onSyncChange(account.id);
                return;
              }
              const newMail =
                event === "exists" &&
                detail.path === "INBOX" &&
                Number.isInteger(detail.prevCount) &&
                detail.count > detail.prevCount;
              let notification;
              let envelopeTimedOut = false;
              let preview = false;
              if (newMail) {
                try {
                  preview = await this.needsPreview(account.id);
                } catch {
                  /* Fail closed for content access. */
                }
              }
              if (job.cancelled || this.closed) return;
              if (newMail && preview) {
                this.leases?.assert(current);
                let timer;
                try {
                  const message = await Promise.race([
                    client.fetchOne("*", { envelope: true }),
                    new Promise((_, reject) => {
                      timer = setTimeout(() => {
                        envelopeTimedOut = true;
                        reject(Error("Envelope timeout"));
                      }, this.timeoutMs);
                    }),
                  ]);
                  const from = message?.envelope?.from?.[0];
                  notification = {
                    sender: clean(from?.name || from?.address, 120),
                    subject: clean(message?.envelope?.subject, 400),
                  };
                } catch {
                  /* Missing metadata falls back to a generic alert, never a body fetch. */
                } finally {
                  clearTimeout(timer);
                }
              }
              try {
                const active = await this.active(account.id);
                if (job.cancelled || this.closed || !active || active.sync_enabled) return;
                this.leases?.assert(current);
                await this.onChange(account.id, newMail ? "new_mail" : "sync", notification);
              } finally {
                // Deliver the fallback before closing the stalled connection cancels this job.
                if (envelopeTimedOut) client.close();
              }
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
        if (job.cancelled || this.closed || this.jobs.get(account.id) !== job) return;
        this.status(account.id, "listening", {
          messageCount: box.exists,
          uidValidity: String(box.uidValidity),
          lastConnectedAt: new Date().toISOString(),
        });
      });
    } catch {
      if (this.jobs.get(account.id) === job && !this.closed && !job.timer) {
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
