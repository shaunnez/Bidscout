import { loadConfig } from "./config.ts";
import { connect, migrate } from "./db.ts";
import { ObjectStore } from "./store.ts";
import { Number8Transport } from "./transport.ts";

export async function appContext() {
  const config = loadConfig();
  const db = connect(config.databaseUrl);
  try {
    await migrate(db);
  } catch (e) {
    const where = new URL(config.databaseUrl).host;
    throw new Error(`Could not reach Postgres at ${where} (${(e as Error).message}). On Railway, set DATABASE_URL to \${{Postgres.DATABASE_URL}}.`);
  }
  const store = new ObjectStore(config.dataDir);
  store.checkWritable();
  const makeTransport = (signal: AbortSignal, concurrency = 1) =>
    new Number8Transport({ baseUrl: config.baseUrl, contact: config.contact, minIntervalMs: config.minIntervalMs, concurrency, signal });
  return { config, db, store, makeTransport };
}
