import assert from "node:assert/strict";
import test from "node:test";
import { auctionInstructions, auctionTitle } from "../../server/scan/ingest.ts";
import { auctionParts, saleReason } from "../../src/auction.ts";
import { lookupQuery } from "../../src/lookup.ts";

test("auction titles: double-escaped entities are decoded, and the parts are split out", () => {
  assert.equal(auctionTitle("Closed - Unreserved Servers, Computers &#38;#38; General IT Equipment Online Liquidation Auction - Rosedale"),
    "Unreserved Servers, Computers & General IT Equipment Online Liquidation Auction - Rosedale");
  assert.equal(auctionTitle("TV&#39;s &amp; Gaming"), "TV's & Gaming");
  const p = auctionParts("Unreserved Servers, Computers & General IT Equipment Online Liquidation Auction - Rosedale");
  assert.deepEqual(p, { headline: "Servers, Computers & General IT Equipment Liquidation", location: "Rosedale", unreserved: true });
  assert.equal(auctionParts("2022 JCB 90Z-2 Excavator Online Auction").location, null);
});

test("auction intros keep only who is selling, never contact lines", () => {
  const intro = "<p>Under Instructions from The Liquidators of Kruez Logging Ltd (In Liquidation)</p><p>Contact [redacted email] with any questions.</p>";
  assert.equal(auctionInstructions(intro), "Under Instructions from The Liquidators of Kruez Logging Ltd (In Liquidation)");
  assert.equal(auctionInstructions("<p>Contact [redacted email] with any questions or queries.</p>"), null);
  assert.equal(saleReason("Unreserved Office Furniture Receivership Online Auction - Drury", null), "Receivership");
  assert.equal(saleReason("Servers & IT", "Under Instructions from The Liquidators of X"), "Liquidation");
  assert.equal(saleReason("Gaming Insurance Claim Online Auction", null), "Insurance claim");
});

test("price lookups search for the machine, or its parts when it's a clone", () => {
  const base = { is_it: true, make: "Lenovo", model: "ThinkPad T14 Gen 2", cpu: "i5-1145G7", title: "Lenovo ThinkPad T14 Gen 2 - Laptop", ram_gb: 16, storage_gb: 256, storage_type: "ssd", device_type: "laptop" };
  assert.equal(lookupQuery(base), "Lenovo ThinkPad T14 Gen 2 i5-1145G7");
  assert.equal(lookupQuery({ ...base, make: "HP", model: "HP EliteBook 840 G5", cpu: "Core i5" }), "HP EliteBook 840 G5");
  assert.equal(lookupQuery({ ...base, make: "Clone", model: "MT", cpu: "i5-12400", storage_gb: 500, device_type: "desktop" }), "i5-12400 16GB 500GB SSD desktop");
  assert.equal(lookupQuery({ ...base, is_it: false, title: "Unreserved Esse Reflex Glass Console Table - Wholesale" }), "Esse Reflex Glass Console Table");
});
