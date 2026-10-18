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

test("passwords: scrypt hashes verify, wrong ones don't, and rules are enforced", async () => {
  const { hashPassword, verifyPassword, passwordProblem, usernameProblem, readCookie, LoginLimiter } = await import("../../server/auth.ts");
  const h = await hashPassword("correct horse");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", h), true);
  assert.equal(await verifyPassword("wrong horse", h), false);
  assert.notEqual(await hashPassword("correct horse"), h, "salted");
  assert.equal(passwordProblem("short"), "Use at least 8 characters.");
  assert.equal(passwordProblem("long enough"), null);
  assert.equal(usernameProblem("shaun"), null);
  assert.ok(usernameProblem("no spaces allowed"));
  assert.equal(readCookie("a=1; bidscout_session=abc%3D; b=2", "bidscout_session"), "abc=");
  let t = 0;
  const lim = new LoginLimiter(3, 1000, () => t);
  lim.fail("u:x"); lim.fail("u:x"); lim.fail("u:x");
  assert.equal(lim.blocked("u:x"), true);
  t = 2000;
  assert.equal(lim.blocked("u:x"), false, "window expires");
});

test("config: empty variables count as unset, so Railway's DATABASE_URL and PORT are used", async () => {
  const { loadConfig } = await import("../../server/config.ts");
  const c = loadConfig({ BIDSCOUT_DATABASE_URL: "", DATABASE_URL: "postgres://u:p@db.internal:5432/x", BIDSCOUT_HOST: " ", PORT: "8080", BIDSCOUT_API_PORT: "" });
  assert.equal(c.databaseUrl, "postgres://u:p@db.internal:5432/x");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.apiPort, 8080);
  assert.equal(loadConfig({ BIDSCOUT_MIN_INTERVAL_MS: "200" }).minIntervalMs, 1000);
});

test("object store refuses to start on a directory it cannot write", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ObjectStore } = await import("../../server/store.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidscout-store-"));
  new ObjectStore(dir).checkWritable();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  assert.throws(() => new ObjectStore(blocker).checkWritable(), /Cannot write stored responses/);
});

test("friendly bidders: usernames and bidder numbers are separate, and a value two members claim is ignored", async () => {
  const { buildFriendIds, friendHighBidder, friendBids } = await import("../../server/friends.ts");
  const ids = buildFriendIds([
    { id: 1, n8_username: "Shaun", n8_bidder_number: "42" },
    { id: 2, n8_username: "42", n8_bidder_number: "77" }, // username "42" clashes with member 1's number
    { id: 3, n8_username: "sam", n8_bidder_number: null },
    { id: 4, n8_username: "SAM", n8_bidder_number: null }, // same username twice
  ]);
  assert.equal(friendHighBidder(ids, { highbidder_username: "shaun" }), 1);
  assert.equal(friendHighBidder(ids, { buyer_number: "77" }), 2);
  assert.equal(friendHighBidder(ids, { high_bidder: "42" }), null, "ambiguous: dropped");
  assert.equal(friendHighBidder(ids, { highbidder_username: "sam" }), null, "claimed twice: dropped");
  assert.equal(friendHighBidder(ids, { highbidder_username: "77" }), null, "a bidder number is not a username");
  assert.equal(friendHighBidder(ids, { highbidder_username: "shaun", buyer_number: "77" }), null, "fields disagree");
  assert.deepEqual(friendBids(ids, [{ user_name: "Shaun", bid: "20" }, { user_name: "stranger", bid: "25" }]).map((b) => b.userId), [1]);
});
