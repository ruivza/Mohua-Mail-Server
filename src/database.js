import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

// Preserve the numeric API contract, but never silently round a BIGINT.
const types = {
  getTypeParser(oid, format) {
    if (oid === 20 && format !== "binary")
      return (value) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number))
          throw Error("Database integer exceeds safe range");
        return number;
      };
    return pg.types.getTypeParser(oid, format);
  },
};
function parameters(sql) {
  let index = 0;
  return sql.replace(/'([^']|'')*'|"([^"]|"")*"|\?/g, (part) =>
    part === "?" ? "$" + ++index : part,
  );
}

export class Database {
  constructor(
    connectionString = process.env.DATABASE_URL,
    schema = process.env.DATABASE_SCHEMA || "public",
  ) {
    if (!connectionString && !process.env.PGHOST)
      throw Error("Configure DATABASE_URL or PGHOST for PostgreSQL");
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw Error("Invalid database schema");
    this.schema = schema;
    this.context = new AsyncLocalStorage();
    this.pool = new pg.Pool({
      connectionString,
      types,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      options: "-c search_path=" + schema,
    });
    this.pool.on("error", () => {
      /* Queries report database outages to callers. */
    });
  }
  async initialize() {
    await this.pool.query('CREATE SCHEMA IF NOT EXISTS "' + this.schema + '"');
    await this.transaction(async () => {
      await this.query(
        "SELECT pg_advisory_xact_lock(734621, hashtext(current_schema()))",
      );
      await this.exec(
        readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
      );
    });
  }
  async claimOwner(onLost) {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT pg_try_advisory_lock(734622, hashtext(current_schema())) AS locked",
      );
      if (!rows[0].locked)
        throw Error("Another Mohua server is using this database schema");
      this.owner = client;
      client.on("error", () => {
        this.ownerLost = true;
        onLost();
      });
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
  query(sql, values = []) {
    const client = this.context.getStore();
    if (client?.finished) throw Error("Transaction already finished");
    return (client?.connection || this.pool).query(parameters(sql), values);
  }
  exec(sql) {
    return this.query(sql);
  }
  prepare(sql) {
    return {
      get: async (...values) => (await this.query(sql, values)).rows[0],
      all: async (...values) => (await this.query(sql, values)).rows,
      run: async (...values) => ({
        changes: (await this.query(sql, values)).rowCount,
      }),
    };
  }
  async transaction(operation) {
    if (this.context.getStore()) return operation();
    const connection = await this.pool.connect();
    const scope = { connection, finished: false };
    try {
      await connection.query("BEGIN");
      const result = await this.context.run(scope, operation);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      scope.finished = true;
      connection.release();
    }
  }
  async close() {
    if (this.owner) {
      const client = this.owner;
      this.owner = null;
      try {
        if (!this.ownerLost)
          await client.query(
            "SELECT pg_advisory_unlock(734622, hashtext(current_schema()))",
          );
      } finally {
        client.release(this.ownerLost);
      }
    }
    await this.pool.end();
  }
}
