import { browserDeviceName } from "./device-name.js";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { fail } from "./errors.js";
import { EMAIL } from "./validate.js";
import { ADMIN_SESSION_TTL } from "./limits.js";

const scryptAsync = promisify(scrypt);

export const hashToken = (value) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export function passwordHash(password) {
  const salt = newToken();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

// Hash off the event loop so concurrent logins do not stall every other request.
async function hashPassword(password) {
  const salt = newToken();
  return `${salt}:${(await scryptAsync(password, salt, 64)).toString("hex")}`;
}

// Unknown identities still pay for one scrypt, so response time does not reveal registered emails.
const decoy = passwordHash(newToken());
async function verifyPassword(password, stored = decoy) {
  const [salt, digest] = stored.split(":");
  const expected = Buffer.from(digest || "", "hex");
  const actual = await scryptAsync(password, salt || "", 64);
  return expected.length === 64 && timingSafeEqual(actual, expected);
}

// Administrators have separate identities and sessions. They never own mailboxes.
export class AuthService {
  constructor(db, setupToken) {
    this.db = db;
    this.setupToken = setupToken;
  }

  credentials(body, creating = false) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 200 || !EMAIL.test(email)) fail(400, "Invalid email");
    if (
      typeof body.password !== "string" ||
      body.password.length < (creating ? 12 : 1) ||
      body.password.length > 128
    ) {
      fail(400, "Password must contain 12–128 characters when creating an account");
    }
    return { email, password: body.password };
  }

  async setup(body) {
    if (
      typeof body.setupToken !== "string" ||
      hashToken(body.setupToken) !== hashToken(this.setupToken)
    )
      fail(403, "Invalid setup token");
    const { email, password } = this.credentials(body, true);
    const digest = await hashPassword(password);
    return this.db.transaction(async () => {
      await this.db.query("SELECT pg_advisory_xact_lock(734623, hashtext(current_schema()))");
      if (await this.db.prepare("SELECT 1 FROM administrators LIMIT 1").get())
        fail(409, "Already initialized");
      await this.db
        .prepare("INSERT INTO administrators VALUES(?,?,?)")
        .run(randomUUID(), email, digest);
      return { created: true };
    });
  }
  async register(body) {
    const { email, password } = this.credentials(body, true);
    if (typeof body.invite !== "string" || body.invite.length > 200)
      fail(403, "Invalid or expired invite");
    const inviteHash = hashToken(body.invite);
    // Reject unknown invites before spending a password hash on them.
    const pending = await this.db
      .prepare("SELECT expires FROM invites WHERE token_hash=?")
      .get(inviteHash);
    if (!pending || pending.expires <= Date.now()) fail(403, "Invalid or expired invite");
    const digest = await hashPassword(password);
    return this.db.transaction(async () => {
      const invite = await this.db
        .prepare("SELECT expires FROM invites WHERE token_hash=? FOR UPDATE")
        .get(inviteHash);
      if (!invite || invite.expires <= Date.now()) fail(403, "Invalid or expired invite");
      const result = await this.db
        .prepare(
          "INSERT INTO users(id,email,password,role) VALUES(?,?,?,'user') ON CONFLICT(email) DO NOTHING",
        )
        .run(randomUUID(), email, digest);
      if (!result.changes) fail(409, "Account already exists");
      await this.db.prepare("DELETE FROM invites WHERE token_hash=?").run(inviteHash);
      return { created: true };
    });
  }

  async login(body, administrator = false) {
    const { email, password } = this.credentials(body);
    const identity = administrator
      ? await this.db.prepare("SELECT * FROM administrators WHERE email=?").get(email)
      : await this.db
          .prepare("SELECT * FROM users WHERE email=? AND role='user' AND active=1")
          .get(email);
    if (!(await verifyPassword(password, identity?.password)) || !identity)
      fail(401, "Invalid credentials");
    return identity;
  }

  async adminLogin(body, userAgent) {
    const admin = await this.login(body, true);
    const name = browserDeviceName(userAgent);
    const token = newToken();
    const sessionId = randomUUID();
    await this.db
      .prepare("INSERT INTO admin_sessions VALUES(?,?,?,?,?)")
      .run(sessionId, admin.id, hashToken(token), name.trim(), Date.now() + ADMIN_SESSION_TTL);
    return {
      token,
      sessionId,
      user: { id: admin.id, email: admin.email, role: "admin" },
    };
  }

  // Expired sessions and invites are never accepted; delete them so the tables stay bounded.
  async sweep(now = Date.now()) {
    await this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
    await this.db.prepare("DELETE FROM admin_sessions WHERE expires<=?").run(now);
    await this.db.prepare("DELETE FROM invites WHERE expires<=?").run(now);
  }

  // One query for both identity kinds. Client sessions return their device row as `device`, so callers do not
  // look it up again; administrator sessions have no device.
  async authenticate(secret) {
    if (!secret) fail(401, "Sign in required");
    const digest = hashToken(secret),
      now = Date.now();
    const identity = await this.db
      .prepare(
        `SELECT a.id,a.email,'admin' AS role,s.id session_id,NULL::jsonb device
      FROM administrators a JOIN admin_sessions s ON s.admin_id=a.id
      WHERE s.token_hash=? AND s.expires>?
      UNION ALL
      SELECT u.id,u.email,u.role,s.id,to_jsonb(d)
      FROM users u JOIN sessions s ON s.user_id=u.id
      JOIN device_sessions ds ON ds.session_id=s.id JOIN client_devices d ON d.id=ds.device_id
      WHERE s.token_hash=? AND s.expires>? AND u.active=1 AND u.role='user' AND d.revoked IS NULL
      LIMIT 1`,
      )
      .get(digest, now, digest, now);
    if (!identity) fail(401, "Sign in required");
    return identity;
  }
}
