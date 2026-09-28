import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { createTestApp, clientCredential } from "./helpers.mjs";
import { ArchiveStore } from "../src/archive-store.js";
import { createMailWorker } from "../src/mail-worker.js";
import { credentialAAD } from "../src/credential-leases.js";
const body=Buffer.from('永久保存的完整正文'),attachment=Buffer.alloc(180000,137);
const raw=Buffer.from('From: sender@example.test\r\nMessage-ID: <fixture@example.test>\r\nSubject: saved\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+body.toString('base64')+'\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="saved.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n'+attachment.toString('base64')+'\r\n--fixture--\r\n');
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"mohua-sync-test-")),brokerToken=randomBytes(32).toString("hex");
 const control=await createTestApp({dataDir:dir,brokerToken});
 await new Promise(r=>control.server.listen(0,"127.0.0.1",r));
 const controlUrl=`http://127.0.0.1:${control.server.address().port}`;
 const user=randomUUID();await control.db.prepare("INSERT INTO users VALUES(?,?,?,'user',1)").run(user,user+"@example.test","unused");
 let device=await control.devices.enroll(user,{name:"Phone",platform:"ios"});
 const state={deleted:false,broken:false,uids:[1],validity:1n,downloads:0};
 class Client extends EventEmitter{
  capabilities=new Set(['MOVE','UIDPLUS']);
  async messageFlagsAdd(uid,flags){state.flagWrites=(state.flagWrites||0)+1;return true;}
  async messageFlagsRemove(uid,flags){state.flagWrites=(state.flagWrites||0)+1;return true;}
  async messageMove(uid,destination){
   state.moves=(state.moves||0)+1;state.uids=state.uids.filter(x=>x!==uid);
   return {uidValidity:state.validity,uidMap:new Map([[uid,uid+100]])};
  }
  async connect(){if(state.deleted)throw Error("Provider account removed");} close(){this.emit("close");} async logout(){this.close();}
  async list(){return [{path:"INBOX",name:"Inbox",flags:new Set(),specialUse:"\\Inbox"}];}
  async mailboxOpen(){return {exists:state.uids.length,uidValidity:state.validity,uidNext:Math.max(...state.uids,0)+1};}
  async fetchAll(range){const [lo,hi]=range.split(":").map(Number);return state.uids.filter(n=>n>=lo&&n<=(hi??lo)).map(uid=>({uid,envelope:{subject:"saved",date:new Date(1700000000000+uid*1000),from:[{address:"sender@example.test"}]},flags:new Set(),size:raw.length}));}
  async fetchOne(uid){if(!state.uids.includes(uid))return false;return {uid,size:(state.raw||raw).length,envelope:{subject:"saved",messageId:"<fixture@example.test>",from:[{address:"sender@example.test"}],date:new Date(1700000000000+uid*1000)},flags:new Set(),bodyStructure:{type:"multipart/mixed",childNodes:[{part:"1",type:"text/plain",size:body.length},{part:"2",type:"application/octet-stream",size:attachment.length,disposition:"attachment",dispositionParameters:{filename:"saved.bin"}}]}};}
  async download(uid,part){state.downloads++;if(part===undefined&&state.broken)return {content:Readable.from((async function*(){yield attachment.subarray(0,50);throw Error("interrupted");})())};return {content:Readable.from([part===undefined?(state.raw||raw):part==="1"?body:attachment])};}
 }
 const mailOptions={resolveHost:async()=>"1.1.1.1",imapFactory:()=>new Client()};
 const keyPath=join(dir,"worker-key");
 let worker,workerUrl;
 async function start(){worker=await createMailWorker({brokerUrl:controlUrl+"/internal/mail",brokerToken,mailOptions,pollMs:60000,archiveKeyPath:keyPath});await new Promise(r=>worker.server.listen(0,"127.0.0.1",r));workerUrl=`http://127.0.0.1:${worker.server.address().port}`;}
 await start();
 const call=async(path,method="GET",payload,controlRoute=false,token=device.token)=>fetch((controlRoute?controlUrl:workerUrl)+path,{method,headers:{Authorization:"Bearer "+token,...(payload!==undefined?{"Content-Type":"application/json"}:{})},body:payload===undefined?undefined:JSON.stringify(payload)});
 const cred=clientCredential(),id=cred.id,path="/api/accounts/"+id;
 assert.equal((await call("/api/accounts","POST",{...cred,email:"mail@example.test",mode:"proxy",imapHost:"imap.example.test",smtpHost:"smtp.example.test"},true)).status,201);
 await control.db.prepare("UPDATE accounts SET monitor_enabled=0 WHERE id=?").run(id);
 await worker.inventory();
 const info=await (await call(path+"/credential")).json();
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);c.setAAD(Buffer.from(credentialAAD(id,cred.envelope.revision)));
 const ciphertext=Buffer.concat([iv,c.update("synthetic-password"),c.final(),c.getAuthTag()]).toString("base64");
 assert.equal((await call(path+"/credential","POST",{challenge:info.challenge,revision:cred.envelope.revision,key:key.toString("base64"),ciphertext,expiresAt:Date.now()+86400000})).status,200);
 async function drain(){await Promise.all([...worker.sync.running.values()].map(j=>j.promise));}
 return {control,id,path,user,state,call,drain,keyPath,get worker(){return worker;},get device(){return device;},enable:async()=>{const r=await call(path+"/sync-mode","POST",{enabled:true});assert.equal(r.status,200,await r.text());await drain();},scan:async()=>{const a=await control.db.prepare("SELECT * FROM accounts WHERE id=?").get(id);await worker.sync.run(a,new AbortController().signal);},restart:async()=>{await worker.close();await start();await drain();},reenroll:async()=>{device=await control.devices.enroll(user,{name:"Other phone",platform:"ios"});},close:async()=>{await worker.close();await control.close();await rm(dir,{recursive:true,force:true});}};
}
test("sync saves complete body, binary attachment and RFC822; survives provider deletion, session expiry, device revocation and worker restart",async()=>{
 const f=await fixture();try{
  await f.enable();
  const status=await(await f.call(f.path+"/sync-mode")).json();assert.equal(status.messages,1);assert.equal(status.authorized,true);
  const page=await(await f.call(f.path+"/messages")).json();assert.equal(page.items.length,1);const uid=page.items[0].uid,q=`?uidValidity=${page.uidValidity}`;
  const stored=await f.control.db.prepare("SELECT sync_credential FROM accounts WHERE id=?").get(f.id);assert.ok(!stored.sync_credential.includes("synthetic-password"));
  const chunks=await f.control.db.prepare("SELECT payload FROM archive_chunks").all();assert.equal(chunks.length,1);assert.equal(Number((await f.control.db.prepare("SELECT COUNT(*) n FROM mail_files").get()).n),1);assert.ok(!JSON.stringify(chunks).includes(body.toString()));
  const before=f.state.downloads;await f.scan();assert.equal(f.state.downloads,before,"completed mail must not be downloaded again");
  f.state.deleted=true;f.state.uids=[];
  await f.control.db.prepare("UPDATE sessions SET expires=0 WHERE id IN (SELECT session_id FROM device_sessions WHERE device_id=?)").run(f.device.deviceId);
  assert.equal((await f.call(f.path+"/messages")).status,401);
  await f.control.devices.revoke(f.user,f.device.deviceId);await f.worker.inventory();
  assert.ok(f.worker.leases.entries.get(f.id)?.persistent,"phone revocation must not revoke independent sync grant");
  await f.reenroll();await f.restart();
  let r=await f.call(`${f.path}/messages/${uid}/body${q}`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),body);
  r=await f.call(`${f.path}/messages/${uid}/attachments/0${q}`);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),attachment);
  const a=await f.control.db.prepare("SELECT * FROM accounts WHERE id=?").get(f.id);
  await f.worker.reader.execute(a,{folder:"INBOX",validity:page.uidValidity},async client=>{
    assert.equal((await client.fetchOne(uid)).envelope.messageId,"<fixture@example.test>");
    const dl=await client.download(uid);const buffers=[];for await(const b of dl.content)buffers.push(b);assert.deepEqual(Buffer.concat(buffers),raw);
  });
  assert.equal((await f.call(f.path,"DELETE",undefined,true)).status,400,"configuration deletion must not cascade into permanent mail");
  assert.equal((await f.call(f.path+"/sync-mode","DELETE")).status,200);
  await f.worker.inventory();assert.equal(f.worker.leases.entries.has(f.id),false);
  assert.equal((await f.call(`${f.path}/messages/${uid}/body${q}`)).status,200,"pausing must preserve reading");
  const replacement=clientCredential("changed-password",f.id);
  assert.equal((await f.call(f.path,"PATCH",{envelope:replacement.envelope},true)).status,200);
  assert.equal((await(await f.call(f.path+"/sync-mode")).json()).state,"paused","updating a password must not resume an explicitly paused archive");
 }finally{await f.close();}
});
test("interrupted attachment stays invisible and retry commits once; UIDVALIDITY reuse preserves both originals",async()=>{
 const f=await fixture();try{
  f.state.broken=true;await f.enable();
  let page=await(await f.call(f.path+"/messages")).json();assert.equal(page.items.length,0);
  assert.equal((await(await f.call(f.path+"/sync-mode")).json()).state,"error");
  f.state.broken=false;await f.scan();
  page=await(await f.call(f.path+"/messages")).json();assert.equal(page.items.length,1);
  f.state.validity=2n;await f.scan();
  const next=await(await f.call(f.path+"/messages")).json();assert.equal(next.uidValidity,page.uidValidity);assert.equal(next.items.length,2);assert.notEqual(next.items[0].uid,next.items[1].uid);
  const delta=await(await f.call(f.path+"/sync","POST",{folder:"INBOX",uidValidity:page.uidValidity,after:page.highWater,known:[page.items[0].uid]})).json();assert.equal(delta.items.length,1);assert.equal(delta.existing.length,1);
  const q=`?uidValidity=${page.uidValidity}`;
  assert.equal((await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}`,"POST",{action:"read"})).status,200);
  assert.equal((await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}`,"POST",{action:"trash"})).status,200);
  const stranger=randomUUID();await f.control.db.prepare("INSERT INTO users VALUES(?,?,?,'user',1)").run(stranger,stranger+"@example.test","unused");const device=await f.control.devices.enroll(stranger,{name:"Stranger",platform:"ios"});
  assert.equal((await f.call(f.path+"/messages","GET",undefined,false,device.token)).status,404);
 }finally{await f.close();}
});
test("history resumes across sparse pages, new mail is scheduled automatically, date pagination and mode switches retain archives",async()=>{
 const f=await fixture();try{
  f.state.uids=[1,202,403,604,805,1006,1207,1408,1609];
  await f.enable();
  let status=await(await f.call(f.path+"/sync-mode")).json();assert.equal(status.state,"backfill");assert.ok(status.messages<9);
  await f.scan();status=await(await f.call(f.path+"/sync-mode")).json();assert.equal(status.messages,9);
  f.state.uids.push(1800);f.worker.sync.last.clear();await f.worker.inventory();await f.drain();
  status=await(await f.call(f.path+"/sync-mode")).json();assert.equal(status.messages,10);
  let before=null,validity=null;const all=[];
  do{
    const q=new URLSearchParams({limit:"3"});if(before!==null){q.set("before",before);q.set("uidValidity",validity);}
    const r=await f.call(f.path+"/messages?"+q);assert.equal(r.status,200);const p=await r.json();all.push(...p.items);before=p.nextBefore;validity=p.uidValidity;
  }while(before!==null);
  assert.equal(new Set(all.map(m=>m.uid)).size,10);assert.deepEqual(all.map(m=>m.date),all.map(m=>m.date).sort().reverse());
  assert.equal((await f.call(f.path+"/sync-mode","POST",{enabled:false})).status,200);
  f.state.deleted=true;await f.restart();
  // No active lease is required to reopen a saved archive on another device.
  assert.equal((await f.call(f.path+"/sync-mode","POST",{enabled:true})).status,200);
  status=await(await f.call(f.path+"/sync-mode")).json();assert.equal(status.state,"paused");assert.equal(status.messages,10);
  const p=await(await f.call(f.path+"/messages")).json();assert.equal(p.uidValidity,validity);assert.equal(p.items.length,10);
 }finally{await f.close();}
});
test("unbinding an empty or incomplete mailbox also enters the recovery period",async()=>{
 const f=await fixture();try{
  f.state.broken=true;await f.enable();
  assert.equal((await(await f.call(f.path+"/sync-mode")).json()).messages,0);
  assert.equal((await f.call(f.path+"/sync-mode","POST",{enabled:false})).status,200);
  assert.equal((await f.call(f.path,"DELETE",{email:"mail@example.test"},true)).status,200);
  const pending=await f.control.db.prepare("SELECT credential,sync_credential,purge_after FROM accounts WHERE id=?").get(f.id);assert.equal(pending.credential,null);assert.equal(pending.sync_credential,null);
  f.control.storage.now=()=>pending.purge_after;await f.control.storage.sweep();assert.equal((await f.control.db.prepare("SELECT COUNT(*) n FROM archive_chunks").get()).n,0);
 }finally{await f.close();}
});

