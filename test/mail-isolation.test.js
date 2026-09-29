import {test} from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes,randomUUID,createCipheriv} from "node:crypto";
import {createTestApp,clientCredential} from "./helpers.mjs";
import {createMailWorker} from "../src/mail-worker.js";
import {credentialAAD} from "../src/credential-leases.js";
import {MailRemoteStore} from "../src/mail-remote-store.js";
import {mailRoute} from "../src/mail-protocol.js";
const secret="synthetic-provider-password-isolation",bodyText="SYNTHETIC_BODY_NOT_FOR_CONTROL",composeText="SYNTHETIC_COMPOSE_NOT_FOR_CONTROL",attachment="SYNTHETIC_ATTACHMENT_NOT_FOR_CONTROL";
async function fixture({pollMs=60000,onEmpty=()=>{},strict=false}={}){
 const dir=await mkdtemp(join(tmpdir(),"mail-isolation-")),brokerToken=randomBytes(32).toString("hex");
 const control=await createTestApp({dataDir:dir,brokerToken,requireMailboxVerification:strict});
 let observed="";control.server.prependListener("request",req=>req.on("data",b=>{observed+=b.toString();}));
 await new Promise(r=>control.server.listen(0,"127.0.0.1",r));
 const controlUrl=`http://127.0.0.1:${control.server.address().port}`;
 const user=randomUUID();await control.db.prepare("INSERT INTO users VALUES(?,?,?,'user',1)").run(user,user+"@example.test","unused");
 const device=await control.devices.enroll(user,{name:"iPhone",platform:"ios"});
 let closed=0,sent=0,passwords=[];
 class Client extends EventEmitter {
  async connect(){} async logout(){this.close();} close(){if(this.closed)return;this.closed=true;closed++;this.emit("close");}
  async mailboxOpen(){return {exists:1,uidValidity:1n,uidNext:2};}
  async list(){return [{path:"INBOX",flags:new Set()}];}
  async fetchOne(){return {envelope:{subject:"synthetic subject"},flags:new Set(),bodyStructure:{type:"text/plain",part:"1",size:bodyText.length}};}
  async download(){return {content:Readable.from([bodyText])};}
 }
 const mailOptions={resolveHost:async()=>"1.1.1.1",imapFactory:o=>{passwords.push(o.auth.pass);return new Client();},smtpFactory:o=>({verify:async()=>{passwords.push(o.auth.pass);},close(){},sendMail:async message=>{for await(const c of message.raw){}sent++;return {accepted:["recipient@example.test"],rejected:[]};}})};
 const worker=await createMailWorker({brokerUrl:controlUrl+"/internal/mail",brokerToken,mailOptions,pollMs,onEmpty});
 await new Promise(r=>worker.server.listen(0,"127.0.0.1",r));const workerUrl=`http://127.0.0.1:${worker.server.address().port}`;
 const call=async(base,path,method="GET",body,token=device.token,headers={})=>{
  const response=await fetch(base+path,{method,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{}),...headers},body:body===undefined?undefined:typeof body==="string"?body:JSON.stringify(body)});
  return response;
 };
 const payload=clientCredential(secret);
 const creation={...payload,email:"mail@example.test",mode:"proxy",imapHost:"imap.example.test",smtpHost:"smtp.example.test"};
 if(strict){const checked=await call(workerUrl,`/api/accounts/${payload.id}/verify`,"POST",{...creation,preflight:true,authorization:temporaryAuthorization(payload)});assert.equal(checked.status,200);creation.verification=(await checked.json()).verification;}
 const created=await call(controlUrl,"/api/accounts","POST",creation);assert.equal(created.status,201);
 await worker.inventory();
 let lastTemporaryKey;
 async function grant(){const path=`/api/accounts/${payload.id}/credential`,challenge=(await (await call(workerUrl,path)).json()).challenge;
  const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);c.setAAD(Buffer.from(credentialAAD(payload.id,payload.envelope.revision)));
  const ciphertext=Buffer.concat([iv,c.update(secret),c.final(),c.getAuthTag()]).toString("base64");
  lastTemporaryKey=key.toString("base64");
  const response=await call(workerUrl,path,"POST",{challenge,revision:payload.envelope.revision,key:key.toString("base64"),ciphertext,expiresAt:Date.now()+86400000});assert.equal(response.status,200);
 }
 await grant();
 return {control,worker,dir,mailOptions,brokerToken,controlUrl,workerUrl,call,device,user,id:payload.id,grant,get temporaryKey(){return lastTemporaryKey;},get observed(){return observed;},get sent(){return sent;},get closed(){return closed;},passwords,close:async()=>{await worker.close();await control.close();await rm(dir,{recursive:true,force:true});}};
}
test("worker handles secrets, bodies and SMTP while control only sees scoped metadata",async()=>{
 const f=await fixture();try{
  const path=`/api/accounts/${f.id}`;
  assert.equal((await f.call(f.controlUrl,path+"/credential")).status,421);
  assert.equal((await f.call(f.controlUrl,path+"/messages/1/body?uidValidity=1")).status,421);
  const response=await f.call(f.workerUrl,path+"/messages/1/body?uidValidity=1");assert.equal(response.status,200);assert.equal(await response.text(),bodyText);
  const prep=await f.call(f.workerUrl,path+"/outbox","POST",{to:["recipient@example.test"],subject:"subject",text:composeText,sentCopy:"provider",attachments:[{filename:"sample.txt",size:Buffer.byteLength(attachment)}]},undefined,{"Idempotency-Key":"isolation-send-001"});assert.equal(prep.status,201);const draft=await prep.json();
  const sent=await f.call(f.workerUrl,"/api/outbox/"+draft.id,"PUT",attachment,undefined,{"Content-Type":"application/octet-stream"});assert.equal(sent.status,200);assert.equal((await sent.json()).state,"sent");assert.equal(f.sent,1);
  assert.ok(f.passwords.includes(secret));for(const value of [secret,bodyText,composeText,attachment,f.temporaryKey])assert.ok(!f.observed.includes(value),"control saw confidential payload");
  assert.equal(f.control.leases.entries,undefined);assert.equal(f.control.mail.password,undefined);
 }finally{await f.close();}
});
test("broker rejects arbitrary SQL and wrong secrets, single worker enforced; revocation closes connections",async()=>{
 const f=await fixture();try{
  const denied=await fetch(f.controlUrl+"/internal/mail",{method:"POST",headers:{Authorization:"Bearer wrong","Content-Type":"application/json"},body:"{}"});assert.equal(denied.status,403);
  await assert.rejects(f.worker.db.call("query",{name:"passwords",args:[]}));
  assert.throws(()=>f.worker.db.prepare("SELECT password FROM users"));
  const another=new MailRemoteStore({url:f.controlUrl+"/internal/mail",token:f.brokerToken});await assert.rejects(another.call("register"),e=>e.status===409);
  const folders=await f.call(f.workerUrl,`/api/accounts/${f.id}/folders`);assert.equal(folders.status,200);
  await f.control.devices.revoke(f.user,f.device.deviceId);await f.worker.inventory();assert.equal(f.worker.leases.entries.size,0);assert.ok(f.closed>0);
  assert.equal((await f.call(f.workerUrl,`/api/accounts/${f.id}/folders`)).status,401);
 }finally{await f.close();}
});
test("fixed mail routes include all content and credential paths",()=>{
 for(const p of ["/api/accounts/a/credential","/api/accounts/a/folders","/api/accounts/a/messages/1/body","/api/accounts/a/messages/1/attachments/0","/api/accounts/a/sync","/api/accounts/a/outbox","/api/outbox/a","/api/outbox","/api/accounts/a/verify"])assert.ok(mailRoute(p));
 for(const p of ["/api/accounts","/api/accounts/a","/api/accounts/a/monitor","/api/client/login","/api/admin/health"])assert.ok(!mailRoute(p));
});

