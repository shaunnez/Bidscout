import type { Db } from "../db.ts";

/**
 * Final all-in ranges per machine key (and loose key) from closed lots with at least one bid.
 * All-in uses each lot's own buyer's premium and 15% GST, matching number8.bid's worked example.
 * Lots with a major fault are kept in their own bucket ("…|fault") so a broken machine is
 * never compared with a working one.
 */
export async function rebuildCompStats(db: Db) {
  await db.query(`
    WITH closed AS (
      SELECT machine_key, loose_key, major_fault, closed_at,
             final_bid * (1 + COALESCE(buyer_premium, 0) / 100.0) * 1.15 AS all_in
      FROM lots WHERE status='closed' AND final_bid > 0
    ),
    keyed AS (
      SELECT machine_key || CASE WHEN major_fault THEN '|fault' ELSE '' END AS key, 'machine' AS kind, all_in, closed_at FROM closed WHERE machine_key IS NOT NULL
      UNION ALL
      SELECT loose_key || CASE WHEN major_fault THEN '|fault' ELSE '' END, 'loose', all_in, closed_at FROM closed WHERE loose_key IS NOT NULL
    ),
    stats AS (
      SELECT key, min(kind) AS kind, count(*)::int AS n,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY all_in) AS p25,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY all_in) AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY all_in) AS p75,
             max(closed_at) AS latest
      FROM keyed GROUP BY key
    ),
    gone AS (DELETE FROM comp_stats WHERE key NOT IN (SELECT key FROM stats))
    INSERT INTO comp_stats (key, key_kind, n, p25, p50, p75, latest, built_at)
    SELECT key, kind, n, p25, p50, p75, latest, now() FROM stats
    ON CONFLICT (key) DO UPDATE SET key_kind=EXCLUDED.key_kind, n=EXCLUDED.n, p25=EXCLUDED.p25, p50=EXCLUDED.p50,
      p75=EXCLUDED.p75, latest=EXCLUDED.latest, built_at=EXCLUDED.built_at`);
}
