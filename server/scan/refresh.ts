import { tx, type Db } from "../db.ts";
import { loadFriendIds } from "../friends.ts";
import { n8, num, unixToDate, type N8ItemData } from "../number8.ts";
import { saveSnapshot } from "../snapshots.ts";
import type { ObjectStore } from "../store.ts";
import type { Transport } from "../transport.ts";
import { CLOSE_GRACE_MS } from "./ingest.ts";
import { recordDetail } from "./runner.ts";

/**
 * Re-reads one lot page now (one request): the current bid, close time, photos and whether
 * anyone in the group has bid. Used right before bidding. The listing text is not revised
 * here; that comes from the lot lists in a scan.
 */
export async function refreshLot(db: Db, store: ObjectStore, transport: Transport, lotId: number, now = new Date()) {
  const lot = (await db.query(`SELECT id, auction_id, status, current_bid, bid_count, ends_at FROM lots WHERE id=$1`, [lotId])).rows[0];
  if (!lot) throw new Error("No such lot");
  const res = await n8.itemData(transport, lot.id, lot.auction_id);
  const snap = await saveSnapshot<N8ItemData & Record<string, unknown>>(db, store, null, res, now);
  const d = snap.doc;
  const friends = await loadFriendIds(db);
  await tx(db, async (c) => {
    await recordDetail(c, lot.id, lot.auction_id, snap.id, d, snap.raw, friends);
    const bid = num(d.current_bid);
    const bids = num(d.bid_count);
    const ends = unixToDate(d.end_time_unix ?? d.end_time);
    const status = ends && ends.getTime() < now.getTime() - CLOSE_GRACE_MS ? "closed" : "open";
    const moved = Number(lot.current_bid ?? -1) !== (bid ?? -1) || Number(lot.bid_count ?? -1) !== (bids ?? -1) ||
      (lot.ends_at?.getTime?.() ?? 0) !== (ends?.getTime() ?? 0) || lot.status !== status;
    if (moved) {
      await c.query(
        `INSERT INTO lot_observations (lot_id, observed_at, current_bid, bid_count, ends_at, status, snapshot_id, snapshot_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'')`,
        [lot.id, now, bid, bids, ends, status, snap.id],
      );
      await c.query(
        `UPDATE lots SET current_bid=$2::numeric, bid_count=$3::int, ends_at=$4::timestamptz, status=$5::text, last_seen=$6,
           final_bid = CASE WHEN $5::text='closed' AND COALESCE($3::int,0) > 0 THEN $2::numeric END,
           closed_at = CASE WHEN $5::text='closed' THEN $4::timestamptz END,
           outcome_snapshot_id = CASE WHEN $5::text='closed' THEN $7::bigint END,
           outcome_path = CASE WHEN $5::text='closed' THEN '' END
         WHERE id=$1`,
        [lot.id, bid, bids, ends, status, now, snap.id],
      );
    }
  });
  return { snapshotId: snap.id };
}
