import path from "node:path";

export interface Config {
  databaseUrl: string;
  dataDir: string;
  contact: string;
  minIntervalMs: number;
  apiPort: number;
  host: string;
  password: string;
  baseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const minInterval = Number(env.BIDSCOUT_MIN_INTERVAL_MS ?? 1200);
  return {
    // DATABASE_URL is what Railway's Postgres provides.
    databaseUrl:
      env.BIDSCOUT_DATABASE_URL ?? env.DATABASE_URL ?? "postgres://bidscout:bidscout@localhost:5432/bidscout",
    dataDir: path.resolve(env.BIDSCOUT_DATA_DIR ?? ".data"),
    contact: (env.BIDSCOUT_CONTACT ?? "").trim(),
    // Never faster than one request a second, whatever the environment says.
    minIntervalMs: Number.isFinite(minInterval) ? Math.max(1000, minInterval) : 1200,
    apiPort: Number(env.PORT ?? env.BIDSCOUT_API_PORT ?? 4328),
    host: env.BIDSCOUT_HOST ?? "127.0.0.1",
    password: env.BIDSCOUT_PASSWORD ?? "",
    baseUrl: "https://www.number8.bid",
  };
}

export const isLoopback = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost";