test('remote storage deletion is explicit, recoverable for 30 days, restart durable and purges every mailbox table',async()=>{
 const f=await fixture();try{
  await f.enable();
  const route=f.path+'/remote-storage';
  assert.equal((await f.call(route,'POST',{action:'delete',email:'wrong'},true)).status,400);
  let now=Date.now();f.control.storage.now=()=>now;
  const initial=await(await f.call(route,'GET',undefined,true)).json();assert.equal(initial.messages,1);assert.equal(initial.purgeAfter,null);
  assert.equal((await f.call(route,'POST',{action:'delete',email:'mail@example.test'},true)).status,200);
  const status=await(await f.call(route,'GET',undefined,true)).json();assert.equal(status.purgeAfter,now+30*86400000);
  await f.worker.inventory();assert.equal(f.worker.leases.entries.has(f.id),false);
  assert.equal((await f.call(f.path+'/messages')).status,409);
  assert.equal((await f.call(f.path+'/sync-mode','POST',{enabled:true})).status,409);
  assert.equal((await f.call(f.path,'PATCH',{email:'new@example.test'},true)).status,409);
  now+=29*86400000;await f.control.storage.sweep();assert.ok(await f.control.db.prepare('SELECT id FROM accounts WHERE id=?').get(f.id));
  assert.equal((await f.call(route,'POST',{action:'delete',email:'mail@example.test'},true)).status,200);
  assert.equal((await(await f.call(route,'GET',undefined,true)).json()).purgeAfter,status.purgeAfter,'retries do not extend grace period');
  assert.equal((await f.call(route,'POST',{action:'restore'},true)).status,200);
  assert.equal((await(await f.call(f.path+'/sync-mode')).json()).state,'paused');
  assert.equal((await f.call(f.path+'/messages')).status,200);
  assert.equal((await f.call(route,'POST',{action:'delete',email:'mail@example.test'},true)).status,200);
  await f.restart();assert.equal((await f.call(f.path+'/messages')).status,409);
  now+=30*86400000;
  assert.equal((await f.call(route,'POST',{action:'restore'},true)).status,409);
  await f.control.storage.sweep();
  for(const table of ['accounts','archive_folders','archive_messages','archive_chunks','remote_drafts','remote_draft_versions','remote_draft_chunks','outbox','device_mailboxes','mailbox_revisions','mail_files','mail_file_chunks','mail_file_deletions'])assert.equal(Number((await f.control.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n),0,table);
  await f.control.storage.sweep(); // idempotent
 }finally{await f.close();}
});

test('encrypted remote drafts preserve attachments, retry atomically, reject stale updates and respect mailbox deletion',async()=>{
 const f=await fixture();try{
  await f.enable();const id=randomUUID(),fileId=randomUUID(),revision=randomUUID();
  const draft={id,accountID:f.id,to:'',cc:'',bcc:'',subject:'private draft',text:'unfinished text',sentCopy:'provider',attachments:[{id:fileId,filename:'a.bin',size:attachment.length}],updated:0};
  const snapshot={draft,files:[{id:fileId,data:attachment.toString('base64')}],revision,baseRevision:null};
  const path=f.path+'/drafts/'+id;
  let response=await f.call(path,'POST',snapshot);assert.equal(response.status,200,await response.text());
  assert.equal((await f.call(path,'POST',snapshot)).status,200,'same revision retry');
  const chunks=await f.control.db.prepare('SELECT payload FROM remote_draft_chunks').all();assert.equal(chunks.length,1);assert.ok(Number((await f.control.db.prepare("SELECT COUNT(*) n FROM mail_file_chunks").get()).n)>3);assert.ok(!JSON.stringify(chunks).includes('private draft'));
  await f.restart();const saved=await(await f.call(path)).json();assert.deepEqual(saved.draft,draft);assert.equal(saved.files[0].data,snapshot.files[0].data);
  const next={...snapshot,revision:randomUUID(),baseRevision:revision,draft:{...draft,text:'updated'}};
  assert.equal((await f.call(path,'POST',next)).status,200);
  assert.equal((await f.call(path,'POST',{...snapshot,revision:randomUUID()})).status,409,'old device cannot overwrite newer version');
  assert.equal((await f.call(path,'DELETE',{baseRevision:revision})).status,409);
  assert.equal((await f.call(path,'POST',{...next,revision:randomUUID(),baseRevision:next.revision,files:[]})).status,400);
  assert.equal((await f.call(path,'DELETE',{baseRevision:next.revision})).status,200);
  assert.equal((await f.call(path)).status,404);
  assert.ok((await(await f.call(f.path+'/drafts')).json())[0].deletedAt);
  assert.equal((await f.call(path,'POST',next)).status,409,'deleted draft cannot be resurrected');
  const now=Date.now();f.control.storage.now=()=>now+31*86400000;await f.control.storage.sweep();
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM remote_draft_chunks').get()).n),0);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM remote_drafts').get()).n),1,'tombstone retained');
  await f.call(f.path+'/remote-storage','POST',{action:'delete',email:'mail@example.test'},true);
  assert.equal((await f.call(path,'POST',next)).status,409);
  f.control.storage.now=()=>now+62*86400000;await f.control.storage.sweep();
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM remote_drafts').get()).n),0);
 }finally{await f.close();}
});

