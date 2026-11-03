import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../src/database.js";
import { AuthService, hashToken } from "../src/auth.js";
import { createTestDatabase, createTestApp } from "./helpers.mjs";

test("PostgreSQL rollback is isolated from simultaneous requests and preserves millisecond timestamps", async () => {
  const db = await createTestDatabase();
  let release, entered;
  const ready = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  try {
    const failing = db.transaction(async () => {
      await db.prepare("INSERT INTO invites VALUES(?,?)").run("rollback", Date.now());
      entered();
      await gate;
      throw Error("rollback requested");
    });
    const rejected = assert.rejects(failing, /rollback requested/);
    await ready;
    const timestamp = Date.now() + 86400000;
    await db.prepare("INSERT INTO invites VALUES(?,?)").run("independent", timestamp);
    release();
    await rejected;
    assert.equal(
      await db.prepare("SELECT * FROM invites WHERE token_hash='rollback'").get(),
      undefined,
    );
    assert.equal(
      (await db.prepare("SELECT expires FROM invites WHERE token_hash='independent'").get())
        .expires,
      timestamp,
    );
    const other = new Database(
      process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      db.schema,
    );
    await db.claimOwner(() => {});
    try {
      await assert.rejects(
        other.claimOwner(() => {}),
        /Another Mohua/,
      );
    } finally {
      await other.close();
    }
  } finally {
    release?.();
    await db.close();
  }
});

test("concurrent setup and invite redemption each admit exactly one request", async () => {
  const db = await createTestDatabase(),
    auth = new AuthService(db, "setup");
  try {
    const setup = await Promise.allSettled(
      [1, 2].map((n) =>
        auth.setup({
          email: `admin${n}@example.com`,
          password: "test-password-123",
          setupToken: "setup",
        }),
      ),
    );
    assert.equal(setup.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(setup.find((r) => r.status === "rejected").reason.status, 409);
    await db
      .prepare("INSERT INTO invites VALUES(?,?)")
      .run(hashToken("single"), Date.now() + 60000);
    const registrations = await Promise.allSettled(
      [1, 2].map((n) =>
        auth.register({
          email: `user${n}@example.com`,
          password: "test-password-123",
          invite: "single",
        }),
      ),
    );
    assert.equal(registrations.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(registrations.find((r) => r.status === "rejected").reason.status, 403);
    assert.equal((await db.prepare("SELECT count(*) n FROM users").get()).n, 1);
  } finally {
    await db.close();
  }
});

test("server restart keeps PostgreSQL records; losing the encryption key fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mohua-pg-restart-"));
  let app;
  try {
    app = await createTestApp({ dataDir: dir, setupToken: "setup" });
    const now = Date.now();
    await app.db.prepare("INSERT INTO invites VALUES(?,?)").run("persistent", now);
    await app.close();
    app = null;
    app = await createTestApp({ dataDir: dir, setupToken: "setup" });
    assert.equal(
      (await app.db.prepare("SELECT expires FROM invites WHERE token_hash='persistent'").get())
        .expires,
      now,
    );
    await app.close();
    app = null;
    const keyPath = join(dir, "master.key"),
      key = readFileSync(keyPath);
    writeFileSync(keyPath, Buffer.alloc(32));
    await assert.rejects(createTestApp({ dataDir: dir, setupToken: "setup" }), /encryption key/);
    writeFileSync(keyPath, key);
    app = await createTestApp({ dataDir: dir, setupToken: "setup" });
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mailbox monitoring defaults on and legacy migration runs only once", async () => {
  const db = await createTestDatabase();
  try {
    await db
      .prepare("INSERT INTO users VALUES('monitor-user','monitor@example.test','unused','user',1)")
      .run();
    await db
      .prepare(
        "INSERT INTO accounts(id,user_id,email,mode,imap_host,imap_port,smtp_host,smtp_port,credential) VALUES('monitor-account','monitor-user','mail@example.test','proxy','imap.example.test',993,'smtp.example.test',465,'unused')",
      )
      .run();
    const enabled = async () =>
      (await db.prepare("SELECT monitor_enabled FROM accounts WHERE id='monitor-account'").get())
        .monitor_enabled;
    assert.equal(await enabled(), 1);
    await db.prepare("UPDATE accounts SET monitor_enabled=0 WHERE id='monitor-account'").run();
    await db
      .prepare("DELETE FROM schema_migrations WHERE name='default-mailbox-monitoring-v1'")
      .run();
    await db.initialize();
    assert.equal(await enabled(), 1);
    await db.prepare("UPDATE accounts SET monitor_enabled=0 WHERE id='monitor-account'").run();
    await db.initialize();
    assert.equal(await enabled(), 0);
  } finally {
    await db.close();
  }
});

test("foreign-key and mailbox cleanup indexes exist and are recreated on restart", async () => {
  const db = await createTestDatabase();
  try {
    const expected = [
      ["mailbox_source_links", "message_id"],
      ["mailbox_writebacks", "message_id"],
      ["device_mailboxes", "account_id"],
      ["outbox", "account_id"],
    ];
    // Leading index column per table; a composite primary key that starts elsewhere does not count.
    const leading = async () =>
      (
        await db
          .prepare("SELECT tablename,indexdef FROM pg_indexes WHERE schemaname=current_schema()")
          .all()
      ).map((r) => [r.tablename, r.indexdef.match(/USING \w+ \((\w+)/)?.[1]].join("."));
    const before = await leading();
    for (const [table, column] of expected)
      assert.ok(before.includes(table + "." + column), `${table}(${column})`);
    // An existing deployment without the indexes gains them on the next initialize.
    await db.exec(
      "DROP INDEX source_links_message, writebacks_message, device_mailboxes_account, outbox_account",
    );
    await db.initialize();
    const after = await leading();
    for (const [table, column] of expected)
      assert.ok(after.includes(table + "." + column), `${table}(${column}) after restart`);
  } finally {
    await db.close();
  }
});
