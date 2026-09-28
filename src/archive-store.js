import { independentOperation, independentMutation } from "./independent-store.js";
import { draftOperation } from "./remote-drafts.js";
import { randomUUID, randomBytes } from "node:crypto";
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const text = (s, max = 512) => typeof s === "string" && s.length > 0 && s.length <= max;
const integer = (n, max = 4294967295) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const encrypted = (s, max = 100000) => text(s, max) && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

const readOperations = new Set(['status','folders','list','sync','known','exists','existsMany','message','chunk','chunks',
  'draftLegacy','draftList','draftRead','draftFileRead','writebackStatus']);
// Named, bounded operations only: the worker never receives SQL access.
export class ArchiveStore {
  constructor(db,files,changed=async()=>{}) { this.db = db; this.files=files; this.changed=changed; }
  async call(op, b) { return this.db.transaction(() => this.lockedCall(op,b)); }
  async lockedCall(op,b) {
    const db = this.db;
    // Shared readers still block account deletion/revocation, but not each other.
    const lock = readOperations.has(op) ? 'FOR SHARE OF a' : 'FOR UPDATE OF a';
    const account = await db.prepare("SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND u.active=1 " + lock).get(b.accountId);
    if (!account) fail(404, "Mailbox not found");
    if (op === "status") {
      const row = await db.prepare("SELECT COUNT(*) n FROM archive_messages WHERE account_id=? AND uid IS NOT NULL").get(account.id);
      const drafts=await db.prepare("SELECT COUNT(*) n FROM remote_draft_versions WHERE account_id=?").get(account.id);
      const writes=await independentOperation(db,account,"writebackStatus",{});
      return { writebackPending:Number(writes.pending),writebackBlocked:Number(writes.blocked),drafts:Number(drafts.n), writebackEnabled: !!account.writeback_enabled, enabled: !!account.sync_enabled, authorized: !!account.sync_credential, state: account.sync_status, updatedAt: account.sync_updated, messages: Number(row.n) };
    }
    if (account.purge_after) fail(409,"Mailbox deletion pending");
    if (op.startsWith("writeback")) return independentOperation(db,account,op,b);
    if (op.startsWith("draft")) return draftOperation(db,account,op,b,this.files);
    if (op === "state") {
      if (!["syncing", "backfill", "idle", "error", "authorization_required"].includes(b.state)) fail(400, "Invalid sync state");
      await db.prepare("UPDATE accounts SET sync_status=?,sync_updated=? WHERE id=? AND sync_enabled=1 AND sync_credential IS NOT NULL").run(b.state, Date.now(), account.id);
      return {};
    }
    if (op === "folders") return db.prepare("SELECT path,name,special_use AS \"specialUse\",validity,cursor FROM archive_folders WHERE account_id=? ORDER BY path").all(account.id);
    if (!text(b.folder)) fail(400, "Invalid archive folder");
    if (op === "folder") {
      if (!account.sync_enabled || !account.sync_credential) fail(409, "Sync paused");
      if (!text(b.name) || (b.specialUse !== null && !text(b.specialUse))) fail(400, "Invalid archive folder");
      const validity = (BigInt("0x" + randomBytes(8).toString("hex")) + 1n).toString();
      await db.prepare("INSERT INTO archive_folders(account_id,path,name,special_use,validity) VALUES(?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET name=excluded.name,special_use=excluded.special_use").run(account.id, b.folder, b.name, b.specialUse, validity);
    }
    const folder = await db.prepare("SELECT * FROM archive_folders WHERE account_id=? AND path=?").get(account.id, b.folder);
    if (!folder) fail(404, "Folder has not been synced yet");
    if (op === "folder") return folder;
    if (op === "arrivalBoundary") {
      if (!account.sync_enabled || !account.sync_credential || account.sync_credential !== b.credential) fail(409,"Sync paused");
      if (!text(b.sourceValidity,20) || !/^[1-9]\d*$/.test(b.sourceValidity) || !integer(b.highWater)) fail(400,"Invalid arrival boundary");
      // A UIDVALIDITY reset establishes a new baseline instead of re-alerting old messages.
      if (folder.arrival_validity !== b.sourceValidity) await db.prepare("UPDATE archive_folders SET arrival_validity=?,arrival_floor=? WHERE account_id=? AND path=?").run(b.sourceValidity,b.highWater,account.id,b.folder);
      return {};
    }
    if (op === "cursor") {
      if (b.cursor !== null && (!text(b.cursor, 1000))) fail(400, "Invalid archive cursor");
      await db.prepare("UPDATE archive_folders SET cursor=? WHERE account_id=? AND path=?").run(b.cursor, account.id, b.folder); return {};
    }
    if (b.validity && b.validity !== folder.validity) fail(409, "Mailbox changed; reload message list");
    if (op === "sync") {
      if (!integer(b.after) || !Array.isArray(b.known) || b.known.length > 500 || b.known.some(n => !integer(n) || n < 1 || n > b.after)) fail(400,"Invalid archive sync");
      const highWater=folder.next_uid-1;
      if(b.after>highWater)fail(409,"Mailbox changed; reload message list");
      const end=Math.min(highWater,b.after+1000);
      const rows=await db.prepare("SELECT id,uid,metadata,flags FROM archive_messages WHERE account_id=? AND folder=? AND uid>? AND uid<=? ORDER BY uid DESC LIMIT 1000").all(account.id,b.folder,b.after,end);
      const existing=b.known.length?await db.prepare(`SELECT uid,flags FROM archive_messages WHERE account_id=? AND folder=? AND uid IN (${b.known.map(()=>"?").join(",")})`).all(account.id,b.folder,...b.known):[];
      return {validity:folder.validity,highWater:end,hasMore:end<highWater,rows,existing};
    }
    if (op === "list") {
      if (!integer(b.before, 4294967296) || !integer(b.limit, 1000) || b.limit < 1 || !integer(b.after || 0)) fail(400, "Invalid archive page");
      let rows;
      if (Object.hasOwn(b,"after")) rows = await db.prepare("SELECT id,uid,metadata,flags FROM archive_messages WHERE account_id=? AND folder=? AND uid<? AND uid>? ORDER BY uid DESC LIMIT ?").all(account.id,b.folder,Math.min(b.before,folder.next_uid),b.after,b.limit);
      else {
        const anchor = b.before === 4294967296 ? null : await db.prepare("SELECT sort_time,uid FROM archive_messages WHERE account_id=? AND folder=? AND uid=?").get(account.id,b.folder,b.before);
        if (b.before !== 4294967296 && !anchor) fail(409,"Archive cursor unavailable");
        rows = anchor ? await db.prepare("SELECT id,uid,metadata,flags FROM archive_messages WHERE account_id=? AND folder=? AND (sort_time<? OR (sort_time=? AND uid<?)) AND uid<? ORDER BY sort_time DESC,uid DESC LIMIT ?").all(account.id,b.folder,anchor.sort_time,anchor.sort_time,anchor.uid,folder.next_uid,b.limit)
          : await db.prepare("SELECT id,uid,metadata,flags FROM archive_messages WHERE account_id=? AND folder=? AND uid<? ORDER BY sort_time DESC,uid DESC LIMIT ?").all(account.id,b.folder,folder.next_uid,b.limit);
      }
      return { validity: folder.validity, highWater: folder.next_uid - 1, rows };
    }
    if (op === "known") {
      if (!Array.isArray(b.known) || b.known.length > 500 || b.known.some(n => !integer(n))) fail(400, "Invalid known messages");
      if (!b.known.length) return [];
      return db.prepare(`SELECT uid,flags FROM archive_messages WHERE account_id=? AND folder=? AND uid IN (${b.known.map(() => "?").join(",")})`).all(account.id, b.folder, ...b.known);
    }
    if(op === "existsMany") {
      if(!text(b.sourceValidity,20)||!Array.isArray(b.uids)||b.uids.length>50||b.uids.some(n=>!integer(n)||n<1))fail(400,"Invalid source UIDs");
      if(!b.uids.length)return {complete:[]};
      const rows=await db.prepare(`SELECT l.uid FROM mailbox_source_links l LEFT JOIN archive_messages m ON m.id=l.message_id WHERE l.account_id=? AND l.folder=? AND l.validity=? AND l.uid IN (${b.uids.map(()=>"?").join(",")}) AND (l.message_id IS NULL OR m.uid IS NOT NULL)`).all(account.id,b.folder,b.sourceValidity,...b.uids);
      return {complete:rows.map(r=>r.uid)};
    }
    if (op === "exists") {
      const link=await db.prepare("SELECT l.message_id,m.uid FROM mailbox_source_links l LEFT JOIN archive_messages m ON m.id=l.message_id WHERE l.account_id=? AND l.folder=? AND l.validity=? AND l.uid=?").get(account.id,b.folder,b.sourceValidity,b.sourceUid);
      return {complete:!!link && (!link.message_id || !!link.uid)};
    }
    if (op === "begin") {
      if (!account.sync_enabled || !account.sync_credential || account.sync_credential !== b.credential) fail(409, "Sync paused");
      if (!text(b.sourceValidity, 20) || !/^[1-9]\d*$/.test(b.sourceValidity) || !integer(b.sourceUid) || !encrypted(b.metadata, 900000) || !Array.isArray(b.flags) || b.flags.length > 100 || b.flags.some(f => !text(f, 256))) fail(400, "Invalid archive message");
      if (!Array.isArray(b.parts) || b.parts.length > 1002 || !b.parts.includes("raw") || b.parts.some(p=>!text(p,32)) || new Set(b.parts).size!==b.parts.length) fail(400,"Invalid archive parts");
      return db.transaction(async () => {
        await db.prepare("SELECT id FROM accounts WHERE id=? FOR UPDATE").get(account.id);
        const link=await db.prepare("SELECT l.message_id,m.uid FROM mailbox_source_links l LEFT JOIN archive_messages m ON m.id=l.message_id WHERE l.account_id=? AND l.folder=? AND l.validity=? AND l.uid=?").get(account.id,b.folder,b.sourceValidity,b.sourceUid);
        if(link && !link.message_id)return {complete:true};
        const old=link?{id:link.message_id,uid:link.uid}:null;
        if (old?.uid) return { id: old.id, complete: true };
        const id = old?.id || randomUUID();
        if (old) { await db.prepare("DELETE FROM archive_chunks WHERE message_id=?").run(id); await db.prepare("DELETE FROM mail_files WHERE message_id=?").run(id); }
        await db.prepare("INSERT INTO archive_messages(id,account_id,folder,source_validity,source_uid,metadata,flags,sort_time,expected_parts) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,flags=excluded.flags,expected_parts=excluded.expected_parts").run(id, account.id, b.folder, b.sourceValidity, b.sourceUid, b.metadata, JSON.stringify(b.flags), Number.isSafeInteger(b.sortTime) ? b.sortTime : 0, JSON.stringify(b.parts));
        if(b.messageHash && /^[a-f0-9]{64}$/.test(b.messageHash))await db.prepare("UPDATE archive_messages SET message_hash=? WHERE id=?").run(b.messageHash,id);
        await db.prepare('UPDATE archive_messages SET source_folder=? WHERE id=? AND source_folder IS NULL').run(b.folder,id);
        await db.prepare('INSERT INTO mailbox_source_links VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(account.id,b.folder,b.sourceValidity,b.sourceUid,id);
        return { id, complete: false };
      });
    }
    const message = b.id
      ? await db.prepare("SELECT * FROM archive_messages WHERE id=? AND account_id=? AND folder=?").get(b.id, account.id, b.folder)
      : await db.prepare("SELECT * FROM archive_messages WHERE uid=? AND account_id=? AND folder=?").get(b.uid, account.id, b.folder);
    if (!message) fail(404, "Archived message not found");
    if (["write", "writeBatch", "finish"].includes(op)) {
      if (!account.sync_enabled || !account.sync_credential || account.sync_credential !== b.credential) fail(409, "Sync paused");
      if (message.uid) fail(409, "Archive already complete");
    }
    if (op === "write" || op === "writeBatch") {
      const chunks=op==="write"?[{seq:b.seq,payload:b.payload}]:b.chunks;
      if(!text(b.part,32)||!Array.isArray(chunks)||!chunks.length||chunks.length>8||chunks.some(c=>!c||!integer(c.seq,2147483647)||!encrypted(c.payload))||new Set(chunks.map(c=>c.seq)).size!==chunks.length)fail(400,"Invalid archive chunk batch");
      if(!JSON.parse(message.expected_parts).includes(b.part))fail(400,"Unexpected archive part");
      if(b.part!=="body"){
        const file=await this.files.archiveFile(account.id,message.id,b.part);
        await this.files.putChunks(file,chunks);return {};
      }
      await db.prepare("INSERT INTO archive_chunks VALUES "+chunks.map(()=>"(?,?,?,?)").join(",")+" ON CONFLICT(message_id,part,seq) DO UPDATE SET payload=excluded.payload").run(...chunks.flatMap(c=>[message.id,b.part,c.seq,c.payload]));return {};
    }
    if (op === "finish") {
      if (!Array.isArray(b.manifest) || b.manifest.length > 1002 || b.manifest.some(p => !text(p.part,32) || !integer(p.chunks,2147483647)) || new Set(b.manifest.map(p => p.part)).size !== b.manifest.length) fail(400, "Invalid archive manifest");
      const expected=JSON.parse(message.expected_parts);
      if(expected.length!==b.manifest.length || expected.some(p=>!b.manifest.some(v=>v.part===p)))fail(409,"Archive incomplete");
      return db.transaction(async () => {
        const locked = await db.prepare("SELECT * FROM accounts WHERE id=? FOR UPDATE").get(account.id);
        if (!locked.sync_enabled || locked.sync_credential !== b.credential) fail(409, "Sync paused");
        const fresh = await db.prepare("SELECT uid FROM archive_messages WHERE id=? FOR UPDATE").get(message.id);
        if (fresh.uid) return {};
        const chunks = await db.prepare("SELECT part,COUNT(*) n,MIN(seq) first,MAX(seq) last FROM archive_chunks WHERE message_id=? GROUP BY part").all(message.id);
        chunks.push(...await db.prepare("SELECT f.part,COUNT(*) n,MIN(c.seq) first,MAX(c.seq) last FROM mail_files f JOIN mail_file_chunks c ON c.file_id=f.id WHERE f.message_id=? GROUP BY f.part").all(message.id));
        for (const p of b.manifest) {
          const actual = chunks.find(c => c.part === p.part);
          if ((Number(actual?.n) || 0) !== p.chunks || (p.chunks && (actual.first !== 0 || actual.last !== p.chunks - 1))) fail(409, "Archive incomplete");
        }
        if (chunks.some(c => !b.manifest.some(p => p.part === c.part))) fail(409, "Archive incomplete");
        const f = await db.prepare("SELECT next_uid FROM archive_folders WHERE account_id=? AND path=? FOR UPDATE").get(account.id,b.folder);
        if (f.next_uid > 4294967295) fail(507, "Archive UID capacity reached");
        await db.prepare("UPDATE archive_messages SET uid=?,manifest=?,archived_at=? WHERE id=?").run(f.next_uid, JSON.stringify(b.manifest), Date.now(), message.id);
        await db.prepare("UPDATE archive_folders SET next_uid=next_uid+1 WHERE account_id=? AND path=?").run(account.id,b.folder);
        const newMail = (folder.path.toUpperCase()==="INBOX" || folder.special_use==="\\Inbox")
          && folder.arrival_validity===message.source_validity && message.source_uid>folder.arrival_floor;
        const clean=(value,limit)=>Array.from(String(value||"").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g," ").trim()).slice(0,limit).join("");
        const notification=b.notification && typeof b.notification==="object"
          ? {sender:clean(b.notification.sender,120),subject:clean(b.notification.subject,400)} : undefined;
        // The durable push job and publication of the completed message commit together.
        await this.changed(account.id,newMail?"new_mail":"sync",newMail?notification:undefined);
        return {};
      });
    }
    if (!message.uid) fail(404, "Archive incomplete");
    if (op === "message") return { ...message, validity: folder.validity };
    if (op === "chunks") {
      if(!text(b.part,32)||!integer(b.seq,2147483647)||!integer(b.count,8)||b.count<1)fail(400,"Invalid archive chunk range");
      const file=await db.prepare("SELECT id FROM mail_files WHERE message_id=? AND part=?").get(message.id,b.part);
      const rows=file?await this.files.getChunks(file,b.seq,b.count):await db.prepare("SELECT seq,payload FROM archive_chunks WHERE message_id=? AND part=? AND seq>=? AND seq<? ORDER BY seq").all(message.id,b.part,b.seq,b.seq+b.count);
      return {chunks:rows};
    }
    if (op === "chunk") {
      if (!text(b.part,32) || !integer(b.seq,2147483647)) fail(400, "Invalid archive chunk");
      const file=await db.prepare("SELECT id FROM mail_files WHERE message_id=? AND part=?").get(message.id,b.part);
      if(file)return this.files.getChunk(file,b.seq);
      return await db.prepare("SELECT payload FROM archive_chunks WHERE message_id=? AND part=? AND seq=?").get(message.id,b.part,b.seq) || null;
    }
    if (op === "flags") return independentMutation(db,account,message,b);
    fail(400, "Unsupported archive operation");
  }
}

