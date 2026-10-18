import crypto from "node:crypto";
import fs from "node:fs";
import type { FirecrawlClient } from "./firecrawl.ts";
import type { ParallelClient } from "./parallel.ts";
import { stripContacts } from "./redact.ts";

/**
 * Trade Me's own search, read the way a person sees it: one results page per search, and the
 * listing cards on it (title, location, closing date, price). Shaun decided on 18 Oct 2026 to
 * use Trade Me search even though its robots.txt disallows search pages for crawlers; it runs
 * only on a person's button press, at most two results pages per lookup, cached for 7 days and
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
  /** The page's visible text (or markdown), to tell "no results" from a check page. */
  text: string;
}

export interface TradeMeSearcher {
  name: "firecrawl" | "chromium" | "parallel";
  search(url: string): Promise<SearchPage>;
}

const LISTING_HREF = /^https:\/\/(?:www\.)?trademe\.co\.nz\/a\/marketplace\/[^?#\s)]*?\/listing\/(\d+)/i;

export const searchUrl = (q: string) => `https://www.trademe.co.nz/a/marketplace/search?search_string=${encodeURIComponent(q)}`;

/** Trade Me refused or challenged the search: the lookup stops here, with no other route tried. */
export class TradeMeBlocked extends Error {}

const BLOCK_STATUS = new Set([401, 403, 406, 429, 451]);
const NO_RESULTS = /Showing 0 results|No results found|couldn't find anything matching/i;
const CHALLENGE = /captcha|verify (?:that )?you(?: are|'re) (?:a )?human|are you a robot|unusual traffic|access denied|request (?:was |has been )?blocked|checking your browser|enable javascript and cookies/i;

/**
 * Accepts a results page or says why not. A refusal or check page is TradeMeBlocked; a page with
 * no listings counts as an answer only when it says there were no results.
 */
export function checkPage(page: SearchPage): void {
  if (page.status && BLOCK_STATUS.has(page.status)) throw new TradeMeBlocked(`Trade Me refused the search (HTTP ${page.status}), so BidScout stopped there.`);
  if (page.status && page.status >= 400) throw new Error(`Trade Me answered HTTP ${page.status} to the search`);
  if (page.cards.length) return;
  if (CHALLENGE.test(page.text)) throw new TradeMeBlocked("Trade Me showed a check page instead of results, so BidScout stopped there.");
  if (!NO_RESULTS.test(page.text)) throw new Error("Trade Me's search page showed no listings and no \"no results\" message, so it wasn't kept as an answer.");
}

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
      return { cards: cardsFromMarkdown(page.markdown), pageSha: sha(page.markdown), status: page.statusCode, text: page.markdown };
    },
  };
}

