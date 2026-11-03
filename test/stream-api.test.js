import { clientCredential, authorizeFixture } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as createApp } from "./helpers.mjs";
test("HTTP body streaming and mutations enforce ownership, mode and validity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-stream-"));
  let downloads = 0,
    changes = 0;
  const app = await createApp({
    dataDir: dir,
    setupToken: "test",
    mailOptions: {
      resolveHost: async () => "1.1.1.1",
      smtpFactory: () => ({
        verify: async () => {},
        close() {},
        sendMail: async (m) => {
          for await (const c of m.raw) {
          }
          return { accepted: ["to@example.com"], rejected: [] };
        },
      }),
      imapFactory: () => ({
        on() {},
        connect: async () => {},
        close() {},
        mailboxOpen: async () => ({ uidValidity: 7n }),
        fetchOne: async () => ({
          bodyStructure: { type: "text/html", part: "1" },
          envelope: { subject: "test" },
        }),
        download: async () => {
          downloads++;
          return {
            content: Readable.from(
              (async function* () {
                for (let i = 0; i < 48; i++) yield Buffer.alloc(65536, 97);
              })(),
            ),
          };
        },
        messageFlagsAdd: async () => {
          changes++;
          return true;
        },
      }),
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port + "/api";
  const call = (path, token, method = "GET", body) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await call("/setup", "", "POST", {
      email: "a@example.com",
      password: "password-long-123",
      setupToken: "test",
    });
    const admin = (
      await (
        await call("/login", "", "POST", {
          email: "a@example.com",
          password: "password-long-123",
        })
      ).json()
    ).token;
    const invite = (await (await call("/admin/invites", admin, "POST", {})).json()).invite;
    await call("/register", "", "POST", {
      email: "b@example.com",
      password: "password-long-123",
      invite,
    });
    const b = (
      await (
        await call("/client/login", "", "POST", {
          email: "b@example.com",
          password: "password-long-123",
        })
      ).json()
    ).token;
    const ownInvite = (await (await call("/admin/invites", admin, "POST", {})).json()).invite;
    await call("/register", "", "POST", {
      email: "owner@example.com",
      password: "password-long-123",
      invite: ownInvite,
    });
    const a = (
      await (
        await call("/client/login", "", "POST", {
          email: "owner@example.com",
          password: "password-long-123",
        })
      ).json()
    ).token;
    const id = (
      await (
        await call("/accounts", a, "POST", {
          email: "mail@example.com",
          mode: "proxy",
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          ...clientCredential("secret"),
        })
      ).json()
    ).id;
    await authorizeFixture(app, id, "secret");
    const path = "/accounts/" + id + "/messages/1",
      q = "?uidValidity=7";
    const metadata = await (await call(path + q, a)).json();
    assert.equal(metadata.text, undefined);
    assert.equal(downloads, 0);
    const response = await call(path + "/body" + q, a);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition"), /^attachment/);
    assert.equal((await response.arrayBuffer()).byteLength, 3 * 1024 * 1024);
    assert.equal((await call(path + "/body" + q, b)).status, 404);
    assert.equal((await call(path + "/actions" + q, b, "POST", { action: "read" })).status, 404);
    const revision = async () =>
      (await app.db.prepare("SELECT revision FROM mailbox_revisions WHERE account_id=?").get(id))
        ?.revision ?? 0;
    const before = await revision();
    assert.equal(
      (
        await call(path + "/actions?uidValidity=8", a, "POST", {
          action: "read",
        })
      ).status,
      409,
    );
    assert.equal(await revision(), before, "a failed action must not make devices resync");
    assert.equal((await call(path + "/actions" + q, a, "POST", { action: "read" })).status, 200);
    assert.equal(changes, 1);
    assert.ok((await revision()) > before);

    const preparedResponse = await fetch(base + "/accounts/" + id + "/outbox", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + a,
        "Content-Type": "application/json",
        "Idempotency-Key": "http-send",
      },
      body: JSON.stringify({
        to: ["to@example.com"],
        subject: "HTTP send",
        text: "Hello",
        sentCopy: "provider",
        attachments: [{ filename: "test.txt", size: 3 }],
      }),
    });
    assert.equal(preparedResponse.status, 201);
    const prepared = await preparedResponse.json();
    assert.equal((await call("/outbox/" + prepared.id, b)).status, 404);
    let sent = await fetch(base + "/outbox/" + prepared.id, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + a,
        "Content-Type": "application/octet-stream",
      },
      body: "abc",
    });
    assert.equal((await sent.json()).state, "sent");
    assert.equal((await (await call("/outbox/" + prepared.id, a)).json()).state, "sent");
    await app.db.prepare("UPDATE accounts SET mode='direct' WHERE id=?").run(id);
    assert.equal((await call(path + "/actions" + q, a, "POST", { action: "read" })).status, 409);
    assert.equal((await call(path + "/body" + q, a)).status, 409);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
