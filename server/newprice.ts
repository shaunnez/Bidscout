import crypto from "node:crypto";
import { tx, type Db } from "./db.ts";
import type { ParallelSearch, SearchHit } from "./parallel.ts";
import { stripContacts } from "./redact.ts";
import { getTradeMeSettings } from "./settings.ts";
import { autoStatus, linkLot, loadLookup, LookupError, queryKey, tidyQuery, tradeMeStatus } from "./trademe.ts";
import { isRating, modelNumber } from "../shared/lookup.ts";

/**
 * New price in NZ for a product (mostly lots that aren't computers): a web search through
 * Parallel for the product's brand and model, kept to New Zealand shops (.nz sites, not Trade Me),
 * and each shop's price quoted from the words Parallel's index holds for that page. No shop page
 * is fetched by BidScout. Shares the Trade Me prices switch and daily limits; answers kept 7 days.
 */

export const NEW_CACHE_DAYS = 7;
const MAX_SHOPS = 5;
const NEAR = 300;
const SKIP_HOSTS = /(^|\.)(trademe\.co\.nz|number8\.bid|facebook\.com|pricespy\.co\.nz|priceme\.co\.nz)$/i;

export interface ShopPrice {
  url: string;
  host: string;
  title: string | null;
  price: number;
  excerpt: string;
  quote_start: number;
  quote_end: number;
  page_sha256: string;
}

const PRICE = /(?:NZ)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?![\d,])/g;
/** Not the price you'd pay for the product: a saving, an old, list or RRP price, a price before GST, shipping or a payment plan. */
const NOT_BEFORE = /(?:was|save|saving|you save|from only|rrp|r\.r\.p\.?|list price|ex\.? ?gst|excl\.? ?gst|excluding gst|shipping|delivery|freight|deposit|discount|off|afterpay|laybuy|zip|weekly|fortnightly|monthly|per week|per month|over)\s*[:-]?\s*$/i;
const NOT_AFTER = /^\s*(?:off|per\b|\/\s*(?:wk|week|mth|month|fortnight)|p\/?m\b|pw\b|a week|weekly|fortnightly|monthly|shipping|delivery|deposit|\+ ?gst|excl)/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The model a shop page must name: the lot's own model number when the search contains it (the
 * listing says what it is), else the search's last model-like word that isn't a size or rating
 * ("DHP486" in "Makita DHP486 18V", "X100" in "WD-40 X100").
 */
export function searchModel(query: string, lotModel?: string | null): string | undefined {
  if (lotModel && norm(query).includes(norm(lotModel))) return lotModel;
  return query.split(/\s+/).filter((w) => /\d/.test(w) && !isRating(w) && (/[a-z]/i.test(w) || w.replace(/\D/g, "").length >= 3)).pop();
}

/** Where the product is named in the text: the model number if there is one, else most of the search's words. */
export function productMention(text: string, query: string, model = searchModel(query)): number {
  if (model) {
    const want = norm(model);
    // Compare without spaces or dashes ("SHI2000-22" = "SHI 2000 22"), mapping back to the text.
    let flat = "";
    const at: number[] = [];
    for (let i = 0; i < text.length; i++) if (/[a-z0-9]/i.test(text[i]!)) { flat += text[i]!.toLowerCase(); at.push(i); }
    const k = flat.indexOf(want);
    return k < 0 ? -1 : at[k]!;
  }
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const lower = text.toLowerCase();
  const found = words.filter((w) => lower.includes(w));
  return words.length && found.length >= Math.max(2, Math.ceil(words.length * 0.6)) ? lower.indexOf(found[0]!) : -1;
}

/** The price nearest the product's name in one page's words, quoted with the words around it. */
export function shopPrice(hit: SearchHit, query: string, model = searchModel(query)): ShopPrice | null {
  let host: string;
  try {
    host = new URL(hit.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!/\.nz$/i.test(host) || SKIP_HOSTS.test(host)) return null;
  const sha = crypto.createHash("sha256").update(hit.excerpts.join("\n")).digest("hex");
  let best: (ShopPrice & { dist: number }) | null = null;
  for (const raw of hit.excerpts) {
    const text = stripContacts(raw.replace(/\s+/g, " "));
    const at = productMention(text, query, model);
    if (at < 0) continue;
    for (const m of text.matchAll(PRICE)) {
      const i = m.index!;
      const dist = i >= at ? i - at : (at - i) * 2; // prices after the name are likelier to be its own
      if (dist > NEAR) continue;
      if (NOT_BEFORE.test(text.slice(Math.max(0, i - 25), i)) || NOT_AFTER.test(text.slice(i + m[0].length, i + m[0].length + 20))) continue;
      const price = Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(m[2]) / 100 : 0);
      if (price < 5 || price > 200_000) continue;
      if (!best || dist < best.dist) {
        const from = Math.max(0, Math.min(at, i) - 80);
        const to = Math.min(text.length, Math.max(at, i + m[0].length) + 80);
        best = { url: hit.url, host, title: hit.title, price, excerpt: text.slice(from, to), quote_start: i - from, quote_end: i - from + m[0].length, page_sha256: sha, dist };
      }
    }
  }
  if (!best) return null;
  const { dist: _d, ...shop } = best;
  // Page titles can carry contact details too.
  return { ...shop, title: shop.title === null ? null : stripContacts(shop.title) };
}

export interface NewPriceDeps {
  db: Db;
  parallel: ParallelSearch | null;
  now?: () => Date;
}

