/**
 * The only way BidScout talks to number8.bid.
 *
 * Consideration rules:
 * - At most `concurrency` requests in flight (1–4, a setting). With one, requests are at
 *   least `minIntervalMs` apart (never under 1s) plus jitter; with more, request starts are
 *   still spaced at least 300 ms apart.
 * - Slow responses slow us down: after a reply that took over 3s, or any 429/503, the
 *   transport drops to one request at a time, and the next gap is twice that reply's time
 *   (capped at 30s), so a busy server gets breathing room. It climbs back one request at a
 *   time, after every 20 quick replies in a row (under 2 s each), up to the scan's setting.
 * - Retries only for failures that can pass: network errors, timeouts, 408/425/5xx.
 *   Backoff 2s, 4s, 8s, 16s (+ jitter), at most `maxRetries` times.
 * - 429 and 503 mean "slow down": wait for Retry-After (default 60s, at most 15 min).
 *   After `maxThrottles` of those in one run the transport stops the run instead of pushing on.
 * - An HTML page where JSON was expected (a challenge or login page) stops the run.
 * - Only public API paths; robots.txt's /admin and /myaccount are refused outright.
 * - Every transport in a process shares one `RequestGate`, so a manual refresh during a scan
 *   takes one of the scan's slots and keeps the same spacing, rather than adding to them.
 */

export interface FetchResult {
  method: string;
  url: string;
  requestBody: string | null;
  status: number;
  body: Buffer;
  elapsedMs: number;
  attempts: number;
}

export interface TransportStats {
  requests: number;
  retries: number;
  throttles: number;
}

