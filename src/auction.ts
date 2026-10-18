/**
 * number8 auction titles carry everything in one line ("Unreserved Servers, Computers & General
 * IT Equipment Online Liquidation Auction - Rosedale"). These split out the parts worth showing.
 */

export function auctionParts(title: string) {
  let t = title.replace(/\s+/g, " ").trim();
  const unreserved = /\bunreserved\b/i.test(t);
  let location: string | null = null;
  const loc = /\s[-–]\s+([^-–]{2,40})$/.exec(t);
  if (loc) {
    location = loc[1]!.trim();
    t = t.slice(0, loc.index);
  }
  const headline = t
    .replace(/^(?:holding|final|penultimate|cs \d+)\s*-?\s*/i, "")
    .replace(/\bunreserved\b\s*/gi, "")
    .replace(/\bonline\b\s*/gi, "")
    .replace(/\s*\b(?:auction|sale)\b\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { headline: headline || title, location, unreserved };
}

/** Why the goods are being sold, from the title and the "Under instructions from …" line. */
export function saleReason(title: string, instructions: string | null): string | null {
  const t = `${title} ${instructions ?? ""}`;
  if (/receiver/i.test(t)) return "Receivership";
  if (/liquidat/i.test(t)) return "Liquidation";
  if (/insurance claim/i.test(t)) return "Insurance claim";
  if (/closure|end of lease|retirement/i.test(t)) return "Closing down";
  if (/clearance|surplus|end of line|bulk buy/i.test(t)) return "Clearance";
  return null;
}
