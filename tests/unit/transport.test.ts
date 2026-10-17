import assert from "node:assert/strict";
import test from "node:test";
import { Number8Transport, StopRunError, retryAfterMs } from "../../server/transport.ts";

function harness(responses: Array<() => Response | Promise<Response>>) {
  let clock = 1_000_000;
  const waits: Array<{ ms: number; why: string }> = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const t = new Number8Transport({
    baseUrl: "https://example.test",
    minIntervalMs: 1200,
    jitterMs: 0,
    random: () => 0,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onWait: (ms, why) => waits.push({ ms, why }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next();
    },
  });
  return { t, waits, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("requests are paced at least the minimum interval apart and identify themselves", async () => {
  const { t, waits, calls } = harness([json({ a: 1 }), json({ a: 2 })]);
  await t.get("/api/one");
  await t.get("/api/two");
  assert.equal(waits.filter((w) => w.why === "pacing").length, 1);
  assert.ok(waits[0]!.ms >= 1200);
  assert.match(String((calls[0]!.init.headers as Record<string, string>)["User-Agent"]), /BidScout/);
});

test("server errors are retried with growing backoff, then succeed", async () => {
  const { t, waits } = harness([json({}, 502), json({}, 500), json({ ok: true })]);
  const r = await t.get("/api/x");
  assert.equal(r.attempts, 3);
  assert.equal(t.stats.retries, 2);
  const backoffs = waits.filter((w) => w.why.startsWith("retry")).map((w) => w.ms);
  assert.deepEqual(backoffs, [2000, 4000]);
});

test("network errors are retried, and give up after the retry limit", async () => {
  const boom = () => {
    throw new TypeError("fetch failed");
  };
  const { t } = harness([boom, boom, boom, boom, boom]);
  await assert.rejects(t.get("/api/x"), /fetch failed/);
  assert.equal(t.stats.requests, 5);
});

test("429 waits for Retry-After, and repeated slow-down requests stop the run", async () => {
  const { t, waits } = harness([json({}, 429, { "retry-after": "120" }), json({ ok: 1 })]);
  await t.get("/api/x");
  assert.ok(waits.some((w) => w.ms === 120_000 && /waiting as asked/.test(w.why)));
  const h2 = harness([json({}, 503), json({}, 429), json({}, 429), json({ ok: 1 })]);
  await assert.rejects(h2.t.get("/api/x"), (e: unknown) => e instanceof StopRunError && e.reason === "throttled");
});

test("an HTML page from the API stops the run (challenge or login)", async () => {
  const { t } = harness([() => new Response("<!doctype html><title>Just a moment</title>", { status: 200, headers: { "content-type": "text/html" } })]);
  await assert.rejects(t.get("/api/x"), (e: unknown) => e instanceof StopRunError && e.reason === "challenge");
});

test("robots.txt-disallowed and non-API paths are refused without a request", async () => {
  const { t, calls } = harness([]);
  await assert.rejects(t.get("/myaccount/shoppingcart"), (e: unknown) => e instanceof StopRunError && e.reason === "blocked");
  await assert.rejects(t.get("/admin"), StopRunError);
  await assert.rejects(t.get("/login"), StopRunError);
  assert.equal(calls.length, 0);
});

test("4xx other than 408/425/429 is not retried", async () => {
  const { t } = harness([json({}, 404)]);
  await assert.rejects(t.get("/api/x"), /HTTP 404/);
  assert.equal(t.stats.requests, 1);
});

test("slow replies widen the next gap", async () => {
  let clock = 0;
  const waits: number[] = [];
  const t = new Number8Transport({
    baseUrl: "https://example.test", jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; }, onWait: (ms) => waits.push(ms),
    fetch: async () => { clock += 6000; return new Response("{}", { headers: { "content-type": "application/json" } }); },
  });
  await t.get("/api/a");
  await t.get("/api/b");
  assert.equal(waits[0], 12_000);
});

test("Retry-After parsing has sane bounds", () => {
  assert.equal(retryAfterMs(null, 0), 60_000);
  assert.equal(retryAfterMs("1", 0), 5_000);
  assert.equal(retryAfterMs("99999", 0), 15 * 60_000);
});
