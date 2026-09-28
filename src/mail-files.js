import { randomUUID } from 'node:crypto';
import { mkdir,open,readFile,writeFile,unlink,opendir,stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join,dirname } from 'node:path';
const SLOT=65568; // 64 KiB plaintext + AES-GCM IV/tag + a four-byte length.
const uuid=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/i.test(s);
const fail=message=>{throw Error(message);};
// Ciphertext only. One durable file per attachment/original, not one tiny file per chunk.
export class MailFiles {
  constructor(db,root){Object.assign(this,{db,root});this.lastScan=Date.now();}
  async initialize(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const marker=join(this.root,'store-id');
    const row=await this.db.prepare('SELECT identity FROM mail_file_store WHERE id=1').get();
    let identity;try{identity=(await readFile(marker,'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;}
    if(row && row.identity!==identity)fail('Restore the original mail-files volume before starting the server');
    if(!row){
      if(!identity){identity=randomUUID();await writeFile(marker,identity,{flag:'wx',mode:0o600});const f=await open(marker,'r');try{await f.sync();}finally{await f.close();}}
      if(!uuid(identity))fail('Invalid mail-files volume identity');
      const directory=await open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
      await this.db.prepare('INSERT INTO mail_file_store VALUES(1,?)').run(identity);
    }
    this.identity=identity;
  }
  async checkVolume(){if((await readFile(join(this.root,"store-id"),"utf8")).trim()!==this.identity)fail("Mail-files volume changed");}
  path(id){if(!uuid(id))fail('Invalid mail file identity');return join(this.root,id.slice(0,2),id);}
  async write(id,seq,payload){
    return (await this.writeBatch(id,[{seq,payload}]))[0].bytes;
  }
  async writeBatch(id,chunks){
    await this.checkVolume();
    if(!Array.isArray(chunks)||!chunks.length||chunks.length>8)fail('Invalid mail file batch');
    const prepared=chunks.map(({seq,payload})=>{
      if(!Number.isSafeInteger(seq)||seq<0||seq>2147483647)fail('Invalid mail file offset');
      const bytes=Buffer.from(payload,'base64');
      if(bytes.length<28||bytes.length>SLOT-4||bytes.toString('base64')!==payload)fail('Invalid encrypted mail file chunk');
      return {seq,bytes};
    });
    const path=this.path(id),directory=dirname(path);
    await mkdir(directory,{recursive:true,mode:0o700});
    const file=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
    try{
      for(const {seq,bytes} of prepared){
        const buffer=Buffer.alloc(4+bytes.length);buffer.writeUInt32BE(bytes.length);bytes.copy(buffer,4);
        let offset=0;while(offset<buffer.length){const n=await file.write(buffer,offset,buffer.length-offset,seq*SLOT+offset);if(!n.bytesWritten)fail('Incomplete mail file write');offset+=n.bytesWritten;}
      }
      // No chunk references are published until the whole bounded batch is durable.
      await file.sync();
    }finally{await file.close();}
    for(const dir of [directory,this.root]){const handle=await open(dir,'r');try{await handle.sync();}finally{await handle.close();}}
    return prepared.map(({seq,bytes})=>({seq,bytes:bytes.length}));
  }
  async read(id,seq,expected){
    return (await this.readBatch(id,[{seq,bytes:expected}]))[0].payload;
  }
  async readBatch(id,chunks){
    if(!chunks.length)return [];
    const file=await open(this.path(id),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const values=[];
      for(const {seq,bytes:expected} of chunks){
        const buffer=Buffer.alloc(expected+4);let offset=0;
        while(offset<buffer.length){const r=await file.read(buffer,offset,buffer.length-offset,seq*SLOT+offset);if(!r.bytesRead)fail('Incomplete saved mail file');offset+=r.bytesRead;}
        if(buffer.readUInt32BE(0)!==expected)fail('Saved mail file length mismatch');
        values.push({seq,payload:buffer.subarray(4).toString('base64')});
      }
      return values;
    }finally{await file.close();}
  }
  async putChunk(file,seq,payload){
    const size=await this.write(file.id,seq,payload);
    await this.db.prepare('INSERT INTO mail_file_chunks VALUES(?,?,?) ON CONFLICT(file_id,seq) DO UPDATE SET bytes=excluded.bytes').run(file.id,seq,size);
  }
  async putChunks(file,chunks){
    const rows=await this.writeBatch(file.id,chunks);
    await this.db.prepare('INSERT INTO mail_file_chunks(file_id,seq,bytes) VALUES '+rows.map(()=>'(?,?,?)').join(',')+' ON CONFLICT(file_id,seq) DO UPDATE SET bytes=excluded.bytes').run(...rows.flatMap(r=>[file.id,r.seq,r.bytes]));
  }
  async getChunk(file,seq){
    const rows=await this.getChunks(file,seq,1);
    return rows.length?{payload:rows[0].payload}:null;
  }
  async getChunks(file,seq,count){
    const rows=await this.db.prepare('SELECT seq,bytes FROM mail_file_chunks WHERE file_id=? AND seq>=? AND seq<? ORDER BY seq').all(file.id,seq,seq+count);
    return this.readBatch(file.id,rows);
  }
  async archiveFile(accountId,messageId,part){
    let row=await this.db.prepare('SELECT id FROM mail_files WHERE message_id=? AND part=?').get(messageId,part);
    if(!row){row={id:randomUUID()};await this.db.prepare('INSERT INTO mail_files(id,account_id,message_id,part,created) VALUES(?,?,?,?,?)').run(row.id,accountId,messageId,part,Date.now());}
    return row;
  }
  async migrateArchive(){
    // One part per pass. A crash leaves the original database chunks intact.
    const next=await this.db.prepare("SELECT m.account_id,c.message_id,c.part FROM archive_chunks c JOIN archive_messages m ON m.id=c.message_id JOIN accounts a ON a.id=m.account_id WHERE c.part<>'body' AND a.purge_after IS NULL LIMIT 1").get();
    if(!next)return;
    await this.db.transaction(async()=>{
      const a=await this.db.prepare('SELECT purge_after FROM accounts WHERE id=? FOR UPDATE').get(next.account_id);
      if(!a||a.purge_after)return;
      let after=-1;
      const file=await this.archiveFile(next.account_id,next.message_id,next.part);
      for(;;){
        const chunks=await this.db.prepare('SELECT seq,payload FROM archive_chunks WHERE message_id=? AND part=? AND seq>? ORDER BY seq LIMIT 64').all(next.message_id,next.part,after);
        if(!chunks.length)break;
        for(const c of chunks){await this.putChunk(file,c.seq,c.payload);if((await this.getChunk(file,c.seq)).payload!==c.payload)fail('Mail file migration verification failed');after=c.seq;}
      }
      await this.db.prepare('DELETE FROM archive_chunks WHERE message_id=? AND part=?').run(next.message_id,next.part);
    });
  }
  async collect(){
    await this.checkVolume();
    const rows=await this.db.prepare('SELECT id FROM mail_file_deletions LIMIT 500').all();
    for(const row of rows){
      try{await unlink(this.path(row.id));}catch(e){if(e.code!=='ENOENT')throw e;}
      const dir=await open(dirname(this.path(row.id)),'r').catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(dir)try{await dir.sync();}finally{await dir.close();}
      await this.db.prepare('DELETE FROM mail_file_deletions WHERE id=?').run(row.id);
    }
    // Rolled-back uploads have no DB reference. Collect only aged orphan files.
    if(Date.now()-this.lastScan<86400000)return;
    this.lastScan=Date.now();
    for await(const shard of await opendir(this.root)){
      if(!shard.isDirectory()||!/^[a-f0-9]{2}$/i.test(shard.name))continue;
      for await(const entry of await opendir(join(this.root,shard.name))){
        if(!entry.isFile()||!uuid(entry.name))continue;
        const path=this.path(entry.name),info=await stat(path);
        if(Date.now()-info.mtimeMs<86400000)continue;
        if(!await this.db.prepare('SELECT id FROM mail_files WHERE id=?').get(entry.name))await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
    }
  }
}
