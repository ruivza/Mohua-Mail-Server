import { Database } from "../src/database.js";
import { removeLegacyMailboxes } from "../src/remove-legacy-mailboxes.js";
const db = new Database();
try {
  await db.claimOwner(() => {});
  console.log(JSON.stringify(await removeLegacyMailboxes(db)));
} finally {
  await db.close();
}
