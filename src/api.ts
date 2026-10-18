export interface Lot {
  id: number;
  auction_id: number;
  lot_number: string | null;
  title: string;
  category: string | null;
  quantity: number | null;
  item_url: string | null;
  thumb_url: string | null;
  city: string | null;
  ends_at: string | null;
  current_bid: number | null;
  bid_count: number | null;
  starting_bid: number | null;
  buyer_premium: number | null;
  status: "open" | "closed";
  final_bid: number | null;
  closed_at: string | null;
  device_type: string | null;
  is_it: boolean;
  make: string | null;
  model: string | null;
  cpu: string | null;
  cpu_family: string | null;
  cpu_gen: number | null;
  ram_gb: number | null;
  storage_gb: number | null;
  storage_type: string | null;
  screen_in: number | null;
  gpu: string | null;
  os: string | null;
  faults: string[];
  major_fault: boolean;
  image_count: number;
  auction_title: string;
  price: number | null;
  all_in: number | null;
  premium_rate: number;
  gst_rate: number;
  gst_assumed: boolean;
  comp_n: number | null;
  comp_p25: number | null;
  comp_p50: number | null;
  comp_p75: number | null;
  comp_kind: "machine" | "similar" | "spec" | null;
  expected_low: number | null;
  expected_mid: number | null;
  expected_high: number | null;
  spec_score: number | null;
  score_parts: Array<{ label: string; points: number }> | null;
  score_incomplete: boolean;
  photo_fields: string[];
  value_index: number | null;
  /** Trade Me (open lots): relevant listings with a buy-now price, their median and lowest, when read. */
  tm_n: number | null;
  tm_mid: number | null;
  tm_low: number | null;
  tm_at: string | null;
  /** All-in now, the expected all-in, and the one compared (expected, else now), as % of the Trade Me median. */
  tm_pct_now: number | null;
  tm_pct_expected: number | null;
  tm_pct: number | null;
  /** New price in NZ (open lots): shops found, their median, when; the all-in now/expected as % of it. */
  new_n: number | null;
  new_mid: number | null;
  new_at: string | null;
  new_pct_now: number | null;
  new_pct_expected: number | null;
  new_pct: number | null;
  /** A wholesale or RRP price written in the title, the words it came from and where. */
  list_price: number | null;
  list_quote: string | null;
  list_rrp: boolean | null;
  list_start: number | null;
  list_pct_now: number | null;
  /** Against outside prices, as a share of the opportunity line: 1 or less is an opportunity. */
  opp_score: number | null;
  spec_n: number | null;
  spec_p50: number | null;
  watched: boolean;
  max_all_in: number | null;
  watcher_count: number;
  friend_high_bidder: string | null;
  friend_bidders: number;
  first_seen: string;
}

export interface Facet {
  value: string;
  n: number;
}

export interface SearchResult {
  total: number;
  page: number;
  perPage: number;
  items: Lot[];
  facets: { category: Facet[]; type: Facet[]; make: Facet[]; cpu: Facet[] };
}

export interface SpecValue {
  id: number;
  field: string;
  value: string;
  num: number | null;
  source: string;
  quote: string;
  method: string;
}

export interface LotDetail {
  lot: Lot & {
    description: string;
    images: string[];
    bid_history: Array<{ bid: number; at: string | null }>;
    outcome_snapshot_id: number | null;
    outcome_path: string | null;
    auction_url: string | null;
    photo_ocr_at: string | null;
    photos_read: number;
    auction_city: string | null;
    auction_address: string | null;
    auction_lots_close_at: string | null;
    auction_instructions: string | null;
    auction_ends_at: string | null;
    detail_read_at: string | null;
  };
  specs: SpecValue[];
  observations: Array<{ id: number; observed_at: string; current_bid: number | null; bid_count: number | null; ends_at: string | null; status: string; snapshot_id: number; snapshot_path: string }>;
  terms: { premium_rate: number | null; gst_rate: number | null; payment_due: string | null } | null;
  revisions: Array<{ id: number; created_at: string }>;
  watchers: Array<{ id: number; display_name: string; added_at: string }>;
  photoValues: Array<{ id: number; field: string; value: string; quote: string; confidence: number; image_url: string }>;
  tradeMe: TradeMeState;
  newPrice: { available: boolean; reason: string | null; latest: TradeMeLookup | null };
  friendBids: Array<{ user_id: number; display_name: string; kind: "high_bidder" | "bid"; amount: number | null; bid_at: string | null; seen_at: string }>;
  comps: Array<{ id: number; title: string; final_bid: number; all_in: number; closed_at: string; faults: string[]; auction_title: string; item_url: string | null; thumb_url: string | null; bid_count: number | null; outcome_snapshot_id: number; outcome_path: string }>;
}

