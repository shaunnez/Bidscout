import { PARSER_VERSION } from "../shared/specs/computer.ts";
import { loadConfig } from "../server/config.ts";
import { connect, migrate, tx } from "../server/db.ts";
import { rebuildCompStats } from "../server/scan/comps.ts";
import { parseRevision } from "../server/scan/ingest.ts";

/**
 * Re-reads every lot's current listing with the current parser. Earlier parses stay
 * (spec_values are immutable and keyed by parser version); facets move to the new one.
 * No requests to number8.bid.
 */
const db = connect(loadConfig().databaseUrl);
await migrate(db);
const todo = await db.query(
  `SELECT l.id, r.id AS revision_id, r.fields FROM lots l JOIN lot_revisions r ON r.id = l.current_revision_id
   WHERE l.parser_version IS DISTINCT FROM $1 ${process.argv.includes("--all") ? "OR true" : ""} ORDER BY l.id`,
  [PARSER_VERSION],
);
console.log(`Re-parsing ${todo.rows.length} lots with ${PARSER_VERSION}…`);
for (let i = 0; i < todo.rows.length; i += 500) {
  await tx(db, async (c) => {
    for (const r of todo.rows.slice(i, i + 500)) await parseRevision(c, r.id, r.revision_id, r.fields);
  });
  process.stdout.write(`  ${Math.min(i + 500, todo.rows.length)}\r`);
}
await rebuildCompStats(db);
console.log(`\nDone. Price history rebuilt.`);
await db.end();
