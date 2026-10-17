import { appContext } from "../server/context.ts";
import { startRun, workOneRun, type RunKind, type RunOptions } from "../server/scan/runner.ts";

/**
 * Manual trigger:
 *   npm run scan                       live auctions (new and changed lots, lot pages, recent final bids)
 *   npm run scan -- history            past sales (final bids) for price history, resumable
 *   npm run scan -- history --max-pages 100 --category "IT & Equipment"
 *   npm run scan -- history --resume   carry on from where the last history scan stopped
 */
const args = process.argv.slice(2);
const kind: RunKind = args[0] === "history" ? "history" : "live";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const options: RunOptions = {};
if (opt("max-pages")) options.maxPages = Number(opt("max-pages"));
if (opt("max-details")) options.maxDetails = Number(opt("max-details"));
if (opt("lookback-days")) options.lookbackDays = Number(opt("lookback-days"));
if (opt("category")) options.category = opt("category");
if (opt("keyword")) options.keyword = opt("keyword");

const deps = await appContext();
const { run, reused } = await startRun(deps.db, kind, options, args.includes("--resume"));
console.log(reused ? `A scan is already queued or running (#${run.id}, ${run.kind}); working it.` : `Queued ${kind} scan #${run.id}.`);

const timer = setInterval(async () => {
  const r = await deps.db.query(
    `SELECT phase, requests, retries, throttles, pages_read, pages_total, auctions_queued, auctions_listed, lots_seen,
            lots_new, lots_changed, details_read, details_total FROM scan_runs WHERE id=$1`,
    [run.id],
  );
  const s = r.rows[0];
  if (s)
    console.log(
      `  ${s.phase}: ${s.requests} requests (${s.retries} retries, ${s.throttles} slow-downs) · pages ${s.pages_read}${s.pages_total ? "/" + s.pages_total : ""}` +
        ` · auctions ${s.auctions_listed}/${s.auctions_queued} · lots ${s.lots_seen} (${s.lots_new} new, ${s.lots_changed} changed) · details ${s.details_read}/${s.details_total}`,
    );
}, 10_000);

await workOneRun({ ...deps, log: (m) => console.log(m) });
clearInterval(timer);
const done = await deps.db.query(`SELECT * FROM scan_runs WHERE id=$1`, [run.id]);
const s = done.rows[0];
console.log(
  `Scan #${s.id} ${s.state}. ${s.requests} requests, ${s.retries} retries, ${s.throttles} slow-downs. ` +
    `${s.lots_seen} lots seen, ${s.lots_new} new, ${s.lots_changed} changed, ${s.lots_closed} closed, ${s.details_read} lot pages read.` +
    (s.stop_reason ? ` Note: ${s.stop_reason}` : ""),
);
await deps.db.end();
