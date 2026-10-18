import assert from "node:assert/strict";
import test from "node:test";
import { isBulkLot, modelNumber, productQuery } from "../../shared/lookup.ts";
import { productMention, shopPrice } from "../../server/newprice.ts";

test("search text for products: brand and model from the description; bulk lots get none", () => {
  assert.equal(productQuery("EPEVER Pure Sine Wave Inverter", "EPEVER Pure Sine Wave Inverter Model – SHI2000-22(AU)"), "EPEVER SHI2000-22");
  assert.equal(productQuery("6x EPEVER Pure Sine Wave Inverter 600W", "EPEVER Pure Sine Wave Inverter 600W PN: SHI600-12(AU) Quantity – 6"), "EPEVER SHI600-12");
  assert.equal(productQuery("SOFAR SOLAR PV Inverter", "SOFAR SOLAR PV Inverter SOFAR4000TLM"), "SOFAR4000TLM");
  assert.equal(productQuery("Pallet Lot of Christmas Products", ""), "");
  assert.equal(productQuery("Bulk Lot of Assorted Hair Accessories", ""), "");
  assert.equal(productQuery("MIDJ Nene Wood Dining Chair - Wholesale $650.00", ""), "MIDJ Nene Wood Dining Chair");
  assert.equal(productQuery("Wooden Dining Table with 6 Chairs", "Dimensions L1480 x W900 x H750mm"), "Wooden Dining Table with 6 Chairs");
  assert.equal(isBulkLot("9x Bays Of Dexion Warehouse Pallet Racking"), false, "pallet racking is a product");
  assert.equal(isBulkLot("Heavy-Duty Manual Pallet Jack"), false);
  assert.equal(modelNumber("Inverter 400W 12V 230V, 2000VA"), null, "ratings aren't models");
});

const hit = (url: string, excerpts: string[]) => ({ url, title: "Shop page", excerpts });

test("shop prices: the price nearest the model, NZ shops only, not savings, old prices or payment plans", () => {
  const a = shopPrice(hit("https://www.solarshop.co.nz/epever-shi2000", ["EPEVER SHI2000-22 Pure Sine Wave Inverter 2000W. Was $1,099.00 Now $949.00 incl GST. Afterpay 4 x $237.25"]), "EPEVER SHI2000-22");
  assert.ok(a);
  assert.deepEqual([a.host, a.price], ["solarshop.co.nz", 949]);
  assert.equal(a.excerpt.slice(a.quote_start, a.quote_end), "$949.00");
  assert.equal(shopPrice(hit("https://www.amazon.com/x", ["EPEVER SHI2000-22 $499.00"]), "EPEVER SHI2000-22"), null, "not a NZ shop");
  assert.equal(shopPrice(hit("https://www.trademe.co.nz/a/x", ["EPEVER SHI2000-22 $499.00"]), "EPEVER SHI2000-22"), null, "Trade Me is not a shop here");
  assert.equal(shopPrice(hit("https://shop.co.nz/other", ["Victron Phoenix 12/500 inverter $399.00"]), "EPEVER SHI2000-22"), null, "the product must be named");
  assert.equal(productMention("Epever SHI 2000-22 inverter", "EPEVER SHI2000-22"), 7, "matches without spaces or dashes");
  const b = shopPrice(hit("https://www.powershop.nz/p", ["Free shipping over $100. EPEVER SHI2000-22 — $1,020.50"]), "EPEVER SHI2000-22");
  assert.equal(b?.price, 1020.5, "the shipping threshold isn't the price");
});
