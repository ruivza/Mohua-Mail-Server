import { Readable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MailReader, readOptions, splitStructure } from "../src/reader.js";
const raw = Buffer.from(
  'From: Sender <sender@example.com>\r\nTo: user@example.com\r\nSubject: Test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello safe reader\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="test.txt"\r\n\r\nattachment bytes\r\n--x--\r\n',
);
test("HTML alternative is preferred and inline CID parts retain stable attachment IDs", () => {
  const parts = splitStructure({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        childNodes: [
          { part: "1.1", type: "text/plain" },
          {
            type: "multipart/related",
            childNodes: [
              { part: "1.2.1", type: "text/html" },
              {
                part: "1.2.2",
                type: "image/png",
                id: "<logo@example>",
                disposition: "inline",
                size: 123,
              },
              {
                part: "1.2.3",
                type: "image/jpeg",
                id: "<photo@example>",
                disposition: "inline",
                dispositionParameters: { filename: "photo.jpg" },
              },
            ],
          },
        ],
      },
      {
        part: "2",
        type: "message/rfc822",
        childNodes: [{ part: "2.1", type: "text/html" }],
      },
      {
        part: "3",
        type: "text/html",
        disposition: "attachment",
        dispositionParameters: { filename: "report.html" },
      },
    ],
  });
  assert.equal(parts.body.part, "1.2.1");
  assert.deepEqual(
    parts.attachments.map((a) => a.part),
    ["1.2.2", "1.2.3", "2", "3"],
  );
  assert.equal(parts.attachments[0].contentId, "<logo@example>");
  assert.equal(parts.attachments[1].contentId, "<photo@example>");
});
test("a lone named HTML part remains readable as the message body", () => {
  const parts = splitStructure({
    type: "multipart/mixed",
    childNodes: [{
      part: "1", type: "text/html", disposition: "attachment",
      dispositionParameters: { filename: "message.html" },
    }],
  });
  assert.equal(parts.body.part, "1");
  assert.deepEqual(parts.attachments, []);
});
test("a named HTML body keeps separate inline images available", () => {
  const parts = splitStructure({
    type: "multipart/related",
    childNodes: [
      { part: "1", type: "text/html", parameters: { name: "body.html" } },
      { part: "2", type: "image/png", id: "<logo>", disposition: "inline" },
    ],
  });
  assert.equal(parts.body.part, "1");
  assert.deepEqual(parts.attachments.map((part) => part.part), ["2"]);
});
function fixture() {
  let closed = 0;
  const client = {
    connect: async () => {},
    close: () => closed++,
    mailboxOpen: async (_, o) => {
      assert.equal(o.readOnly, true);
      return { uidValidity: 123n, uidNext: 206 };
    },
    list: async () => [
      { path: "INBOX", name: "Inbox", flags: new Set() },
      { path: "root", flags: new Set(["\\Noselect"]) },
    ],
    fetchAll: async (range, query, options) => {
      assert.equal(options.uid, true);
      return [205, 204, 202].map((uid) => ({
        uid,
        envelope: { subject: "s" },
        flags: new Set(),
        size: 100,
      }));
    },
    fetchOne: async (uid, q) => {
      assert.equal(q.source, undefined);
      return uid === 99
        ? false
        : {
            size: 100 * 1024 * 1024,
            envelope: { subject: "Test" },
            bodyStructure: {
              type: "multipart/mixed",
              childNodes: [
                { part: "1", type: "text/plain" },
                {
                  part: "2",
                  type: "application/octet-stream",
                  disposition: "attachment",
                  dispositionParameters: { filename: "test.txt" },
                  size: 99 * 1024 * 1024,
                },
              ],
            },
          };
    },
    download: async (uid, part, opts) => ({
      meta: {},
      content: Readable.from([
        Buffer.from(part === "1" ? "hello safe reader" : "attachment bytes"),
      ]),
    }),
  };
  const mail = {
    imap: async (_, job) => {
      job.client = client;
      return client;
    },
    deadline: async (_, op) => op(),
  };
  return {
    reader: new MailReader(mail, { idleMs: 0 }),
    account: { mode: "proxy", user_id: "u" },
    client,
    get closed() {
      return closed;
    },
  };
}
test("UID pagination is descending and exposes stable next cursor", async () => {
  const f = await fixture();
  const result = await f.reader.list(f.account, { limit: 2 }, null);
  assert.deepEqual(
    result.items.map((m) => m.uid),
    [205, 204],
  );
  assert.equal(result.nextBefore, 204);
  assert.equal(result.uidValidity, "123");
  assert.equal(f.closed, 1);
});
test("direct mode and stale UIDVALIDITY are rejected", async () => {
  const f = await fixture();
  await assert.rejects(f.reader.folders({ ...f.account, mode: "direct" }), {
    status: 409,
  });
  await assert.rejects(
    f.reader.list(f.account, { validity: "999", limit: 2 }),
    { status: 409 },
  );
});
test("read text and download decoded MIME attachment without HTML rendering", async () => {
  const f = await fixture();
  const message = await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    null,
  );
  assert.equal(message.body.contentType, "text/plain");
  assert.equal(message.text, undefined);
  assert.equal(message.html, undefined);
  assert.equal(message.attachments[0].filename, "test.txt");
  let data = "";
  await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    0,
    null,
    async (file) => {
      for await (const chunk of file.content) data += chunk.toString();
    },
  );
  assert.match(data, /attachment bytes/);
});
test("large messages remain readable and missing parts fail safely", async () => {
  const f = await fixture();
  await assert.rejects(
    f.reader.message(f.account, { validity: "123" }, 99, null),
    { status: 404 },
  );
  await assert.rejects(
    f.reader.message(f.account, { validity: "123" }, 205, 9),
    { status: 404 },
  );
  const result = await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    null,
  );
  assert.equal(result.body.contentType, "text/plain");
  assert.equal(result.attachments[0].size, 99 * 1024 * 1024);
});
test("reject invalid query bounds and unselectable folders", async () => {
  assert.throws(() => readOptions(new URLSearchParams("limit=100")), {
    status: 400,
  });
  assert.throws(() => readOptions(new URLSearchParams("before=0")), {
    status: 400,
  });
  const f = await fixture();
  assert.equal((await f.reader.folders(f.account)).length, 1);
});

