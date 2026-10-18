import crypto from "node:crypto";
import os from "node:os";
import { cleanText } from "../../shared/clean.ts";
import { parseTerms } from "../../shared/terms.ts";
import { tx, type Db, type Tx } from "../db.ts";
import { isoToDate, n8, num, type N8AuctionsPage, type N8ItemData, type N8Lot, type N8LotsPage } from "../number8.ts";
import { friendBids, friendHighBidder, loadFriendIds, recordFriendBids, recordFriendHigh, type FriendIds } from "../friends.ts";
import { ImageFetcher } from "../images.ts";
import { ocrAvailable } from "../ocr.ts";
import { getScanSettings } from "../settings.ts";
import { saveSnapshot, type Snapshot } from "../snapshots.ts";
import type { ObjectStore } from "../store.ts";
import { HttpError, StopRunError, type Transport } from "../transport.ts";
import { rebuildCompStats } from "./comps.ts";
import { ingestLot, upsertAuction } from "./ingest.ts";
import { lotsNeedingPhotos, readLotPhotos } from "./photos.ts";

export type RunKind = "live" | "history";

export interface RunOptions {
  /** Live: also re-list auctions that ended within this many days, to capture final bids. */
  lookbackDays?: number;
  /** Live: most lot detail pages to read in one run. */
  maxDetails?: number;
  /** Live: most computer lots to read photos for in one run (specs missing from the listing). */
  maxPhotoLots?: number;
  /** History: stop after this many past-sales pages (resume later). */
  maxPages?: number;
  category?: string;
  keyword?: string;
  /** History: stop at the first page that adds no new lots (the weekly top-up). */
  untilKnown?: boolean;
}

interface LiveCursor {
  stage: "auctions" | "lots" | "details" | "photos" | "finish";
  auctionPage: number;
  queue: number[];
  idx: number;
  lotPage: number;
  detailsDone: number;
}

interface HistoryCursor {
  stage: "pages" | "finish";
  page: number;
  pagesThisRun: number;
}

export interface RunRow {
  id: number;
  kind: RunKind;
  state: string;
  options: RunOptions;
  cursor: Partial<LiveCursor & HistoryCursor>;
}

export class LeaseLost extends Error {}

const LEASE_SECONDS = 60;
const MAX_AUCTION_PAGES = 60;

export const newOwner = () => `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

/** Queues a run, or returns the one already queued or running (only one at a time, ever). */
export async function startRun(
  db: Db,
  kind: RunKind,
  options: RunOptions = {},
  resume = false,
  meta: { trigger?: "manual" | "schedule"; startedBy?: number | null } = {},
) {
  return tx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bidscout-start-run'))");
    const active = await c.query(`SELECT * FROM scan_runs WHERE state IN ('queued','running') LIMIT 1`);
    if (active.rows[0]) return { run: active.rows[0], reused: true };
    let cursor = {};
    let opts = options;
    if (resume) {
      const last = await c.query(
        `SELECT cursor, options FROM scan_runs WHERE kind=$1 AND state IN ('partial','cancelled','failed') ORDER BY id DESC LIMIT 1`,
        [kind],
      );
      if (last.rows[0]) {
        cursor = { ...last.rows[0].cursor, pagesThisRun: 0 };
        opts = { ...last.rows[0].options, ...options };
      }
    }
    const r = await c.query(
      `INSERT INTO scan_runs (kind, options, cursor, trigger, started_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [kind, opts, cursor, meta.trigger ?? "manual", meta.startedBy ?? null],
    );
    return { run: r.rows[0], reused: false };
  });
}

export async function claimRun(db: Db, owner: string): Promise<RunRow | null> {
  const r = await db.query(
    `UPDATE scan_runs SET state='running', lease_owner=$1, lease_until=now() + make_interval(secs => $2),
       started_at=COALESCE(started_at, now())
     WHERE id = (SELECT id FROM scan_runs
                 WHERE state='queued' OR (state='running' AND lease_until < now())
                 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, state, options, cursor`,
    [owner, LEASE_SECONDS],
  );
  return r.rows[0] ?? null;
}

