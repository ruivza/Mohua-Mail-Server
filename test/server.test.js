import { clientCredential, authorizeFixture } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as createApp } from "./helpers.mjs";
test("tenant isolation, invite reuse, encrypted credentials and session revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-test-"));
  const app = await createApp({ dataDir: dir, setupToken: "setup-secret" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const call = async (path, method = "GET", body, token) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal(
      (
        await call("/setup", "POST", {
          email: "admin@example.com",
          password: "long-password-123",
          setupToken: "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/setup", "POST", {
          email: "admin@example.com",
          password: "long-password-123",
          setupToken: "setup-secret",
        })
      ).status,
      201,
    );
    const admin = (
      await call("/login", "POST", {
        email: "admin@example.com",
        password: "long-password-123",
      })
    ).data;
    const invite = (await call("/admin/invites", "POST", {}, admin.token)).data.invite;
    assert.equal(
      (
        await call("/register", "POST", {
          email: "user@example.com",
          password: "long-password-456",
          invite,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call("/register", "POST", {
          email: "other@example.com",
          password: "long-password-456",
          invite,
        })
      ).status,
      403,
    );
    const user = (
      await call("/client/login", "POST", {
        email: "user@example.com",
        password: "long-password-456",
      })
    ).data;
    assert.equal((await call("/admin/users", "GET", undefined, user.token)).status, 403);
    assert.equal((await call("/admin/health", "GET", undefined, user.token)).status, 403);
    assert.equal((await call("/admin/health/run", "POST", {}, user.token)).status, 403);
    assert.equal(
      (
        await call(
          "/admin/health/settings",
          "PATCH",
          { enabled: true, intervalMinutes: 60 },
          user.token,
        )
      ).status,
      403,
    );
    const health = (await call("/admin/health", "GET", undefined, admin.token)).data;
    assert.equal(
      (
        await call(
          "/admin/health/settings",
          "PATCH",
          { enabled: true, intervalMinutes: 60 },
          admin.token,
        )
      ).status,
      404,
    );
    assert.equal(health.samples.length, 1);
    assert.equal(health.settings, undefined);
    assert.equal(health.business.listeners.expected, 0);
    assert.equal(typeof health.traffic.requests, "number");
    assert.ok(!JSON.stringify(health).includes("credential"));
    const account = (
      await call(
        "/accounts",
        "POST",
        {
          email: "mail@example.com",
          mode: "proxy",
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          ...clientCredential("mail-secret-unique"),
        },
        user.token,
      )
    ).data;
    assert.ok(account.id);
    assert.equal(
      (await call("/accounts/" + account.id + "/folders", "GET", undefined, admin.token)).status,
      403,
    );
    const stats = (await call("/admin/health", "GET", undefined, admin.token)).data.counts;
    assert.deepEqual(stats, { users: 1, activeUsers: 1, mailboxes: 1 });
    assert.equal((await call("/accounts", "GET", undefined, admin.token)).status, 403);
    await call("/accounts/" + account.id, "DELETE", undefined, admin.token);
    const accounts = (await call("/accounts", "GET", undefined, user.token)).data;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].credential, undefined);
    assert.ok(
      !(await app.db.prepare("SELECT credential FROM accounts").get()).credential.includes(
        "mail-secret-unique",
      ),
    );
    await call("/devices/" + user.sessionId, "DELETE", undefined, user.token);
    assert.equal((await call("/me", "GET", undefined, user.token)).status, 401);
    // Signing a client session out revokes its device, which also ends its mailbox leases.
    assert.ok(
      (await app.db.prepare("SELECT revoked FROM client_devices WHERE id=?").get(user.deviceId))
        .revoked,
    );
    const again = (
      await call("/client/login", "POST", {
        email: "user@example.com",
        password: "long-password-456",
      })
    ).data;
    await call("/admin/users/" + again.user.id, "PATCH", { active: false }, admin.token);
    assert.equal((await call("/me", "GET", undefined, again.token)).status, 401);
    assert.equal(
      (
        await call("/client/login", "POST", {
          email: "user@example.com",
          password: "long-password-456",
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public readiness probe reports database failure without leaking details and recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-readiness-"));
  const app = await createApp({ dataDir: dir, setupToken: "setup-secret" });
  const query = app.db.query;
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    let response = await fetch(base + "/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "ok" });
    app.db.query = async () => {
      throw Error("private database credentials");
    };
    response = await fetch(base + "/healthz");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
    app.db.query = query;
    response = await fetch(base + "/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    response = await fetch(base + "/health");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
    response = await fetch(base + "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    await response.text();
    response = await fetch(base + "/app.js");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.ok((await response.text()).length > 0);
    response = await fetch(base + "/mail-test");
    assert.equal(response.status, 404);
    await response.text();
  } finally {
    app.db.query = query;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
