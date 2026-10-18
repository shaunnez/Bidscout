import { loadConfig } from "./config.ts";
import { connect, migrate } from "./db.ts";
import { ObjectStore } from "./store.ts";
import { ImageFetcher } from "./images.ts";
import { Number8Transport, RequestGate } from "./transport.ts";

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
  // One gate for every request this process makes to number8.bid (scans and manual refreshes).
  const gate = new RequestGate();
  /** A scan passes its concurrency setting; a refresh leaves it out and shares the scan's slots. */
  const makeTransport = (signal: AbortSignal, concurrency?: number) =>
    new Number8Transport({ baseUrl: config.baseUrl, contact: config.contact, minIntervalMs: config.minIntervalMs, concurrency, signal, gate });
  const makeImageFetcher = () =>
    new ImageFetcher({ userAgent: `BidScout/0.1 (lot photo reading${config.contact ? `; contact ${config.contact}` : ""})` });
  return { config, db, store, makeTransport, makeImageFetcher };
}
