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

export const unixToDate = (v: unknown): Date | null => {
  const n = num(v);
  return n && n > 0 ? new Date(n * 1000) : null;
};
