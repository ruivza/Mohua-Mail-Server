import { createHmac, timingSafeEqual } from "node:crypto";
import { CredentialLeases, encodeEnvelope } from "./credential-leases.js";
import { MailService } from "./mail.js";
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function candidateMailbox(id, body, existing) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) fail(400,"Invalid mailbox ID");
  const a = existing ? {...existing} : {
    id, email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
    mode: body.mode, imap_host: body.imapHost, imap_port: body.imapPort ?? 993,
    smtp_host: body.smtpHost, smtp_port: body.smtpPort ?? 465
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) fail(400,"Invalid email");
  if (!["proxy","direct"].includes(a.mode)) fail(400,"Invalid mode");
  if ([a.imap_host,a.smtp_host].some(h=>typeof h!=="string"||! /^[a-zA-Z0-9.-]+$/.test(h))) fail(400,"Invalid mail host");
  if (a.imap_port!==993 || ![465,587].includes(a.smtp_port)) fail(400,"Mailbox TLS ports required");
  if (a.purge_after) fail(409,"Mailbox deletion pending");
  a.credential=encodeEnvelope(body.envelope);
  return a;
}
function binding(a) { return [a.id,a.email,a.mode,a.imap_host,a.imap_port,a.smtp_host,a.smtp_port,a.credential]; }
const mac=(key,value)=>createHmac("sha256",key).update(value).digest("base64url");
export function verificationReceipt(key, session, a, now=Date.now()) {
  const payload=Buffer.from(JSON.stringify({session,account:binding(a),expires:now+300000})).toString("base64url");
  return payload+"."+mac(key,payload);
}
export function requireVerification(key, session, a, receipt, now=Date.now()) {
  if(typeof receipt!=="string" || receipt.length>30000) fail(422,"Mailbox verification required");
  const [payload,signature,...rest]=receipt.split(".");
  const expected=mac(key,payload||""), actual=signature||"";
  if(rest.length || !/^[A-Za-z0-9_-]{43}$/.test(actual) || !timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) fail(422,"Mailbox verification required");
  let data;try{data=JSON.parse(Buffer.from(payload,"base64url").toString());}catch{fail(422,"Mailbox verification required");}
  if(data.expires<=now || data.session!==session || JSON.stringify(data.account)!==JSON.stringify(binding(a))) fail(422,"Mailbox verification required");
}
export async function verifyCandidate(account, authorization, mailOptions={}) {
  if(!authorization || typeof authorization!=="object")fail(400,"Invalid encrypted credential");
  const leases=new CredentialLeases();
  // Temporary authorization is used only by this isolated verification connection.
  try {
    leases.restore(account,authorization,"preflight");
    const mail=new MailService({...mailOptions,leases,db:{prepare:()=>({get:async()=>account})}});
    return await mail.verify(account);
  } finally { leases.close(); }
}
