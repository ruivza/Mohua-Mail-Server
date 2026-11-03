import { fail } from "./errors.js";
import { JSON_BODY_BYTES, OUTBOX_BODY_BYTES, DRAFT_BODY_BYTES } from "./limits.js";
// Only these named operations cross the worker/control boundary. Never accept SQL.
export const queries = {
  account: [
    "get",
    "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND u.active=1",
  ],
  monitored: [
    "all",
    "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.monitor_enabled=1 AND u.active=1",
  ],
  outboxStatus: ["get", "SELECT id,state,result FROM outbox WHERE id=? AND user_id=?"],
  outboxExisting: ["get", "SELECT * FROM outbox WHERE user_id=? AND request_key=?"],
  outboxInsert: ["run", "INSERT INTO outbox VALUES(?,?,?,?,?,'prepared',NULL,?)"],
  outboxClaim: [
    "run",
    "UPDATE outbox SET state='sending' WHERE id=? AND user_id=? AND state='prepared'",
  ],
  outboxResult: ["run", "UPDATE outbox SET state=?,result=? WHERE id=?"],
  outboxExpire: ["run", "UPDATE outbox SET state='expired' WHERE id=? AND state='prepared'"],
};
// Kept identical to the location regex in ops/mail-edge.conf; test/mail-isolation.test.js compares them.
export const mailRoute = (path) =>
  /^\/api\/(outbox(?:\/|$)|accounts\/[^/]+\/(credential|folders|messages|sync|sync-mode|drafts|outbox|verify)(?:\/|$))/.test(
    path,
  );
// Draft snapshots carry attachments and outbox requests carry compose text; everything else is small JSON.
export const bodyLimit = (path) =>
  /\/drafts\//.test(path)
    ? DRAFT_BODY_BYTES
    : /^\/api\/accounts\/[^/]+\/outbox$/.test(path)
      ? OUTBOX_BODY_BYTES
      : JSON_BODY_BYTES;
export const bearer = (req) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
export async function jsonBody(req, max = JSON_BODY_BYTES) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    fail(415, "Use application/json");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail(413, "Body too large");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    fail(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid body");
  return value;
}
export function reply(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
