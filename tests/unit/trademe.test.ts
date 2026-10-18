import assert from "node:assert/strict";
import test from "node:test";
import { Firecrawl } from "../../server/firecrawl.ts";
import { parseRobots, robotsAllows, ruleMatches } from "../../server/robots.ts";
import { findPrice, listingUrl, toItem } from "../../server/trademe.ts";

// Lines from Trade Me's robots.txt (September 2025 version), plus a named group.
const ROBOTS = `
User-agent: *
Allow: /
Disallow: /a/*search?
Disallow: /a/*listing/
Allow: /a/marketplace
Disallow: /a/marketplace/*search_string
Disallow: /a/marketplace/*member_listing
Disallow: /a/
Disallow: /Browse/
Disallow:

User-agent: OtherBot
Disallow: /
`;

test("robots.txt: longest rule wins, so marketplace listings are allowed and searches are not", () => {
  const r = parseRobots(ROBOTS);
  const ok = (p: string) => robotsAllows(r, `https://www.trademe.co.nz${p}`, ["bidscout", "firecrawlagent"]);
  assert.equal(ok("/a/marketplace/computers/laptops/listing/5512345678"), true);
  assert.equal(ok("/a/marketplace/computers/laptops/search?search_string=thinkpad"), false);
  assert.equal(ok("/a/search?search_string=thinkpad"), false);
  assert.equal(ok("/a/marketplace/member_listing/1"), false);
  assert.equal(ok("/a/services/plumbing/listing/1"), false, "outside the marketplace, listings fall under Disallow: /a/*listing/");
  assert.equal(ok("/Browse/Listing.aspx?id=1"), false);
  assert.equal(robotsAllows(r, "https://www.trademe.co.nz/a/marketplace", ["OtherBot"]), false, "a named group replaces *");
});

test("robots.txt: $ anchors, ties go to Allow, and many wildcards stay fast", () => {
  assert.equal(ruleMatches("/a/*.pdf$", "/a/x/y.pdf"), true);
  assert.equal(ruleMatches("/a/*.pdf$", "/a/x/y.pdf?x=1"), false);
  assert.equal(ruleMatches("/a/*listing", "/a/marketplace/listing/1"), true);
  const tie = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x\n");
  assert.equal(robotsAllows(tie, "/x/1", ["bidscout"]), true);
  const started = Date.now();
  const long = "/a/property/residential/sale/" + "abcdefgh/".repeat(40) + "nothing-here";
  for (let i = 0; i < 2000; i++) ruleMatches("/a/property/residential/sale/*/*/*/*/*/*listing", long);
  assert.ok(Date.now() - started < 1000, "2,000 multi-wildcard checks in under a second");
});

test("listing URLs are reduced to the canonical marketplace listing, anything else is refused", () => {
  assert.deepEqual(listingUrl("https://www.trademe.co.nz/a/marketplace/computers/laptops/listing/5512345678?bof=abc#photos"),
    { url: "https://www.trademe.co.nz/a/marketplace/computers/laptops/listing/5512345678", listingId: "5512345678" });
  assert.equal(listingUrl("https://trademe.co.nz/a/marketplace/computers/listing/42")?.url, "https://www.trademe.co.nz/a/marketplace/computers/listing/42");
  assert.equal(listingUrl("https://www.trademe.co.nz/a/marketplace/computers/search?search_string=x"), null);
  assert.equal(listingUrl("https://www.trademe.co.nz/a/property/residential/sale/auckland/listing/1"), null);
  assert.equal(listingUrl("https://evil.example/a/marketplace/x/listing/1"), null);
});

test("prices are confirmed against the page text, and the excerpt drops contact details", () => {
  const md = "ThinkPad T14 Gen 2\n\nCurrent bid\n\n$12\n\nBuy Now $1,234.50 · call 021 234 5678 or jo@example.co.nz";
  const f = findPrice(md, 1234.5)!;
  assert.equal(f.excerpt.slice(f.start, f.end), "$1,234.50");
  assert.ok(!/021 234|jo@example/.test(f.excerpt));
  assert.equal(findPrice(md, 12)!.excerpt.slice(findPrice(md, 12)!.start, findPrice(md, 12)!.end), "$12");
  assert.equal(findPrice("Buy Now $1,234", 12), null, "$12 is not found inside $1,234");
  assert.equal(findPrice("Buy Now $1,234.50", 1234), null, "$1,234 is not $1,234.50");
  assert.equal(findPrice("Buy Now $120", 12), null);
  assert.equal(findPrice("Asking $650", 650)?.start !== undefined, true);
  assert.equal(findPrice("no prices here", 650), null);
});

