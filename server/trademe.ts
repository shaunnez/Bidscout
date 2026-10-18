import crypto from "node:crypto";
import type { Db } from "./db.ts";
import type { FirecrawlClient } from "./firecrawl.ts";
import { stripContacts } from "./redact.ts";
import { parseRobots, robotsAllows, type Robots } from "./robots.ts";
import { getTradeMeSettings } from "./settings.ts";

/**
 * Trade Me prices for a lot, on demand (a button in the lot drawer). Runs only when an admin has
 * turned it on and a Firecrawl key is set.
 *
 *  1. Firecrawl web search for the lot's search text, limited to trademe.co.nz. BidScout never
 *     opens Trade Me's own search pages: its robots.txt disallows them.
 *  2. Up to MAX_LISTINGS marketplace listing pages from those results, each checked against
 *     Trade Me's robots.txt first, read one at a time by Firecrawl (its servers, its cache of up
 *     to a day), with structured extraction of price, status and condition.
 *  3. Each price is looked for in the page text. When found, the words around it (contact
 *     details removed) are kept as the citation; the page itself is not stored.
 *
 * Answers are reused for CACHE_DAYS for the same search text; the group shares a daily limit.
 */

export const MAX_LISTINGS = 5;
export const CACHE_DAYS = 3;
const AGENTS = ["bidscout", "firecrawlagent"];
const LISTING = /^https:\/\/(?:www\.)?trademe\.co\.nz\/a\/marketplace\/[^?#]*?\/listing\/(\d+)/i;

export const LISTING_SCHEMA = {
  type: "object",
  properties: {
    title: { type: ["string", "null"] },
    status: { type: ["string", "null"], enum: ["open", "closed", "sold", null] },
    price: { type: ["number", "null"] },
    price_kind: { type: ["string", "null"], enum: ["sold", "current_bid", "buy_now", "asking", "starting", null] },
    buy_now: { type: ["number", "null"] },
    bid_count: { type: ["integer", "null"] },
    condition: { type: ["string", "null"], enum: ["new", "used", "refurbished", null] },
    closes: { type: ["string", "null"] },
    location: { type: ["string", "null"] },
  },
};

export const LISTING_PROMPT =
  "This is one Trade Me listing page. Extract: title; status (open if it is still running, sold if the page says it sold, " +
  "closed if it ended or was withdrawn without a sale); price, the single most telling price shown, in NZD as a number: the " +
  "sold price if it sold, else the current bid if there are bids, else the Buy Now price, else the asking or fixed price, else " +
  "the starting price; price_kind naming which of those it is; buy_now, the Buy Now price if one is shown; bid_count; condition " +
  "(new, used or refurbished) as stated; closes, the closing date or time text as shown; location, the town or region only. " +
  "Use null for anything not shown. Never include the seller's name or any contact details.";

export interface TradeMeItem {
  url: string;
  listing_id: string;
  title: string | null;
  status: string | null;
  price: number | null;
  price_kind: string | null;
  buy_now: number | null;
  bid_count: number | null;
  condition: string | null;
  closes: string | null;
  location: string | null;
  excerpt: string | null;
  quote_start: number | null;
  quote_end: number | null;
  verified: boolean;
  page_sha256: string;
  fetched_at: Date;
}

/** The canonical listing URL (no query string) and its listing number, or null if it isn't a marketplace listing. */
export function listingUrl(url: string): { url: string; listingId: string } | null {
  const m = LISTING.exec(url);
  if (!m) return null;
  return { url: m[0].replace(/^https:\/\/trademe/i, "https://www.trademe"), listingId: m[1]! };
}

export const queryKey = (q: string) => q.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

/**
 * Finds `price` written on the page ("$1,234.50", "$1,234", "$1234") and returns the words around
 * it, with contact details removed, and where the price sits in that excerpt.
 */
export function findPrice(markdown: string, price: number | null): { excerpt: string; start: number; end: number } | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const whole = Math.round(price) === price;
  const fmt = (n: number, cents: boolean) => n.toLocaleString("en-NZ", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  const forms = new Set([`$${fmt(price, true)}`, `$${fmt(price, true).replace(/,/g, "")}`]);
  if (whole) for (const f of [`$${fmt(price, false)}`, `$${fmt(price, false).replace(/,/g, "")}`]) forms.add(f);
  let at = -1;
  let quote = "";
  for (const f of [...forms].sort((a, b) => b.length - a.length)) {
    // Not followed by more digits or cents, so $12 doesn't match $120 and $1,234 doesn't match $1,234.50.
    const re = new RegExp(f.replace(/[$.]/g, "\\$&") + "(?![\\d,]*\\d|\\.\\d)");
    const m = re.exec(markdown);
    if (m && (at < 0 || m.index < at)) {
      at = m.index;
      quote = m[0];
    }
  }
  if (at < 0) return null;
  const before = stripContacts(markdown.slice(Math.max(0, at - 90), at)).replace(/\s+/g, " ").trimStart();
  const after = stripContacts(markdown.slice(at + quote.length, at + quote.length + 90)).replace(/\s+/g, " ").trimEnd();
  return { excerpt: before + quote + after, start: before.length, end: before.length + quote.length };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[$,\s]/g, ""))) ? Number(v.replace(/[$,\s]/g, "")) : null);
