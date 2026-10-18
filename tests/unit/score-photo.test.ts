import assert from "node:assert/strict";
import test from "node:test";
import { cleanText } from "../../shared/clean.ts";
import { parseComputer } from "../../shared/specs/computer.ts";
import { extractPhotoValues, mergePhotoValues, type OcrWord } from "../../shared/specs/photo.ts";
import { specScore } from "../../shared/specs/score.ts";
import { parseTsv } from "../../server/ocr.ts";

const summary = (title: string, html: string) => parseComputer({ title: cleanText(title), description: cleanText(html), category: "IT & Equipment" }).summary;

test("spec score: newer CPU, more RAM and an SSD score higher; faults cut it; parts explain it", () => {
  const newer = specScore(summary("Dell Latitude 5430 - Laptop", "Specs &#8211; Intel Core i5 1245U,16GB,512GB SSD"))!;
  const older = specScore(summary("Dell Latitude E7450 - Laptop", "Specs &#8211; Intel Core i5 5300U,8GB,256GB SSD"))!;
  const broken = specScore(summary("Dell Latitude 5430 - Laptop - Won't Boot", "Specs &#8211; Intel Core i5 1245U,16GB,512GB SSD"))!;
  assert.ok(newer.score > older.score, `${newer.score} > ${older.score}`);
  assert.ok(broken.score < older.score);
  assert.match(newer.key, /^s\|portable\|\d+\.\d\|ok$/);
  assert.match(broken.key, /\|fault$/);
  assert.equal(newer.incomplete, false);
  assert.ok(newer.parts.some((p) => p.label.includes("12th gen")));
  const total = newer.parts.reduce((a, p) => a + p.points, 0);
  assert.ok(Math.abs(total - newer.score) < 0.3, "parts add up");
  assert.equal(specScore(summary("Office Chair", "Black mesh")), null, "not a computer");
  assert.equal(specScore(summary("Samsung 27 inch monitor", "")), null, "monitors have no score");
});

const words = (text: string, conf = 90): OcrWord[] => {
  const out: OcrWord[] = [];
  let pos = 0;
  for (const w of text.split(" ")) {
    out.push({ text: w, conf, left: pos * 10, top: 5, width: w.length * 10, height: 12, start: pos, end: pos + w.length });
    pos += w.length + 1;
  }
  return out;
};

test("photo values: BIOS CPU line, memory in MB, storage; each with word boxes", () => {
  const text = "Processor Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz Memory Size 8192 MB Storage 256GB SSD";
  const vs = extractPhotoValues(text, words(text));
  const by = Object.fromEntries(vs.map((v) => [v.field, v]));
  assert.equal(by.cpu!.value, "i5-8350U");
  assert.equal(by.cpu!.cpuGen, 8);
  assert.equal(by.ramGb!.num, 8);
  assert.equal(by.storage!.num, 256);
  for (const v of vs) {
    assert.equal(text.slice(v.start, v.end), v.quote);
    assert.ok(v.boxes.length >= 1);
    assert.equal(v.confidence, 90);
  }
  assert.deepEqual(extractPhotoValues("Core i5 sticker", words("Core i5 sticker")), [], "a bare Core i5 is too weak");
});

test("photo merge fills only what the listing left out, and only when confident", () => {
  const s = summary("HP ProDesk 600 G4 - SFF", "Type &#8211; SFF Make &#8211; HP Model &#8211; ProDesk 600 G4 Specs &#8211; Intel Core i5,8GB");
  assert.equal(s.ramGb, 8);
  assert.equal(s.cpuGen, null);
  const { summary: m, used } = mergePhotoValues(s, [
    { field: "cpu", value: "i5-8500", num: null, confidence: 80 },
    { field: "ramGb", value: "16 GB", num: 16, confidence: 95 },
    { field: "storage", value: "256 GB SSD", num: 256, confidence: 40 },
  ]);
  assert.equal(m.cpu, "i5-8500");
  assert.equal(m.cpuGen, 8);
  assert.equal(m.ramGb, 8, "the listing's RAM stays");
  assert.equal(m.storageGb, null, "40% confident is not enough");
  assert.deepEqual(used, ["cpu"]);
});

test("tesseract TSV becomes words with offsets into the joined text", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t",
    "5\t1\t1\t1\t1\t1\t10\t20\t60\t15\t91.5\tModel:",
    "5\t1\t1\t1\t1\t2\t80\t20\t50\t15\t88\tT510",
    "5\t1\t2\t1\t1\t1\t10\t60\t90\t15\t77\t16GB",
  ].join("\n");
  const r = parseTsv(tsv);
  assert.equal(r.width, 800);
  assert.equal(r.text, "Model: T510\n16GB");
  for (const w of r.words) assert.equal(r.text.slice(w.start, w.end), w.text);
});

test("photo text showing an email or NZ mobile is flagged", async () => {
  const { showsContact } = await import("../../server/redact.ts");
  assert.equal(showsContact("Asset tag 80000737 i5-8350U 16GB RAM"), false);
  assert.equal(showsContact("Owner: jo@example.co.nz"), true);
  assert.equal(showsContact("Call 021 234 5678"), true);
  assert.equal(showsContact("Call 021 234 5678"), true, "no regex state carried over");
});

test("image downloads are capped at 10 MB, by header or while streaming", async () => {
  const { ImageFetcher } = await import("../../server/images.ts");
  const url = "https://d2mkoraxgm9izf.cloudfront.net/x.jpg";
  const big = new ImageFetcher({ sleep: async () => {}, fetch: async () => new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(11 * 1024 * 1024) } }) });
  await assert.rejects(big.get(url), /over 10 MB/);
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 11; i++) c.enqueue(chunk); c.close(); } });
  const streamed = new ImageFetcher({ sleep: async () => {}, fetch: async () => new Response(stream, { headers: { "content-type": "image/jpeg" } }) });
  await assert.rejects(streamed.get(url), /over 10 MB/);
  const ok = new ImageFetcher({ sleep: async () => {}, fetch: async () => new Response(new Uint8Array(10), { headers: { "content-type": "image/jpeg" } }) });
  assert.equal((await ok.get(url)).body.length, 10);
});
