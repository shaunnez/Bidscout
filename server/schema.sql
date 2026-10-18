-- BidScout schema. Idempotent: re-run in full at start (server/db.ts migrate).
-- Append changes as ALTER ... IF NOT EXISTS blocks with a dated comment.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Blocks edits to stored evidence. Rows may be added, never changed.
CREATE OR REPLACE FUNCTION bidscout_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Every response fetched from number8.bid, as stored (bidder fields redacted).
CREATE TABLE IF NOT EXISTS snapshots (
  id bigserial PRIMARY KEY,
  run_id bigint,
  method text NOT NULL,
  url text NOT NULL,
  request_body text,
  status int NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  elapsed_ms int NOT NULL,
  attempts int NOT NULL DEFAULT 1,
  original_sha256 text NOT NULL,
  stored_sha256 text NOT NULL,
  object_ref text NOT NULL,
  bytes int NOT NULL,
  redactions jsonb NOT NULL DEFAULT '[]'
);
DROP TRIGGER IF EXISTS snapshots_immutable ON snapshots;
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION bidscout_immutable();

-- One scan at a time across the whole app, so the site only ever sees one client.
CREATE TABLE IF NOT EXISTS scan_runs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('live', 'history')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled')),
  options jsonb NOT NULL DEFAULT '{}',
  cursor jsonb NOT NULL DEFAULT '{}',
  phase text NOT NULL DEFAULT 'queued',
  lease_owner text,
  lease_until timestamptz,
  requests int NOT NULL DEFAULT 0,
  retries int NOT NULL DEFAULT 0,
  throttles int NOT NULL DEFAULT 0,
  pages_read int NOT NULL DEFAULT 0,
  pages_total int,
  auctions_seen int NOT NULL DEFAULT 0,
  auctions_queued int NOT NULL DEFAULT 0,
  auctions_listed int NOT NULL DEFAULT 0,
  lots_seen int NOT NULL DEFAULT 0,
  lots_new int NOT NULL DEFAULT 0,
  lots_changed int NOT NULL DEFAULT 0,
  observations int NOT NULL DEFAULT 0,
  lots_closed int NOT NULL DEFAULT 0,
  details_total int NOT NULL DEFAULT 0,
  details_read int NOT NULL DEFAULT 0,
  specs_parsed int NOT NULL DEFAULT 0,
  errors int NOT NULL DEFAULT 0,
  last_error text,
  stop_reason text,
  ticker jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS scan_runs_one_active ON scan_runs ((true))
  WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS auctions (
  id int PRIMARY KEY,
  title text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  city text,
  region text,
  item_count int,
  url text,
  thumb_url text,
  list_hash text,
  snapshot_id bigint REFERENCES snapshots(id),
  snapshot_path text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  last_listed_at timestamptz,
  finalized_at timestamptz
);

-- Buyer's premium and GST wording, read from a lot's payment terms (ItemData).
CREATE TABLE IF NOT EXISTS auction_terms (
  id bigserial PRIMARY KEY,
  auction_id int NOT NULL REFERENCES auctions(id),
  premium_rate numeric,
  premium_quote text,
  premium_start int,
  premium_end int,
  gst_rate numeric,
  gst_quote text,
  gst_start int,
  gst_end int,
  payment_due text,
  snapshot_id bigint NOT NULL REFERENCES snapshots(id),
  snapshot_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auction_id, snapshot_id)
);
DROP TRIGGER IF EXISTS auction_terms_immutable ON auction_terms;
CREATE TRIGGER auction_terms_immutable BEFORE UPDATE ON auction_terms
  FOR EACH ROW EXECUTE FUNCTION bidscout_immutable();

CREATE TABLE IF NOT EXISTS lots (
  id int PRIMARY KEY,
  auction_id int NOT NULL REFERENCES auctions(id),
  lot_number text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text,
  quantity int,
  item_url text,
  thumb_url text,
  city text,
  current_revision_id bigint,
  semantic_hash text,
  ends_at timestamptz,
  current_bid numeric,
  bid_count int,
  starting_bid numeric,
  buyer_premium numeric,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  final_bid numeric,
  closed_at timestamptz,
  outcome_snapshot_id bigint REFERENCES snapshots(id),
  outcome_path text,
  needs_detail boolean NOT NULL DEFAULT true,
  detail_snapshot_id bigint REFERENCES snapshots(id),
  detail_read_at timestamptz,
  images jsonb NOT NULL DEFAULT '[]',
  bid_history jsonb NOT NULL DEFAULT '[]',
  -- Facets copied from the current parse (spec_values hold the citations).
  parser_version text,
  device_type text,
  is_it boolean NOT NULL DEFAULT false,
  make text,
  model text,
  cpu text,
  cpu_family text,
  cpu_gen int,
  ram_gb numeric,
  storage_gb numeric,
  storage_type text,
  screen_in numeric,
  gpu text,
  os text,
  faults text[] NOT NULL DEFAULT '{}',
  major_fault boolean NOT NULL DEFAULT false,
  machine_key text,
  loose_key text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS lots_search ON lots USING gin (search);
CREATE INDEX IF NOT EXISTS lots_title_trgm ON lots USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS lots_status_ends ON lots (status, ends_at);
CREATE INDEX IF NOT EXISTS lots_auction ON lots (auction_id);
CREATE INDEX IF NOT EXISTS lots_machine_key ON lots (machine_key) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS lots_loose_key ON lots (loose_key) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS lots_needs_detail ON lots (ends_at) WHERE needs_detail;

-- The listing content of a lot, each time it changes (bid changes are observations).
CREATE TABLE IF NOT EXISTS lot_revisions (
  id bigserial PRIMARY KEY,
  lot_id int NOT NULL REFERENCES lots(id),
  semantic_hash text NOT NULL,
  fields jsonb NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES snapshots(id),
  snapshot_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, semantic_hash)
);
DROP TRIGGER IF EXISTS lot_revisions_immutable ON lot_revisions;
CREATE TRIGGER lot_revisions_immutable BEFORE UPDATE ON lot_revisions
  FOR EACH ROW EXECUTE FUNCTION bidscout_immutable();

