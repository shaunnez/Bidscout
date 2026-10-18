import type { Db } from "./db.ts";
import { lookupQuery, modelNumber } from "../shared/lookup.ts";
import { NEW_CACHE_DAYS, newPriceLookup } from "./newprice.ts";
import type { ParallelSearch } from "./parallel.ts";
import { saveTradeMeSettings } from "./settings.ts";
import { TradeMeBlocked, type TradeMeSearcher } from "./tmsearch.ts";
import { autoStatus, CACHE_DAYS, LookupError, searchKey, tradeMeLookup, type LookupDeps } from "./trademe.ts";

/**
 * Automatic prices (Shaun's decisions, 18 Oct 2026): every open lot that isn't a bulk or mixed lot
 * gets the Trade Me lookup the button would run for it, and products with a model number that
 * aren't computers also get a new-price-in-NZ lookup (server/newprice.ts). All through Parallel
 * only, many at a time with their starts spread out, under one daily limit (Settings). Lots that
 * share a search share one answer (the cache), so each search runs once. If Trade Me refuses
 * Parallel, or lookups keep failing, it turns itself off and Settings says why.
 */

/** Bulk, pallet and mixed lots (the same words as isBulkLot in shared/lookup.ts): nothing to price. */
export const NOT_BULK = `l.title !~* '\\m(pallets? (lot|of|load)|bulk|assorted|mixed|miscellaneous|misc|contents of|box(es)? of|lots? of|job lot|bundle of)\\M'`;
/**
 * Might have a model number (a superset of modelNumber in shared/lookup.ts, which decides): a code
 * of capitals and digits, or a model / part number label. Lots without one never get a new price.
 */
export const MODELISH = `(l.description ~ '(?=[A-Z0-9./-]*[0-9])(?=[A-Z0-9./-]*[A-Z])[A-Z0-9][A-Z0-9./-]{3,}[A-Z0-9]'
  OR l.title ~ '(?=[A-Z0-9./-]*[0-9])(?=[A-Z0-9./-]*[A-Z])[A-Z0-9][A-Z0-9./-]{3,}[A-Z0-9]'
  OR l.description ~* '\\m(model|part\\s*(no|number)|p/n|pn|sku|mpn)\\M'
  OR l.title ~* '\\m(model|part\\s*(no|number)|p/n|pn|sku|mpn)\\M')`;
const HAS = (source: string, days: string) => `EXISTS (SELECT 1 FROM price_lookup_lots k JOIN price_lookups pl ON pl.id = k.lookup_id
  WHERE k.lot_id = l.id AND pl.status = 'ok' AND pl.source = '${source}' AND pl.created_at > now() - make_interval(days => ${days}))`;

/**
 * Gentle on Trade Me (Shaun asked, 18 Oct 2026, after some failures): one lookup starts every 3
 * seconds, at most 5 run at once, and after a failed lookup nothing new starts for 30 seconds.
 */
export const AUTO_CONCURRENCY = 5;
export const AUTO_GAP_MS = 3_000;
export const AUTO_COOL_OFF_MS = 30_000;
const MAX_FAILURES_IN_A_ROW = 5;
/** Enough lots for a whole day's limit in one pass. */
const BATCH = 1000;

/**
 * Open lots waiting for a price, the soonest to close first: no Trade Me answer under 7 days old,
 * or (not computers) no new-price answer under 7 days old.
 */
export async function lotsToPrice(db: Pick<Db, "query">, limit = BATCH, noModel: number[] = []) {
  const r = await db.query(
    `SELECT * FROM (
       SELECT l.id, l.is_it, l.make, l.model, l.cpu, l.title, l.description, l.ram_gb::float8 AS ram_gb, l.storage_gb::float8 AS storage_gb,
              l.storage_type, l.device_type, l.ends_at, NOT ${HAS("trademe", "$1")} AS need_tm,
              (NOT l.is_it AND ${MODELISH} AND NOT (l.id = ANY($4::int[])) AND NOT ${HAS("newprice", "$2")}) AS need_new
       FROM lots l
       WHERE l.status = 'open' AND (l.ends_at IS NULL OR l.ends_at > now()) AND ${NOT_BULK}) x
     WHERE need_tm OR need_new
     ORDER BY ends_at ASC NULLS LAST, id
     LIMIT $3`,
    [CACHE_DAYS, NEW_CACHE_DAYS, limit, noModel],
  );
  return r.rows;
}

