import { clientCredential, authorizeFixture } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as createApp } from "./helpers.mjs";
import { passwordHash } from "../src/auth.js";

test("sync route isolates tenants and rechecks revocation after upstream reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-sync-test-"));
  const app = await createApp({ dataDir: dir });
  let revokeDuringRead = false;
  app.mail.imap = async (_, job) => {
    const client = {
      connect: async () => {},
      close() {},
      mailboxOpen: async () => ({ uidValidity: 7n, uidNext: 11 }),
      fetchAll: async () => {
        if (revokeDuringRead)
          await app.db
            .prepare("DELETE FROM sessions WHERE user_id='one'")
            .run();
        return [
          { uid: 10, flags: new Set(["\\Seen"]), envelope: { subject: "New" } },
        ];
      },
    };
    job.client = client;
    return client;
  };
  for (const id of ["one", "two"]) {
    await app.db
      .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
      .run(
        id,
        id + "@example.com",
        passwordHash("password-for-test"),
        "user",
        1,
      );
  }
  await app.db
    .prepare(
      "INSERT INTO accounts(id,user_id,email,mode,credential,imap_host,imap_port,smtp_host,smtp_port) VALUES(?,?,?,?,?,'imap.example.com',993,'smtp.example.com',465)",
    )
    .run("mailbox", "one", "mail@example.com", "proxy", "client-v1:" + JSON.stringify(clientCredential("fixture-only", "mailbox").envelope));
  await authorizeFixture(app, "mailbox");
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, body, token) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const login = async (email) =>
      (
        await (
          await call("/api/client/login", {
            email,
            password: "password-for-test",
          })
        ).json()
      ).token;
    const owner = await login("one@example.com"),
      other = await login("two@example.com");
    const payload = { folder: "INBOX", uidValidity: "7", after: 9, known: [8] };
    assert.equal(
      (await call("/api/accounts/mailbox/sync", payload, other)).status,
      404,
    );
    const response = await call("/api/accounts/mailbox/sync", payload, owner);
    assert.equal(response.status, 200);
    const delta = await response.json();
    assert.equal(delta.highWater, 10);
    assert.deepEqual(
      delta.items.map((m) => m.uid),
      [10],
    );
    assert.deepEqual(delta.existing, []);
    revokeDuringRead = true;
    assert.equal(
      (await call("/api/accounts/mailbox/sync", payload, owner)).status,
      401,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
