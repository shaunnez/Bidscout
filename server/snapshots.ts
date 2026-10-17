import type { Db, Tx } from "./db.ts";
import { redact } from "./redact.ts";
import { ObjectStore, sha256 } from "./store.ts";
import type { FetchResult } from "./transport.ts";

export interface Snapshot<T = unknown> {
  id: number;
  doc: T;
}

/** Parses, redacts and stores a response. The stored (redacted) JSON is what citations point into. */
export async function saveSnapshot<T>(c: Db | Tx, store: ObjectStore, runId: number | null, r: FetchResult): Promise<Snapshot<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new Error(`Response from ${r.url} was not JSON`);
  }
  const { value, redactions } = redact(parsed);
  const stored = Buffer.from(JSON.stringify(value));
  const { ref, hash } = store.put(stored);
  const row = await c.query(
    `INSERT INTO snapshots (run_id, method, url, request_body, status, elapsed_ms, attempts,
       original_sha256, stored_sha256, object_ref, bytes, redactions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [runId, r.method, r.url, r.requestBody, r.status, r.elapsedMs, r.attempts, sha256(r.body), hash, ref, stored.length, JSON.stringify(redactions)],
  );
  return { id: row.rows[0].id, doc: value as T };
}

const cache = new Map<string, unknown>();

export async function loadSnapshotDoc(db: Db, store: ObjectStore, id: number): Promise<{ doc: unknown; meta: Record<string, unknown> }> {
  const r = await db.query(
    `SELECT id, method, url, request_body, status, fetched_at, stored_sha256, original_sha256, object_ref, redactions FROM snapshots WHERE id=$1`,
    [id],
  );
  if (!r.rows[0]) throw new Error(`No snapshot ${id}`);
  const meta = r.rows[0];
  let doc = cache.get(meta.object_ref);
  if (!doc) {
    doc = JSON.parse(store.get(meta.object_ref).toString("utf8"));
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(meta.object_ref, doc);
  }
  return { doc, meta };
}
