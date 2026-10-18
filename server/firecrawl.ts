/**
 * A small client for Firecrawl (https://docs.firecrawl.dev, API v2): web search, and reading
 * one page as markdown plus structured JSON. Requests go out from Firecrawl's servers, not ours.
 * One retry on 429/5xx, honouring Retry-After (at most 30 s).
 */

export interface SearchResult {
  url: string;
  title: string | null;
  description: string | null;
}

export interface ScrapeResult {
  markdown: string;
  json: Record<string, unknown> | null;
  statusCode: number | null;
  url: string;
}

export interface FirecrawlClient {
  search(query: string, opts: { limit: number; includeDomains: string[]; country: string }): Promise<{ results: SearchResult[]; credits: number | null }>;
  scrape(url: string, opts: { schema: Record<string, unknown>; prompt: string; maxAgeMs: number }): Promise<ScrapeResult & { credits: number | null }>;
}

export class FirecrawlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class Firecrawl implements FirecrawlClient {
  constructor(
    private apiKey: string,
    private opts: { fetch?: FetchFn; sleep?: (ms: number) => Promise<void>; base?: string } = {},
  ) {}

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const fetchFn = this.opts.fetch ?? ((u, i) => fetch(u, i));
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(`${this.opts.base ?? "https://api.firecrawl.dev/v2"}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Math.min(30_000, Number.isFinite(after) && after > 0 ? after * 1000 : 5_000));
        continue;
      }
      if (!res.ok || json.success === false) {
        const why = res.status === 402 ? "the Firecrawl account is out of credits" : res.status === 401 ? "the Firecrawl key was refused" : String(json.error ?? `HTTP ${res.status}`);
        throw new FirecrawlError(`Firecrawl: ${why}`, res.status);
      }
      return json;
    }
  }

  async search(query: string, opts: { limit: number; includeDomains: string[]; country: string }) {
    const r = await this.post("/search", { query, limit: opts.limit, sources: ["web"], includeDomains: opts.includeDomains, country: opts.country });
    const web = (r.data?.web ?? r.data ?? []) as Array<Record<string, unknown>>;
    return {
      results: web.filter((w) => typeof w.url === "string").map((w) => ({ url: String(w.url), title: (w.title as string) ?? null, description: (w.description as string) ?? null })),
      credits: typeof r.creditsUsed === "number" ? r.creditsUsed : null,
    };
  }

  async scrape(url: string, opts: { schema: Record<string, unknown>; prompt: string; maxAgeMs: number }) {
    const r = await this.post("/scrape", {
      url,
      formats: ["markdown", { type: "json", schema: opts.schema, prompt: opts.prompt }],
      onlyMainContent: true,
      maxAge: opts.maxAgeMs,
      location: { country: "NZ", languages: ["en-NZ"] },
      timeout: 60_000,
    });
    const d = (r.data ?? {}) as Record<string, any>;
    return {
      markdown: String(d.markdown ?? ""),
      json: (d.json ?? d.extract ?? null) as Record<string, unknown> | null,
      statusCode: typeof d.metadata?.statusCode === "number" ? d.metadata.statusCode : null,
      url: String(d.metadata?.url ?? d.metadata?.sourceURL ?? url),
      credits: typeof r.creditsUsed === "number" ? r.creditsUsed : null,
    };
  }
}
