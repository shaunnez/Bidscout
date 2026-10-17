import { loadConfig } from "./config.ts";
import { connect, migrate } from "./db.ts";
import { ObjectStore } from "./store.ts";
import { Number8Transport } from "./transport.ts";

export async function appContext() {
  const config = loadConfig();
  const db = connect(config.databaseUrl);
  await migrate(db);
  const store = new ObjectStore(config.dataDir);
  const makeTransport = (signal: AbortSignal) =>
    new Number8Transport({ baseUrl: config.baseUrl, contact: config.contact, minIntervalMs: config.minIntervalMs, signal });
  return { config, db, store, makeTransport };
}
