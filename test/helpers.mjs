import { Database } from "../src/database.js";
import { createApp } from "../src/server.js";
import { createHash, randomUUID, randomBytes, createCipheriv } from "node:crypto";
import { after } from "node:test";
const schemas = new Set();
const connection = () =>
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
export async function createTestDatabase() {
  const schema = "test_" + randomUUID().replaceAll("-", "");
  schemas.add(schema);
  const db = new Database(connection(), schema);
  await db.initialize();
  return db;
}
export async function createTestApp(options = {}) {
  const schema =
    "test_" +
    createHash("sha256")
      .update(options.dataDir || randomUUID())
      .digest("hex")
      .slice(0, 24);
  schemas.add(schema);
  return createApp({
    ...options,
    databaseUrl: connection(),
    databaseSchema: schema,
  });
}
export async function cleanupTestDatabases() {
  if (!schemas.size) return;
  const db = new Database(connection());
  try {
    for (const schema of schemas)
      await db.exec('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  } finally {
    await db.close();
  }
}
if (process.env.NODE_TEST_CONTEXT) after(cleanupTestDatabases);


export function clientCredential(password = "fixture-only", id = randomUUID()) {
  const revision = randomUUID(), key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`mohua-credential-v1\n${id}\n${revision}`));
  const ciphertext = Buffer.concat([iv, cipher.update(password), cipher.final(), cipher.getAuthTag()]).toString("base64");
  return { id, envelope: { revision, ciphertext } };
}
export async function authorizeFixture(app, id, password = "fixture-only") {
  const a = await app.db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
  const { revision } = JSON.parse(a.credential.slice("client-v1:".length));
  let device = await app.db.prepare("SELECT id FROM client_devices WHERE user_id=? AND revoked IS NULL LIMIT 1").get(a.user_id);
  if (!device) { const created = await app.devices.enroll(a.user_id, { name: "Fixture", platform: "ios" }); device = { id: created.deviceId }; }
  const key=randomBytes(32), iv=randomBytes(12), c=createCipheriv("aes-256-gcm",key,iv);
  c.setAAD(Buffer.from(`mohua-credential-v1\n${id}\n${revision}`));
  const ciphertext=Buffer.concat([iv,c.update(password),c.final(),c.getAuthTag()]).toString("base64");
  app.leases.install(a,device.id,{challenge:app.leases.challenge(a,device.id),revision,key:key.toString("base64"),ciphertext,expiresAt:null});
}
