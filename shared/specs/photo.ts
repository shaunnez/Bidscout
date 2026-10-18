import { findCpu } from "./computer.ts";
import { find, whole, type Seg } from "./text.ts";

/**
 * Spec values in the text OCR found in a lot photo (spec stickers, BIOS and "About" screens).
 * Strict patterns only: a CPU model, "16GB RAM"-style memory, "512GB SSD"-style storage.
 * Each value keeps the OCR words it came from, so the photo can show the boxes.
 */

export const OCR_VERSION = "tesseract5-psm11-x2-v1";
/** Average word confidence (0–100) a photo value needs before BidScout uses it. */
export const MIN_PHOTO_CONFIDENCE = 60;

export interface OcrWord {
  text: string;
  conf: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Offsets of this word in the joined text. */
  start: number;
  end: number;
}

export interface PhotoValue {
  field: "cpu" | "ramGb" | "storage";
  value: string;
  num: number | null;
  quote: string;
  start: number;
  end: number;
  boxes: Array<[number, number, number, number]>;
  confidence: number;
  cpuFamily?: string;
  cpuGen?: number | null;
  storageType?: string;
}

/** True for a CPU with a model number ("i5-8350U", "Celeron N4100", "Apple M2"), not just "Core i5". */
export const hasCpuModel = (cpu: string | null | undefined) => !!cpu && (/\d{3}/.test(cpu) || /^Apple M\d/.test(cpu));

export function wordsIn(words: OcrWord[], start: number, end: number) {
  return words.filter((w) => w.end > start && w.start < end);
}

export function extractPhotoValues(text: string, words: OcrWord[]): PhotoValue[] {
  const seg: Seg = whole("description", text);
  const out: PhotoValue[] = [];
  const add = (v: Omit<PhotoValue, "boxes" | "confidence">) => {
    const ws = wordsIn(words, v.start, v.end);
    if (!ws.length) return;
    const confidence = Math.round(ws.reduce((a, w) => a + w.conf, 0) / ws.length);
    out.push({ ...v, boxes: ws.map((w) => [w.left, w.top, w.width, w.height]), confidence });
  };
  const cpu = findCpu([seg]);
  // A bare "Core i5" in a photo is too weak; require a model number or a named chip.
  if (cpu && hasCpuModel(cpu.cpu)) {
    add({ field: "cpu", value: cpu.cpu, num: null, quote: cpu.hit.quote, start: cpu.hit.start, end: cpu.hit.end, cpuFamily: cpu.family, cpuGen: cpu.gen });
  }
  const ram =
    find(seg, /\b(\d{1,3})\s?GB\s*(?:of\s*)?(?:RAM|DDR\d\w*|LPDDR\d\w*|Memory)\b/i) ??
    find(seg, /\b(?:Installed\s+)?(?:RAM|Memory)\s*[:=-]?\s*(\d{1,3})\s?GB\b/i);
  // BIOS screens: "Memory Size 8192 MB", "System Memory: 16384 MB"
  const mb = !ram ? find(seg, /\b(?:System\s+)?(?:Memory|RAM)(?:\s*Size)?\s*[:=-]?\s*(\d{4,6})\s?MB\b/i) : null;
  if (mb) {
    const n = Math.round(Number(mb.m[1]) / 1024);
    if ([2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256].includes(n))
      add({ field: "ramGb", value: `${n} GB`, num: n, quote: mb.quote, start: mb.start, end: mb.end });
  }
  if (ram) {
    const n = Number(ram.m[1]);
    if ([2, 4, 6, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256].includes(n))
      add({ field: "ramGb", value: `${n} GB`, num: n, quote: ram.quote, start: ram.start, end: ram.end });
  }
  const st = find(seg, /\b(\d+(?:\.\d+)?)\s?(GB|TB)\s*(NVMe|M\.2|SSD|HDD)\b/i);
  if (st) {
    const gb = Number(st.m[1]) * (st.m[2]!.toUpperCase() === "TB" ? 1000 : 1);
    const type = /hdd/i.test(st.m[3]!) ? "hdd" : "ssd";
    if (gb >= 16 && gb <= 20000)
      add({ field: "storage", value: `${gb >= 1000 ? gb / 1000 + " TB" : gb + " GB"} ${type.toUpperCase()}`, num: gb, quote: st.quote, start: st.start, end: st.end, storageType: type });
  }
  return out;
}

export interface StoredPhotoValue {
  field: string;
  value: string;
  num: number | null;
  confidence: number;
}

/**
 * Fills in only the specs the listing text didn't state, from the most confident photo values.
 * Returns the merged summary and the fields that came from photos.
 */
export function mergePhotoValues<S extends { cpu: string | null; cpuFamily: string | null; cpuGen: number | null; ramGb: number | null; storageGb: number | null; storageType: string | null }>(
  summary: S,
  values: StoredPhotoValue[],
): { summary: S; used: string[] } {
  const s = { ...summary };
  const used: string[] = [];
  const best = (field: string) =>
    values.filter((v) => v.field === field && Number(v.confidence) >= MIN_PHOTO_CONFIDENCE).sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
  const cpu = best("cpu");
  if (cpu && !hasCpuModel(s.cpu)) {
    const hit = findCpu([whole("description", cpu.value)]);
    Object.assign(s, { cpu: hit?.cpu ?? cpu.value, cpuFamily: hit?.family ?? s.cpuFamily, cpuGen: hit?.gen ?? null });
    used.push("cpu");
  }
  const ram = best("ramGb");
  if (ram && s.ramGb === null && ram.num !== null) {
    s.ramGb = Number(ram.num);
    used.push("ramGb");
  }
  const st = best("storage");
  if (st && s.storageGb === null && st.num !== null) {
    Object.assign(s, { storageGb: Number(st.num), storageType: /HDD/i.test(st.value) ? "hdd" : "ssd" });
    used.push("storage");
  }
  return { summary: s, used };
}