/**
 * For Settings, read live: open lots worth pricing and how many have a current answer, today's automatic
 * lookups, how many are running now, and the latest ten (all from the database, so it works
 * whichever process runs the loop).
 */
export async function autoProgress(db: Pick<Db, "query">) {
  // Priced: a Trade Me answer, and for a product with a model number (modelNumber decides, as in
  // the worker) a new price too. Worked out from the database, whichever process runs the loop.
  const rows = (await db.query(
    `SELECT l.is_it, l.title, l.description, ${HAS("trademe", "$1")} AS has_tm, ${HAS("newprice", "$2")} AS has_new
     FROM lots l WHERE l.status = 'open' AND (l.ends_at IS NULL OR l.ends_at > now()) AND ${NOT_BULK}`,
    [CACHE_DAYS, NEW_CACHE_DAYS],
  )).rows as Array<{ is_it: boolean; title: string; description: string | null; has_tm: boolean; has_new: boolean }>;
  const priced = rows.filter((l) => l.has_tm && (l.is_it || l.has_new || !modelNumber(l.description ?? "", l.title))).length;
  const s = await autoStatus(db);
  const running = Number((await db.query(`SELECT count(*) AS n FROM price_lookups WHERE origin='auto' AND status='running'`)).rows[0].n);
  const recent = (await db.query(
    `SELECT pl.id, pl.lot_id, pl.source, pl.query, pl.status, pl.found, left(pl.error, 200) AS error, pl.created_at, l.title AS lot_title
     FROM price_lookups pl LEFT JOIN lots l ON l.id = pl.lot_id
     WHERE pl.origin = 'auto' ORDER BY pl.id DESC LIMIT 10`,
  )).rows;
  // The limit is a rolling 24 hours: when it's reached, more are allowed as the oldest one passes 24 hours.
  const oldest = s.used >= s.dailyLimit
    ? (await db.query(`SELECT min(created_at) AS at FROM price_lookups WHERE source IN ('trademe','newprice') AND origin='auto' AND created_at > now() - interval '24 hours'`)).rows[0].at
    : null;
  const resumesAt = oldest ? new Date(new Date(oldest).getTime() + 86_400_000).toISOString() : null;
  return { openLots: rows.length, priced, used: s.used, dailyLimit: s.dailyLimit, running, recent, resumesAt };
}