test('sent draft waits for an archived original; unfinished draft upload never replaces the current snapshot',async()=>{
 const f=await fixture();try{
  await f.enable();const id=randomUUID(),revision=randomUUID(),sendId=randomUUID();
  await f.control.db.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,'sent',?,?)").run(sendId,f.user,f.id,randomUUID(),'digest',JSON.stringify({messageId:'<fixture@example.test>',sentCopy:'provider'}),Date.now());
  const draft={id,accountID:f.id,to:'',cc:'',bcc:'',subject:'draft',text:'retain until original archived',sentCopy:'provider',attachments:[],updated:0,attempt:{status:{id:sendId,state:'sent',sentCopy:'provider'}}};
  const path=f.path+'/drafts/'+id;
  // Remove the message-identity proof while retaining the original fixture data.
  await f.control.db.prepare('UPDATE archive_messages SET message_hash=NULL').run();
  assert.equal((await f.call(path,'POST',{draft,files:[],revision,baseRevision:null})).status,200);
  await f.control.storage.sweep();assert.equal((await f.call(path)).status,200);
  const values={accountId:f.id,id,revision:randomUUID(),baseRevision:revision,chunks:2,files:[]};
  await f.worker.db.call('archive',{operation:'draftBegin',values});
  const incomplete=await f.worker.db.call('archive',{operation:'draftFinish',values}).then(()=>null,e=>e);assert.equal(incomplete.status,409);
  assert.equal((await(await f.call(path)).json()).revision,revision);
  const {createHash}=await import('node:crypto');
  await f.control.db.prepare('UPDATE archive_messages SET message_hash=?').run(createHash('sha256').update('<fixture@example.test>').digest('hex'));
  await f.control.storage.sweep();assert.equal((await f.call(path)).status,404,'only archived originals permit sent draft cleanup');
 }finally{await f.close();}
});