type Counters = Partial<Record<
  "requests" | "retries" | "throttles" | "pages_read" | "auctions_seen" | "auctions_queued" | "auctions_listed" |
  "lots_seen" | "lots_new" | "lots_changed" | "observations" | "lots_closed" | "details_read" | "specs_parsed" | "errors" | "photos_read",
  number
>>;

interface Ctx {
  db: Db;
  store: ObjectStore;
  transport: Transport;
  owner: string;
  run: RunRow;
  now: () => Date;
  log: (msg: string) => void;
  friends: FriendIds;
  images: ImageFetcher;
  /** Past-sales pages already downloading while the previous ones are stored. */
  readAhead?: { from: number; count: number; snaps: Promise<Snapshot<N8LotsPage>[]> };
}

/** Ingests a page of lot rows; also notes when someone in the group is the high bidder. */
async function ingestRows(c: Tx, ctx: Ctx, rows: N8Lot[], raw: N8Lot[] | undefined, snapId: number, now: Date, past: boolean) {
  const add: Counters = {};
  for (const [i, row] of rows.entries()) {
    const o = await ingestLot(c, row, snapId, `items.${i}`, now, past);
    add.lots_seen = (add.lots_seen ?? 0) + 1;
    if (o.isNew) add.lots_new = (add.lots_new ?? 0) + 1;
    if (o.changed) add.lots_changed = (add.lots_changed ?? 0) + 1;
    if (o.observed) add.observations = (add.observations ?? 0) + 1;
    if (o.closedNow) add.lots_closed = (add.lots_closed ?? 0) + 1;
    if (o.parsed) add.specs_parsed = (add.specs_parsed ?? 0) + 1;
    const rawRow = raw?.[i] as unknown as Record<string, unknown> | undefined;
    await recordFriendHigh(c, Number(row.id), friendHighBidder(ctx.friends, rawRow), num(row.current_bid), snapId);
  }
  return add;
}

/** Locks the run row if this worker still holds the lease, else throws LeaseLost. */
async function fence(c: Tx, ctx: Ctx) {
  const r = await c.query(`SELECT 1 FROM scan_runs WHERE id=$1 AND lease_owner=$2 AND state='running' FOR UPDATE`, [ctx.run.id, ctx.owner]);
  if (!r.rowCount) throw new LeaseLost(`Run ${ctx.run.id} is no longer ours`);
}

async function progress(c: Tx, ctx: Ctx, add: Counters, set: Record<string, unknown> = {}, tick?: string) {
  const parts: string[] = [];
  const vals: unknown[] = [ctx.run.id, ctx.owner];
  const stats = ctx.transport.stats;
  const transportAdd = { requests: stats.requests, retries: stats.retries, throttles: stats.throttles };
  for (const [k, v] of Object.entries(transportAdd)) {
    vals.push(v);
    parts.push(`${k}=$${vals.length}`);
  }
  for (const [k, v] of Object.entries(add)) {
    if (!v) continue;
    vals.push(v);
    parts.push(`${k}=${k}+$${vals.length}`);
  }
  for (const [k, v] of Object.entries(set)) {
    vals.push(k === "cursor" ? JSON.stringify(v) : v);
    parts.push(`${k}=$${vals.length}`);
  }
  if (tick) {
    vals.push(JSON.stringify([{ at: ctx.now().toISOString(), text: tick }]));
    parts.push(`ticker=(SELECT coalesce(jsonb_agg(e ORDER BY n), '[]') FROM (SELECT e, n FROM jsonb_array_elements($${vals.length}::jsonb || ticker) WITH ORDINALITY t(e, n) ORDER BY n LIMIT 6) s)`);
  }
  await c.query(`UPDATE scan_runs SET ${parts.join(", ")} WHERE id=$1 AND lease_owner=$2`, vals);
}

// ---------------------------------------------------------------- live

