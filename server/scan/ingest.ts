import crypto from "node:crypto";
import { cleanText } from "../../shared/clean.ts";
import { looseKey, machineKey, PARSER_VERSION, parseComputer, titleKey, type ComputerSummary } from "../../shared/specs/computer.ts";
import { mergePhotoValues } from "../../shared/specs/photo.ts";
import { specScore } from "../../shared/specs/score.ts";
import type { Tx } from "../db.ts";
import { isoToDate, num, unixToDate, type N8Auction, type N8Lot } from "../number8.ts";

/** A lot that ended more than this long ago is closed (extended bidding can push the end out). */
export const CLOSE_GRACE_MS = 5 * 60_000;

export interface IngestOutcome {
  isNew: boolean;
  changed: boolean;
  observed: boolean;
  closedNow: boolean;
  revisionId: number;
  parsed: boolean;
}

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The listing content of a lot. Bids and close time are left out: they are observations. */
function semanticFields(row: N8Lot) {
  return {
    title: row.title ?? "",
    description: row.description ?? "",
    lot_number: row.lot_number ?? null,
    quantity: row.quantity ?? null,
    category: row.category_name ?? null,
    starting_bid: row.starting_bid ?? null,
    buyer_premium: row.buyer_premium ?? null,
    buy_now: row.buy_now ?? null,
    thumb_url: row.thumb_url ?? null,
  };
}

export async function upsertAuction(c: Tx, a: N8Auction, snapshotId: number, path: string, now: Date) {
  const id = Number(a.id);
  const title = cleanText(a.title).replace(/^Closed\s*-\s*/i, "");
  const fields = { title, starts: a.starts ?? null, ends: a.ends ?? null, city: a.city ?? null, count: a.item_count ?? null };
  await c.query(
    `INSERT INTO auctions (id, title, starts_at, ends_at, city, region, item_count, url, thumb_url, list_hash, snapshot_id, snapshot_path, first_seen, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at,
       city=EXCLUDED.city, region=EXCLUDED.region, item_count=EXCLUDED.item_count, url=EXCLUDED.url,
       thumb_url=EXCLUDED.thumb_url, list_hash=EXCLUDED.list_hash, snapshot_id=EXCLUDED.snapshot_id,
       snapshot_path=EXCLUDED.snapshot_path, last_seen=EXCLUDED.last_seen`,
    [id, title, isoToDate(a.starts), isoToDate(a.ends), a.city ?? null,
      a.state_abbreviation ?? null, num(a.item_count), a.url ? new URL(a.url, "https://www.number8.bid").toString() : null,
      a.main_thumb_url ?? null, hash(fields), snapshotId, path, now],
  );
}

