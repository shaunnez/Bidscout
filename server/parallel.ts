/**
 * A small client for Parallel's Extract API (https://docs.parallel.ai, POST /v1/extract): one
 * page as markdown, fetched from Parallel's servers, not ours. Reads Trade Me's results pages for
 * the Trade Me prices button (first, before Firecrawl and Chromium) and for automatic prices.
 */

export interface ExtractResult {
  markdown: string;
  title: string | null;
  /** Parallel couldn't fetch the page: its error type and the site's HTTP status, if any. */
  error: { type: string; status: number | null } | null;
  warnings: string[];
}

export interface ParallelClient {
  page(url: string): Promise<ExtractResult>;
}

export interface SearchHit {
  url: string;
  title: string | null;
  /** Words from the page, as Parallel's index has them (markdown). */
  excerpts: string[];
}

/** Parallel's Search API: web results with excerpts of each page, without reading the pages again. */
export interface ParallelSearch {
  search(objective: string, queries: string[], opts?: { maxResults?: number; excludeDomains?: string[]; country?: string }): Promise<SearchHit[]>;
}

export class ParallelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class Parallel implements ParallelClient, ParallelSearch {
  constructor(
    private apiKey: string,
    private opts: { fetch?: FetchFn; base?: string; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async search(objective: string, queries: string[], opts: { maxResults?: number; excludeDomains?: string[]; country?: string } = {}): Promise<SearchHit[]> {
    const fetchFn = this.opts.fetch ?? ((u, i) => fetch(u, i));
    const res = await fetchFn(`${this.opts.base ?? "https://api.parallel.ai"}/v1/search`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        objective,
        search_queries: queries,
        mode: "fast",
        advanced_settings: {
          max_results: opts.maxResults ?? 10,
          ...(opts.country ? { location: opts.country } : {}),
          ...(opts.excludeDomains?.length ? { source_policy: { exclude_domains: opts.excludeDomains } } : {}),
          excerpt_settings: { max_chars_per_result: 1500 },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? "the Parallel key was refused" : res.status === 402 ? "the Parallel account is out of credit" : res.status === 429 ? "too many requests (rate limit)" : String(json.error?.message ?? `HTTP ${res.status}`);
      throw new ParallelError(`Parallel: ${why}`, res.status);
    }
    return ((json.results ?? []) as Array<Record<string, any>>)
      .filter((r) => typeof r.url === "string")
      .map((r) => ({ url: String(r.url), title: typeof r.title === "string" ? r.title : null, excerpts: Array.isArray(r.excerpts) ? r.excerpts.map(String) : [] }));
  }

  async page(url: string): Promise<ExtractResult> {
    const fetchFn = this.opts.fetch ?? ((u, i) => fetch(u, i));
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let res: Response;
    let json: Record<string, any>;
    // Parallel allows 600 requests a minute: on 429, wait (Retry-After, at most 30 s) and try twice more.
    for (let attempt = 1; ; attempt++) {
      res = await fetchFn(`${this.opts.base ?? "https://api.parallel.ai"}/v1/extract`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
        // The whole page from a fresh fetch (no older cached copy), not excerpts.
        body: JSON.stringify({ urls: [url], advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600, timeout_seconds: 60, disable_cache_fallback: true } } }),
        signal: AbortSignal.timeout(120_000),
      });
      json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.status !== 429 || attempt >= 3) break;
      const after = Number(res.headers.get("retry-after"));
      await sleep(Math.min(30_000, Number.isFinite(after) && after > 0 ? after * 1000 : 5_000 * attempt));
    }
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? "the Parallel key was refused" : res.status === 402 ? "the Parallel account is out of credit" : res.status === 429 ? "too many requests (rate limit)" : String(json.error?.message ?? `HTTP ${res.status}`);
      throw new ParallelError(`Parallel: ${why}`, res.status);
    }
    const r = (json.results ?? [])[0] as Record<string, any> | undefined;
    const e = (json.errors ?? [])[0] as Record<string, any> | undefined;
    return {
      markdown: String(r?.full_content ?? (Array.isArray(r?.excerpts) ? r.excerpts.join("\n\n") : "")),
      title: typeof r?.title === "string" ? r.title : null,
      error: !r && e ? { type: String(e.error_type ?? "error"), status: typeof e.http_status_code === "number" ? e.http_status_code : null } : null,
      warnings: ((json.warnings ?? []) as Array<Record<string, unknown>>).map((w) => String(w.message ?? w.type ?? "")).filter(Boolean),
    };
  }
}
