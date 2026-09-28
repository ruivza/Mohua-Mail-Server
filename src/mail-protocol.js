// Only these named operations cross the worker/control boundary. Never accept SQL.
export const queries = {
  account: ["get", "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND u.active=1"],
  monitored: ["all", "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.monitor_enabled=1 AND u.active=1"],
  outboxStatus: ["get", "SELECT id,state,result FROM outbox WHERE id=? AND user_id=?"],
  outboxExisting: ["get", "SELECT * FROM outbox WHERE user_id=? AND request_key=?"],
  outboxInsert: ["run", "INSERT INTO outbox VALUES(?,?,?,?,?,'prepared',NULL,?)"],
  outboxClaim: ["run", "UPDATE outbox SET state='sending' WHERE id=? AND user_id=? AND state='prepared'"],
  outboxResult: ["run", "UPDATE outbox SET state=?,result=? WHERE id=?"],
  outboxExpire: ["run", "UPDATE outbox SET state='expired' WHERE id=? AND state='prepared'"],
};
export const mailRoute = path => /^\/api\/(outbox(?:\/|$)|accounts\/[^/]+\/(credential|folders|messages|sync|sync-mode|drafts|outbox|verify)(?:\/|$))/.test(path);
export async function jsonBody(req, max = 16384) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw Object.assign(Error("Use application/json"), { status: 415 });
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>max)throw Object.assign(Error("Body too large"),{status:413});chunks.push(chunk); }
  let value;try { value=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}"); } catch { throw Object.assign(Error("Invalid JSON"),{status:400}); }
  if(!value||typeof value!=="object"||Array.isArray(value))throw Object.assign(Error("Invalid body"),{status:400});return value;
}
export function reply(res, status, body) {
  res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(body));
}
