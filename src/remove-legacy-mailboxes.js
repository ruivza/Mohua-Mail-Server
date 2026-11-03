// Explicit destructive maintenance only. Caller must hold database ownership lock.
export async function removeLegacyMailboxes(db) {
  return db.transaction(async () => {
    await db.exec("LOCK TABLE accounts IN EXCLUSIVE MODE");
    const old = await db
      .prepare("SELECT COUNT(*) n FROM accounts WHERE credential NOT LIKE 'client-v1:%'")
      .get();
    const outbox = await db
      .prepare(
        "DELETE FROM outbox WHERE account_id IN (SELECT id FROM accounts WHERE credential NOT LIKE 'client-v1:%')",
      )
      .run();
    const removed = await db
      .prepare("DELETE FROM accounts WHERE credential NOT LIKE 'client-v1:%'")
      .run();
    const remaining = await db.prepare("SELECT COUNT(*) n FROM accounts").get();
    return {
      oldConfigurations: old.n,
      removedConfigurations: removed.changes,
      removedOutboxRecords: outbox.changes,
      remainingConfigurations: remaining.n,
    };
  });
}
