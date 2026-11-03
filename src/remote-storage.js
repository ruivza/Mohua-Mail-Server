import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { DAY, SECOND, RECOVERY_PERIOD } from "./limits.js";
export const RECOVERY_MS = RECOVERY_PERIOD;
// Wall-clock budget for draining purged archives in one sweep call; each batch is its own short transaction.
const PURGE_BATCH = 100,
  PURGE_BUDGET = 5 * SECOND;
// Control-side lifecycle; runs independently of mailbox credentials and worker uptime.
export class RemoteStorage {
  constructor(db, invalidate, now = Date.now, files) {
    Object.assign(this, { db, invalidate, now, files });
  }
  async status(id, includeUsage = false) {
    const a = await this.db.prepare("SELECT purge_after FROM accounts WHERE id=?").get(id);
    if (!a) fail(404, "Mailbox not found");
    const mail = await this.db
      .prepare("SELECT COUNT(*) n FROM archive_messages WHERE account_id=? AND uid IS NOT NULL")
      .get(id);
    const drafts = await this.db
      .prepare(
        "SELECT COUNT(*) n FROM remote_drafts WHERE account_id=? AND revision IS NOT NULL AND deleted_at IS NULL",
      )
      .get(id);
    const result = {
      messages: Number(mail.n),
      drafts: Number(drafts.n),
      purgeAfter: a.purge_after,
      recoveryDays: RECOVERY_MS / DAY,
    };
    if (!includeUsage) return result;
    // Account-scoped stored payload estimate; excludes shared DB overhead and backups.
    // pg_column_size reports the stored (possibly compressed/TOASTed) size without detoasting each value.
    const usage = await this.db
      .prepare(
        `SELECT COALESCE(SUM(bytes),0) bytes FROM (
      SELECT pg_column_size(c.payload)::bigint bytes FROM archive_chunks c JOIN archive_messages m ON m.id=c.message_id WHERE m.account_id=?
      UNION ALL SELECT pg_column_size(metadata)::bigint FROM archive_messages WHERE account_id=?
      UNION ALL SELECT pg_column_size(payload)::bigint FROM remote_draft_chunks WHERE account_id=?
      UNION ALL SELECT (c.bytes+4)::bigint FROM mail_file_chunks c JOIN mail_files f ON f.id=c.file_id WHERE f.account_id=?
    ) content`,
      )
      .get(id, id, id, id);
    return { ...result, storedBytes: Number(usage.bytes) };
  }
  async change(id, userId, action, email) {
    if (!["delete", "restore", "purge"].includes(action)) fail(400, "Invalid storage action");
    await this.db.transaction(async () => {
      const a = await this.db
        .prepare("SELECT * FROM accounts WHERE id=? AND user_id=? FOR UPDATE")
        .get(id, userId);
      if (!a) fail(404, "Mailbox not found");
      if (action === "purge") {
        if (email !== a.email) fail(400, "Type the mailbox email to confirm permanent deletion");
        if (!a.purge_after) fail(409, "Start mailbox deletion before permanently deleting");
        await this.db
          .prepare(
            "UPDATE accounts SET purge_after=?,credential=NULL,sync_credential=NULL,writeback_enabled=0,sync_status='deletion_pending',monitor_enabled=0 WHERE id=?",
          )
          .run(Math.min(a.purge_after, this.now()), id);
      } else if (action === "delete") {
        if (email !== a.email) fail(400, "Type the mailbox email to confirm deletion");
        // Repeated submissions cannot extend the recovery period.
        if (!a.purge_after)
          await this.db
            .prepare(
              "UPDATE accounts SET deletion_requested_at=?,purge_after=?,credential=NULL,sync_credential=NULL,writeback_enabled=0,sync_status='deletion_pending',monitor_enabled=0 WHERE id=?",
            )
            .run(this.now(), this.now() + RECOVERY_MS, id);
      } else {
        if (a.purge_after && a.purge_after <= this.now()) fail(409, "Recovery period has ended");
        // Restored archives reopen paused; a mailbox that never used sync mode stays on live IMAP reads.
        if (a.purge_after)
          await this.db
            .prepare(
              "UPDATE accounts SET deletion_requested_at=NULL,purge_after=NULL,sync_status=CASE WHEN sync_enabled=1 THEN 'paused' ELSE 'off' END,sync_credential=NULL,monitor_enabled=0 WHERE id=?",
            )
            .run(id);
      }
    });
    if (action !== "restore")
      await this.db.prepare("DELETE FROM mailbox_writebacks WHERE account_id=?").run(id);
    this.invalidate(id);
    if (action === "purge") {
      // Commit the irreversible deadline first; failures remain durable for maintenance retry.
      try {
        await this.sweep(id);
      } catch {
        console.error("Immediate mailbox cleanup will retry in maintenance");
      }
    }
    return { updated: true };
  }
  async sweep(accountId) {
    const due = accountId
      ? await this.db
          .prepare("SELECT id FROM accounts WHERE id=? AND purge_after<=?")
          .all(accountId, this.now())
      : await this.db.prepare("SELECT id FROM accounts WHERE purge_after<=?").all(this.now());
    // Real elapsed time, not this.now(): tests and recovery checks move the logical clock.
    const deadline = Date.now() + PURGE_BUDGET;
    for (const { id } of due) {
      this.invalidate(id);
      // Every due mailbox gets at least one batch; the budget only limits further batches.
      for (;;) {
        const finished = await this.db.transaction(async () => {
          const a = await this.db
            .prepare("SELECT purge_after FROM accounts WHERE id=? FOR UPDATE")
            .get(id);
          if (!a?.purge_after || a.purge_after > this.now()) return true;
          await this.db
            .prepare(
              "DELETE FROM archive_messages WHERE id IN (SELECT id FROM archive_messages WHERE account_id=? LIMIT ?)",
            )
            .run(id, PURGE_BATCH);
          if (
            await this.db
              .prepare("SELECT 1 FROM archive_messages WHERE account_id=? LIMIT 1")
              .get(id)
          )
            return false;
          await this.db.prepare("DELETE FROM archive_folders WHERE account_id=?").run(id);
          await this.db.prepare("DELETE FROM remote_drafts WHERE account_id=?").run(id);
          await this.db.prepare("DELETE FROM outbox WHERE account_id=?").run(id);
          return true;
        });
        if (finished || Date.now() >= deadline) break;
      }
    }
    // File cleanup shares what is left of this call's budget; it always processes at least one batch.
    if (this.files) await this.files.collect(Math.max(0, deadline - Date.now()));
    // Keep the pending mailbox visible until all durable file-deletion jobs succeeded.
    for (const { id } of due)
      await this.db.transaction(async () => {
        const a = await this.db
          .prepare("SELECT purge_after FROM accounts WHERE id=? FOR UPDATE")
          .get(id);
        if (!a?.purge_after || a.purge_after > this.now()) return;
        for (const table of ["archive_messages", "remote_drafts", "mail_file_deletions"])
          if (await this.db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? LIMIT 1`).get(id))
            return;
        await this.db.prepare("DELETE FROM accounts WHERE id=?").run(id);
      });
    await this.db
      .prepare("DELETE FROM archive_messages WHERE deleted_at<=?")
      .run(this.now() - RECOVERY_MS);
    // Sent drafts remain until an actual complete archived original proves the sent copy exists.
    const receipts = await this.db
      .prepare(
        "SELECT d.account_id,d.id,d.revision,d.send_id,o.result FROM remote_drafts d JOIN outbox o ON o.id=d.send_id AND o.account_id=d.account_id WHERE d.deleted_at IS NULL AND o.state='sent'",
      )
      .all();
    for (const row of receipts) {
      let messageId;
      try {
        messageId = JSON.parse(row.result).messageId;
      } catch {
        continue;
      }
      if (typeof messageId !== "string") continue;
      const hash = createHash("sha256").update(messageId).digest("hex");
      await this.db
        .prepare(
          "UPDATE remote_drafts SET deleted_at=?,updated=? WHERE account_id=? AND id=? AND revision=? AND send_id=? AND EXISTS (SELECT 1 FROM archive_messages WHERE account_id=? AND message_hash=? AND uid IS NOT NULL)",
        )
        .run(
          this.now(),
          this.now(),
          row.account_id,
          row.id,
          row.revision,
          row.send_id,
          row.account_id,
          hash,
        );
    }
    // Only abandoned staging revisions and explicitly deleted drafts expire.
    await this.db
      .prepare(
        "DELETE FROM remote_draft_versions v WHERE created<? AND NOT EXISTS (SELECT 1 FROM remote_drafts d WHERE d.account_id=v.account_id AND d.id=v.draft_id AND d.revision=v.revision)",
      )
      .run(this.now() - DAY);
    // Keep small deletion tombstones so an old offline device cannot resurrect a draft.
    await this.db
      .prepare(
        "DELETE FROM remote_draft_versions v USING remote_drafts d WHERE d.account_id=v.account_id AND d.id=v.draft_id AND d.deleted_at<=?",
      )
      .run(this.now() - RECOVERY_MS);
  }
}
