import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ArchiveSync } from "../src/archive-sync.js";

const raw = Buffer.from("From: sender@example.test\r\nSubject: fixture\r\n\r\nbody\r\n");
const failure = (status) => Object.assign(Error("capture failed"), { status });

// One provider folder and an in-memory archive store; capture runs the real download path.
function fixture({ uids, ...options }) {
  const state = {
    uids,
    saved: new Set(),
    states: [],
    cursor: null,
    probes: 0,
    downloads: new Map(),
    broken: new Map(), // uid -> error thrown by the original download
    sizes: new Map(), // uid -> reported RFC822.SIZE
    content: new Map(), // uid -> bytes actually delivered
    tails: new Map(), // uid -> bytes answered past the delivered end
  };
  const store = {
    async call(op, values) {
      if (op === "state") state.states.push(values.state);
      if (op === "writebackNext") return null;
      if (op === "folder") return { cursor: state.cursor };
      if (op === "cursor") state.cursor = values.cursor;
      if (op === "existsMany")
        return { complete: values.uids.filter((uid) => state.saved.has(uid)) };
      if (op === "begin") return { id: "draft-" + values.sourceUid, complete: false };
      if (op === "finish") state.saved.add(Number(values.id.slice(6)));
      return {};
    },
  };
  const client = {
    async fetchOne(uid, query) {
      if (!state.uids.includes(uid)) return false;
      if (query.source) {
        state.probes++;
        return { uid, source: state.tails.get(uid) ?? Buffer.alloc(0) };
      }
      const bytes = state.content.get(uid) ?? raw;
      return {
        uid,
        size: state.sizes.get(uid) ?? bytes.length,
        flags: new Set(),
        envelope: {
          subject: "fixture",
          messageId: `<${uid}@example.test>`,
          from: [{ address: "sender@example.test" }],
          date: new Date(0),
        },
        bodyStructure: { type: "text/plain", part: "1", size: 6 },
      };
    },
    async download(uid, part) {
      if (part === undefined) {
        state.downloads.set(uid, (state.downloads.get(uid) || 0) + 1);
        if (state.broken.has(uid)) throw state.broken.get(uid);
      }
      return {
        content: Readable.from([
          part === undefined ? (state.content.get(uid) ?? raw) : Buffer.from("body\r\n"),
        ]),
      };
    },
  };
  const reader = {
    async folders() {
      return [{ path: "INBOX", name: "Inbox" }];
    },
    async list(account, o) {
      const below = state.uids
        .filter((uid) => o.before === null || uid < o.before)
        .sort((a, b) => b - a);
      const items = below.slice(0, o.limit).map((uid) => ({ uid }));
      return {
        uidValidity: "7",
        highWater: Math.max(0, ...state.uids),
        items,
        nextBefore: below.length > o.limit ? items.at(-1).uid : null,
      };
    },
    async execute(account, o, operation) {
      return operation(client, { uidValidity: 7n }, () => {});
    },
  };
  const sync = new ArchiveSync({
    reader,
    store,
    crypto: { seal: () => "sealed" },
    leases: { entries: new Map() },
    ...options,
  });
  const account = { id: "account", sync_enabled: 1 };
  return { sync, state, run: () => sync.run(account, new AbortController().signal) };
}
const sorted = (set) => [...set].sort((a, b) => a - b);

test("a message that keeps failing is set aside after three runs and the folder keeps progressing", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const f = fixture({ uids: [1, 2, 3] });
  f.state.broken.set(2, failure(502));
  for (let run = 1; run <= 2; run++) {
    await f.run();
    assert.deepEqual(
      sorted(f.state.saved),
      [1],
      "later messages wait while the failure may be transient",
    );
    assert.equal(f.state.states.at(-1), "error");
    assert.equal(f.state.cursor, null);
  }
  await f.run();
  assert.deepEqual(sorted(f.state.saved), [1, 3]);
  assert.equal(
    JSON.parse(f.state.cursor).before,
    null,
    "history completes past the set-aside message",
  );
  assert.equal(f.sync.skippedCount("account"), 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /INBOX|fixture|example\.test|account/);
  await f.run();
  assert.equal(f.state.downloads.get(2), 3, "a set-aside message is not downloaded again");
  assert.equal(f.state.states.at(-1), "error", "the account keeps reporting the gap");
});

test("a set-aside message in an older history page does not stop the cursor", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = fixture({ uids: Array.from({ length: 120 }, (_, i) => i + 1), maxMessages: 1000 });
  f.state.broken.set(30, failure(422));
  for (let run = 0; run < 2; run++) {
    await f.run();
    assert.equal(f.state.saved.size, 59, "the page holding the failure is retried, not skipped");
  }
  await f.run();
  assert.equal(f.state.saved.size, 119);
  assert.equal(f.state.saved.has(30), false);
  assert.equal(JSON.parse(f.state.cursor).before, null);
  assert.equal(f.state.downloads.get(30), 3);
});

test("an RFC822.SIZE mismatch is accepted only when nothing follows the downloaded bytes", async () => {
  const f = fixture({ uids: [1, 2, 3, 4] });
  f.state.sizes.set(1, raw.length + 7); // counted with different line endings
  f.state.sizes.set(2, raw.length - 3);
  f.state.tails.set(2, raw); // a server that ignores partial ranges returns the whole source
  f.state.sizes.set(3, raw.length);
  f.state.content.set(3, raw.subarray(0, raw.length - 5)); // the download ended early
  f.state.tails.set(3, raw.subarray(raw.length - 5, raw.length - 4));
  await f.run();
  assert.deepEqual(sorted(f.state.saved), [1, 2]);
  assert.equal(f.state.probes, 3);
  assert.equal(f.state.states.at(-1), "error");
  f.state.content.delete(3);
  f.state.tails.delete(3);
  await f.run();
  assert.deepEqual(sorted(f.state.saved), [1, 2, 3, 4]);
  assert.equal(f.state.probes, 3, "matching sizes need no probe");
  assert.equal(f.sync.skippedCount("account"), 0);
});

test("admission limits and cancellations never set a message aside", async () => {
  const f = fixture({ uids: [1] });
  for (const status of [429, 499, 503, 429]) {
    f.state.broken.set(1, failure(status));
    await f.run();
  }
  assert.equal(f.sync.skippedCount("account"), 0);
  f.state.broken.delete(1);
  await f.run();
  assert.deepEqual(sorted(f.state.saved), [1]);
  assert.equal(f.state.states.at(-1), "idle");
});

test("invalidate and the retry period give a set-aside message another chance", async (t) => {
  t.mock.method(console, "warn", () => {});
  let clock = 1_000_000;
  const f = fixture({ uids: [1], now: () => clock });
  f.state.broken.set(1, failure(502));
  for (let run = 0; run < 3; run++) await f.run();
  assert.equal(f.sync.skippedCount("account"), 1);
  f.sync.invalidate("account");
  assert.equal(f.sync.skippedCount("account"), 0);
  for (let run = 0; run < 3; run++) await f.run();
  assert.equal(f.state.downloads.get(1), 6);
  assert.equal(f.sync.skippedCount("account"), 1);
  await f.run();
  assert.equal(f.state.downloads.get(1), 6);
  clock += 24 * 60 * 60 * 1000;
  f.state.broken.delete(1);
  await f.run();
  assert.deepEqual(sorted(f.state.saved), [1]);
  assert.equal(f.state.states.at(-1), "idle");
});
