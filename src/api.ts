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
    detail_read_at: string | null;
  };
  specs: SpecValue[];
  observations: Array<{ id: number; observed_at: string; current_bid: number | null; bid_count: number | null; ends_at: string | null; status: string; snapshot_id: number; snapshot_path: string }>;
  terms: { premium_rate: number | null; gst_rate: number | null; payment_due: string | null } | null;
  revisions: Array<{ id: number; created_at: string }>;
  watchers: Array<{ id: number; display_name: string; added_at: string }>;
  photoValues: Array<{ id: number; field: string; value: string; quote: string; confidence: number; image_url: string }>;
  friendBids: Array<{ user_id: number; display_name: string; kind: "high_bidder" | "bid"; amount: number | null; bid_at: string | null; seen_at: string }>;
  comps: Array<{ id: number; title: string; final_bid: number; all_in: number; closed_at: string; faults: string[]; auction_title: string; item_url: string | null; outcome_snapshot_id: number; outcome_path: string }>;
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
  | { kind: "photo"; field: string; value: string; quote: string; confidence: number; boxes: Array<[number, number, number, number]>; width: number | null; height: number | null; image: string; imageUrl: string; sha256: string; ocr: string; readAt: string; lotUrl: string | null };

export interface ScanRun {
  id: number;
  kind: "live" | "history";
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
  settings: () => call<{ scan: ScanSettings; liveHourOptions: number[] }>(`/api/settings`),
  saveSettings: (scan: Partial<ScanSettings>) => call<{ scan: ScanSettings }>(`/api/settings`, { method: "PUT", body: JSON.stringify({ scan }) }),
};