const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? stripContacts(v.trim()).slice(0, max) : null);
const oneOf = (v: unknown, allowed: string[]) => (typeof v === "string" && allowed.includes(v) ? v : null);

/** Turns one scraped page into a stored item. */
export function toItem(url: string, listingId: string, markdown: string, json: Record<string, unknown> | null, fetchedAt: Date): TradeMeItem {
  const j = json ?? {};
  const price = num(j.price);
  const found = findPrice(markdown, price);
  return {
    url, listing_id: listingId,
    title: str(j.title),
    status: oneOf(j.status, ["open", "closed", "sold"]),
    price,
    price_kind: oneOf(j.price_kind, ["sold", "current_bid", "buy_now", "asking", "starting"]),
    buy_now: num(j.buy_now),
    bid_count: Number.isInteger(j.bid_count) ? (j.bid_count as number) : null,
    condition: oneOf(j.condition, ["new", "used", "refurbished"]),
    closes: str(j.closes, 80),
    location: str(j.location, 80),
    excerpt: found?.excerpt ?? null,
    quote_start: found?.start ?? null,
    quote_end: found?.end ?? null,
    verified: !!found,
    page_sha256: crypto.createHash("sha256").update(markdown).digest("hex"),
    fetched_at: fetchedAt,
  };
}

