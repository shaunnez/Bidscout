import crypto from "node:crypto";
import fs from "node:fs";
import type { FirecrawlClient } from "./firecrawl.ts";
import { stripContacts } from "./redact.ts";

/**
 * Trade Me's own search, read the way a person sees it: one results page per search, and the
 * listing cards on it (title, location, closing date, price). Shaun decided on 18 Oct 2026 to
 * use Trade Me search even though its robots.txt disallows search pages for crawlers; it runs
 * only on a person's button press, at most two results pages per lookup, cached for 3 days and
 * under the group's daily limit. No disguise: a plain browser, and if Trade Me blocks it, it stops.
 */

export interface SearchCard {
  url: string;
  listingId: string;
  text: string;
}

export interface SearchPage {
  cards: SearchCard[];
  pageSha: string;
  status: number | null;
}

export interface TradeMeSearcher {
  name: "firecrawl" | "chromium";
  search(url: string): Promise<SearchPage>;
}

const LISTING_HREF = /^https:\/\/(?:www\.)?trademe\.co\.nz\/a\/marketplace\/[^?#\s)]*?\/listing\/(\d+)/i;

export const searchUrl = (q: string) => `https://www.trademe.co.nz/a/marketplace/search?search_string=${encodeURIComponent(q)}`;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const tidy = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/[[\]#*_`>|]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Listing cards from a results page as markdown (Firecrawl): each card is the text linked to a
 * listing, i.e. the text between the previous listing link and this one.
 */
export function cardsFromMarkdown(markdown: string): SearchCard[] {
  const re = /\]\((https:\/\/(?:www\.)?trademe\.co\.nz\/a\/marketplace\/[^)\s]*?\/listing\/(\d+)[^)\s]*)\)/gi;
  const cards = new Map<string, SearchCard>();
  let last = 0;
  for (const m of markdown.matchAll(re)) {
    const text = tidy(markdown.slice(last, m.index)).slice(-400);
    last = m.index! + m[0].length;
    const url = LISTING_HREF.exec(m[1]!)?.[0].replace(/^https:\/\/trademe/i, "https://www.trademe");
    const prev = cards.get(m[2]!);
    if (url && text && (!prev || text.length > prev.text.length)) cards.set(m[2]!, { url, listingId: m[2]!, text });
  }
  return [...cards.values()];
}

export function firecrawlSearcher(fc: FirecrawlClient): TradeMeSearcher {
  return {
    name: "firecrawl",
    async search(url) {
      const page = await fc.page(url, { maxAgeMs: 3_600_000 });
      return { cards: cardsFromMarkdown(page.markdown), pageSha: sha(page.markdown), status: page.statusCode };
    },
  };
}

/** The Chromium to drive: CHROMIUM_PATH, else the system's (the Docker image installs it). */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of [env.CHROMIUM_PATH?.trim(), "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (p && fs.existsSync(p)) return p;
  return null;
}

let queue: Promise<unknown> = Promise.resolve();

