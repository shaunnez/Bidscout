import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanText } from "../../shared/clean.ts";
import { resolvePath } from "../../shared/cite.ts";
import { connect, migrate } from "../../server/db.ts";
import { nzOffsetMs } from "../../server/number8.ts";
import { loadSnapshotDoc } from "../../server/snapshots.ts";
import { replayAll } from "../../server/scan/replay.ts";
import { startRun, workOneRun } from "../../server/scan/runner.ts";
import { ObjectStore } from "../../server/store.ts";
import type { FetchResult, Transport } from "../../server/transport.ts";

const url = process.env.BIDSCOUT_TEST_DATABASE_URL;
if (!url) throw new Error("Run with npm run test:db");

// An illustrative site: one live IT auction with two lots, one past sale. Not real listings.
const NOW = new Date("2026-10-17T00:00:00Z");
// number8 writes NZ wall-clock time into its unix fields (see server/number8.ts).
const unix = (d: Date) => String(Math.floor((d.getTime() + nzOffsetMs(d)) / 1000));
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function site() {
  const state = {
    lot2Desc: "Type &#8211; AIO Make &#8211; HP Model &#8211; EliteOne 800 G6 Specs &#8211; Intel Core i5 10500,3.1GHz,8GB,1TB SSD ,27 inch Faults &#8211; ITAD Comments &#8211; -",
    lot1Bid: "10.00",
    lot1Ends: inDays(2),
    calls: [] as string[],
  };
  const lots = () => ({
    total: 2, page: 1, total_pages: 1,
    items: [
      { id: "501", auction_id: "90", lot_number: "0001", title: "Lenovo ThinkPad T14 Gen 2 - Laptop",
        description: "Type &#8211; Laptop Make &#8211; Lenovo Model &#8211; ThinkPad T14 Gen 2 Specs &#8211; Intel Core i5 1145G7,16GB,256GB SSD ,14 inch Faults &#8211; Missing power adapter",
        quantity: "1", category_name: "IT & Equipment", starting_bid: "10.00", buyer_premium: "15.000", current_bid: state.lot1Bid,
        bid_count: state.lot1Bid === "0.00" ? "0" : "3", end_time: unix(state.lot1Ends), high_bidder: "60248", winner: "someone",
        item_url: "https://www.number8.bid/auction/90/item/x-501/", thumb_url: "https://cdn.test/501.jpg", mapping_city: "Rosedale" },
      { id: "502", auction_id: "90", lot_number: "0002", title: "HP EliteOne 800 G6 - AIO", description: state.lot2Desc,
        quantity: "1", category_name: "IT & Equipment", starting_bid: "10.00", buyer_premium: "15.000", current_bid: "0.00",
        bid_count: "0", end_time: unix(inDays(2)), item_url: "https://www.number8.bid/auction/90/item/y-502/" },
    ],
  });
  let current = { path: "", form: "" };
  const respond = (body: unknown): FetchResult => ({
    method: "POST", url: `https://www.number8.bid${current.path}`, requestBody: current.form, status: 200,
    body: Buffer.from(JSON.stringify(body)), elapsedMs: 5, attempts: 1,
  });
  const transport: Transport = {
    stats: { requests: 0, retries: 0, throttles: 0 },
    async get() { throw new Error("unused"); },
    async post(p, form) {
      this.stats.requests++;
      state.calls.push(`${p} ${JSON.stringify(form)}`);
      current = { path: p, form: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() };
      if (p === "/api/auctions")
        return respond({ total: 2, page: 1, total_pages: 1, data: [
          { id: "90", title: "Unreserved IT Equipment Liquidation - Rosedale", ends: inDays(2).toISOString().slice(0, 19) + "+1300", starts: inDays(-5).toISOString().slice(0, 19) + "+1300", city: "Rosedale", item_count: "2" },
          { id: "10", title: "Closed - Old Sale", ends: inDays(-400).toISOString().slice(0, 19) + "+1300", city: "Drury", item_count: "5" },
        ] });
      if (p === "/api/getitems" && form.item_type === "itemlist") return respond(lots());
      if (p === "/api/getitems" && form.item_type === "pastsales")
        return respond({ total: 1, page: 1, total_pages: 1, items: [
          { id: "400", auction_id: "80", auction_title: "Closed - Earlier IT Sale", lot_number: "0007", title: "Lenovo ThinkPad T14 Gen 2 - Laptop",
            description: "Type &#8211; Laptop Make &#8211; Lenovo Model &#8211; ThinkPad T14 Gen 2 Specs &#8211; Intel Core i5 1145G7,16GB,256GB SSD ,14 inch Faults &#8211; ITAD Comments &#8211; -",
            category_name: "IT & Equipment", buyer_premium: "15.000", current_bid: "300.00", bid_count: "21", ends: unix(inDays(-30)) },
        ] });
      if (p === "/api/ItemData")
        return respond({ id: String(form.item_id), auction_id: "90",
          images: [{ image_url: "https://cdn.test/a.jpg" }, { image_url: "https://cdn.test/b.jpg" }],
          bid_history: [{ bid: "10.00", time_of_bid: "2026-10-16T03:47:43+1300", user_name: "bidder9", buyer_number: "12" }],
          payment_happens: "<p><strong>BIDS IN THIS SALE DO NOT INCLUDE GST AND HAVE A 15% + GST BUYER'S PREMIUM</strong></p><p>the buyer's premium of 15% is added ($150) and then GST of 15% ($172.50) is added. PAYMENT DUE Full payment by 12pm Friday.</p>" });
      throw new Error(`unexpected ${p}`);
    },
  };
  return { state, transport };
}

