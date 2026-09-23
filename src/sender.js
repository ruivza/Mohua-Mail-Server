import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import MailComposer from "nodemailer/lib/mail-composer";
import { readOptions } from "./reader.js";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const MAX_UPLOAD = 25 * 1024 * 1024,
  MAX_MIME = 40 * 1024 * 1024;
const clean = (s, n) =>
  typeof s === "string" && s.length <= n && !/[\r\n\x00]/.test(s);
function addresses(value) {
  if (!Array.isArray(value) || value.length > 100)
    fail(400, "Use an array of email addresses");
  return [
    ...new Set(
      value.map((a) => {
        if (!clean(a, 254) || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(a))
          fail(400, "Invalid recipient");
        return a;
      }),
    ),
  ];
}
export function validateSend(input) {
  if (
    !clean(input.subject, 998) ||
    typeof input.text !== "string" ||
    Buffer.byteLength(input.text) > 256 * 1024
  )
    fail(400, "Invalid subject or body (maximum 256 KiB)");
  const to = addresses(input.to || []),
    cc = addresses(input.cc || []),
    bcc = addresses(input.bcc || []);
  if (
    (!to.length && !cc.length && !bcc.length) ||
    to.length + cc.length + bcc.length > 100
  )
    fail(400, "Require 1–100 recipients");
  if (!["provider", "append"].includes(input.sentCopy))
    fail(400, "Choose sent copy policy");
  const attachments = input.attachments || [];
  if (!Array.isArray(attachments) || attachments.length > 20)
    fail(400, "Maximum 20 attachments");
  let total = 0;
  const files = attachments.map((f) => {
    if (
      !clean(f.filename, 200) ||
      !f.filename ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0
    )
      fail(400, "Invalid attachment");
    total += f.size;
    return { filename: f.filename, size: f.size };
  });
  if (total > MAX_UPLOAD) fail(413, "Attachments exceed 25 MiB");
  let source = null;
  if (input.source) {
    const s = input.source;
    if (
      !["reply", "replyAll", "forward"].includes(s.kind) ||
      !Number.isInteger(s.uid) ||
      s.uid < 1 ||
      s.uid > 4294967295 ||
      typeof s.folder !== "string" ||
      typeof s.uidValidity !== "string"
    )
      fail(400, "Invalid source message");
    const o = readOptions(
      new URLSearchParams({ folder: s.folder, uidValidity: s.uidValidity }),
    );
    source = { kind: s.kind, uid: s.uid, ...o };
  }
  return {
    to,
    cc,
    bcc,
    subject: input.subject,
    text: input.text,
    sentCopy: input.sentCopy,
    attachments: files,
    total,
    source,
  };
}
// Each attachment consumes exactly its declared slice of the upload stream.
export function uploadParts(stream, files) {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0),
    ended = false;
  async function next() {
    const r = await iterator.next();
    ended = r.done;
    if (!ended) pending = Buffer.from(r.value);
  }
  return {
    parts: files.map((f) => ({
      filename: f.filename,
      contentType: "application/octet-stream",
      content: Readable.from(
        (async function* () {
          let left = f.size;
          while (left) {
            if (!pending.length) {
              await next();
              if (ended) fail(400, "Incomplete attachment upload");
            }
            const n = Math.min(left, pending.length);
            yield pending.subarray(0, n);
            pending = pending.subarray(n);
            left -= n;
          }
        })(),
      ),
    })),
    async finish() {
      if (pending.length) fail(400, "Extra upload bytes");
      if (!ended) {
        await next();
        if (!ended) fail(400, "Extra upload bytes");
      }
    },
  };
}
export class MailSender {
  constructor({ mail, reader, db }) {
    Object.assign(this, { mail, reader, db });
    this.pending = new Map();
    this.active = new Map();
  }
  async initialize() {
    await this.db.exec(
      "UPDATE outbox SET state='unknown' WHERE state='sending'; UPDATE outbox SET state='expired' WHERE state='prepared';",
    );
    this.timer = setInterval(() => {
      this.pruning = this.prune().catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  async prune() {
    for (const [id, p] of this.pending)
      if (Date.now() - p.created > 900000) {
        this.pending.delete(id);
        await this.db
          .prepare(
            "UPDATE outbox SET state='expired' WHERE id=? AND state='prepared'",
          )
          .run(id);
      }
  }
  async status(id, user) {
    const r = await this.db
      .prepare("SELECT id,state,result FROM outbox WHERE id=? AND user_id=?")
      .get(id, user);
    if (!r) fail(404, "Send record not found");
    return {
      id: r.id,
      state: r.state,
      ...(r.result ? JSON.parse(r.result) : {}),
    };
  }
  async prepare(account, user, key, input) {
    return this.db.transaction(async () => {
      await this.db.query(
        "SELECT pg_advisory_xact_lock(734624, hashtext(current_schema()))",
      );
      if (account.mode !== "proxy") fail(409, "Direct mode: send on device");
      if (!clean(key, 100) || !key || !/^[\w-]+$/.test(key))
        fail(400, "Idempotency-Key required");
      const data = validateSend(input);
      const digest = createHash("sha256")
        .update(JSON.stringify({ account: account.id, data }))
        .digest("hex");
      const old = await this.db
        .prepare("SELECT * FROM outbox WHERE user_id=? AND request_key=?")
        .get(user, key);
      if (old) {
        if (old.digest !== digest)
          fail(409, "Key already used for a different message");
        return await this.status(old.id, user);
      }
      await this.prune();
      if (
        this.pending.size >= 32 ||
        [...this.pending.values()].filter((p) => p.user === user).length >= 4
      )
        fail(429, "Too many prepared messages");
      const id = randomUUID(),
        created = Date.now();
      await this.db
        .prepare("INSERT INTO outbox VALUES(?,?,?,?,?,'prepared',NULL,?)")
        .run(id, user, account.id, key, digest, created);
      this.pending.set(id, { data, account, user, created });
      return await this.status(id, user);
    });
  }
  async submit(id, user, upload, authorize) {
    if (this.closed) fail(503, "Service closing");
    if (
      this.active.size >= 2 ||
      [...this.active.values()].some((j) => j.user === user)
    )
      fail(429, "Another send is running");
    const job = { user, cancelled: false, smtpStarted: false };
    this.active.set(id, job);
    try {
      return await this.submitReserved(id, user, upload, authorize, job);
    } finally {
      this.active.delete(id);
    }
  }
  async submitReserved(id, user, upload, authorize, job) {
    const current = await this.status(id, user);
    if (current.state !== "prepared") return current;
    const p = this.pending.get(id);
    if (!p) fail(409, "Prepared message expired");
    await authorize(p.account);
    if (job.cancelled || this.closed) fail(503, "Service closing");
    const claimed = await this.db
      .prepare(
        "UPDATE outbox SET state='sending' WHERE id=? AND user_id=? AND state='prepared'",
      )
      .run(id, user);
    if (!claimed.changes) return this.status(id, user);
    this.pending.delete(id);
    let timer;
    const streams = [];
    let confirmed = null;
    const update = async (state, result) => {
      await this.db
        .prepare("UPDATE outbox SET state=?,result=? WHERE id=?")
        .run(state, JSON.stringify(result || {}), id);
    };
    const check = async () => {
      if (job.cancelled) fail(499, "Send cancelled");
      await authorize(p.account);
    };
    const perform = async (sourceClient) => {
      job.sourceClient = sourceClient;
      await check();
      const data = p.data,
        account = p.account;
      const attached = uploadParts(upload, data.attachments);
      streams.push(...attached.parts.map((a) => a.content));
      const options = {
        from: account.email,
        to: data.to,
        cc: data.cc,
        subject: data.subject,
        text: data.text,
        messageId: "<" + id + "@mohua.local>",
        date: new Date(),
        attachments: attached.parts,
        disableFileAccess: true,
        disableUrlAccess: true,
      };
      if (data.source) {
        const original = await sourceClient.fetchOne(
          data.source.uid,
          { envelope: true, size: true },
          { uid: true },
        );
        if (!original) fail(404, "Original message missing");
        const mid = original.envelope?.messageId;
        if (data.source.kind !== "forward") {
          if (!clean(mid, 998) || !/^<[^<>\s]+>$/.test(mid))
            fail(422, "Original Message-ID unavailable");
          options.inReplyTo = mid;
          options.references = [original.envelope?.inReplyTo, mid].filter(
            (m) => clean(m, 998) && /^<[^<>\s]+>$/.test(m),
          );
        } else {
          if (original.size > MAX_UPLOAD)
            fail(413, "Original email exceeds 25 MiB");
          const dl = await sourceClient.download(data.source.uid, undefined, {
            uid: true,
            chunkSize: 65536,
          });
          streams.push(dl.content);
          options.attachments.push({
            filename: "original.eml",
            contentType: "message/rfc822",
            contentDisposition: "attachment",
            content: dl.content,
          });
        }
      }
      let sentClient = sourceClient,
        destination;
      if (data.sentCopy === "append") {
        if (!sentClient) {
          sentClient = await this.mail.imap(account, job);
          await sentClient.connect();
        }
        const folders = (await sentClient.list()).filter(
          (f) => f.specialUse === "\\Sent" && !f.flags?.has("\\Noselect"),
        );
        if (folders.length !== 1)
          fail(
            409,
            "No unique Sent folder; configure provider copy or mailbox folders",
          );
        destination = folders[0].path;
      }
      if (![465, 587].includes(account.smtp_port))
        fail(400, "SMTP TLS requires 465 or 587");
      const host = await this.mail.resolveHost(account.smtp_host);
      await check();
      job.smtp = this.mail.smtpFactory({
        host,
        port: account.smtp_port,
        secure: account.smtp_port === 465,
        requireTLS: true,
        auth: {
          user: account.email,
          pass: this.mail.decrypt(account.credential),
        },
        tls: {
          servername: account.smtp_host,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        logger: false,
        debug: false,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 60000,
      });
      await job.smtp.verify();
      await check();
      const mime = new MailComposer(options).compile().createReadStream();
      streams.push(mime);
      const saved = [];
      let size = 0;
      const raw = Readable.from(
        (async function* () {
          for await (const chunk of mime) {
            await check();
            size += chunk.length;
            if (size > MAX_MIME) fail(413, "Encoded email exceeds 40 MiB");
            if (data.sentCopy === "append") saved.push(chunk);
            yield chunk;
          }
          await attached.finish();
        })(),
      );
      streams.push(raw);
      job.smtpStarted = true;
      const info = await job.smtp.sendMail({
        envelope: {
          from: account.email,
          to: [...new Set([...data.to, ...data.cc, ...data.bcc])],
        },
        raw,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      await check();
      confirmed = {
        accepted: info.accepted?.length || 0,
        rejected: info.rejected?.length || 0,
        messageId: options.messageId,
        sentCopy: data.sentCopy === "provider" ? "provider_managed" : "pending",
      };
      await update(confirmed.rejected ? "partial" : "sent", confirmed);
      if (data.sentCopy === "append") {
        try {
          await check();
          const result = await sentClient.append(
            destination,
            Buffer.concat(saved),
            ["\\Seen"],
          );
          confirmed.sentCopy = result ? "saved" : "failed";
        } catch {
          confirmed.sentCopy = "failed_or_unknown";
        }
        if (!job.cancelled)
          await update(confirmed.rejected ? "partial" : "sent", confirmed);
      }
    };
    try {
      await Promise.race([
        p.data.source
          ? this.reader.execute(
              p.account,
              p.data.source,
              perform,
              undefined,
              600000,
            )
          : perform(),
        new Promise((_, reject) => {
          job.abort = () => {
            job.cancelled = true;
            job.smtp?.close();
            job.client?.close();
            job.sourceClient?.close();
            for (const s of streams) s.destroy();
            reject(Error("cancelled or timed out"));
          };
          timer = setTimeout(job.abort, 600000);
        }),
      ]);
    } catch (e) {
      if (!confirmed)
        await update(job.smtpStarted ? "unknown" : "failed", {
          error: e.status
            ? e.message
            : "Send failed; check status before retrying",
        });
      else if (confirmed.sentCopy === "pending") {
        confirmed.sentCopy = "failed_or_unknown";
        await update(confirmed.rejected ? "partial" : "sent", confirmed);
      }
    } finally {
      clearTimeout(timer);
      job.cancelled = true;
      job.smtp?.close();
      job.client?.close();
      for (const s of streams) s.destroy();
    }
    return await this.status(id, user);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pruning;
    for (const job of this.active.values()) {
      job.cancelled = true;
      job.abort?.();
    }
    while (this.active.size) await new Promise((r) => setTimeout(r, 20));
    this.pending.clear();
  }
}