/** Parallel's Extract API; a fetch error carries the site's HTTP status (e.g. 406) for checkPage. */
export function parallelSearcher(p: ParallelClient): TradeMeSearcher {
  return {
    name: "parallel",
    async search(url) {
      const page = await p.page(url);
      if (page.error && !page.error.status) throw new Error(`Parallel couldn't fetch the page (${page.error.type})`);
      return { cards: cardsFromMarkdown(page.markdown), pageSha: sha(page.markdown), status: page.error?.status ?? null, text: page.markdown };
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
          const context = await browser.newContext({ locale: "en-NZ", viewport: { width: 1280, height: 900 } });
          // Only the page's text is read: skip images, video and fonts (faster, and less memory).
          await context.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
          const page = await context.newPage();
          const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          const status = res?.status() ?? null;
          if (status && status >= 400) return { cards: [], pageSha: "", status, text: "" };
          // Listings, or Trade Me saying there are none.
          await page
            .waitForFunction(() => !!document.querySelector('a[href*="/listing/"]') || /Showing 0 results|No results found/i.test(document.body?.innerText ?? ""), null, { timeout: 20_000 })
            .catch(() => {});
          const raw = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/listing/"]')].map((a) => ({ href: a.href, text: a.innerText || "" })),
          );
          const cards = new Map<string, SearchCard>();
          for (const r of raw) {
            const m = LISTING_HREF.exec(r.href);
            const text = r.text.replace(/\s+/g, " ").trim();
            if (m && text && !cards.has(m[1]!)) cards.set(m[1]!, { url: m[0], listingId: m[1]!, text });
          }
          const text = cards.size ? "" : await page.evaluate(() => document.body?.innerText ?? "");
          return { cards: [...cards.values()], pageSha: sha(raw.map((r) => `${r.href} ${r.text}`).join("\n")), status, text };
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
  price_kind: "current_bid" | "buy_now" | "asking" | "starting" | null;
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
  const start = new RegExp(`Start(?:ing)? price\\s*${PRICE}`, "i").exec(text);
  const buy = new RegExp(`Buy Now\\s*${PRICE}`, "i").exec(text);
  const asking = new RegExp(`(?:Asking price|(?<!start\\s|starting\\s)Price)\\s*${PRICE}`, "i").exec(text);
  const at = (m: RegExpExecArray | null) => (m ? { start: m.index + m[0].lastIndexOf("$"), end: m.index + m[0].length } : null);
  let main: RegExpExecArray | null = bid ?? start ?? buy ?? asking;
  let kind: CardItem["price_kind"] = bid ? "current_bid" : start ? "starting" : buy ? "buy_now" : asking ? "asking" : null;
  if (!main) {
    // A bare price that isn't shipping ("Shipping from $15.00", "$15.00 shipping").
    const any = [...text.matchAll(new RegExp(PRICE, "g"))].find((m) => !/shipping(?:\s+from)?\s*$/i.test(text.slice(Math.max(0, m.index! - 20), m.index)) && !/^\s*shipping/i.test(text.slice(m.index! + m[0].length)));
    if (any) {
      main = any as unknown as RegExpExecArray;
      kind = "asking";
    }
  }
  const mainAt = at(main);
  const buyAt = at(buy);
  const reserve = /Reserve not met/i.test(text) ? "not met" : /No reserve/i.test(text) ? "none" : /Reserve met/i.test(text) ? "met" : null;
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

/**
 * Is the item itself an accessory? Only the main part of the title counts: "HP ProBook with
 * charger", "… + bag", "… charger included" or "…, backlit keyboard" are laptops.
 */
export function isAccessory(title: string): boolean {
  const main = title
    .replace(/\s(?:with|w\/|incl(?:udes?|uding|\.)?|inc\.?|plus|\+|&)\s.*$/i, "")
    .replace(/\b\w+(?:\s+\w+)?\s+included\b/gi, " ")
    .split(/\s[.·|–-]\s|,|\(/)[0]!;
  return ACCESSORY.test(main);
}

/** What the filtering in relevantCards depends on, so saved answers are only reused for alike lots. */
export function filterKey(deviceType: string | null, lotTitle = ""): string {
  if (isAccessory(lotTitle)) return "|accessory";
  const hint = deviceType ? CATEGORY_HINT[deviceType] : undefined;
  return hint ? `|${hint}` : "";
}

/** Drops accessories and keeps the lot's own category when any results are in it (unless the lot is itself an accessory). */
export function relevantCards(items: CardItem[], deviceType: string | null, lotTitle = ""): CardItem[] {
  const lotIsAccessory = isAccessory(lotTitle);
  let kept = items.filter((i) => i.price !== null && (lotIsAccessory || !isAccessory(i.title ?? "")));
  const hint = deviceType ? CATEGORY_HINT[deviceType] : undefined;
  if (hint && !lotIsAccessory && kept.some((i) => i.url.includes(hint))) kept = kept.filter((i) => i.url.includes(hint));
  return kept;
}

export interface ProbeReport {
  method: TradeMeSearcher["name"];
  query: string;
  url: string;
  verdict: "ok" | "no-results" | "blocked" | "failed";
  message: string;
  status: number | null;
  ms: number;
  cards: number;
  /** Cards a price was read from. */
  priced: number;
  /** The first few listings' links (their values aren't shown: nothing here is stored to cite). */
  listingUrls: string[];
  /** The start of the page's text when no listings were found, to see what came back instead. */
  pageStart: string;
}

/**
 * One results page through one searcher, reported for an admin and not stored: whether it came
 * back, how many listing cards it held and how many a price was read from.
 */
export async function probeSearcher(s: TradeMeSearcher, query: string, now = () => Date.now()): Promise<ProbeReport> {
  const url = searchUrl(query);
  const started = now();
  const base = { method: s.name, query, url, status: null, cards: 0, priced: 0, listingUrls: [], pageStart: "" };
  let page: SearchPage;
  try {
    page = await s.search(url);
  } catch (e) {
    return { ...base, verdict: "failed", message: (e as Error).message, ms: now() - started };
  }
  const report = {
    ...base,
    status: page.status,
    ms: now() - started,
    cards: page.cards.length,
    priced: page.cards.map(parseCard).filter((c) => c.price != null).length,
    listingUrls: page.cards.slice(0, 5).map((c) => c.url),
    pageStart: page.cards.length ? "" : stripContacts(tidy(page.text)).slice(0, 400),
  };
  try {
    checkPage(page);
    if (!page.cards.length) return { ...report, verdict: "no-results", message: "Trade Me said there were no results." };
    // Listings without prices aren't usable, so that isn't "works".
    if (!report.priced) return { ...report, verdict: "failed", message: `Found ${page.cards.length} listings but read no prices from them.` };
    return { ...report, verdict: "ok", message: `Found ${page.cards.length} listings and read a price from ${report.priced}.` };
  } catch (e) {
    return { ...report, verdict: e instanceof TradeMeBlocked ? "blocked" : "failed", message: (e as Error).message };
  }
}
