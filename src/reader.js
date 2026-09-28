import { ImapPool } from "./imap-pool.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export function readOptions(params) {
  const folder = params.get("folder") || "INBOX";
  if (folder.length > 512 || /[\x00-\x1f]/.test(folder))
    fail(400, "Invalid folder");
  const integer = (name, fallback, max) => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
      fail(400, "Invalid " + name);
    return Number(value);
  };
  const validity = params.get("uidValidity");
  if (validity !== null && !/^[1-9]\d{0,19}$/.test(validity))
    fail(400, "Invalid UIDVALIDITY");
  return {
    folder,
    before: integer("before", null, 4294967296),
    limit: integer("limit", 25, 50),
    validity,
  };
}
function summary(message) {
  return {
    uid: message.uid,
    subject: message.envelope?.subject || "",
    from: message.envelope?.from || [],
    date: message.envelope?.date || null,
    flags: [...(message.flags || [])],
    size: message.size,
  };
}

export function syncOptions(input) {
  if (
    !input ||
    typeof input.folder !== "string" ||
    !input.folder ||
    typeof input.uidValidity !== "string"
  )
    fail(400, "Invalid sync request");
  const options = readOptions(
    new URLSearchParams({
      folder: input.folder,
      uidValidity: input.uidValidity,
    }),
  );
  if (
    !Number.isInteger(input.after) ||
    input.after < 0 ||
    input.after > 4294967295 ||
    !Array.isArray(input.known) ||
    input.known.length > 500 ||
    input.known.some(
      (uid) => !Number.isInteger(uid) || uid < 1 || uid > input.after,
    ) ||
    new Set(input.known).size !== input.known.length
  )
    fail(400, "Invalid sync cursor");
  return { ...options, after: input.after, known: input.known };
}