test("live and history scans store cited, redacted, versioned lots", async () => {
  const db = connect(url);
  await migrate(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidscout-"));
  const store = new ObjectStore(dir);
  const { state, transport } = site();
  let clock = NOW;
  const deps = { db, store, makeTransport: () => transport, now: () => clock };

  // History first, so the live lot has a comparable sale.
  await startRun(db, "history");
  assert.equal(await workOneRun(deps), true);
  await startRun(db, "live");
  assert.equal(await workOneRun(deps), true);
  assert.equal(await workOneRun(deps), false, "nothing left queued");

  const runs = (await db.query(`SELECT kind, state, lots_seen, lots_new, details_read, stop_reason, last_error FROM scan_runs ORDER BY id`)).rows;
  assert.deepEqual(runs.map((r) => [r.kind, r.state]), [["history", "complete"], ["live", "complete"]], JSON.stringify(runs));
  assert.equal(runs[1].lots_new, 2);
  assert.equal(runs[1].details_read, 2);
  assert.ok(!state.calls.some((c) => c.includes('"auction_id":10')), "an auction that ended long ago is not re-listed");

  const lot = (await db.query(`SELECT * FROM lots WHERE id=501`)).rows[0];
  assert.equal(lot.device_type, "laptop");
  assert.equal(lot.ends_at.toISOString(), inDays(2).toISOString(), "close time converted from NZ wall clock");
  assert.equal(lot.cpu, "i5-1145G7");
  assert.equal(lot.ram_gb, 16);
  assert.deepEqual(lot.faults, ["no-charger"]);
  assert.deepEqual(lot.images, ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
  assert.deepEqual(lot.bid_history, [{ bid: 10, at: "2026-10-16T03:47:43+1300" }]);
  const past = (await db.query(`SELECT status, final_bid, machine_key FROM lots WHERE id=400`)).rows[0];
  assert.equal(past.status, "closed");
  assert.equal(past.final_bid, 300);
  assert.equal(past.machine_key, lot.machine_key, "same machine, same key");
  const stats = (await db.query(`SELECT n, p50 FROM comp_stats WHERE key=$1`, [lot.machine_key])).rows[0];
  assert.equal(stats.n, 1);
  assert.equal(Math.round(stats.p50 * 100), Math.round(300 * 1.15 * 1.15 * 100));

  const terms = (await db.query(`SELECT premium_rate, gst_rate, premium_quote FROM auction_terms WHERE auction_id=90`)).rows[0];
  assert.equal(terms.premium_rate, 15);
  assert.equal(terms.gst_rate, 15);

  // Every spec value's quote is found at its offsets in the stored snapshot.
  const values = (await db.query(
    `SELECT v.*, r.snapshot_id, r.snapshot_path FROM spec_values v JOIN lot_revisions r ON r.id = v.lot_revision_id`)).rows;
  assert.ok(values.length > 10);
  for (const v of values) {
    const { doc } = await loadSnapshotDoc(db, store, v.snapshot_id);
    const text = cleanText(resolvePath(doc, `${v.snapshot_path}.${v.source}`));
    assert.equal(text.slice(v.start_offset, v.end_offset), v.quote, `${v.field} of revision ${v.lot_revision_id}`);
  }

  // Bidder identities never reach disk.
  for (const f of walk(dir)) {
    const body = zlib.gunzipSync(fs.readFileSync(f)).toString();
    assert.ok(!body.includes("60248") && !body.includes("bidder9") && !body.includes("someone"), `redacted ${f}`);
  }

  // A bid change is an observation, not a revision; a description change is a revision.
  clock = new Date(NOW.getTime() + 3_600_000);
  state.lot1Bid = "45.00";
  state.lot2Desc = state.lot2Desc.replace("8GB", "16GB");
  await startRun(db, "live");
  await workOneRun(deps);
  const revs = (await db.query(`SELECT lot_id, count(*)::int AS n FROM lot_revisions GROUP BY lot_id ORDER BY lot_id`)).rows;
  assert.deepEqual(revs, [{ lot_id: 400, n: 1 }, { lot_id: 501, n: 1 }, { lot_id: 502, n: 2 }]);
  const obs = (await db.query(`SELECT current_bid FROM lot_observations WHERE lot_id=501 ORDER BY id`)).rows.map((r) => r.current_bid);
  assert.deepEqual(obs, [10, 45]);
  assert.equal((await db.query(`SELECT ram_gb FROM lots WHERE id=502`)).rows[0].ram_gb, 16);
  const third = (await db.query(`SELECT details_read FROM scan_runs ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(third.details_read, 1, "only the changed lot's page is re-read");

  // After close, the final bid is recorded from the snapshot that showed it closed.
  clock = inDays(3);
  await startRun(db, "live");
  await workOneRun(deps);
  const closed = (await db.query(`SELECT status, final_bid, outcome_snapshot_id FROM lots WHERE id=501`)).rows[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.final_bid, 45);
  assert.ok(closed.outcome_snapshot_id);

  // Replaying the stored responses rebuilds the same state without any requests.
  const snapshotOf = async () => (await db.query(
    `SELECT id, status, final_bid, ends_at, machine_key, ram_gb, faults, current_revision_id IS NOT NULL AS has_rev FROM lots ORDER BY id`)).rows;
  const before = await snapshotOf();
  const obsBefore = (await db.query(`SELECT count(*)::int AS n FROM lot_observations`)).rows[0].n;
  const requestsBefore = transport.stats.requests;
  await replayAll(db, store);
  assert.deepEqual(await snapshotOf(), before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lot_observations`)).rows[0].n, obsBefore);
  assert.equal(transport.stats.requests, requestsBefore, "replay makes no requests");

  // Evidence rows cannot be edited.
  await assert.rejects(db.query(`UPDATE spec_values SET quote='x'`), /immutable/);
  await assert.rejects(db.query(`UPDATE snapshots SET url='x'`), /immutable/);
  await db.end();
});

test("only one scan can be active, and a second start reuses it", async () => {
  const db = connect(url);
  const a = await startRun(db, "live");
  const b = await startRun(db, "history");
  assert.equal(b.reused, true);
  assert.equal(b.run.id, a.run.id);
  await db.query(`UPDATE scan_runs SET state='cancelled' WHERE id=$1`, [a.run.id]);
  await db.end();
});

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".gz") ? [path.join(d, e.name)] : []));
}
