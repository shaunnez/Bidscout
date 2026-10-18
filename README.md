# BidScout

Search and deal scanning for [number8.bid](https://www.number8.bid/) auctions, built around computers but covering every category. Each lot's details are pulled out of the listing text, and every value opens the exact words it came from in the stored copy of the listing.

Personal use, with permission from number 8 solutions (17 October 2026).

## What it does

- **Live deals:** every open lot in every category, closing soonest first (switch to Computers & IT for computer filters), filterable by type (laptop, all-in-one, mini PC, workstation, server, tablet, monitor…), make, processor, Intel generation, RAM, storage, SSD, condition (no faults / no major faults), all-in price and closing time. Rows show the all-in price now (bid + buyer's premium + GST), bid count, a ticking time left, fault badges, the spec score, the expected final and a value index. Sort by best value, lowest expected final or highest spec score.
- **Expected final:** the likely all-in final price, from past sales of the same machine, then similar machines, then machines with a similar spec score. Shown as the middle half of those sales (p25–p75), never below the all-in at the current bid.
- **Value index:** how much computer you get for the money. 100 × the typical final for machines with this spec score ÷ this lot's expected final. Over 100 is cheaper than typical for what it is. Hidden when the expected final itself came from the spec-score sales, since it would just read 100.
- **Specs from photos:** for open computer lots missing a CPU model, RAM or storage, the first 3 photos are read with OCR (spec stickers, BIOS and "About" screens). A value found there fills only specs the listing didn't state, and opens the photo with the words boxed.
- **Past sales:** closed lots with their final bids, the history the comparisons are built from.
- **Auctions:** every live auction as a card: photos, pickup address, when the first and last lots close, fees, payment deadline, who is selling (the "Under instructions from …" line), lot and bid counts, how many lots are good value, and the group's favourites. Recently closed auctions show what sold and for how much. Opening one shows its lots with the auction's details at the top.
- **Check prices elsewhere:** each lot has links that search Trade Me, eBay sold listings, PriceSpy and Google for the same machine (make, model and CPU; a clone's parts; or the tidied title). BidScout only opens these pages for you.
- **Trade Me prices** (off until an admin turns it on, needs a Firecrawl key): a button on each lot that finds matching Trade Me listings and shows what they sold for or are asking, next to BidScout's own expected final. See below.
- **Lot drawer:** photos, a price breakdown where each part opens its source (bid, premium wording, GST wording), a link to its auction (pickup address, closing times, fees), a details table where every value opens its quote, what it's likely to cost with the spec score broken down, values read from photos, past sales of the same machine, bid movement seen across scans, and the listing text.
- **Favourites:** each person stars their own lots; a lot shows who else in the group has favourited it.
- **Friends:** each person adds their own number8 username and bidder number in Profile. A lot then shows when a friend is the high bidder or has bid, so you don't bid against each other. **Refresh now** on a lot re-reads it from number8.bid (one request) right before you bid.
- **Scans:** live scans run every 4 hours (Settings; on by default when hosted), plus a weekly past-sales top-up; you can also start one by hand and watch real progress counts.
- **Accounts:** usernames and passwords, created by an admin in Settings. No self sign-up.

## Running it

Needs Node 22 and PostgreSQL 16. Reading photos also needs `tesseract` (`apt install tesseract-ocr tesseract-ocr-eng`); without it the photo stage is skipped. The Docker image includes it.

```sh
cp .env.example .env.local        # set BIDSCOUT_CONTACT to an email number 8 solutions can reach you on
createdb bidscout                 # or point BIDSCOUT_DATABASE_URL at any empty database
npm install
npm run setup:db
npm run dev:api                   # API on :4328, scan worker runs inside it; first run creates admin/bidscout
npm run dev                       # UI on http://localhost:5188
```

Press **Scan now** in the UI, or run it from the command line:

```sh
npm run scan                                   # live auctions
npm run scan -- history --max-pages 200        # past sales, 200 pages (~5 min)
npm run scan -- history --resume               # continue where the last history scan stopped
npm run scan -- history --category "IT & Equipment"
npm run photos -- --limit 20                   # read photos of up to 20 lots now
```

The first live scan takes 10–20 minutes, because it opens every lot page once. Later scans only open new or changed lots. All past sales come to roughly 2,200 pages, about 50 minutes in total; run them in chunks.

## Hosting on Railway

The repo has a `Dockerfile` and `railway.toml`. Shaun runs the deploy himself (`railway up`). One service runs the API, the UI and the scan worker; scans still start only when someone presses Scan now.

1. In a new Railway project, add **PostgreSQL**. BidScout does not see it until you add the `DATABASE_URL` reference below.
2. Add a **volume** to the BidScout service mounted at `/data`, where the stored responses go. Without it, they are lost on every deploy and the citations break.
3. Set these variables on the service, and only these (don't copy `.env.example`: its local `BIDSCOUT_HOST`, `BIDSCOUT_DATA_DIR` and database settings break hosting):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`: a reference to the Postgres service.
   - `BIDSCOUT_PASSWORD`: the password of the first admin, user `admin` (or `BIDSCOUT_ADMIN_USERNAME`), created on first start. After that, people and passwords are managed in Settings.
   - `BIDSCOUT_CONTACT`: the email sent to number 8 solutions in the User-Agent.
   - `FIRECRAWL_API_KEY` (optional): Trade Me searches go through Firecrawl (after Parallel, if set), and pasted listing links need it. Without either, the image's Chromium runs Trade Me searches. `FIRECRAWL_API_URL` points at a self-hosted Firecrawl instead.
   - `PARALLEL_API_KEY` (optional): Trade Me searches go through Parallel's Extract API first (about $0.001 a page), and automatic prices for open IT lots can be turned on in Settings. Also turns on an admin-only "Test Parallel" button that reads one results page and reports how many listings and prices came back (nothing stored).
4. Under the service's Networking settings, generate a public domain.
5. Deploy: connect the repo so every push to `main` deploys, or run `railway up` from this folder. The health check is `/api/health`. The schema is applied at start.

Keep `numReplicas = 1`: the worker runs inside the one instance, and only one scan may run at a time.

## Trade Me prices (`server/trademe.ts`, `server/tmsearch.ts`, `server/autoprice.ts`)

A press of the button in a lot's drawer, by a signed-in person, when an admin has turned it on; or automatic prices (step 6).

1. **Trade Me's own search.** BidScout loads Trade Me's search results page for the lot's search text and reads the listing cards on it: title, location, closing date, and the price (Buy Now, current bid with reserve status, or asking price; shipping amounts ignored). If fewer than 3 relevant listings turn up, it searches again with just the make and model. At most two results pages per lookup.
   - Through Parallel when `PARALLEL_API_KEY` is set, then Firecrawl when `FIRECRAWL_API_KEY` is set, otherwise (or if those fail) a plain headless Chromium on the server (`CHROMIUM_PATH`; the Docker image installs `chromium`). No disguise: if Trade Me blocks it, the lookup fails rather than retrying around the block.
   - Trade Me's robots.txt asks crawlers not to use its search pages. Shaun chose to use them for this (18 Oct 2026), cached and under daily limits.
2. **Relevant listings only.** Accessories (batteries, chargers, cases…) are dropped unless the lot is one, and results in the lot's own Trade Me category are preferred. Faulty or for-parts listings are tagged and left out of the summary unless the lot has a major fault too.
3. **Quoted prices.** Each price (and Buy Now) opens the card text it came from, with contact details removed, and the results page's SHA-256. The page itself is not stored.
4. **Fallbacks.** If Trade Me's search can't be read and there's a Firecrawl key, a web search limited to trademe.co.nz finds listing pages instead (robots.txt checked for each, up to 5 read). You can also paste up to 5 listing links to have just those pages read (needs Firecrawl).
5. **Reuse and limit.** The same search text reuses the answer for 3 days. The group shares a daily limit for button presses (Settings: 10 to 1000; failed lookups count).
6. **Automatic prices** (needs `PARALLEL_API_KEY`; off until an admin turns it on in Settings). Every open IT lot gets the lookup the button would run, through Parallel only, about 2 searches a second (up to 100 running at once; Parallel allows 600 requests a minute, with retries on 429), under its own daily limit (100 to 1000). Lots sharing a search share one answer; answers are refreshed after 3 days while the lot is open; new lots are picked up after each scan. If Trade Me refuses Parallel, or 5 lookups in a row fail, it turns itself off and Settings says why.

Trade Me's terms still apply to this use; ask Trade Me before relying on it heavily. Trade Me's API is not an option: it is only for sellers in the trade.

## Scraping with consideration (`server/transport.ts`)

- One scan at a time across the whole app (a unique index on active runs).
- Up to 4 requests in flight (Settings → Requests at a time, 1–4), with request starts at least 0.3 s apart. One at a time means at least 1.2 s between requests plus up to 0.4 s of jitter (`BIDSCOUT_MIN_INTERVAL_MS` can raise it, never below 1 s).
- Every request the app makes to number8.bid shares one set of slots and spacing (`RequestGate`), so **Refresh now** during a scan takes one of the scan's slots rather than adding to them. This holds because the worker runs inside the one instance.
- Any slow reply (over 3 s) or 429/503 drops the scan to one request at a time. It climbs back one request at a time after every 20 quick replies in a row (under 2 s each), up to the setting. If one parallel request stops the run, the others are cancelled.
- Past-sales pages are read ahead: the next pages download through the same paced transport while the current ones are stored (not for the weekly top-up, never past the last page or the run's page limit).
- A weekly past-sales top-up reads one page at a time, so it stops at the first page with nothing new without fetching past it.
- After a reply that took over 3 s, the next gap is twice that reply's time (capped at 30 s).
- Past sales are read 60 to a page, the largest page the site's own menu offers. A 200-row page took 17 s for their server.
- **Retries:**
  - Network errors, timeouts, 408, 425 and 5xx: backoff of 2 s, 4 s, 8 s and 16 s (plus jitter), at most 4 retries.
  - 429 and 503: nothing starts until `Retry-After` has passed (default 60 s, at most 15 min), and the retry waits for requests still in flight, then goes one at a time. After 3 of these in one run, the run stops as *partial* and can be continued later.
  - An HTML page where JSON was expected (a challenge or login page) stops the run.
- Only public `/api/` and `/auxiliary/` paths. `/admin` and `/myaccount` (disallowed in robots.txt) are refused in code.
- Photos load from number8's CDN in your browser when you open a lot; the scanner doesn't download them.
- A live scan only re-lists auctions that are live or ended in the last 3 days. Closed lots are never re-read.

## Citations (`shared/`, `server/scan/ingest.ts`)

- Every response is stored as fetched, apart from the redaction below. It is gzipped and content-addressed by SHA-256 under `.data/objects/`, written once and re-hashed on every read (`server/store.ts`). The `snapshots` table records the URL, request, time, attempts and both hashes.
- A lot's listing content (title, description, quantity, category, prices set by the seller) is a **revision**, kept only when it changes. Bids, bid counts and close times are **observations**, kept only when they move. Final bids come from the snapshot that showed the lot closed.
- The parsers (`shared/specs/computer.ts`) work on `cleanText()` of the title and description. Each value is stored in `spec_values` with its field, value, character offsets and exact quote. The drawer re-reads the snapshot, re-cleans the field and checks the quote is still at those offsets before showing it.
- `npm run check:citations` re-checks every stored citation; the database test does the same on its fixtures.
- `npm run replay` rebuilds every derived table from the stored responses, in fetch order, without any requests. Use it after fixing how a field is read. The database test checks that a replay reproduces the same state.
- **Times:** AuctionMethod's unix fields (`end_time`, `ends`) hold New Zealand wall-clock time written as if it were UTC, and the auction list's ISO strings put a "+1300" label on a UTC clock. Both are converted in `server/number8.ts` (with daylight saving), checked against the site's own display text.
- **Photos (`server/images.ts`, `server/ocr.ts`, `server/scan/photos.ts`):** photos come only from number8's image host, one at a time a second apart. Each is stored like a snapshot (SHA-256, gzipped), enlarged 2× and greyscaled with sharp, then read by tesseract (`--psm 11`). `photo_reads` keeps the text and every word's box; `photo_values` keeps each value with its quote, boxes and confidence. Only strict patterns count (a CPU model number, "16GB RAM", "Memory Size 8192 MB", "512GB SSD"), only at 60% confidence or more, and only for specs the listing didn't state. A replay keeps photo reads, since they come from images rather than snapshots. If you change the OCR settings, bump `OCR_VERSION`.
- Evidence tables (`snapshots`, `lot_revisions`, `lot_observations`, `spec_values`, `auction_terms`, `photo_reads`, `photo_values`) reject updates.
- Nothing is guessed. A value that isn't in the text is simply missing, and generations are only given for Intel Core.

**Redaction (`server/redact.ts`).** Bidder usernames, buyer numbers and the high bidder, plus any email address or NZ mobile number in any text, are replaced before a response is written. Each snapshot lists the paths removed and keeps the SHA-256 of the original bytes.

## Deal comparisons (`server/scan/comps.ts`)

- **Machine key:** type, make, model, CPU, RAM band and storage class.
- **Similar key:** type, CPU family and generation, RAM band and drive type.
- Lots with a major fault (won't boot, locked, screen damage, unknown fault) are only compared with other faulty lots.
- Everything else is keyed on its tidied title, since liquidation sales often repeat a stock line.
- All-in uses each sale's premium and 15% GST, matching number8's worked example: a $1,000 bid becomes $1,322.50.
- **Spec score (`shared/specs/score.ts`):** a rough, explainable measure of how much computer a lot is, not a benchmark: (2 × CPU points + RAM points + storage points) × condition. CPU points are the tier (i3 1 … i9 4, Ryzen alike, Apple M 3.5, Celeron 0.4) times an age factor (Intel generation, Ryzen series, M chip). RAM is log₂ of GB (capped at 6), an SSD 0.5–2.5 by size, a hard drive 0.3. A major fault multiplies by 0.35, a minor one by 0.9. The drawer shows each part. Rows with no RAM or storage stated are marked incomplete.
- **Spec key:** form factor (portable, desktop, server), the score rounded to half a point, and fault. It's the last fallback for comparisons and the basis of the value index.
- A comparison shows its sales in the drawer. Below 3 sales it says how many there are, rather than giving a range; the expected final needs at least 3.

## Layout

```
server/      API (Fastify), worker, transport, store, redaction, schema.sql
server/scan/ runner (leases, cursor, stages), ingest, comparisons, photos
shared/      clean text, citation helpers, parsers, payment terms
src/         React UI (feed, lot drawer, source panel, scans)
scripts/     scan, setup-db, reparse, replay, read-photos, check-citations, test-db
tests/       unit (parsers, transport, redaction) and db (whole pipeline against a fake site)
```

## Tests

```sh
npm run typecheck
npm test            # parsers, spec score, photo values, transport retries and pacing, redaction
npm run test:db     # whole pipeline in a throwaway database with a fake site
npm run check:citations
```

Test fixtures are made-up lots written in number8's formats. Scraped data stays in `.data/` and the database, never in Git.
