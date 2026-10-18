import assert from "node:assert/strict";
import test from "node:test";
import { connect, migrate } from "../../server/db.ts";
import type { FirecrawlClient } from "../../server/firecrawl.ts";
import { parseRobots } from "../../server/robots.ts";
import type { TradeMeSearcher } from "../../server/tmsearch.ts";
import { autoPriceTick, autoProgress } from "../../server/autoprice.ts";
import { getTradeMeSettings, saveTradeMeSettings } from "../../server/settings.ts";
import { failInterruptedLookups, latestForLot, loadLookup, tradeMeLookup, tradeMeStatus } from "../../server/trademe.ts";

const url = process.env.BIDSCOUT_TEST_DATABASE_URL;
if (!url) throw new Error("Run with npm run test:db");

const TM = "https://www.trademe.co.nz/a/marketplace/computers/laptops";
// Listing 3 is disallowed by name, to show robots.txt is checked for each page.
const robots = async () => parseRobots(`User-agent: *\nDisallow: /a/*search?\nAllow: /a/marketplace\nDisallow: /a/marketplace/computers/laptops/listing/3\nDisallow: /a/\n`);

/** A made-up Firecrawl: three listings found by search, plus results that must be ignored. */
function fakeFirecrawl(opts: { outOfCredits?: boolean; pagesFail?: boolean; slow?: Promise<void> } = {}) {
  const calls: string[] = [];
  const pages: Record<string, { markdown: string; json: Record<string, unknown> }> = {
    "1": { markdown: "Lenovo ThinkPad T14 Gen 2\nSold for $520\nSeller jo@example.co.nz", json: { title: "Lenovo ThinkPad T14 Gen 2", status: "sold", price: 520, price_kind: "sold", condition: "used" } },
    "2": { markdown: "ThinkPad T14 i5\nBuy Now $650\n3 bids, current bid $410", json: { title: "ThinkPad T14 i5", status: "open", price: 410, price_kind: "current_bid", buy_now: 650, bid_count: 3 } },
    "4": { markdown: "ThinkPad T14 parts\nAsking price on request", json: { title: "ThinkPad T14 parts", status: "open", price: 99, price_kind: "asking" } },
  };
  const fc: FirecrawlClient = {
    async search(q) {
      calls.push(`search ${q}`);
      if (opts.slow) await opts.slow;
      return {
        results: [
          { url: `${TM}/listing/1?bof=xyz`, title: null, description: null },
          { url: `${TM}/search?search_string=thinkpad`, title: null, description: null },
          { url: `${TM}/listing/2`, title: null, description: null },
          { url: `${TM}/listing/1`, title: null, description: null },
          { url: `${TM}/listing/3`, title: null, description: null },
          { url: "https://www.pbtech.co.nz/product/x", title: null, description: null },
          { url: `${TM}/listing/4`, title: null, description: null },
        ],
        credits: 2,
      };
    },
    async page() {
      throw new Error("not used");
    },
    async scrape(u) {
      calls.push(`scrape ${u}`);
      if (opts.outOfCredits) throw Object.assign(new Error("Firecrawl: the Firecrawl account is out of credits"), { status: 402 });
      if (opts.pagesFail) throw Object.assign(new Error("Firecrawl: HTTP 503"), { status: 503 });
      const id = /listing\/(\d+)/.exec(u)![1]!;
      return { ...pages[id]!, statusCode: 200, url: u, credits: 1 };
    },
  };
  return { fc, calls };
}

