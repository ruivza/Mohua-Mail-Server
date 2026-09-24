import {test} from "node:test";
import assert from "node:assert/strict";
import {createTestDatabase,clientCredential} from "./helpers.mjs";
import {removeLegacyMailboxes} from "../src/remove-legacy-mailboxes.js";
import {CredentialLeases} from "../src/credential-leases.js";
test("explicit cleanup removes only legacy accounts and their dependent state, keeps encrypted accounts and users",async()=>{
 const db=await createTestDatabase();
 try {
  await db.prepare("INSERT INTO users VALUES('u','u@example.test','unused','user',1)").run();
  for(const [id,credential] of [["old","server-encrypted-legacy"],["new","client-v1:"+JSON.stringify(clientCredential().envelope)]]) {
   await db.prepare("INSERT INTO accounts VALUES(?,'u',?,'proxy','imap.example.test',993,'smtp.example.test',465,?,0)").run(id,id+"@example.test",credential);
   await db.prepare("INSERT INTO mailbox_revisions VALUES(?,1)").run(id);
   await db.prepare("INSERT INTO outbox VALUES(?,'u',?,?,'digest','prepared',NULL,0)").run(id,id,id);
  }
  const result=await removeLegacyMailboxes(db);
  assert.deepEqual(result,{oldConfigurations:1,removedConfigurations:1,removedOutboxRecords:1,remainingConfigurations:1});
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").get()).n,1);
  assert.deepEqual(await db.prepare("SELECT account_id FROM mailbox_revisions").all(),[{account_id:"new"}]);
  assert.deepEqual(await db.prepare("SELECT account_id FROM outbox").all(),[{account_id:"new"}]);
  assert.equal((await removeLegacyMailboxes(db)).removedConfigurations,0);
 } finally {await db.close();}
});
test("legacy credentials cannot bypass a lease check",()=>{
 const l=new CredentialLeases(),a={id:"old",credential:"old-server-ciphertext"};
 assert.throws(()=>l.assert(a),e=>e.status===409);assert.throws(()=>l.password(a),e=>e.status===409);
});
