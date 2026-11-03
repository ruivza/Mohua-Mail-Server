import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { SECOND } from "./limits.js";

// RFC 6266/5987: ASCII fallback plus the percent-encoded UTF-8 name, so no header injection is possible.
export const contentDisposition = (filename) =>
  "attachment; filename=attachment; filename*=UTF-8''" +
  encodeURIComponent(filename).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16));

// Streams a message body or attachment. Access is checked before the first byte and again at most once a
// second while bytes flow, so revoking a session or changing the credential stops a long download.
export async function streamAttachment(res, file, recheck, signal) {
  await recheck();
  let last = Date.now();
  const permission = new Transform({
    transform(chunk, encoding, done) {
      if (Date.now() - last < SECOND) return done(null, chunk);
      recheck().then(() => {
        last = Date.now();
        done(null, chunk);
      }, done);
    },
  });
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  await pipeline(file.content, permission, res, { signal });
}
