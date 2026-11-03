import { applyWritebacks } from "./independent-writeback.js";
import { createHash } from "node:crypto";
import { splitStructure, messageMetadata } from "./reader.js";
import { fail } from "./errors.js";
import { SECOND, MINUTE, HOUR, DAY, CHUNK_BYTES, CHUNK_BATCH } from "./limits.js";
// Admission limits, cancellation and shutdown say nothing about the message being captured.
const TRANSIENT = new Set([429, 499, 503]);
export class ArchiveSync {
  constructor({
    reader,
    store,
    crypto,
    leases,
    now = Date.now,
    budgetMs = 10 * SECOND,
    maxMessages = 50,
    maxFailures = 3,
    skipMs = DAY,
  }) {
    Object.assign(this, {
      reader,
      store,
      crypto,
      leases,
      now,
      budgetMs,
      maxMessages,
      maxFailures,
      skipMs,
    });
    this.folderOffsets = new Map();
    this.running = new Map();
    this.last = new Map();
    this.closed = false;
    this.wakes = new Map();
    // Per account, in memory only: consecutive capture failures keyed by (folder, source UIDVALIDITY, UID).
    this.failures = new Map();
  }
  call(a, op, values = {}) {
    return this.store.call(op, { accountId: a.id, credential: a.sync_credential, ...values });
  }
  restore(a) {
    if (!a.sync_enabled || !a.sync_credential) return;
    const current = this.leases.entries.get(a.id);
    if (current?.persistent === a.sync_credential && current.credential === a.credential) return;
    const data = JSON.parse(this.crypto.open(a.sync_credential, "credential:" + a.id).toString());
    this.leases.restore(a, data, a.sync_credential);
  }
  async credential(a) {
    if (!a.credential) fail(423, "Mailbox authorization required");
    this.leases.assert(a);
    const status = await this.call(a, "status");
    this.crypto.key(status.messages === 0 && !status.drafts);
    const entry = this.leases.entries.get(a.id);
    return this.crypto.seal(
      Buffer.from(
        JSON.stringify({
          revision: entry.revision,
          key: entry.key.toString("base64"),
          ciphertext: entry.ciphertext.toString("base64"),
        }),
      ),
      "credential:" + a.id,
    );
  }
  schedule(accounts) {
    if (this.closed) return;
    // One account per worker at a time leaves capacity for interactive reads.
    if (this.running.size) return;
    const candidates = accounts
      .filter(
        (a) =>
          a.sync_enabled &&
          a.sync_credential &&
          (this.wakes.has(a.id) || Date.now() - (this.last.get(a.id) || 0) > 30 * SECOND),
      )
      .sort(
        (a, b) =>
          Number(this.wakes.has(b.id)) - Number(this.wakes.has(a.id)) ||
          (this.last.get(a.id) || 0) - (this.last.get(b.id) || 0),
      );
    const a = candidates[0];
    if (!a) return;
    const controller = new AbortController(),
      wake = this.wakes.get(a.id);
    const promise = this.run(a, controller.signal)
      .catch(async () => {
        await this.call(a, "state", { state: "error" }).catch(() => {});
      })
      .finally(() => {
        this.last.set(a.id, Date.now());
        if (this.wakes.get(a.id) === wake) this.wakes.delete(a.id);
        this.running.delete(a.id);
      });
    this.running.set(a.id, { promise, controller });
  }
  async run(a, signal) {
    this.restore(a);
    await this.call(a, "state", { state: "syncing" });
    await applyWritebacks(this, a, signal);
    const listed = await this.reader.folders(a, signal);
    const offset = (this.folderOffsets.get(a.id) || 0) % Math.max(1, listed.length);
    const folders = [...listed.slice(offset), ...listed.slice(0, offset)];
    this.folderOffsets.set(a.id, offset + 1);
    const started = this.now();
    let captured = 0,
      backfill = false,
      failed = false,
      yielded = false;
    const exhausted = () => captured >= this.maxMessages || this.now() - started >= this.budgetMs;
    this.pruneFailures(a.id);
    const struck = new Set();
    const savePage = async (folder, value) => {
      const saved = await this.call(a, "existsMany", {
        folder,
        sourceValidity: value.uidValidity,
        uids: value.items.map((i) => i.uid),
      });
      const known = new Set(saved.complete);
      for (const item of [...value.items].reverse()) {
        signal?.throwIfAborted();
        if (known.has(item.uid)) continue;
        const key = JSON.stringify([folder, value.uidValidity, item.uid]);
        // A set-aside message no longer holds back its page or the folder history.
        if (this.skipping(a.id, key)) continue;
        if (exhausted()) {
          yielded = true;
          return false;
        }
        captured++;
        try {
          await this.capture(a, folder, value.uidValidity, item.uid, signal, true);
          this.failures.get(a.id)?.delete(key);
        } catch (error) {
          signal?.throwIfAborted();
          if ([401, 403, 409, 423].includes(error.status)) throw error;
          failed = true;
          if (this.strike(a.id, key, error, struck)) continue;
          // Leave the rest of the page to the next run: a broken connection would otherwise
          // fail every remaining message and count against each of them.
          return false;
        }
      }
      return true;
    };
    const histories = [];
    // Check the newest page in every visited folder before spending the remaining
    // slice on history. Account and folder rotation bound backfill monopolization.
    for (const f of folders) {
      signal?.throwIfAborted();
      if (exhausted()) {
        backfill = true;
        break;
      }
      const saved = await this.call(a, "folder", {
        folder: f.path,
        name: f.name || f.path,
        specialUse: f.specialUse || null,
      });
      let cursor = saved.cursor ? JSON.parse(saved.cursor) : null;
      const newest = await this.reader.list(
        a,
        { folder: f.path, limit: 50, before: null, validity: null },
        signal,
      );
      await this.call(a, "arrivalBoundary", {
        folder: f.path,
        sourceValidity: newest.uidValidity,
        highWater: newest.highWater,
      });
      const complete = await savePage(f.path, newest);
      if (cursor?.validity !== newest.uidValidity) cursor = null;
      // A completed history is audited hourly; arrivals beyond the previous high
      // water still resume immediately when they overflow the newest UID window.
      const audited =
        cursor?.before === null &&
        this.now() - (cursor.checkedAt || 0) < HOUR &&
        (newest.nextBefore === null || newest.nextBefore <= cursor.highWater);
      // A burst can overflow the newest window while an older history cursor is
      // still in progress. Resume at the burst's tail rather than skipping it.
      const overflow =
        cursor && newest.nextBefore !== null && newest.nextBefore > (cursor.highWater || 0);
      const before = audited
        ? null
        : overflow
          ? newest.nextBefore
          : (cursor?.before ?? newest.nextBefore);
      histories.push({ f, newest, before, audited, complete });
    }
    for (const history of histories) {
      const { f, newest, audited, complete } = history;
      let { before } = history;
      if (audited) continue;
      for (let page = 0; before !== null && page < 5; page++) {
        if (exhausted()) {
          yielded = true;
          break;
        }
        const value = await this.reader.list(
          a,
          { folder: f.path, limit: 50, before, validity: newest.uidValidity },
          signal,
        );
        if (!(await savePage(f.path, value))) break;
        before = value.nextBefore;
        await this.call(a, "cursor", {
          folder: f.path,
          cursor: JSON.stringify({
            validity: value.uidValidity,
            before,
            highWater: newest.highWater,
            checkedAt: before === null ? this.now() : null,
          }),
        });
      }
      if (before === null && complete)
        await this.call(a, "cursor", {
          folder: f.path,
          cursor: JSON.stringify({
            validity: newest.uidValidity,
            before: null,
            highWater: newest.highWater,
            checkedAt: this.now(),
          }),
        });
      else backfill = true;
    }
    // Keep reporting an error while set-aside messages are missing from the archive.
    await this.call(a, "state", {
      state:
        failed || this.skippedCount(a.id) ? "error" : backfill || yielded ? "backfill" : "idle",
    });
  }
  // Counts consecutive failures of one message across runs, at most once per run. Returns
  // true once the message is set aside; it is retried after skipMs or invalidate().
  strike(id, key, error, struck) {
    if (TRANSIENT.has(error.status) || struck.has(key)) return false;
    struck.add(key);
    let entries = this.failures.get(id);
    if (!entries) this.failures.set(id, (entries = new Map()));
    const entry = { count: (entries.get(key)?.count || 0) + 1, at: this.now() };
    entries.set(key, entry);
    if (entry.count < this.maxFailures) return false;
    // Logs carry no account, folder, UID or message data.
    console.warn("Archive sync set aside a message after repeated capture failures", {
      status: error.status || null,
      attempts: entry.count,
      skipped: this.skippedCount(id),
    });
    return true;
  }
  skipping(id, key) {
    const entry = this.failures.get(id)?.get(key);
    return !!entry && entry.count >= this.maxFailures && this.now() - entry.at < this.skipMs;
  }
  skippedCount(id) {
    let count = 0;
    for (const key of this.failures.get(id)?.keys() || []) if (this.skipping(id, key)) count++;
    return count;
  }
  pruneFailures(id) {
    const entries = this.failures.get(id);
    if (!entries) return;
    for (const [key, entry] of entries)
      if (this.now() - entry.at >= this.skipMs) entries.delete(key);
    if (!entries.size) this.failures.delete(id);
  }

