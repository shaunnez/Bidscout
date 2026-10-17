# BidScout

Search and deal scanning for [number8.bid](https://www.number8.bid/) auctions, built around computers but covering every category. Each lot's details are pulled out of the listing text, and every value opens the exact words it came from in the stored copy of the listing.

Personal use, with permission from number 8 solutions (17 October 2026).

## What it does

- **Live deals:** every open lot, filterable by type (laptop, all-in-one, mini PC, workstation, server, tablet, monitor…), make, processor, Intel generation, RAM, storage, SSD, condition (no faults / no major faults), all-in price and closing time. Rows show the all-in price now (bid + buyer's premium + GST), bid count, a ticking time left, fault badges, and past final prices for the same or similar machine.
- **Past sales:** closed lots with their final bids, the history the comparisons are built from.
- **Lot drawer:** photos, a price breakdown where each part opens its source (bid, premium wording, GST wording), a details table where every value opens its quote, past sales of the same machine, bid movement seen across scans, and the listing text.
- **Watchlist:** star a lot to keep it on one list.
- **Scans:** start a live scan or a chunk of past sales, and watch real progress counts. Nothing runs on a schedule.

## Running it

Needs Node 22 and PostgreSQL 16.

```sh
cp .env.example .env.local        # set BIDSCOUT_CONTACT to an email number 8 solutions can reach you on
createdb bidscout                 # or point BIDSCOUT_DATABASE_URL at any empty database
npm install
npm run setup:db
npm run dev:api                   # API on :4328, scan worker runs inside it
npm run dev                       # UI on http://localhost:5188
```

Press **Scan now** in the UI, or run it from the command line:

```sh
npm run scan                                   # live auctions
npm run scan -- history --max-pages 200        # past sales, 200 pages (~5 min)
npm run scan -- history --resume               # continue where the last history scan stopped
npm run scan -- history --category "IT & Equipment"
```

The first live scan takes 10–20 minutes, because it opens every lot page once. Later scans only open new or changed lots. All past sales come to roughly 2,200 pages, about 50 minutes in total; run them in chunks.

## Scraping with consideration (`server/transport.ts`)

- One scan at a time across the whole app (a unique index on active runs), with one request at a time.
- At least 1.2 s between requests, plus up to 0.4 s of jitter. `BIDSCOUT_MIN_INTERVAL_MS` can raise the gap, but it can never go below 1 s.
- After a reply that took over 3 s, the next gap is twice that reply's time (capped at 30 s).
- Past sales are read 60 to a page, the largest page the site's own menu offers. A 200-row page took 17 s for their server.
- **Retries:**
  - Network errors, timeouts, 408, 425 and 5xx: backoff of 2 s, 4 s, 8 s and 16 s (plus jitter), at most 4 retries.
  - 429 and 503: wait for `Retry-After` (default 60 s, at most 15 min). After 3 of these in one run, the run stops as *partial* and can be continued later.
  - An HTML page where JSON was expected (a challenge or login page) stops the run.
- Only public `/api/` and `/auxiliary/` paths. `/admin` and `/myaccount` (disallowed in robots.txt) are refused in code.
- Photos load from number8's CDN in your browser when you open a lot; the scanner doesn't download them.
- A live scan only re-lists auctions that are live or ended in the last 3 days. Closed lots are never re-read.

## Citations (`shared/`, `server/scan/ingest.ts`)

- Every response is stored as fetched, apart from the redaction below. It is gzipped and content-addressed by SHA-256 under `.data/objects/`, written once and re-hashed on every read (`server/store.ts`). The `snapshots` table records the URL, request, time, attempts and both hashes.
- A lot's listing content (title, description, quantity, category, prices set by the seller) is a **revision**, kept only when it changes. Bids, bid counts and close times are **observations**, kept only when they move. Final bids come from the snapshot that showed the lot closed.
- The parsers (`shared/specs/computer.ts`) work on `cleanText()` of the title and description. Each value is stored in `spec_values` with its field, value, character offsets and exact quote. The drawer re-reads the snapshot, re-cleans the field and checks the quote is still at those offsets before showing it.
- `npm run check:citations` re-checks every stored citation; the database test does the same on its fixtures.
- Evidence tables (`snapshots`, `lot_revisions`, `lot_observations`, `spec_values`, `auction_terms`) reject updates.
- Nothing is guessed. A value that isn't in the text is simply missing, and generations are only given for Intel Core.

**Redaction (`server/redact.ts`).** Bidder usernames, buyer numbers and the high bidder, plus any email address or NZ mobile number in any text, are replaced before a response is written. Each snapshot lists the paths removed and keeps the SHA-256 of the original bytes.

## Deal comparisons (`server/scan/comps.ts`)

- **Machine key:** type, make, model, CPU, RAM band and storage class.
- **Similar key:** type, CPU family and generation, RAM band and drive type.
- Lots with a major fault (won't boot, locked, screen damage, unknown fault) are only compared with other faulty lots.
- Everything else is keyed on its tidied title, since liquidation sales often repeat a stock line.
- All-in uses each sale's premium and 15% GST, matching number8's worked example: a $1,000 bid becomes $1,322.50.
- A comparison shows its sales in the drawer. Below 3 sales it says how many there are, rather than giving a range.

## Layout

```
server/      API (Fastify), worker, transport, store, redaction, schema.sql
server/scan/ runner (leases, cursor, stages), ingest, comparisons
shared/      clean text, citation helpers, parsers, payment terms
src/         React UI (feed, lot drawer, source panel, scans)
scripts/     scan, setup-db, reparse, check-citations, test-db
tests/       unit (parsers, transport, redaction) and db (whole pipeline against a fake site)
```

## Tests

```sh
npm run typecheck
npm test            # parsers, transport retries and pacing, redaction
npm run test:db     # whole pipeline in a throwaway database with a fake site
npm run check:citations
```

Test fixtures are made-up lots written in number8's formats. Scraped data stays in `.data/` and the database, never in Git.
