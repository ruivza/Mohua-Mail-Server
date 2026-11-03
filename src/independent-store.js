import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { newValidity } from "./validate.js";
import { MAX_UID, MINUTE } from "./limits.js";
export async function independentOperation(db, a, op, b) {
  const id = a.id;
  if (op === "writebackStatus")
    return db
      .prepare(
        "SELECT COUNT(*) FILTER(WHERE state='pending') pending,COUNT(*) FILTER(WHERE state='blocked') blocked FROM mailbox_writebacks WHERE account_id=?",
      )
      .get(id);
  if (op === "writebackNext") {
    if (!a.sync_enabled || !a.sync_credential || a.sync_credential !== b.credential)
      fail(409, "Sync paused");
    if (!a.writeback_enabled) return null;
    // Writebacks for one message apply strictly in sequence order: a row waits while any earlier row for the
    // same message remains, whether pending (possibly not yet due) or blocked. A blocked row never runs again,
    // so writebackFailed and independentMutation mark the rows queued behind it blocked too; disabling
    // writeback (configureSync) clears the whole queue.
    return db
      .prepare(
        "SELECT q.*,m.source_folder,m.source_uid,m.source_validity FROM mailbox_writebacks q JOIN archive_messages m ON m.id=q.message_id WHERE q.account_id=? AND q.state='pending' AND q.next_at<=? AND NOT EXISTS(SELECT 1 FROM mailbox_writebacks earlier WHERE earlier.message_id=q.message_id AND earlier.sequence<q.sequence) ORDER BY q.sequence LIMIT 1",
      )
      .get(id, Date.now());
  }
  if (op === "writebackComplete" || op === "writebackFailed") {
    if (!a.sync_enabled || !a.sync_credential || a.sync_credential !== b.credential)
      fail(409, "Sync paused");
    const q = await db
      .prepare("SELECT * FROM mailbox_writebacks WHERE account_id=? AND id=? FOR UPDATE")
      .get(id, b.id);
    if (!q) return {};
    if (op === "writebackFailed") {
      await db
        .prepare("UPDATE mailbox_writebacks SET attempts=attempts+1,state=?,next_at=? WHERE id=?")
        .run(b.blocked ? "blocked" : "pending", Date.now() + MINUTE, q.id);
      if (b.blocked)
        await db
          .prepare(
            "UPDATE mailbox_writebacks SET state='blocked' WHERE account_id=? AND message_id=? AND sequence>? AND state='pending'",
          )
          .run(id, q.message_id, q.sequence);
      return {};
    }
    if (b.destination) {
      if (
        typeof b.destination !== "string" ||
        b.destination.length > 512 ||
        !Number.isSafeInteger(b.uid) ||
        b.uid < 1 ||
        typeof b.validity !== "string" ||
        !/^\d{1,20}$/.test(b.validity)
      )
        fail(400, "Invalid move result");
      await db
        .prepare(
          "INSERT INTO mailbox_source_links(account_id,folder,validity,uid,message_id) VALUES(?,?,?,?,?) ON CONFLICT(account_id,folder,validity,uid) DO NOTHING",
        )
        .run(id, b.destination, b.validity, b.uid, q.message_id);
      await db
        .prepare(
          "UPDATE archive_messages SET source_folder=?,source_validity=?,source_uid=? WHERE id=?",
        )
        .run(b.destination, b.validity, b.uid, q.message_id);
    }
    await db.prepare("DELETE FROM mailbox_writebacks WHERE id=?").run(q.id);
    return {};
  }
  fail(400, "Unsupported independent operation");
}
export async function independentMutation(db, a, message, b) {
  const action = b.action;
  if (!["read", "unread", "flag", "unflag", "move", "archive", "trash", "purge"].includes(action))
    fail(400, "Invalid mail action");
  if (action === "purge") {
    if (!message.deleted_at) fail(409, "Move the message to trash before permanently deleting");
    await db.prepare("DELETE FROM archive_messages WHERE id=?").run(message.id);
    return { updated: true, reload: true };
  }
  let destination = null;
  if (["read", "unread", "flag", "unflag"].includes(action)) {
    const flags = new Set(JSON.parse(message.flags)),
      flag = ["read", "unread"].includes(action) ? "\\Seen" : "\\Flagged";
    if (["read", "flag"].includes(action)) flags.add(flag);
    else flags.delete(flag);
    await db
      .prepare("UPDATE archive_messages SET flags=? WHERE id=?")
      .run(JSON.stringify([...flags]), message.id);
  } else {
    if (action === "move") {
      if (
        typeof b.destination !== "string" ||
        !b.destination ||
        b.destination.length > 512 ||
        /[\x00-\x1f]/.test(b.destination)
      )
        fail(400, "Invalid destination");
      destination = b.destination;
    } else {
      const special = action === "trash" ? "\\Trash" : "\\Archive";
      let folder = await db
        .prepare(
          "SELECT path FROM archive_folders WHERE account_id=? AND special_use=? ORDER BY path LIMIT 1",
        )
        .get(a.id, special);
      if (!folder) {
        const path = action === "trash" ? "Mohua Trash" : "Mohua Archive";
        await db
          .prepare(
            "INSERT INTO archive_folders(account_id,path,name,special_use,validity) VALUES(?,?,?,?,?) ON CONFLICT(account_id,path) DO NOTHING",
          )
          .run(a.id, path, path, special, newValidity());
        folder = { path };
      }
      destination = folder.path;
    }
    const folder = await db
      .prepare("SELECT * FROM archive_folders WHERE account_id=? AND path=? FOR UPDATE")
      .get(a.id, destination);
    if (!folder) fail(400, "Destination folder not found");
    if (destination === message.folder) fail(409, "Message is already in this folder");
    if (folder.next_uid > MAX_UID) fail(507, "Mailbox UID capacity reached");
    await db
      .prepare("UPDATE archive_messages SET folder=?,uid=?,deleted_at=? WHERE id=?")
      .run(
        destination,
        folder.next_uid,
        folder.special_use === "\\Trash" ? Date.now() : null,
        message.id,
      );
    await db
      .prepare("UPDATE archive_folders SET next_uid=next_uid+1 WHERE account_id=? AND path=?")
      .run(a.id, destination);
  }
  if (a.writeback_enabled) {
    // A change queued behind a blocked writeback can never run either; record it as blocked so status stays accurate.
    await db
      .prepare(
        "INSERT INTO mailbox_writebacks(id,account_id,message_id,action,destination,state,next_at) VALUES(?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM mailbox_writebacks WHERE account_id=? AND message_id=? AND state='blocked') THEN 'blocked' ELSE 'pending' END,0)",
      )
      .run(randomUUID(), a.id, message.id, action, destination, a.id, message.id);
  }
  return { updated: true, reload: true, ...(destination ? { destination } : {}) };
}
