import assert from "node:assert/strict";
import test from "node:test";
import { connect, migrate } from "../../server/db.ts";
import type { FirecrawlClient } from "../../server/firecrawl.ts";
import { parseRobots } from "../../server/robots.ts";
import { saveTradeMeSettings } from "../../server/settings.ts";
import { latestForLot, tradeMeLookup, tradeMeStatus } from "../../server/trademe.ts";

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

  // Same search text within 3 days: the saved answer, no requests, and lot 502 remembers it too.
  const again = await tradeMeLookup(deps, { lotId: 502, userId: user, query: "thinkpad t14" });
  assert.equal(again.cached, true);
  assert.equal(again.id, r.id);
  assert.equal(calls.length, 4);
  assert.equal((await latestForLot(db, 502))?.id, r.id);
  assert.equal((await latestForLot(db, 501))?.id, r.id);
  assert.equal(Number(live.buy_now), 650);
  assert.equal(live.buy_now_excerpt.slice(live.buy_now_start, live.buy_now_end), "$650");

  // Every listing page fails (an outage): recorded as failed, not cached as an empty answer.
  const down = fakeFirecrawl({ pagesFail: true });
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: down.fc }, { lotId: 503, userId: user, query: "lenovo m720q" }), /Couldn't read any of the 3 listings/);
  assert.equal((await db.query(`SELECT status FROM price_lookups WHERE query_key='lenovo m720q'`)).rows[0].status, "failed");
  assert.equal(await latestForLot(db, 503), null, "a failed lookup isn't shown as the lot's answer");

  // Out of credits: recorded as a failed lookup (it counts toward the limit) and reported.
  const broke = fakeFirecrawl({ outOfCredits: true });
  await assert.rejects(tradeMeLookup({ ...deps, firecrawl: broke.fc }, { lotId: 501, userId: user, query: "dell latitude 5520" }), /out of credits/);
  const failed = (await db.query(`SELECT status, error FROM price_lookups WHERE query_key='dell latitude 5520'`)).rows[0];
  assert.equal(failed.status, "failed");

  // Two people, different searches, one slot left: only one goes to Firecrawl.
  await saveTradeMeSettings(db, { dailyLimit: 10 }, user);
  const usedNow = (await tradeMeStatus(db, fc)).used;
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
  for (let i = (await tradeMeStatus(db, fc)).used; i < 10; i++)
    await db.query(`INSERT INTO price_lookups (source, query, query_key, status) VALUES ('trademe', $1, $1, 'ok')`, [`filler ${i}`]);

  const st = await tradeMeStatus(db, fc);
  assert.equal(st.used, 10);
  assert.equal(st.available, false);
  await assert.rejects(tradeMeLookup(deps, { lotId: 501, userId: user, query: "hp elitebook 840" }), /lookups for the last 24 hours are used up/);
  assert.equal((await tradeMeLookup(deps, { lotId: 501, userId: user, query: "thinkpad t14" })).cached, true, "saved answers still work at the limit");
  await db.end();
});
