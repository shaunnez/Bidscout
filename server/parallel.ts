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

export class ParallelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class Parallel implements ParallelClient {
  constructor(
    private apiKey: string,
    private opts: { fetch?: FetchFn; base?: string } = {},
  ) {}

  async page(url: string): Promise<ExtractResult> {
    const fetchFn = this.opts.fetch ?? ((u, i) => fetch(u, i));
    const res = await fetchFn(`${this.opts.base ?? "https://api.parallel.ai"}/v1/extract`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      // The whole page from a fresh fetch (no older cached copy), not excerpts.
      body: JSON.stringify({ urls: [url], advanced_settings: { full_content: true, fetch_policy: { max_age_seconds: 600, timeout_seconds: 60, disable_cache_fallback: true } } }),
      signal: AbortSignal.timeout(120_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? "the Parallel key was refused" : res.status === 402 ? "the Parallel account is out of credit" : String(json.error?.message ?? `HTTP ${res.status}`);
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
