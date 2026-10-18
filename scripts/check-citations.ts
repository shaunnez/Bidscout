import { cleanText } from "../shared/clean.ts";
import { resolvePath } from "../shared/cite.ts";
import { loadConfig } from "../server/config.ts";
import { connect } from "../server/db.ts";
import { loadSnapshotDoc } from "../server/snapshots.ts";
import { ObjectStore } from "../server/store.ts";

/** Re-reads every stored citation from its snapshot and fails if any quote is not at its offsets. */
const config = loadConfig();
const db = connect(config.databaseUrl);
const store = new ObjectStore(config.dataDir);
const rows = await db.query(
  `SELECT v.id, v.field, v.source, v.start_offset, v.end_offset, v.quote, r.snapshot_id, r.snapshot_path
   FROM spec_values v JOIN lot_revisions r ON r.id = v.lot_revision_id ORDER BY r.snapshot_id`,
);
let bad = 0;
for (const v of rows.rows) {
  const { doc } = await loadSnapshotDoc(db, store, v.snapshot_id);
  const text = cleanText(resolvePath(doc, `${v.snapshot_path}.${v.source}`));
  if (text.slice(v.start_offset, v.end_offset) !== v.quote) {
    bad++;
    if (bad <= 20) console.log(`✕ citation ${v.id} (${v.field}): expected “${v.quote}”, found “${text.slice(v.start_offset, v.end_offset)}”`);
  }
}
const terms = await db.query(`SELECT * FROM auction_terms`);
for (const t of terms.rows) {
  const { doc } = await loadSnapshotDoc(db, store, t.snapshot_id);
  const text = cleanText(resolvePath(doc, t.snapshot_path));
  for (const w of ["premium", "gst"]) {
    if (t[`${w}_quote`] && text.slice(t[`${w}_start`], t[`${w}_end`]) !== t[`${w}_quote`]) {
      bad++;
      console.log(`✕ auction ${t.auction_id} ${w} terms quote moved`);
    }
  }
}
// Photo values: the stored photo still matches its hash, and the quote is in the text read from it.
const photos = await db.query(
  `SELECT v.id, v.field, v.quote, r.text, r.image_sha256 FROM photo_values v JOIN photo_reads r ON r.id = v.photo_read_id ORDER BY v.id`,
);
for (const p of photos.rows) {
  let problem = "";
  try {
    store.get(p.image_sha256);
  } catch (e) {
    problem = `photo unreadable (${(e as Error).message})`;
  }
  if (!problem && !p.text.includes(p.quote)) problem = `“${p.quote}” not in the photo's text`;
  if (problem) {
    bad++;
    console.log(`✕ photo value ${p.id} (${p.field}): ${problem}`);
  }
}
console.log(`${rows.rows.length + terms.rows.length * 2 + photos.rows.length} citations checked, ${bad} failed.`);
await db.end();
process.exit(bad ? 1 : 0);