export class MailReader {
  constructor(mail, poolOptions) {
    this.mail = mail;
    this.jobs = new Map();
    this.pool = new ImapPool(mail, poolOptions);
  }
  async execute(account, options, operation, signal, timeoutMs = 30000) {
    if (account.mode !== "proxy")
      fail(409, "Direct mode: read mail on the device");
    if (
      this.jobs.size >= 16 ||
      [...this.jobs.values()].filter((job) => job.user === account.user_id)
        .length >= 2
    ) {
      fail(429, "Too many mailbox reads");
    }
    const id = Symbol();
    const job = {
      cancelled: false,
      user: account.user_id,
      account: account.id,
    };
    this.jobs.set(id, job);
    const abort = () => {
      job.cancelled = true;
      job.client?.close();
    };
    job.abort = abort;
    signal?.addEventListener("abort", abort, { once: true });
    let timer, connection;
    let reusable = false;
    const checkCancelled = () => {
      if (job.cancelled || signal?.aborted) fail(499, "Request cancelled");
    };
    const work = async () => {
      checkCancelled();
      connection = await this.pool.acquire(account, job);
      checkCancelled();
      const client = connection.client;
      let box;
      if (options) {
        box = await client.mailboxOpen(options.folder, {
          readOnly: !options.write,
        });
        if (options.validity && String(box.uidValidity) !== options.validity)
          fail(409, "Mailbox changed; reload message list");
      }
      checkCancelled();
      const result = await operation(client, box, checkCancelled);
      checkCancelled();
      reusable = true;
      return result;
    };
    try {
      return await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort();
            reject(
              Object.assign(Error("Mailbox read timed out"), { status: 504 }),
            );
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error.status) throw error;
      fail(502, "Mailbox read failed; check connection and credentials");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.jobs.delete(id);
      this.pool.release(connection, reusable && !job.cancelled);
    }
  }
  folders(account, signal) {
    return this.execute(
      account,
      null,
      async (client) =>
        (await client.list())
          .filter((f) => !f.flags?.has("\\Noselect"))
          .map((f) => ({
            path: f.path,
            name: f.name,
            specialUse: f.specialUse || null,
          })),
      signal,
    );
  }
  list(account, o, signal) {
    return this.execute(
      account,
      o,
      async (client, box) => {
        const end = Math.min(
          (o.before ?? Number(box.uidNext)) - 1,
          Number(box.uidNext) - 1,
        );
        if (end < 1)
          return {
            uidValidity: String(box.uidValidity),
            highWater: Number(box.uidNext) - 1,
            items: [],
            nextBefore: null,
          };
        const start = Math.max(1, end - 199);
        const rows = await client.fetchAll(
          `${start}:${end}`,
          { uid: true, envelope: true, flags: true, size: true },
          { uid: true },
        );
        const ordered = rows
          .filter((m) => m.uid >= start && m.uid <= end)
          .sort((a, b) => b.uid - a.uid);
        const selected = ordered.slice(0, o.limit);
        return {
          uidValidity: String(box.uidValidity),
          highWater: Number(box.uidNext) - 1,
          items: selected.map(summary),
          nextBefore:
            ordered.length > o.limit
              ? selected.at(-1).uid
              : start > 1
                ? start
                : null,
        };
      },
      signal,
    );
  }
  sync(account, input, signal) {
    const options = syncOptions(input);
    return this.execute(
      account,
      options,
      async (client, box, checkCancelled) => {
        const latest = Number(box.uidNext) - 1;
        if (options.after > latest)
          fail(409, "Mailbox changed; reload message list");
        // A bounded UID range advances across holes without fetching old envelopes or bodies.
        const highWater = Math.min(latest, options.after + 1000);
        const incoming =
          highWater > options.after
            ? await client.fetchAll(
                `${options.after + 1}:${highWater}`,
                { uid: true, envelope: true, flags: true, size: true },
                { uid: true },
              )
            : [];
        checkCancelled();
        const known = new Set(options.known);
        const existing = known.size
          ? await client.fetchAll(
              options.known.join(","),
              { uid: true, flags: true },
              { uid: true },
            )
          : [];
        return {
          uidValidity: String(box.uidValidity),
          highWater,
          hasMore: highWater < latest,
          items: incoming
            .filter((m) => m.uid > options.after && m.uid <= highWater)
            .map(summary),
          existing: existing
            .filter((m) => known.has(m.uid))
            .map((m) => ({ uid: m.uid, flags: [...(m.flags || [])] })),
        };
      },
      signal,
    );
  }

  message(account, o, uid, attachment, signal, consume) {
    if (!o.validity) fail(400, "UIDVALIDITY required");
    return this.execute(
      account,
      o,
      async (client) => {
        const meta = await client.fetchOne(
          uid,
          { bodyStructure: true, envelope: true, flags: true },
          { uid: true },
        );
        if (!meta) fail(404, "Message not found");
        const parts = splitStructure(meta.bodyStructure);
        if (attachment !== null) {
          const item =
            attachment === "body" ? parts.body : parts.attachments[attachment];
          if (!item) fail(404, "Attachment not found");
          if (!consume) fail(500, "Streaming response required");
          const download = await client.download(uid, item.part, {
            uid: true,
            chunkSize: 65536,
          });
          try {
            return await consume({
              content: download.content,
              filename:
                item.filename ||
                (item.type === "text/html" ? "body.html" : "body.txt"),
              contentType: item.type,
            });
          } finally {
            download.content.destroy();
          }
        }
        return messageMetadata(meta, o.validity, uid, parts);
      },
      signal,
      attachment === null ? 30000 : 600000,
    );
  }

  async mutate(account, o, uid, input, signal, authorize = () => {}) {
    if (!o.validity) fail(400, "UIDVALIDITY required");
    const action = input.action;
    if (
      ![
        "read",
        "unread",
        "flag",
        "unflag",
        "move",
        "archive",
        "trash",
      ].includes(action)
    )
      fail(400, "Invalid mail action");
    if (
      action === "move" &&
      (typeof input.destination !== "string" ||
        !input.destination ||
        input.destination.length > 512 ||
        /[\x00-\x1f]/.test(input.destination))
    )
      fail(400, "Invalid destination");
    return this.execute(
      account,
      { ...o, write: true },
      async (client, box, checkCancelled) => {
        if (!(await client.fetchOne(uid, { uid: true }, { uid: true })))
          fail(404, "Message not found");
        let destination = input.destination;
        if (["move", "archive", "trash"].includes(action)) {
          const folders = (await client.list()).filter(
            (f) => !f.flags?.has("\\Noselect"),
          );
          if (action !== "move") {
            const matches = folders.filter(
              (f) =>
                f.specialUse ===
                (action === "archive" ? "\\Archive" : "\\Trash"),
            );
            if (matches.length !== 1)
              fail(
                409,
                "No unique destination folder; choose a folder manually",
              );
            destination = matches[0].path;
          }
          if (!folders.some((f) => f.path === destination))
            fail(400, "Destination folder not found");
          if (destination === o.folder)
            fail(409, "Message is already in this folder");
          // Require native MOVE to avoid non-atomic COPY/delete fallback.
          if (!client.capabilities?.has("MOVE"))
            fail(409, "Server does not support safe message move");
          checkCancelled();
          await authorize();
          const result = await client.messageMove(uid, destination, {
            uid: true,
          });
          if (!result) fail(502, "Message move failed");
          return { updated: true, destination, reload: true };
        }
        checkCancelled();
        await authorize();
        const flag = ["read", "unread"].includes(action)
          ? "\\Seen"
          : "\\Flagged";
        const method = ["read", "flag"].includes(action)
          ? "messageFlagsAdd"
          : "messageFlagsRemove";
        if (!(await client[method](uid, [flag], { uid: true })))
          fail(502, "Flag update failed");
        return { updated: true, reload: true };
      },
      signal,
    );
  }
  invalidate(account) {
    this.pool.invalidate(account);
    for (const job of this.jobs.values())
      if (job.account === account) job.abort();
  }
  close() {
    this.pool.close();
    for (const job of this.jobs.values()) job.abort();
  }
}

