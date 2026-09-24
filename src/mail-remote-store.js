import { randomUUID } from "node:crypto";
import { queries } from "./mail-protocol.js";
const norm=s=>s.replace(/\s+/g," ").trim();
export class MailRemoteStore {
  constructor({url,token,fetcher=fetch}){this.url=url;this.token=token;this.fetcher=fetcher;this.worker=randomUUID();this.tail=Promise.resolve();}
  async call(op,values={}){
    const r=await this.fetcher(this.url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),headers:{Authorization:"Bearer "+this.token,"Content-Type":"application/json"},body:JSON.stringify({...values,op,worker:this.worker})});
    const b=await r.json();if(!r.ok)throw Object.assign(Error(b.error||"Mail broker unavailable"),{status:r.status});return b;
  }
  prepare(sql){
    const entry=Object.entries(queries).find(([,q])=>norm(q[1])===norm(sql));if(!entry)throw Error("Unsupported mail store query");
    return {[entry[1][0]]:(...args)=>this.call("query",{name:entry[0],args})};
  }
  async exec(sql){if(norm(sql)!=="UPDATE outbox SET state='unknown' WHERE state='sending'; UPDATE outbox SET state='expired' WHERE state='prepared';")throw Error("Unsupported mail store exec");/* registration atomically handles restart recovery */}
  async query(sql){if(norm(sql)!=="SELECT pg_advisory_xact_lock(734624, hashtext(current_schema()))")throw Error("Unsupported mail store query");}
  async transaction(operation){const previous=this.tail;let release;this.tail=new Promise(r=>release=r);await previous;try{return await operation();}finally{release();}}
}
