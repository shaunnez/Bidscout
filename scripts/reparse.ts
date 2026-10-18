import { PARSER_VERSION } from "../shared/specs/computer.ts";
import { loadConfig } from "../server/config.ts";
import { connect, migrate } from "../server/db.ts";
import { reparseStale } from "../server/scan/reparse.ts";

/**
 * Re-reads lots with the current parser (the worker also does this on start after an upgrade).
 *   npm run reparse           lots parsed by an older version
 *   npm run reparse -- --all  every lot
 */
const db = connect(loadConfig().databaseUrl);
await migrate(db);
const n = await reparseStale(db, { all: process.argv.includes("--all"), onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`) });
console.log(`\nRe-parsed ${n} lots with ${PARSER_VERSION}.${n ? " Price history rebuilt." : ""}`);
await db.end();
