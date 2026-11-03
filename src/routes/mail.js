import { candidateMailbox, verifyCandidate, verificationReceipt } from "../mail-verification.js";
import { envelope } from "../credential-leases.js";
import { readOptions } from "../reader.js";
import { streamAttachment } from "../attachment-stream.js";
import { fail } from "../errors.js";
import { MAX_UID } from "../limits.js";

const ACCOUNT = /^\/api\/accounts\/([^/]+)\/(.*)$/;
const DRAFTS = /^drafts(?:\/([^/]+))?$/;
const ACTION = /^messages\/([1-9]\d{0,9})\/actions$/;
const READ = /^(folders|messages|sync)(?:\/([1-9]\d{0,9})(?:\/(body|attachments\/\d{1,3}))?)?$/;
const SEND = /^\/api\/outbox\/([a-f0-9-]+)$/;
const SETTLED = ["sent", "partial", "unknown"];

// Mailbox content routes: every path mailRoute() matches. The in-process control service (tests and
// fixtures) and the isolated mail worker (production) both serve them through this one implementation;
// each supplies a context with the same shape:
//   user {id, session_id}, device {id}   the authenticated caller
//   mailbox(id)                          the caller's mailbox row; throws 404 when it is not theirs
//   authorize(account|null, message)     re-check after slow I/O: session alive, device not revoked and, for an
//                                        account, its credential revision unchanged (401/403/409); `message` is
//                                        the control service's 401 text, the worker reports the broker's
//   exclusive(account, fn)               run fn(current row) with authorization changes for it serialised
//   configureSync(account, settings)     persist sync-mode settings after a live-session check
//   resetSync(account)                   drop the old sync lease and reload sync state after a settings change
//   changed(accountId)                   bump the mailbox revision and notify the user's devices
//   outboxList()                         the caller's 20 newest send records {id,state,result}
//   throttle()                           extra rate limit for provider verification and send preparation
//   leases, mail, reader, sender, sync, remoteDrafts, archive, mailOptions, verificationKey
// Replies through `send`, or streams to `res` for bodies and attachments; errors carry an HTTP status.
export async function mailRoutes(ctx, { req, res, url, path, body, send }) {
  const account = path.match(ACCOUNT);
  if (account?.[2] === "verify" && req.method === "POST")
    return send(200, await verify(ctx, account[1], body));
  if (path === "/api/outbox") {
    if (req.method !== "GET") fail(405, "Method not allowed");
    const rows = await ctx.outboxList();
    return send(
      200,
      rows.map((r) => ({ id: r.id, state: r.state, ...(r.result ? JSON.parse(r.result) : {}) })),
    );
  }
  const outgoing = path.match(SEND);
  if (outgoing) return send(200, await submit(ctx, outgoing[1], req));
  if (!account) fail(404, "Not found");

  const a = await ctx.mailbox(account[1]);
  const route = account[2];
  if (a.purge_after && route !== "sync-mode") fail(409, "Mailbox deletion pending");
  const drafts = route.match(DRAFTS);
  if (drafts) {
    const result = await ctx.remoteDrafts.handle(a, drafts[1], req.method, body);
    await ctx.authorize(a, "Access revoked");
    return send(200, result);
  }
  if (route === "sync-mode") return send(200, await syncMode(ctx, a, req.method, body));
  if (route === "credential") return send(200, await credential(ctx, a, req.method, body));
  if (route === "outbox" && req.method === "POST") {
    ctx.throttle();
    ctx.leases.assert(a);
    return send(
      201,
      await ctx.sender.prepare(a, ctx.user.id, req.headers["idempotency-key"], body),
    );
  }

  const action = route.match(ACTION),
    read = route.match(READ);
  if (
    !(action && req.method === "POST") &&
    !(read && (req.method === "GET" || (req.method === "POST" && read[1] === "sync" && !read[2])))
  )
    fail(404, "Not found");
  const options = readOptions(url.searchParams);
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", disconnected);
  try {
    if (action) {
      const uid = Number(action[1]);
      if (uid > MAX_UID) fail(400, "Invalid UID");
      const result = await ctx.reader.mutate(a, options, uid, body, controller.signal, () =>
        ctx.authorize(a, "Access revoked"),
      );
      // Only a completed action changes the mailbox; a failed one must not make every device resync.
      if (a.sync_enabled) ctx.sync.wake(a.id);
      await ctx.changed(a.id);
      return send(200, result);
    }
    const recheck = () => ctx.authorize(a, "Access revoked; sign in again");
    let result;
    if (req.method === "POST") result = await ctx.reader.sync(a, body, controller.signal);
    else if (read[1] === "folders" && !read[2])
      result = await ctx.reader.folders(a, controller.signal);
    else if (read[1] === "messages" && !read[2])
      result = await ctx.reader.list(a, options, controller.signal);
    else if (read[1] === "messages" && Number(read[2]) <= MAX_UID) {
      const part =
        read[3] === undefined ? null : read[3] === "body" ? "body" : Number(read[3].split("/")[1]);
      result = await ctx.reader.message(
        a,
        options,
        Number(read[2]),
        part,
        controller.signal,
        (file) => streamAttachment(res, file, recheck, controller.signal),
      );
      if (part !== null) return true;
    } else fail(400, "Invalid read request");
    // Mail content left the provider; only reply if the caller may still see it.
    await recheck();
    return send(200, result);
  } finally {
    res.off("close", disconnected);
  }
}

