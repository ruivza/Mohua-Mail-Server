import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteDrafts } from "../src/remote-drafts.js";

const MINUTE = 60 * 1000,
  HOUR = 60 * MINUTE;

// legacy: account id -> draft ids still stored in the old format.
function fixture(legacy = new Map()) {
  let clock = 10 * HOUR;
  const probes = [],
    migrated = [];
  const store = {
    async call(op, values) {
      assert.equal(op, "draftLegacy");
      probes.push(values.accountId);
      const pending = legacy.get(values.accountId);
      return pending?.length ? { id: pending[0] } : null;
    },
  };
  const drafts = new RemoteDrafts(store, {}, { now: () => clock });
  drafts.handle = async (account, id, method) => {
    if (account.fail) throw Error("snapshot unavailable");
    if (method === "POST") {
      legacy.get(account.id).shift();
      migrated.push(id);
    }
    return { revision: "r" };
  };
  return {
    drafts,
    probes,
    migrated,
    advance: (ms) => (clock += ms),
    scan: async (accounts) => {
      drafts.scheduleMigration(accounts);
      await drafts.migrating;
    },
  };
}

test("legacy draft scans run at most once a minute and clean accounts are rescanned hourly", async () => {
  const f = fixture();
  const accounts = [{ id: "a" }, { id: "b" }, { id: "c", purge_after: 1 }];
  await f.scan(accounts);
  assert.deepEqual(f.probes, ["a", "b"]);
  await f.scan(accounts);
  f.advance(MINUTE - 1);
  await f.scan(accounts);
  assert.deepEqual(f.probes, ["a", "b"], "no scan within a minute");
  f.advance(1);
  await f.scan([...accounts, { id: "d" }]);
  assert.deepEqual(f.probes, ["a", "b", "d"], "only accounts not yet found clean are probed");
  f.advance(HOUR);
  await f.scan(accounts);
  assert.deepEqual(f.probes.slice(3), ["a", "b"]);
});

test("legacy drafts migrate within a per-scan budget and a failing account does not block others", async () => {
  const legacy = new Map([
    ["a", Array.from({ length: 25 }, (_, i) => "draft-" + i)],
    ["c", ["draft-c"]],
  ]);
  const f = fixture(legacy);
  const accounts = [{ id: "b", fail: true }, { id: "a" }, { id: "c" }];
  legacy.set("b", ["draft-b"]);
  await f.scan(accounts);
  assert.equal(f.migrated.length, 19, "the failed attempt also counts toward the 20-draft budget");
  assert.equal(legacy.get("c").length, 1, "the budget ends the scan");
  f.advance(MINUTE);
  await f.scan(accounts);
  assert.equal(legacy.get("a").length, 0);
  assert.equal(legacy.get("c").length, 0);
  assert.equal(legacy.get("b").length, 1);
  const probes = f.probes.length;
  f.advance(MINUTE);
  await f.scan(accounts);
  assert.equal(f.probes.length, probes, "clean and recently failed accounts wait");
  f.advance(10 * MINUTE);
  await f.scan(accounts);
  assert.deepEqual(f.probes.slice(probes), ["b"], "a failed account is retried later");
});
