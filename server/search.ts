import type { Db } from "./db.ts";

export interface SearchQuery {
  q?: string;
  status?: "live" | "closed" | "all";
  it?: boolean;
  category?: string[];
  type?: string[];
  make?: string[];
  cpu?: string[];
  minGen?: number;
  minRam?: number;
  minStorage?: number;
  ssd?: boolean;
  faults?: "none" | "minor" | "any";
  maxAllIn?: number;
  closingHours?: number;
  auction?: number;
  watch?: boolean;
  /** Only lots with a spec read from their photos. */
  photo?: boolean;
  /** Outside prices: "1" lots compared with Trade Me listings or new prices, "opp" only opportunities. */
  tm?: "1" | "opp";
  sort?: "closing" | "newest" | "price" | "deal" | "bids" | "ended" | "value" | "expected" | "score" | "tm";
  page?: number;
  perPage?: number;
}

const list = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const number = (v: unknown) => (v === undefined || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

export function parseQuery(q: Record<string, unknown>): SearchQuery {
  return {
    q: typeof q.q === "string" ? q.q.trim() : undefined,
    status: q.status === "closed" || q.status === "all" ? q.status : "live",
    it: q.it === "1" || q.it === "true",
    category: list(q.category),
    type: list(q.type),
    make: list(q.make),
    cpu: list(q.cpu),
    minGen: number(q.minGen),
    minRam: number(q.minRam),
    minStorage: number(q.minStorage),
    ssd: q.ssd === "1",
    faults: q.faults === "none" || q.faults === "minor" ? q.faults : "any",
    maxAllIn: number(q.maxAllIn),
    closingHours: number(q.closingHours),
    auction: number(q.auction),
    watch: q.watch === "1",
    photo: q.photo === "1",
    tm: q.tm === "1" || q.tm === "opp" ? q.tm : undefined,
    sort: (["closing", "newest", "price", "deal", "bids", "ended", "value", "expected", "score", "tm"] as const).find((s) => s === q.sort),
    page: Math.max(1, number(q.page) ?? 1),
    perPage: Math.min(100, Math.max(10, number(q.perPage) ?? 40)),
  };
}

/**
 * Price now = current bid, or the starting bid while there are no bids.
 * All-in = price × (1 + premium) × (1 + GST), using the auction's own terms when read,
 * else the lot's buyer's premium and 15% GST (flagged as assumed).
 */
const PRICE = `CASE WHEN l.status='closed' THEN l.final_bid WHEN COALESCE(l.bid_count,0) > 0 THEN l.current_bid ELSE COALESCE(l.starting_bid, l.current_bid) END`;
const PREMIUM = `COALESCE(t.premium_rate, l.buyer_premium, 0)`;
const GST = `COALESCE(t.gst_rate, 15)`;
export const ALL_IN = `(${PRICE}) * (1 + ${PREMIUM} / 100.0) * (1 + ${GST} / 100.0)`;
const FAULT_SUFFIX = `CASE WHEN l.major_fault THEN '|fault' ELSE '' END`;

const BASE_JOINS = `
  JOIN auctions a ON a.id = l.auction_id
  LEFT JOIN LATERAL (SELECT premium_rate, gst_rate FROM auction_terms WHERE auction_id = l.auction_id ORDER BY id DESC LIMIT 1) t ON true
  LEFT JOIN comp_stats cm ON cm.key = l.machine_key || ${FAULT_SUFFIX}
  LEFT JOIN comp_stats cl ON cl.key = l.loose_key || ${FAULT_SUFFIX}
  LEFT JOIN comp_stats cs ON cs.key = l.score_key
  LEFT JOIN favourites w ON w.lot_id = l.id AND w.user_id = $1
  LEFT JOIN users fh ON fh.id = l.friend_high_user_id`;

/** Faulty or for-parts Trade Me listings only count for lots with a major fault too (as in the lot panel). */
const TM_FAULTY = `'\\m(faulty|for parts|spares|not working|broken|cracked|won''?t (boot|turn on|power))\\M'`;

/**
 * Trade Me price (open lots): from the newest Trade Me lookup this lot used, the median of what
 * the relevant listings ask to buy now: a Buy Now quoted from the card, or an asking or sold
 * price. Each of those prices is cited in the lot's Trade Me panel.
 */
const TM_JOIN = `
  LEFT JOIN LATERAL (
    SELECT count(v.p)::int AS tm_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY v.p) AS tm_mid, min(v.p) AS tm_low, max(pl.created_at) AS tm_at
    FROM (SELECT k.lookup_id FROM price_lookup_lots k JOIN price_lookups p ON p.id = k.lookup_id
          WHERE l.status = 'open' AND k.lot_id = l.id AND p.status = 'ok' AND p.source = 'trademe' ORDER BY k.used_at DESC LIMIT 1) last
    JOIN price_lookups pl ON pl.id = last.lookup_id
    JOIN LATERAL (
      SELECT COALESCE(CASE WHEN i.buy_now_start IS NOT NULL THEN i.buy_now END,
                      CASE WHEN i.verified AND i.price_kind IN ('asking', 'buy_now', 'sold') THEN i.price END) AS p
      FROM price_lookup_items i
      WHERE i.lookup_id = last.lookup_id AND (l.major_fault OR COALESCE(i.title, '') !~* ${TM_FAULTY})
    ) v ON v.p > 0
  ) tm ON true`;

/** New price in NZ (open lots): the median of the shop prices in the newest new-price lookup (server/newprice.ts). */
const NEW_JOIN = `
  LEFT JOIN LATERAL (
    SELECT count(i.price)::int AS new_n, percentile_cont(0.5) WITHIN GROUP (ORDER BY i.price) AS new_mid, max(pl.created_at) AS new_at
    FROM (SELECT k.lookup_id FROM price_lookup_lots k JOIN price_lookups p ON p.id = k.lookup_id
          WHERE l.status = 'open' AND k.lot_id = l.id AND p.status = 'ok' AND p.source = 'newprice' ORDER BY k.used_at DESC LIMIT 1) last
    JOIN price_lookups pl ON pl.id = last.lookup_id
    JOIN price_lookup_items i ON i.lookup_id = last.lookup_id AND i.verified AND i.price > 0
  ) np ON true`;

/** A wholesale or RRP price written in the title ("Wholesale $4,950.00"), with the words it came from. */
const LIST_JOIN = `
  LEFT JOIN LATERAL (
    SELECT m[1] AS list_quote, replace(m[3], ',', '')::numeric AS list_price, lower(m[2]) AS list_kind
    FROM regexp_match(l.title, '((?:total\\s+)?(wholesale|rrp|retail)(?:\\s+total)?(?:\\s+price)?\\s*:?\\s*\\$\\s*(\\d[\\d,]*(?:\\.\\d{1,3})?))', 'i') m
  ) lp ON true`;

export const LOT_JOINS = BASE_JOINS + TM_JOIN + NEW_JOIN + LIST_JOIN;

/** Trade Me listings needed before a lot is compared with them. */
export const TM_MIN_LISTINGS = 2;
/** An opportunity: expected (else current) all-in at or under this share of the Trade Me price... */
export const TM_OPPORTUNITY_PCT = 70;
/** ...or of the new price in NZ (auction lots usually go for far less than new). */
export const NEW_OPPORTUNITY_PCT = 40;

/**
 * The comparable set used: the same machine when it has 3+ sales, else similar machines,
 * else similar spec score, else whatever exists (in that order).
 */
const COMP = (f: string) =>
  `CASE WHEN cm.n >= 3 THEN cm.${f} WHEN cl.n >= 3 THEN cl.${f} WHEN cs.n >= 3 THEN cs.${f}
        WHEN cm.n IS NOT NULL THEN cm.${f} WHEN cl.n IS NOT NULL THEN cl.${f} ELSE cs.${f} END`;
const COMP_KIND = `CASE WHEN cm.n >= 3 THEN 'machine' WHEN cl.n >= 3 THEN 'similar' WHEN cs.n >= 3 THEN 'spec'
  WHEN cm.n IS NOT NULL THEN 'machine' WHEN cl.n IS NOT NULL THEN 'similar' WHEN cs.n IS NOT NULL THEN 'spec' END`;
/**
 * Expected final (open lots, 3+ comparable sales): the comparables' all-in range, never below
 * the all-in at the current bid. Value index: the typical final for machines with this spec
 * score, as a percentage of this lot's expected final (over 100 = cheaper than typical).
 */
const EXPECTED = (f: "p25" | "p50" | "p75") =>
  `CASE WHEN l.status='open' AND ${COMP("n")} >= 3 THEN GREATEST(${ALL_IN}, ${COMP(f)}) END`;

/** Expected all-in when there is one, else the all-in now: what the Trade Me comparison uses. */
const TM_BASIS = () => `COALESCE(${EXPECTED("p50")}, ${ALL_IN})`;
const TM_PCT = (v: string) => `CASE WHEN tm.tm_n >= ${TM_MIN_LISTINGS} AND tm.tm_mid > 0 THEN round(100 * ${v} / tm.tm_mid)::int END`;
const NEW_PCT = (v: string) => `CASE WHEN np.new_n >= 1 AND np.new_mid > 0 THEN round(100 * ${v} / np.new_mid)::int END`;
/** How good a deal against outside prices, as a share of its opportunity line (1 or less = an opportunity). */
const OPP_SCORE = () => `LEAST(${TM_PCT(TM_BASIS())} / ${TM_OPPORTUNITY_PCT}.0, ${NEW_PCT(TM_BASIS())} / ${NEW_OPPORTUNITY_PCT}.0)`;

export const LOT_COLUMNS = `
  l.id, l.auction_id, l.lot_number, l.title, l.category, l.quantity, l.item_url, l.thumb_url, l.city, l.ends_at,
  l.current_bid, l.bid_count, l.starting_bid, l.buyer_premium, l.status, l.final_bid, l.closed_at,
  l.device_type, l.is_it, l.make, l.model, l.cpu, l.cpu_family, l.cpu_gen, l.ram_gb, l.storage_gb, l.storage_type,
  l.screen_in, l.gpu, l.os, l.faults, l.major_fault, l.first_seen, jsonb_array_length(l.images) AS image_count,
  a.title AS auction_title, a.ends_at AS auction_ends_at,
  (${PRICE}) AS price, ${ALL_IN} AS all_in, ${PREMIUM} AS premium_rate, ${GST} AS gst_rate,
  (t.gst_rate IS NULL) AS gst_assumed,
  ${COMP("n")} AS comp_n, ${COMP("p25")} AS comp_p25, ${COMP("p50")} AS comp_p50, ${COMP("p75")} AS comp_p75,
  ${COMP_KIND} AS comp_kind,
  ${EXPECTED("p25")} AS expected_low, ${EXPECTED("p50")} AS expected_mid, ${EXPECTED("p75")} AS expected_high,
  l.spec_score, l.score_parts, l.score_incomplete, l.photo_fields,
  CASE WHEN cs.n >= 3 AND ${EXPECTED("p50")} > 0 THEN round(100 * cs.p50 / ${EXPECTED("p50")}) END AS value_index,
  cs.n AS spec_n, cs.p50 AS spec_p50,
  (w.lot_id IS NOT NULL) AS watched, w.max_all_in,
  (SELECT count(*)::int FROM favourites f WHERE f.lot_id = l.id) AS watcher_count,
  fh.display_name AS friend_high_bidder,
  (SELECT count(DISTINCT fb.user_id)::int FROM friend_bids fb WHERE fb.lot_id = l.id) AS friend_bidders,
  tm.tm_n, tm.tm_mid, tm.tm_low, tm.tm_at,
  ${TM_PCT(ALL_IN)} AS tm_pct_now, ${TM_PCT(EXPECTED("p50"))} AS tm_pct_expected, ${TM_PCT(TM_BASIS())} AS tm_pct,
  np.new_n, np.new_mid, np.new_at,
  ${NEW_PCT(ALL_IN)} AS new_pct_now, ${NEW_PCT(EXPECTED("p50"))} AS new_pct_expected, ${NEW_PCT(TM_BASIS())} AS new_pct,
  lp.list_price::float8 AS list_price, lp.list_quote, lp.list_kind, strpos(l.title, lp.list_quote) - 1 AS list_start,
  CASE WHEN lp.list_price > 0 THEN round(100 * ${ALL_IN} / lp.list_price)::int END AS list_pct_now,
  (${OPP_SCORE()})::float8 AS opp_score`;

function where(q: SearchQuery, params: unknown[], skip?: string) {
  const w: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.status === "live") w.push(`l.status='open'`);
  if (q.status === "closed") w.push(`l.status='closed'`);
  if (q.q) {
    const terms = q.q;
    w.push(`(l.search @@ websearch_to_tsquery('english', ${p(terms)}) OR l.title ILIKE ${p(`%${terms}%`)})`);
  }
  if (q.it) w.push(`l.is_it`);
  if (q.category?.length && skip !== "category") w.push(`COALESCE(l.category, 'Uncategorised') = ANY(${p(q.category)})`);
  if (q.type?.length && skip !== "type") w.push(`l.device_type = ANY(${p(q.type)})`);
  if (q.make?.length && skip !== "make") w.push(`l.make = ANY(${p(q.make)})`);
  if (q.cpu?.length && skip !== "cpu") w.push(`l.cpu_family = ANY(${p(q.cpu)})`);
  if (q.minGen) w.push(`l.cpu_gen >= ${p(q.minGen)}`);
  if (q.minRam) w.push(`l.ram_gb >= ${p(q.minRam)}`);
  if (q.minStorage) w.push(`l.storage_gb >= ${p(q.minStorage)}`);
  if (q.ssd) w.push(`l.storage_type = 'ssd'`);
  if (q.faults === "none") w.push(`cardinality(l.faults) = 0`);
  if (q.faults === "minor") w.push(`NOT l.major_fault`);
  if (q.maxAllIn) w.push(`${ALL_IN} <= ${p(q.maxAllIn)}`);
  if (q.closingHours) w.push(`l.status='open' AND l.ends_at <= now() + make_interval(hours => ${p(q.closingHours)})`);
  if (q.auction) w.push(`l.auction_id = ${p(q.auction)}`);
  if (q.watch) w.push(`w.lot_id IS NOT NULL`);
  if (q.photo) w.push(`cardinality(l.photo_fields) > 0`);
  if (q.tm) w.push(`l.status='open' AND ((tm.tm_n >= ${TM_MIN_LISTINGS} AND tm.tm_mid > 0) OR (np.new_n >= 1 AND np.new_mid > 0))`);
  if (q.tm === "opp") w.push(`${OPP_SCORE()} <= 1`);
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

const ORDER: Record<string, string> = {
  closing: `l.ends_at ASC NULLS LAST, l.id`,
  ended: `l.closed_at DESC NULLS LAST, l.id DESC`,
  newest: `l.first_seen DESC, l.id DESC`,
  price: `all_in ASC NULLS LAST, l.id`,
  bids: `l.bid_count DESC NULLS LAST, l.id`,
  deal: `CASE WHEN comp_n >= 3 AND comp_p50 > 0 THEN (comp_p50 - all_in) / comp_p50 END DESC NULLS LAST, l.ends_at ASC`,
  value: `value_index DESC NULLS LAST, spec_score DESC NULLS LAST, l.ends_at ASC`,
  expected: `expected_mid ASC NULLS LAST, l.ends_at ASC`,
  score: `spec_score DESC NULLS LAST, l.ends_at ASC`,
  tm: `opp_score ASC NULLS LAST, l.ends_at ASC`,
};

/** All search queries run in parallel; $1 is always the signed-in user (for favourites). */
export async function searchLots(db: Db, q: SearchQuery, userId: number) {
  const params: unknown[] = [userId];
  const w = where(q, params);
  const sort = q.sort ?? (q.status === "closed" ? "ended" : "closing");
  const offset = ((q.page ?? 1) - 1) * (q.perPage ?? 40);
  const itemsQ = db.query(
    `SELECT * FROM (SELECT ${LOT_COLUMNS} FROM lots l ${LOT_JOINS} ${w}) x
     ORDER BY ${ORDER[sort]!.replace(/\bl\./g, "x.")} LIMIT ${q.perPage} OFFSET ${offset}`,
    params,
  );
  const totalP: unknown[] = [userId];
  // Counts skip the Trade Me join unless a Trade Me filter needs it.
  const countJoins = q.tm ? LOT_JOINS : BASE_JOINS;
  const totalQ = db.query(`SELECT count(*)::int AS n FROM lots l ${countJoins} ${where(q, totalP)}`, totalP);

  // Each facet counts with every other filter applied, but not its own, so choices stay visible.
  const facet = async (name: string, expr: string, limit = 40) => {
    const fp: unknown[] = [userId];
    const r = await db.query(
      `SELECT ${expr} AS value, count(*)::int AS n FROM lots l ${countJoins} ${where(q, fp, name)}
       GROUP BY 1 HAVING ${expr} IS NOT NULL ORDER BY n DESC, 1 LIMIT ${limit}`,
      fp,
    );
    return r.rows as Array<{ value: string; n: number }>;
  };
  const [items, total, category, type, make, cpu] = await Promise.all([
    itemsQ,
    totalQ,
    facet("category", `COALESCE(l.category, 'Uncategorised')`),
    facet("type", `l.device_type`),
    facet("make", `l.make`, 30),
    facet("cpu", `l.cpu_family`, 20),
  ]);
  return { total: total.rows[0].n, page: q.page, perPage: q.perPage, items: items.rows, facets: { category, type, make, cpu } };
}
