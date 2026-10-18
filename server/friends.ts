import type { Tx } from "./db.ts";
import { num } from "./number8.ts";

/**
 * Friendly bidders: each person enters their own number8 username and bidder number, so the
 * group can see when one of them is bidding and not bid against each other.
 * Matching happens on the raw response, before redaction; only matches are stored.
 */

/** Usernames and bidder numbers are looked up separately; a value two members claim is ignored. */
export interface FriendIds {
  names: Map<string, number>;
  numbers: Map<string, number>;
  size: number;
}

const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

export function buildFriendIds(users: Array<{ id: number | string; n8_username?: string | null; n8_bidder_number?: string | null }>): FriendIds {
  const names = new Map<string, number>();
  const numbers = new Map<string, number>();
  const ambiguous = new Set<string>();
  const add = (m: Map<string, number>, v: unknown, id: number) => {
    const k = norm(v);
    if (!k) return;
    if (m.has(k) && m.get(k) !== id) ambiguous.add(k);
    m.set(k, id);
  };
  for (const u of users) {
    add(names, u.n8_username, Number(u.id));
    add(numbers, u.n8_bidder_number, Number(u.id));
  }
  // Also ambiguous: one member's username is another member's bidder number.
  for (const [k, id] of names) if (numbers.has(k) && numbers.get(k) !== id) ambiguous.add(k);
  for (const k of ambiguous) {
    names.delete(k);
    numbers.delete(k);
  }
  return { names, numbers, size: names.size + numbers.size };
}

export async function loadFriendIds(c: { query: Tx["query"] }): Promise<FriendIds> {
  const r = await c.query(`SELECT id, n8_username, n8_bidder_number FROM users WHERE NOT disabled`);
  return buildFriendIds(r.rows);
}

type Field = [value: unknown, kind: "name" | "number" | "either"];

/** The member the fields point to, or null if none do or they point to different members. */
const pick = (ids: FriendIds, ...fields: Field[]) => {
  const found = new Set<number>();
  for (const [v, kind] of fields) {
    const k = norm(v);
    if (!k) continue;
    if (kind !== "number" && ids.names.has(k)) found.add(ids.names.get(k)!);
    if (kind !== "name" && ids.numbers.has(k)) found.add(ids.numbers.get(k)!);
  }
  return found.size === 1 ? [...found][0]! : null;
};

/** The current high bidder on a lot-list row, if they are in the group. */
export function friendHighBidder(ids: FriendIds, row: Record<string, unknown> | undefined): number | null {
  if (!row || !ids.size) return null;
  return pick(ids, [row.winner, "name"], [row.highbidder_username, "name"], [row.high_bidder, "either"], [row.buyer_number, "number"]);
}

/** Bids in a lot page's bid history placed by people in the group. */
export function friendBids(ids: FriendIds, history: unknown): Array<{ userId: number; amount: number | null; at: string | null }> {
  if (!ids.size || !Array.isArray(history)) return [];
  const out: Array<{ userId: number; amount: number | null; at: string | null }> = [];
  for (const b of history as Array<Record<string, unknown>>) {
    const userId = pick(ids, [b.user_name, "name"], [b.username, "name"], [b.buyer_number, "number"], [b.bidder, "either"]);
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