test("Trade Me prices: off until enabled, reads only robots-allowed listings, confirms prices, caches, limits", async () => {
  const db = connect(url);
  await migrate(db);
  const user = (await db.query(`INSERT INTO users (username, display_name, password_hash) VALUES ('tmuser','TM','x') RETURNING id`)).rows[0].id;
  const { fc, calls } = fakeFirecrawl();
  const deps = { db, firecrawl: fc, robots, sleep: async () => {} };

  // No key: nothing happens. Key but not enabled: nothing happens.
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: null }, { lotId: 501, userId: user, query: "thinkpad t14" }), /FIRECRAWL_API_KEY/);
  await assert.rejects(tradeMeLookup(deps, { lotId: 501, userId: user, query: "thinkpad t14" }), /turn Trade Me prices on/);
  assert.equal(calls.length, 0);

  await saveTradeMeSettings(db, { enabled: true, dailyLimit: 10 }, user);
  const r = await tradeMeLookup(deps, { lotId: 501, userId: user, query: "  ThinkPad   T14 " });
  assert.equal(r.cached, false);
  assert.equal(r.query, "ThinkPad T14");
  assert.deepEqual(calls, ["search ThinkPad T14", `scrape ${TM}/listing/1`, `scrape ${TM}/listing/2`, `scrape ${TM}/listing/4`],
    "never the search page, other sites, duplicates, or a listing robots.txt disallows");
  assert.equal(r.found, 3);
  assert.equal(r.candidates, 4, "four distinct Trade Me listings in the search results");
  assert.equal(r.blocked, 1, "one of them disallowed by robots.txt, counted but not read");
  const [sold, live, parts] = r.items;
  assert.equal(sold.status, "sold");
  assert.equal(Number(sold.price), 520);
  assert.equal(sold.verified, true);
  assert.equal(sold.excerpt.slice(sold.quote_start, sold.quote_end), "$520");
  assert.ok(!sold.excerpt.includes("jo@example"), "contact details never stored");
  assert.equal(Number(live.buy_now), 650);
  assert.equal(live.verified, true);
  assert.equal(parts.verified, false, "a price not written on the page is kept but marked unconfirmed");
  await assert.rejects(db.query(`UPDATE price_lookup_items SET price=1`), /immutable/);

  // Same search text within 3 days, for a lot of the same kind: the saved answer, no requests, and lot 510 remembers it too.
  await db.query(`INSERT INTO auctions (id, title) VALUES (77, 'Test') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO lots (id, auction_id, title, device_type, status) VALUES (510, 77, 'Lenovo ThinkPad T14 Gen 1 - Laptop', 'laptop', 'open') ON CONFLICT DO NOTHING`);
  const again = await tradeMeLookup(deps, { lotId: 510, userId: user, query: "thinkpad t14" });
  assert.equal(again.cached, true);
  assert.equal(again.id, r.id);
  assert.equal(calls.length, 4);
  assert.equal((await latestForLot(db, 510))?.id, r.id);
  assert.equal((await latestForLot(db, 501))?.id, r.id);
  assert.equal(Number(live.buy_now), 650);
  assert.equal(live.buy_now_excerpt.slice(live.buy_now_start, live.buy_now_end), "$650");

  // Every listing page fails (an outage): recorded as failed, not cached as an empty answer.
  const down = fakeFirecrawl({ pagesFail: true });
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: down.fc }, { lotId: 503, userId: user, query: "lenovo m720q" }), /Couldn't read any of the 3 listings/);
  assert.equal((await db.query(`SELECT status FROM price_lookups WHERE query='lenovo m720q'`)).rows[0].status, "failed");
  assert.equal(await latestForLot(db, 503), null, "a failed lookup isn't shown as the lot's answer");

  // Out of credits: recorded as a failed lookup (it counts toward the limit) and reported.
  const broke = fakeFirecrawl({ outOfCredits: true });
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: broke.fc }, { lotId: 501, userId: user, query: "dell latitude 5520" }), /out of credits/);
  const failed = (await db.query(`SELECT status, error FROM price_lookups WHERE query='dell latitude 5520'`)).rows[0];
  assert.equal(failed.status, "failed");

  // Two people, different searches, one slot left: only one goes to Firecrawl.
  await saveTradeMeSettings(db, { dailyLimit: 10 }, user);
  const usedNow = (await tradeMeStatus(db, { firecrawl: fc })).used;
  for (let i = usedNow; i < 9; i++)
    await db.query(`INSERT INTO price_lookups (source, query, query_key, status) VALUES ('trademe', $1, $1, 'ok')`, [`race filler ${i}`]);
  let release!: () => void;
  const slow = fakeFirecrawl({ slow: new Promise<void>((r) => (release = r)) });
  const a = tradeMeLookup({ ...deps, firecrawl: slow.fc }, { lotId: 601, userId: user, query: "hp elitedesk 800 g4" });
  const b = tradeMeLookup({ ...deps, firecrawl: slow.fc }, { lotId: 602, userId: user, query: "dell optiplex 7060" });
  const settled = Promise.allSettled([a, b]);
  await new Promise((r) => setTimeout(r, 200));
  release();
  const results = await settled;
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(String((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason), /used up/);
  assert.equal(slow.calls.filter((c) => c.startsWith("search")).length, 1);
  await db.query(`DELETE FROM price_lookup_lots WHERE lookup_id IN (SELECT id FROM price_lookups WHERE query LIKE 'race filler%')`);
  await db.query(`DELETE FROM price_lookups WHERE query LIKE 'race filler%'`);

  // The group's daily limit.
  await saveTradeMeSettings(db, { dailyLimit: 10 }, user);
  for (let i = (await tradeMeStatus(db, { firecrawl: fc })).used; i < 10; i++)
    await db.query(`INSERT INTO price_lookups (source, query, query_key, status) VALUES ('trademe', $1, $1, 'ok')`, [`filler ${i}`]);

  const st = await tradeMeStatus(db, { firecrawl: fc });
  assert.equal(st.used, 10);
  assert.equal(st.available, false);
  await assert.rejects(tradeMeLookup(deps, { lotId: 501, userId: user, query: "hp elitebook 840" }), /lookups for the last 24 hours are used up/);
  assert.equal((await tradeMeLookup(deps, { lotId: 501, userId: user, query: "thinkpad t14" })).cached, true, "saved answers still work at the limit");
  await db.end();
});

