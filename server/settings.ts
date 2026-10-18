import type { Db } from "./db.ts";

/** Admin-editable settings, stored in the settings table and read by the worker each minute. */
export interface ScanSettings {
  /** Run a live scan automatically every `liveEveryHours`. */
  scheduleEnabled: boolean;
  liveEveryHours: number;
  /** Once a week, read past sales until reaching ones already stored. */
  historyWeekly: boolean;
  /** Requests to number8.bid in flight at once (1–4). Drops to 1 for the rest of a scan if the site slows. */
  concurrency: number;
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  // On by default when hosted (the Docker image sets NODE_ENV=production); off for local development.
  scheduleEnabled: process.env.NODE_ENV === "production",
  liveEveryHours: 4,
  historyWeekly: true,
  concurrency: 4,
};

export const LIVE_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

export function cleanScanSettings(input: Partial<ScanSettings> | null | undefined): ScanSettings {
  const v = { ...DEFAULT_SCAN_SETTINGS, ...(input ?? {}) };
  return {
    scheduleEnabled: !!v.scheduleEnabled,
    liveEveryHours: LIVE_HOURS.includes(Number(v.liveEveryHours)) ? Number(v.liveEveryHours) : DEFAULT_SCAN_SETTINGS.liveEveryHours,
    historyWeekly: !!v.historyWeekly,
    concurrency: Math.min(4, Math.max(1, Math.round(Number(v.concurrency) || 1))),
  };
}

export async function getScanSettings(db: Db): Promise<ScanSettings> {
  const r = await db.query(`SELECT value FROM settings WHERE key='scan'`);
  return cleanScanSettings(r.rows[0]?.value);
}

export async function saveScanSettings(db: Db, input: Partial<ScanSettings>, userId: number | null): Promise<ScanSettings> {
  const s = cleanScanSettings({ ...(await getScanSettings(db)), ...input });
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('scan', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(s), userId],
  );
  return s;
}

/** Trade Me price lookups (server/trademe.ts): off until an admin turns them on. */
export interface TradeMeSettings {
  enabled: boolean;
  /** Button lookups the whole group may run in 24 hours (cached answers don't count). */
  dailyLimit: number;
  /** Look up every open IT lot automatically, through Parallel only (server/autoprice.ts). */
  autoEnabled: boolean;
  /** Automatic lookups in 24 hours, on top of the button's. */
  autoDailyLimit: number;
  /** Why automatic lookups last turned themselves off (e.g. Trade Me refused), and when. */
  autoStopped: { reason: string; at: string } | null;
}

export const TRADEME_LIMITS = [10, 20, 50, 100, 250, 500, 1000];
export const TRADEME_AUTO_LIMITS = [100, 250, 500, 1000];
export const DEFAULT_TRADEME_SETTINGS: TradeMeSettings = { enabled: false, dailyLimit: 20, autoEnabled: false, autoDailyLimit: 1000, autoStopped: null };

export function cleanTradeMeSettings(input: Partial<TradeMeSettings> | null | undefined): TradeMeSettings {
  const v = { ...DEFAULT_TRADEME_SETTINGS, ...(input ?? {}) };
  const stopped = v.autoStopped && typeof v.autoStopped.reason === "string" ? { reason: v.autoStopped.reason.slice(0, 300), at: String(v.autoStopped.at) } : null;
  return {
    enabled: !!v.enabled,
    dailyLimit: TRADEME_LIMITS.includes(Number(v.dailyLimit)) ? Number(v.dailyLimit) : DEFAULT_TRADEME_SETTINGS.dailyLimit,
    autoEnabled: !!v.autoEnabled,
    autoDailyLimit: TRADEME_AUTO_LIMITS.includes(Number(v.autoDailyLimit)) ? Number(v.autoDailyLimit) : DEFAULT_TRADEME_SETTINGS.autoDailyLimit,
    // Turning automatic lookups back on clears the old reason.
    autoStopped: v.autoEnabled ? null : stopped,
  };
}

export async function getTradeMeSettings(db: Pick<Db, "query">): Promise<TradeMeSettings> {
  const r = await db.query(`SELECT value FROM settings WHERE key='trademe'`);
  return cleanTradeMeSettings(r.rows[0]?.value);
}

export async function saveTradeMeSettings(db: Db, input: Partial<TradeMeSettings>, userId: number | null): Promise<TradeMeSettings> {
  const s = cleanTradeMeSettings({ ...(await getTradeMeSettings(db)), ...input });
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('trademe', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(s), userId],
  );
  return s;
}
