import { candidateMailbox, requireVerification } from "../mail-verification.js";
import { encodeEnvelope } from "../credential-leases.js";
import { fail } from "../errors.js";
import { EMAIL, MAIL_HOST, isUuid } from "../validate.js";

const PUBLIC_ACCOUNT =
  "id,email,mode,imap_host,imap_port,smtp_host,smtp_port,monitor_enabled,credential,writeback_enabled,sync_enabled,sync_status,sync_updated,purge_after";
const ACCOUNT_ROUTE = /^\/api\/accounts\/([^/]+)(?:\/(monitor|access|remote-storage))?$/;

const string = (value, name, min = 1, max = 200) => {
  if (typeof value !== "string" || value.length < min || value.length > max)
    fail(400, `${name} invalid`);
  return value;
};

// Mailbox configuration and lifecycle. Mailbox content routes live in routes/mail.js.
// `account` is the caller's row for /api/accounts/:id paths, loaded once by the dispatcher.
export async function accountRoutes(app, r) {
  const { req, path, url, user, body, account, send } = r;
  const { db, devices, mail, leases, storage } = app;
  if (path === "/api/accounts" && req.method === "GET")
    return send(
      200,
      (await db.prepare(`SELECT ${PUBLIC_ACCOUNT} FROM accounts WHERE user_id=?`).all(user.id)).map(
        (a) => ({
          ...a,
          ...mail.state(a.id),
          credentialMode: a.credential ? "client" : "unbound",
          authorization: leases.status(a),
          credential: undefined,
        }),
      ),
    );
  if (path === "/api/accounts" && req.method === "POST")
    return send(201, await create(app, user, body));
  const route = path.match(ACCOUNT_ROUTE);
  if (!route) return false;
  if (!account) fail(404, "Mailbox not found");
  const action = route[2];

  if (action === "remote-storage") {
    if (req.method === "GET")
      return send(200, await storage.status(account.id, url.searchParams.get("usage") === "1"));
    if (req.method !== "POST") fail(405, "Method not allowed");
    const result = await storage.change(account.id, user.id, body.action, body.email);
    await devices.changed(account.id);
    return send(200, result);
  }
  if (action === "access" && req.method === "GET") {
    if (account.mode !== "proxy") fail(409, "Direct mode: read mail on the device");
    return send(200, { authorized: true });
  }
  if (action === "monitor" && req.method === "POST") {
    if (typeof body.enabled !== "boolean") fail(400, "enabled must be boolean");
    await db
      .prepare("UPDATE accounts SET monitor_enabled=? WHERE id=? AND purge_after IS NULL")
      .run(body.enabled ? 1 : 0, account.id);
    // Stopping only closes the listener; the user's mailbox authorization stays installed.
    if (body.enabled) void mail.start({ ...account, monitor_enabled: 1 });
    else mail.stop(account.id);
    return send(200, mail.state(account.id));
  }
  if (!action && req.method === "PATCH")
    return send(200, await replaceCredential(app, user, account, body));
  if (!action && req.method === "DELETE") {
    const result = await storage.change(account.id, user.id, "delete", body.email);
    await devices.changed(account.id);
    app.leaseHints.delete(account.id);
    return send(200, result);
  }
  return false;
}

async function create(app, user, body) {
  const { db, devices } = app;
  const email = string(body.email, "email").trim().toLowerCase();
  if (!EMAIL.test(email)) fail(400, "Invalid email");
  const mode = body.mode;
  if (!["proxy", "direct"].includes(mode)) fail(400, "Invalid mode");
  const imap = string(body.imapHost, "imapHost");
  const smtp = string(body.smtpHost, "smtpHost");
  for (const host of [imap, smtp]) if (!MAIL_HOST.test(host)) fail(400, "Invalid mail host");
  const imapPort = body.imapPort ?? 993,
    smtpPort = body.smtpPort ?? 465;
  // Same TLS ports the mail service and verification accept; others could never connect.
  if (imapPort !== 993 || ![465, 587].includes(smtpPort)) fail(400, "Mailbox TLS ports required");
  if (!body.envelope || Object.hasOwn(body, "credential"))
    fail(409, "Client encrypted credential required");
  const credential = encodeEnvelope(body.envelope);
  const id = string(body.id, "id", 36, 36);
  if (!isUuid(id)) fail(400, "Invalid mailbox ID");
  if (await db.prepare("SELECT id FROM accounts WHERE user_id=? AND email=?").get(user.id, email))
    fail(409, "Mailbox already added");
  if (app.requireMailboxVerification || body.verification)
    requireVerification(
      app.verificationKey,
      user.session_id,
      candidateMailbox(id, body),
      body.verification,
    );
  await db
    .prepare(
      "INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(id, user.id, email, mode, imap, imapPort, smtp, smtpPort, credential);
  await devices.changed(id);
  return { id, connectionStatus: "not_connected" };
}

async function replaceCredential(app, user, account, body) {
  const { db, leases, mail } = app;
  if (!body.envelope || Object.hasOwn(body, "credential"))
    fail(409, "Client encrypted credential required");
  const credential = encodeEnvelope(body.envelope);
  if (app.requireMailboxVerification || body.verification)
    requireVerification(
      app.verificationKey,
      user.session_id,
      candidateMailbox(account.id, body, account),
      body.verification,
    );
  await db.transaction(async () => {
    const fresh = await db
      .prepare("SELECT credential,purge_after FROM accounts WHERE id=? FOR UPDATE")
      .get(account.id);
    if (fresh?.purge_after) fail(409, "Mailbox deletion pending");
    if (!fresh || fresh.credential !== account.credential)
      fail(409, "Credential authorization changed");
    await db
      .prepare(
        "UPDATE accounts SET credential=?,sync_credential=NULL,sync_status=CASE WHEN sync_enabled=1 AND sync_status='paused' THEN 'paused' WHEN sync_enabled=1 THEN 'authorization_required' ELSE 'off' END WHERE id=?",
      )
      .run(credential, account.id);
    leases.revoke(account.id);
  });
  if (account.monitor_enabled) void mail.start({ ...account, credential });
  return { updated: true };
}