export class LookupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Trade Me's robots.txt, fetched directly (it's a public file for crawlers) and kept for a day. */
export function robotsLoader(fetchFn: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i), now = () => Date.now()) {
  let cached: { robots: Robots; at: number } | null = null;
  return async (): Promise<Robots> => {
    if (cached && now() - cached.at < 86_400_000) return cached.robots;
    const res = await fetchFn("https://www.trademe.co.nz/robots.txt", { headers: { "User-Agent": "BidScout/0.1 (robots.txt check)" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new LookupError(`Couldn't read Trade Me's robots.txt (HTTP ${res.status}), so nothing was fetched.`, 502);
    cached = { robots: parseRobots(await res.text()), at: now() };
    return cached.robots;
  };
}

export interface LookupDeps {
  db: Db;
  firecrawl: FirecrawlClient | null;
  robots: () => Promise<Robots>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export async function loadLookup(db: Db, id: number) {
  const l = (await db.query(`SELECT * FROM price_lookups WHERE id=$1`, [id])).rows[0];
  if (!l) return null;
  const items = (await db.query(`SELECT * FROM price_lookup_items WHERE lookup_id=$1 ORDER BY id`, [id])).rows;
  return { ...l, items };
}

/** Is the button usable right now, and if not, why not. */
export async function tradeMeStatus(db: Db, firecrawl: FirecrawlClient | null) {
  const s = await getTradeMeSettings(db);
  const used = Number((await db.query(`SELECT count(*) AS n FROM price_lookups WHERE source='trademe' AND created_at > now() - interval '24 hours'`)).rows[0].n);
  const reason = !firecrawl ? "Needs a Firecrawl API key (FIRECRAWL_API_KEY in Railway)." : !s.enabled ? "An admin can turn Trade Me prices on in Settings." : used >= s.dailyLimit ? `The group's ${s.dailyLimit} lookups for the last 24 hours are used up.` : null;
  return { available: !reason, reason, used, dailyLimit: s.dailyLimit };
}

const running = new Map<string, Promise<unknown>>();

/** Runs (or reuses) a Trade Me lookup for `query`. */
export async function tradeMeLookup(deps: LookupDeps, input: { lotId: number | null; userId: number; query: string }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, 120);
  const key = queryKey(query);
  if (key.length < 3) throw new LookupError("Search text is too short.", 400);

  const cached = (await db.query(
    `SELECT id FROM price_lookups WHERE source='trademe' AND query_key=$1 AND status='ok' AND created_at > $2::timestamptz - make_interval(days => $3)
     ORDER BY id DESC LIMIT 1`,
    [key, now(), CACHE_DAYS],
  )).rows[0];
  if (cached) return { ...(await loadLookup(db, Number(cached.id)))!, cached: true };

  const status = await tradeMeStatus(db, deps.firecrawl);
  if (!status.available) throw new LookupError(status.reason!, deps.firecrawl ? 403 : 503);
  if (running.has(key)) {
    await running.get(key);
    return tradeMeLookup(deps, input);
  }
  const work = run(deps, input, query, key, now, sleep);
  running.set(key, work);
  try {
    return { ...(await work), cached: false };
  } finally {
    running.delete(key);
  }
}

async function run(deps: LookupDeps, input: { lotId: number | null; userId: number }, query: string, key: string, now: () => Date, sleep: (ms: number) => Promise<void>) {
  const { db } = deps;
  const fc = deps.firecrawl!;
  const items: TradeMeItem[] = [];
  let credits = 0;
  let searched = 0;
  let error: string | null = null;
  try {
    const robots = await deps.robots();
    const found = await fc.search(query, { limit: 10, includeDomains: ["trademe.co.nz"], country: "NZ" });
    credits += found.credits ?? 0;
    searched = found.results.length;
    const seen = new Set<string>();
    const targets = found.results
      .map((r) => listingUrl(r.url))
      .filter((l): l is { url: string; listingId: string } => !!l && !seen.has(l.listingId) && !!seen.add(l.listingId))
      .filter((l) => robotsAllows(robots, l.url, AGENTS))
      .slice(0, MAX_LISTINGS);
    for (const [i, t] of targets.entries()) {
      if (i > 0) await sleep(1000);
      try {
        const page = await fc.scrape(t.url, { schema: LISTING_SCHEMA, prompt: LISTING_PROMPT, maxAgeMs: 86_400_000 });
        credits += page.credits ?? 0;
        if (page.statusCode && page.statusCode >= 400) continue; // listing gone
        items.push(toItem(t.url, t.listingId, page.markdown, page.json, now()));
      } catch (e) {
        if ((e as { status?: number }).status === 402) throw e;
        // One unreadable listing doesn't spoil the rest.
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  const r = await db.query(
    `INSERT INTO price_lookups (source, query, query_key, lot_id, requested_by, status, error, searched, found, credits, created_at)
     VALUES ('trademe',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [query, key, input.lotId, input.userId, error ? "failed" : "ok", error, searched, items.length, credits || null, now()],
  );
  const id = Number(r.rows[0].id);
  for (const it of items)
    await db.query(
      `INSERT INTO price_lookup_items (lookup_id, url, listing_id, title, status, price, price_kind, buy_now, bid_count, condition, closes,
         location, excerpt, quote_start, quote_end, verified, page_sha256, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, it.url, it.listing_id, it.title, it.status, it.price, it.price_kind, it.buy_now, it.bid_count, it.condition, it.closes,
        it.location, it.excerpt, it.quote_start, it.quote_end, it.verified, it.page_sha256, it.fetched_at],
    );
  if (error) throw new LookupError(error, 502);
  return (await loadLookup(db, id))!;
}
