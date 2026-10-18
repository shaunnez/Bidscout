import type { Db } from "./db.ts";
import { LOT_COLUMNS, LOT_JOINS } from "./search.ts";

/**
 * Auctions with what the group cares about: how many lots and bids, what's computer gear,
 * who has favourited what, and how the closed ones sold. $1 is always the signed-in user.
 */

export type AuctionScope = "live" | "closed";

// Live while any lot is still open, or the auction itself hasn't ended.
const LIVE = `(COALESCE(a.ends_at > now(), false) OR EXISTS (SELECT 1 FROM lots x WHERE x.auction_id = a.id AND x.status = 'open'))`;

const COLUMNS = `
  a.id, a.title, a.starts_at, a.ends_at, a.lots_close_at, a.city, a.region, a.address, a.postcode, a.instructions,
  a.url, a.thumb_url, a.item_count, ${LIVE} AS live,
  count(l.id)::int AS lots,
  count(l.id) FILTER (WHERE l.is_it)::int AS it_lots,
  count(l.id) FILTER (WHERE l.status = 'open')::int AS open_lots,
  count(l.id) FILTER (WHERE COALESCE(l.bid_count, 0) > 0)::int AS lots_with_bids,
  COALESCE(sum(l.bid_count), 0)::int AS bids,
  min(l.ends_at) FILTER (WHERE l.status = 'open' AND l.ends_at > now()) AS next_close,
  count(l.id) FILTER (WHERE l.status = 'closed' AND l.final_bid > 0)::int AS sold,
  sum(l.final_bid) FILTER (WHERE l.status = 'closed') AS sold_total,
  max(l.final_bid) FILTER (WHERE l.status = 'closed') AS top_final,
  max(l.closed_at) AS last_closed,
  sum(l.current_bid) FILTER (WHERE l.status = 'open' AND COALESCE(l.bid_count, 0) > 0) AS bid_total,
  count(l.id) FILTER (WHERE l.friend_high_user_id IS NOT NULL AND l.status = 'open')::int AS friend_high,
  (SELECT count(*)::int FROM favourites f JOIN lots x ON x.id = f.lot_id WHERE x.auction_id = a.id) AS group_favourites,
  (SELECT count(*)::int FROM favourites f JOIN lots x ON x.id = f.lot_id WHERE x.auction_id = a.id AND f.user_id = $1) AS my_favourites,
  (SELECT array_agg(c.category ORDER BY c.n DESC) FROM (SELECT category, count(*) AS n FROM lots WHERE auction_id = a.id AND category IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 3) c) AS top_categories,
  (SELECT array_agg(x.thumb_url) FROM (SELECT thumb_url FROM lots WHERE auction_id = a.id AND thumb_url IS NOT NULL ORDER BY bid_count DESC NULLS LAST, id LIMIT 4) x) AS thumbs,
  t.premium_rate, t.gst_rate, t.payment_due`;

const FROM = `
  FROM auctions a
  LEFT JOIN lots l ON l.auction_id = a.id
  LEFT JOIN LATERAL (SELECT premium_rate, gst_rate, payment_due FROM auction_terms WHERE auction_id = a.id ORDER BY id DESC LIMIT 1) t ON true`;

const GROUP = `GROUP BY a.id, t.premium_rate, t.gst_rate, t.payment_due`;

/** Open lots expected to sell for less than is typical for their spec (value index 115+), per auction. */
async function goodValue(db: Db, userId: number, ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const r = await db.query(
    `SELECT x.auction_id, count(*) FILTER (WHERE x.value_index >= 115 AND x.comp_kind <> 'spec')::int AS n
     FROM (SELECT ${LOT_COLUMNS} FROM lots l ${LOT_JOINS} WHERE l.status = 'open' AND l.auction_id = ANY($2)) x GROUP BY 1`,
    [userId, ids],
  );
  return new Map(r.rows.map((row) => [Number(row.auction_id), Number(row.n)]));
}

export async function listAuctions(db: Db, userId: number, scope: AuctionScope, limit = 60) {
  const r = await db.query(
    `SELECT ${COLUMNS} ${FROM} WHERE ${scope === "live" ? LIVE : `NOT ${LIVE}`} ${GROUP}
     HAVING count(l.id) > 0
     ORDER BY ${scope === "live" ? "next_close ASC NULLS LAST, a.ends_at ASC" : "COALESCE(a.ends_at, max(l.closed_at)) DESC NULLS LAST"} LIMIT ${Math.min(200, limit)}`,
    [userId],
  );
  const good = await goodValue(db, userId, scope === "live" ? r.rows.map((a) => Number(a.id)) : []);
  return r.rows.map((a) => ({ ...a, good_value: good.get(Number(a.id)) ?? 0 }));
}

export async function getAuction(db: Db, userId: number, id: number) {
  const r = await db.query(`SELECT ${COLUMNS} ${FROM} WHERE a.id = $2 ${GROUP}`, [userId, id]);
  const a = r.rows[0];
  if (!a) return null;
  const good = await goodValue(db, userId, a.live ? [id] : []);
  return { ...a, good_value: good.get(id) ?? 0 };
}
