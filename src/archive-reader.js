import { rawAttachment } from "./raw-attachment.js";
import { Readable } from "node:stream";
import { syncOptions } from "./reader.js";
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export class ArchiveReader {
  constructor(live, store, crypto, {attachmentCacheBytes=8*1024*1024, attachmentCacheEntryBytes=1024*1024, now=Date.now}={}) {
    Object.assign(this, { live, store, crypto, attachmentCacheBytes, attachmentCacheEntryBytes, now });
    this.attachments=new Map();this.attachmentBytes=0;this.cacheGeneration=0;
  }
  dropAttachment(key) {
    const entry=this.attachments.get(key);
    if(entry){this.attachmentBytes-=entry.bytes;this.attachments.delete(key);}
  }
  attachment(a,o,row,index,signal) {
    // record() has already revalidated the account, folder and message. Cache only
    // ciphertext, scoped by immutable archive identity; never publish partial MIME.
    const key=JSON.stringify([a.id,row.id,index]),aad=`attachment-cache:${a.id}:${row.id}:${index}`;
    for(const [id,entry] of this.attachments)if(entry.expires<=this.now())this.dropAttachment(id);
    const cached=this.attachments.get(key),self=this,generation=this.cacheGeneration;
    if(cached){
      this.attachments.delete(key);this.attachments.set(key,cached);
      return Readable.from((async function*(){
        for(let seq=0;seq<cached.chunks.length;seq++){
          signal?.throwIfAborted();yield self.crypto.open(cached.chunks[seq],`${aad}:${seq}`);
        }
      })());
    }
    return Readable.from((async function*(){
      const source=rawAttachment(self.stream(a,o,row,"raw",signal),Number(index));
      let chunks=[],bytes=0;
      try{
        for await(const value of source){
          signal?.throwIfAborted();
          const buffer=Buffer.isBuffer(value)?value:Buffer.from(value);
          // Cache chunks stay small even when the MIME parser emits a large part.
          for(let offset=0;offset<buffer.length;offset+=65536){
            const chunk=buffer.subarray(offset,offset+65536);
            if(chunks){
              const payload=self.crypto.seal(chunk,`${aad}:${chunks.length}`);
              bytes+=Buffer.byteLength(payload);
              if(bytes>Math.min(self.attachmentCacheBytes,self.attachmentCacheEntryBytes))chunks=null;
              else chunks.push(payload);
            }
            yield chunk;
          }
        }
        signal?.throwIfAborted();
        if(chunks && generation===self.cacheGeneration){
          self.dropAttachment(key);
          while(self.attachments.size && (self.attachmentBytes+bytes>self.attachmentCacheBytes||self.attachments.size>=128))self.dropAttachment(self.attachments.keys().next().value);
          self.attachments.set(key,{account:a.id,chunks,bytes,expires:self.now()+300000});self.attachmentBytes+=bytes;
        }
      }finally{source.destroy();}
    })());
  }
  call(account, op, values = {}) { return this.store.call(op, { accountId: account.id, ...values }); }
  decode(account, row) {
    return JSON.parse(this.crypto.open(row.metadata, "metadata:" + account.id).toString());
  }
  async folders(a, signal) {
    if (!a.sync_enabled) return this.live.folders(a,signal);
    return (await this.call(a,"folders")).map(f => ({ path:f.path,name:f.name,specialUse:f.specialUse }));
  }
  async list(a,o,signal) {
    if (!a.sync_enabled) return this.live.list(a,o,signal);
    const page = await this.call(a,"list",{folder:o.folder,validity:o.validity,before:o.before ?? 4294967296,limit:o.limit + 1});
    const selected = page.rows.slice(0,o.limit);
    return { uidValidity:page.validity,highWater:page.highWater,items:selected.map(r => ({ ...this.decode(a,r).summary,uid:r.uid,flags:JSON.parse(r.flags) })),nextBefore:page.rows.length>o.limit?selected.at(-1).uid:null };
  }
  async sync(a,input,signal) {
    if (!a.sync_enabled) return this.live.sync(a,input,signal);
    const o=syncOptions(input);
    // Checkpoint, bounded incremental window and known flags share one transaction.
    const page=await this.call(a,"sync",{folder:o.folder,validity:o.validity,after:o.after,known:o.known});
    return {uidValidity:page.validity,highWater:page.highWater,hasMore:page.hasMore,items:page.rows.map(r=>({...this.decode(a,r).summary,uid:r.uid,flags:JSON.parse(r.flags)})),existing:page.existing.map(r=>({uid:r.uid,flags:JSON.parse(r.flags)}))};
  }
  async record(a,o,uid) {
    if(!o.validity)fail(400,"UIDVALIDITY required");
    const row=await this.call(a,"message",{folder:o.folder,validity:o.validity,uid});
    return {row,data:this.decode(a,row)};
  }
  stream(a,o,row,part,signal) {
    const count=JSON.parse(row.manifest).find(p=>p.part===part)?.chunks;
    if(count===undefined)fail(404,"Attachment not found");
    const self=this;
    return Readable.from((async function*(){
      for(let seq=0;seq<count;){
        signal?.throwIfAborted();
        const length=Math.min(8,count-seq);
        const value=await self.call(a,"chunks",{folder:o.folder,id:row.id,part,seq,count:length});
        if(value.chunks?.length!==length)fail(500,"Archived content unavailable");
        for(const chunk of value.chunks){
          signal?.throwIfAborted();
          if(chunk.seq!==seq)fail(500,"Archived content unavailable");
          yield self.crypto.open(chunk.payload,`chunk:${a.id}:${row.id}:${part}:${seq}`);
          seq++;
        }
      }
    })());
  }
  async message(a,o,uid,attachment,signal,consume) {
    if(!a.sync_enabled)return this.live.message(a,o,uid,attachment,signal,consume);
    const {row,data}=await this.record(a,o,uid),metadata={...data.metadata,uid,uidValidity:row.validity,flags:JSON.parse(row.flags),deletedAt:row.deleted_at};
    if(attachment===null)return metadata;
    const item=attachment==="body"?metadata.body:metadata.attachments[attachment];
    if(!item)fail(404,"Attachment not found");
    const content=attachment!=="body" && data.rawAttachments
      ? this.attachment(a,o,row,attachment,signal)
      : this.stream(a,o,row,String(attachment),signal);
    try{return await consume({content,filename:item.filename||(item.contentType==="text/html"?"body.html":"body.txt"),contentType:item.contentType});}
    finally{content.destroy();}
  }
  async mutate(a,o,uid,input,signal,authorize=()=>{}) {
    if(!a.sync_enabled)return this.live.mutate(a,o,uid,input,signal,authorize);
    signal?.throwIfAborted();await authorize();
    if(!o.validity)fail(400,"UIDVALIDITY required");
    return this.call(a,"flags",{folder:o.folder,validity:o.validity,uid,action:input.action,destination:input.destination});
  }
  async execute(a,o,operation,signal,timeout) {
    if(!a.sync_enabled)return this.live.execute(a,o,operation,signal,timeout);
    // Reply/forward sources come from the saved RFC822, never the provider's UID.
    const streams=[];
    const source={archive:true,close(){for(const s of streams)s.destroy();},fetchOne:async uid=>{
      const {data}=await this.record(a,o,uid);return {envelope:data.envelope,size:data.summary.size};
    },download:async uid=>{const {row}=await this.record(a,o,uid);const content=this.stream(a,o,row,"raw",signal);streams.push(content);return {content};}};
    try{return await operation(source);}finally{source.close();}
  }
  invalidate(id){this.cacheGeneration++;for(const [key,value] of this.attachments)if(value.account===id)this.dropAttachment(key);this.live.invalidate(id);}
  close(){this.cacheGeneration++;this.attachments.clear();this.attachmentBytes=0;this.live.close();}
}
