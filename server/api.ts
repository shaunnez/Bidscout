import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { cleanText, CLEAN_VERSION } from "../shared/clean.ts";
import { resolvePath } from "../shared/cite.ts";
import { PARSER_VERSION } from "../shared/specs/computer.ts";
import { passwordAccepted } from "./auth.ts";
import { isLoopback } from "./config.ts";
import { appContext } from "./context.ts";
import { startRun, type RunKind, type RunOptions } from "./scan/runner.ts";
import { LOT_COLUMNS, LOT_JOINS, parseQuery, searchLots } from "./search.ts";
import { loadSnapshotDoc } from "./snapshots.ts";
import { runWorkerLoop } from "./worker.ts";

const ctx = await appContext();
const { db, store, config } = ctx;
if (!isLoopback(config.host) && !config.password) {
  console.error(`Refusing to listen on ${config.host} without BIDSCOUT_PASSWORD: anyone could start scans.`);
  process.exit(1);
}
const app = Fastify({ logger: { level: "warn" }, trustProxy: true });

app.get("/api/health", async () => {
  await db.query("SELECT 1");
  return { ok: true };
});

app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/api/health" || passwordAccepted(req.headers.authorization, config.password)) return;
  reply.header("WWW-Authenticate", 'Basic realm="BidScout", charset="UTF-8"').code(401).send({ error: "Password required" });
});

const snapshotMeta = (m: Record<string, unknown>) => ({
  id: m.id,
  method: m.method,
  url: m.url,
  request: m.request_body,
  fetchedAt: m.fetched_at,
  sha256: m.stored_sha256,
  originalSha256: m.original_sha256,
  redactions: m.redactions,
});

app.get("/api/lots", async (req) => searchLots(db, parseQuery(req.query as Record<string, unknown>)));

app.get<{ Params: { id: string } }>("/api/lots/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const r = await db.query(
    `SELECT ${LOT_COLUMNS}, l.description, l.images, l.bid_history, l.current_revision_id, l.machine_key, l.loose_key,
            l.detail_read_at, l.outcome_snapshot_id, l.outcome_path, a.url AS auction_url, a.city AS auction_city
     FROM lots l ${LOT_JOINS} WHERE l.id=$1`,
    [id],
  );
  const lot = r.rows[0];
  if (!lot) return reply.code(404).send({ error: "No such lot" });
  const [specs, obs, terms, revs] = await Promise.all([
    db.query(
      `SELECT id, field, value, num, source, start_offset, end_offset, quote, method FROM spec_values
       WHERE lot_revision_id=$1 AND parser_version=$2 ORDER BY id`,
      [lot.current_revision_id, PARSER_VERSION],
    ),
    db.query(
      `SELECT id, observed_at, current_bid, bid_count, ends_at, status, snapshot_id, snapshot_path FROM lot_observations WHERE lot_id=$1 ORDER BY observed_at`,
      [id],
    ),
    db.query(`SELECT * FROM auction_terms WHERE auction_id=$1 ORDER BY id DESC LIMIT 1`, [lot.auction_id]),
    db.query(`SELECT id, created_at, snapshot_id FROM lot_revisions WHERE lot_id=$1 ORDER BY id`, [id]),
  ]);
  const suffix = lot.major_fault ? "|fault" : "";
  const compKey = lot.comp_kind === "similar" ? lot.loose_key : lot.machine_key;
  const comps = compKey
    ? await db.query(
        `SELECT l.id, l.title, l.final_bid, l.closed_at, l.buyer_premium, l.faults, l.ram_gb, l.storage_gb, l.cpu, l.item_url,
                l.outcome_snapshot_id, l.outcome_path, a.title AS auction_title,
                l.final_bid * (1 + COALESCE(l.buyer_premium,0)/100.0) * 1.15 AS all_in
         FROM lots l JOIN auctions a ON a.id=l.auction_id
         WHERE l.status='closed' AND l.final_bid > 0 AND l.id <> $1
           AND ${lot.comp_kind === "similar" ? "l.loose_key" : "l.machine_key"} = $2 AND l.major_fault = $3
         ORDER BY l.closed_at DESC NULLS LAST LIMIT 20`,
        [id, compKey, !!suffix],
      )
    : { rows: [] };
  return { lot, specs: specs.rows, observations: obs.rows, terms: terms.rows[0] ?? null, revisions: revs.rows, comps: comps.rows };
});

/** The exact words behind a spec value, re-read from the stored snapshot and checked. */
app.get<{ Params: { id: string } }>("/api/cite/:id", async (req, reply) => {
  const r = await db.query(
    `SELECT v.*, r.snapshot_id, r.snapshot_path, r.lot_id, l.item_url FROM spec_values v
     JOIN lot_revisions r ON r.id=v.lot_revision_id JOIN lots l ON l.id=r.lot_id WHERE v.id=$1`,
    [Number(req.params.id)],
  );
  const v = r.rows[0];
  if (!v) return reply.code(404).send({ error: "No such citation" });
  const { doc, meta } = await loadSnapshotDoc(db, store, v.snapshot_id);
  const fieldPath = `${v.snapshot_path}.${v.source}`;
  const text = cleanText(resolvePath(doc, fieldPath));
  return {
    kind: "spec",
    field: v.field,
    value: v.value,
    method: v.method,
    source: v.source,
    path: fieldPath,
    text,
    start: v.start_offset,
    end: v.end_offset,
    quote: v.quote,
    verified: text.slice(v.start_offset, v.end_offset) === v.quote,
    clean: CLEAN_VERSION,
    lotUrl: v.item_url,
    snapshot: snapshotMeta(meta),
  };
});

