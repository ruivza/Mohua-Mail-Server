import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { CredentialLeases, encodeEnvelope } from "./credential-leases.js";
import { MailService } from "./mail.js";
import { fail } from "./errors.js";
import { isUuid, EMAIL, MAIL_HOST } from "./validate.js";
import { VERIFICATION_TTL } from "./limits.js";
// Receipts are signed with a key derived from MAIL_BROKER_TOKEN, never with the bearer token itself.
// Control and worker derive the same key from the same token, so either side can check the other's receipt.
export const verificationKey = (secret) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "mohua-verification-v1", 32));
export function candidateMailbox(id, body, existing) {
  if (!isUuid(id)) fail(400, "Invalid mailbox ID");
  const a = existing
    ? { ...existing }
    : {
        id,
        email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
        mode: body.mode,
        imap_host: body.imapHost,
        imap_port: body.imapPort ?? 993,
        smtp_host: body.smtpHost,
        smtp_port: body.smtpPort ?? 465,
      };
  if (!EMAIL.test(a.email)) fail(400, "Invalid email");
  if (!["proxy", "direct"].includes(a.mode)) fail(400, "Invalid mode");
  if ([a.imap_host, a.smtp_host].some((h) => typeof h !== "string" || !MAIL_HOST.test(h)))
    fail(400, "Invalid mail host");
  if (a.imap_port !== 993 || ![465, 587].includes(a.smtp_port))
    fail(400, "Mailbox TLS ports required");
  if (a.purge_after) fail(409, "Mailbox deletion pending");
  a.credential = encodeEnvelope(body.envelope);
  return a;
}
function binding(a) {
  return [a.id, a.email, a.mode, a.imap_host, a.imap_port, a.smtp_host, a.smtp_port, a.credential];
}
const mac = (key, value) => createHmac("sha256", key).update(value).digest("base64url");
export function verificationReceipt(key, session, a, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ session, account: binding(a), expires: now + VERIFICATION_TTL }),
  ).toString("base64url");
  return payload + "." + mac(key, payload);
}
export function requireVerification(key, session, a, receipt, now = Date.now()) {
  if (typeof receipt !== "string" || receipt.length > 30000)
    fail(422, "Mailbox verification required");
  const [payload, signature, ...rest] = receipt.split(".");
  const expected = mac(key, payload || ""),
    actual = signature || "";
  if (
    rest.length ||
    !/^[A-Za-z0-9_-]{43}$/.test(actual) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    fail(422, "Mailbox verification required");
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    fail(422, "Mailbox verification required");
  }
  if (
    data.expires <= now ||
    data.session !== session ||
    JSON.stringify(data.account) !== JSON.stringify(binding(a))
  )
    fail(422, "Mailbox verification required");
}
export async function verifyCandidate(account, authorization, mailOptions = {}) {
  if (!authorization || typeof authorization !== "object")
    fail(400, "Invalid encrypted credential");
  const leases = new CredentialLeases();
  // Temporary authorization is used only by this isolated verification connection.
  try {
    leases.restore(account, authorization, "preflight");
    // The candidate is not stored yet, so the "mailbox still active" re-check answers from the candidate itself.
    const mail = new MailService({ ...mailOptions, leases, active: async () => account });
    return await mail.verify(account);
  } finally {
    leases.close();
  }
}
