import { appContext } from "../server/context.ts";
import { ocrAvailable } from "../server/ocr.ts";
import { lotsNeedingPhotos, readLotPhotos } from "../server/scan/photos.ts";
import { rebuildCompStats } from "../server/scan/comps.ts";

/**
 * Reads photos for computer lots missing specs, outside a scan (live scans do this too).
 *   npm run photos                 up to 40 lots that need it
 *   npm run photos -- --limit 20   up to 20
 *   npm run photos -- 234375       specific lots
 */
const deps = await appContext();
if (!(await ocrAvailable())) {
  console.error("tesseract is not installed (apt install tesseract-ocr).");
  process.exit(1);
}
const args = process.argv.slice(2);
const at = args.indexOf("--limit");
const limit = at >= 0 ? Number(args[at + 1]) || 40 : 40;
const ids = args.filter((a, i) => i !== at && i !== at + 1).map(Number).filter(Boolean);
const lots = ids.length ? ids : await lotsNeedingPhotos(deps.db, limit);
const images = deps.makeImageFetcher();
for (const id of lots) {
  const n = await readLotPhotos(deps.db, deps.store, images, id);
  const v = (await deps.db.query(`SELECT field, value, confidence FROM photo_values WHERE lot_id=$1 ORDER BY id`, [id])).rows;
  console.log(`lot ${id}: ${n} photos read; ${v.map((x) => `${x.field}=${x.value} (${x.confidence})`).join(", ") || "no spec text found"}`);
}
await rebuildCompStats(deps.db);
await deps.db.end();