/** A plain headless Chromium, one page at a time. */
export function chromiumSearcher(executablePath: string): TradeMeSearcher {
  return {
    name: "chromium",
    search(url) {
      const work = queue.then(async () => {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
        try {
          const page = await (await browser.newContext({ locale: "en-NZ", viewport: { width: 1280, height: 900 } })).newPage();
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          const status = res?.status() ?? null;
          if (status && status >= 400) return { cards: [], pageSha: "", status };
          await page.waitForSelector('a[href*="/listing/"]', { timeout: 20_000 }).catch(() => {});
          const raw = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/listing/"]')].map((a) => ({ href: a.href, text: a.innerText || "" })),
          );
          const cards = new Map<string, SearchCard>();
          for (const r of raw) {
            const m = LISTING_HREF.exec(r.href);
            const text = r.text.replace(/\s+/g, " ").trim();
            if (m && text && !cards.has(m[1]!)) cards.set(m[1]!, { url: m[0], listingId: m[1]!, text });
          }
          return { cards: [...cards.values()], pageSha: sha(raw.map((r) => `${r.href} ${r.text}`).join("\n")), status };
        } finally {
          await browser.close();
        }
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}

export interface CardItem {
  url: string;
  listing_id: string;
  title: string | null;
  location: string | null;
  closes: string | null;
  price: number | null;
  price_kind: "current_bid" | "buy_now" | "asking" | null;
  buy_now: number | null;
  reserve: "met" | "not met" | "none" | null;
  excerpt: string;
  quote_start: number | null;
  quote_end: number | null;
  buy_now_start: number | null;
  buy_now_end: number | null;
}

const money = (s: string) => Number(s.replace(/,/g, ""));
const PRICE = "\\$([\\d,]+(?:\\.\\d{2})?)";

/**
 * One results card, e.g. "Waikato Closes: Fri, 23 Oct HP ProBook 450 G8 . i5-1135G7 . 8GB/256GB
 * Shipping from $15.00 No reserve $600.00 Buy Now $650.00". Prices are quoted from the card text;
 * shipping amounts are ignored.
 */
export function parseCard(card: SearchCard): CardItem {
  const text = stripContacts(card.text).slice(0, 400);
  const closes = /Closes:?\s*((?:[A-Z][a-z]{2},\s*)?\d{1,2}\s+[A-Z][a-z]{2}|in\s+[\w\s]+?(?:mins?|hrs?|days?))/i.exec(text);
  const location = closes && closes.index > 0 && closes.index < 40 ? text.slice(0, closes.index).trim() || null : null;
  const afterCloses = closes ? closes.index + closes[0].length : 0;
  const stop = /(Free shipping|Shipping from|\$[\d,.]+ shipping|Pick-?ups?\b|Expected delivery|No reserve|Reserve (?:not )?met|Buy Now|Asking price|Current bid|Start price|\$\d)/i.exec(text.slice(afterCloses));
  const title = text.slice(afterCloses, stop ? afterCloses + stop.index : undefined).replace(/^[\s.·-]+|[\s.·-]+$/g, "") || null;
  const bid = new RegExp(`(No reserve|Reserve met|Reserve not met|Current bid)\\s*${PRICE}`, "i").exec(text);
  const buy = new RegExp(`Buy Now\\s*${PRICE}`, "i").exec(text);
  const asking = new RegExp(`(?:Asking price|Price)\\s*${PRICE}`, "i").exec(text);
  const at = (m: RegExpExecArray | null) => (m ? { start: m.index + m[0].lastIndexOf("$"), end: m.index + m[0].length } : null);
  let main: RegExpExecArray | null = bid ?? buy ?? asking;
  let kind: CardItem["price_kind"] = bid ? "current_bid" : buy ? "buy_now" : asking ? "asking" : null;
  if (!main) {
    // A bare price that isn't shipping.
    const any = [...text.matchAll(new RegExp(PRICE, "g"))].find((m) => !/shipping\s*$/i.test(text.slice(Math.max(0, m.index! - 14), m.index)) && !/^\s*shipping/i.test(text.slice(m.index! + m[0].length)));
    if (any) {
      main = any as unknown as RegExpExecArray;
      kind = "asking";
    }
  }
  const mainAt = at(main);
  const buyAt = at(buy);
  const reserve = bid ? (/not met/i.test(bid[1]!) ? "not met" : /no reserve/i.test(bid[1]!) ? "none" : /met/i.test(bid[1]!) ? "met" : null) : null;
  return {
    url: card.url, listing_id: card.listingId, title, location, closes: closes?.[1] ?? null,
    price: main ? money(main[main.length - 1]!) : null, price_kind: kind,
    buy_now: buy ? money(buy[1]!) : null, reserve,
    excerpt: text, quote_start: mainAt?.start ?? null, quote_end: mainAt?.end ?? null,
    buy_now_start: buyAt?.start ?? null, buy_now_end: buyAt?.end ?? null,
  };
}

const ACCESSORY = /\b(batter(?:y|ies)|charger|adapt[eo]r|power (?:supply|pack|cord|cable)|psu|keyboard|screen protector|protector|case|cover|sleeve|bag|backpack|dock(?:ing)?(?: station)?|stand|cable|hinge|fan|motherboard|lcd|screen (?:replacement|panel)|replacement|skin|decal|ram module|memory module|ssd only|hdd only)\b/i;

/** Where Trade Me files each kind of lot, used to prefer like-for-like results. */
const CATEGORY_HINT: Record<string, string> = {
  laptop: "/computers/laptops/laptops/",
  desktop: "/computers/desktops/",
  mini: "/computers/desktops/",
  aio: "/computers/desktops/",
  workstation: "/computers/desktops/",
  tablet: "/computers/tablets",
  monitor: "/computers/monitors/",
};

/** Drops accessories and keeps the lot's own category when any results are in it (unless the lot is itself an accessory). */
export function relevantCards(items: CardItem[], deviceType: string | null, lotTitle = ""): CardItem[] {
  const lotIsAccessory = ACCESSORY.test(lotTitle);
  let kept = items.filter((i) => i.price !== null && (lotIsAccessory || !ACCESSORY.test(i.title ?? "")));
  const hint = deviceType ? CATEGORY_HINT[deviceType] : undefined;
  if (hint && !lotIsAccessory && kept.some((i) => i.url.includes(hint))) kept = kept.filter((i) => i.url.includes(hint));
  return kept;
}
