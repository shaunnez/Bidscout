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
  sort?: "closing" | "newest" | "price" | "deal" | "bids" | "ended";
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
    sort: (["closing", "newest", "price", "deal", "bids", "ended"] as const).find((s) => s === q.sort),
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

export const LOT_JOINS = `
  JOIN auctions a ON a.id = l.auction_id
  LEFT JOIN LATERAL (SELECT premium_rate, gst_rate FROM auction_terms WHERE auction_id = l.auction_id ORDER BY id DESC LIMIT 1) t ON true
  LEFT JOIN comp_stats cm ON cm.key = l.machine_key || ${FAULT_SUFFIX}
  LEFT JOIN comp_stats cl ON cl.key = l.loose_key || ${FAULT_SUFFIX}
  LEFT JOIN watchlist w ON w.lot_id = l.id`;

/** The comparable set used: exact machine when it has 3+ sales, else similar machines, else whatever exists. */
const COMP = (f: string) =>
  `CASE WHEN cm.n >= 3 THEN cm.${f} WHEN cl.n >= 3 THEN cl.${f} WHEN cm.n IS NOT NULL THEN cm.${f} ELSE cl.${f} END`;

export const LOT_COLUMNS = `
  l.id, l.auction_id, l.lot_number, l.title, l.category, l.quantity, l.item_url, l.thumb_url, l.city, l.ends_at,
  l.current_bid, l.bid_count, l.starting_bid, l.buyer_premium, l.status, l.final_bid, l.closed_at,
  l.device_type, l.is_it, l.make, l.model, l.cpu, l.cpu_family, l.cpu_gen, l.ram_gb, l.storage_gb, l.storage_type,
  l.screen_in, l.gpu, l.os, l.faults, l.major_fault, l.first_seen, jsonb_array_length(l.images) AS image_count,
  a.title AS auction_title, a.ends_at AS auction_ends_at,
  (${PRICE}) AS price, ${ALL_IN} AS all_in, ${PREMIUM} AS premium_rate, ${GST} AS gst_rate,
  (t.gst_rate IS NULL) AS gst_assumed,
  ${COMP("n")} AS comp_n, ${COMP("p25")} AS comp_p25, ${COMP("p50")} AS comp_p50, ${COMP("p75")} AS comp_p75,
  CASE WHEN cm.n >= 3 THEN 'machine' WHEN cl.n >= 3 THEN 'similar' WHEN cm.n IS NOT NULL THEN 'machine' WHEN cl.n IS NOT NULL THEN 'similar' END AS comp_kind,
  (w.lot_id IS NOT NULL) AS watched, w.max_all_in`;

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
  return w.length ? `WHERE ${w.join(" AND ")}` : "";
}

const ORDER: Record<string, string> = {
  closing: `l.ends_at ASC NULLS LAST, l.id`,
  ended: `l.closed_at DESC NULLS LAST, l.id DESC`,
  newest: `l.first_seen DESC, l.id DESC`,
  price: `all_in ASC NULLS LAST, l.id`,
  bids: `l.bid_count DESC NULLS LAST, l.id`,
  deal: `CASE WHEN comp_n >= 3 AND comp_p50 > 0 THEN (comp_p50 - all_in) / comp_p50 END DESC NULLS LAST, l.ends_at ASC`,
};

export async function searchLots(db: Db, q: SearchQuery) {
  const params: unknown[] = [];
  const w = where(q, params);
  const sort = q.sort ?? (q.status === "closed" ? "ended" : "closing");
  const offset = ((q.page ?? 1) - 1) * (q.perPage ?? 40);
  const items = await db.query(
    `SELECT * FROM (SELECT ${LOT_COLUMNS} FROM lots l ${LOT_JOINS} ${w}) x
     ORDER BY ${ORDER[sort]!.replace(/\bl\./g, "x.")} LIMIT ${q.perPage} OFFSET ${offset}`,
    params,
  );
  const totalP: unknown[] = [];
  const total = await db.query(`SELECT count(*)::int AS n FROM lots l ${LOT_JOINS} ${where(q, totalP)}`, totalP);

  // Each facet counts with every other filter applied, but not its own, so choices stay visible.
  const facet = async (name: string, expr: string, limit = 40) => {
    const fp: unknown[] = [];
    const r = await db.query(
      `SELECT ${expr} AS value, count(*)::int AS n FROM lots l ${LOT_JOINS} ${where(q, fp, name)}
       GROUP BY 1 HAVING ${expr} IS NOT NULL ORDER BY n DESC, 1 LIMIT ${limit}`,
      fp,
    );
    return r.rows as Array<{ value: string; n: number }>;
  };
  const [category, type, make, cpu] = await Promise.all([
    facet("category", `COALESCE(l.category, 'Uncategorised')`),
    facet("type", `l.device_type`),
    facet("make", `l.make`, 30),
    facet("cpu", `l.cpu_family`, 20),
  ]);
  return { total: total.rows[0].n, page: q.page, perPage: q.perPage, items: items.rows, facets: { category, type, make, cpu } };
}