test("an extracted listing keeps only confirmed, cleaned fields", () => {
  const md = "Lenovo ThinkPad T14\nSold for $520\nSeller: bob, ring 021 555 1234";
  const it = toItem("https://www.trademe.co.nz/a/marketplace/x/listing/9", "9", md,
    { title: "Lenovo ThinkPad T14", status: "sold", price: 520, price_kind: "sold", condition: "mint!!", location: "Auckland 021 555 1234", bid_count: 7 }, new Date(0));
  assert.equal(it.verified, true);
  assert.equal(it.condition, null, "values outside the allowed list are dropped");
  assert.equal(it.location, "Auckland [redacted phone]");
  assert.equal(it.bid_count, 7);
  const made = toItem("u", "9", md, { price: 999 }, new Date(0));
  assert.equal(made.verified, false, "a price not on the page is not confirmed");
  assert.equal(made.excerpt, null);
});

test("Firecrawl client: bearer auth, v2 bodies, one retry on 429, a clear message when out of credits", async () => {
  const calls: Array<{ url: string; body: any; auth: string }> = [];
  const replies = [
    new Response("{}", { status: 429, headers: { "retry-after": "1" } }),
    Response.json({ success: true, data: { web: [{ url: "https://www.trademe.co.nz/a/marketplace/x/listing/1", title: "T14" }] }, creditsUsed: 2 }),
    Response.json({ success: true, data: { markdown: "# T14 $500", json: { price: 500 }, metadata: { statusCode: 200, url: "https://www.trademe.co.nz/a/marketplace/x/listing/1" } } }),
    Response.json({ success: false, error: "Payment required" }, { status: 402 }),
  ];
  const fc = new Firecrawl("fc-test", {
    sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
      return replies.shift()!;
    },
  });
  const s = await fc.search("thinkpad t14", { limit: 10, includeDomains: ["trademe.co.nz"], country: "NZ" });
  assert.equal(calls.length, 2, "retried once after 429");
  assert.equal(calls[1]!.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(calls[1]!.auth, "Bearer fc-test");
  assert.deepEqual(calls[1]!.body.includeDomains, ["trademe.co.nz"]);
  assert.equal(s.results[0]!.title, "T14");
  assert.equal(s.credits, 2);
  const p = await fc.scrape("https://www.trademe.co.nz/a/marketplace/x/listing/1", { schema: {}, prompt: "p", maxAgeMs: 1 });
  assert.equal(calls[2]!.body.formats[1].type, "json");
  assert.equal(p.json?.price, 500);
  assert.equal(p.statusCode, 200);
  await assert.rejects(fc.scrape("u", { schema: {}, prompt: "p", maxAgeMs: 1 }), /out of credits/);
});

test("robots.txt is checked for each identity on its own: a BidScout group doesn't excuse Firecrawl from *", () => {
  const r = parseRobots("User-agent: BidScout\nAllow: /\n\nUser-agent: *\nDisallow: /a/marketplace/x/listing/\n");
  const url = "https://www.trademe.co.nz/a/marketplace/x/listing/1";
  assert.equal(robotsAllows(r, url, ["bidscout"]), true);
  assert.equal(robotsAllows(r, url, ["firecrawlagent"]), false);
  assert.equal(["bidscout", "firecrawlagent"].every((a) => robotsAllows(r, url, [a])), false);
});

test("contact details crossing the excerpt edge are removed before trimming", () => {
  const md = "x".repeat(200) + " call 021 234 5678 " + "y".repeat(76) + "Price $500 " + "z".repeat(85) + " mail longname.someone@example.co.nz end";
  const f = findPrice(md, 500)!;
  assert.ok(!/234 5678|5678|someone@|example\.co/.test(f.excerpt), f.excerpt);
  assert.equal(f.excerpt.slice(f.start, f.end), "$500");
});

test("a Buy Now price is kept only when it is written on the page, with its own quote", () => {
  const md = "ThinkPad\nCurrent bid $410\nBuy Now $650";
  const ok = toItem("u", "1", md, { price: 410, price_kind: "current_bid", buy_now: 650 }, new Date(0));
  assert.equal(ok.buy_now, 650);
  assert.equal(ok.buy_now_excerpt!.slice(ok.buy_now_start!, ok.buy_now_end!), "$650");
  const made = toItem("u", "1", md, { price: 410, buy_now: 999 }, new Date(0));
  assert.equal(made.buy_now, null);
  assert.equal(made.buy_now_excerpt, null);
});