export interface PhotoSummary {
  available: boolean;
  ocrVersion: string;
  minConfidence: number;
  waiting: number;
  lots_read: number;
  photos_read: number;
  last_read_at: string | null;
  lots_with_values: number;
  lots_using: number;
  recent: Array<{ id: number; title: string; thumb_url: string | null; status: string; photo_fields: string[]; read_at: string; photos: number; found: Array<{ field: string; value: string; confidence: number }> }>;
}

export interface TradeMeItem {
  id: number;
  url: string;
  listing_id: string;
  title: string | null;
  status: "open" | "closed" | "sold" | null;
  price: number | null;
  price_kind: "sold" | "current_bid" | "buy_now" | "asking" | "starting" | null;
  buy_now: number | null;
  buy_now_excerpt: string | null;
  buy_now_start: number | null;
  buy_now_end: number | null;
  reserve: "met" | "not met" | "none" | null;
  bid_count: number | null;
  condition: string | null;
  closes: string | null;
  location: string | null;
  excerpt: string | null;
  quote_start: number | null;
  quote_end: number | null;
  verified: boolean;
  page_sha256: string;
  fetched_at: string;
  /** The Trade Me results page the quote came from, for search cards; null when it came from the listing page itself. */
  source_url: string | null;
}

export interface TradeMeLookup {
  id: number;
  query: string;
  status: "ok" | "failed" | "running";
  error: string | null;
  searched: number;
  found: number;
  candidates: number | null;
  blocked: number | null;
  /** "trademe-search:parallel", "trademe-search:chromium", "trademe-search:firecrawl", "web-search" or "links"; null on old lookups (web search). */
  method: string | null;
  /** The web searches run; empty for pasted links; null for lookups saved before this was recorded (web searches). */
  queries: string[] | null;
  created_at: string;
  items: TradeMeItem[];
  cached?: boolean;
}

export interface TradeMeState {
  available: boolean;
  reason: string | null;
  used: number;
  dailyLimit: number;
  /** Pasted listing links can be read (they need Firecrawl). */
  pasteLinks: boolean;
  latest: TradeMeLookup | null;
}

export interface Auction {
  id: number;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  lots_close_at: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
  postcode: string | null;
  instructions: string | null;
  url: string | null;
  thumb_url: string | null;
  item_count: number | null;
  live: boolean;
  lots: number;
  it_lots: number;
  open_lots: number;
  lots_with_bids: number;
  bids: number;
  next_close: string | null;
  sold: number;
  sold_total: number | null;
  top_final: number | null;
  last_closed: string | null;
  bid_total: number | null;
  friend_high: number;
  group_favourites: number;
  my_favourites: number;
  top_categories: string[] | null;
  thumbs: string[] | null;
  premium_rate: number | null;
  gst_rate: number | null;
  payment_due: string | null;
  good_value: number;
}

export interface SnapshotMeta {
  id: number;
  method: string;
  url: string;
  request: string | null;
  fetchedAt: string;
  sha256: string;
  originalSha256: string;
  redactions: string[];
}

