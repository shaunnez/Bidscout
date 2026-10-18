import assert from "node:assert/strict";
import test from "node:test";
import { Parallel } from "../../server/parallel.ts";
import { cardsFromMarkdown, checkPage, isAccessory, parallelSearcher, parseCard, probeSearcher, relevantCards, searchUrl, TradeMeBlocked } from "../../server/tmsearch.ts";

const TM = "https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/hp/listing";
const card = (id: number, text: string, path = TM) => ({ url: `${path}/${id}`, listingId: String(id), text });

test("results cards: title, location, closing date and the price, quoted from the card; shipping is not a price", () => {
  const a = parseCard(card(1, "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 . i5-1135G7 . 8GB/256GB Shipping from $15.00 Buy Now $599.00"));
  assert.deepEqual([a.title, a.location, a.closes, a.price, a.price_kind, a.buy_now], ["HP ProBook 450 G8 . i5-1135G7 . 8GB/256GB", "Waikato", "Fri, 23 Oct", 599, "buy_now", 599]);
  assert.equal(a.excerpt.slice(a.quote_start!, a.quote_end!), "$599.00");
  const b = parseCard(card(2, "Auckland Closes: Thu, 22 Oct HP ProBook 450 G8 i5 256GB Shipping from $15.00 No reserve $600.00 Buy Now $650.00"));
  assert.deepEqual([b.price, b.price_kind, b.reserve, b.buy_now], [600, "current_bid", "none", 650]);
  assert.equal(b.excerpt.slice(b.buy_now_start!, b.buy_now_end!), "$650.00");
  const c = parseCard(card(3, "Christchurch Closes in 3 hrs HP ProBook 450 G8 Reserve not met $210.00"));
  assert.deepEqual([c.price, c.reserve, c.closes], [210, "not met", "in 3 hrs"]);
  const d = parseCard(card(4, "Hamilton Closes: Sat, 24 Oct HP ProBook 450 G8 $15.00 shipping nationwide Asking price $480"));
  assert.deepEqual([d.price, d.price_kind], [480, "asking"]);
  const e = parseCard(card(5, "Nelson Closes: Sat, 24 Oct HP ProBook 450 G8 call 021 234 5678 Buy Now $500"));
  assert.ok(!e.excerpt.includes("234 5678"), "contact details removed from the stored card text");
});

test("results pages as markdown: each listing link's text becomes a card", () => {
  const md = `# Results\n\n[![photo](https://img/x.jpg)\n\nWaikato\n\nCloses: Fri, 23 Oct\n\nHP ProBook 450 G8\n\nBuy Now $599.00](${TM}/6182073617?rsqid=abc)\n\n[Auckland Closes: Thu, 22 Oct HP ProBook 450 G8 No reserve $600.00](${TM}/6180903143)\n\n[See more](https://www.trademe.co.nz/a/marketplace/computers)`;
  const cards = cardsFromMarkdown(md);
  assert.deepEqual(cards.map((c) => c.listingId), ["6182073617", "6180903143"]);
  assert.equal(cards[0]!.url, `${TM}/6182073617`);
  assert.match(cards[0]!.text, /Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 Buy Now \$599\.00$/);
  assert.equal(parseCard(cards[1]!).price, 600);
});

test("relevance: accessories are dropped, and the lot's own category is preferred", () => {
  const items = [
    card(1, "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 Buy Now $599.00"),
    card(2, "Wellington Closes: Thu, 22 Oct Battery for HP ProBook 450 G8 Buy Now $109.59", "https://www.trademe.co.nz/a/marketplace/computers/laptops/batteries/compaq-hp/listing"),
    card(3, "Auckland Closes: Thu, 22 Oct HP 65W charger for ProBook 450 Buy Now $19.90"),
    card(4, "Auckland Closes: Thu, 22 Oct HP ProBook 450 G8 desktop bundle Buy Now $700", "https://www.trademe.co.nz/a/marketplace/computers/desktops/listing"),
  ].map(parseCard);
  assert.deepEqual(relevantCards(items, "laptop").map((i) => i.listing_id), ["1"]);
  assert.deepEqual(relevantCards(items, null).map((i) => i.listing_id), ["1", "4"]);
  assert.deepEqual(relevantCards(items, "laptop", "Laptop battery lot").map((i) => i.listing_id), ["1", "2", "3", "4"], "an accessory lot keeps accessories, from any category");
  assert.equal(searchUrl("HP ProBook 450 G8"), "https://www.trademe.co.nz/a/marketplace/search?search_string=HP%20ProBook%20450%20G8");
});

test("start prices keep their kind, and a card whose only amount is shipping has no price", () => {
  const s = parseCard(card(6, "Otago Closes: Sun, 25 Oct HP ProBook 450 G8 Start price $100.00"));
  assert.deepEqual([s.price, s.price_kind], [100, "starting"]);
  assert.equal(s.excerpt.slice(s.quote_start!, s.quote_end!), "$100.00");
  const r = parseCard(card(7, "Otago Closes: Sun, 25 Oct HP ProBook 450 G8 Reserve not met Start price $1.00"));
  assert.deepEqual([r.price_kind, r.reserve], ["starting", "not met"]);
  const f = parseCard(card(8, "Otago Closes: Sun, 25 Oct HP ProBook 450 G8 Shipping from $15.00"));
  assert.deepEqual([f.price, f.price_kind, f.quote_start], [null, null, null]);
});