  async capture(a, folder, validity, uid, signal, checked = false) {
    if (
      !checked &&
      (await this.call(a, "exists", { folder, sourceValidity: validity, sourceUid: uid })).complete
    )
      return false;
    return this.reader.execute(
      a,
      { folder, validity },
      async (client, box, check) => {
        const meta = await client.fetchOne(
          uid,
          { uid: true, bodyStructure: true, envelope: true, flags: true, size: true },
          { uid: true },
        );
        if (!meta) return false;
        const parts = splitStructure(meta.bodyStructure),
          metadata = messageMetadata(meta, validity, uid, parts);
        const summary = {
          subject: meta.envelope?.subject || "",
          from: meta.envelope?.from || [],
          date: meta.envelope?.date || null,
          flags: [...(meta.flags || [])],
          size: meta.size,
        };
        const encrypted = this.crypto.seal(
          Buffer.from(
            JSON.stringify({
              metadata,
              summary,
              envelope: meta.envelope || {},
              rawAttachments: true,
            }),
          ),
          "metadata:" + a.id,
        );
        const downloads = [
          { key: "raw", part: undefined },
          ...(parts.body ? [{ key: "body", part: parts.body.part }] : []),
        ];
        const draft = await this.call(a, "begin", {
          folder,
          sourceValidity: validity,
          sourceUid: uid,
          messageHash: meta.envelope?.messageId
            ? createHash("sha256").update(meta.envelope.messageId).digest("hex")
            : null,
          metadata: encrypted,
          flags: summary.flags,
          sortTime: Date.parse(summary.date) || 0,
          parts: downloads.map((p) => p.key),
        });
        if (draft.complete) return false;
        const manifest = [];
        for (const p of downloads) {
          check();
          const dl = await client.download(uid, p.part, { uid: true, chunkSize: CHUNK_BYTES });
          let seq = 0,
            bytes = 0,
            batch = [];
          const flush = async () => {
            if (!batch.length) return;
            check();
            await this.call(a, "writeBatch", { folder, id: draft.id, part: p.key, chunks: batch });
            batch = [];
          };
          try {
            for await (const value of dl.content) {
              const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
              for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
                check();
                const chunk = buffer.subarray(offset, offset + CHUNK_BYTES);
                bytes += chunk.length;
                batch.push({
                  seq,
                  payload: this.crypto.seal(chunk, `chunk:${a.id}:${draft.id}:${p.key}:${seq}`),
                });
                seq++;
                if (batch.length === CHUNK_BATCH) await flush();
              }
            }
            await flush();
          } finally {
            dl.content.destroy();
          }
          if (p.key === "raw" && Number.isFinite(meta.size) && bytes !== meta.size) {
            check();
            if (!(await this.downloadEnded(client, uid, bytes)))
              fail(502, "Incomplete original message download");
          }
          manifest.push({ part: p.key, chunks: seq });
        }
        check();
        const from = meta.envelope?.from?.[0];
        await this.call(a, "finish", {
          folder,
          id: draft.id,
          manifest,
          notification: {
            sender: from?.name || from?.address || "",
            subject: meta.envelope?.subject || "",
          },
        });
        return true;
      },
      signal,
      10 * MINUTE,
    );
  }
  // RFC822.SIZE is advisory: some servers count line endings differently than they deliver.
  // A download can still end early without an error (a short chunk, or the message expunged
  // mid-fetch), so on a mismatch ask for the octet just past what arrived. Only an empty
  // answer proves the saved original is whole.
  async downloadEnded(client, uid, bytes) {
    const tail = await client.fetchOne(
      uid,
      { uid: true, source: { start: bytes, maxLength: 1 } },
      { uid: true },
    );
    if (!tail) return false;
    const extra = tail.source?.length || 0;
    // Servers that ignore partial ranges answer with the whole source instead of one octet.
    return extra === 0 || (extra > 1 && extra === bytes);
  }
  wake(id) {
    this.wakes.set(id, (this.wakes.get(id) || 0) + 1);
  }
  invalidate(id) {
    this.running.get(id)?.controller.abort();
    this.last.delete(id);
    this.folderOffsets.delete(id);
    this.failures.delete(id);
  }
  async close() {
    this.closed = true;
    for (const job of this.running.values()) job.controller.abort();
    await Promise.allSettled([...this.running.values()].map((j) => j.promise));
  }
}
