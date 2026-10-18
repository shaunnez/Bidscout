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

test("hosted password gate: Basic auth with any username, constant-time compare", async () => {
  const { passwordAccepted } = await import("../../server/auth.ts");
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
  assert.equal(passwordAccepted(undefined, ""), true, "no password set: open (local use)");
  assert.equal(passwordAccepted(undefined, "s3cret"), false);
  assert.equal(passwordAccepted(basic("shaun", "s3cret"), "s3cret"), true);
  assert.equal(passwordAccepted(basic("", "s3cret"), "s3cret"), true);
  assert.equal(passwordAccepted(basic("shaun", "wrong"), "s3cret"), false);
  assert.equal(passwordAccepted(basic("a", "pass:with:colons"), "pass:with:colons"), true);
  assert.equal(passwordAccepted("Bearer s3cret", "s3cret"), false);
});

test("config: empty variables count as unset, so Railway's DATABASE_URL and PORT are used", async () => {
  const { loadConfig } = await import("../../server/config.ts");
  const c = loadConfig({ BIDSCOUT_DATABASE_URL: "", DATABASE_URL: "postgres://u:p@db.internal:5432/x", BIDSCOUT_HOST: " ", PORT: "8080", BIDSCOUT_API_PORT: "" });
  assert.equal(c.databaseUrl, "postgres://u:p@db.internal:5432/x");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.apiPort, 8080);
  assert.equal(loadConfig({ BIDSCOUT_MIN_INTERVAL_MS: "200" }).minIntervalMs, 1000);
});