test('unbind immediately erases both credential forms and old grants cannot return after restore/restart',async()=>{
 const f=await fixture();try{
  await f.enable();
  const old=await f.control.db.prepare('SELECT credential,sync_credential FROM accounts WHERE id=?').get(f.id);
  assert.ok(old.credential);assert.ok(old.sync_credential);
  const challenged=await(await f.call(f.path+'/credential')).json();
  assert.equal((await f.call(f.path,'DELETE',{email:'mail@example.test'},true)).status,200);
  const a=await f.control.db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id);
  assert.equal(a.credential,null);assert.equal(a.sync_credential,null);assert.equal(a.monitor_enabled,0);
  await f.worker.inventory();assert.equal(f.worker.leases.entries.has(f.id),false);
  assert.equal((await f.call(f.path+'/remote-storage','POST',{action:'restore'},true)).status,200);
  await f.restart();const restored=await(await f.call(f.path+'/credential')).json();
  assert.equal(restored.envelope,null);assert.equal(restored.authorization.state,'locked');
  assert.equal((await f.call(f.path+'/credential','POST',{challenge:challenged.challenge,revision:challenged.envelope.revision})).status,409);
  assert.equal((await f.call(f.path+'/messages')).status,200,'saved mail does not require provider keys');
  const rebound=clientCredential('new-provider-password',f.id);
  assert.equal((await f.call(f.path,'PATCH',{envelope:rebound.envelope},true)).status,200);
  assert.equal((await(await f.call(f.path+'/credential')).json()).envelope.revision,rebound.envelope.revision);
 }finally{await f.close();}
});

test('legacy originals migrate with verification; failed migration retains DB source and orphan files are collected',async()=>{
 const f=await fixture();try{
  await f.enable();const files=f.control.files,db=f.control.db;
  const file=await db.prepare("SELECT * FROM mail_files WHERE part='raw'").get();
  const chunks=await db.prepare('SELECT seq FROM mail_file_chunks WHERE file_id=? ORDER BY seq').all(file.id);
  for(const c of chunks)await db.prepare('INSERT INTO archive_chunks VALUES(?,?,?,?)').run(file.message_id,'raw',c.seq,(await files.getChunk(file,c.seq)).payload);
  await db.prepare('DELETE FROM mail_files WHERE id=?').run(file.id);await files.collect();
  const write=files.write.bind(files);let orphan;
  files.write=async(...args)=>{orphan=args[0];await write(...args);throw Error('simulated interrupted migration');};
  await assert.rejects(files.migrateArchive(),/interrupted/);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) n FROM archive_chunks WHERE part='raw'").get()).n),chunks.length);
  files.write=write;await files.migrateArchive();
  assert.equal(Number((await db.prepare("SELECT COUNT(*) n FROM archive_chunks WHERE part='raw'").get()).n),0);
  const page=await(await f.call(f.path+'/messages')).json();const a=await db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id);
  await f.worker.reader.execute(a,{folder:'INBOX',validity:page.uidValidity},async client=>{
    const dl=await client.download(page.items[0].uid),parts=[];for await(const p of dl.content)parts.push(p);assert.deepEqual(Buffer.concat(parts),raw);
  });
  const {utimes,stat}=await import('node:fs/promises');await utimes(files.path(orphan),new Date(0),new Date(0));files.lastScan=0;await files.collect();await assert.rejects(stat(files.path(orphan)),{code:'ENOENT'});
  const {MailFiles}=await import('../src/mail-files.js');
  await assert.rejects(new MailFiles(db,files.root+'-missing').initialize(),/Restore the original/);
 }finally{await f.close();}
});

