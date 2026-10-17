import { find, whole, type Hit } from "./specs/text.ts";

export interface Terms {
  premiumRate: number | null;
  premium: Hit | null;
  gstRate: number | null;
  gst: Hit | null;
}

/** Reads the buyer's premium and GST from an auction's payment wording (cleaned text). */
export function parseTerms(text: string): Terms {
  const s = whole("description", text);
  const p =
    find(s, /(\d{1,2}(?:\.\d+)?)\s*%\s*(?:\+\s*GST\s*)?buyer[’']?s\s+premium/i) ??
    find(s, /buyer[’']?s\s+premium\s+of\s+(\d{1,2}(?:\.\d+)?)\s*%/i);
  const g =
    find(s, /\bGST\s+of\s+(\d{1,2}(?:\.\d+)?)\s*%/i) ??
    find(s, /(\d{1,2}(?:\.\d+)?)\s*%\s*GST\b/i);
  return {
    premiumRate: p ? Number(p.m[1]) : null,
    premium: p ? { source: p.source, start: p.start, end: p.end, quote: p.quote } : null,
    gstRate: g ? Number(g.m[1]) : null,
    gst: g ? { source: g.source, start: g.start, end: g.end, quote: g.quote } : null,
  };
}

/** All-in price as the terms state it: bid, plus premium, plus GST on both. */
export function allIn(bid: number, premiumPct: number | null, gstPct: number | null): number {
  return bid * (1 + (premiumPct ?? 0) / 100) * (1 + (gstPct ?? 0) / 100);
}
