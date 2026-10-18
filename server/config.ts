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
  /** Firecrawl API key for Trade Me price lookups (server/trademe.ts); empty turns them off. */
  firecrawlKey: string;
  /** Firecrawl's API address; set FIRECRAWL_API_URL for a self-hosted Firecrawl. */
  firecrawlUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A variable set to an empty string counts as unset (hosting dashboards make these easy to create).
  const get = (k: string) => env[k]?.trim() || undefined;
  const minInterval = Number(get("BIDSCOUT_MIN_INTERVAL_MS") ?? 1200);
  return {
    // DATABASE_URL is what Railway's Postgres provides.
    databaseUrl: get("BIDSCOUT_DATABASE_URL") ?? get("DATABASE_URL") ?? "postgres://bidscout:bidscout@localhost:5432/bidscout",
    dataDir: path.resolve(get("BIDSCOUT_DATA_DIR") ?? ".data"),
    contact: get("BIDSCOUT_CONTACT") ?? "",
    // Never faster than one request a second, whatever the environment says.
    minIntervalMs: Number.isFinite(minInterval) ? Math.max(1000, minInterval) : 1200,
    apiPort: Number(get("PORT") ?? get("BIDSCOUT_API_PORT") ?? 4328),
    host: get("BIDSCOUT_HOST") ?? "127.0.0.1",
    password: env.BIDSCOUT_PASSWORD ?? "",
    baseUrl: "https://www.number8.bid",
    firecrawlKey: get("FIRECRAWL_API_KEY") ?? "",
    firecrawlUrl: get("FIRECRAWL_API_URL") ?? "https://api.firecrawl.dev/v2",
  };
}

export const isLoopback = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost";