export interface AutoDeps {
  db: Db;
  parallel: TradeMeSearcher;
  /** Parallel's search, for new prices; without it only Trade Me lookups run. */
  search?: ParallelSearch | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  gapMs?: number;
  /** After a failed lookup, how long before the next one starts. */
  coolOffMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

/** Lots whose lookup failed are left alone for a day (in this process), per kind of lookup. */
const retryAfter = new Map<string, number>();
/** Lots the SQL thought might have a model number but modelNumber found none (so no new price). */
const noModel = new Set<number>();
let failuresInARow = 0;

async function stop(db: Db, reason: string) {
  await saveTradeMeSettings(db, { autoEnabled: false, autoStopped: { reason, at: new Date().toISOString() } }, null);
}

/**
 * One pass over the lots waiting for a price. Lots are grouped by search first, so two lots
 * sharing one never start it twice: the first lot of a group runs the lookup, the rest reuse it.
 */
export async function autoPriceTick(deps: AutoDeps) {
  const { db } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const gap = deps.gapMs ?? AUTO_GAP_MS;
  const coolOff = deps.coolOffMs ?? AUTO_COOL_OFF_MS;
  const out = { looked: 0, reused: 0, failed: 0, stopped: null as string | null };
  if (!(await autoStatus(db)).available) return out;
  // Parallel only: no Chromium (too heavy to run in bulk) and no Firecrawl web-search fallback.
  const lookupDeps: LookupDeps = { db, firecrawl: null, searchers: [deps.parallel], robots: async () => { throw new Error("not used"); } };

  type Kind = "trademe" | "newprice";
  const groups = new Map<string, { kind: Kind; lots: Array<{ id: number; query: string }> }>();
  const add = (kind: Kind, key: string, lot: { id: number; query: string }) => {
    if ((retryAfter.get(`${kind}:${lot.id}`) ?? 0) > now()) return;
    const g = groups.get(`${kind}|${key}`) ?? { kind, lots: [] };
    g.lots.push(lot);
    groups.set(`${kind}|${key}`, g);
  };
  for (const lot of await lotsToPrice(db, BATCH, [...noModel])) {
    const query = lookupQuery(lot);
    if (!query) continue;
    if (lot.need_tm) add("trademe", searchKey(query, lot.device_type, lot.title), { id: lot.id, query });
    // New prices only for products with a model number: a shop search for "office desk" means little.
    if (lot.need_new && deps.search) {
      if (modelNumber(lot.description ?? "", lot.title)) add("newprice", query.toLowerCase(), { id: lot.id, query });
      else noModel.add(lot.id); // left out of later passes, so it doesn't hold a place in the batch
    }
  }
  const queue = [...groups.values()];
  let halt = false;
  let nextStart = 0;

  // Starts at least `gap` apart across all workers; a reused answer gives its slot back.
  const takeSlot = async () => {
    const at = Math.max(now(), nextStart);
    nextStart = at + gap;
    if (at > now()) await sleep(at - now());
  };
  const lookup = (kind: Kind, lot: { id: number; query: string }) =>
    kind === "trademe"
      ? tradeMeLookup(lookupDeps, { lotId: lot.id, userId: null, query: lot.query, auto: true })
      : newPriceLookup({ db, parallel: deps.search ?? null }, { lotId: lot.id, userId: null, query: lot.query, auto: true });

  const worker = async () => {
    for (let group = queue.shift(); group && !halt && !deps.signal?.aborted; group = queue.shift()) {
      const [first, ...rest] = group.lots;
      await takeSlot();
      if (halt) return;
      try {
        const r = await lookup(group.kind, first!);
        if (r.cached) {
          out.reused++;
          nextStart = Math.max(now(), nextStart - gap);
        } else {
          out.looked++;
          failuresInARow = 0;
        }
      } catch (e) {
        if (e instanceof TradeMeBlocked) {
          if (!halt) {
            halt = true;
            out.stopped = `Trade Me refused Parallel, so automatic lookups stopped: ${e.message}`;
            await stop(db, out.stopped);
          }
          return;
        }
        // Turned off, or today's automatic lookups are used up: try again next time.
        if (e instanceof LookupError && e.status === 403) {
          halt = true;
          return;
        }
        out.failed++;
        // Back off: nothing new starts for a while.
        nextStart = Math.max(nextStart, now() + coolOff);
        // The rest of the group would run the same failing search: they wait a day too.
        for (const lot of group.lots) retryAfter.set(`${group.kind}:${lot.id}`, now() + 86_400_000);
        // A lookup that never started (e.g. search text too short) costs nothing and isn't a failure in a row.
        if (!(e instanceof LookupError && e.status === 400) && ++failuresInARow >= MAX_FAILURES_IN_A_ROW && !halt) {
          halt = true;
          out.stopped = `${MAX_FAILURES_IN_A_ROW} automatic lookups in a row failed, so they stopped. The last said: ${(e as Error).message}`;
          failuresInARow = 0;
          await stop(db, out.stopped);
        }
        continue;
      }
      // The answer is in: the rest of the group take it from the cache.
      for (const lot of rest) {
        try {
          await lookup(group.kind, lot);
          out.reused++;
        } catch {
          retryAfter.set(`${group.kind}:${lot.id}`, now() + 86_400_000);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: deps.concurrency ?? AUTO_CONCURRENCY }, worker));
  return out;
}

/** Runs a pass every minute while there are lots waiting (beside the scan worker). */
export async function runAutoPriceLoop(deps: AutoDeps, log: (m: string) => void) {
  while (!deps.signal?.aborted) {
    try {
      const r = await autoPriceTick(deps);
      if (r.looked || r.failed || r.stopped) log(`Automatic prices: ${r.looked} looked up, ${r.reused} reused, ${r.failed} failed${r.stopped ? `; ${r.stopped}` : ""}`);
    } catch (e) {
      log(`Trade Me auto prices error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
