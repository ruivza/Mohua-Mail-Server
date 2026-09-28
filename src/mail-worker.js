import { RemoteDrafts } from "./remote-drafts.js";
import { ArchiveCrypto } from "./archive-crypto.js";
import { ArchiveReader } from "./archive-reader.js";
import { ArchiveSync } from "./archive-sync.js";
import http from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { CredentialLeases, envelope } from "./credential-leases.js";
import { MailService } from "./mail.js";
import { MailReader, readOptions } from "./reader.js";
import { MailSender } from "./sender.js";
import { MailRemoteStore } from "./mail-remote-store.js";
import { jsonBody, reply, mailRoute } from "./mail-protocol.js";
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export async function createMailWorker({brokerUrl,brokerToken,mailOptions={},pollMs=1000,archiveKeyPath=process.env.MAIL_ARCHIVE_KEY_FILE||"data/mail-sync.key",onLost=()=>{},onEmpty=()=>{}}){
  const db=new MailRemoteStore({url:brokerUrl,token:brokerToken});
  const registration=await db.call("register");
  let mail,reader,sender,sync,closed=false,lastHeartbeat=0,tick,previous=new Map(),invalidations={},accounts=[];
  const leases=new CredentialLeases({onRevoke:id=>{
    sync?.invalidate(id);mail?.stop(id);reader?.invalidate(id);sender?.invalidate(id);mail?.status(id,"authorization_required");
    if(!leases.entries.size)setImmediate(()=>{if(!closed&&!leases.entries.size&&!accounts.some(a=>a.sync_enabled))onEmpty();});
  }});
  mail=new MailService({db,leases,...mailOptions,needsPreview:id=>db.call("needsPreview",{accountId:id}),onSyncChange:id=>sync?.wake(id),onChange:(id,kind,notification)=>db.call("changed",{accountId:id,kind,notification})});
  const live=new MailReader(mail),crypto=new ArchiveCrypto(archiveKeyPath);
  const archive={call:(operation,values)=>db.call("archive",{operation,values})};
  const remoteDrafts=new RemoteDrafts(archive,crypto);
  sync=new ArchiveSync({reader:live,store:archive,crypto,leases});
  reader=new ArchiveReader(live,archive,crypto);sender=new MailSender({db,reader,mail});await sender.initialize();
  async function inventory(){
    const snapshot=accounts.map(a=>({id:a.id,...mail.state(a.id),authorization:leases.status(a)}));
    const data=await db.call("inventory",{snapshot});
    if(data.boot!==registration.boot)throw Error("Control service restarted");
    const present=new Map(data.accounts.map(a=>[a.id,a])),devices=new Set(data.devices);
    for(const [id,e] of leases.entries){
      if(!present.has(id)||present.get(id).credential!==e.credential||(!e.persistent&&!devices.has(e.device))||(e.persistent&&present.get(id).sync_credential!==e.persistent)||(data.invalidations[id]||0)!==(invalidations[id]||0))leases.revoke(id);
    }
    for(const old of previous.values())if(!present.has(old.id)){mail.remove(old.id);reader.invalidate(old.id);sender.invalidate(old.id);}
    accounts=data.accounts;invalidations=data.invalidations;previous=present;
    for(const a of accounts){
      try{sync.restore(a);}catch{await archive.call("state",{accountId:a.id,state:"authorization_required"});}
      if(a.sync_enabled ? !!a.sync_credential : a.monitor_enabled)void mail.start(a);else if(mail.jobs.has(a.id))mail.stop(a.id);
      const status=leases.status(a);
      if(status.state!=="active"||(status.expiresAt!==null&&status.expiresAt-Date.now()<86400000))await db.call("hint",{accountId:a.id});
    }
    lastHeartbeat=Date.now();sync.schedule(accounts);remoteDrafts.scheduleMigration(accounts);
  }
  try{await inventory();}catch(e){await sender.close();reader.close();await mail.close();throw e;}
  const timer=setInterval(()=>{
    leases.sweep();if(tick||closed)return;
    tick=inventory().catch(()=>{leases.close();onLost();}).finally(()=>tick=null);
  },pollMs);timer.unref();
  const limits=new Map();
  function limit(id){const now=Date.now();for(const [k,v]of limits)if(v.until<now)limits.delete(k);const v=limits.get(id)||{count:0,until:now+60000};if(++v.count>120)fail(429,"Too many mail requests");limits.set(id,v);}
  const server=http.createServer(async(req,res)=>{
    const send=(status,body)=>reply(res,status,body);
    try{
      const url=new URL(req.url,"http://localhost"),path=url.pathname;
      if(path==="/healthz"&&req.method==="GET")return send(Date.now()-lastHeartbeat<10000?200:503,{status:Date.now()-lastHeartbeat<10000?"ok":"unavailable"});
      if(!mailRoute(path))fail(404,"Not found");
      if(closed||Date.now()-lastHeartbeat>=10000)fail(503,"Mail worker unavailable");
      const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)fail(401,"Sign in required");
      const scope=await db.call("authorize",{token});
      const user=scope.user,device=scope.device;
      const match=path.match(/^\/api\/accounts\/([^/]+)\/(.*)$/);
      let a;if(match)a=(await db.call("authorize",{token,accountId:match[1]})).account;
      const authorize=async account=>{await db.call("authorize",{token,accountId:account.id,credential:account.credential});if((await db.call("authorize",{token,accountId:account.id})).account.purge_after)fail(409,"Mailbox deletion pending");};
      if(a?.purge_after && match?.[2]!=="sync-mode")fail(409,"Mailbox deletion pending");
      let body={};if(["POST","PATCH"].includes(req.method)||(req.method==="DELETE"&&match?.[2].startsWith("drafts/")&&req.headers["content-type"])){limit(device.id);body=await jsonBody(req,match?.[2].startsWith("drafts/")?37*1024*1024:path.endsWith("/outbox")?400000:16384);}
      if(match && /^drafts(?:\/[^/]+)?$/.test(match[2])){const result=await remoteDrafts.handle(a,match[2].split("/")[1],req.method,body);await authorize(a);return send(200,result);}
      if(match&&match[2]==="sync-mode"){
        if(req.method==="GET")return send(200,await archive.call("status",{accountId:a.id}));
        if(req.method!=="POST"&&req.method!=="DELETE")fail(405,"Method not allowed");
        if(req.method==="POST" && body.enabled===undefined && typeof body.writebackEnabled==="boolean"){
          const result=await db.call("archiveConfigure",{token,accountId:a.id,credentialRevision:a.credential,settings:{policyOnly:true,writebackEnabled:body.writebackEnabled}});
          sync.wake(a.id);return send(200,result);
        }
        let pause=req.method==="DELETE";const enabled=pause?true:body.enabled;
        if(typeof enabled!=="boolean")fail(400,"enabled must be boolean");
        let credential=null;
        if(enabled&&!pause){try{credential=await sync.credential(a);}catch(e){if(e.status!==423)throw e;pause=true;}}
        const result=await db.call("archiveConfigure",{token,accountId:a.id,credentialRevision:a.credential,settings:{enabled,pause,credential,writebackEnabled:body.writebackEnabled}});
        sync.invalidate(a.id);leases.revoke(a.id);
        await inventory();return send(200,result);
      }
      if(match&&match[2]==="credential"){
        if(req.method==="GET")return send(200,{envelope:envelope(a.credential),authorization:leases.status(a),challenge:leases.challenge(a,device.id)});
        if(req.method==="POST"){
          const authorization=leases.install(a,device.id,body);
          try{await authorize(a);}catch(e){leases.revoke(a.id);throw e;}
          if(a.sync_enabled && a.sync_status!=="paused"){
            const credential=await sync.credential(a);
            await db.call("archiveConfigure",{token,accountId:a.id,credentialRevision:a.credential,settings:{enabled:true,credential}});
          }
          if(a.monitor_enabled)void mail.start(a);
          return send(200,{authorized:true,authorization});
        }
        if(req.method==="DELETE"){
          if(a.sync_enabled)await db.call("archiveConfigure",{token,accountId:a.id,credentialRevision:a.credential,settings:{enabled:true,pause:true}});
          leases.revoke(a.id);return send(200,{revoked:true});
        }
        fail(405,"Method not allowed");
      }
      if(match&&match[2]==="verify"&&req.method==="POST"){
        const result=await mail.verify(a);await authorize(a);return send(200,result);
      }
      if(match&&match[2]==="outbox"&&req.method==="POST"){
        leases.assert(a);return send(201,await sender.prepare(a,user.id,req.headers["idempotency-key"],body));
      }
      if(path==="/api/outbox"&&req.method==="GET"){
        const rows=await db.call("outboxList",{token});return send(200,rows.map(r=>({id:r.id,state:r.state,...(r.result?JSON.parse(r.result):{})})));
      }
      const outgoing=path.match(/^\/api\/outbox\/([a-f0-9-]+)$/);
      if(outgoing){
        if(req.method==="GET")return send(200,await sender.status(outgoing[1],user.id));
        if(req.method==="PUT"){
          if(req.headers["content-type"]!=="application/octet-stream")fail(415,"Use application/octet-stream");
          const accountId=sender.pending.get(outgoing[1])?.account.id;
          const result=await sender.submit(outgoing[1],user.id,req,authorize);
          if(accountId&&["sent","partial","unknown"].includes(result.state))await db.call("changed",{accountId});
          req.resume();return send(200,result);
        }
      }
      if(!match)fail(404,"Not found");
      const action=match[2].match(/^messages\/([1-9]\d{0,9})\/actions$/);
      const read=match[2].match(/^(folders|messages|sync)(?:\/([1-9]\d{0,9})(?:\/(body|attachments\/\d{1,3}))?)?$/);
      const controller=new AbortController();
      const disconnected=()=>{if(!res.writableEnded)controller.abort();};res.on("close",disconnected);
      try{
        const options=readOptions(url.searchParams);
        if(action&&req.method==="POST"){
          const uid=Number(action[1]);if(uid>4294967295)fail(400,"Invalid UID");
          const result=await reader.mutate(a,options,uid,body,controller.signal,()=>authorize(a));
          if(a.sync_enabled)sync.wake(a.id);await db.call("changed",{accountId:a.id});return send(200,result);
        }
        let result;
        if(read&&read[1]==="sync"&&!read[2]&&req.method==="POST")result=await reader.sync(a,body,controller.signal);
        else if(read&&req.method==="GET"){
          if(read[1]==="folders"&&!read[2])result=await reader.folders(a,controller.signal);
          else if(read[1]==="messages"&&!read[2])result=await reader.list(a,options,controller.signal);
          else if(read[1]==="messages"&&Number(read[2])<=4294967295){
            result=await reader.message(a,options,Number(read[2]),read[3]===undefined?null:read[3]==="body"?"body":Number(read[3].split("/")[1]),controller.signal,async file=>{
              await authorize(a);let last=Date.now();
              const permission=new Transform({transform(chunk,encoding,done){
                if(Date.now()-last<1000)return done(null,chunk);
                authorize(a).then(()=>{last=Date.now();done(null,chunk);},done);
              }});
              res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Disposition":"attachment; filename=attachment; filename*=UTF-8''"+encodeURIComponent(file.filename).replace(/[!'()*]/g,c=>"%"+c.charCodeAt(0).toString(16)),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
              await pipeline(file.content,permission,res,{signal:controller.signal});
            });
            if(read[3]!==undefined)return;
          }else fail(400,"Invalid read request");
        }else fail(404,"Not found");
        await authorize(a);return send(200,result);
      }finally{res.off("close",disconnected);}
    }catch(e){
      if(res.headersSent){res.destroy();return;}
      send(e.status||502,{error:e.status?e.message:"Mail operation failed"});
    }
  });
  server.requestTimeout=600000;server.headersTimeout=10000;
  let closing;
  const close=()=>closing||=(async()=>{closed=true;clearInterval(timer);leases.close();await sync.close();await tick;await remoteDrafts.migrating;const stopped=new Promise(r=>server.close(r));server.closeAllConnections();reader.close();await mail.close();await sender.close();await db.call("release").catch(()=>{});await stopped;})();
  return {server,close,leases,mail,reader,sender,db,inventory,sync,remoteDrafts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  for(const key of ["PGHOST","PGPASSWORD","DATABASE_URL","MASTER_KEY_FILE","SETUP_TOKEN"])if(process.env[key])throw Error("Mail worker must not receive database or master-key configuration");
  let app,stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;void app?.close().finally(()=>process.exit(0));};
  app=await createMailWorker({brokerUrl:process.env.MAIL_BROKER_URL||"http://server:3210/internal/mail",brokerToken:process.env.MAIL_BROKER_TOKEN,onLost:stop,onEmpty:stop});
  for(const signal of ["SIGINT","SIGTERM"])process.on(signal,stop);
  app.server.listen(Number(process.env.PORT||3211),process.env.HOST||"0.0.0.0");
}
