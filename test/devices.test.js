import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp as createApp } from "./helpers.mjs";

test("separate admin identity, invitation registration, user-wide mailboxes and independent devices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-devices-"));
  let app;
  let base;
  async function start() {
    app = await createApp({ dataDir: dir, setupToken: "test" });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}/api`;
  }
  async function api(path, token, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token || ""}`,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  const password = "password-long-123";
  const login = (email, deviceName, deviceId) =>
    api("/client/login", "", "POST", { email, password, deviceName, deviceId, deviceInfo: { model: "iPhone", systemVersion: "27.0" } });
  await start();
  try {
    await api("/setup", "", "POST", {
      email: "admin@example.com",
      password,
      setupToken: "test",
    });
    const admin = (
      await api("/login", "", "POST", { email: "admin@example.com", password, deviceName: "Ignored manual name" })
    ).data.token;
    assert.equal((await api("/devices", admin)).data[0].name, "Safari · macOS");
    assert.equal((await api("/admin/push", admin)).data.mode, "official");
    assert.equal((await api("/admin/push", admin)).data.appId, "mohua");
    assert.equal(
      (
        await api("/admin/push", admin, "PATCH", {
          mode: "custom",
          customUrl: "http://localhost",
        })
      ).status,
      400,
    );
    assert.equal(
      (await api("/admin/push", admin, "PATCH", { mode: "disabled" })).status,
      200,
    );
    assert.equal(
      (await api("/admin/push/test", admin, "POST", {})).data.ready,
      false,
    );
    assert.equal(
      (await app.db.prepare("SELECT COUNT(*) n FROM users").get()).n,
      0,
    );
    assert.equal((await login("admin@example.com", "Admin phone")).status, 401);
    assert.equal((await api("/accounts", admin)).status, 403);
    assert.equal((await api("/accounts", admin, "POST", {})).status, 403);
    assert.equal((await api("/client-devices", admin)).status, 403);
    assert.equal(
      (
        await api("/register", "", "POST", {
          email: "owner@example.com",
          password,
        })
      ).status,
      403,
    );
    for (const email of ["owner@example.com", "other@example.com"]) {
      const invite = (await api("/admin/invites", admin, "POST", {})).data
        .invite;
      assert.equal(
        (await api("/register", "", "POST", { email, password, invite }))
          .status,
        201,
      );
      assert.equal(
        (
          await api("/register", "", "POST", {
            email: "reuse@example.com",
            password,
            invite,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await api("/login", "", "POST", {
          email: "owner@example.com",
          password,
        })
      ).status,
      401,
    );
    const first = (await login("owner@example.com", "Phone")).data;
    const second = (await login("owner@example.com", "Tablet")).data;
    const other = (await login("other@example.com", "Other phone")).data;
    const wrongPassword = await api("/client/login", "", "POST", {
      email: "owner@example.com",
      password: "incorrect",
      deviceName: "Impostor",
      deviceId: first.deviceId,
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal((await api("/me", first.token)).status, 200);
    const unrelated = (
      await login("other@example.com", "Separate installation", first.deviceId)
    ).data;
    assert.notEqual(unrelated.deviceId, first.deviceId);
    assert.equal((await api("/me", first.token)).status, 200);
    assert.equal((await api("/admin/health", first.token)).status, 403);
    for (const path of ["/pairings", "/pairings/claim"]) {
      assert.equal((await api(path, first.token, "POST", {})).status, 404);
    }
    const mailbox = (
      await api("/accounts", first.token, "POST", {
        email: "mail@example.com",
        mode: "proxy",
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        credential: "private-password",
      })
    ).data.id;
    assert.ok(mailbox);
    assert.equal(
      (await api(`/accounts/${mailbox}/access`, first.token)).status,
      200,
    );
    assert.equal((await api(`/accounts/${mailbox}/access`, admin)).status, 403);
    assert.equal(
      (await api(`/accounts/${mailbox}/access`, other.token)).status,
      404,
    );
    assert.equal((await api("/accounts", second.token)).data[0].id, mailbox);
    assert.deepEqual((await api("/accounts", other.token)).data, []);
    assert.equal(
      (await api(`/accounts/${mailbox}`, other.token, "DELETE")).status,
      404,
    );
    assert.equal(
      (await api(`/client-devices/${first.deviceId}`, other.token, "DELETE"))
        .status,
      404,
    );
    assert.equal(
      (
        await api("/client/ack", other.token, "POST", {
          accountId: mailbox,
          revision: 1,
        })
      ).status,
      404,
    );
    await api("/client/ack", first.token, "POST", {
      accountId: mailbox,
      revision: 1,
    });
    assert.equal(
      (await api("/client/sync", first.token)).data.mailboxes[0].syncPending,
      false,
    );
    assert.equal(
      (await api("/client/sync", second.token)).data.mailboxes[0].syncPending,
      true,
    );
    await app.devices.changed(mailbox);
    assert.equal(
      (
        await api("/client/ack", first.token, "POST", {
          accountId: mailbox,
          revision: 999,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await api("/client/push", first.token, "POST", {
          token: "a".repeat(64),
          environment: "sandbox",
        })
      ).status,
      400,
    );
    assert.equal(
      (await api("/client/push", first.token, "POST", { enabled: false }))
        .status,
      200,
    );
    assert.equal(
      (await api("/client/push/config", first.token)).data.enabled,
      false,
    );
    assert.equal((await api("/admin/push", first.token)).status, 403);
    assert.equal(
      (
        await app.db
          .prepare("SELECT push_token FROM client_devices WHERE id=?")
          .get(first.deviceId)
      ).push_token,
      null,
    );
    await app.close();
    await start();
    assert.equal(
      (await api("/client/sync", first.token)).data.mailboxes[0].revision,
      2,
    );
    const renewed = (
      await login("owner@example.com", "Renamed phone", first.deviceId)
    ).data;
    assert.equal(renewed.deviceId, first.deviceId);
    const namedDevices = (await api("/client-devices", renewed.token)).data;
    assert.equal(namedDevices.find(d => d.id === renewed.deviceId).name, "iPhone · iOS 27.0");
    assert.equal((await api(`/client-devices/${renewed.deviceId}`, renewed.token, "PATCH", { name: "Manual" })).status, 404);

    assert.equal((await api("/me", first.token)).status, 401);
    assert.equal((await api("/me", second.token)).status, 200);
    await api(`/client-devices/${renewed.deviceId}`, second.token, "DELETE");
    assert.equal((await api("/me", renewed.token)).status, 401);
    assert.equal((await api("/me", second.token)).status, 200);
    assert.equal(
      (
        await app.db
          .prepare("SELECT push_token FROM client_devices WHERE id=?")
          .get(first.deviceId)
      ).push_token,
      null,
    );
    await api(`/accounts/${mailbox}`, second.token, "DELETE");
    assert.equal(
      (await api("/client/sync", second.token)).data.mailboxes.length,
      0,
    );
    await api("/logout", second.token, "POST", {});
    assert.equal((await api("/me", second.token)).status, 401);
    assert.equal((await api("/me", other.token)).status, 200);
    const owners = (await api("/admin/users", admin)).data;
    assert.equal(owners.length, 2);
    const owner = owners.find((user) => user.email === "owner@example.com");
    const last = (await login(owner.email, "New phone")).data;
    await api(`/admin/users/${owner.id}`, admin, "PATCH", { active: false });
    assert.equal((await api("/me", last.token)).status, 401);
    assert.equal((await login(owner.email, "Blocked phone")).status, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
