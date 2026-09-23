import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as createApp } from "./helpers.mjs";
test("mail API authenticates, updates secrets and closes workers on user disable and account removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-api-"));
  const passwords = [];
  let closes = 0;
  class Fake extends EventEmitter {
    async connect() {}
    async mailboxOpen() {
      return { exists: 0, uidValidity: 1n };
    }
    async logout() {
      this.close();
    }
    close() {
      closes++;
      this.emit("close");
    }
  }
  const app = await createApp({
    dataDir: dir,
    setupToken: "test",
    mailOptions: {
      resolveHost: async () => "1.1.1.1",
      imapFactory: (o) => {
        passwords.push(o.auth.pass);
        return new Fake();
      },
      smtpFactory: () => ({ verify: async () => {}, close() {} }),
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const call = async (path, method = "GET", body, token) => {
    const r = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: r.status, data: await r.json() };
  };
  try {
    await call("/setup", "POST", {
      email: "admin@example.com",
      password: "long-password-123",
      setupToken: "test",
    });
    const admin = (
      await call("/login", "POST", {
        email: "admin@example.com",
        password: "long-password-123",
      })
    ).data;
    const invite = (await call("/admin/invites", "POST", {}, admin.token)).data
      .invite;
    await call("/register", "POST", {
      email: "user@example.com",
      password: "long-password-456",
      invite,
    });
    const user = (
      await call("/client/login", "POST", {
        email: "user@example.com",
        password: "long-password-456",
      })
    ).data;
    const id = (
      await call(
        "/accounts",
        "POST",
        {
          email: "mail@example.com",
          mode: "direct",
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          credential: "old-secret",
        },
        user.token,
      )
    ).data.id;
    assert.equal(
      (await call(`/accounts/${id}/verify`, "POST", {}, admin.token)).status,
      403,
    );
    assert.equal(
      (await call(`/accounts/${id}/verify`, "POST", {}, user.token)).data
        .connectionStatus,
      "verified",
    );
    assert.equal(
      (
        await call(
          `/accounts/${id}`,
          "PATCH",
          { credential: "new-secret" },
          user.token,
        )
      ).status,
      200,
    );
    await call(`/accounts/${id}/verify`, "POST", {}, user.token);
    assert.deepEqual(passwords, ["old-secret", "new-secret"]);
    await call(
      `/accounts/${id}/monitor`,
      "POST",
      { enabled: true },
      user.token,
    );
    assert.equal(app.mail.jobs.size, 1);
    await call(
      `/admin/users/${user.user.id}`,
      "PATCH",
      { active: false },
      admin.token,
    );
    assert.equal(app.mail.jobs.size, 0);
    assert.ok(closes >= 3);
    await call(
      `/admin/users/${user.user.id}`,
      "PATCH",
      { active: true },
      admin.token,
    );
    assert.equal(app.mail.jobs.size, 1);
    const again = (
      await call("/client/login", "POST", {
        email: "user@example.com",
        password: "long-password-456",
      })
    ).data;
    await call(`/accounts/${id}`, "DELETE", undefined, again.token);
    assert.equal(app.mail.jobs.size, 0);
    assert.equal(
      (await app.db.prepare("SELECT COUNT(*) n FROM accounts").get()).n,
      0,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