test('legacy draft binary payload moves out of PostgreSQL without requiring provider authorization',async()=>{
 const f=await fixture();try{
  await f.enable();await f.call(f.path+'/sync-mode','DELETE');
  const {ArchiveCrypto}=await import('../src/archive-crypto.js'),crypto=new ArchiveCrypto(f.keyPath);
  const id=randomUUID(),revision=randomUUID(),fileId=randomUUID();
  const draft={id,accountID:f.id,to:'',cc:'',bcc:'',subject:'legacy draft',text:'saved body',sentCopy:'provider',updated:0,attachments:[{id:fileId,filename:'legacy.bin',size:attachment.length}]};
  const data=Buffer.from(JSON.stringify({draft,files:[{id:fileId,data:attachment.toString('base64')}]}));
  const db=f.control.db;await db.prepare('INSERT INTO remote_drafts(account_id,id,revision,updated) VALUES(?,?,?,?)').run(f.id,id,revision,Date.now());
  await db.prepare('INSERT INTO remote_draft_versions(account_id,draft_id,revision,chunks,created) VALUES(?,?,?,?,?)').run(f.id,id,revision,Math.ceil(data.length/65536),Date.now());
  for(let seq=0,offset=0;offset<data.length;offset+=65536,seq++)await db.prepare('INSERT INTO remote_draft_chunks VALUES(?,?,?,?,?)').run(f.id,id,revision,seq,crypto.seal(data.subarray(offset,offset+65536),`draft:${f.id}:${id}:${revision}:${seq}`));
  await f.worker.remoteDrafts.migrating;f.worker.remoteDrafts.lastMigration=0;
  f.worker.remoteDrafts.scheduleMigration([await db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id)]);await f.worker.remoteDrafts.migrating;
  const saved=await(await f.call(f.path+'/drafts/'+id)).json();assert.deepEqual(saved.draft,draft);assert.equal(saved.files[0].data,attachment.toString('base64'));
  assert.notEqual(saved.revision,revision);
  assert.equal(Number((await db.prepare('SELECT COUNT(*) n FROM remote_draft_chunks WHERE draft_id=?').get(id)).n),1,'only encrypted draft text/metadata remains in DB');
  assert.equal((await db.prepare('SELECT storage_version FROM remote_draft_versions WHERE draft_id=?').get(id)).storage_version,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM mail_files WHERE draft_id=?').get(id)).n,1);
 }finally{await f.close();}
});

