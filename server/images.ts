/**
 * Fetches lot photos from number8.bid's image CDN for reading specs (one at a time, at least
 * 1 s apart, 10 MB cap, images only, two retries). Only the CDN host the site's own pages use.
 */
export const N8_IMAGE_HOSTS = new Set(["d2mkoraxgm9izf.cloudfront.net"]);
// image/mpo is the multi-picture JPEG some phone cameras produce; it decodes as a JPEG.
const TYPES = /^image\/(jpeg|pjpeg|mpo|png|webp|gif)$/;

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}

export class ImageFetcher {
  private nextAt = 0;
  constructor(
    private opts: {
      fetch?: (url: string, init: RequestInit) => Promise<Response>;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      userAgent?: string;
      minIntervalMs?: number;
    } = {},
  ) {}

  async get(url: string): Promise<FetchedImage> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !N8_IMAGE_HOSTS.has(u.host)) throw new Error(`Not a number8 image URL: ${u.host}`);
    const fetchFn = this.opts.fetch ?? ((a, b) => fetch(a, b));
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? (() => Date.now());
    for (let attempt = 1; ; attempt++) {
      const wait = this.nextAt - now();
      if (wait > 0) await sleep(wait);
      this.nextAt = now() + (this.opts.minIntervalMs ?? 1000);
      try {
        const res = await fetchFn(url, { headers: { "User-Agent": this.opts.userAgent ?? "BidScout/0.1 (lot photo reading)" }, signal: AbortSignal.timeout(30_000) });
        if (res.status >= 500 && attempt < 3) {
          await sleep(2000 * attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (!TYPES.test(contentType)) throw new Error(`Not an image (${contentType})`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > 10 * 1024 * 1024) throw new Error("Image over 10 MB");
        return { body, contentType };
      } catch (e) {
        if (attempt >= 3 || (e as Error).message.startsWith("HTTP 4") || (e as Error).message.startsWith("Not an image")) throw e;
        await sleep(2000 * attempt);
      }
    }
  }
}
