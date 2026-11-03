import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { CredentialLeases, encodeEnvelope, credentialAAD } from "../src/credential-leases.js";
function seal(key, text, id, revision) {
  const nonce = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(credentialAAD(id, revision)));
  return Buffer.concat([nonce, c.update(text), c.final(), c.getAuthTag()]).toString("base64");
}
function account() {
  const id = randomUUID(),
    revision = randomUUID();
  return {
    id,
    revision,
    credential: encodeEnvelope({
      revision,
      ciphertext: seal(randomBytes(32), "password", id, revision),
    }),
  };
}
function grant(leases, a, device, expiresAt) {
  const key = randomBytes(32);
  return {
    challenge: leases.challenge(a, device),
    revision: a.revision,
    key: key.toString("base64"),
    ciphertext: seal(key, "private-mail-password", a.id, a.revision),
    expiresAt,
  };
}
test("leases isolate mailbox, device, revision and authenticated ciphertext; replay fails", () => {
  const l = new CredentialLeases(),
    a = account(),
    other = account();
  const b = grant(l, a, "device", Date.now() + 60000);
  assert.throws(() => l.install(other, "device", b));
  assert.throws(() => l.install(a, "other-device", b));
  const corrupt = Buffer.from(b.ciphertext, "base64");
  corrupt[15] ^= 1;
  assert.throws(() => l.install(a, "device", { ...b, ciphertext: corrupt.toString("base64") }));
  l.install(a, "device", b);
  assert.equal(l.password(a), "private-mail-password");
  assert.throws(() => l.install(a, "device", b));
  assert.throws(() => l.password({ ...a, credential: other.credential }));
  assert.throws(() => new CredentialLeases().password(a));
  l.close();
});
test("expiry and device revocation wipe owned buffers; no-expiry still dies with process", () => {
  let now = 1000;
  const closed = [];
  const l = new CredentialLeases({ now: () => now, onRevoke: (id) => closed.push(id) }),
    a = account();
  l.install(a, "d", grant(l, a, "d", 2000));
  const old = l.entries.get(a.id);
  now = 2000;
  assert.throws(
    () => l.password(a),
    (e) => e.status === 423,
  );
  assert.ok(old.key.every((x) => x === 0));
  assert.ok(old.ciphertext.every((x) => x === 0));
  assert.deepEqual(closed, [a.id]);
  l.install(a, "d", grant(l, a, "d", null));
  now = 1e12;
  assert.equal(l.password(a), "private-mail-password");
  l.revokeDevice("d");
  assert.throws(() => l.password(a));
});
test("renewal survives old deadline, stale challenges and invalid expiry cannot extend it", () => {
  let now = 1000;
  const l = new CredentialLeases({ now: () => now }),
    a = account();
  l.install(a, "d", grant(l, a, "d", 2000));
  l.install(a, "d", grant(l, a, "d", 3000));
  now = 2000;
  l.sweep();
  assert.equal(l.status(a).state, "active");
  assert.throws(() => l.install(a, "d", grant(l, a, "d", 1999)));
  const b = grant(l, a, "d", 4000);
  now += 300001;
  assert.throws(() => l.install(a, "d", b));
  l.close();
});

test("CryptoKit combined AES-GCM format interoperates with the server", () => {
  const id = "11111111-1111-1111-1111-111111111111",
    revision = "22222222-2222-2222-2222-222222222222";
  const ciphertext = "4jTDPG62Nrz/6ba59Y+xuVsZWrA1lMcVnOe2/3uzcsZDEVa1XxBWhzKXrjBbfuPAdV0gPpk=";
  const a = { id, revision, credential: encodeEnvelope({ revision, ciphertext }) };
  const l = new CredentialLeases();
  l.install(a, "device", {
    challenge: l.challenge(a, "device"),
    revision,
    ciphertext,
    key: Buffer.alloc(32, 7).toString("base64"),
    expiresAt: null,
  });
  assert.equal(l.password(a), "synthetic-互通-password");
  l.close();
});

test("expiration closes idle and borrowed IMAP connections and cancels active SMTP work", async () => {
  const { MailService } = await import("../src/mail.js");
  const { MailReader } = await import("../src/reader.js");
  const { MailSender } = await import("../src/sender.js");
  const { EventEmitter } = await import("node:events");
  let now = 1000,
    closed = 0;
  class Client extends EventEmitter {
    async connect() {}
    close() {
      if (this.closed) return;
      this.closed = true;
      closed++;
      this.emit("close");
    }
  }
  const leases = new CredentialLeases({ now: () => now });
  const mail = new MailService({
    db: {},
    decrypt: () => {
      throw Error("must not use server master key");
    },
    leases,
    resolveHost: async () => "1.1.1.1",
    imapFactory: () => new Client(),
  });
  const reader = new MailReader(mail);
  const sender = Object.create(MailSender.prototype);
  let cancelled = false;
  const a = {
    ...account(),
    mode: "proxy",
    user_id: "owner",
    email: "a@example.test",
    imap_port: 993,
    imap_host: "imap.example.test",
  };
  sender.active = new Map([
    [
      "send",
      {
        account: a.id,
        abort: () => {
          cancelled = true;
        },
      },
    ],
  ]);
  leases.onRevoke = (id) => {
    mail.stop(id);
    reader.invalidate(id);
    sender.invalidate(id);
  };
  leases.install(a, "device", grant(leases, a, "device", 2000));
  await reader.execute(a, null, async () => "ok");
  assert.equal(reader.pool.idle.length, 1);
  let began;
  const started = new Promise((r) => (began = r));
  const running = reader.execute(a, null, async (client) => {
    began();
    await new Promise((r) => client.once("close", r));
  });
  await started;
  now = 2000;
  leases.sweep();
  await assert.rejects(running);
  assert.equal(reader.pool.idle.length, 0);
  assert.ok(closed > 0);
  assert.equal(cancelled, true);
  await assert.rejects(
    reader.execute(a, null, async () => "must not run"),
    (e) => e.status === 423,
  );
  reader.close();
  await mail.close();
});
