import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayProvider } from "../src/gateway.js";
const credential = "s".repeat(43),
  ticket = "t".repeat(43);
function fixture() {
  let config = {
    gatewayUrl: "https://push.example.test",
    appId: "mohua",
    serverId: "server-one",
    revision: "revision-one",
  };
  const calls = [];
  const settings = { officialURL: config.gatewayUrl, current: async () => ({ ...config }) };
  const transport = {
    request: async (origin, path, options) => {
      calls.push({ origin, path, ...options });
      return { status: 200, body: { ticket }, retryAfter: "60" };
    },
    close() {},
  };
  return {
    provider: new GatewayProvider(settings, transport, { credential, origin: config.gatewayUrl }),
    config,
    calls,
    transport,
  };
}
test("server secret stays at its configured origin, ticket is scoped to the authenticated device", async () => {
  const f = fixture();
  const r = await f.provider.registrationTicket({ id: "phone" });
  assert.equal(r.ticket, ticket);
  assert.ok(!JSON.stringify(r).includes(credential));
  assert.deepEqual(f.calls[0].body, { appId: "mohua", serverId: "server-one", deviceId: "phone" });
  assert.equal(f.calls[0].credential, credential);
  await f.provider.validate({ id: "phone" }, "device-grant");
  assert.equal(f.calls[1].credential, "device-grant");
  assert.equal(f.calls[1].serverCredential, credential);
  f.config.gatewayUrl = "https://custom.example.test";
  assert.equal((await f.provider.registrationTicket({ id: "phone" })).ticket, null);
  assert.equal(f.calls.length, 2);
  await f.provider.send({ id: "phone" }, "device-grant");
  assert.equal(f.calls[2].serverCredential, "");
});
test("ticket errors retain retry semantics, reject redirects and detect config changes", async () => {
  const f = fixture();
  f.transport.request = async () => ({ status: 429, body: {}, retryAfter: "123" });
  await assert.rejects(
    f.provider.registrationTicket({ id: "phone" }),
    (e) => e.status === 429 && e.retryAfter === 123,
  );
  f.transport.request = async () => ({ status: 302, body: {} });
  await assert.rejects(f.provider.registrationTicket({ id: "phone" }), (e) => e.status === 403);
  f.transport.request = async () => {
    f.config.revision = "changed";
    return { status: 200, body: { ticket } };
  };
  await assert.rejects(f.provider.registrationTicket({ id: "phone" }), (e) => e.status === 409);
});

test("ticket HTTP endpoint binds to session device and rejects unauthenticated callers", async () => {
  const { createTestApp } = await import("./helpers.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mohua-ticket-"));
  let received;
  const app = await createTestApp({
    dataDir: dir,
    setupToken: "fixture",
    pushOptions: {
      autoStart: false,
      provider: {
        registrationTicket: async (device) => {
          received = device.id;
          return { ticket, revision: "rev" };
        },
        close() {},
      },
    },
  });
  try {
    await app.db.exec("INSERT INTO users VALUES('u','u@example.com','fixture-hash','user',1)");
    const device = await app.devices.enroll("u", { name: "Phone", platform: "ios" });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + app.server.address().port + "/api/client/push/ticket";
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + device.token },
      body: JSON.stringify({ deviceId: "victim" }),
    });
    assert.equal(response.status, 200);
    assert.equal(received, device.deviceId);
    assert.deepEqual(await response.json(), { ticket, revision: "rev" });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