test("large attachment streams in bounded chunks without downloading body", async () => {
  const f = await fixture();
  let produced = 0;
  const total = 12 * 1024 * 1024;
  f.client.download = async (uid, part, options) => {
    assert.equal(part, "2");
    assert.equal(options.maxBytes, undefined);
    return {
      content: Readable.from(
        (async function* () {
          while (produced < total) {
            produced += 65536;
            yield Buffer.alloc(65536, 42);
          }
        })(),
      ),
    };
  };
  let received = 0;
  await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    0,
    null,
    async (file) => {
      for await (const chunk of file.content) {
        assert.ok(chunk.length <= 65536);
        received += chunk.length;
      }
    },
  );
  assert.equal(received, total);
  assert.equal(f.closed, 1);
});
test("stream consumer failure closes IMAP and frees concurrency slot", async () => {
  const f = await fixture();
  await assert.rejects(
    f.reader.message(f.account, { validity: "123" }, 205, 0, null, async () => {
      throw Error("client disconnected");
    }),
    { status: 502 },
  );
  assert.equal(f.closed, 1);
  assert.equal(f.reader.jobs.size, 0);
});

test("body streams beyond old limit and metadata never downloads body", async () => {
  const f = await fixture();
  let received = 0;
  f.client.download = async (uid, part, options) => {
    assert.equal(part, "1");
    assert.equal(options.maxBytes, undefined);
    return {
      content: Readable.from(
        (async function* () {
          for (let i = 0; i < 64; i++) yield Buffer.alloc(65536, 97);
        })(),
      ),
    };
  };
  const meta = await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    null,
  );
  assert.equal(meta.text, undefined);
  await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    "body",
    null,
    async (file) => {
      for await (const chunk of file.content) received += chunk.length;
    },
  );
  assert.equal(received, 4 * 1024 * 1024);
});

