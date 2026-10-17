import { loadConfig } from "../server/config.ts";
import { connect, migrate } from "../server/db.ts";

const db = connect(loadConfig().databaseUrl);
await migrate(db);
console.log("BidScout schema is up to date.");
await db.end();
