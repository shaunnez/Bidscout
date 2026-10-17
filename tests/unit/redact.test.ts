import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../../server/redact.ts";

test("bidder identities and personal contacts are removed, prices and premiums kept", () => {
  const { value, redactions } = redact({
    items: [{ id: "1", high_bidder: "60248", winner: "someone", buyer_premium: "15.000", current_bid: "10.00" }],
    bid_history: [{ bid: "10.00", user_name: "bidder9", buyer_number: "77", time_of_bid: "2026-10-16T03:47:43+1300" }],
    intro: "Contact sales on info@example.co.nz or 021 714 766 for viewing",
    empty_winner: { winner: "" },
  }) as { value: any; redactions: string[] };
  assert.equal(value.items[0].high_bidder, "[redacted]");
  assert.equal(value.items[0].winner, "[redacted]");
  assert.equal(value.items[0].buyer_premium, "15.000");
  assert.equal(value.bid_history[0].user_name, "[redacted]");
  assert.equal(value.bid_history[0].bid, "10.00");
  assert.equal(value.intro, "Contact sales on [redacted email] or [redacted phone] for viewing");
  assert.equal(value.empty_winner.winner, "");
  assert.ok(redactions.includes("items.0.high_bidder"));
  assert.ok(redactions.includes("intro"));
});
