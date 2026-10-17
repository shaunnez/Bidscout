import { tx, type Db } from "../db.ts";
import type { N8AuctionsPage, N8ItemData, N8LotsPage } from "../number8.ts";
import { loadSnapshotDoc } from "../snapshots.ts";
import type { ObjectStore } from "../store.ts";
import { rebuildCompStats } from "./comps.ts";
import { ingestLot, upsertAuction } from "./ingest.ts";
import { recordDetail } from "./runner.ts";

/**
 * Rebuilds every derived table (auctions, lots, revisions, observations, specs, terms,
 * price history) from the stored snapshots, in the order they were fetched.
 * Use after fixing how a field is read. No requests to number8.bid. The watchlist is kept.
 */
export async function replayAll(db: Db, store: ObjectStore, onProgress?: (done: number, total: number) => void) {
  const active = await db.query(`SELECT id FROM scan_runs WHERE state IN ('queued','running')`);
  if (active.rowCount) throw new Error("A scan is running; wait for it to finish before replaying.");
  const watch = (await db.query(`SELECT lot_id, max_all_in, note, added_at FROM watchlist`)).rows;
  await db.query(`TRUNCATE watchlist, comp_stats, spec_values, lot_observations, auction_terms, lot_revisions, lots, auctions`);
  const snaps = (await db.query(`SELECT id, url, request_body, fetched_at FROM snapshots ORDER BY id`)).rows;
  let n = 0;
  for (const s of snaps) {
    const { doc } = await loadSnapshotDoc(db, store, s.id);
    const form = new URLSearchParams(s.request_body ?? "");
    const now: Date = s.fetched_at;
    await tx(db, async (c) => {
      if (s.url.endsWith("/api/auctions")) {
        for (const [i, a] of ((doc as N8AuctionsPage).data ?? []).entries()) await upsertAuction(c, a, s.id, `data.${i}`, now);
      } else if (s.url.endsWith("/api/getitems")) {
        const past = form.get("item_type") === "pastsales";
        for (const [i, row] of ((doc as N8LotsPage).items ?? []).entries()) await ingestLot(c, row, s.id, `items.${i}`, now, past);
      } else if (s.url.endsWith("/api/ItemData")) {
        const d = doc as N8ItemData;
        const id = Number(form.get("item_id") ?? d.id);
        const exists = await c.query(`SELECT auction_id FROM lots WHERE id=$1`, [id]);
        if (exists.rows[0]) await recordDetail(c, id, exists.rows[0].auction_id, s.id, d);
      }
    });
    onProgress?.(++n, snaps.length);
  }
  for (const w of watch)
    await db.query(
      `INSERT INTO watchlist (lot_id, max_all_in, note, added_at) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM lots WHERE id=$1)`,
      [w.lot_id, w.max_all_in, w.note, w.added_at],
    );
  await rebuildCompStats(db);
  return snaps.length;
}
