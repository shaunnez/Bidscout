import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import pg from "pg";
import { loadConfig } from "../server/config.ts";

/** Creates a throwaway database, runs tests/db/*.test.ts against it, then drops it. */
const base = new URL(process.env.E2E_POSTGRES_ADMIN_URL?.trim() || loadConfig().databaseUrl);
const name = `bidscout_test_${crypto.randomBytes(4).toString("hex")}`;
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(base.toString());
url.pathname = `/${name}`;
let code = 1;
try {
  const r = spawnSync("npx", ["tsx", "--test", "--test-concurrency=1", "tests/db/pipeline.test.ts", "tests/db/trademe.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, BIDSCOUT_TEST_DATABASE_URL: url.toString() },
  });
  code = r.status ?? 1;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
process.exit(code);