test("worker restart forgets leases and conservatively preserves uncertain send results",async()=>{
 const f=await fixture();let restarted;
 try{
  for(const state of ["sending","prepared"])await f.control.db.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?,NULL,?)").run(randomUUID(),f.user,f.id,state,"synthetic-digest",state,Date.now());
  await f.worker.close();
  restarted=await createMailWorker({brokerUrl:f.controlUrl+"/internal/mail",brokerToken:f.brokerToken,pollMs:60000});
  assert.equal(restarted.leases.entries.size,0);
  const states=(await f.control.db.prepare("SELECT state FROM outbox ORDER BY state").all()).map(r=>r.state);assert.deepEqual(states,["expired","unknown"]);
 }finally{await restarted?.close();await f.close();}
});
test("lost control registration fails closed and clears live mailbox capabilities",async()=>{
 const f=await fixture({pollMs:20});
 try{
  f.control.broker.worker="00000000-0000-0000-0000-000000000000";
  const deadline=Date.now()+2000;
  while(f.worker.leases.entries.size&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(f.worker.leases.entries.size,0);
 }finally{await f.close();}
});


test('worker checks preview demand through the authenticated broker',async()=>{
 const f=await fixture();
 try {
  assert.equal(await f.worker.mail.needsPreview(f.id),false);
  let checked;
  f.control.push.needsPreview=async id=>{checked=id;return true;};
  assert.equal(await f.worker.mail.needsPreview(f.id),true);
  assert.equal(checked,f.id);
  await assert.rejects(f.worker.db.call('needsPreview',{accountId:null}),e=>e.status===400);
 }finally{await f.close();}
});

test("enabling sync does not exit while the replacement authorization is loading",async()=>{
 let exits=0;const f=await fixture({onEmpty:()=>exits++});
 try {
  const original=f.worker.db.call.bind(f.worker.db);
  f.worker.db.call=async(op,body)=>{if(op==="inventory")await new Promise(r=>setTimeout(r,30));return original(op,body);};
  const response=await f.call(f.workerUrl,`/api/accounts/${f.id}/sync-mode`,"POST",{enabled:true});
  assert.equal(response.status,200);
  await new Promise(r=>setTimeout(r,60));
  assert.equal(exits,0);
  assert.equal((await f.call(f.workerUrl,"/healthz")).status,200);
 } finally {await f.close();}
});

function temporaryAuthorization(payload){
 const key=randomBytes(32),iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);
 c.setAAD(Buffer.from(credentialAAD(payload.id,payload.envelope.revision)));
 return {revision:payload.envelope.revision,key:key.toString("base64"),ciphertext:Buffer.concat([iv,c.update(secret),c.final(),c.getAuthTag()]).toString("base64")};
}
test("strict mailbox saves require verification and rejected replacement preserves the old credential",async()=>{
 const f=await fixture({strict:true});
 try {
  const unverified=clientCredential("wrong-password");
  assert.equal((await f.call(f.controlUrl,"/api/accounts","POST",{...unverified,email:"new@example.test",mode:"proxy",imapHost:"imap.example.test",smtpHost:"smtp.example.test"})).status,422);
  assert.equal(await f.control.db.prepare("SELECT id FROM accounts WHERE id=?").get(unverified.id),undefined);
  const before=await f.control.db.prepare("SELECT credential FROM accounts WHERE id=?").get(f.id);
  const replacement=clientCredential("replacement",f.id),authorization=temporaryAuthorization(replacement);
  assert.equal((await f.call(f.controlUrl,`/api/accounts/${f.id}`,"PATCH",replacement)).status,422);
  const original=f.mailOptions.imapFactory;
  f.mailOptions.imapFactory=()=>{const client=new EventEmitter();client.close=()=>{};client.connect=async()=>{throw Object.assign(Error("provider private detail"),{authenticationFailed:true});};return client;};
  const rejected=await f.call(f.workerUrl,`/api/accounts/${f.id}/verify`,"POST",{...replacement,preflight:true,updating:true,authorization});
  assert.equal(rejected.status,422);assert.deepEqual(await rejected.json(),{error:"Mailbox authentication failed"});
  assert.deepEqual(await f.control.db.prepare("SELECT credential FROM accounts WHERE id=?").get(f.id),before);
  f.mailOptions.imapFactory=original;
  const verified=await f.call(f.workerUrl,`/api/accounts/${f.id}/verify`,"POST",{...replacement,preflight:true,updating:true,authorization});
  assert.equal(verified.status,200);
  const proof=await verified.json();
  assert.equal((await f.call(f.controlUrl,`/api/accounts/${f.id}`,"PATCH",{...replacement,...proof})).status,200);
  assert.notEqual((await f.control.db.prepare("SELECT credential FROM accounts WHERE id=?").get(f.id)).credential,before.credential);
  assert.equal(f.observed.includes(authorization.key),false);
 } finally {await f.close();}
});