test('file deletion failure keeps the expired mailbox pending until a later cleanup succeeds',async()=>{
 const f=await fixture();try{
  await f.enable();await f.call(f.path,'DELETE',{email:'mail@example.test'},true);
  const a=await f.control.db.prepare('SELECT purge_after FROM accounts WHERE id=?').get(f.id);f.control.storage.now=()=>a.purge_after;
  const collect=f.control.files.collect.bind(f.control.files);f.control.files.collect=async()=>{throw Error('disk unavailable');};
  await assert.rejects(f.control.storage.sweep(),/disk unavailable/);
  assert.ok(await f.control.db.prepare('SELECT id FROM accounts WHERE id=?').get(f.id));
  assert.ok(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mail_file_deletions').get()).n)>0);
  f.control.files.collect=collect;await f.control.storage.sweep();
  assert.equal(await f.control.db.prepare('SELECT id FROM accounts WHERE id=?').get(f.id),undefined);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mail_file_deletions').get()).n),0);
 }finally{await f.close();}
});


test('immediate permanent deletion requires pending deletion and email confirmation, then removes stored mail and files',async()=>{
 const f=await fixture();try{
  await f.enable();const route=f.path+'/remote-storage';
  assert.equal((await f.call(route,'POST',{action:'purge',email:'mail@example.test'},true)).status,409);
  assert.equal((await f.call(route,'POST',{action:'delete',email:'mail@example.test'},true)).status,200);
  assert.equal((await f.call(route,'POST',{action:'purge',email:'wrong'},true)).status,400);
  assert.ok((await f.control.db.prepare('SELECT purge_after FROM accounts WHERE id=?').get(f.id)).purge_after>Date.now());
  assert.equal((await f.call(route,'POST',{action:'purge',email:'mail@example.test'},true)).status,200);
  for(const table of ['accounts','archive_messages','archive_chunks','mail_files','mail_file_chunks','mail_file_deletions'])assert.equal(Number((await f.control.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).n),0,table);
  assert.equal((await f.call(route,'POST',{action:'restore'},true)).status,404);
 }finally{await f.close();}
});

test('immediate deletion cannot be restored when file cleanup fails and maintenance retries',async()=>{
 const f=await fixture();try{
  await f.enable();const route=f.path+'/remote-storage';
  await f.call(route,'POST',{action:'delete',email:'mail@example.test'},true);
  const files=f.control.storage.files, collect=files.collect;
  files.collect=async()=>{throw Error('simulated storage outage');};
  try {
   assert.equal((await f.call(route,'POST',{action:'purge',email:'mail@example.test'},true)).status,200);
   assert.equal((await f.call(route,'POST',{action:'restore'},true)).status,409);
   assert.ok(await f.control.db.prepare('SELECT id FROM accounts WHERE id=?').get(f.id));
  }finally{files.collect=collect;}
  await f.control.storage.sweep();
  assert.equal(await f.control.db.prepare('SELECT id FROM accounts WHERE id=?').get(f.id),undefined);
 }finally{await f.close();}
});


test('archive alerts start after baseline, wait for complete attachments, and do not repeat on scans or restart',async()=>{
 const f=await fixture();try{
  const events=[];const changed=f.control.devices.changed.bind(f.control.devices);
  f.control.devices.changed=async(id,kind,notification)=>{events.push({kind,notification});return changed(id,kind,notification);};
  await f.enable();assert.equal(events.filter(e=>e.kind==='new_mail').length,0);
  f.state.uids=[1,2];f.state.broken=true;await f.scan();
  assert.equal(events.filter(e=>e.kind==='new_mail').length,0);
  f.state.broken=false;await f.scan();
  assert.equal(events.filter(e=>e.kind==='new_mail').length,1);
  assert.equal(events.find(e=>e.kind==='new_mail').notification.subject,'saved');
  await f.scan();await f.restart();await f.scan();
  assert.equal(events.filter(e=>e.kind==='new_mail').length,1);
  f.state.validity=2n;await f.scan();
  assert.equal(events.filter(e=>e.kind==='new_mail').length,1,'validity reset must not re-alert historical mail');
 }finally{await f.close();}
});

test('archive publication rolls back if durable notification enqueue fails',async()=>{
 const f=await fixture();try{
  await f.enable();f.state.uids=[1,2];
  const changed=f.control.devices.changed.bind(f.control.devices);
  f.control.devices.changed=async(id,kind,notification)=>{if(kind==='new_mail')throw Error('simulated enqueue failure');return changed(id,kind,notification);};
  await f.scan();
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM archive_messages WHERE uid IS NOT NULL').get()).n),1);
  f.control.devices.changed=changed;await f.scan();
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM archive_messages WHERE uid IS NOT NULL').get()).n),2);
 }finally{await f.close();}
});


test('independent moves and trash preserve source identity; permanent deletion cannot reimport the original',async()=>{
 const f=await fixture();try{
  await f.enable();await f.call(f.path+'/sync-mode','POST',{writebackEnabled:false});
  let page=await(await f.call(f.path+'/messages')).json();const uid=page.items[0].uid;
  assert.equal((await f.call(`${f.path}/messages/${uid}/actions?uidValidity=${page.uidValidity}`,'POST',{action:'trash'})).status,200);
  await f.scan();assert.equal((await(await f.call(f.path+'/messages')).json()).items.length,0);
  let folders=await(await f.call(f.path+'/folders')).json();let trash=folders.find(x=>x.specialUse==='\\Trash');assert.ok(trash);
  let q='?folder='+encodeURIComponent(trash.path);page=await(await f.call(f.path+'/messages'+q)).json();assert.equal(page.items.length,1);
  const detail=await(await f.call(`${f.path}/messages/${page.items[0].uid}${q}&uidValidity=${page.uidValidity}`)).json();assert.ok(detail.deletedAt);
  assert.equal((await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}&uidValidity=${page.uidValidity}`,'POST',{action:'move',destination:'INBOX'})).status,200);
  page=await(await f.call(f.path+'/messages')).json();assert.equal(page.items.length,1);
  assert.equal((await f.call(`${f.path}/messages/${page.items[0].uid}/actions?uidValidity=${page.uidValidity}`,'POST',{action:'trash'})).status,200);
  page=await(await f.call(f.path+'/messages'+q)).json();
  assert.equal((await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}&uidValidity=${page.uidValidity}`,'POST',{action:'purge'})).status,200);
  await f.scan();assert.equal((await(await f.call(f.path+'/messages')).json()).items.length,0);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_source_links WHERE message_id IS NULL').get()).n),1);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_writebacks').get()).n),0);
 }finally{await f.close();}
});

test('writeback defaults on, stores only future operations and disabling cancels pending work',async()=>{
 const f=await fixture();try{
  await f.enable();const page=await(await f.call(f.path+'/messages')).json();const action=`${f.path}/messages/${page.items[0].uid}/actions?uidValidity=${page.uidValidity}`;
  assert.equal((await(await f.call(f.path+'/sync-mode')).json()).writebackEnabled,true);
  assert.equal((await f.call(f.path+'/sync-mode','POST',{writebackEnabled:false})).status,200);
  await f.call(action,'POST',{action:'flag'});
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_writebacks').get()).n),0);
  assert.equal((await f.call(f.path+'/sync-mode','POST',{writebackEnabled:true})).status,200);
  assert.equal((await(await f.call(f.path+'/sync-mode')).json()).writebackEnabled,true);
  await f.call(action,'POST',{action:'unflag'});
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_writebacks').get()).n),1);
  assert.equal((await f.call(f.path+'/sync-mode','POST',{writebackEnabled:false})).status,200);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_writebacks').get()).n),0);
 }finally{await f.close();}
});


test('enabled writeback applies flags and a mapped move without changing the stored original',async()=>{
 const f=await fixture();try{
  await f.enable();await f.call(f.path+'/sync-mode','POST',{writebackEnabled:true});
  let page=await(await f.call(f.path+'/messages')).json();let q=`?uidValidity=${page.uidValidity}`;
  await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}`,'POST',{action:'flag'});
  await f.scan();assert.equal(f.state.flagWrites,1);
  const a=await f.control.db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id);
  await new ArchiveStore(f.control.db,f.control.storage.files).call('folder',{accountId:f.id,credential:a.sync_credential,folder:'Other',name:'Other',specialUse:null});
  const originalList=f.worker.sync.reader.folders;
  // The provider connection's list is extended only during this mapped move.
  const execute=f.worker.sync.reader.execute.bind(f.worker.sync.reader);
  f.worker.sync.reader.execute=(account,options,operation,...rest)=>execute(account,options,async(client,box,check)=>{
   const list=client.list.bind(client);client.list=async()=>[...await list(),{path:'Other',name:'Other',flags:new Set()}];
   try{return await operation(client,box,check);}finally{client.list=list;}
  },...rest);
  await f.call(`${f.path}/messages/${page.items[0].uid}/actions${q}`,'POST',{action:'move',destination:'Other'});
  await f.scan();assert.equal(f.state.moves,1);
  const row=await f.control.db.prepare('SELECT source_folder,source_uid FROM archive_messages WHERE account_id=?').get(f.id);
  assert.equal(row.source_folder,'Other');assert.equal(row.source_uid,101);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mailbox_writebacks').get()).n),0);
  page=await(await f.call(f.path+'/messages?folder=Other')).json();assert.equal(page.items.length,1);
  const download=await f.call(`${f.path}/messages/${page.items[0].uid}/attachments/0?folder=Other&uidValidity=${page.uidValidity}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),attachment);
 }finally{await f.close();}
});


