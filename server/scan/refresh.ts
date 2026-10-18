import { tx, type Db, type Tx } from "../db.ts";
import { friendHighBidder, loadFriendIds, recordFriendHigh } from "../friends.ts";
import { n8, num, unixToDate, type N8ItemData } from "../number8.ts";
import { saveSnapshot } from "../snapshots.ts";
import type { ObjectStore } from "../store.ts";
import type { Transport } from "../transport.ts";
import { CLOSE_GRACE_MS } from "./ingest.ts";
import { recordDetail } from "./runner.ts";

/**
 * Re-reads one lot page now (one request): the current bid, close time, photos, whether
 * anyone in the group has bid and whether one of them is the high bidder. Used right before
 * bidding. The listing text is not revised here; that comes from the lot lists in a scan.
 */
export async function refreshLot(db: Db, store: ObjectStore, transport: Transport, lotId: number, now = new Date()) {
  const lot = (await db.query(`SELECT id, auction_id FROM lots WHERE id=$1`, [lotId])).rows[0];
  if (!lot) throw new Error("No such lot");
  const res = await n8.itemData(transport, lot.id, lot.auction_id);
  const snap = await saveSnapshot<N8ItemData & Record<string, unknown>>(db, store, null, res, now);
  const friends = await loadFriendIds(db);
  await tx(db, async (c) => {
    await recordDetail(c, lot.id, lot.auction_id, snap.id, snap.doc, snap.raw, friends);
    await applyRefresh(c, lot.id, snap.id, snap.doc, now);
    await recordFriendHigh(c, lot.id, friendHighBidder(friends, snap.raw), num(snap.doc.current_bid), snap.id);
  });
  return { snapshotId: snap.id };
}

/**
 * The bid, bid count, close time and status from a refresh's lot page, kept as an observation
 * when any of them moved. Replay runs this again for refresh snapshots (those with no scan run).
 */
export async function applyRefresh(c: Tx, lotId: number, snapshotId: number, d: N8ItemData & Record<string, unknown>, now: Date) {
  const lot = (await c.query(`SELECT status, current_bid, bid_count, ends_at FROM lots WHERE id=$1`, [lotId])).rows[0];
  if (!lot) return;
  const bid = num(d.current_bid);
  const bids = num(d.bid_count);
  const ends = unixToDate(d.end_time_unix ?? d.end_time);
  const status = ends && ends.getTime() < now.getTime() - CLOSE_GRACE_MS ? "closed" : "open";
  const moved = Number(lot.current_bid ?? -1) !== (bid ?? -1) || Number(lot.bid_count ?? -1) !== (bids ?? -1) ||
    (lot.ends_at?.getTime?.() ?? 0) !== (ends?.getTime() ?? 0) || lot.status !== status;
  if (!moved) return;
  await c.query(
    `INSERT INTO lot_observations (lot_id, observed_at, current_bid, bid_count, ends_at, status, snapshot_id, snapshot_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'')`,
    [lotId, now, bid, bids, ends, status, snapshotId],
  );
  await c.query(
    `UPDATE lots SET current_bid=$2::numeric, bid_count=$3::int, ends_at=$4::timestamptz, status=$5::text, last_seen=$6,
       final_bid = CASE WHEN $5::text='closed' AND COALESCE($3::int,0) > 0 THEN $2::numeric END,
       closed_at = CASE WHEN $5::text='closed' THEN $4::timestamptz END,
       outcome_snapshot_id = CASE WHEN $5::text='closed' THEN $7::bigint END,
       outcome_path = CASE WHEN $5::text='closed' THEN '' END
     WHERE id=$1`,
    [lotId, bid, bids, ends, status, now, snapshotId],
  );
}
