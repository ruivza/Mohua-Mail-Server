import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers.mjs";
import { DeviceService } from "../src/devices.js";
import { PushService, retryAfterMs } from "../src/push.js";

async function fixture(send = async () => ({ status: 200 })) {
  const db = await createTestDatabase();
  await db.exec(`INSERT INTO users VALUES('one','one@example.com','hash','user',1),('two','two@example.com','hash','user',1);
    INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES('a','one','a@example.com','proxy','imap.example.com',993,'smtp.example.com',587,'encrypted'),('b','two','b@example.com','proxy','imap.example.com',993,'smtp.example.com',587,'encrypted');`);
  const devices = new DeviceService({
    db,
    seal: (value) => "encrypted:" + value,
  });
  let now = Date.now();
  const options = {
    db,
    decrypt: (value) => value.slice(10),
    provider: { send, validate: async () => ({ status: 200 }), close() {} },
    officialURL: "https://push.example.test",
    now: () => now,
    autoStart: false,
    random: () => 0,
    coalesceMs: 0,
    intervalMs: 1200000,
  };
  let push = new PushService(options);
  await push.initialize();
  devices.pushService = push;
  const enroll = async (user) =>
    await devices.own(
      user,
      (await devices.enroll(user, { name: "Phone", platform: "ios" })).deviceId,
    );
  return {
    db,
    devices,
    options,
    enroll,
    register: async (device, credential = "a".repeat(43)) =>
      await devices.push(device, {
        enabled: true,
        credential,
        revision: (await push.settings.current()).revision,
      }),
    get push() {
      return push;
    },
    advance(ms) {
      now += ms;
    },
    async restart() {
      await push.close();
      push = new PushService(options);
      await push.initialize();
      devices.pushService = push;
    },
    async close() {
      await push.close();
      await db.close();
    },
  };
}

test("durable queue coalesces changes, survives restart, retries and preserves in-flight changes", async () => {
  let count = 0,
    f;
  f = await fixture(async () => {
    count++;
    if (count === 1) return { status: 503 };
    if (count === 2) await f.devices.changed("a");
    return { status: 200 };
  });
  try {
    const device = await f.enroll("one");
    await f.register(device);
    for (let i = 0; i < 10; i++) await f.devices.changed("a");
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      1,
    );
    await f.push.flush();
    assert.equal(count, 1);
    assert.equal(
      (await f.db.prepare("SELECT attempts FROM push_jobs").get()).attempts,
      1,
    );
    await f.restart();
    await f.push.flush();
    assert.equal(count, 1);
    f.advance(65000);
    await f.push.flush();
    assert.equal(count, 2);
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      1,
    );
    f.advance(1200000);
    await f.push.flush();
    assert.equal(count, 3);
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("switching gateways and disabling a device invalidate credentials and queued work", async () => {
  const f = await fixture();
  try {
    const device = await f.enroll("one");
    await f.register(device);
    assert.equal((await f.devices.own("one", device.id)).push_token, null);
    assert.ok(
      (await f.devices.own("one", device.id)).push_credential.startsWith(
        "encrypted:",
      ),
    );
    const old = (await f.push.settings.current()).revision;
    await f.push.configure({
      mode: "custom",
      customUrl: "https://custom.example.test",
    });
    assert.notEqual((await f.push.settings.current()).revision, old);
    assert.equal((await f.devices.own("one", device.id)).push_credential, null);
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      0,
    );
    await assert.rejects(
      f.devices.push(device, {
        enabled: true,
        credential: "a".repeat(43),
        revision: old,
      }),
      /changed/,
    );
    await f.register(device);
    await f.devices.push(device, { enabled: false });
    assert.equal(
      await f.push.status(await f.devices.own("one", device.id)),
      "device_disabled",
    );
    await f.devices.changed("a");
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      0,
    );
    await f.push.configure({ mode: "disabled" });
    await f.devices.push(device, { enabled: true });
    assert.equal(
      await f.push.status(await f.devices.own("one", device.id)),
      "server_disabled",
    );
  } finally {
    await f.close();
  }
});

test("late delivery failure cannot clear a replacement credential", async () => {
  let f;
  f = await fixture(async (device) => {
    await f.register(device, "b".repeat(43));
    return { status: 410 };
  });
  try {
    const device = await f.enroll("one");
    await f.register(device);
    await f.push.flush();
    assert.equal(
      (await f.devices.own("one", device.id)).push_credential,
      "encrypted:" + "b".repeat(43),
    );
    await f.devices.revoke("one", device.id);
    await f.push.flush();
    assert.equal(
      (await f.db.prepare("SELECT count(*) n FROM push_jobs").get()).n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("disabling while gateway validation is running prevents late enrollment", async () => {
  const f = await fixture();
  try {
    const device = await f.enroll("one");
    let resume, started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    f.options.provider.validate = () =>
      new Promise((resolve) => {
        resume = resolve;
        started();
      });
    const enrolling = f.register(device);
    await ready;
    await f.devices.push(device, { enabled: false });
    resume({ status: 200 });
    await assert.rejects(enrolling, /changed/);
    assert.equal((await f.devices.own("one", device.id)).push_credential, null);
    assert.equal(
      await f.push.status(await f.devices.own("one", device.id)),
      "device_disabled",
    );
  } finally {
    await f.close();
  }
});


test("gateway Retry-After survives restart and blocks early delivery", async () => {
  let sends = 0;
  const f = await fixture(async () => { sends++; return sends === 1 ? { status: 429, retryAfter: '7200' } : { status: 200 }; });
  try {
    const device = await f.enroll('one'); await f.register(device); await f.push.flush();
    assert.equal(sends, 1); await f.restart();
    f.advance(7199000); await f.push.flush(); assert.equal(sends, 1);
    f.advance(1000); await f.push.flush(); assert.equal(sends, 2);
  } finally { await f.close(); }
});

test("temporary validation errors preserve credentials and expose cooldown to the client", async () => {
  const f = await fixture();
  try {
    const device = await f.enroll('one'); await f.register(device);
    f.options.provider.validate = async () => ({ status: 429, retryAfter: '7200' });
    await assert.rejects(f.register(device), error => error.status === 429 && error.retryAfter === 7200);
    assert.equal((await f.devices.own('one', device.id)).push_credential, 'encrypted:' + 'a'.repeat(43));
    f.options.provider.validate = async () => ({ status: 503, retryAfter: '120' });
    await assert.rejects(f.register(device), error => error.status === 503 && error.retryAfter === 120);
  } finally { await f.close(); }
});

test("Retry-After parsing rejects malformed delays and caps remote values", () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs('Thu, 24 Sep 2026 00:02:00 GMT', now), 120000);
  for (const value of ['-1', 'NaN', 'Infinity', 'garbage', undefined]) assert.equal(retryAfterMs(value, now), 0);
  assert.equal(retryAfterMs('9999999999', now), 86400000);
});
