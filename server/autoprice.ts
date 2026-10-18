import type { Db } from "./db.ts";
import { lookupQuery } from "../shared/lookup.ts";
import { saveTradeMeSettings } from "./settings.ts";
import { TradeMeBlocked, type TradeMeSearcher } from "./tmsearch.ts";
import { autoStatus, CACHE_DAYS, LookupError, tradeMeLookup, type LookupDeps } from "./trademe.ts";

/**
 * Automatic Trade Me prices (Shaun's decision, 18 Oct 2026): every open IT lot gets the lookup the
 * button would run for it, through Parallel only, one at a time with a gap between them, under its
 * own daily limit (Settings). Lots that share a search share one answer (the 3-day cache), so each
 * search runs once. If Trade Me refuses Parallel, or lookups keep failing, it turns itself off and
 * Settings says why.
 */

export const AUTO_GAP_MS = 20_000;
const MAX_FAILURES_IN_A_ROW = 5;
const BATCH = 50;

/** Open IT lots with no answer under 3 days old, the soonest to close first. */
export async function lotsToPrice(db: Pick<Db, "query">, limit = BATCH) {
  const r = await db.query(
    `SELECT l.id, l.is_it, l.make, l.model, l.cpu, l.title, l.ram_gb::float8 AS ram_gb, l.storage_gb::float8 AS storage_gb, l.storage_type, l.device_type
     FROM lots l
     WHERE l.status = 'open' AND l.is_it AND (l.ends_at IS NULL OR l.ends_at > now())
       AND NOT EXISTS (SELECT 1 FROM price_lookup_lots k JOIN price_lookups pl ON pl.id = k.lookup_id
                       WHERE k.lot_id = l.id AND pl.status = 'ok' AND pl.created_at > now() - make_interval(days => $1))
     ORDER BY l.ends_at ASC NULLS LAST, l.id
     LIMIT $2`,
    [CACHE_DAYS, limit],
  );
  return r.rows;
}

/** For Settings: open IT lots, how many have a current answer, and today's automatic lookups. */
export async function autoProgress(db: Pick<Db, "query">) {
  const r = await db.query(
    `SELECT count(*) AS open,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM price_lookup_lots k JOIN price_lookups pl ON pl.id = k.lookup_id
                                          WHERE k.lot_id = l.id AND pl.status = 'ok' AND pl.created_at > now() - make_interval(days => $1))) AS priced
     FROM lots l WHERE l.status = 'open' AND l.is_it AND (l.ends_at IS NULL OR l.ends_at > now())`,
    [CACHE_DAYS],
  );
  const s = await autoStatus(db);
  return { openLots: Number(r.rows[0].open), priced: Number(r.rows[0].priced), used: s.used, dailyLimit: s.dailyLimit };
}

export interface AutoDeps {
  db: Db;
  parallel: TradeMeSearcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  gapMs?: number;
  signal?: AbortSignal;
}

/** Lots whose lookup failed are left alone for a day (in this process). */
const retryAfter = new Map<number, number>();
let failuresInARow = 0;

async function stop(db: Db, reason: string) {
  await saveTradeMeSettings(db, { autoEnabled: false, autoStopped: { reason, at: new Date().toISOString() } }, null);
}

/** One pass over the lots waiting for a price. */
export async function autoPriceTick(deps: AutoDeps) {
  const { db } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const gap = deps.gapMs ?? AUTO_GAP_MS;
  const out = { looked: 0, reused: 0, failed: 0, stopped: null as string | null };
  if (!(await autoStatus(db)).available) return out;
  // Parallel only: no Chromium (too heavy to run in bulk) and no Firecrawl web-search fallback.
  const lookupDeps: LookupDeps = { db, firecrawl: null, searchers: [deps.parallel], robots: async () => { throw new Error("not used"); } };
  for (const lot of await lotsToPrice(db)) {
    if (deps.signal?.aborted) break;
    if ((retryAfter.get(lot.id) ?? 0) > now()) continue;
    try {
      const r = await tradeMeLookup(lookupDeps, { lotId: lot.id, userId: null, query: lookupQuery(lot), auto: true });
      if (r.cached) {
        out.reused++;
        continue;
      }
      out.looked++;
      failuresInARow = 0;
    } catch (e) {
      if (e instanceof TradeMeBlocked) {
        out.stopped = `Trade Me refused Parallel, so automatic lookups stopped: ${e.message}`;
        await stop(db, out.stopped);
        return out;
      }
      // Turned off, or today's automatic lookups are used up: try again next time.
      if (e instanceof LookupError && e.status === 403) break;
      out.failed++;
      retryAfter.set(lot.id, now() + 86_400_000);
      // A lookup that never started (e.g. search text too short) costs nothing and isn't a failure in a row.
      if (!(e instanceof LookupError && e.status === 400) && ++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        out.stopped = `${MAX_FAILURES_IN_A_ROW} automatic lookups in a row failed, so they stopped. The last said: ${(e as Error).message}`;
        failuresInARow = 0;
        await stop(db, out.stopped);
        return out;
      }
      if (e instanceof LookupError && e.status === 400) continue;
    }
    await sleep(gap);
  }
  return out;
}

/** Runs a pass every minute while there are lots waiting (beside the scan worker). */
export async function runAutoPriceLoop(deps: AutoDeps, log: (m: string) => void) {
  while (!deps.signal?.aborted) {
    try {
      const r = await autoPriceTick(deps);
      if (r.looked || r.failed || r.stopped) log(`Trade Me auto prices: ${r.looked} looked up, ${r.reused} reused, ${r.failed} failed${r.stopped ? `; ${r.stopped}` : ""}`);
    } catch (e) {
      log(`Trade Me auto prices error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
