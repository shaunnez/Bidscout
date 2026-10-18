import type { Tx } from "./db.ts";
import { num } from "./number8.ts";

/**
 * Friendly bidders: each person enters their own number8 username and bidder number, so the
 * group can see when one of them is bidding and not bid against each other.
 * Matching happens on the raw response, before redaction; only matches are stored.
 */

export type FriendIds = Map<string, number>;

const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

export async function loadFriendIds(c: { query: Tx["query"] }): Promise<FriendIds> {
  const r = await c.query(`SELECT id, n8_username, n8_bidder_number FROM users WHERE NOT disabled`);
  const m: FriendIds = new Map();
  for (const u of r.rows) {
    for (const v of [u.n8_username, u.n8_bidder_number]) if (norm(v)) m.set(norm(v), Number(u.id));
  }
  return m;
}

const pick = (ids: FriendIds, ...vals: unknown[]) => {
  for (const v of vals) {
    const id = ids.get(norm(v));
    if (id) return id;
  }
  return null;
};

/** The current high bidder on a lot-list row, if they are in the group. */
export function friendHighBidder(ids: FriendIds, row: Record<string, unknown> | undefined): number | null {
  if (!row || !ids.size) return null;
  return pick(ids, row.winner, row.highbidder_username, row.high_bidder, row.buyer_number);
}

/** Bids in a lot page's bid history placed by people in the group. */
export function friendBids(ids: FriendIds, history: unknown): Array<{ userId: number; amount: number | null; at: string | null }> {
  if (!ids.size || !Array.isArray(history)) return [];
  const out: Array<{ userId: number; amount: number | null; at: string | null }> = [];
  for (const b of history as Array<Record<string, unknown>>) {
    const userId = pick(ids, b.user_name, b.username, b.buyer_number, b.bidder);
    if (userId) out.push({ userId, amount: num(b.bid), at: typeof b.time_of_bid === "string" ? b.time_of_bid : null });
  }
  return out;
}

export async function recordFriendHigh(c: Tx, lotId: number, userId: number | null, amount: number | null, snapshotId: number) {
  await c.query(`UPDATE lots SET friend_high_user_id=$2 WHERE id=$1`, [lotId, userId]);
  if (userId)
    await c.query(
      `INSERT INTO friend_bids (lot_id, user_id, kind, amount, snapshot_id) VALUES ($1,$2,'high_bidder',$3,$4) ON CONFLICT DO NOTHING`,
      [lotId, userId, amount, snapshotId],
    );
}

export async function recordFriendBids(c: Tx, lotId: number, bids: ReturnType<typeof friendBids>, snapshotId: number) {
  for (const b of bids)
    await c.query(
      `INSERT INTO friend_bids (lot_id, user_id, kind, amount, bid_at, snapshot_id) VALUES ($1,$2,'bid',$3,$4,$5) ON CONFLICT DO NOTHING`,
      [lotId, b.userId, b.amount, b.at ? new Date(b.at) : null, snapshotId],
    );
}
