import { PARSER_VERSION } from "../../shared/specs/computer.ts";
import { tx, type Db } from "../db.ts";
import { rebuildCompStats } from "./comps.ts";
import { parseRevision } from "./ingest.ts";

/**
 * Re-reads lots' current listings with the current parser: those parsed by an older version,
 * or every lot with `all`. Earlier parses stay (spec_values are immutable and keyed by parser
 * version); facets move to the new one. No requests to number8.bid. Returns lots re-parsed.
 */
export async function reparseStale(db: Db, opts: { all?: boolean; onProgress?: (done: number, total: number) => void } = {}) {
  const todo = await db.query(
    `SELECT l.id, r.id AS revision_id, r.fields FROM lots l JOIN lot_revisions r ON r.id = l.current_revision_id
     WHERE l.parser_version IS DISTINCT FROM $1 ${opts.all ? "OR true" : ""} ORDER BY l.id`,
    [PARSER_VERSION],
  );
  for (let i = 0; i < todo.rows.length; i += 500) {
    await tx(db, async (c) => {
      for (const r of todo.rows.slice(i, i + 500)) await parseRevision(c, r.id, r.revision_id, r.fields);
    });
    opts.onProgress?.(Math.min(i + 500, todo.rows.length), todo.rows.length);
  }
  if (todo.rows.length) await rebuildCompStats(db);
  return todo.rows.length;
}