test("Trade Me prices: a wider second search when the first finds nothing, and pasted listing links", async () => {
  const db = connect(url);
  await migrate(db);
  const user = (await db.query(`INSERT INTO users (username, display_name, password_hash) VALUES ('tmuser2','TM2','x') RETURNING id`)).rows[0].id;
  await db.query(`DELETE FROM price_lookup_lots`);
  await db.query(`DELETE FROM price_lookup_items`);
  await db.query(`DELETE FROM price_lookups`);
  await saveTradeMeSettings(db, { enabled: true, dailyLimit: 50 }, user);
  const calls: string[] = [];
  const fc: FirecrawlClient = {
    async search(q, o) {
      calls.push(`search ${q} (${o.limit})`);
      // The exact search turns up nothing from Trade Me; the shorter one finds a listing.
      if (q.includes("i5-12500T")) return { results: [{ url: "https://www.pbtech.co.nz/x", title: null, description: null }], credits: 1 };
      return { results: [{ url: `${TM}/listing/7`, title: null, description: null }], credits: 2 };
    },
    async page() {
      throw new Error("not used");
    },
    async scrape(u) {
      calls.push(`scrape ${u}`);
      return { markdown: "HP Elite Mini 600 G9\nBuy Now $899", json: { title: "HP Elite Mini 600 G9", status: "open", price: 899, price_kind: "buy_now" }, statusCode: 200, url: u, credits: 1 };
    },
  };
  const deps = { db, firecrawl: fc, robots, sleep: async () => {} };
  const r = await tradeMeLookup(deps, { lotId: 234340, userId: user, query: "HP Elite Mini 600 G9 i5-12500T" });
  assert.deepEqual(r.queries, ["HP Elite Mini 600 G9 i5-12500T", "HP Elite Mini 600 G9"]);
  assert.deepEqual(calls, ["search HP Elite Mini 600 G9 i5-12500T (10)", "search HP Elite Mini 600 G9 (20)", `scrape ${TM}/listing/7`]);
  assert.equal(r.searched, 2);
  assert.equal(r.candidates, 1);
  assert.equal(r.items[0].verified, true);

  // Pasted links: only marketplace listings, robots-checked, no search; the same links reuse the answer.
  calls.length = 0;
  await assert.rejects(tradeMeLookup(deps, { lotId: 234340, userId: user, links: ["https://www.trademe.co.nz/a/search?search_string=hp"] }), /marketplace listings/);
  const pasted = await tradeMeLookup(deps, { lotId: 234340, userId: user, links: [
    `${TM}/listing/8?rsqid=abc`, "https://www.pbtech.co.nz/x", `${TM}/listing/3`, `${TM}/listing/8`,
  ] });
  assert.deepEqual(calls, [`scrape ${TM}/listing/8`], "no search; listing 3 is disallowed by robots.txt; duplicates read once");
  assert.equal(pasted.found, 1);
  assert.equal(pasted.queries.length, 0);
  assert.equal((await tradeMeLookup(deps, { lotId: 234341, userId: user, links: [`${TM}/listing/9`] })).cached, false, "a different set of links is a new lookup");
  assert.equal((await tradeMeLookup(deps, { lotId: 234342, userId: user, links: [`${TM}/listing/3`, `${TM}/listing/8?x=1`] })).cached, true, "the same set, in any order, is reused");
  await assert.rejects(tradeMeLookup(deps, { lotId: 234340, userId: user, links: [`${TM}/listing/3`] }), /robots\.txt doesn't allow/);
  await db.end();
});

test("Trade Me prices: Trade Me's own search, the next searcher when one fails, and the web search as a last resort", async () => {
  const db = connect(url);
  await migrate(db);
  const user = (await db.query(`INSERT INTO users (username, display_name, password_hash) VALUES ('tmuser3','TM3','x') RETURNING id`)).rows[0].id;
  await saveTradeMeSettings(db, { enabled: true, dailyLimit: 50 }, user);
  await db.query(`INSERT INTO auctions (id, title) VALUES (77, 'Test') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO lots (id, auction_id, title, device_type, status) VALUES (9001, 77, 'HP ProBook 450 G8 - Laptop', 'laptop', 'open') ON CONFLICT DO NOTHING`);
  const LAP = "https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/hp/listing";
  const searched: string[] = [];
  const broken: TradeMeSearcher = { name: "firecrawl", async search() { throw new Error("Firecrawl: HTTP 403"); } };
  const chromium: TradeMeSearcher = {
    name: "chromium",
    async search(u) {
      searched.push(decodeURIComponent(u.split("search_string=")[1]!));
      const exact = u.includes("i5");
      return {
        status: 200, pageSha: "abc", text: "",
        cards: exact
          ? [{ url: `${LAP}/1`, listingId: "1", text: "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 i5 Buy Now $599.00" }]
          : [
              { url: `${LAP}/1`, listingId: "1", text: "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 i5 Buy Now $599.00" },
              { url: `${LAP}/2`, listingId: "2", text: "Auckland Closes: Thu, 22 Oct HP ProBook 450 G8 No reserve $600.00 Buy Now $650.00" },
              { url: `${LAP}/3`, listingId: "3", text: "Wellington Closes: Thu, 22 Oct Battery for HP ProBook 450 G8 Buy Now $109.59" },
            ],
      };
    },
  };
  const deps = { db, firecrawl: null, robots, sleep: async () => {}, searchers: [chromium] };
  const r = await tradeMeLookup(deps, { lotId: 9001, userId: user, query: "HP ProBook 450 G8 i5-1135G7" });
  assert.equal(r.method, "trademe-search:chromium");
  assert.deepEqual(searched, ["HP ProBook 450 G8 i5-1135G7", "HP ProBook 450 G8"], "fewer than 3 matches, so the make and model were searched too");
  assert.deepEqual(r.items.map((i: any) => [i.listing_id, Number(i.price), i.price_kind, i.reserve]), [["1", 599, "buy_now", null], ["2", 600, "current_bid", "none"]], "the battery is left out");
  assert.equal(r.items[1].excerpt.slice(r.items[1].quote_start, r.items[1].quote_end), "$600.00");
  assert.equal(r.items[1].excerpt.slice(r.items[1].buy_now_start, r.items[1].buy_now_end), "$650.00");
  assert.equal(r.items[0].source_url, "https://www.trademe.co.nz/a/marketplace/search?search_string=HP%20ProBook%20450%20G8%20i5-1135G7", "the quote cites the results page it came from");
  assert.equal(r.items[1].source_url, "https://www.trademe.co.nz/a/marketplace/search?search_string=HP%20ProBook%20450%20G8");

  // Firecrawl errors, or shows an unexplained empty page: Chromium takes over, but two results pages per lookup in all, so it gets one.
  for (const [first, q] of [[broken, "HP ProBook 450 G8 i5-8250U"], [{ name: "firecrawl", async search() { return { status: 200, pageSha: "", cards: [], text: "Trade Me" }; } }, "HP ProBook 450 G8 i7-1165G7"]] as const) {
    searched.length = 0;
    const r2 = await tradeMeLookup({ ...deps, searchers: [first as TradeMeSearcher, chromium] }, { lotId: 9001, userId: user, query: q });
    assert.equal(r2.method, "trademe-search:chromium");
    assert.deepEqual(searched, [q]);
  }

  // A saved answer isn't reused for a different kind of lot with the same search text.
  await db.query(`INSERT INTO lots (id, auction_id, title, device_type, status) VALUES (9002, 77, 'HP ProBook 450 G8 charger', 'laptop', 'open') ON CONFLICT DO NOTHING`);
  searched.length = 0;
  const acc = await tradeMeLookup(deps, { lotId: 9002, userId: user, query: "HP ProBook 450 G8 i5-1135G7" });
  assert.equal(acc.cached, false);
  assert.ok(acc.items.some((i: any) => i.listing_id === "3"), "the charger lot keeps the battery listing");
  assert.equal((await tradeMeLookup(deps, { lotId: 9001, userId: user, query: "HP ProBook 450 G8 i5-1135G7" })).cached, true);

  // Trade Me search unavailable, Firecrawl present: the web-search route still runs.
  const webCalls: string[] = [];
  const fc: FirecrawlClient = {
    async search(q) { webCalls.push(`search ${q}`); return { results: [], credits: 1 }; },
    async scrape() { throw new Error("not used"); },
    async page() { throw new Error("not used"); },
  };
  const down: TradeMeSearcher = { name: "chromium", async search() { return { status: 503, pageSha: "", cards: [], text: "" }; } };
  const w = await tradeMeLookup({ ...deps, firecrawl: fc, searchers: [down] }, { lotId: 9001, userId: user, query: "dell latitude 5520" });
  assert.equal(w.method, "web-search");
  assert.equal(webCalls[0], "search dell latitude 5520");
  assert.equal((await tradeMeStatus(db, { firecrawl: null, searchers: [chromium] })).pasteLinks, false, "pasted links need Firecrawl");
  assert.equal((await tradeMeStatus(db, { firecrawl: fc, searchers: [chromium] })).pasteLinks, true);
  // No Firecrawl and Trade Me unavailable: a clear failure.
  await assert.rejects(tradeMeLookup({ ...deps, searchers: [down] }, { lotId: 9001, userId: user, query: "lenovo x1 carbon" }), /HTTP 503/);

  // Trade Me refuses or shows a check page: the lookup stops, with no web search, and nothing is kept as an answer.
  webCalls.length = 0;
  const refused: TradeMeSearcher = { name: "chromium", async search() { return { status: 403, pageSha: "", cards: [], text: "" }; } };
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: fc, searchers: [refused] }, { lotId: 9001, userId: user, query: "dell latitude 7490" }), /refused the search \(HTTP 403\)/);
  const check: TradeMeSearcher = { name: "chromium", async search() { return { status: 200, pageSha: "", cards: [], text: "Please verify you are human" }; } };
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: fc, searchers: [check, chromium] }, { lotId: 9001, userId: user, query: "dell latitude 7400" }), /check page/);
  assert.deepEqual(webCalls, []);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM price_lookups WHERE query LIKE 'dell latitude 74%' AND status='ok'`)).rows[0].n, 0);

  // Trade Me says there are no results: that is an answer.
  const none: TradeMeSearcher = { name: "chromium", async search() { return { status: 200, pageSha: "x", cards: [], text: "Showing 0 results for 'zz'. No results found" }; } };
  const empty = await tradeMeLookup({ ...deps, searchers: [none] }, { lotId: 9001, userId: user, query: "zzqx laptop model" });
  assert.deepEqual([empty.status, empty.items.length], ["ok", 0]);

  // In the background (what the API does): the reply comes at once as 'running', a second press gets the same lookup, and the answer lands on the row.
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  const slow: TradeMeSearcher = { name: "chromium", async search(u) { await gate; return chromium.search(u); } };
  const bg = await tradeMeLookup({ ...deps, searchers: [slow] }, { lotId: 9001, userId: user, query: "HP ProBook 450 G8 i5-10210U", background: true });
  assert.equal(bg.status, "running");
  await db.query(`INSERT INTO lots (id, auction_id, title, device_type, status) VALUES (9003, 77, 'HP ProBook 450 G8 - Laptop (2)', 'laptop', 'open') ON CONFLICT DO NOTHING`);
  assert.equal((await tradeMeLookup({ ...deps, searchers: [slow] }, { lotId: 9003, userId: user, query: "HP ProBook 450 G8 i5-10210U", background: true })).id, bg.id);
  release();
  let done = bg;
  for (let i = 0; i < 50 && done.status === "running"; i++) {
    await new Promise((ok) => setTimeout(ok, 20));
    done = await loadLookup(db, bg.id);
  }
  assert.equal(done.status, "ok");
  assert.equal((await latestForLot(db, 9001))?.id, bg.id, "linked to the lot once finished");
  for (let i = 0; i < 50 && !(await latestForLot(db, 9003)); i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal((await latestForLot(db, 9003))?.id, bg.id, "and to the lot whose press joined it");
  await db.query(`INSERT INTO price_lookups (source, query, query_key, status) VALUES ('trademe', 'stuck', 'stuck', 'running')`);
  await failInterruptedLookups(db);
  assert.equal((await db.query(`SELECT status FROM price_lookups WHERE query='stuck'`)).rows[0].status, "failed", "a restart doesn't leave lookups running forever");
  await db.end();
});

test("Automatic prices: open IT lots only, one search per shared query, own daily limit, stops when Trade Me refuses", async () => {
  const db = connect(url);
  await migrate(db);
  await db.query(`INSERT INTO auctions (id, title) VALUES (77, 'Test') ON CONFLICT DO NOTHING`);
  const lot = (id: number, title: string, device: string, make: string, model: string, status = "open", isIt = true) =>
    db.query(`INSERT INTO lots (id, auction_id, title, device_type, status, is_it, make, model, ends_at) VALUES ($1, 77, $2, $3, $4, $5, $6, $7, now() + interval '1 day')`,
      [id, title, device, status, isIt, make, model]);
  // Only this test's lots are open IT lots (the pipeline test leaves some behind).
  await db.query(`UPDATE lots SET status='closed' WHERE is_it AND status='open'`);
  await lot(7001, "Dell Latitude 5420 Laptop", "laptop", "Dell", "Latitude 5420");
  await lot(7002, "Dell Latitude 5420 Laptop (2)", "laptop", "Dell", "Latitude 5420");
  await lot(7003, "HP EliteDesk 800 G4 Desktop", "desktop", "HP", "EliteDesk 800 G4");
  await lot(7004, "Dell Latitude 7490 Laptop", "laptop", "Dell", "Latitude 7490", "closed");
  await lot(7005, "Pallet of office chairs", "", "", "", "open", false);

  const LAP = "https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/dell/listing";
  const searched: string[] = [];
  let refuse = false;
  const parallel: TradeMeSearcher = {
    name: "parallel",
    async search(u) {
      const q = decodeURIComponent(u.split("search_string=")[1]!);
      searched.push(q);
      if (refuse) return { cards: [], pageSha: "", status: 406, text: "" };
      const cards = [1, 2, 3].map((n) => ({ url: `${LAP}/${q.length * 10 + n}`, listingId: String(q.length * 10 + n), text: `Auckland Closes: Fri, 23 Oct ${q} i5 16GB Buy Now $${400 + n}.00` }));
      return { cards, pageSha: "sha", status: 200, text: "" };
    },
  };
  const deps = { db, parallel, gapMs: 0, sleep: async () => {} };

  await saveTradeMeSettings(db, { enabled: true, autoEnabled: false }, null);
  assert.equal((await autoPriceTick(deps)).looked, 0);
  assert.equal(searched.length, 0, "nothing runs while automatic prices are off");

  const buttonUsed = (await tradeMeStatus(db, { firecrawl: null, searchers: [parallel] })).used;
  await saveTradeMeSettings(db, { autoEnabled: true, autoDailyLimit: 50 }, null);
  const r = await autoPriceTick(deps);
  assert.deepEqual([r.looked, r.reused, r.failed, r.stopped], [2, 1, 0, null]);
  assert.deepEqual(searched, ["Dell Latitude 5420", "HP EliteDesk 800 G4"], "closed and non-IT lots are skipped; two lots sharing a search share one lookup");
  for (const id of [7001, 7002, 7003]) assert.equal((await latestForLot(db, id))?.status, "ok", `lot ${id} has prices`);
  assert.equal((await latestForLot(db, 7004)), null);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM price_lookups WHERE origin='auto'`)).rows[0].n, 2);
  assert.equal((await tradeMeStatus(db, { firecrawl: null, searchers: [parallel] })).used, buttonUsed, "automatic lookups don't use up the button's daily limit");
  const p = await autoProgress(db);
  assert.deepEqual([p.openLots, p.priced, p.used, p.dailyLimit], [3, 3, 2, 50]);

  searched.length = 0;
  assert.equal((await autoPriceTick(deps)).looked, 0);
  assert.equal(searched.length, 0, "lots with an answer under 3 days old wait");

  // A new lot, and Trade Me refuses: automatic prices turn themselves off and say why.
  await lot(7006, "Lenovo ThinkCentre M720q", "mini", "Lenovo", "ThinkCentre M720q");
  refuse = true;
  const stopped = await autoPriceTick(deps);
  assert.match(stopped.stopped ?? "", /refused Parallel/);
  const s = await getTradeMeSettings(db);
  assert.equal(s.autoEnabled, false);
  assert.match(s.autoStopped?.reason ?? "", /HTTP 406/);
  assert.equal((await saveTradeMeSettings(db, { autoEnabled: true }, null)).autoStopped, null, "turning it back on clears the reason");
  await saveTradeMeSettings(db, { autoEnabled: false }, null);
  await db.end();
});
