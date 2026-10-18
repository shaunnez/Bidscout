import { appContext } from "./context.ts";
import { runAutoPriceLoop } from "./autoprice.ts";
import { parallelSearcher } from "./tmsearch.ts";
import { scheduleTick } from "./schedule.ts";
import { reparseStale } from "./scan/reparse.ts";
import { workOneRun } from "./scan/runner.ts";

/** Works queued scans one at a time, and queues scheduled ones (Settings → Scans). */
export async function runWorkerLoop(deps: Awaited<ReturnType<typeof appContext>>, signal?: AbortSignal) {
  const log = (m: string) => console.log(`[worker] ${new Date().toISOString()} ${m}`);
  // After an upgrade that changes the parser, re-read stored listings before any scan runs.
  try {
    const n = await reparseStale(deps.db, { onProgress: (d, t) => d === t && log(`re-parsed ${t} lots with the new parser`) });
    if (!n) log("all lots parsed with the current parser");
  } catch (e) {
    log(`re-parse error: ${(e as Error).message}`);
  }
  // Automatic prices for open lots (Trade Me, and new prices for products), through Parallel (Settings turns them on).
  if (deps.parallel) void runAutoPriceLoop({ db: deps.db, parallel: parallelSearcher(deps.parallel), search: deps.parallel, signal }, log);
  let lastTick = 0;
  while (!signal?.aborted) {
    if (Date.now() - lastTick > 60_000) {
      lastTick = Date.now();
      const started = await scheduleTick(deps.db).catch((e) => {
        log(`schedule error: ${(e as Error).message}`);
        return null;
      });
      if (started) log(`scheduled ${started} scan queued`);
    }
    const worked = await workOneRun({ ...deps, log }).catch((e) => {
      log(`error: ${(e as Error).stack ?? e}`);
      return false;
    });
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = await appContext();
  console.log("[worker] waiting for scans (start one from the UI or with npm run scan)");
  await runWorkerLoop(deps);
}
