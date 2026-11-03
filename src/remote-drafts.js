import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { isUuid as uuid, BASE64 } from "./validate.js";
import { MINUTE, HOUR, CHUNK_BYTES, MAX_UPLOAD_BYTES } from "./limits.js";
// Legacy draft migration: drafts moved per scan, and the retry delay after a failed account.
const MIGRATIONS_PER_SCAN = 20,
  MIGRATION_RETRY = 10 * MINUTE;
export async function draftOperation(db, account, op, b, files) {
  const id = account.id;
  if (op === "draftLegacy")
    return (
      db
        .prepare(
          "SELECT d.id FROM remote_drafts d JOIN remote_draft_versions v ON v.account_id=d.account_id AND v.draft_id=d.id AND v.revision=d.revision WHERE d.account_id=? AND d.deleted_at IS NULL AND v.storage_version=1 LIMIT 1",
        )
        .get(id) || null
    );
  if (op === "draftList")
    return db
      .prepare(
        'SELECT id,revision,deleted_at AS "deletedAt" FROM remote_drafts WHERE account_id=? ORDER BY updated DESC',
      )
      .all(id);
  if (!uuid(b.id)) fail(400, "Invalid draft");
  const row = await db
    .prepare("SELECT * FROM remote_drafts WHERE account_id=? AND id=?")
    .get(id, b.id);
  if (op === "draftRead") {
    if (!row?.revision || row.deleted_at) fail(404, "Draft not found");
    const parts = await db
      .prepare(
        "SELECT payload FROM remote_draft_chunks WHERE account_id=? AND draft_id=? AND revision=? ORDER BY seq",
      )
      .all(id, b.id, row.revision);
    const version = await db
      .prepare(
        "SELECT storage_version,expected_files FROM remote_draft_versions WHERE account_id=? AND draft_id=? AND revision=?",
      )
      .get(id, b.id, row.revision);
    return {
      revision: row.revision,
      parts: parts.map((p) => p.payload),
      storageVersion: version.storage_version,
      files: JSON.parse(version.expected_files),
    };
  }
  if (op === "draftDelete") {
    if (!row) return {};
    if (row.deleted_at) return {};
    if (row.revision !== b.baseRevision) fail(409, "Draft changed on another device");
    await db
      .prepare("UPDATE remote_drafts SET deleted_at=?,updated=? WHERE account_id=? AND id=?")
      .run(Date.now(), Date.now(), id, b.id);
    return {};
  }
  if (op === "draftFileRead") {
    if (!row?.revision || row.deleted_at || row.revision !== b.revision)
      fail(409, "Draft changed on another device");
    if (!uuid(b.fileId) || !Number.isInteger(b.seq) || b.seq < 0) fail(400, "Invalid draft file");
    const file = await db
      .prepare(
        "SELECT id FROM mail_files WHERE account_id=? AND draft_id=? AND revision=? AND part=?",
      )
      .get(id, b.id, b.revision, b.fileId);
    if (!file) fail(404, "Draft attachment not found");
    const chunk = await files.getChunk(file, b.seq);
    if (!chunk) fail(404, "Draft attachment incomplete");
    return chunk;
  }
  if (!account.sync_enabled && !b.migration) fail(409, "Enable sync mode to save remote drafts");
  if (!uuid(b.revision) || (b.baseRevision !== null && !uuid(b.baseRevision)))
    fail(400, "Invalid draft revision");
  if (
    row?.deleted_at ||
    (row?.revision !== b.revision && (row?.revision || null) !== b.baseRevision)
  )
    fail(409, "Draft changed on another device");
  if (op === "draftBegin") {
    if (!Number.isInteger(b.chunks) || b.chunks < 1 || b.chunks > 600)
      fail(400, "Invalid draft size");
    if (!row) {
      const count = await db
        .prepare("SELECT COUNT(*) n FROM remote_drafts WHERE account_id=? AND deleted_at IS NULL")
        .get(id);
      if (Number(count.n) >= 100) fail(409, "Remote drafts limit reached");
      await db
        .prepare(
          "INSERT INTO remote_drafts(account_id,id,revision,deleted_at,updated) VALUES(?,?,NULL,NULL,?)",
        )
        .run(id, b.id, Date.now());
    }
    if (row?.revision === b.revision) return { complete: true };
    if (
      !Array.isArray(b.files) ||
      b.files.length > 20 ||
      b.files.some(
        (f) => !uuid(f.id) || !Number.isInteger(f.chunks) || f.chunks < 0 || f.chunks > 400,
      ) ||
      new Set(b.files.map((f) => f.id)).size !== b.files.length
    )
      fail(400, "Invalid draft files");
    await db
      .prepare(
        "INSERT INTO remote_draft_versions(account_id,draft_id,revision,chunks,created,storage_version,expected_files) VALUES(?,?,?,?,?,2,?) ON CONFLICT DO NOTHING",
      )
      .run(id, b.id, b.revision, b.chunks, Date.now(), JSON.stringify(b.files));
    for (const file of b.files)
      await db
        .prepare(
          "INSERT INTO mail_files(id,account_id,draft_id,revision,part,created) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,draft_id,revision,part) DO NOTHING",
        )
        .run(randomUUID(), id, b.id, b.revision, file.id, Date.now());
    return { complete: false };
  }
  const version = await db
    .prepare(
      "SELECT chunks,expected_files FROM remote_draft_versions WHERE account_id=? AND draft_id=? AND revision=?",
    )
    .get(id, b.id, b.revision);
  if (!version) fail(404, "Draft upload not found");
  if (op === "draftFileWrite") {
    if (row.revision === b.revision) return {};
    const expected = JSON.parse(version.expected_files).find((f) => f.id === b.fileId);
    if (
      !expected ||
      !Number.isInteger(b.seq) ||
      b.seq < 0 ||
      b.seq >= expected.chunks ||
      typeof b.payload !== "string" ||
      b.payload.length > 90000
    )
      fail(400, "Invalid draft chunk");
    const file = await db
      .prepare(
        "SELECT id FROM mail_files WHERE account_id=? AND draft_id=? AND revision=? AND part=?",
      )
      .get(id, b.id, b.revision, b.fileId);
    await files.putChunk(file, b.seq, b.payload);
    return {};
  }
  if (op === "draftWrite") {
    if (row.revision === b.revision) return {};
    if (
      !Number.isInteger(b.seq) ||
      b.seq < 0 ||
      b.seq >= version.chunks ||
      typeof b.payload !== "string" ||
      b.payload.length > 90000 ||
      !BASE64.test(b.payload)
    )
      fail(400, "Invalid draft chunk");
    await db
      .prepare(
        "INSERT INTO remote_draft_chunks VALUES(?,?,?,?,?) ON CONFLICT(account_id,draft_id,revision,seq) DO UPDATE SET payload=excluded.payload",
      )
      .run(id, b.id, b.revision, b.seq, b.payload);
    return {};
  }
  if (op === "draftFinish") {
    const count = await db
      .prepare(
        "SELECT COUNT(*) n FROM remote_draft_chunks WHERE account_id=? AND draft_id=? AND revision=?",
      )
      .get(id, b.id, b.revision);
    if (Number(count.n) !== version.chunks) fail(409, "Draft upload incomplete");
    for (const expected of JSON.parse(version.expected_files)) {
      const count = await db
        .prepare(
          "SELECT COUNT(*) n FROM mail_file_chunks c JOIN mail_files f ON f.id=c.file_id WHERE f.account_id=? AND f.draft_id=? AND f.revision=? AND f.part=?",
        )
        .get(id, b.id, b.revision, expected.id);
      if (Number(count.n) !== expected.chunks) fail(409, "Draft upload incomplete");
    }
    const receipt = uuid(b.sendId)
      ? await db.prepare("SELECT id FROM outbox WHERE id=? AND account_id=?").get(b.sendId, id)
      : null;
    await db
      .prepare(
        "UPDATE remote_drafts SET revision=?,updated=?,send_id=? WHERE account_id=? AND id=?",
      )
      .run(b.revision, Date.now(), receipt?.id || null, id, b.id);
    if (b.baseRevision && b.baseRevision !== b.revision)
      await db
        .prepare(
          "DELETE FROM remote_draft_versions WHERE account_id=? AND draft_id=? AND revision=?",
        )
        .run(id, b.id, b.baseRevision);
    return {};
  }
  fail(400, "Unsupported draft operation");
}
// Worker encrypts the entire snapshot, including attachment bytes, before crossing the broker.
export class RemoteDrafts {
  constructor(store, crypto, { now = Date.now } = {}) {
    Object.assign(this, { store, crypto, now });
    this.migrating = null;
    this.lastMigration = 0;
    this.nextScan = new Map();
  }
  // Storage version 1 drafts are no longer written, and each draftLegacy probe is a locked
  // transaction. Scan at most once a minute; an account found clean is rescanned hourly.
  migrationDue(now = this.now()) {
    return !this.migrating && now - this.lastMigration >= MINUTE;
  }
  scheduleMigration(accounts) {
    if (!this.migrationDue()) return;
    this.migrating = (async () => {
      const now = this.now();
      for (const [id, at] of this.nextScan) if (at <= now) this.nextScan.delete(id);
      let budget = MIGRATIONS_PER_SCAN;
      for (const a of accounts) {
        if (a.purge_after || this.nextScan.has(a.id)) continue;
        try {
          for (;;) {
            const old = await this.store.call("draftLegacy", { accountId: a.id });
            if (!old) {
              this.nextScan.set(a.id, this.now() + HOUR);
              break;
            }
            // Unfinished accounts stay unscheduled and continue on the next scan.
            if (budget-- <= 0) return;
            const snapshot = await this.handle(a, old.id, "GET", {});
            await this.handle(
              a,
              old.id,
              "POST",
              { ...snapshot, baseRevision: snapshot.revision, revision: randomUUID() },
              true,
            );
          }
        } catch {
          this.nextScan.set(a.id, this.now() + MIGRATION_RETRY);
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.lastMigration = this.now();
        this.migrating = null;
      });
  }
  async handle(account, suffix, method, body, migration = false) {
    const values = { accountId: account.id, id: suffix, migration };
    const call = (op, extra = {}) => this.store.call(op, { ...values, ...extra });
    if (!suffix && method === "GET") return call("draftList");
    if (!uuid(suffix)) fail(400, "Invalid draft");
    if (method === "GET") {
      const result = await call("draftRead");
      const data = Buffer.concat(
        result.parts.map((p, i) =>
          this.crypto.open(p, `draft:${account.id}:${suffix}:${result.revision}:${i}`),
        ),
      );
      const snapshot = JSON.parse(data.toString());
      if (result.storageVersion === 2) {
        snapshot.files = [];
        for (const f of result.files) {
          const chunks = [];
          for (let seq = 0; seq < f.chunks; seq++) {
            const row = await call("draftFileRead", {
              revision: result.revision,
              fileId: f.id,
              seq,
            });
            chunks.push(
              this.crypto.open(
                row.payload,
                `draft-file:${account.id}:${suffix}:${result.revision}:${f.id}:${seq}`,
              ),
            );
          }
          snapshot.files.push({ id: f.id, data: Buffer.concat(chunks).toString("base64") });
        }
      }
      return { ...snapshot, revision: result.revision };
    }
    if (method === "DELETE") return call("draftDelete", { baseRevision: body.baseRevision });
    if (method !== "POST") fail(405, "Method not allowed");
    const { draft, files, revision, baseRevision } = body;
    if (
      !draft ||
      draft.id !== suffix ||
      draft.accountID !== account.id ||
      !Array.isArray(draft.attachments) ||
      draft.attachments.length > 20 ||
      !Array.isArray(files) ||
      files.length !== draft.attachments.length
    )
      fail(400, "Invalid draft");
    let total = 0;
    const ids = new Set();
    for (const part of draft.attachments) {
      const file = files.find((f) => f.id === part.id);
      if (
        !uuid(part.id) ||
        ids.has(part.id) ||
        !file ||
        typeof file.data !== "string" ||
        typeof part.filename !== "string" ||
        part.filename.length > 1024 ||
        !Number.isSafeInteger(part.size) ||
        part.size < 0
      )
        fail(400, "Invalid draft attachment");
      ids.add(part.id);
      const data = Buffer.from(file.data, "base64");
      if (data.length !== part.size || data.toString("base64") !== file.data)
        fail(400, "Incomplete draft attachment");
      total += data.length;
    }
    if (total > MAX_UPLOAD_BYTES) fail(413, "Draft attachments too large");
    for (const field of ["to", "cc", "bcc", "subject", "text"])
      if (typeof draft[field] !== "string" || Buffer.byteLength(draft[field]) > 524288)
        fail(400, "Invalid draft");
    const status = await this.store.call("status", { accountId: account.id });
    this.crypto.key(!status.messages && !status.drafts);
    const data = Buffer.from(JSON.stringify({ draft }));
    const meta = {
      revision,
      baseRevision,
      chunks: Math.ceil(data.length / CHUNK_BYTES),
      files: draft.attachments.map((f) => ({ id: f.id, chunks: Math.ceil(f.size / CHUNK_BYTES) })),
    };
    const begun = await call("draftBegin", meta);
    if (!begun.complete) {
      for (let seq = 0; seq < meta.chunks; seq++)
        await call("draftWrite", {
          ...meta,
          seq,
          payload: this.crypto.seal(
            data.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES),
            `draft:${account.id}:${suffix}:${revision}:${seq}`,
          ),
        });
      for (const f of files) {
        const bytes = Buffer.from(f.data, "base64");
        for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK_BYTES, seq++)
          await call("draftFileWrite", {
            ...meta,
            fileId: f.id,
            seq,
            payload: this.crypto.seal(
              bytes.subarray(offset, offset + CHUNK_BYTES),
              `draft-file:${account.id}:${suffix}:${revision}:${f.id}:${seq}`,
            ),
          });
      }
      await call("draftFinish", { ...meta, sendId: draft.attempt?.status?.id });
    }
    return { revision };
  }
}
