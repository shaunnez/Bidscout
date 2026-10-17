import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// numeric and bigint come back as strings by default; the values here fit in a double.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 8 });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

/** Applies the idempotent schema under an advisory lock, as Groundwork does at start. */
export async function migrate(db: Db): Promise<void> {
  const sql = fs.readFileSync(schemaPath, "utf8");
  await tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bidscout-schema'))");
    await c.query(sql);
  });
}
