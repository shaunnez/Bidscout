/**
 * Removes bidder identities and personal contact details before a response is stored.
 * BidScout has no use for who is bidding; usernames, buyer numbers, emails and mobile
 * numbers never reach disk. Each removal is recorded by path.
 */

// Keys whose values identify a bidder or a person (exact names seen in the AuctionMethod API).
const PERSON_KEYS = new Set([
  "high_bidder",
  "highbidder_username",
  "winner",
  "user_name",
  "username",
  "buyer_number",
  "customer_number",
  "user_id",
  "userid",
  "bidder",
  "bidder_id",
  "consignor",
  "email",
  "phone",
  "cell_number",
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// NZ mobiles (02x) in the usual spacings, with or without +64.
const MOBILE = /(?:\+?64[\s-]?|\b0)2\d[\s-]?\d{3}[\s-]?\d{3,5}\b/g;

export interface RedactResult {
  value: unknown;
  redactions: string[];
}

export function redact(input: unknown): RedactResult {
  const redactions: string[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}.${i}`));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const p = at ? `${at}.${k}` : k;
        if (PERSON_KEYS.has(k.toLowerCase()) && x !== null && x !== "" && x !== 0 && x !== "0") {
          out[k] = "[redacted]";
          redactions.push(p);
        } else out[k] = walk(x, p);
      }
      return out;
    }
    if (typeof v === "string") {
      let s = v;
      if (EMAIL.test(s)) s = s.replace(EMAIL, "[redacted email]");
      EMAIL.lastIndex = 0;
      if (MOBILE.test(s)) s = s.replace(MOBILE, "[redacted phone]");
      MOBILE.lastIndex = 0;
      if (s !== v) redactions.push(at);
      return s;
    }
    return v;
  };
  return { value: walk(input, ""), redactions };
}