export type Citation =
  | { kind: "spec"; field: string; value: string; method: string; source: string; path: string; text: string; start: number; end: number; quote: string; verified: boolean; lotUrl?: string; snapshot: SnapshotMeta }
  | { kind: "field"; path: string; value: unknown; context: Record<string, unknown> | null; snapshot: SnapshotMeta }
  | { kind: "external"; site: string; url: string; listingUrl?: string; value: string; excerpt: string; start: number; end: number; fetchedAt: string; sha256: string; where: string }
  | { kind: "photo"; field: string; value: string; quote: string; confidence: number; boxes: Array<[number, number, number, number]>; width: number | null; height: number | null; image: string; imageUrl: string; sha256: string; ocr: string; readAt: string; lotUrl: string | null };

export interface ScanRun {
  id: number;
  kind: "live" | "history";
  photos_read: number;
  trigger: "manual" | "schedule" | string | null;
  state: string;
  phase: string;
  options: Record<string, unknown>;
  requests: number;
  retries: number;
  throttles: number;
  pages_read: number;
  pages_total: number | null;
  auctions_seen: number;
  auctions_queued: number;
  auctions_listed: number;
  lots_seen: number;
  lots_new: number;
  lots_changed: number;
  observations: number;
  lots_closed: number;
  details_total: number;
  details_read: number;
  specs_parsed: number;
  errors: number;
  last_error: string | null;
  stop_reason: string | null;
  ticker: Array<{ at: string; text: string }>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cursor: { page?: number };
}

export interface Summary {
  live: number;
  live_it: number;
  closed: number;
  sold: number;
  live_auctions: number;
  watching: number;
  last_live_scan: string | null;
  last_history_scan: string | null;
}

