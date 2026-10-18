import assert from "node:assert/strict";
import test from "node:test";
import { cardsFromMarkdown, parseCard, relevantCards, searchUrl } from "../../server/tmsearch.ts";

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