async function ensureAuctionStub(c: Tx, row: N8Lot, snapshotId: number, path: string) {
  await c.query(
    `INSERT INTO auctions (id, title, snapshot_id, snapshot_path) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [Number(row.auction_id), cleanText(row.auction_title ?? `Auction ${row.auction_id}`).replace(/^Closed\s*-\s*/i, ""), snapshotId, `${path}.auction_title`],
  );
}

/**
 * Copies a parse's facets onto the lot, plus the spec score. `photoFields` names facets that
 * came from photo text rather than the listing (see server/scan/photos.ts).
 */
export async function applySummary(c: Tx, lotId: number, s: ComputerSummary, title: string, photoFields: string[] = []) {
  const score = specScore(s);
  await c.query(
    `UPDATE lots SET parser_version=$2, device_type=$3, is_it=$4, make=$5, model=$6, cpu=$7, cpu_family=$8, cpu_gen=$9,
       ram_gb=$10, storage_gb=$11, storage_type=$12, screen_in=$13, gpu=$14, os=$15, faults=$16, major_fault=$17,
       machine_key=$18, loose_key=$19, spec_score=$20, score_key=$21, score_parts=$22, score_incomplete=$23, photo_fields=$24
     WHERE id=$1`,
    [lotId, PARSER_VERSION, s.deviceType, s.isIt, s.make, s.model, s.cpu, s.cpuFamily, s.cpuGen, s.ramGb, s.storageGb,
      s.storageType, s.screenIn, s.gpu, s.os, s.faults, s.majorFault, s.machineKey ?? (s.isIt ? null : titleKey(title)), s.looseKey,
      score?.score ?? null, score?.key ?? null, score ? JSON.stringify(score.parts) : null, score?.incomplete ?? false, photoFields],
  );
}

/** Parses a revision and stores every value with its span, then copies the facets onto the lot. */
export async function parseRevision(c: Tx, lotId: number, revisionId: number, fields: ReturnType<typeof semanticFields>) {
  const title = cleanText(fields.title);
  const description = cleanText(fields.description);
  const { values, summary } = parseComputer({ title, description, category: fields.category });
  const existing = await c.query(`SELECT 1 FROM spec_values WHERE lot_revision_id=$1 AND parser_version=$2 LIMIT 1`, [revisionId, PARSER_VERSION]);
  if (!existing.rowCount && values.length) {
    const cols: unknown[] = [];
    const tuples = values.map((v, i) => {
      cols.push(revisionId, PARSER_VERSION, v.field, v.value, v.num ?? null, v.source, v.start, v.end, v.quote, v.method);
      const b = i * 10;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
    });
    await c.query(
      `INSERT INTO spec_values (lot_revision_id, parser_version, field, value, num, source, start_offset, end_offset, quote, method) VALUES ${tuples.join(",")}`,
      cols,
    );
  }
  // Specs read from photos fill gaps the listing leaves (server/scan/photos.ts); keep them on re-parse.
  const photo = (await c.query(`SELECT field, value, num, confidence FROM photo_values WHERE lot_id=$1`, [lotId])).rows;
  if (photo.length) {
    const merged = mergePhotoValues(summary, photo);
    merged.summary.machineKey = machineKey(merged.summary);
    merged.summary.looseKey = looseKey(merged.summary);
    await applySummary(c, lotId, merged.summary, title, merged.used);
  } else await applySummary(c, lotId, summary, title);
  return values.length;
}

/**
 * Records one lot row from a stored response. Called inside the page's transaction.
 * `past` rows come from the past-sales list and are always closed.
 */
export async function ingestLot(c: Tx, row: N8Lot, snapshotId: number, path: string, now: Date, past = false): Promise<IngestOutcome> {
  const id = Number(row.id);
  const fields = semanticFields(row);
  const semantic = hash(fields);
  const ends = unixToDate(row.end_time ?? row.ends);
  const bid = num(row.current_bid);
  const bids = num(row.bid_count);
  const closed = past || (!!ends && ends.getTime() < now.getTime() - CLOSE_GRACE_MS);
  const status = closed ? "closed" : "open";
  const title = cleanText(fields.title);
  const description = cleanText(fields.description);

  await ensureAuctionStub(c, row, snapshotId, path);
  const cur = await c.query(
    `SELECT id, semantic_hash, current_revision_id, status, current_bid, bid_count, ends_at FROM lots WHERE id=$1 FOR UPDATE`,
    [id],
  );
  const lot = cur.rows[0];
  let isNew = false;
  let changed = false;
  let revisionId: number = lot?.current_revision_id;
  let parsed = false;

  if (!lot) {
    isNew = true;
    await c.query(
      `INSERT INTO lots (id, auction_id, lot_number, title, description, category, quantity, item_url, thumb_url, city,
         semantic_hash, ends_at, current_bid, bid_count, starting_bid, buyer_premium, status, needs_detail, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
      [id, Number(row.auction_id), fields.lot_number, title, description, fields.category, num(fields.quantity),
        row.item_url ?? null, fields.thumb_url, row.mapping_city ?? null, semantic, ends, bid, bids,
        num(fields.starting_bid), num(fields.buyer_premium), status, !closed, now],
    );
  }
  if (!lot || lot.semantic_hash !== semantic) {
    if (lot) changed = true;
    const ins = await c.query(
      `INSERT INTO lot_revisions (lot_id, semantic_hash, fields, snapshot_id, snapshot_path)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (lot_id, semantic_hash) DO NOTHING RETURNING id`,
      [id, semantic, JSON.stringify(fields), snapshotId, path],
    );
    revisionId = ins.rows[0]?.id ?? (await c.query(`SELECT id FROM lot_revisions WHERE lot_id=$1 AND semantic_hash=$2`, [id, semantic])).rows[0].id;
    await c.query(
      `UPDATE lots SET current_revision_id=$2, semantic_hash=$3, title=$4, description=$5, category=$6, quantity=$7,
         lot_number=$8, thumb_url=$9, starting_bid=$10, buyer_premium=$11, needs_detail = needs_detail OR $12 WHERE id=$1`,
      [id, revisionId, semantic, title, description, fields.category, num(fields.quantity), fields.lot_number,
        fields.thumb_url, num(fields.starting_bid), num(fields.buyer_premium), !closed],
    );
    await parseRevision(c, id, revisionId, fields);
    parsed = true;
  }

  const moved =
    !lot || lot.status !== status || Number(lot.current_bid ?? -1) !== (bid ?? -1) ||
    Number(lot.bid_count ?? -1) !== (bids ?? -1) || (lot.ends_at?.getTime?.() ?? 0) !== (ends?.getTime() ?? 0);
  if (moved) {
    await c.query(
      `INSERT INTO lot_observations (lot_id, observed_at, current_bid, bid_count, ends_at, status, snapshot_id, snapshot_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, now, bid, bids, ends, status, snapshotId, path],
    );
  }
  const closedNow = closed && (!lot || lot.status !== "closed");
  await c.query(
    `UPDATE lots SET current_bid=$2::numeric, bid_count=$3::int, ends_at=$4::timestamptz, status=$5::text, last_seen=$6,
       item_url=COALESCE($7::text, item_url), city=COALESCE($8::text, city),
       final_bid = CASE WHEN $5::text = 'closed' AND COALESCE($3::int, 0) > 0 THEN $2::numeric END,
       closed_at = CASE WHEN $5::text = 'closed' THEN $4::timestamptz END,
       outcome_snapshot_id = CASE WHEN $5::text = 'closed' THEN $9::bigint END,
       outcome_path = CASE WHEN $5::text = 'closed' THEN $10::text END,
       needs_detail = CASE WHEN $5::text = 'closed' THEN false ELSE needs_detail END
     WHERE id=$1`,
    [id, bid, bids, ends, status, now, row.item_url ?? null, row.mapping_city ?? null, snapshotId, path],
  );
  return { isNew, changed, observed: moved, closedNow, revisionId, parsed };
}
