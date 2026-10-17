import type { Transport } from "./transport.ts";

/**
 * number8.bid runs on AuctionMethod. These are the public JSON calls its own pages make.
 * Keep site specifics here so another source could get its own adapter.
 */

export const LOT_LIST_PAGE = 100; // the server's fixed page size for an auction's lots
export const PAST_PAGE = 60; // the largest page the site's own menu offers; bigger pages are slow for them

export const n8 = {
  auctions: (t: Transport, page: number) =>
    t.post("/api/auctions", { "filters[page]": page, past_sales: "false" }),
  lots: (t: Transport, auctionId: number, page: number) =>
    t.post("/api/getitems", { auction_id: auctionId, item_type: "itemlist", lotnum: 0, show_closed: 1, "filters[page]": page }),
  pastSales: (t: Transport, page: number, opts: { category?: string; keyword?: string } = {}) =>
    t.post("/api/getitems", {
      item_type: "pastsales",
      "filters[page]": page,
      "filters[perpage]": PAST_PAGE,
      ...(opts.category ? { "filters[category]": opts.category } : {}),
      ...(opts.keyword ? { "filters[keyword]": opts.keyword } : {}),
    }),
  itemData: (t: Transport, itemId: number, auctionId: number) =>
    t.post("/api/ItemData", { item_id: itemId, auction_id: auctionId }),
};

export interface N8Auction {
  id: string;
  title: string;
  starts?: string;
  ends?: string;
  city?: string;
  state_abbreviation?: string;
  item_count?: string | number;
  url?: string;
  main_thumb_url?: string;
}

export interface N8AuctionsPage {
  data: N8Auction[];
  total: number;
  page: number;
  total_pages: number;
}

export interface N8Lot {
  id: string;
  auction_id: string;
  lot_number?: string;
  title: string;
  description?: string;
  quantity?: string;
  category_name?: string | null;
  auction_title?: string;
  starting_bid?: string;
  buyer_premium?: string;
  buy_now?: string;
  current_bid?: string;
  bid_count?: string;
  end_time?: string;
  ends?: string;
  thumb_url?: string;
  item_url?: string;
  mapping_city?: string;
}

export interface N8LotsPage {
  items: N8Lot[];
  total: number;
  page: number;
  total_pages: number;
}

export interface N8ItemData {
  id: string;
  auction_id: string;
  item_description?: string;
  payment_happens?: string;
  images?: Array<{ image_url?: string; thumb_url?: string }>;
  bid_history?: Array<{ bid?: string; time_of_bid?: string }>;
  end_time_unix?: string;
  url?: string;
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const NZ_PARTS = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "Pacific/Auckland", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Pacific/Auckland's offset from UTC at an instant, in ms (+13h in summer, +12h in winter). */
export function nzOffsetMs(at: Date): number {
  const p = Object.fromEntries(NZ_PARTS.formatToParts(at).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - at.getTime()) / 60_000) * 60_000;
}

/**
 * AuctionMethod's unix fields (end_time, ends, start_time, end_time_unix) hold New Zealand
 * wall-clock time written as if it were UTC: 1792695600 is "22 Oct 19:00", shown on the site
 * as 7:00 pm NZ (06:00 UTC). Checked against the site's own display_end_time and
 * start_time_display fields.
 */
export const unixToDate = (v: unknown): Date | null => {
  const n = num(v);
  if (!n || n <= 0) return null;
  const wall = n * 1000;
  let at = wall - 13 * 3_600_000;
  for (let i = 0; i < 2; i++) at = wall - nzOffsetMs(new Date(at));
  return new Date(at);
};

/**
 * The auction list's ISO strings carry a "+1300" label on a UTC clock:
 * "2026-10-14T22:00:00+1300" is 15 Oct 11:00 am NZ (the start_time_display of its lots).
 */
export const isoToDate = (v: unknown): Date | null => {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/.exec(v) : null;
  return m ? new Date(`${m[1]}Z`) : null;
};
