import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers.mjs";
import { HealthService, describeProbeError } from "../src/health.js";
const make = async (probe) => {
  const db = await createTestDatabase();
  const service = new HealthService({
    db,
    seal: (x) => "encrypted:" + x,
    decrypt: (x) => x.slice(10),
    mail: { closed: false },
    probe,
  });
  await service.initialize();
  return { db, service };
};
test("resource history and manual diagnostics reject concurrent checks", async () => {
  let finish, readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const f = await make(async ({ stage }) => {
    await stage("imap_read");
    await new Promise((r) => {
      finish = r;
      readyResolve();
    });
  });
  try {
    assert.equal((await f.service.summary()).samples.length, 1);
    assert.equal((await f.service.summary()).settings, undefined);
    assert.deepEqual(Object.keys((await f.service.summary()).samples[0]).sort(), ["at", "cpu", "memory"]);
    await f.service.run();
    await assert.rejects(async () => await f.service.run(), /already running/);
    await ready;
    finish();
    await f.service.pending;
    const run = (await f.service.summary()).runs[0];
    assert.equal(run.status, "ok");
    assert.equal(run.stage, "imap_read");
    assert.ok(
      !JSON.stringify(await f.service.summary()).includes("encrypted:"),
    );
  } finally {
    await f.service.close();
    await f.db.close();
  }
});
test("external failures remain distinct from application failures", async () => {
  const f = await make(async () => {
    throw Object.assign(Error("secret"), { code: "ECONNREFUSED" });
  });
  try {
    await f.service.run();
    await f.service.pending;
    assert.equal((await f.service.summary()).runs[0].status, "external_error");
    assert.ok(!JSON.stringify(await f.service.summary()).includes("secret"));
  } finally {
    await f.service.close();
    await f.db.close();
  }
});
test("shutdown aborts self-test; restart marks unfinished run unknown", async () => {
  const f = await make(
    async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(Error("aborted"))),
      ),
  );
  await f.service.run();
  await f.service.close();
  const restored = new HealthService({
    db: f.db,
    seal: (x) => x,
    decrypt: (x) => x,
    mail: { closed: false },
    probe: async () => {},
  });
  await restored.initialize();
  try {
    assert.equal((await restored.summary()).runs[0].status, "unknown");
    assert.equal((await restored.summary()).runs[0].stage, "interrupted");
  } finally {
    await restored.close();
    await f.db.close();
  }
});

test("diagnostics distinguish local permissions without exposing upstream secrets", () => {
  assert.equal(
    describeProbeError({ code: "ESOCKET", errno: -4048, message: "secret" })
      .status,
    "error",
  );
  assert.match(describeProbeError({ code: "EAUTH" }).detail, /EAUTH/);
  assert.ok(
    !JSON.stringify(
      describeProbeError({ code: "UNKNOWN", message: "password secret" }),
    ).includes("secret"),
  );
});

test('legacy scheduled self-tests no longer send mail during resource sampling', async () => {
  const db = await createTestDatabase();
  let calls=0;
  await db.exec("INSERT INTO service_settings VALUES('enabled','true'),('interval','15')");
  const service = new HealthService({db,seal:x=>x,decrypt:x=>x,mail:{closed:false},intervalMs:5,probe:async()=>{calls++;}});
  try {
    await service.initialize();
    await new Promise(r=>setTimeout(r,35));
    assert.equal(calls,0);
    assert.equal((await db.prepare('SELECT count(*) n FROM health_probe').get()).n,0);
  } finally {await service.close();await db.close();}
});