test('storage usage is explicit, tenant scoped and retained during the deletion recovery period',async()=>{
 const f=await fixture();try{
  await f.enable();const path=f.path+'/remote-storage';
  assert.equal((await(await f.call(path,'GET',undefined,true)).json()).storedBytes,undefined);
  const usage=await(await f.call(path+'?usage=1','GET',undefined,true)).json();
  assert.ok(usage.storedBytes>0);
  // This repetitive MIME fixture compresses well; usage reflects stored bytes.
  assert.ok(usage.storedBytes<raw.length);
  await f.call(path,'POST',{action:'delete',email:'mail@example.test'},true);
  assert.equal((await(await f.call(path+'?usage=1','GET',undefined,true)).json()).storedBytes,usage.storedBytes);
  const stranger=randomUUID();await f.control.db.prepare("INSERT INTO users VALUES(?,?,?,'user',1)").run(stranger,stranger+'@example.test','unused');
  const device=await f.control.devices.enroll(stranger,{name:'Other',platform:'ios'});
  assert.equal((await f.call(path+'?usage=1','GET',undefined,true,device.token)).status,404);
 }finally{await f.close();}
});


test('provider connection failure keeps moves pending without discarding local changes',async()=>{
 const f=await fixture();try{
  await f.enable();await f.call(f.path+'/sync-mode','POST',{writebackEnabled:true});
  const page=await(await f.call(f.path+'/messages')).json();
  await f.call(`${f.path}/messages/${page.items[0].uid}/actions?uidValidity=${page.uidValidity}`,'POST',{action:'trash'});
  f.state.deleted=true;f.worker.sync.reader.invalidate(f.id);
  await assert.rejects(f.scan());
  const job=await f.control.db.prepare('SELECT state,attempts FROM mailbox_writebacks').get();assert.equal(job.state,'pending');assert.equal(job.attempts,1);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM archive_messages WHERE deleted_at IS NOT NULL').get()).n),1);
 }finally{await f.close();}
});


test('archive transfer batches stay bounded and reconstruct exact bytes',async()=>{
 const f=await fixture();try{
  f.state.raw=Buffer.concat([raw,Buffer.alloc(2*1024*1024,32)]);
  const store=f.worker.reader.store,call=store.call.bind(store),ops=[];
  store.call=async(op,b)=>{ops.push({op,b});return call(op,b);};
  await f.enable();
  const chunks=Math.ceil(f.state.raw.length/65536);
  const writes=ops.filter(x=>x.op==='writeBatch'&&x.b.part==='raw');
  assert.equal(writes.length,Math.ceil(chunks/8));
  assert.ok(writes.every(x=>x.b.chunks.length<=8));
  assert.equal(ops.filter(x=>x.op==='write').length,0);
  const page=await(await f.call(f.path+'/messages')).json();
  const a=await f.control.db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id);
  ops.length=0;
  await f.worker.reader.execute(a,{folder:'INBOX',validity:page.uidValidity},async client=>{
   const dl=await client.download(page.items[0].uid),data=[];for await(const b of dl.content)data.push(b);
   assert.deepEqual(Buffer.concat(data),f.state.raw);
  });
  assert.equal(ops.filter(x=>x.op==='chunks').length,Math.ceil(chunks/8));
  assert.ok(ops.filter(x=>x.op==='chunks').every(x=>x.b.count<=8));
 }finally{await f.close();}
});

test('incremental archive sync uses one broker operation and advances safely across UID holes',async()=>{
 const f=await fixture();try{
  await f.enable();
  const page=await(await f.call(f.path+'/messages')).json();
  await f.control.db.prepare('UPDATE archive_folders SET next_uid=2502 WHERE account_id=? AND path=?').run(f.id,'INBOX');
  const store=f.worker.reader.store,call=store.call.bind(store),ops=[];
  store.call=async(op,b)=>{ops.push(op);return call(op,b);};
  let delta=await(await f.call(f.path+'/sync','POST',{folder:'INBOX',uidValidity:page.uidValidity,after:0,known:[]})).json();
  assert.deepEqual(ops,['sync']);assert.equal(delta.highWater,1000);assert.equal(delta.hasMore,true);assert.equal(delta.items.length,1);
  ops.length=0;
  delta=await(await f.call(f.path+'/sync','POST',{folder:'INBOX',uidValidity:page.uidValidity,after:1000,known:[1]})).json();
  assert.deepEqual(ops,['sync']);assert.equal(delta.highWater,2000);assert.equal(delta.items.length,0);assert.equal(delta.existing.length,1);
  delta=await(await f.call(f.path+'/sync','POST',{folder:'INBOX',uidValidity:page.uidValidity,after:2000,known:[1]})).json();
  assert.equal(delta.highWater,2501);assert.equal(delta.hasMore,false);
 }finally{await f.close();}
});