/** A raw field from a stored response (a bid, a close time, a final bid). */
app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/snapshots/:id/field", async (req, reply) => {
  const p = req.query.path ?? "";
  if (!/^[\w.]+$/.test(p)) return reply.code(400).send({ error: "Bad path" });
  const { doc, meta } = await loadSnapshotDoc(db, store, Number(req.params.id));
  const value = resolvePath(doc, p);
  const parent = p.includes(".") ? resolvePath(doc, p.split(".").slice(0, -1).join(".")) : null;
  const context = parent && typeof parent === "object" && !Array.isArray(parent)
    ? Object.fromEntries(
        Object.entries(parent as Record<string, unknown>)
          .filter(([k]) => ["id", "lot_number", "title", "current_bid", "bid_count", "end_time", "ends", "starting_bid", "buyer_premium", "category_name"].includes(k)),
      )
    : null;
  return { kind: "field", path: p, value, context, snapshot: snapshotMeta(meta) };
});

/** Premium or GST wording from an auction's payment terms. */
app.get<{ Params: { auction: string; which: string } }>("/api/terms/:auction/:which", async (req, reply) => {
  const t = (await db.query(`SELECT * FROM auction_terms WHERE auction_id=$1 ORDER BY id DESC LIMIT 1`, [Number(req.params.auction)])).rows[0];
  if (!t) return reply.code(404).send({ error: "Terms not read yet" });
  const which = req.params.which === "gst" ? "gst" : "premium";
  const { doc, meta } = await loadSnapshotDoc(db, store, t.snapshot_id);
  const text = cleanText(resolvePath(doc, t.snapshot_path));
  const start = t[`${which}_start`];
  const end = t[`${which}_end`];
  const quote = t[`${which}_quote`];
  return {
    kind: "spec", field: which, value: `${t[`${which}_rate`]}%`, method: "parser:terms", source: "payment terms",
    path: t.snapshot_path, text, start, end, quote, verified: quote !== null && text.slice(start, end) === quote,
    clean: CLEAN_VERSION, snapshot: snapshotMeta(meta),
  };
});

app.get("/api/scans/current", async () => {
  const r = await db.query(`SELECT * FROM scan_runs ORDER BY (state IN ('queued','running')) DESC, id DESC LIMIT 1`);
  return { run: r.rows[0] ?? null };
});

app.get("/api/scans", async () => {
  const r = await db.query(`SELECT * FROM scan_runs ORDER BY id DESC LIMIT 25`);
  return { runs: r.rows };
});

app.post<{ Body: { kind?: RunKind; resume?: boolean; options?: RunOptions } }>("/api/scans", async (req) => {
  const kind: RunKind = req.body?.kind === "history" ? "history" : "live";
  const opts = req.body?.options ?? {};
  const options: RunOptions = {};
  if (Number(opts.maxPages) > 0) options.maxPages = Number(opts.maxPages);
  if (Number(opts.maxDetails) > 0) options.maxDetails = Number(opts.maxDetails);
  if (typeof opts.category === "string" && opts.category) options.category = opts.category;
  return startRun(db, kind, options, !!req.body?.resume);
});

app.post<{ Params: { id: string } }>("/api/scans/:id/cancel", async (req) => {
  await db.query(`UPDATE scan_runs SET state='cancelled', finished_at=now(), stop_reason='Stopped by you' WHERE id=$1 AND state IN ('queued','running')`, [Number(req.params.id)]);
  return { ok: true };
});

app.put<{ Params: { id: string }; Body: { maxAllIn?: number | null; note?: string | null } }>("/api/watch/:id", async (req) => {
  await db.query(
    `INSERT INTO watchlist (lot_id, max_all_in, note) VALUES ($1,$2,$3)
     ON CONFLICT (lot_id) DO UPDATE SET max_all_in=EXCLUDED.max_all_in, note=EXCLUDED.note`,
    [Number(req.params.id), req.body?.maxAllIn ?? null, req.body?.note ?? null],
  );
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/api/watch/:id", async (req) => {
  await db.query(`DELETE FROM watchlist WHERE lot_id=$1`, [Number(req.params.id)]);
  return { ok: true };
});

app.get("/api/summary", async () => {
  const r = await db.query(`
    SELECT count(*) FILTER (WHERE status='open')::int AS live,
           count(*) FILTER (WHERE status='open' AND is_it)::int AS live_it,
           count(*) FILTER (WHERE status='closed')::int AS closed,
           count(*) FILTER (WHERE status='closed' AND final_bid > 0)::int AS sold,
           (SELECT count(*)::int FROM auctions WHERE ends_at > now()) AS live_auctions,
           (SELECT count(*)::int FROM watchlist) AS watching,
           (SELECT max(finished_at) FROM scan_runs WHERE kind='live' AND state='complete') AS last_live_scan,
           (SELECT max(finished_at) FROM scan_runs WHERE kind='history' AND state IN ('complete','partial')) AS last_history_scan
    FROM lots`);
  return r.rows[0];
});

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

await app.listen({ port: config.apiPort, host: config.host });
console.log(`BidScout on http://${config.host}:${config.apiPort}${config.password ? " (password required)" : ""}`);

if (process.env.BIDSCOUT_INLINE_WORKER !== "0") {
  console.log("Scan worker running in this process (set BIDSCOUT_INLINE_WORKER=0 to use npm run worker instead).");
  void runWorkerLoop(ctx);
}
