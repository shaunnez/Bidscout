import { looseKey, machineKey, COMPUTER_TYPES, type ComputerSummary } from "../../shared/specs/computer.ts";
import { CURRENT_PHOTO_VALUES, extractPhotoValues, mergePhotoValues, OCR_VERSION } from "../../shared/specs/photo.ts";
import { tx, type Db, type Tx } from "../db.ts";
import type { ImageFetcher } from "../images.ts";
import { readImageText, type OcrResult } from "../ocr.ts";
import { showsContact } from "../redact.ts";
import type { ObjectStore } from "../store.ts";
import { applySummary } from "./ingest.ts";

/**
 * Computer lots worth reading photos for: open, with photos, not read with this OCR version,
 * and missing a CPU model, RAM or storage (or relying on photos for one of them).
 */
export async function lotsNeedingPhotos(c: { query: Tx["query"] }, limit: number) {
  const r = await c.query(
    `SELECT id FROM lots
     WHERE status='open' AND is_it AND device_type = ANY($1) AND jsonb_array_length(images) > 0 AND photo_ocr_version IS DISTINCT FROM $3
       AND (cpu IS NULL OR (cpu !~ '\\d{3}' AND cpu !~ '^Apple M\\d') OR ram_gb IS NULL OR storage_gb IS NULL
            OR cardinality(photo_fields) > 0)
     ORDER BY ends_at NULLS LAST LIMIT $2`,
    [[...COMPUTER_TYPES], limit, OCR_VERSION],
  );
  return r.rows.map((x) => Number(x.id));
}

const summaryFromRow = (l: Record<string, any>): ComputerSummary => ({
  deviceType: l.device_type, isIt: l.is_it, make: l.make, model: l.model, cpu: l.cpu, cpuFamily: l.cpu_family,
  cpuGen: l.cpu_gen, ramGb: l.ram_gb, storageGb: l.storage_gb, storageType: l.storage_type, screenIn: l.screen_in,
  gpu: l.gpu, os: l.os, faults: l.faults ?? [], majorFault: l.major_fault, machineKey: l.machine_key, looseKey: l.loose_key,
});

/**
 * Reads up to `maxImages` photos of one lot: runs OCR, stores the photo and any spec values
 * found (with their word boxes), and fills in only the specs the listing text didn't state.
 * A photo whose text shows an email address or phone number is dropped, not stored.
 * Returns the number of photos read. If every photo failed for a reason that may pass
 * (network, server error), the lot stays queued for the next scan.
 */
export async function readLotPhotos(
  db: Db,
  store: ObjectStore,
  images: Pick<ImageFetcher, "get">,
  lotId: number,
  maxImages = 3,
  now = new Date(),
  ocr: (image: Buffer) => Promise<OcrResult> = readImageText,
): Promise<number> {
  const lot = (await db.query(`SELECT * FROM lots WHERE id=$1`, [lotId])).rows[0];
  if (!lot) return 0;
  let read = 0;
  let retryLater = false;
  for (const url of (lot.images as string[]).slice(0, maxImages)) {
    let img;
    try {
      img = await images.get(url);
    } catch (e) {
      if (!isPermanent(e)) retryLater = true;
      continue;
    }
    let text: OcrResult;
    try {
      text = await ocr(img.body);
    } catch {
      continue; // corrupt or unreadable image: skip it, don't stop the scan
    }
    if (showsContact(text.text)) continue;
    const { hash } = store.put(img.body);
    read++;
    const ins = await db.query(
      `INSERT INTO photo_reads (lot_id, image_url, image_sha256, content_type, width, height, ocr_version, text, words, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (lot_id, image_url, ocr_version) DO NOTHING RETURNING id`,
      [lotId, url, hash, img.contentType, text.width, text.height, OCR_VERSION, text.text, JSON.stringify(text.words), now],
    );
    const readId = ins.rows[0]?.id;
    if (!readId) continue;
    for (const v of extractPhotoValues(text.text, text.words)) {
      await db.query(
        `INSERT INTO photo_values (photo_read_id, lot_id, field, value, num, quote, boxes, confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [readId, lotId, v.field, v.value, v.num, v.quote, JSON.stringify(v.boxes), v.confidence],
      );
    }
  }
  await tx(db, async (c) => {
    const stored = (await c.query(CURRENT_PHOTO_VALUES, [lotId])).rows;
    const { summary, used } = mergePhotoValues(summaryFromRow(lot), stored);
    summary.machineKey = machineKey(summary);
    summary.looseKey = looseKey(summary);
    if (used.length) await applySummary(c, lotId, summary, lot.title, used);
    if (read > 0 || !retryLater) await c.query(`UPDATE lots SET photo_ocr_at=$2, photo_ocr_version=$3 WHERE id=$1`, [lotId, now, OCR_VERSION]);
  });
  return read;
}

/** Failures that won't pass on a retry: refused, not an image, too big, not number8's image host. */
const isPermanent = (e: unknown) => /^(HTTP 4|Not an image|Image over|Not a number8 image)/.test((e as Error)?.message ?? "");
