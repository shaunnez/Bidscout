import assert from "node:assert/strict";
import test from "node:test";
import { Number8Transport, RequestGate, StopRunError, retryAfterMs } from "../../server/transport.ts";

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

test("concurrency: at most N in flight, starts spaced 300 ms+, and a slow reply drops to one at a time", async () => {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let hold = true;
  const targets = [0]; // the first request starts straight away
  const held: Array<() => void> = [];
  const t = new Number8Transport({
    baseUrl: "https://example.test", concurrency: 4, jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    onWait: (ms, why) => { if (why === "pacing") targets.push(clock + ms); },
    fetch: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (hold) await new Promise<void>((r) => held.push(r));
      inFlight--;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(t.parallelism, 4);
  const all = Array.from({ length: 6 }, (_, i) => t.get(`/api/p${i}`));
  for (let i = 0; i < 50 && held.length < 4; i++) await new Promise((r) => setImmediate(r));
  assert.equal(held.length, 4, "four in flight");
  assert.equal(maxInFlight, 4);
  const first = targets.slice(0, 4);
  for (let i = 1; i < first.length; i++) assert.ok(first[i]! - first[i - 1]! >= 300, `start spacing in ${first.join(",")}`);
  clock += 5000; // these replies took 5 s: slow
  hold = false;
  held.splice(0).forEach((r) => r());
  await Promise.all(all);
  assert.equal(t.parallelism, 1, "slow replies drop to one at a time");
  assert.equal(maxInFlight, 4);
});

test("concurrency: a 429 also drops to one at a time", async () => {
  const { t } = harnessWith(4, [json({}, 429, { "retry-after": "5" }), json({ ok: 1 })]);
  await t.get("/api/x");
  assert.equal(t.parallelism, 1);
});

function harnessWith(concurrency: number, responses: Array<() => Response>) {
  let clock = 0;
  const t = new Number8Transport({
    baseUrl: "https://example.test", concurrency, jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => responses.shift()!(),
  });
  return { t };
}

test("a shared gate caps requests across transports (a refresh during a scan takes a scan slot)", async () => {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const held: Array<() => void> = [];
  const gate = new RequestGate();
  const opts = {
    baseUrl: "https://example.test", jitterMs: 0, random: () => 0, now: () => clock, gate,
    sleep: async (ms: number) => { clock += ms; },
    fetch: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => held.push(r));
      inFlight--;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  };
  const scan = new Number8Transport({ ...opts, concurrency: 2 });
  const refresh = new Number8Transport(opts);
  assert.equal(refresh.parallelism, 2, "a refresh keeps the scan's limit");
  const all = [scan.get("/api/a"), scan.get("/api/b"), refresh.get("/api/c")];
  for (let i = 0; i < 50 && held.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(held.length, 2);
  for (let i = 0; i < 20 && held.length < 3; i++) { held.shift()?.(); await new Promise((r) => setImmediate(r)); }
  while (held.length) { held.shift()!(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(all);
  assert.equal(maxInFlight, 2, "never more than the shared limit");
});

test("after a 429, the retry waits for requests still in flight and goes one at a time", async () => {
  let clock = 0;
  let inFlight = 0;
  const startedWith: number[] = [];
  let slowDone: () => void = () => {};
  let n = 0;
  const t = new Number8Transport({
    baseUrl: "https://example.test", concurrency: 2, jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async (url) => {
      startedWith.push(inFlight);
      inFlight++;
      try {
        if (String(url).endsWith("/slow")) await new Promise<void>((r) => (slowDone = r));
        else if (n++ === 0) return new Response("{}", { status: 429, headers: { "retry-after": "5" } });
        return new Response("{}", { headers: { "content-type": "application/json" } });
      } finally {
        inFlight--;
      }
    },
  });
  const slow = t.get("/api/slow");
  const fast = t.get("/api/fast");
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(startedWith.length, 2, "the retry has not started while /slow is in flight");
  slowDone();
  await Promise.all([slow, fast]);
  assert.equal(startedWith.length, 3);
  assert.equal(startedWith[2], 0, "the retry started alone");
  assert.equal(t.parallelism, 1);
});

test("after a slow-down, quick replies climb back one request at a time, up to the setting", async () => {
  const replies = Array.from({ length: 80 }, () => json({ ok: 1 }));
  let clock = 0;
  let slow = true;
  const t = new Number8Transport({
    baseUrl: "https://example.test", concurrency: 3, jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => {
      if (slow) clock += 4000; // one reply took 4 s
      slow = false;
      clock += 500;
      return replies.shift()!();
    },
  });
  await t.get("/api/first");
  assert.equal(t.parallelism, 1, "a slow reply drops to one");
  for (let i = 0; i < 19; i++) await t.get(`/api/q${i}`);
  assert.equal(t.parallelism, 1, "19 quick replies aren't enough");
  await t.get("/api/q19");
  assert.equal(t.parallelism, 2, "20 in a row add one");
  for (let i = 0; i < 40; i++) await t.get(`/api/r${i}`);
  assert.equal(t.parallelism, 3, "never above the setting");
});

test("a quick challenge page doesn't count towards climbing back", async () => {
  let clock = 0;
  let n = 0;
  const t = new Number8Transport({
    baseUrl: "https://example.test", concurrency: 2, jitterMs: 0, random: () => 0, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetch: async () => {
      n++;
      clock += n === 1 ? 4500 : 500;
      if (n === 21) return new Response("<!doctype html><title>Checking your browser</title>", { headers: { "content-type": "text/html" } });
      return json({ ok: 1 })();
    },
  });
  for (let i = 0; i < 20; i++) await t.get(`/api/q${i}`); // one slow, then 19 quick
  assert.equal(t.parallelism, 1);
  await assert.rejects(t.get("/api/challenge"), StopRunError);
  assert.equal(t.parallelism, 1, "the challenge page was the 20th quick reply but doesn't raise the limit");
});