test('archive readers share an account while a file read is pending',async()=>{
 const f=await fixture();let release,reading;try{
  await f.enable();const db=f.control.db,files=f.control.files;
  const message=await db.prepare('SELECT * FROM archive_messages WHERE account_id=?').get(f.id);
  const store=new ArchiveStore(db,files),get=files.getChunks.bind(files);
  let started;const entered=new Promise(r=>started=r),blocked=new Promise(r=>release=r);
  files.getChunks=async(...args)=>{started();await blocked;return get(...args);};
  reading=store.call('chunks',{accountId:f.id,folder:'INBOX',id:message.id,part:'raw',seq:0,count:1});
  await entered;
  const status=await db.transaction(async()=>{await db.query("SET LOCAL lock_timeout='500ms'");return store.call('status',{accountId:f.id});});
  assert.equal(status.messages,1);
  // Exclusive account mutation must still wait for the protected read.
  await assert.rejects(db.transaction(async()=>{await db.query("SET LOCAL lock_timeout='100ms'");await db.prepare('UPDATE accounts SET sync_credential=NULL WHERE id=?').run(f.id);}),e=>e.code==='55P03');
 }finally{release?.();await reading;await f.close();}
});

test('small attachment cache avoids rereading MIME but still rejects deleted messages',async()=>{
 const f=await fixture();try{
  await f.enable();const page=await(await f.call(f.path+'/messages')).json(),uid=page.items[0].uid;
  const url=`${f.path}/messages/${uid}/attachments/0?uidValidity=${page.uidValidity}`;
  const store=f.worker.reader.store,call=store.call.bind(store);let reads=0;
  store.call=async(op,b)=>{if(op==='chunks')reads++;return call(op,b);};
  let result=await f.call(url);assert.deepEqual(Buffer.from(await result.arrayBuffer()),attachment);assert.ok(reads>0);
  reads=0;result=await f.call(url);assert.deepEqual(Buffer.from(await result.arrayBuffer()),attachment);assert.equal(reads,0);
  assert.ok(f.worker.reader.attachmentBytes<=f.worker.reader.attachmentCacheBytes);
  f.worker.reader.invalidate(f.id);reads=0;
  result=await f.call(url);assert.deepEqual(Buffer.from(await result.arrayBuffer()),attachment);assert.ok(reads>0);
  await f.control.db.prepare('DELETE FROM archive_messages WHERE account_id=?').run(f.id);
  assert.equal((await f.call(url)).status,404);
 }finally{await f.close();}
});

test('sync yields at its message budget and resumes without losing partial pages',async()=>{
 const f=await fixture();try{
  f.worker.sync.maxMessages=1;f.state.uids=[1,2,3];
  await f.enable();assert.equal((await(await f.call(f.path+'/sync-mode')).json()).messages,1);
  await f.scan();assert.equal((await(await f.call(f.path+'/sync-mode')).json()).messages,2);
  await f.scan();assert.equal((await(await f.call(f.path+'/sync-mode')).json()).messages,3);
  const cursor=JSON.parse((await f.control.db.prepare('SELECT cursor FROM archive_folders WHERE account_id=?').get(f.id)).cursor);
  assert.equal(cursor.before,null);assert.ok(cursor.checkedAt>0);
  let lists=0;const reader=f.worker.sync.reader,list=reader.list.bind(reader);
  reader.list=(...args)=>{lists++;return list(...args);};
  await f.scan();assert.equal(lists,1,'completed history should not immediately start another audit');
 }finally{await f.close();}
});

test('failed batch durability never publishes chunk references or a completed message',async()=>{
 const f=await fixture();try{
  const files=f.control.files,write=files.writeBatch.bind(files);
  files.writeBatch=async(...args)=>{await write(...args);throw Error('simulated batch sync failure');};
  await f.enable();
  assert.equal((await(await f.call(f.path+'/messages')).json()).items.length,0);
  assert.equal(Number((await f.control.db.prepare('SELECT COUNT(*) n FROM mail_file_chunks').get()).n),0);
  files.writeBatch=write;await f.scan();
  assert.equal((await(await f.call(f.path+'/messages')).json()).items.length,1);
 }finally{await f.close();}
});


test('arrival bursts do not skip their tail while historical backfill is in progress',async()=>{
 const f=await fixture();try{
  f.worker.sync.maxMessages=100;
  f.state.uids=Array.from({length:400},(_,i)=>i+1);
  await f.enable();
  let cursor=JSON.parse((await f.control.db.prepare('SELECT cursor FROM archive_folders WHERE account_id=?').get(f.id)).cursor);
  assert.ok(cursor.before<350);assert.equal(cursor.highWater,400);
  f.state.uids.push(...Array.from({length:200},(_,i)=>401+i));
  await f.scan();
  const row=await f.control.db.prepare('SELECT m.uid FROM mailbox_source_links l JOIN archive_messages m ON m.id=l.message_id WHERE l.account_id=? AND l.uid=501').get(f.id);
  assert.ok(row?.uid,'the overflow tail must precede older historical pages');
 }finally{await f.close();}
});

test('cancelled MIME extraction is not cached, and oversized entries respect the memory bound',async()=>{
 const f=await fixture();try{
  await f.enable();const page=await(await f.call(f.path+'/messages')).json(),uid=page.items[0].uid;
  const reader=f.worker.reader,a=await f.control.db.prepare('SELECT * FROM accounts WHERE id=?').get(f.id);
  await reader.message(a,{folder:'INBOX',validity:page.uidValidity},uid,0,new AbortController().signal,async({content})=>{for await(const chunk of content){assert.ok(chunk.length>0);break;}});
  assert.equal(reader.attachments.size,0);assert.equal(reader.attachmentBytes,0);
  reader.attachmentCacheEntryBytes=10;
  const url=`${f.path}/messages/${uid}/attachments/0?uidValidity=${page.uidValidity}`;
  const r=await f.call(url);assert.deepEqual(Buffer.from(await r.arrayBuffer()),attachment);
  assert.equal(reader.attachments.size,0);assert.equal(reader.attachmentBytes,0);
 }finally{await f.close();}
});