export async function configureSync(db, account, { enabled, credential, pause = false, writebackEnabled, policyOnly = false }) {
  if (writebackEnabled !== undefined && typeof writebackEnabled !== 'boolean') fail(400,'Invalid writeback setting');
  if(policyOnly){
    if(typeof writebackEnabled!=='boolean')fail(400,'Invalid writeback setting');
    return db.transaction(async()=>{
      const fresh=await db.prepare('SELECT * FROM accounts WHERE id=? FOR UPDATE').get(account.id);
      if(!fresh?.sync_enabled||fresh.purge_after)fail(409,'Independent mode is not available');
      await db.prepare('UPDATE accounts SET writeback_enabled=? WHERE id=?').run(writebackEnabled?1:0,account.id);
      if(!writebackEnabled)await db.prepare('DELETE FROM mailbox_writebacks WHERE account_id=?').run(account.id);
      return {updated:true};
    });
  }
  if (typeof enabled !== "boolean" || (enabled && !pause && !encrypted(credential, 30000))) fail(400, "Invalid sync authorization");
  if (account.mode !== "proxy") fail(409, "Sync mode requires a proxy mailbox");
  await db.transaction(async () => {
    const fresh=await db.prepare("SELECT * FROM accounts WHERE id=? FOR UPDATE").get(account.id);
    if(fresh?.purge_after)fail(409,"Mailbox deletion pending");
    if(!fresh || fresh.credential!==account.credential)fail(409,"Credential authorization changed");
    await db.prepare("UPDATE accounts SET sync_enabled=?,sync_credential=?,sync_status=?,sync_updated=? WHERE id=?").run(enabled?1:0,enabled&&!pause?credential:null,enabled?(pause?"paused":"syncing"):"off",Date.now(),account.id);
    if(writebackEnabled!==undefined){
      await db.prepare('UPDATE accounts SET writeback_enabled=? WHERE id=?').run(writebackEnabled?1:0,account.id);
      if(!writebackEnabled)await db.prepare('DELETE FROM mailbox_writebacks WHERE account_id=?').run(account.id);
    }
    if(enabled)await db.prepare("INSERT INTO archive_folders(account_id,path,name,special_use,validity) VALUES(?, 'INBOX', 'INBOX', '\\Inbox', ?) ON CONFLICT(account_id,path) DO NOTHING").run(account.id,(BigInt("0x"+randomBytes(8).toString("hex"))+1n).toString());
  });
  return { updated:true };
}