test("accessories: the main item decides, not a bundled charger or bag", () => {
  assert.equal(isAccessory("HP ProBook 450 G8 laptop with charger"), false);
  assert.equal(isAccessory("HP ProBook 450 G8 + bag"), false);
  assert.equal(isAccessory("Dell Latitude 5490, charger included"), false);
  assert.equal(isAccessory("HP ProBook 450 G8 . i5 . backlit keyboard"), false);
  assert.equal(isAccessory("HP 65W charger for ProBook 450"), true);
  assert.equal(isAccessory("Battery for HP ProBook 450 G8"), true);
  assert.equal(isAccessory("Laptop bag with shoulder strap"), true);
  const items = [card(1, "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 with charger Buy Now $599.00"), card(2, "Auckland Closes: Thu, 22 Oct HP 65W charger Buy Now $19.90")].map(parseCard);
  assert.deepEqual(relevantCards(items, "laptop", "HP ProBook 450 G8 Laptop with Charger").map((i) => i.listing_id), ["1"]);
});

test("results pages: refusals and check pages stop the lookup; an empty page counts only when it says no results", () => {
  const page = (status: number | null, text: string, cards = 0) => ({ status, text, pageSha: "", cards: Array.from({ length: cards }, (_, i) => card(i, "x")) });
  assert.throws(() => checkPage(page(403, "")), TradeMeBlocked);
  assert.throws(() => checkPage(page(429, "")), TradeMeBlocked);
  assert.throws(() => checkPage(page(200, "Checking your browser before accessing")), TradeMeBlocked);
  assert.throws(() => checkPage(page(503, "")), (e) => !(e instanceof TradeMeBlocked));
  assert.throws(() => checkPage(page(200, "Trade Me")), (e) => !(e instanceof TradeMeBlocked) && /no listings/.test((e as Error).message));
  assert.doesNotThrow(() => checkPage(page(200, "Search Results Showing 0 results for 'zz' No results found")));
  assert.doesNotThrow(() => checkPage(page(200, "access denied", 2)), "a page with listings is accepted");
});

const parallelWith = (status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []) =>
  new Parallel("k", { fetch: async (url, init) => (seen.push({ url, init }), new Response(JSON.stringify(body), { status })) });

test("Parallel: asks for the whole page fresh, and its cards are read like Firecrawl's", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const md = `Showing 2 results\n[Auckland Closes: Fri, 23 Oct Lenovo ThinkPad T480 i5 Buy Now $350.00](${TM}/11)\n[Wellington Lenovo ThinkPad T480 $280.00](${TM}/12)`;
  const p = parallelWith(200, { extract_id: "x", results: [{ url: searchUrl("t480"), title: "Search", excerpts: [], full_content: md }], errors: [] }, seen);
  const r = await probeSearcher(parallelSearcher(p), "t480");
  assert.equal(seen[0]!.url, "https://api.parallel.ai/v1/extract");
  assert.equal((seen[0]!.init.headers as Record<string, string>)["x-api-key"], "k");
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.deepEqual([body.urls, body.advanced_settings.full_content, body.advanced_settings.fetch_policy.disable_cache_fallback], [[searchUrl("t480")], true, true]);
  assert.deepEqual([r.method, r.verdict, r.cards, r.sample[0]!.price, r.sample[0]!.price_kind], ["parallel", "ok", 2, 350, "buy_now"]);
});

test("Parallel: Trade Me's refusal is reported as blocked; an empty page shows how it started", async () => {
  const refused = parallelWith(200, { extract_id: "x", results: [], errors: [{ url: "u", error_type: "fetch_error", http_status_code: 406, content: null }] });
  const a = await probeSearcher(parallelSearcher(refused), "t480");
  assert.deepEqual([a.verdict, a.status], ["blocked", 406]);
  const unknown = parallelWith(200, { extract_id: "x", results: [], errors: [{ url: "u", error_type: "timeout", http_status_code: null }] });
  assert.equal((await probeSearcher(parallelSearcher(unknown), "t480")).verdict, "failed");
  const shell = parallelWith(200, { extract_id: "x", results: [{ url: "u", excerpts: ["Trade Me Marketplace. Loading…"] }], errors: [] });
  const c = await probeSearcher(parallelSearcher(shell), "t480");
  assert.deepEqual([c.verdict, c.cards, c.pageStart], ["failed", 0, "Trade Me Marketplace. Loading…"]);
  const badKey = await probeSearcher(parallelSearcher(parallelWith(401, { type: "error", error: { message: "nope" } })), "t480");
  assert.deepEqual([badKey.verdict, badKey.message], ["failed", "Parallel: the Parallel key was refused"]);
});
