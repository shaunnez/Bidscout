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
 * Use after fixing how a field is read. No requests to number8.bid. Favourites, friends'
 * bids (stored responses have bidder IDs removed) and photo reads (they come from images,
 * not snapshots) are kept, and photo values are merged back in as each lot is rebuilt.
 */
export async function replayAll(db: Db, store: ObjectStore, onProgress?: (done: number, total: number) => void) {
  const active = await db.query(`SELECT id FROM scan_runs WHERE state IN ('queued','running')`);
  if (active.rowCount) throw new Error("A scan is running; wait for it to finish before replaying.");
  const favs = (await db.query(`SELECT user_id, lot_id, max_all_in, note, added_at FROM favourites`)).rows;
  const fbids = (await db.query(`SELECT lot_id, user_id, kind, amount, bid_at, snapshot_id, seen_at FROM friend_bids`)).rows;
  await db.query(`TRUNCATE watchlist, favourites, friend_bids, comp_stats, spec_values, lot_observations, auction_terms, lot_revisions, lots, auctions`);
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
  for (const f of favs)
    await db.query(
      `INSERT INTO favourites (user_id, lot_id, max_all_in, note, added_at) SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM lots WHERE id=$2)`,
      [f.user_id, f.lot_id, f.max_all_in, f.note, f.added_at],
    );
  for (const b of fbids)
    await db.query(
      `INSERT INTO friend_bids (lot_id, user_id, kind, amount, bid_at, snapshot_id, seen_at)
       SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (SELECT 1 FROM lots WHERE id=$1) ON CONFLICT DO NOTHING`,
      [b.lot_id, b.user_id, b.kind, b.amount, b.bid_at, b.snapshot_id, b.seen_at],
    );
  await db.query(
    `UPDATE lots l SET photo_ocr_at = r.at FROM (SELECT lot_id, max(created_at) AS at FROM photo_reads GROUP BY lot_id) r WHERE r.lot_id = l.id`,
  );
  await rebuildCompStats(db);
  return snaps.length;
}
