import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createCipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "./helpers.mjs";
import { credentialAAD } from "../src/credential-leases.js";
import { AuthService } from "../src/auth.js";
function encrypt(key, id, revision) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(credentialAAD(id, revision)));
  return Buffer.concat([
    iv,
    c.update("test-provider-password"),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
test("client encrypted API persists only envelope, enforces tenant/replay/downgrade and forgets leases on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-lease-"));
  let app = await createTestApp({ dataDir: dir });
  const start = () => new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  await start();
  const call = async (path, method, body, token) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const user = randomUUID(),
      other = randomUUID();
    for (const id of [user, other])
      await app.db
        .prepare("INSERT INTO users VALUES(?,?,?,'user',1)")
        .run(id, id + "@example.test", "unused");
    const device = await app.devices.enroll(user, { name: "iPhone", platform: "ios" }),
      stranger = await app.devices.enroll(other, { name: "iPhone", platform: "ios" });
    const id = randomUUID(),
      revision = randomUUID(),
      key = randomBytes(32),
      ciphertext = encrypt(key, id, revision);
    assert.equal(
      (
        await call(
          "/accounts",
          "POST",
          {
            email: "old@example.test",
            mode: "proxy",
            imapHost: "imap.example.test",
            smtpHost: "smtp.example.test",
            credential: "rejected-password",
          },
          device.token,
        )
      ).status,
      409,
    );
    const result = await call(
      "/accounts",
      "POST",
      {
        id,
        email: "mail@example.test",
        mode: "proxy",
        imapHost: "imap.example.test",
        smtpHost: "smtp.example.test",
        envelope: { revision, ciphertext },
      },
      device.token,
    );
    assert.equal(result.status, 201);
    let a = await app.db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
    assert.equal(a.monitor_enabled, 1);
    assert.ok(a.credential.startsWith("client-v1:"));
    assert.ok(!a.credential.includes(key.toString("base64")));
    assert.throws(() => app.mail.password(a));
    const list = await call("/accounts", "GET", null, device.token);
    assert.equal(list.body[0].credential, undefined);
    assert.equal(list.body[0].authorization.state, "locked");
    assert.equal(
      (await call(`/accounts/${id}/credential`, "GET", null, stranger.token)).status,
      404,
    );
    const challenge = (await call(`/accounts/${id}/credential`, "GET", null, device.token)).body
      .challenge;
    const temporary = randomBytes(32),
      body = {
        challenge,
        revision,
        key: temporary.toString("base64"),
        ciphertext: encrypt(temporary, id, revision),
        expiresAt: Date.now() + 60000,
      };
    assert.equal(
      (await call(`/accounts/${id}/credential`, "POST", body, device.token)).status,
      200,
    );
    assert.equal(app.mail.password(a), "test-provider-password");
    assert.equal(
      (await call(`/accounts/${id}/credential`, "POST", body, device.token)).status,
      409,
    );
    assert.equal(
      (await call(`/accounts/${id}`, "PATCH", { credential: "downgrade" }, device.token)).status,
      409,
    );
    assert.equal(
      (await app.db.prepare("SELECT credential FROM accounts WHERE id=?").get(id)).credential,
      a.credential,
    );
    await app.close();
    app = await createTestApp({ dataDir: dir });
    await start();
    assert.throws(() => app.mail.password(a));
    const challenge2 = (await call(`/accounts/${id}/credential`, "GET", null, device.token)).body
      .challenge;
    assert.equal(
      (
        await call(
          `/accounts/${id}/credential`,
          "POST",
          { ...body, challenge: challenge2 },
          device.token,
        )
      ).status,
      200,
    );
    await app.devices.revoke(user, device.deviceId);
    assert.throws(() => app.mail.password(a));
    assert.equal(
      (
        await call(
          `/accounts/${id}/credential`,
          "POST",
          { ...body, challenge: challenge2 },
          device.token,
        )
      ).status,
      401,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("in-process leases end with the device session and never outlive a failed installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-lease-"));
  const app = await createTestApp({ dataDir: dir });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const call = async (path, method, body, token) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const user = randomUUID();
    await app.db
      .prepare("INSERT INTO users VALUES(?,?,?,'user',1)")
      .run(user, user + "@example.test", "unused");
    const device = await app.devices.enroll(user, { name: "iPhone", platform: "ios" });
    const identity = await new AuthService(app.db).authenticate(device.token);
    assert.deepEqual(
      [identity.id, identity.role, identity.session_id, identity.device.id],
      [user, "user", device.sessionId, device.deviceId],
    );
    const id = randomUUID(),
      revision = randomUUID();
    assert.equal(
      (
        await call(
          "/accounts",
          "POST",
          {
            id,
            email: "mail@example.test",
            mode: "proxy",
            imapHost: "imap.example.test",
            smtpHost: "smtp.example.test",
            envelope: { revision, ciphertext: encrypt(randomBytes(32), id, revision) },
          },
          device.token,
        )
      ).status,
      201,
    );
    await app.db.prepare("UPDATE accounts SET monitor_enabled=0 WHERE id=?").run(id);
    const grant = async (token) => {
      const challenge = (await call(`/accounts/${id}/credential`, "GET", null, token)).body
          .challenge,
        key = randomBytes(32);
      return (
        await call(
          `/accounts/${id}/credential`,
          "POST",
          {
            challenge,
            revision,
            key: key.toString("base64"),
            ciphertext: encrypt(key, id, revision),
            expiresAt: null,
          },
          token,
        )
      ).status;
    };
    // A failure after the lease was installed rolls the lease back.
    await app.db
      .prepare("UPDATE accounts SET sync_enabled=1,sync_status='syncing' WHERE id=?")
      .run(id);
    const credential = app.sync.credential;
    app.sync.credential = async () => {
      throw Error("simulated sync failure");
    };
    assert.equal(await grant(device.token), 500);
    assert.equal(app.leases.entries.has(id), false);
    app.sync.credential = credential;
    await app.db.prepare("UPDATE accounts SET sync_enabled=0,sync_status='off' WHERE id=?").run(id);
    // Signing the session out revokes its device and the device's leases at once.
    assert.equal(await grant(device.token), 200);
    assert.ok(app.leases.entries.has(id));
    assert.equal(
      (await call("/devices/" + device.sessionId, "DELETE", null, device.token)).status,
      200,
    );
    assert.equal(app.leases.entries.has(id), false);
    assert.ok(
      (await app.db.prepare("SELECT revoked FROM client_devices WHERE id=?").get(device.deviceId))
        .revoked,
    );
    // An expired session ends the lease on the next lease check.
    const tablet = await app.devices.enroll(user, { name: "iPad", platform: "ios" });
    assert.equal(await grant(tablet.token), 200);
    assert.ok(app.leases.entries.has(id));
    await app.db
      .prepare("UPDATE sessions SET expires=? WHERE id=?")
      .run(Date.now() - 1, tablet.sessionId);
    const deadline = Date.now() + 5000;
    while (app.leases.entries.has(id) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.leases.entries.has(id), false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