export function splitStructure(root) {
  const attachments = [],
    texts = [];
  let visited = 0;
  function visit(node, depth = 0) {
    if (!node) return;
    if (++visited > 1000 || depth > 30) fail(422, "MIME structure too complex");
    const type = (node.type || "").toLowerCase(),
      filename = node.dispositionParameters?.filename || node.parameters?.name;
    const attached =
      (node.disposition || "").toLowerCase() === "attachment" ||
      !!filename ||
      type === "message/rfc822";
    if (attached) {
      attachments.push({
        part: node.part || "1",
        filename: filename || "attachment.eml",
        type,
        size: node.size || 0,
        contentId: node.id || null,
      });
      return;
    }
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    const part = {
      part: node.part || "1",
      type,
      size: node.size || 0,
      contentId: node.id || null,
    };
    if (type === "text/plain" || type === "text/html") texts.push(part);
    else attachments.push({ ...part, filename: "attachment" });
  }
  visit(root);
  let body = texts.find((p) => p.type === "text/html") ||
    texts.find((p) => p.type === "text/plain");
  // Some providers label the only HTML part as a named attachment. When there is
  // no other text part, treat that part as the readable message body.
  const htmlAttachments = attachments.filter((part) => part.type === "text/html");
  if (!body && htmlAttachments.length === 1) {
    body = htmlAttachments[0];
    attachments.splice(attachments.indexOf(body), 1);
  }
  return { body, attachments };
}

export function messageMetadata(meta, validity, uid, parts = splitStructure(meta.bodyStructure)) {
const address = (values) =>
          (values || [])
            .map((v) =>
              v.name ? v.name + " <" + v.address + ">" : v.address || "",
            )
            .join(", ");
        return {
          uid,
          uidValidity: validity,
          flags: [...(meta.flags || [])],
          replyTo: meta.envelope?.replyTo || meta.envelope?.from || [],
          toAddresses: meta.envelope?.to || [],
          ccAddresses: meta.envelope?.cc || [],
          subject: meta.envelope?.subject || "",
          from: address(meta.envelope?.from),
          to: address(meta.envelope?.to),
          date: meta.envelope?.date || null,
          body: parts.body ? { contentType: parts.body.type } : null,
          attachments: parts.attachments.map((a, id) => ({
            id,
            filename: a.filename,
            size: a.size,
            contentType: a.type,
            contentId: a.contentId || null,
            sizeIsEncoded: true,
          })),
        };
}
