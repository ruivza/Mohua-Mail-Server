import { Database } from "../src/database.js";
import { createApp } from "../src/server.js";
import { createHash, randomUUID } from "node:crypto";
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