test("mail actions use UID flags and special-use folders, rejecting stale and unsafe moves", async () => {
  const f = await fixture(),
    calls = [];
  f.client.mailboxOpen = async (path, o) => {
    assert.equal(o.readOnly, false);
    return { uidValidity: 123n };
  };
  f.client.capabilities = new Set(["MOVE"]);
  f.client.list = async () => [
    { path: "INBOX" },
    { path: "Bin", specialUse: "\\Trash" },
    { path: "Saved", specialUse: "\\Archive" },
  ];
  f.client.messageFlagsAdd = async (...args) => {
    calls.push(args);
    return true;
  };
  f.client.messageFlagsRemove = f.client.messageFlagsAdd;
  f.client.messageMove = f.client.messageFlagsAdd;
  const o = { folder: "INBOX", validity: "123" };
  for (const action of ["read", "unread", "flag", "unflag", "archive", "trash"])
    await f.reader.mutate(f.account, o, 205, { action });
  assert.deepEqual(calls[0], [205, ["\\Seen"], { uid: true }]);
  assert.deepEqual(calls[2], [205, ["\\Flagged"], { uid: true }]);
  assert.deepEqual(calls[4], [205, "Saved", { uid: true }]);
  assert.deepEqual(calls[5], [205, "Bin", { uid: true }]);
  await assert.rejects(
    f.reader.mutate(f.account, { ...o, validity: "9" }, 205, {
      action: "read",
    }),
    { status: 409 },
  );
  await assert.rejects(
    f.reader.mutate(f.account, o, 205, {
      action: "move",
      destination: "unknown",
    }),
    { status: 400 },
  );
  await assert.rejects(
    f.reader.mutate(f.account, o, 205, { action: "trash" }, null, () => {
      throw Object.assign(Error("revoked"), { status: 401 });
    }),
    { status: 401 },
  );
  f.client.capabilities.clear();
  await assert.rejects(
    f.reader.mutate(f.account, o, 205, { action: "trash" }),
    { status: 409 },
  );
  assert.equal(calls.length, 6);
});

test("metadata reports authoritative flags without reading body", async () => {
  const f = await fixture();
  let downloaded = false;
  f.client.fetchOne = async (uid, query) => {
    assert.equal(query.flags, true);
    return {
      flags: new Set(["\\Seen", "\\Flagged"]),
      bodyStructure: { type: "text/plain" },
      envelope: { subject: "flags" },
    };
  };
  f.client.download = async () => {
    downloaded = true;
    throw Error("unexpected download");
  };
  const result = await f.reader.message(
    f.account,
    { validity: "123" },
    205,
    null,
  );
  assert.deepEqual(result.flags, ["\\Seen", "\\Flagged"]);
  assert.equal(downloaded, false);
});

test("incremental sync bounds UID holes and fetches only flags for known messages", async () => {
  const f = await fixture();
  const calls = [];
  f.client.mailboxOpen = async () => ({ uidValidity: 123n, uidNext: 4000 });
  f.client.fetchAll = async (range, query) => {
    calls.push({ range, query });
    if (query.envelope)
      return [1200, 1205, 3000].map((uid) => ({
        uid,
        envelope: { subject: "new" },
      }));
    return [{ uid: 99, flags: new Set(["\\Seen", "\\Flagged"]) }, { uid: 7 }];
  };
  const result = await f.reader.sync(f.account, {
    folder: "INBOX",
    uidValidity: "123",
    after: 205,
    known: [99, 100],
  });
  assert.equal(result.highWater, 1205);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.items.map((m) => m.uid),
    [1200, 1205],
  );
  assert.deepEqual(result.existing, [
    { uid: 99, flags: ["\\Seen", "\\Flagged"] },
  ]);
  assert.deepEqual(calls, [
    {
      range: "206:1205",
      query: { uid: true, envelope: true, flags: true, size: true },
    },
    { range: "99,100", query: { uid: true, flags: true } },
  ]);
  f.client.fetchAll = async () => [];
  const holes = await f.reader.sync(f.account, {
    folder: "INBOX",
    uidValidity: "123",
    after: 1205,
    known: [],
  });
  assert.equal(holes.highWater, 2205);
  assert.deepEqual(holes.items, []);
});

test("incremental sync rejects malformed cursors, changed epochs and regressed UIDNEXT", async () => {
  const f = await fixture();
  const input = { folder: "INBOX", uidValidity: "123", after: 205, known: [] };
  for (const change of [
    { after: -1 },
    { known: [1, 1] },
    { known: [206] },
    { known: ["1:*"] },
    { known: Array.from({ length: 501 }, (_, i) => i + 1), after: 1000 },
    { uidValidity: "" },
    { folder: "bad\0" },
  ]) {
    assert.throws(() => f.reader.sync(f.account, { ...input, ...change }), {
      status: 400,
    });
  }
  await assert.rejects(
    f.reader.sync(f.account, { ...input, uidValidity: "124" }),
    { status: 409 },
  );
  await assert.rejects(f.reader.sync(f.account, { ...input, after: 206 }), {
    status: 409,
  });
  f.client.fetchAll = async () => {
    throw Error("must not fetch an empty UID set");
  };
  const unchanged = await f.reader.sync(f.account, input);
  assert.equal(unchanged.highWater, 205);
  assert.equal(unchanged.hasMore, false);
  assert.deepEqual(unchanged.existing, []);
});
