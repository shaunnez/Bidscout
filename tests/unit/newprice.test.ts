import assert from "node:assert/strict";
import test from "node:test";
import { isBulkLot, modelNumber, productQuery } from "../../shared/lookup.ts";
import { productMention, searchModel, shopPrice } from "../../server/newprice.ts";

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

test("shop prices: RRP, list and ex-GST prices aren't the shop's price; the model, not the brand, must be named; titles redacted", () => {
  const a = shopPrice(hit("https://shop.co.nz/p", ["Model SHI2000-22 — RRP $1,099; our price $949"]), "EPEVER SHI2000-22");
  assert.equal(a?.price, 949);
  const b = shopPrice(hit("https://shop.co.nz/p", ["SHI2000-22 ex GST $800.00, incl GST $920.00"]), "EPEVER SHI2000-22");
  assert.equal(b?.price, 920);
  assert.equal(productMention("3M tape, great value $12", "3M 7100123456"), -1, "the brand alone isn't the product");
  assert.equal(productMention("3M 7100123456 safety glasses $12", "3M 7100123456"), 3);
  const c = shopPrice({ url: "https://shop.co.nz/p", title: "Call 021 234 5678 for SHI2000-22", excerpts: ["SHI2000-22 $949"] }, "EPEVER SHI2000-22");
  assert.ok(c && !c.title!.includes("234 5678"), "contact details removed from the title");
});

test("the model a shop must name is the last model-like word of the search, not the brand", () => {
  assert.equal(productMention("WD-40 multi-use spray $12", "WD-40 X100"), -1);
  assert.equal(productMention("WD-40 X100 applicator $12", "WD-40 X100"), 6);
});

test("the model: the lot's own model when the search has it, else the last model-like word that isn't a rating", () => {
  assert.equal(searchModel("Makita DHP486 18V"), "DHP486", "18V is a rating");
  assert.equal(searchModel("EPEVER SHI2000-22 2000W"), "SHI2000-22");
  assert.equal(searchModel("WD-40 X100 applicator", "X100"), "X100", "the lot's model wins");
  assert.equal(searchModel("Acme X100 kit", "Q-7"), "X100", "the lot's model isn't used when the search doesn't contain it");
  assert.equal(productMention("Makita 18V drill, any model $199", "Makita DHP486 18V"), -1);
});
