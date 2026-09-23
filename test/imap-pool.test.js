import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MailReader } from "../src/reader.js";

function fixture(options) {
  const clients = [];
  const mail = {
    async imap(account, job) {
      const client = new EventEmitter();
      Object.assign(client, {
        connections: 0,
        closed: false,
        selections: [],
        async connect() {
          this.connections++;
        },
        close() {
          this.closed = true;
          this.emit("close");
        },
        async list() {
          return [{ path: "INBOX" }];
        },
        async mailboxOpen(folder, options) {
          this.selections.push({ folder, ...options });
          return { uidValidity: 7n, uidNext: 10 };
        },
        async fetchAll() {
          return [];
        },
      });
      job.client = client;
      clients.push(client);
      return client;
    },
  };
  const account = {
    id: "a",
    user_id: "u",
    mode: "proxy",
    credential: "secret",
    imap_host: "mail.example.com",
    imap_port: 993,
  };
  return { reader: new MailReader(mail, options), clients, account };
}

test("sequential mailbox reads reuse one connection and select each folder explicitly", async () => {
  const f = await fixture();
  try {
    await f.reader.folders(f.account);
    await f.reader.list(f.account, {
      folder: "INBOX",
      limit: 25,
      validity: "7",
    });
    await f.reader.list(f.account, {
      folder: "Archive",
      limit: 25,
      validity: "7",
    });
    assert.equal(f.clients.length, 1);
    assert.equal(f.clients[0].connections, 1);
    assert.deepEqual(
      f.clients[0].selections.map((item) => item.folder),
      ["INBOX", "Archive"],
    );
    assert.equal(f.clients[0].closed, false);
  } finally {
    f.reader.close();
  }
  assert.equal(f.clients[0].closed, true);
});

test("pool isolates users, accounts and credential changes; invalidation closes idle connections", async () => {
  const f = await fixture();
  try {
    for (const account of [
      f.account,
      { ...f.account, user_id: "other" },
      { ...f.account, id: "b" },
      { ...f.account, credential: "new" },
    ]) {
      await f.reader.folders(account);
    }
    assert.equal(f.clients.length, 4);
    f.reader.invalidate("a");
    assert.equal(
      f.reader.pool.idle.some((entry) => entry.account === "a"),
      false,
    );
    assert.equal(f.clients[2].closed, false);
    await f.reader.folders({ ...f.account, credential: "new" });
    assert.equal(f.clients.length, 5);
  } finally {
    f.reader.close();
  }
});

test("simultaneous requests never share a selected mailbox; failed work is not reused or retried", async () => {
  const f = await fixture();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const first = f.reader.execute(f.account, { folder: "INBOX" }, async () => {
      await blocked;
      return "first";
    });
    await new Promise((resolve) => setImmediate(resolve));
    await f.reader.folders(f.account);
    assert.equal(f.clients.length, 2);
    release();
    await first;
    await assert.rejects(
      f.reader.execute(f.account, null, async () => {
        throw Error("failed mutation");
      }),
      { status: 502 },
    );
    assert.equal(f.clients.filter((client) => client.closed).length, 1);
  } finally {
    release();
    f.reader.close();
  }
});

test("abort and idle timeout discard sockets", async () => {
  const f = await fixture({ idleMs: 10 });
  try {
    await f.reader.folders(f.account);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.clients[0].closed, true);
    const controller = new AbortController();
    await assert.rejects(
      f.reader.execute(
        f.account,
        null,
        async () => {
          controller.abort();
        },
        controller.signal,
      ),
      { status: 499 },
    );
    assert.equal(f.reader.pool.idle.length, 0);
    assert.equal(f.reader.jobs.size, 0);
    assert.equal(f.clients[1].closed, true);
  } finally {
    f.reader.close();
  }
});
