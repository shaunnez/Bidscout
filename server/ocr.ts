import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { OcrWord } from "../shared/specs/photo.ts";

const run = promisify(execFile);

export interface OcrResult {
  text: string;
  words: OcrWord[];
  width: number | null;
  height: number | null;
}

let available: boolean | null = null;

/** True when the tesseract command is installed (it is in the Docker image). */
export async function ocrAvailable(): Promise<boolean> {
  if (available === null) available = await run("tesseract", ["--version"]).then(() => true, () => false);
  return available;
}

/** Photos are enlarged this much (and made greyscale, contrast-normalised) before OCR. */
const SCALE = 2;

/**
 * Runs tesseract on a lot photo and returns its words (boxes in the original photo's pixels,
 * with confidence) and line text. Labels in auction photos are small, so the photo is enlarged
 * 2×, made greyscale and normalised, and read in sparse-text mode (--psm 11).
 */
export async function readImageText(image: Buffer): Promise<OcrResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidscout-ocr-"));
  const file = path.join(dir, "img.png");
  try {
    const src = sharp(image).rotate();
    const meta = await src.metadata();
    const width = meta.autoOrient?.width ?? meta.width ?? null;
    const height = meta.autoOrient?.height ?? meta.height ?? null;
    await src.resize(width ? { width: width * SCALE } : undefined).grayscale().normalise().sharpen().png().toFile(file);
    const { stdout } = await run("tesseract", [file, "stdout", "-l", "eng", "--psm", "11", "tsv"], { maxBuffer: 20 * 1024 * 1024, timeout: 90_000 });
    const r = parseTsv(stdout);
    const k = width ? SCALE : 1;
    return {
      text: r.text,
      words: r.words.map((w) => ({ ...w, left: Math.round(w.left / k), top: Math.round(w.top / k), width: Math.round(w.width / k), height: Math.round(w.height / k) })),
      width,
      height,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Tesseract TSV: level 1 is the page, level 5 a word; words join into lines by block/par/line. */
export function parseTsv(tsv: string): OcrResult {
  const rows = tsv.trim().split("\n").slice(1).map((l) => l.split("\t"));
  let width: number | null = null;
  let height: number | null = null;
  const lines = new Map<string, Array<Omit<OcrWord, "start" | "end">>>();
  for (const r of rows) {
    const [level, , block, par, line, , left, top, w, h, conf, ...rest] = r;
    const text = rest.join("\t").trim();
    if (level === "1") {
      width = Number(w);
      height = Number(h);
    }
    if (level !== "5" || !text || Number(conf) < 0) continue;
    const key = `${block}.${par}.${line}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push({ text, conf: Number(conf), left: Number(left), top: Number(top), width: Number(w), height: Number(h) });
  }
  const words: OcrWord[] = [];
  const out: string[] = [];
  let pos = 0;
  for (const ws of lines.values()) {
    const parts: string[] = [];
    for (const w of ws) {
      if (parts.length) pos += 1;
      words.push({ ...w, start: pos, end: pos + w.text.length });
      parts.push(w.text);
      pos += w.text.length;
    }
    out.push(parts.join(" "));
    pos += 1; // newline
  }
  return { text: out.join("\n"), words, width, height };
}
