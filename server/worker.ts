import { appContext } from "./context.ts";
import { workOneRun } from "./scan/runner.ts";

/** Waits for queued scans and works them one at a time. Scans only start when someone asks. */
export async function runWorkerLoop(deps: Awaited<ReturnType<typeof appContext>>, signal?: AbortSignal) {
  const log = (m: string) => console.log(`[worker] ${new Date().toISOString()} ${m}`);
  while (!signal?.aborted) {
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