/** Called when the session has ended, so the app can show the sign-in screen. */
export let onSignedOut: () => void = () => {};
export const setOnSignedOut = (fn: () => void) => (onSignedOut = fn);

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (r.status === 401 && !url.startsWith("/api/auth/")) onSignedOut();
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Request failed (${r.status})`);
  return r.json() as Promise<T>;
}

export const api = {
  lots: (qs: string) => call<SearchResult>(`/api/lots?${qs}`),
  lot: (id: number) => call<LotDetail>(`/api/lots/${id}`),
  cite: (id: number) => call<Citation>(`/api/cite/${id}`),
  field: (snapshot: number, path: string) => call<Citation>(`/api/snapshots/${snapshot}/field?path=${encodeURIComponent(path)}`),
  terms: (auction: number, which: "premium" | "gst") => call<Citation>(`/api/terms/${auction}/${which}`),
  summary: () => call<Summary>(`/api/summary`),
  currentScan: () => call<{ run: ScanRun | null }>(`/api/scans/current`),
  scans: () => call<{ runs: ScanRun[] }>(`/api/scans`),
  startScan: (body: { kind: "live" | "history"; resume?: boolean; options?: Record<string, unknown> }) =>
    call<{ run: ScanRun; reused: boolean }>(`/api/scans`, { method: "POST", body: JSON.stringify(body) }),
  cancelScan: (id: number) => call(`/api/scans/${id}/cancel`, { method: "POST", body: "{}" }),
  watch: (id: number, maxAllIn: number | null = null) => call(`/api/favourites/${id}`, { method: "PUT", body: JSON.stringify({ maxAllIn }) }),
  unwatch: (id: number) => call(`/api/favourites/${id}`, { method: "DELETE" }),
  photoValue: (id: number) => call<Citation>(`/api/photo-values/${id}`),
  photoSummary: () => call<PhotoSummary>(`/api/photos/summary`),
  auctions: (scope: "live" | "closed") => call<{ auctions: Auction[] }>(`/api/auctions?scope=${scope}`),
  auction: (id: number) => call<Auction>(`/api/auctions/${id}`),
  /** `fresh` skips a saved answer (the Look again / Search shops again buttons). */
  newPrice: (id: number, query: string, fresh = false) => call<TradeMeLookup>(`/api/lots/${id}/newprice`, { method: "POST", body: JSON.stringify({ query, fresh }) }),
  tradeMe: (id: number, query: string, fresh = false) => call<TradeMeLookup>(`/api/lots/${id}/trademe`, { method: "POST", body: JSON.stringify({ query, fresh }) }),
  tradeMeLookup: (lookupId: number) => call<TradeMeLookup>(`/api/trademe/lookups/${lookupId}`),
  tradeMeLinks: (id: number, links: string[]) => call<TradeMeLookup>(`/api/lots/${id}/trademe`, { method: "POST", body: JSON.stringify({ links }) }),
  refreshLot: (id: number) => call<{ ok: true }>(`/api/lots/${id}/refresh`, { method: "POST", body: "{}" }),
};

export interface Me {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
  email: string | null;
  n8_username: string | null;
  n8_bidder_number: string | null;
}

export interface AdminUser extends Me {
  disabled: boolean;
  created_at: string;
  last_sign_in: string | null;
}

export interface ScanSettings {
  scheduleEnabled: boolean;
  liveEveryHours: number;
  historyWeekly: boolean;
  concurrency: number;
}

export interface TradeMeSettings {
  enabled: boolean;
  dailyLimit: number;
  /** Automatic lookups for every open IT lot, through Parallel. */
  autoEnabled: boolean;
  autoDailyLimit: number;
  /** Why automatic lookups turned themselves off, and when. */
  autoStopped: { reason: string; at: string } | null;
}

export interface SettingsResponse {
  scan: ScanSettings;
  liveHourOptions: number[];
  trademe: TradeMeSettings;
  trademeLimitOptions: number[];
  trademeKeySet: boolean;
  parallelKeySet: boolean;
  autoLimitOptions: number[];
  autoProgress: AutoProgress;
}

/** Automatic Trade Me prices: open IT lots priced, today's lookups, those running now and the latest ten. */
export interface AutoProgress {
  openLots: number;
  priced: number;
  used: number;
  dailyLimit: number;
  running: number;
  /** When the daily limit is reached: when the oldest of the last 24 hours' lookups ages out. */
  resumesAt: string | null;
  recent: Array<{ id: number; lot_id: number | null; lot_title: string | null; source: "trademe" | "newprice"; query: string; status: "ok" | "failed" | "running"; found: number; error: string | null; created_at: string }>;
}

/** One Trade Me results page read through Parallel, for the admin's test; not stored. */
export interface ProbeReport {
  method: string;
  query: string;
  url: string;
  verdict: "ok" | "no-results" | "blocked" | "failed";
  message: string;
  status: number | null;
  ms: number;
  cards: number;
  priced: number;
  listingUrls: string[];
  pageStart: string;
}

export const account = {
  me: () => call<Me>(`/api/me`),
  login: (username: string, password: string) => call<{ ok: true }>(`/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => call(`/api/auth/logout`, { method: "POST", body: "{}" }),
  saveMe: (body: Partial<Me> & { current_password?: string; new_password?: string }) => call<Me>(`/api/me`, { method: "PUT", body: JSON.stringify(body) }),
  users: () => call<{ users: AdminUser[] }>(`/api/admin/users`),
  createUser: (body: { username: string; display_name: string; password: string; is_admin: boolean }) =>
    call<{ id: number }>(`/api/admin/users`, { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: number, body: { display_name?: string; is_admin?: boolean; disabled?: boolean; password?: string }) =>
    call(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteUser: (id: number) => call(`/api/admin/users/${id}`, { method: "DELETE" }),
  settings: () => call<SettingsResponse>(`/api/settings`),
  saveSettings: (scan: Partial<ScanSettings>) => call<{ scan: ScanSettings; trademe: TradeMeSettings }>(`/api/settings`, { method: "PUT", body: JSON.stringify({ scan }) }),
  autoPrices: () => call<AutoProgress & { enabled: boolean; autoEnabled: boolean; stopped: { reason: string; at: string } | null }>(`/api/trademe/auto`),
  probeParallel: (query: string) => call<ProbeReport>(`/api/admin/trademe/probe`, { method: "POST", body: JSON.stringify({ query }) }),
  saveTradeMe: (trademe: Partial<TradeMeSettings>) => call<{ scan: ScanSettings; trademe: TradeMeSettings }>(`/api/settings`, { method: "PUT", body: JSON.stringify({ trademe }) }),
};