/** Is the new-price lookup usable now, and if not, why not. */
export async function newPriceStatus(db: Pick<Db, "query">, parallel: ParallelSearch | null) {
  if (!parallel) return { available: false, reason: "Needs a Parallel API key (PARALLEL_API_KEY)." };
  const s = await tradeMeStatus(db, { firecrawl: null, searchers: [{ name: "parallel", search: async () => { throw new Error("unused"); } }] });
  return { available: s.available, reason: s.reason, used: s.used, dailyLimit: s.dailyLimit };
}

/** New-price lookups in progress in this process, by query key. */
const running = new Map<string, Promise<unknown>>();

const CACHED = `SELECT id FROM price_lookups WHERE source='newprice' AND query_key=$1 AND status='ok' AND created_at > $2::timestamptz - make_interval(days => $3) ORDER BY id DESC LIMIT 1`;

/** Runs (or reuses, for 7 days) the new-price lookup for `query`, and links it to the lot. */
export async function newPriceLookup(deps: NewPriceDeps, input: { lotId: number | null; userId: number | null; query: string; auto?: boolean; fresh?: boolean }): Promise<any> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const query = tidyQuery(input.query);
  const key = `new:${queryKey(query)}`;
  if (queryKey(query).length < 3) throw new LookupError("Search text is too short.", 400);
  if (!deps.parallel) throw new LookupError("Needs a Parallel API key (PARALLEL_API_KEY).", 503);
  const reuse = async (cachedId: number) => {
    await linkLot(db, cachedId, input.lotId);
    return { ...(await loadLookup(db, cachedId))!, cached: true };
  };
  // "Search shops again" (fresh) skips the saved answer.
  const cached = input.fresh ? undefined : (await db.query(CACHED, [key, now(), NEW_CACHE_DAYS])).rows[0];
  if (cached) return reuse(Number(cached.id));
  // The same search already running: wait for it and take its answer.
  const inFlight = running.get(key);
  if (inFlight) {
    await inFlight.catch(() => {});
    return newPriceLookup(deps, { ...input, fresh: false });
  }
  const work = run(deps, input, query, key, now, reuse);
  running.set(key, work);
  try {
    return await work;
  } finally {
    running.delete(key);
  }
}

async function run(deps: NewPriceDeps, input: { lotId: number | null; userId: number | null; auto?: boolean; fresh?: boolean }, query: string, key: string, now: () => Date, reuse: (id: number) => Promise<any>) {
  const { db } = deps;
  const parallel = deps.parallel!;
  // Every query in the locked section uses the transaction's client: one that waits for another
  // pool client while holding the lock could stall them all.
  const reserved = await tx(db, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('bidscout:trademe-limit'))`);
    // Another process may have just finished the same search.
    const done = input.fresh ? undefined : (await c.query(CACHED, [key, now(), NEW_CACHE_DAYS])).rows[0];
    if (done) return { cachedId: Number(done.id) };
    const s = await getTradeMeSettings(c);
    if (!s.enabled) throw new LookupError("An admin can turn Trade Me prices on in Settings.", 403);
    const status = input.auto ? await autoStatus(c) : await newPriceStatus(c, parallel);
    if (!status.available) throw new LookupError(status.reason!, 403);
    const r = await c.query(
      `INSERT INTO price_lookups (source, query, query_key, lot_id, requested_by, status, created_at, origin, method) VALUES ('newprice',$1,$2,$3,$4,'running',$5,$6,'parallel-search') RETURNING id`,
      [query, key, input.lotId, input.userId, now(), input.auto ? "auto" : "button"],
    );
    return { id: Number(r.rows[0].id) };
  });
  if ("cachedId" in reserved) return reuse(reserved.cachedId!);
  const id = reserved.id;
  let error: string | null = null;
  let hits: SearchHit[] = [];
  const shops: ShopPrice[] = [];
  // For a lot, the model its listing names is what a shop page must mention.
  const lot = input.lotId === null ? null : (await db.query(`SELECT title, description FROM lots WHERE id=$1`, [input.lotId])).rows[0];
  const model = searchModel(query, lot ? modelNumber(lot.description ?? "", lot.title) : null);
  try {
    hits = await parallel.search(
      `Current retail price in New Zealand dollars of the ${query}, new, from New Zealand shops.`,
      [`${query} price NZ`, `${query} buy New Zealand`],
      { maxResults: 15, country: "NZ", excludeDomains: ["trademe.co.nz", "number8.bid", "facebook.com"] },
    );
    const seen = new Set<string>();
    for (const h of hits) {
      const shop = shopPrice(h, query, model);
      if (!shop || seen.has(shop.host)) continue;
      seen.add(shop.host);
      shops.push(shop);
      if (shops.length >= MAX_SHOPS) break;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  const at = now();
  await tx(db, async (c) => {
    for (const s of shops)
      await c.query(
        `INSERT INTO price_lookup_items (lookup_id, url, listing_id, title, status, price, price_kind, excerpt, quote_start, quote_end, verified, page_sha256, fetched_at, source_url)
         VALUES ($1,$2,$3,$4,'new',$5,'new',$6,$7,$8,true,$9,$10,$2)`,
        [id, s.url, s.host, s.title, s.price, s.excerpt, s.quote_start, s.quote_end, s.page_sha256, at],
      );
    await c.query(
      `UPDATE price_lookups SET status=$2, error=$3, searched=$4, found=$5, candidates=$6, queries=$7 WHERE id=$1`,
      [id, error ? "failed" : "ok", error, hits.length, shops.length, hits.filter((h) => /\.nz(\/|$)/i.test(h.url.replace(/^https?:\/\//, "").split("/")[0] + "/")).length, [query]],
    );
  });
  if (error) throw new LookupError(error, 502);
  await linkLot(db, id, input.lotId);
  return { ...(await loadLookup(db, id))!, cached: false };
}