async function liveStep(ctx: Ctx, cur: LiveCursor): Promise<boolean> {
  const { db, store, transport, run } = ctx;
  const now = ctx.now();
  const lookback = (run.options.lookbackDays ?? 3) * 86_400_000;

  if (cur.stage === "auctions") {
    const res = await n8.auctions(transport, cur.auctionPage);
    const snap = await saveSnapshot<N8AuctionsPage>(db, store, run.id, res, ctx.now());
    const page = snap.doc;
    await tx(db, async (c) => {
      await fence(c, ctx);
      let fresh = 0;
      for (const [i, a] of (page.data ?? []).entries()) {
        await upsertAuction(c, a, snap.id, `data.${i}`, now);
        const ends = isoToDate(a.ends)?.getTime() ?? 0;
        if (ends >= now.getTime() - lookback) {
          fresh++;
          const done = await c.query(`SELECT finalized_at FROM auctions WHERE id=$1`, [Number(a.id)]);
          if (!done.rows[0]?.finalized_at && !cur.queue.includes(Number(a.id))) cur.queue.push(Number(a.id));
        }
      }
      const last = !fresh || cur.auctionPage >= (page.total_pages ?? 1) || cur.auctionPage >= MAX_AUCTION_PAGES;
      const queuedNow = cur.queue.length;
      if (last) Object.assign(cur, { stage: "lots", idx: 0, lotPage: 1 });
      else cur.auctionPage++;
      await progress(c, ctx, { pages_read: 1, auctions_seen: page.data?.length ?? 0 }, { cursor: cur, phase: cur.stage, auctions_queued: queuedNow },
        last ? `Found ${queuedNow} auctions to read` : undefined);
    });
    return true;
  }

  if (cur.stage === "lots") {
    if (cur.idx >= cur.queue.length) {
      const pending = await db.query(`SELECT count(*)::int AS n FROM lots WHERE needs_detail AND status='open'`);
      await tx(db, async (c) => {
        await fence(c, ctx);
        Object.assign(cur, { stage: "details", detailsDone: 0 });
        await progress(c, ctx, {}, { cursor: cur, phase: "details", details_total: pending.rows[0].n });
      });
      return true;
    }
    // Up to `parallelism` auctions at once; each auction's pages are read in order.
    const batch = cur.queue.slice(cur.idx, cur.idx + transport.parallelism);
    await Promise.all(batch.map((auctionId) => listAuction(ctx, auctionId, now)));
    await tx(db, async (c) => {
      await fence(c, ctx);
      Object.assign(cur, { idx: cur.idx + batch.length, lotPage: 1 });
      await progress(c, ctx, {}, { cursor: cur });
    });
    return true;
  }

  if (cur.stage === "details") {
    const max = run.options.maxDetails ?? 2000;
    const room = Math.max(0, max - cur.detailsDone);
    const next = await db.query(
      `SELECT id, auction_id, title FROM lots WHERE needs_detail AND status='open' ORDER BY ends_at NULLS LAST, id LIMIT $1`,
      [Math.min(transport.parallelism, room)],
    );
    if (!next.rows.length) {
      const more = room === 0 && (await db.query(`SELECT 1 FROM lots WHERE needs_detail AND status='open' LIMIT 1`)).rowCount;
      await tx(db, async (c) => {
        await fence(c, ctx);
        cur.stage = "photos";
        await progress(c, ctx, {}, { cursor: cur, phase: "photos", ...(more ? { stop_reason: `Read the first ${max} lot pages; the rest wait for the next scan` } : {}) });
      });
      return true;
    }
    await Promise.all(next.rows.map((lot) => readDetail(ctx, lot, cur)));
    return true;
  }

  if (cur.stage === "photos") {
    // Computer lots whose listing leaves out the CPU, RAM or storage: read their photos.
    const ids = (await ocrAvailable()) ? await lotsNeedingPhotos(db, run.options.maxPhotoLots ?? 40) : [];
    for (const id of ids) {
      const read = await readLotPhotos(db, store, ctx.images, id, 3, ctx.now());
      await tx(db, async (c) => {
        await fence(c, ctx);
        await progress(c, ctx, { photos_read: read }, {});
      });
    }
    await tx(db, async (c) => {
      await fence(c, ctx);
      cur.stage = "finish";
      await progress(c, ctx, {}, { cursor: cur, phase: "finish" }, ids.length ? `Read photos of ${ids.length} computer lots for missing specs` : undefined);
    });
    return true;
  }

  await finish(ctx);
  return false;
}

