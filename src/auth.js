import { browserDeviceName } from "./device-name.js";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const hashToken = (value) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export function passwordHash(password) {
  const salt = newToken();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = stored.split(":");
  const expected = Buffer.from(digest || "", "hex");
  return (
    expected.length === 64 &&
    timingSafeEqual(scryptSync(password, salt, 64), expected)
  );
}

// Administrators have separate identities and sessions. They never own mailboxes.
export class AuthService {
  constructor(db, setupToken) {
    this.db = db;
    this.setupToken = setupToken;
  }

  credentials(body, creating = false) {
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      fail(400, "Invalid email");
    if (
      typeof body.password !== "string" ||
      body.password.length < (creating ? 12 : 1) ||
      body.password.length > 128
    ) {
      fail(
        400,
        "Password must contain 12–128 characters when creating an account",
      );
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
    return this.db.transaction(async () => {
      await this.db.query(
        "SELECT pg_advisory_xact_lock(734623, hashtext(current_schema()))",
      );
      if (await this.db.prepare("SELECT 1 FROM administrators LIMIT 1").get())
        fail(409, "Already initialized");
      await this.db
        .prepare("INSERT INTO administrators VALUES(?,?,?)")
        .run(randomUUID(), email, passwordHash(password));
      return { created: true };
    });
  }
  async register(body) {
    const { email, password } = this.credentials(body, true);
    if (typeof body.invite !== "string" || body.invite.length > 200)
      fail(403, "Invalid or expired invite");
    const inviteHash = hashToken(body.invite),
      digest = passwordHash(password);
    return this.db.transaction(async () => {
      const invite = await this.db
        .prepare("SELECT expires FROM invites WHERE token_hash=? FOR UPDATE")
        .get(inviteHash);
      if (!invite || invite.expires <= Date.now())
        fail(403, "Invalid or expired invite");
      const result = await this.db
        .prepare(
          "INSERT INTO users(id,email,password,role) VALUES(?,?,?,'user') ON CONFLICT(email) DO NOTHING",
        )
        .run(randomUUID(), email, digest);
      if (!result.changes) fail(409, "Account already exists");
      await this.db
        .prepare("DELETE FROM invites WHERE token_hash=?")
        .run(inviteHash);
      return { created: true };
    });
  }

  async login(body, administrator = false) {
    const { email, password } = this.credentials(body);
    const identity = administrator
      ? await this.db
          .prepare("SELECT * FROM administrators WHERE email=?")
          .get(email)
      : await this.db
          .prepare(
            "SELECT * FROM users WHERE email=? AND role='user' AND active=1",
          )
          .get(email);
    if (!identity || !verifyPassword(password, identity.password))
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
      .run(
        sessionId,
        admin.id,
        hashToken(token),
        name.trim(),
        Date.now() + 86400000,
      );
    return {
      token,
      sessionId,
      user: { id: admin.id, email: admin.email, role: "admin" },
    };
  }

  async authenticate(secret) {
    if (!secret) fail(401, "Sign in required");
    const digest = hashToken(secret);
    const admin = await this.db
      .prepare(
        `SELECT a.id,a.email,'admin' role,s.id session_id
      FROM administrators a JOIN admin_sessions s ON s.admin_id=a.id
      WHERE s.token_hash=? AND s.expires>?`,
      )
      .get(digest, Date.now());
    if (admin) return admin;
    const user = await this.db
      .prepare(
        `SELECT u.id,u.email,u.role,s.id session_id
      FROM users u JOIN sessions s ON s.user_id=u.id
      JOIN device_sessions ds ON ds.session_id=s.id JOIN client_devices d ON d.id=ds.device_id
      WHERE s.token_hash=? AND s.expires>? AND u.active=1 AND u.role='user' AND d.revoked IS NULL`,
      )
      .get(digest, Date.now());
    if (!user) fail(401, "Sign in required");
    return user;
  }
}
