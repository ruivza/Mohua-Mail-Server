import { randomBytes, createDecipheriv } from "node:crypto";
const prefix = "client-v1:";
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
export const isClientCredential = value => typeof value === "string" && value.startsWith(prefix);
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
function bytes(value, min, max) {
  if (typeof value !== "string" || value.length > max * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, "Invalid encrypted credential");
  const b = Buffer.from(value, "base64");
  if (b.length < min || b.length > max || b.toString("base64") !== value) fail(400, "Invalid encrypted credential");
  return b;
}
export function encodeEnvelope(value) {
  if (!value || !uuid(value.revision)) fail(400, "Invalid credential revision");
  bytes(value.ciphertext, 29, 8192);
  return prefix + JSON.stringify({ revision: value.revision, ciphertext: value.ciphertext });
}
export function envelope(value) { return isClientCredential(value) ? JSON.parse(value.slice(prefix.length)) : null; }
export function credentialAAD(id, revision) { return `mohua-credential-v1\n${id}\n${revision}`; }
export class CredentialLeases {
  constructor({ now = Date.now, onRevoke = () => {} } = {}) {
    Object.assign(this, { now, onRevoke }); this.entries = new Map(); this.challenges = new Map();
  }
  challenge(account, device) {
    const key = account.id + ":" + device;
    for (const [k, v] of this.challenges) if (v.until <= this.now()) this.challenges.delete(k);
    if (this.challenges.size >= 10000 && !this.challenges.has(key)) fail(429, "Too many authorization requests");
    const value = { nonce: randomBytes(32).toString("base64url"), until: this.now() + 300000, credential: account.credential };
    this.challenges.set(key, value); return value.nonce;
  }
  install(account, device, body) {
    const e = envelope(account.credential), challengeKey = account.id + ":" + device;
    const c = this.challenges.get(challengeKey);
    if (!e || !c || c.until <= this.now() || c.nonce !== body.challenge || c.credential !== account.credential || body.revision !== e.revision) fail(409, "Credential authorization changed");
    const expires = body.expiresAt;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= this.now() || expires > this.now() + 366 * 86400000)) fail(400, "Invalid authorization expiry");
    const key = bytes(body.key, 32, 32), ciphertext = bytes(body.ciphertext, 29, 8192);
    const entry = { key, ciphertext, expires, device, credential: account.credential, revision: e.revision, hinted: 0 };
    try { const plaintext = this.decode(account.id, entry); if (!plaintext.length || plaintext.length > 4096) fail(400, "Invalid mailbox credential"); plaintext.fill(0); }
    catch { key.fill(0); ciphertext.fill(0); fail(400, "Invalid encrypted credential"); }
    this.challenges.delete(challengeKey);
    const old = this.entries.get(account.id);
    if (old) { old.key.fill(0); old.ciphertext.fill(0); }
    this.entries.set(account.id, entry);
    return this.status(account);
  }
  restore(account, data, persistent) {
    const e = envelope(account.credential);
    if (!e || data.revision !== e.revision) fail(409, "Credential authorization changed");
    const entry = { key: bytes(data.key,32,32), ciphertext: bytes(data.ciphertext,29,8192), expires:null, device:null, credential:account.credential, revision:e.revision, persistent };
    const clear = this.decode(account.id,entry); clear.fill(0);
    const old=this.entries.get(account.id);if(old){old.key.fill(0);old.ciphertext.fill(0);}
    this.entries.set(account.id,entry);
  }
  decode(id, entry) {
    const b = entry.ciphertext, d = createDecipheriv("aes-256-gcm", entry.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(credentialAAD(id, entry.revision))); d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]);
  }
  assert(account) {
    if (!isClientCredential(account.credential)) fail(409, "Client encrypted credential required");
    const e = this.entries.get(account.id);
    if (e && e.expires !== null && e.expires <= this.now()) this.revoke(account.id);
    if (!e || !this.entries.has(account.id) || e.credential !== account.credential) fail(423, "Mailbox authorization required");
  }
  password(account) {
    this.assert(account); const clear = this.decode(account.id, this.entries.get(account.id));
    try { return clear.toString("utf8"); } finally { clear.fill(0); }
  }
  status(account) {
    if (!account.credential) return {mode:"client",state:"locked",expiresAt:null};
    if (!isClientCredential(account.credential)) fail(409, "Client encrypted credential required");
    try { this.assert(account); } catch { return { mode: "client", state: "locked", expiresAt: null }; }
    return { mode: "client", state: "active", expiresAt: this.entries.get(account.id).expires };
  }
  revoke(id) {
    const e = this.entries.get(id); this.entries.delete(id);
    if (e) { e.key.fill(0); e.ciphertext.fill(0); }
    for (const k of this.challenges.keys()) if (k.startsWith(id + ":")) this.challenges.delete(k);
    this.onRevoke(id);
  }
  revokeDevice(device) { for (const [id, e] of this.entries) if (e.device === device) this.revoke(id); }
  sweep() { for (const [id, e] of this.entries) if (e.expires !== null && e.expires <= this.now()) this.revoke(id); }
  close() { for (const id of [...this.entries.keys()]) this.revoke(id); this.challenges.clear(); }
}
