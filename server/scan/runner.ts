import crypto from "node:crypto";
import os from "node:os";
import { cleanText } from "../../shared/clean.ts";
import { parseTerms } from "../../shared/terms.ts";
import { tx, type Db, type Tx } from "../db.ts";
import { isoToDate, n8, type N8AuctionsPage, type N8ItemData, type N8LotsPage } from "../number8.ts";
import { saveSnapshot } from "../snapshots.ts";
import type { ObjectStore } from "../store.ts";
import { HttpError, StopRunError, type Transport } from "../transport.ts";
import { rebuildCompStats } from "./comps.ts";
import { ingestLot, upsertAuction } from "./ingest.ts";

export type RunKind = "live" | "history";

export interface RunOptions {
  /** Live: also re-list auctions that ended within this many days, to capture final bids. */
  lookbackDays?: number;
  /** Live: most lot detail pages to read in one run. */
  maxDetails?: number;
  /** History: stop after this many past-sales pages (resume later). */
  maxPages?: number;
  category?: string;
  keyword?: string;
}

interface LiveCursor {
  stage: "auctions" | "lots" | "details" | "finish";
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
export async function startRun(db: Db, kind: RunKind, options: RunOptions = {}, resume = false) {
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
    const r = await c.query(`INSERT INTO scan_runs (kind, options, cursor) VALUES ($1,$2,$3) RETURNING *`, [kind, opts, cursor]);
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
  "lots_seen" | "lots_new" | "lots_changed" | "observations" | "lots_closed" | "details_read" | "specs_parsed" | "errors",
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
    const auctionId = cur.queue[cur.idx]!;
    let page: N8LotsPage;
    let snapId: number;
    try {
      const res = await n8.lots(transport, auctionId, cur.lotPage);
      const snap = await saveSnapshot<N8LotsPage>(db, store, run.id, res, ctx.now());
      page = snap.doc;
      snapId = snap.id;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await tx(db, async (c) => {
        await fence(c, ctx);
        Object.assign(cur, { idx: cur.idx + 1, lotPage: 1 });
        await progress(c, ctx, { errors: 1 }, { cursor: cur, last_error: e.message });
      });
      return true;
    }
    await tx(db, async (c) => {
      await fence(c, ctx);
      const add: Counters = { pages_read: 1 };
      for (const [i, row] of (page.items ?? []).entries()) {
        const o = await ingestLot(c, row, snapId, `items.${i}`, now);
        add.lots_seen = (add.lots_seen ?? 0) + 1;
        if (o.isNew) add.lots_new = (add.lots_new ?? 0) + 1;
        if (o.changed) add.lots_changed = (add.lots_changed ?? 0) + 1;
        if (o.observed) add.observations = (add.observations ?? 0) + 1;
        if (o.closedNow) add.lots_closed = (add.lots_closed ?? 0) + 1;
        if (o.parsed) add.specs_parsed = (add.specs_parsed ?? 0) + 1;
      }
      const more = cur.lotPage < (page.total_pages ?? 1) && (page.items?.length ?? 0) > 0;
      let tick: string | undefined;
      if (more) cur.lotPage++;
      else {
        add.auctions_listed = 1;
        const a = await c.query(
          `UPDATE auctions SET last_listed_at=$2::timestamptz,
             finalized_at = CASE WHEN ends_at < $2::timestamptz AND NOT EXISTS (SELECT 1 FROM lots WHERE auction_id=$1 AND status='open') THEN $2::timestamptz END
           WHERE id=$1 RETURNING title`,
          [auctionId, now],
        );
        tick = `Read ${a.rows[0]?.title ?? `auction ${auctionId}`}`;
        Object.assign(cur, { idx: cur.idx + 1, lotPage: 1 });
      }
      await progress(c, ctx, add, { cursor: cur }, tick);
    });
    return true;
  }

  if (cur.stage === "details") {
    const max = run.options.maxDetails ?? 2000;
    const next = await db.query(
      `SELECT id, auction_id, title FROM lots WHERE needs_detail AND status='open' ORDER BY ends_at NULLS LAST, id LIMIT 1`,
    );
    const lot = next.rows[0];
    if (!lot || cur.detailsDone >= max) {
      await tx(db, async (c) => {
        await fence(c, ctx);
        cur.stage = "finish";
        await progress(c, ctx, {}, { cursor: cur, phase: "finish", ...(lot ? { stop_reason: `Read the first ${max} lot pages; the rest wait for the next scan` } : {}) });
      });
      return true;
    }
    try {
      const res = await n8.itemData(transport, lot.id, lot.auction_id);
      const snap = await saveSnapshot<N8ItemData>(db, store, run.id, res, ctx.now());
      await tx(db, async (c) => {
        await fence(c, ctx);
        await recordDetail(c, lot.id, lot.auction_id, snap.id, snap.doc);
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
    return true;
  }

  await finish(ctx);
  return false;
}

/** Stores what the lot page adds: every photo, bid amounts and times, and the auction's payment terms. */
export async function recordDetail(c: Tx, lotId: number, auctionId: number, snapshotId: number, d: N8ItemData) {
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
    const res = await n8.pastSales(transport, cur.page, { category: run.options.category, keyword: run.options.keyword });
    const snap = await saveSnapshot<N8LotsPage>(db, store, run.id, res, ctx.now());
    const page = snap.doc;
    const now = ctx.now();
    await tx(db, async (c) => {
      await fence(c, ctx);
      const add: Counters = { pages_read: 1 };
      for (const [i, row] of (page.items ?? []).entries()) {
        const o = await ingestLot(c, row, snap.id, `items.${i}`, now, true);
        add.lots_seen = (add.lots_seen ?? 0) + 1;
        if (o.isNew) add.lots_new = (add.lots_new ?? 0) + 1;
        if (o.changed) add.lots_changed = (add.lots_changed ?? 0) + 1;
        if (o.closedNow) add.lots_closed = (add.lots_closed ?? 0) + 1;
        if (o.parsed) add.specs_parsed = (add.specs_parsed ?? 0) + 1;
      }
      const last = !page.items?.length || cur.page >= (page.total_pages ?? 1);
      if (last) cur.stage = "finish";
      else cur.page++;
      cur.pagesThisRun++;
      await progress(c, ctx, add, { cursor: cur, phase: cur.stage, pages_total: page.total_pages ?? null },
        cur.page % 50 === 0 || last ? `Past sales page ${cur.page} of ${page.total_pages}` : undefined);
    });
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
  makeTransport: (signal: AbortSignal) => Transport;
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
  const transport = deps.makeTransport(abort.signal);
  const ctx: Ctx = { db: deps.db, store: deps.store, transport, owner, run, now: deps.now ?? (() => new Date()), log: deps.log ?? (() => {}) };
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