async function listAuction(ctx: Ctx, auctionId: number, now: Date) {
  const { db, store, transport, run } = ctx;
  for (let page = 1; ; page++) {
    let doc: N8LotsPage;
    let raw: N8LotsPage;
    let snapId: number;
    try {
      const res = await n8.lots(transport, auctionId, page);
      const snap = await saveSnapshot<N8LotsPage>(db, store, run.id, res, ctx.now());
      ({ doc, raw } = snap);
      snapId = snap.id;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await tx(db, async (c) => {
        await fence(c, ctx);
        await progress(c, ctx, { errors: 1 }, { last_error: e.message });
      });
      return;
    }
    const more = page < (doc.total_pages ?? 1) && (doc.items?.length ?? 0) > 0;
    await tx(db, async (c) => {
      await fence(c, ctx);
      const add = await ingestRows(c, ctx, doc.items ?? [], raw.items, snapId, now, false);
      add.pages_read = 1;
      let tick: string | undefined;
      if (!more) {
        add.auctions_listed = 1;
        const a = await c.query(
          `UPDATE auctions SET last_listed_at=$2::timestamptz,
             finalized_at = CASE WHEN ends_at < $2::timestamptz AND NOT EXISTS (SELECT 1 FROM lots WHERE auction_id=$1 AND status='open') THEN $2::timestamptz END
           WHERE id=$1 RETURNING title`,
          [auctionId, now],
        );
        tick = `Read ${a.rows[0]?.title ?? `auction ${auctionId}`}`;
      }
      await progress(c, ctx, add, {}, tick);
    });
    if (!more) return;
  }
}

async function readDetail(ctx: Ctx, lot: { id: number; auction_id: number; title: string }, cur: LiveCursor) {
  const { db, store, transport, run } = ctx;
  try {
    const res = await n8.itemData(transport, lot.id, lot.auction_id);
    const snap = await saveSnapshot<N8ItemData>(db, store, run.id, res, ctx.now());
    await tx(db, async (c) => {
      await fence(c, ctx);
      await recordDetail(c, lot.id, lot.auction_id, snap.id, snap.doc, snap.raw, ctx.friends);
      cur.detailsDone++;
      await progress(c, ctx, { details_read: 1 }, { cursor: cur }, cur.detailsDone % 25 === 1 ? `Opened ${cleanText(lot.title).slice(0, 70)}` : undefined);
    });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    await tx(db, async (c) => {
      await fence(c, ctx);
      await c.query(`UPDATE lots SET needs_detail=false WHERE id=$1`, [lot.id]);
      cur.detailsDone++;
      await progress(c, ctx, { errors: 1 }, { cursor: cur, last_error: e.message });
    });
  }
}

/** Stores what the lot page adds: every photo, bid amounts and times, and the auction's payment terms. */
export async function recordDetail(
  c: Tx,
  lotId: number,
  auctionId: number,
  snapshotId: number,
  d: N8ItemData,
  raw?: N8ItemData,
  friends?: FriendIds,
) {
  if (raw && friends) await recordFriendBids(c, lotId, friendBids(friends, raw.bid_history), snapshotId);
  const images = (d.images ?? []).map((i) => i.image_url).filter(Boolean);
  const bids = (d.bid_history ?? []).map((b) => ({ bid: Number(b.bid), at: b.time_of_bid ?? null }));
  await c.query(
    `UPDATE lots SET images=$2, bid_history=$3, detail_snapshot_id=$4, detail_read_at=now(), needs_detail=false WHERE id=$1`,
    [lotId, JSON.stringify(images), JSON.stringify(bids), snapshotId],
  );
  if (d.payment_happens) {
    const has = await c.query(`SELECT 1 FROM auction_terms WHERE auction_id=$1 LIMIT 1`, [auctionId]);
    if (!has.rowCount) {
      const t = parseTerms(cleanText(d.payment_happens));
      const due = /payment due\s*(.{0,140}?)(?:\.|$)/i.exec(cleanText(d.payment_happens))?.[1] ?? null;
      await c.query(
        `INSERT INTO auction_terms (auction_id, premium_rate, premium_quote, premium_start, premium_end, gst_rate, gst_quote,
           gst_start, gst_end, payment_due, snapshot_id, snapshot_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'payment_happens') ON CONFLICT DO NOTHING`,
        [auctionId, t.premiumRate, t.premium?.quote ?? null, t.premium?.start ?? null, t.premium?.end ?? null,
          t.gstRate, t.gst?.quote ?? null, t.gst?.start ?? null, t.gst?.end ?? null, due, snapshotId],
      );
    }
  }
}

