import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers.mjs";
import { PushService } from "../src/push.js";
import { gatewayProtocols, gatewayAppId, GatewaySettings } from "../src/gateway.js";
import { AuthService, passwordHash } from "../src/auth.js";
import { clientAddress, sweepExpired } from "../src/server.js";

test("gateway protocols accept relay 0.3.0 protocol lists and reject unknown versions", () => {
  assert.deepEqual(gatewayProtocols({ protocol: 1 }), [1]);
  assert.deepEqual(gatewayProtocols({ protocol: 1, protocols: [1, 2] }), [1, 2]);
  assert.deepEqual(gatewayProtocols({ protocol: 2, protocols: [2] }), [2]);
  assert.deepEqual(gatewayProtocols({ protocol: 3, protocols: [3] }), []);
  assert.deepEqual(gatewayProtocols(undefined), []);
  assert.equal(gatewayAppId("mohua-mail_2"), "mohua-mail_2");
  assert.throws(() => gatewayAppId("bad id"));
});

async function pushWith(health) {
  const db = await createTestDatabase();
  let calls = 0,
    now = 1000;
  const push = new PushService({
    db,
    decrypt: (v) => v,
    officialURL: "https://push.example.test",
    autoStart: false,
    now: () => now,
    provider: {
      health: async () => {
        calls++;
        return health();
      },
      close() {},
    },
  });
  await push.initialize();
  return {
    db,
    push,
    calls: () => calls,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("client capabilities advertise the newest shared registration protocol and cache gateway status", async () => {
  const f = await pushWith(() => ({
    status: 200,
    body: {
      protocol: 1,
      protocols: [1, 2],
      ready: true,
      kinds: ["sync", "encrypted_alert"],
      notificationEncryption: "p256-hkdf-sha256-aes256gcm-v1",
    },
  }));
  const first = await f.push.capabilities();
  assert.deepEqual(first.gatewayProtocols, [1, 2]);
  assert.equal(first.registrationProtocol, 2);
  assert.deepEqual(first.kinds, ["sync", "encrypted_alert"]);
  await f.push.capabilities();
  assert.equal(f.calls(), 1);
  f.advance(61000);
  await f.push.capabilities();
  assert.equal(f.calls(), 2);
  const result = await f.push.test();
  assert.equal(result.reachable, true);
  assert.equal(result.ready, true);
  assert.deepEqual(result.protocols, [1, 2]);
  assert.equal((await f.push.settings.current()).appId, "mohua");
});

test("a gateway offering only an unknown protocol is reported incompatible", async () => {
  const f = await pushWith(() => ({
    status: 200,
    body: { protocol: 3, protocols: [3], ready: true, kinds: ["sync"] },
  }));
  const result = await f.push.test();
  assert.equal(result.reachable, false);
  assert.equal((await f.push.capabilities()).registrationProtocol, null);
});

test("gateway app ID is configurable for gateways without a default application", async () => {
  const db = await createTestDatabase();
  const settings = new GatewaySettings(db, "https://push.example.test", "mohua-prod");
  await settings.initialize();
  assert.equal((await settings.current()).appId, "mohua-prod");
});

test("rate-limit address uses the trusted proxy hop and groups IPv6 by /64", () => {
  const req = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
  });
  assert.equal(clientAddress(req("172.18.0.5", "198.51.100.7"), 0), "172.18.0.5");
  assert.equal(clientAddress(req("172.18.0.5", "203.0.113.9, 198.51.100.7"), 1), "198.51.100.7");
  assert.equal(clientAddress(req("172.18.0.5", "203.0.113.9, 198.51.100.7"), 2), "203.0.113.9");
  assert.equal(clientAddress(req("172.18.0.5", "not-an-ip"), 1), "172.18.0.5");
  assert.equal(clientAddress(req("172.18.0.5"), 1), "172.18.0.5");
  assert.equal(clientAddress(req("::ffff:198.51.100.7"), 0), "198.51.100.7");
  assert.equal(
    clientAddress(req("172.18.0.5", "2001:db8:1:2:3:4:5:6"), 1),
    clientAddress(req("172.18.0.5", "2001:db8:1:2:ffff::1"), 1),
  );
});

test("expired sessions, invites and old send records are removed; pending draft receipts are kept", async () => {
  const db = await createTestDatabase();
  const auth = new AuthService(db, "setup");
  const now = Date.now(),
    old = now - 100 * 86400000;
  await db.exec(`INSERT INTO users VALUES('u','u@example.com','hash','user',1);
    INSERT INTO administrators VALUES('adm','admin@example.com','hash');
    INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES('a','u','a@example.com','proxy','imap.example.com',993,'smtp.example.com',465,'x');`);
  await db
    .prepare("INSERT INTO sessions VALUES('s-old','u','h1','n',?),('s-new','u','h2','n',?)")
    .run(now - 1, now + 60000);
  await db.prepare("INSERT INTO admin_sessions VALUES('a-old','adm','h3','n',?)").run(now - 1);
  await db.prepare("INSERT INTO invites VALUES('i-old',?),('i-new',?)").run(now - 1, now + 60000);
  await db
    .prepare(
      "INSERT INTO outbox VALUES('o-old','u','a','k1','d','sent',NULL,?),('o-kept','u','a','k2','d','sent',NULL,?),('o-new','u','a','k3','d','sent',NULL,?)",
    )
    .run(old, old, now);
  await db
    .prepare(
      "INSERT INTO remote_drafts(account_id,id,revision,updated,send_id) VALUES('a','draft','r',?,'o-kept')",
    )
    .run(now);
  await sweepExpired(db, auth, now);
  assert.deepEqual(
    (await db.prepare("SELECT id FROM sessions ORDER BY id").all()).map((r) => r.id),
    ["s-new"],
  );
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_sessions").get()).n, 0);
  assert.deepEqual(
    (await db.prepare("SELECT token_hash FROM invites").all()).map((r) => r.token_hash),
    ["i-new"],
  );
  assert.deepEqual(
    (await db.prepare("SELECT id FROM outbox ORDER BY id").all()).map((r) => r.id),
    ["o-kept", "o-new"],
  );
});

test("login rejects unknown and wrong-password identities alike and accepts the right password", async () => {
  const db = await createTestDatabase();
  await db
    .prepare("INSERT INTO users VALUES('u','login@example.com',?,'user',1)")
    .run(passwordHash("correct horse battery"));
  const auth = new AuthService(db, "setup");
  await assert.rejects(
    auth.login({ email: "missing@example.com", password: "whatever" }),
    (e) => e.status === 401,
  );
  await assert.rejects(
    auth.login({ email: "login@example.com", password: "wrong" }),
    (e) => e.status === 401,
  );
  assert.equal(
    (await auth.login({ email: "login@example.com", password: "correct horse battery" })).id,
    "u",
  );
});
