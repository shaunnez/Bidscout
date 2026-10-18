import { appContext } from "./context.ts";
import { scheduleTick } from "./schedule.ts";
import { workOneRun } from "./scan/runner.ts";

/** Works queued scans one at a time, and queues scheduled ones (Settings → Scans). */
export async function runWorkerLoop(deps: Awaited<ReturnType<typeof appContext>>, signal?: AbortSignal) {
  const log = (m: string) => console.log(`[worker] ${new Date().toISOString()} ${m}`);
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
