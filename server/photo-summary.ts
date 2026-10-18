import { MIN_PHOTO_CONFIDENCE, OCR_VERSION } from "../shared/specs/photo.ts";
import type { Db } from "./db.ts";
import { ocrAvailable } from "./ocr.ts";
import { lotsNeedingPhotos } from "./scan/photos.ts";

/**
 * Where and when reading specs from photos has worked: totals, what's waiting, and the most
 * recent lots read with what each one found (and whether it was used).
 */
export async function photoSummary(db: Db, recent = 30) {
  const [totals, waiting, rows] = await Promise.all([
    db.query(
      `SELECT count(DISTINCT pr.lot_id)::int AS lots_read, count(*)::int AS photos_read, max(pr.created_at) AS last_read_at,
              (SELECT count(DISTINCT pv.lot_id)::int FROM photo_values pv JOIN photo_reads x ON x.id = pv.photo_read_id
                 WHERE x.ocr_version = $1 AND pv.confidence >= $2) AS lots_with_values,
              (SELECT count(*)::int FROM lots WHERE cardinality(photo_fields) > 0) AS lots_using
       FROM photo_reads pr WHERE pr.ocr_version = $1`,
      [OCR_VERSION, MIN_PHOTO_CONFIDENCE],
    ),
    lotsNeedingPhotos(db, 1000),
    db.query(
      `SELECT l.id, l.title, l.thumb_url, l.status, l.photo_fields, max(pr.created_at) AS read_at, count(DISTINCT pr.id)::int AS photos,
              COALESCE(json_agg(json_build_object('field', pv.field, 'value', pv.value, 'confidence', pv.confidence))
                FILTER (WHERE pv.id IS NOT NULL AND pv.confidence >= $2), '[]') AS found
       FROM photo_reads pr JOIN lots l ON l.id = pr.lot_id
       LEFT JOIN photo_values pv ON pv.photo_read_id = pr.id
       WHERE pr.ocr_version = $1
       GROUP BY l.id ORDER BY max(pr.created_at) DESC LIMIT $3`,
      [OCR_VERSION, MIN_PHOTO_CONFIDENCE, recent],
    ),
  ]);
  return { available: await ocrAvailable(), ocrVersion: OCR_VERSION, minConfidence: MIN_PHOTO_CONFIDENCE, waiting: waiting.length, ...totals.rows[0], recent: rows.rows };
}
