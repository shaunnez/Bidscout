import type { Db } from "./db.ts";
import { startRun } from "./scan/runner.ts";
import { getScanSettings } from "./settings.ts";

/**
 * Starts scheduled scans (checked once a minute by the worker):
 * - a live scan when the last live scan started `liveEveryHours` ago or more;
 * - once a week, a past-sales top-up that stops at the first page with nothing new.
 * Never starts one while another scan is queued or running.
 */
export async function scheduleTick(db: Db, now = new Date()): Promise<string | null> {
  const s = await getScanSettings(db);
  if (!s.scheduleEnabled) return null;
  const active = await db.query(`SELECT 1 FROM scan_runs WHERE state IN ('queued','running') LIMIT 1`);
  if (active.rowCount) return null;
  const last = await db.query(
    `SELECT max(created_at) FILTER (WHERE kind='live') AS live,
            max(created_at) FILTER (WHERE kind='history' AND trigger='schedule') AS history
     FROM scan_runs`,
  );
  const hours = (d: Date | null) => (d ? (now.getTime() - new Date(d).getTime()) / 3_600_000 : Infinity);
  if (hours(last.rows[0].live) >= s.liveEveryHours) {
    await startRun(db, "live", {}, false, { trigger: "schedule" });
    return "live";
  }
  if (s.historyWeekly && hours(last.rows[0].history) >= 24 * 7) {
    await startRun(db, "history", { untilKnown: true, maxPages: 400 }, false, { trigger: "schedule" });
    return "history";
  }
  return null;
}