// ---------------------------------------------------------------- history

async function historyStep(ctx: Ctx, cur: HistoryCursor): Promise<boolean> {
  const { db, store, transport, run } = ctx;
  if (cur.stage === "pages") {
    if (run.options.maxPages && cur.pagesThisRun >= run.options.maxPages) {
      await tx(db, async (c) => {
        await fence(c, ctx);
        cur.stage = "finish";
        await progress(c, ctx, {}, { cursor: { ...cur, stage: "pages" }, phase: "finish", stop_reason: `Stopped after ${run.options.maxPages} pages; continue to read more` });
      });
      return finishPartial(ctx);
    }
    // Up to `parallelism` pages fetched at once, stored in page order. A top-up that stops at the
    // first page with nothing new reads one page at a time, so it never fetches past that page.
    const width = run.options.untilKnown ? 1 : transport.parallelism;
    const want = run.options.maxPages ? Math.min(width, run.options.maxPages - cur.pagesThisRun) : width;
    const fetchPages = (from: number, count: number) =>
      Promise.all(
        Array.from({ length: count }, (_, k) => from + k).map(async (pg) =>
          saveSnapshot<N8LotsPage>(db, store, run.id, await n8.pastSales(transport, pg, { category: run.options.category, keyword: run.options.keyword }), ctx.now())),
      );
    const ahead = ctx.readAhead;
    ctx.readAhead = undefined;
    let pages: number[];
    let snaps: Snapshot<N8LotsPage>[];
    if (ahead && ahead.from === cur.page) {
      pages = Array.from({ length: ahead.count }, (_, k) => ahead.from + k);
      snaps = await ahead.snaps;
    } else {
      pages = Array.from({ length: Math.max(1, want) }, (_, k) => cur.page + k);
      snaps = await fetchPages(cur.page, pages.length);
    }
    // Read ahead: the next pages download (through the same paced transport) while these are
    // stored. Not for a top-up, and never past the last page or the run's page limit.
    const total = snaps[0]?.doc.total_pages ?? 0;
    const nextFrom = pages[pages.length - 1]! + 1;
    const capLeft = run.options.maxPages ? run.options.maxPages - cur.pagesThisRun - pages.length : Infinity;
    const nextCount = Math.min(transport.parallelism, capLeft, total - nextFrom + 1);
    if (!run.options.untilKnown && nextCount > 0) {
      const next = fetchPages(nextFrom, nextCount);
      next.catch(() => {}); // a failure surfaces when the next step awaits it
      ctx.readAhead = { from: nextFrom, count: nextCount, snaps: next };
    }
    const now = ctx.now();
    for (const [k, snap] of snaps.entries()) {
      const page = snap.doc;
      const pg = pages[k]!;
      const stop = await tx(db, async (c) => {
        await fence(c, ctx);
        const add = await ingestRows(c, ctx, page.items ?? [], snap.raw.items, snap.id, now, true);
        add.pages_read = 1;
        const last = !page.items?.length || pg >= (page.total_pages ?? 1);
        const caughtUp = !!run.options.untilKnown && !add.lots_new && pg > 1;
        cur.page = pg + 1;
        cur.pagesThisRun++;
        if (last || caughtUp) cur.stage = "finish";
        await progress(c, ctx, add, { cursor: cur, phase: cur.stage, pages_total: page.total_pages ?? null },
          caughtUp ? `Caught up with stored past sales at page ${pg}` : pg % 50 === 0 || last ? `Past sales page ${pg} of ${page.total_pages}` : undefined);
        return last || caughtUp;
      });
      if (stop) break;
    }
    return true;
  }
  await finish(ctx);
  return false;
}

