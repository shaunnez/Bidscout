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
    /** The high bidder the lot page shows (raw, before redaction). */
    itemHigh: "someone",
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
    parallelism: 4,
    async get() { throw new Error("unused"); },
    async post(p, form) {
      this.stats.requests++;
      state.calls.push(`${p} ${JSON.stringify(form)}`);
      current = { path: p, form: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString() };
      if (p === "/api/auctions")
        return respond({ total: 2, page: 1, total_pages: 1, data: [
          { id: "90", title: "Unreserved IT &#38;#38; Equipment Liquidation - Rosedale", ends: inDays(2).toISOString().slice(0, 19) + "+1300", starts: inDays(-5).toISOString().slice(0, 19) + "+1300", city: "Rosedale", item_count: "2",
            address: "Unit 4, 11 Orbit Drive", zip: "0632", last_item_closes: inDays(2.02).toISOString().slice(0, 19) + "+1300",
            intro: "<p>Under Instructions from The Liquidators of Example Ltd (In Liquidation)</p><p>Contact staff@example.test with any questions.</p>" },
          { id: "10", title: "Closed - Old Sale", ends: inDays(-400).toISOString().slice(0, 19) + "+1300", city: "Drury", item_count: "5" },
        ] });
      if (p === "/api/getitems" && form.item_type === "itemlist") return respond(lots());
      if (p === "/api/getitems" && form.item_type === "pastsales")
        return respond({ total: 3, page: 1, total_pages: 1, items: [300, 320, 340].map((bid, k) => (
          { id: String(400 + k), auction_id: "80", auction_title: "Closed - Earlier IT Sale", lot_number: `000${7 + k}`, title: "Lenovo ThinkPad T14 Gen 2 - Laptop",
            description: "Type &#8211; Laptop Make &#8211; Lenovo Model &#8211; ThinkPad T14 Gen 2 Specs &#8211; Intel Core i5 1145G7,16GB,256GB SSD ,14 inch Faults &#8211; ITAD Comments &#8211; -",
            category_name: "IT & Equipment", buyer_premium: "15.000", current_bid: `${bid}.00`, bid_count: "21", ends: unix(inDays(-30 + k)) })) });
      if (p === "/api/ItemData")
        return respond({ id: String(form.item_id), auction_id: "90",
          ...(String(form.item_id) === "501" ? { current_bid: state.lot1Bid, bid_count: "3", end_time_unix: unix(state.lot1Ends), highbidder_username: state.itemHigh } : {}),
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

  // Two people in the group: one is lot 501's high bidder (list row "winner"), the other bid on it
  // (lot page bid history, buyer_number 12). Both are matched before redaction.
  const { hashPassword } = await import("../../server/auth.ts");
  const alex = (await db.query(`INSERT INTO users (username, display_name, password_hash, n8_username) VALUES ('alex','Alex',$1,'Someone') RETURNING id`, [await hashPassword("password1")])).rows[0].id;
  const sam = (await db.query(`INSERT INTO users (username, display_name, password_hash, n8_bidder_number) VALUES ('sam','Sam',$1,'12') RETURNING id`, [await hashPassword("password2")])).rows[0].id;

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
  assert.equal(lot.friend_high_user_id, alex, "Alex is the high bidder on 501");
  const fb = (await db.query(`SELECT user_id, kind, amount FROM friend_bids WHERE lot_id=501 ORDER BY kind, user_id`)).rows;
  assert.ok(fb.some((r) => r.kind === "high_bidder" && r.user_id === alex));
  assert.ok(fb.some((r) => r.kind === "bid" && r.user_id === sam && r.amount === 10));
  const past = (await db.query(`SELECT status, final_bid, machine_key FROM lots WHERE id=400`)).rows[0];
  assert.equal(past.status, "closed");
  assert.equal(past.final_bid, 300);
  assert.equal(past.machine_key, lot.machine_key, "same machine, same key");
  const stats = (await db.query(`SELECT n, p50 FROM comp_stats WHERE key=$1`, [lot.machine_key])).rows[0];
  assert.equal(stats.n, 3);
  assert.equal(Math.round(stats.p50 * 100), Math.round(320 * 1.15 * 1.15 * 100));

  // Expected final and value index come back from search, never below the all-in now.
  const { searchLots, parseQuery } = await import("../../server/search.ts");
  const found = (await searchLots(db, parseQuery({ status: "live", sort: "value" }), alex)).items.find((x) => x.id === 501);
  assert.equal(found.comp_kind, "machine");
  assert.equal(Math.round(found.expected_mid), Math.round(320 * 1.3225));
  // The range is the comps' p25–p75 (all-in 396.75, 423.20, 449.65).
  assert.equal(Math.round(found.expected_low), Math.round(310 * 1.3225));
  assert.equal(Math.round(found.expected_high), Math.round(330 * 1.3225));
  assert.ok(found.spec_score > 0);
  assert.ok(found.expected_low <= found.expected_mid && found.expected_mid <= found.expected_high);

  // Auctions: details from the auction list (title decoded, no contact line), lot and favourite counts.
  const { listAuctions, getAuction } = await import("../../server/auctions.ts");
  const live = await listAuctions(db, alex, "live");
  assert.deepEqual(live.map((a) => a.id), [90]);
  const a90 = live[0];
  assert.equal(a90.title, "Unreserved IT & Equipment Liquidation - Rosedale");
  assert.equal(a90.address, "Unit 4, 11 Orbit Drive");
  assert.equal(a90.postcode, "0632");
  assert.equal(a90.instructions, "Under Instructions from The Liquidators of Example Ltd (In Liquidation)");
  assert.equal(a90.lots, 2);
  assert.equal(a90.it_lots, 2);
  assert.equal(a90.bids, 3);
  assert.ok(a90.lots_close_at > a90.ends_at);
  const closedAuctions = await listAuctions(db, alex, "closed");
  const a80 = closedAuctions.find((a) => a.id === 80);
  assert.ok(a80, "an auction known only from past sales is listed as closed");
  assert.equal(a80.sold, 3);
  assert.equal(Number(a80.sold_total), 960);
  assert.equal((await getAuction(db, alex, 90))?.lots, 2);
  assert.equal(await getAuction(db, alex, 12345), null);

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
  assert.deepEqual(revs, [{ lot_id: 400, n: 1 }, { lot_id: 401, n: 1 }, { lot_id: 402, n: 1 }, { lot_id: 501, n: 1 }, { lot_id: 502, n: 2 }]);
  const obs = (await db.query(`SELECT current_bid FROM lot_observations WHERE lot_id=501 ORDER BY id`)).rows.map((r) => r.current_bid);
  assert.deepEqual(obs, [10, 45]);
  assert.equal((await db.query(`SELECT ram_gb FROM lots WHERE id=502`)).rows[0].ram_gb, 16);
  const third = (await db.query(`SELECT details_read FROM scan_runs ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(third.details_read, 1, "only the changed lot's page is re-read");

  // Refresh now: an outsider has overtaken Alex. One request; the bid moves and Alex is no longer shown as high bidder.
  const { refreshLot } = await import("../../server/scan/refresh.ts");
  state.lot1Bid = "60.00";
  state.itemHigh = "outsider";
  const beforeRefresh = transport.stats.requests;
  await refreshLot(db, store, transport, 501, new Date(clock.getTime() + 600_000));
  assert.equal(transport.stats.requests, beforeRefresh + 1);
  const refreshed = (await db.query(`SELECT current_bid, friend_high_user_id FROM lots WHERE id=501`)).rows[0];
  assert.equal(Number(refreshed.current_bid), 60);
  assert.equal(refreshed.friend_high_user_id, null, "the marker is cleared when a friend is no longer high bidder");
  state.itemHigh = "someone";

  // After close, the final bid is recorded from the snapshot that showed it closed.
  clock = inDays(3);
  await startRun(db, "live");
  await workOneRun(deps);
  const closed = (await db.query(`SELECT status, final_bid, outcome_snapshot_id FROM lots WHERE id=501`)).rows[0];
  assert.equal(closed.status, "closed");
  assert.equal(closed.final_bid, 60);
  assert.ok(closed.outcome_snapshot_id);

  // Replaying the stored responses rebuilds the same state without any requests.
  const snapshotOf = async () => (await db.query(
    `SELECT id, status, current_bid, final_bid, ends_at, machine_key, ram_gb, faults, friend_high_user_id,
            current_revision_id IS NOT NULL AS has_rev FROM lots ORDER BY id`)).rows;
  const before = await snapshotOf();
  assert.equal(before.find((l) => l.id === 501).friend_high_user_id, alex);
  const obsBefore = (await db.query(`SELECT count(*)::int AS n FROM lot_observations`)).rows[0].n;
  const requestsBefore = transport.stats.requests;
  await replayAll(db, store);
  assert.deepEqual(await snapshotOf(), before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM lot_observations`)).rows[0].n, obsBefore);
  assert.equal(transport.stats.requests, requestsBefore, "replay makes no requests");

  // Photos fill specs the listing left out, with the words they came from; the listing's own values stay.
  await db.query(`UPDATE lots SET ram_gb=NULL, storage_gb=NULL, images='["https://cdn.test/p1.jpg"]', photo_ocr_at=NULL, status='open' WHERE id=502`);
  const { readLotPhotos, lotsNeedingPhotos } = await import("../../server/scan/photos.ts");
  assert.ok((await lotsNeedingPhotos(db, 10)).includes(502));
  const fakeImages = { get: async (u: string) => ({ body: Buffer.from(`photo of ${u}`), contentType: "image/jpeg" }) };
  const line = "Memory Size 32768 MB Storage 1TB SSD";
  let pos = 0;
  const words = line.split(" ").map((t) => {
    const w = { text: t, conf: 88, left: pos * 4, top: 10, width: t.length * 4, height: 10, start: pos, end: pos + t.length };
    pos += t.length + 1;
    return w;
  });
  const read = await readLotPhotos(db, store, fakeImages, 502, 3, clock, async () => ({ text: line, words, width: 400, height: 300 }));
  assert.equal(read, 1);
  const lp = (await db.query(`SELECT ram_gb, storage_gb, storage_type, photo_fields, photo_ocr_at FROM lots WHERE id=502`)).rows[0];
  assert.equal(lp.ram_gb, 32);
  assert.equal(lp.storage_gb, 1000);
  assert.deepEqual(lp.photo_fields.sort(), ["ramGb", "storage"]);
  assert.ok(lp.photo_ocr_at);
  const pv = (await db.query(`SELECT field, quote, boxes FROM photo_values WHERE lot_id=502 ORDER BY field`)).rows;
  assert.deepEqual(pv.map((r) => [r.field, r.quote]), [["ramGb", "Memory Size 32768 MB"], ["storage", "1TB SSD"]]);
  assert.ok(pv[0].boxes.length >= 3);
  assert.ok(!(await lotsNeedingPhotos(db, 10)).includes(502), "read once");
  await assert.rejects(db.query(`UPDATE photo_values SET quote='x'`), /immutable/);
  // A replay keeps what was read from photos and doesn't queue the lot again.
  await replayAll(db, store);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM photo_values WHERE lot_id=502`)).rows[0].n, 2);
  assert.ok((await db.query(`SELECT photo_ocr_at FROM lots WHERE id=502`)).rows[0].photo_ocr_at);
  assert.ok(!(await lotsNeedingPhotos(db, 10)).includes(502));

  // Evidence rows cannot be edited.
  await assert.rejects(db.query(`UPDATE spec_values SET quote='x'`), /immutable/);
  await assert.rejects(db.query(`UPDATE snapshots SET url='x'`), /immutable/);
  await db.end();
});

test("schedule: live every N hours, weekly past-sales top-up, never alongside another scan", async () => {
  const db = connect(url);
  const { scheduleTick } = await import("../../server/schedule.ts");
  const { saveScanSettings } = await import("../../server/settings.ts");
  await db.query(`UPDATE scan_runs SET state='cancelled' WHERE state IN ('queued','running')`);
  await saveScanSettings(db, { scheduleEnabled: true, liveEveryHours: 4, historyWeekly: true }, null);
  const last = (await db.query(`SELECT max(created_at) AS t FROM scan_runs WHERE kind='live'`)).rows[0].t as Date;
  assert.equal(await scheduleTick(db, new Date(last.getTime() + 3_600_000)), "history", "live ran an hour ago; history top-up is due");
  assert.equal(await scheduleTick(db, new Date(last.getTime() + 5 * 3_600_000)), null, "a scan is already queued");
  await db.query(`UPDATE scan_runs SET state='cancelled' WHERE state='queued'`);
  assert.equal(await scheduleTick(db, new Date(last.getTime() + 5 * 3_600_000)), "live");
  await db.query(`UPDATE scan_runs SET state='cancelled' WHERE state='queued'`);
  await saveScanSettings(db, { scheduleEnabled: false }, null);
  assert.equal(await scheduleTick(db, new Date(last.getTime() + 50 * 3_600_000)), null, "off means off");
  const run = (await db.query(`SELECT trigger, options FROM scan_runs WHERE kind='history' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(run.trigger, "schedule");
  assert.equal(run.options.untilKnown, true);
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