export class StopRunError extends Error {
  constructor(
    message: string,
    readonly reason: "throttled" | "challenge" | "blocked" | "aborted",
  ) {
    super(message);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

export interface Transport {
  get(path: string): Promise<FetchResult>;
  post(path: string, form: Record<string, string | number>): Promise<FetchResult>;
  stats: TransportStats;
  /** How many requests callers may usefully start at once right now. */
  readonly parallelism: number;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  contact?: string;
  minIntervalMs?: number;
  /** Requests in flight at once, 1–4. */
  concurrency?: number;
  jitterMs?: number;
  maxRetries?: number;
  maxThrottles?: number;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: FetchFn;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  signal?: AbortSignal;
  onWait?: (ms: number, why: string) => void;
  /** Shared slots and spacing. Without one, the transport gets its own. */
  gate?: RequestGate;
}

/** Closest two request starts may be when running more than one at a time. */
export const MIN_PARALLEL_SPACING_MS = 300;
/** Replies quicker than this count towards climbing back after a slow-down... */
export const QUICK_REPLY_MS = 2000;
/** ...and this many in a row add one request at a time. */
export const QUICK_TO_CLIMB = 20;

const ALLOWED = /^\/(api|auxiliary)\//;
const DISALLOWED = /^\/(admin|myaccount)(\/|$)/i;
const RETRYABLE = new Set([408, 425, 500, 502, 504, 520, 521, 522, 523, 524]);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new StopRunError("Run was stopped", "aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new StopRunError("Run was stopped", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function retryAfterMs(header: string | null, now: number): number {
  const fallback = 60_000;
  if (!header) return fallback;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(Math.max(ms, 5_000), 15 * 60_000);
}

/**
 * Request slots and start spacing shared by every transport in a process. A scan sets the
 * limit when it starts (its concurrency setting); anything else, such as a manual refresh,
 * uses whatever limit is current. A slow reply or a 429/503 drops it to one for everyone; a run
 * of quick replies raises it again, one at a time, up to the setting.
 */
export class RequestGate {
  limit = 1;
  /** The scan's setting: the most `limit` climbs back to. */
  ceiling = 1;
  inFlight = 0;
  nextAt = 0;
  private quickInARow = 0;
  private waiting: Array<() => void> = [];

  configure(concurrency: number) {
    this.limit = this.ceiling = Math.min(4, Math.max(1, Math.round(concurrency)));
    this.quickInARow = 0;
  }

  slowDown() {
    this.limit = 1;
    this.quickInARow = 0;
  }

  /** A reply's time: quick ones in a row raise the limit by one, up to the setting. */
  replied(elapsedMs: number) {
    if (elapsedMs >= QUICK_REPLY_MS) {
      this.quickInARow = 0;
      return;
    }
    if (++this.quickInARow < QUICK_TO_CLIMB || this.limit >= this.ceiling) return;
    this.quickInARow = 0;
    this.limit++;
    this.waiting.shift()?.();
  }

  /** No request may start before `at`. */
  holdUntil(at: number) {
    this.nextAt = Math.max(this.nextAt, at);
  }

  async acquire() {
    while (this.inFlight >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
  }

  release() {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}

export class Number8Transport implements Transport {
  readonly stats: TransportStats = { requests: 0, retries: 0, throttles: 0 };
  private gate: RequestGate;
  private o: Required<Omit<TransportOptions, "signal" | "onWait" | "contact" | "concurrency" | "gate">> &
    Pick<TransportOptions, "signal" | "onWait" | "contact">;

  constructor(opts: TransportOptions) {
    this.o = {
      minIntervalMs: 1200,
      jitterMs: 400,
      maxRetries: 4,
      maxThrottles: 3,
      timeoutMs: 45_000,
      maxBytes: 20 * 1024 * 1024,
      fetch: (url, init) => fetch(url, init),
      sleep: defaultSleep,
      now: () => Date.now(),
      random: Math.random,
      ...opts,
    };
    this.o.minIntervalMs = Math.max(1000, this.o.minIntervalMs);
    this.gate = opts.gate ?? new RequestGate();
    // A shared gate keeps its limit unless this transport brings one (a scan starting).
    if (!opts.gate || opts.concurrency !== undefined) this.gate.configure(opts.concurrency ?? 1);
  }

  get parallelism() {
    return this.gate.limit;
  }

  /** Reserves the next start time, so concurrent callers are spaced out. */
  private reserveStart(): number {
    const g = this.gate;
    const at = Math.max(this.o.now(), g.nextAt);
    const spacing = g.limit > 1 ? Math.max(MIN_PARALLEL_SPACING_MS, Math.floor(this.o.minIntervalMs / g.limit)) : 0;
    g.nextAt = at + spacing;
    return at - this.o.now();
  }

  get userAgent() {
    const contact = this.o.contact ? `; contact ${this.o.contact}` : "";
    return `BidScout/0.1 (personal deal research, permission from number 8 solutions; 1 req/s${contact})`;
  }

  get(path: string) {
    return this.request("GET", path, null);
  }

  post(path: string, form: Record<string, string | number>) {
    const body = new URLSearchParams(
      Object.entries(form).map(([k, v]) => [k, String(v)]),
    ).toString();
    return this.request("POST", path, body);
  }

  private async wait(ms: number, why: string) {
    if (ms <= 0) return;
    this.o.onWait?.(ms, why);
    await this.o.sleep(ms, this.o.signal);
  }

  private gap(elapsedMs: number) {
    const slow = elapsedMs > 3000 ? Math.min(elapsedMs * 2, 30_000) : 0;
    return Math.max(this.o.minIntervalMs, slow) + Math.floor(this.o.random() * this.o.jitterMs);
  }

  private async request(method: string, path: string, body: string | null): Promise<FetchResult> {
    if (DISALLOWED.test(path) || !ALLOWED.test(path))
      throw new StopRunError(`Refusing to fetch ${path}: not a public API path`, "blocked");
    await this.gate.acquire();
    try {
      return await this.attempt(method, path, body);
    } finally {
      this.gate.release();
    }
  }

  private async attempt(method: string, path: string, body: string | null): Promise<FetchResult> {
    const url = this.o.baseUrl + path;
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.wait(this.reserveStart(), "pacing");
      if (this.o.signal?.aborted) throw new StopRunError("Run was stopped", "aborted");
      const started = this.o.now();
      this.stats.requests++;
      let res: Response | null = null;
      let failure: unknown = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
      const onAbort = () => ctl.abort();
      this.o.signal?.addEventListener("abort", onAbort, { once: true });
      let buf: Buffer | null = null;
      try {
        res = await this.o.fetch(url, {
          method,
          body,
          signal: ctl.signal,
          redirect: "manual",
          headers: {
            "User-Agent": this.userAgent,
            // The API answers in XML if Accept mentions XML at all.
            Accept: "application/json, text/plain, */*",
            ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
        });
        buf = await this.readCapped(res);
      } catch (e) {
        failure = e;
      } finally {
        clearTimeout(timer);
        this.o.signal?.removeEventListener("abort", onAbort);
      }
      if (this.o.signal?.aborted) throw new StopRunError("Run was stopped", "aborted");
      const elapsedMs = this.o.now() - started;
      if (elapsedMs > 3000) this.gate.slowDown();
      if (this.gate.limit === 1) this.gate.holdUntil(this.o.now() + this.gap(elapsedMs));

      const canRetry = attempt <= this.o.maxRetries;
      if (failure || !res || !buf) {
        if (!canRetry) throw failure ?? new Error(`No response from ${url}`);
        await this.backoff(attempt, `network error: ${(failure as Error)?.message ?? "no response"}`);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        this.stats.throttles++;
        this.gate.slowDown();
        if (this.stats.throttles >= this.o.maxThrottles)
          throw new StopRunError(
            `number8.bid asked us to slow down ${this.stats.throttles} times; stopping this run`,
            "throttled",
          );
        const ms = retryAfterMs(res.headers.get("retry-after"), this.o.now());
        this.stats.retries++;
        // Nobody starts until the wait is over, and this request gives up its slot: the retry
        // queues again, so it waits for requests still in flight before going one at a time.
        this.gate.holdUntil(this.o.now() + ms);
        this.gate.release();
        try {
          await this.wait(ms, `HTTP ${res.status}: waiting as asked`);
        } finally {
          await this.gate.acquire();
        }
        continue;
      }
      if (RETRYABLE.has(res.status)) {
        if (!canRetry) throw new HttpError(res.status, url);
        await this.backoff(attempt, `HTTP ${res.status}`);
        continue;
      }
      if (res.status >= 300) throw new HttpError(res.status, url);
      this.gate.replied(elapsedMs);
      const type = res.headers.get("content-type") ?? "";
      const head = buf.subarray(0, 200).toString("utf8").trimStart().toLowerCase();
      if (path.startsWith("/api/") && (type.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html")))
        throw new StopRunError(`Expected JSON from ${path} but got a web page (challenge or login?)`, "challenge");
      return { method, url, requestBody: body, status: res.status, body: buf, elapsedMs, attempts: attempt };
    }
  }

  private async backoff(attempt: number, why: string) {
    this.stats.retries++;
    this.gate.replied(Infinity); // a failed attempt breaks a run of quick replies
    const ms = 2000 * 2 ** (attempt - 1) + Math.floor(this.o.random() * 1000);
    await this.wait(ms, `retry ${attempt} after ${why}`);
  }

  private async readCapped(res: Response): Promise<Buffer> {
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > this.o.maxBytes) throw new Error(`Response too large (${len} bytes)`);
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > this.o.maxBytes) throw new Error(`Response over ${this.o.maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