// ---------------------------------------------------------------- finishing

async function finish(ctx: Ctx) {
  await rebuildCompStats(ctx.db);
  await tx(ctx.db, async (c) => {
    await fence(c, ctx);
    await progress(c, ctx, {}, { state: "complete", phase: "done", finished_at: ctx.now(), lease_owner: null }, "Scan finished");
  });
}

async function finishPartial(ctx: Ctx) {
  await rebuildCompStats(ctx.db);
  await tx(ctx.db, async (c) => {
    await fence(c, ctx);
    await progress(c, ctx, {}, { state: "partial", phase: "done", finished_at: ctx.now(), lease_owner: null });
  });
  return false;
}

export interface WorkerDeps {
  db: Db;
  store: ObjectStore;
  makeTransport: (signal: AbortSignal, concurrency: number) => Transport;
  makeImageFetcher?: () => ImageFetcher;
  owner?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Claims one run and works it to the end (or until stopped). Returns false when nothing was queued. */
export async function workOneRun(deps: WorkerDeps): Promise<boolean> {
  const owner = deps.owner ?? newOwner();
  const run = await claimRun(deps.db, owner);
  if (!run) return false;
  const abort = new AbortController();
  const settings = await getScanSettings(deps.db);
  const transport = deps.makeTransport(abort.signal, settings.concurrency);
  const friends = await loadFriendIds(deps.db);
  const images = deps.makeImageFetcher?.() ?? new ImageFetcher();
  const ctx: Ctx = { db: deps.db, store: deps.store, transport, owner, run, now: deps.now ?? (() => new Date()), log: deps.log ?? (() => {}), friends, images };
  const beat = setInterval(async () => {
    try {
      const r = await deps.db.query(
        `UPDATE scan_runs SET lease_until = now() + make_interval(secs => $3) WHERE id=$1 AND lease_owner=$2 AND state='running'`,
        [run.id, owner, LEASE_SECONDS],
      );
      if (!r.rowCount) abort.abort();
    } catch {
      /* the next fenced write will notice */
    }
  }, 15_000);
  try {
    if (run.kind === "live") {
      const cur: LiveCursor = { stage: "auctions", auctionPage: 1, queue: [], idx: 0, lotPage: 1, detailsDone: 0, ...(run.cursor as Partial<LiveCursor>) };
      while (await liveStep(ctx, cur)) {
        /* each step persists its own cursor */
      }
    } else {
      const cur: HistoryCursor = { stage: "pages", page: 1, pagesThisRun: 0, ...(run.cursor as Partial<HistoryCursor>) };
      while (await historyStep(ctx, cur)) {
        /* each step persists its own cursor */
      }
    }
  } catch (e) {
    // Parallel batches reject on the first failure; stop their sibling requests too.
    abort.abort();
    if (e instanceof LeaseLost || (e instanceof StopRunError && e.reason === "aborted")) {
      ctx.log(`Run ${run.id} stopped: ${(e as Error).message}`);
    } else {
      const stop = e instanceof StopRunError;
      const msg = (e as Error).message ?? String(e);
      ctx.log(`Run ${run.id} ${stop ? "stopped" : "failed"}: ${msg}`);
      await deps.db.query(
        `UPDATE scan_runs SET state=$3, phase='done', stop_reason=$4, last_error=$4, finished_at=now(), lease_owner=NULL,
           requests=$5, retries=$6, throttles=$7
         WHERE id=$1 AND lease_owner=$2`,
        [run.id, owner, stop ? "partial" : "failed", msg, transport.stats.requests, transport.stats.retries, transport.stats.throttles],
      );
    }
  } finally {
    clearInterval(beat);
  }
  return true;
}
