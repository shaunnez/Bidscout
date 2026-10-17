import path from "node:path";

export interface Config {
  databaseUrl: string;
  dataDir: string;
  contact: string;
  minIntervalMs: number;
  apiPort: number;
  baseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const minInterval = Number(env.BIDSCOUT_MIN_INTERVAL_MS ?? 1200);
  return {
    databaseUrl:
      env.BIDSCOUT_DATABASE_URL ?? "postgres://bidscout:bidscout@localhost:5432/bidscout",
    dataDir: path.resolve(env.BIDSCOUT_DATA_DIR ?? ".data"),
    contact: (env.BIDSCOUT_CONTACT ?? "").trim(),
    // Never faster than one request a second, whatever the environment says.
    minIntervalMs: Number.isFinite(minInterval) ? Math.max(1000, minInterval) : 1200,
    apiPort: Number(env.BIDSCOUT_API_PORT ?? 4328),
    baseUrl: "https://www.number8.bid",
  };
}