async function verify(ctx, id, body) {
  ctx.throttle();
  if (body.preflight) {
    const existing = body.updating ? await ctx.mailbox(id) : null;
    const candidate = candidateMailbox(id, body, existing);
    await verifyCandidate(candidate, body.authorization, ctx.mailOptions);
    // The receipt is bound to this session and the stored mailbox; both must have survived the provider round trip.
    await ctx.authorize(existing, "Session revoked");
    return {
      verification: verificationReceipt(ctx.verificationKey, ctx.user.session_id, candidate),
    };
  }
  const a = await ctx.mailbox(id);
  const result = await ctx.mail.verify(a);
  await ctx.authorize(a, "Session revoked");
  return result;
}

async function syncMode(ctx, a, method, body) {
  if (method === "GET") return ctx.archive.call("status", { accountId: a.id });
  if (method !== "POST" && method !== "DELETE") fail(405, "Method not allowed");
  if (
    method === "POST" &&
    body.enabled === undefined &&
    typeof body.writebackEnabled === "boolean"
  ) {
    const result = await ctx.configureSync(a, {
      policyOnly: true,
      writebackEnabled: body.writebackEnabled,
    });
    ctx.sync.wake(a.id);
    return result;
  }
  let pause = method === "DELETE";
  const enabled = pause ? true : body.enabled;
  if (typeof enabled !== "boolean") fail(400, "enabled must be boolean");
  let credential = null;
  if (enabled && !pause) {
    try {
      credential = await ctx.sync.credential(a);
    } catch (e) {
      // No live lease: keep the archive but leave it paused until the user authorizes again.
      if (e.status !== 423) throw e;
      pause = true;
    }
  }
  const result = await ctx.configureSync(a, {
    enabled,
    pause,
    credential,
    writebackEnabled: body.writebackEnabled,
  });
  await ctx.resetSync(a);
  return result;
}

async function credential(ctx, a, method, body) {
  const { device, leases } = ctx;
  if (!device) fail(403, "Device session required");
  let installed = false,
    granted = null;
  try {
    const result = await ctx.exclusive(a, async (current) => {
      if (method === "GET")
        return {
          envelope: envelope(current.credential),
          authorization: leases.status(current),
          challenge: leases.challenge(current, device.id),
        };
      if (method === "POST") {
        const authorization = leases.install(current, device.id, body);
        installed = true;
        await ctx.authorize(current, "Access revoked");
        if (current.sync_enabled && current.sync_status !== "paused")
          await ctx.configureSync(current, {
            enabled: true,
            credential: await ctx.sync.credential(current),
          });
        granted = current;
        return { authorized: true, authorization };
      }
      if (method === "DELETE") {
        if (current.sync_enabled) await ctx.configureSync(current, { enabled: true, pause: true });
        leases.revoke(current.id);
        return { revoked: true };
      }
      fail(405, "Method not allowed");
    });
    if (granted?.monitor_enabled) void ctx.mail.start(granted);
    return result;
  } catch (error) {
    // A lease must not outlive the request that installed it when anything after the install failed.
    if (installed) leases.revoke(a.id);
    throw error;
  }
}

async function submit(ctx, id, req) {
  if (req.method === "GET") return ctx.sender.status(id, ctx.user.id);
  if (req.method !== "PUT") fail(405, "Method not allowed");
  if (req.headers["content-type"] !== "application/octet-stream")
    fail(415, "Use application/octet-stream");
  const accountId = ctx.sender.pending.get(id)?.account.id;
  const result = await ctx.sender.submit(id, ctx.user.id, req, (account) =>
    ctx.authorize(account, "Access revoked"),
  );
  if (accountId && SETTLED.includes(result.state)) await ctx.changed(accountId);
  req.resume();
  return result;
}
