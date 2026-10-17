import { loadConfig } from "../server/config.ts";
import { connect, migrate } from "../server/db.ts";
import { replayAll } from "../server/scan/replay.ts";
import { ObjectStore } from "../server/store.ts";

/** Rebuilds the derived tables from stored snapshots (no requests). See server/scan/replay.ts. */
const config = loadConfig();
const db = connect(config.databaseUrl);
await migrate(db);
const total = await replayAll(db, new ObjectStore(config.dataDir), (n, t) => n % 100 === 0 && process.stdout.write(`  ${n}/${t}\r`));
const c = (await db.query(`SELECT count(*)::int AS lots, count(*) FILTER (WHERE status='open')::int AS open FROM lots`)).rows[0];
console.log(`\nReplayed ${total} stored responses: ${c.lots} lots (${c.open} open).`);
await db.end();