-- Bid, bid count and close time as seen at a moment, kept only when something moved.
CREATE TABLE IF NOT EXISTS lot_observations (
  id bigserial PRIMARY KEY,
  lot_id int NOT NULL REFERENCES lots(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  current_bid numeric,
  bid_count int,
  ends_at timestamptz,
  status text NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES snapshots(id),
  snapshot_path text NOT NULL
);
CREATE INDEX IF NOT EXISTS lot_observations_lot ON lot_observations (lot_id, observed_at);
DROP TRIGGER IF EXISTS lot_observations_immutable ON lot_observations;
CREATE TRIGGER lot_observations_immutable BEFORE UPDATE ON lot_observations
  FOR EACH ROW EXECUTE FUNCTION bidscout_immutable();

-- Every derived value with the exact words it came from.
-- start/end are offsets into cleanText() of the revision field named by source.
CREATE TABLE IF NOT EXISTS spec_values (
  id bigserial PRIMARY KEY,
  lot_revision_id bigint NOT NULL REFERENCES lot_revisions(id),
  parser_version text NOT NULL,
  field text NOT NULL,
  value text NOT NULL,
  num numeric,
  source text NOT NULL CHECK (source IN ('title', 'description')),
  start_offset int NOT NULL,
  end_offset int NOT NULL,
  quote text NOT NULL,
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spec_values_revision ON spec_values (lot_revision_id, parser_version);
DROP TRIGGER IF EXISTS spec_values_immutable ON spec_values;
CREATE TRIGGER spec_values_immutable BEFORE UPDATE ON spec_values
  FOR EACH ROW EXECUTE FUNCTION bidscout_immutable();

-- Final-bid ranges per machine key, rebuilt at the end of each scan.
CREATE TABLE IF NOT EXISTS comp_stats (
  key text PRIMARY KEY,
  key_kind text NOT NULL,
  n int NOT NULL,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  latest timestamptz,
  built_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist (
  lot_id int PRIMARY KEY REFERENCES lots(id),
  max_all_in numeric,
  note text,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- 18 Oct 2026: accounts, per-person favourites, friendly bidders, settings.

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  disabled boolean NOT NULL DEFAULT false,
  email text,
  -- This person's own number8.bid identities, so the group can see each other's bids.
  n8_username text,
  n8_bidder_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS favourites (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lot_id int NOT NULL REFERENCES lots(id),
  max_all_in numeric,
  note text,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lot_id)
);
CREATE INDEX IF NOT EXISTS favourites_lot ON favourites (lot_id);

-- Bids by people in the group, matched against their own number8 IDs before redaction.
-- Strangers' identities are never stored; only these matches are.
CREATE TABLE IF NOT EXISTS friend_bids (
  id bigserial PRIMARY KEY,
  lot_id int NOT NULL REFERENCES lots(id),
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('high_bidder', 'bid')),
  amount numeric,
  bid_at timestamptz,
  snapshot_id bigint NOT NULL REFERENCES snapshots(id),
  seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS friend_bids_unique ON friend_bids (lot_id, user_id, kind, COALESCE(amount, -1), COALESCE(bid_at, 'epoch'));
CREATE INDEX IF NOT EXISTS friend_bids_lot ON friend_bids (lot_id, seen_at DESC);

ALTER TABLE lots ADD COLUMN IF NOT EXISTS friend_high_user_id bigint REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS trigger text NOT NULL DEFAULT 'manual';
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS started_by bigint REFERENCES users(id) ON DELETE SET NULL;

-- Search speed (18 Oct 2026)
CREATE INDEX IF NOT EXISTS lots_open_it ON lots (ends_at) WHERE status = 'open' AND is_it;
CREATE INDEX IF NOT EXISTS lots_category ON lots (category);
CREATE INDEX IF NOT EXISTS lots_device_type ON lots (device_type) WHERE device_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS lots_closed_at ON lots (closed_at DESC) WHERE status = 'closed';
