import assert from "node:assert/strict";
import test from "node:test";
import { cleanText } from "../../shared/clean.ts";
import { intelGen, parseComputer, titleKey } from "../../shared/specs/computer.ts";
import { allIn, parseTerms } from "../../shared/terms.ts";

// Illustrative lots written in the formats number8.bid uses; not copied listings.
const parse = (title: string, html: string, category: string | null = "IT & Equipment") => {
  const t = cleanText(title);
  const d = cleanText(html);
  const r = parseComputer({ title: t, description: d, category });
  for (const v of r.values) assert.equal((v.source === "title" ? t : d).slice(v.start, v.end), v.quote, `${v.field} span`);
  return r;
};
const valueOf = (r: ReturnType<typeof parse>, field: string) => r.values.find((v) => v.field === field);

test("cleanText strips tags, decodes entities and keeps line structure", () => {
  assert.equal(cleanText("<p>\t<ul><li>A &#8211; B</li><li>C&nbsp;&amp; D</li></ul></p>"), "A – B\nC & D");
  assert.equal(cleanText("1</strong><strong>5% + GST"), "15% + GST");
});

test("ITAD batch format", () => {
  const r = parse(
    "Dell Latitude 7420 - Laptop",
    "<ul><li>ITAD Barcode &#8211; 1234 Serial Number &#8211; ABC123 Type &#8211; Laptop Make &#8211; Dell Model &#8211; Latitude 7420 Specs &#8211; Intel Core i7 1185G7,3.0GHz,16GB,512GB SSD ,14 inch,Webcam,Windows Pro Faults &#8211; Missing power adapter ITAD Comments &#8211; -</li></ul>",
  );
  const s = r.summary;
  assert.equal(s.deviceType, "laptop");
  assert.equal(s.make, "Dell");
  assert.equal(s.model, "Latitude 7420");
  assert.equal(s.cpu, "i7-1185G7");
  assert.equal(s.cpuGen, 11);
  assert.equal(s.ramGb, 16);
  assert.equal(s.storageGb, 512);
  assert.equal(s.storageType, "ssd");
  assert.equal(s.screenIn, 14);
  assert.deepEqual(s.faults, ["no-charger"]);
  assert.equal(s.majorFault, false);
  assert.equal(valueOf(r, "cpu")!.quote, "Intel Core i7 1185G7");
  assert.equal(valueOf(r, "ramGb")!.quote, "16GB");
  assert.match(s.machineKey!, /^m\|laptop\|dell\|latitude 7420\|i7 1185g7\|ram16\|ssd512$/);
});

test("ITAD with an empty Faults field records 'None listed'", () => {
  const r = parse("HP ProDesk 600 G6 - SFF", "Type &#8211; SFF Make &#8211; HP Model &#8211; ProDesk 600 G6 Specs &#8211; Intel Core i5 10500,8GB,256GB SSD Faults &#8211; ITAD Comments &#8211; -");
  assert.deepEqual(r.summary.faults, []);
  assert.equal(valueOf(r, "faultsListed")!.value, "None listed");
});

test("labelled format with labels running together", () => {
  const r = parse(
    "laptop - Lenovo Thinkpad X1 Carbon (TouchScreen)",
    "Model: Thinkpad X1 Carbon (TouchScreen)CPU: Core i5 8350U @ 1.7ghzRAM: 8gbStorage: 256gb ssd Screen: 14’‘ GPU : intergratedWebcam: yesCOA / Licence: Windows 11 ProSN: XYZNotes: light scratches on lid",
  );
  const s = r.summary;
  assert.equal(s.deviceType, "laptop");
  assert.equal(s.model, "Thinkpad X1 Carbon");
  assert.equal(s.cpu, "i5-8350U");
  assert.equal(s.cpuGen, 8);
  assert.equal(s.ramGb, 8);
  assert.equal(s.storageGb, 256);
  assert.equal(s.screenIn, 14);
  assert.equal(s.gpu, null, "integrated is not a GPU spec");
  assert.ok(s.faults.includes("cosmetic"));
});

test("free text server with multiplied drives and a removed-drive note", () => {
  const r = parse("Dell PowerEdge R740 Server - No Hard Drives", "Intel Xeon Gold 6130,2.10 GHz,256 GB,2 × 960GB SSD ,2 Power Supplies");
  const s = r.summary;
  assert.equal(s.deviceType, "server");
  assert.equal(s.cpu, "Xeon Gold 6130");
  assert.equal(s.storageGb, 1920);
  assert.ok(s.faults.includes("no-drive"));
});

test("faults: major vs minor, and plain lots get faults but no specs", () => {
  assert.equal(parse("Apple MacBook Air - Won’t Boot", "Core i5, 8GB, 128GB SSD").summary.majorFault, true);
  assert.ok(parse("iPad Air Tablet", "Unable to activate. No charger").summary.faults.includes("locked"));
  const fridge = parse("Commercial Underbench Fridge", "Stainless steel. Small dent on door.", "Catering / Restaurants");
  assert.equal(fridge.summary.isIt, false);
  assert.equal(fridge.summary.deviceType, null);
  assert.deepEqual(fridge.values.map((v) => v.field), ["fault"]);
});

test("phones and tablets: GB in the title is storage, not RAM", () => {
  const s = parse("Apple iPhone 12 A2403 - 128 GB", "Screen in good condition").summary;
  assert.equal(s.deviceType, "phone");
  assert.equal(s.ramGb, null);
  assert.equal(s.storageGb, 128);
});

test("Intel generation from model numbers", () => {
  assert.equal(intelGen("8500", "T"), 8);
  assert.equal(intelGen("10500"), 10);
  assert.equal(intelGen("1240", "P"), 12);
  assert.equal(intelGen("1065", "G7"), 10);
  assert.equal(intelGen("2500", "K"), 2);
});

test("title keys group repeated stock lines", () => {
  assert.equal(titleKey("2x Blue Widget Pro 3000"), titleKey("Blue Widget Pro 3000"));
});

test("payment terms give premium and GST with their wording", () => {
  const text = cleanText("<p><strong>BIDS IN THIS SALE DO NOT INCLUDE GST AND HAVE A 1</strong><strong>5% + GST BUYER'S PREMIUM</strong></p><p>eg. If the winning bid is $1,000.00 the buyer's premium of 15% is added ($150) and then GST of 15% ($172.50) is added</p>");
  const t = parseTerms(text);
  assert.equal(t.premiumRate, 15);
  assert.equal(t.gstRate, 15);
  assert.equal(text.slice(t.premium!.start, t.premium!.end), t.premium!.quote);
  assert.equal(Math.round(allIn(1000, 15, 15) * 100) / 100, 1322.5);
});
