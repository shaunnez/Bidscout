# BidScout: a computer deal scanner for number8.bid

Plan, 17 October 2026. Nothing is built yet. This folder is kept separate from BidEdge (Groundwork) on purpose: it borrows the patterns that Groundwork's GETS intake uses, but none of its code paths, so it can move to its own repository later.

## 0. Before anything runs: permission

number8.bid's `robots.txt` allows crawling, except for `/admin` and `/myaccount`, and it publishes an auction sitemap. Its **Terms of Use** say otherwise:

> "Access and Interference: You agree that You will not use any automatic device or manual process to monitor or copy number 8 solutions Ltd web pages or the content contained herein."

(Source: `https://www.number8.bid/api/staticpage/terms`, read 17 Oct 2026.)

Groundwork's GETS intake identifies itself as "approved access only". BidScout should hold to the same standard. The first step is to ask number 8 solutions, through the site's Contact Us page, for written permission to read their public listing API for personal deal research. Explain the pacing (one request a second, manual runs only) and offer to stop on request. Ask whether they would prefer to provide an export.

Until they say yes:

- no scheduled or bulk runs;
- no scraped data committed to Git;
- development uses a few hand-saved responses kept under the Git-ignored `.local-groundwork/bidscout/`.

If they say no, the UI and parser are still useful for any data that can be got legitimately, but the backfill and the comparable-sales feature (§4.3) go away.

## 1. What the site actually is

number8.bid runs on the **AuctionMethod** platform (an AngularJS front end, with the `geodesic_classifieds` table names visible). Every screen is filled from a public JSON API that needs no sign-in. That is much better than scraping HTML: the fields are structured, so they can be cited by name.

| Call | What it returns | Notes |
|---|---|---|
| `POST /api/auctions` (`filters[...]`, `past_sales`) | Auctions, 24 per page | 1,126 auctions over 47 pages. Each has an id, title, starts/ends (NZ offset), `item_count`, address, intro HTML, images |
| `GET /api/auctionDetail/{id}` | One auction | Terms and pickup details |
| `POST /api/getitems` (`auction_id`, `item_type=itemlist`, `show_closed`) | Every lot in an auction | Title, description HTML, `current_bid`, `bid_count`, `starting_bid`, `buyer_premium`, close time, `category_name`, thumbnail, `item_url` |
| `POST /api/getitems` (`item_type=pastsales`, `filters[keyword]`, `filters[category]`, `filters[page]`, `filters[perpage]`) | Closed lots with their final bid | **133,892 past lots.** 3,437 are under "IT & Equipment"; "ThinkPad" alone matches 74 |
| `POST /api/ItemData` (`item_id`, `auction_id`) | Full lot detail | Every image URL, bid history (amount and time), `payment_happens` (the premium and GST wording), disclaimers, pickup |
| `GET /api/categories` | Category list | Computers appear as "IT & Equipment" (id 105) and "Computers & IT". Many also sit in mixed sales with no category |
| `/auxiliary/sitemap_auctions.xml` | Every current lot URL | 619 URLs today. A cheap way to spot new lots |

Facts that shape the design:

- **Computer descriptions follow a few templates**, which makes parsing them by code realistic:
  1. ITAD batches (auction 2140, live, 51 lots, closes Thu 22 Oct 2026, 7:00pm NZ): `ITAD Barcode – … Type – AIO Make – HP Model – EliteOne 800 G6 Specs – Intel Core i5 10500,3.1GHz,8GB,1TB SSD ,27 inch,Webcam,Wi-Fi Faults – …`
  2. Labelled fields (auction 2203, closed): `Model: ProOne 600 G5 CPU: Core i5 9500 @ 3.0ghz RAM: 16gb Storage: 500gb ssd Screen: 21.5" GPU: … Webcam: yes … COA / Licence: … SN: …`. Its labels run together with no spaces between them.
  3. Free text: `Intel Xeon Silver 4310,2.10 GHz,192 GB,2 × 1.92 TB SSD …` or `Won't Boot`.
- **The faults are the deal signal**: "Missing power adapter", "Faulty battery", "Won't boot", "No HDD", "black liquid in the middle of screen". They need to be first-class filters.
- **Price is never the bid.** The terms example says: "If the winning bid is $1,000.00 the buyer's premium of 15% is added ($150) and then GST of 15% ($172.50) is added to give a total invoice amount of $1,322.50." So all-in = bid × 1.15 × 1.15 at today's rates. Read the rate from each auction's own wording and cite it; never hard-code it.
- Lots use extended bidding: a bid in the last 5 minutes adds 5 minutes (`extend_threshold`, `extend_interval`). Show the close time as "from".
- **Personal data in the API:** `high_bidder`, `winner`, `highbidder_username`, and the bid history's `user_name` and `buyer_number`. Auction intros also contain staff names, emails and mobiles. BidScout never stores or shows any of these (§3.4).
- Images are on CloudFront (`d2mkoraxgm9izf.cloudfront.net/auctionimages/{auction}/…`), about 4 per lot. Some photos show spec stickers or BIOS screens.

## 2. What the tool does (the "way better UI")

One screen does most of the work: a **computer deal feed**. Every computer lot from live auctions is a row with its specs already pulled out.

- **Search and filters:**
  - type: laptop, all-in-one, desktop, mini, workstation, server, tablet, monitor, part;
  - make and model family (ThinkPad T, EliteBook, ProOne…);
  - CPU vendor, family and generation (an i5-10500 is 10th-gen Intel);
  - RAM at least N GB, SSD or HDD and size, screen size, discrete GPU;
  - OS or licence;
  - faults: none listed, missing charger only, won't boot, no drive, screen damage;
  - region and pickup suburb, and how soon it closes.

  Example: "ThinkPad, 16 GB+, SSD, 10th-gen or newer, no faults, closing this week, under $300 all-in".
- **Each row shows** the all-in price now, the bid count, the time left, a fault badge and a **deal marker** (§4.3), backed by actual past number8 sales of comparable machines.
- **The lot page** has:
  - a spec table in which **every value opens the exact words it came from** in a side panel, the same way BidEdge sources work: the description with the matched words highlighted, or the photo with OCR boxes;
  - photos, bid history (amounts and times only), auction terms, premium and pickup, plus the dates and the link to the lot on number8.bid;
  - "Seen before": earlier sales of the same model and spec, each one cited.
- **Closing timeline:** what you are watching, by close time (the ITAD sales tend to close in a burst on one evening).
- **Watchlist and max-bid planner:** enter a ceiling all-in price and see the matching bid. No automatic bidding, ever. Bidding stays on number8.bid.
- **Batch view:** lots from the same auction or ITAD batch grouped together, e.g. "8 × HP EliteOne 800 G6, i5-10500, 8 GB".
- **Scan now** button and a live card with real counts (auctions read, lots found, new, changed, detail pages read, specs parsed), like Groundwork's `Live.tsx`.

Design language is close to BidEdge: dense, fast and scannable on a desktop, usable on a phone, dates in NZ time.

## 3. Ingestion pipeline

### 3.1 Shape (mirrors Groundwork's GETS intake)

| Groundwork GETS | BidScout |
|---|---|
| `POST /api/feed/refresh` → `startGetsRun` (advisory lock, reuse any active run) | `npm run scan` (CLI) or the Scan now button → `startScanRun`, same rule |
| `gets_intake_runs` with a cursor, a 45s lease, a heartbeat and `fenced()` writes | `scan_runs`, the same lease and fencing pattern |
| `gets_intake_items`, one per RFx, with a listing-row hash | `lots`, one per number8 item id, with a list-row hash |
| `gets_intake_pages` (raw page plus SHA-256) | `snapshots`: every response kept as fetched (§3.4), with its hash |
| `gets_notice_revisions` (semantic hash, immutable) | `lot_revisions` (semantic hash of the non-volatile fields) |
| `skipUnchanged` (row unchanged, read within a day, quick read present) | Skip a lot's `ItemData` when its list row is unchanged and it was read within N hours, unless it closes within 2 hours |
| `units` and `RefChecker` quote checks | `spec_values` with a snapshot, a field path and a character span (§3.3) |
| Run counters drive the live card | The same: counters on `scan_runs`, polled every 3s |

The GETS intake has no generic job queue: each kind of job has its own leased table. BidScout follows that and starts with one worker lane.

### 3.2 Stages of one run

1. **Discover.** Page through `POST /api/auctions` (live). Upsert `auctions`, store each page as a snapshot and record new auction ids. Cross-check against the sitemap's lot URLs.
2. **List lots.** Call `getitems` once per auction that is live or closed within the last 7 days (with `show_closed=1` so final bids are captured). Hash each row. A new item id is **new**. A changed semantic hash means **changed** (title, description, quantity, images or close time). A change only in bid fields is an **observation**.
3. **Classify.** Decide whether the lot is a computer: category "IT & Equipment" or "Computers & IT", **or** a title, description or spec pattern in a mixed sale. Every lot is kept; non-computers are flagged as such, so the classifier can improve and be re-run.
4. **Drill in.** Call `ItemData` for computer lots that are new, changed or about to close. This brings the full image list, bid history, payment wording and disclaimers. Image files are fetched only when a lot is opened or OCR is asked for, and are then stored with their hash.
5. **Parse specs.** Run the deterministic parsers (§3.3) on the cleaned description. Each value keeps its span.
6. **Consolidate.**
   - Group lots that are the same model and spec into a `machine_key`, e.g. `hp|eliteone 800 g6|i5-10500|8gb|1tb-ssd`.
   - Link each lot to its comparables.
   - When a lot closes, record its **final bid** as an `outcome` from the snapshot that showed it closed.
7. **Finish.** The run is `complete` only when its counters reconcile, otherwise `partial` with the reason (as GETS `finish()` does).

**History backfill (one-off, only once permission is given):**

- Page `pastsales` with `category=IT & Equipment`, `Computers & IT`, plus computer keywords for uncategorised lots.
- That is roughly 5–8k candidate lots at 60 per page, then `ItemData` only for those classified as computers.
- At one request a second, it takes about 2–3 hours, can be resumed through the run cursor, and is never repeated.

**Transport:**

- Plain HTTPS (Node `https`, as `ApprovedPublicGetsTransport` does), with a user-agent that names the tool and gives a contact address.
- At least 1 second between requests; 30s timeout; size cap; JSON only.
- Stop the run as `partial` on a 403 or 429 or an unexpected HTML page.
- No Playwright, no sign-in, nothing under `/myaccount`.

### 3.3 Citations: every value can be checked

Every derived value is stored as:

```
spec_values(lot_revision_id, field, value, unit,
            snapshot_id, json_path, start, end, quote,
            method,  -- 'parser:itad-v1' | 'parser:labelled-v1' | 'ocr' | 'model'
            parser_version)
```

- `snapshot_id` plus `json_path` (e.g. `$.item_description`) points at the stored response. `start` and `end` are offsets into that field's cleaned text, which has HTML stripped and entities decoded by one shared `cleanText()` function that is versioned. `quote` is the exact substring, e.g. `Intel Core i5 10500,3.1GHz`.
- A check script (like `scripts/check-briefs.ts`) re-derives every quote from its snapshot and fails if one doesn't match. It runs in the tests.
- Parser values are exact by construction. **Model values** are a fallback for free text only. The model must return the quote, and the quote must be found verbatim, using the same NFKC, dash and quote folding as Groundwork's `RefChecker`. Otherwise the value is dropped and shown as unknown.
- **OCR values** (spec stickers, BIOS photos) keep the image hash and word boxes, and are labelled "read from photo".
- Lot-level facts cite their field as well: the current bid cites `$.current_bid` in the snapshot of a stated time; the premium cites the `payment_happens` sentence; the close time cites `end_time`.
- **Derived numbers say how they were worked out:** all-in price = bid × (1 + premium) × (1 + GST), with both rates cited. A comparison cites each past lot it used.
- Unknown stays unknown. "RAM: not stated" is a valid value; it is never guessed from the model name.

### 3.4 Storage, immutability and privacy

- **Postgres**, run as Groundwork does it: one idempotent `schema.sql`, re-run at start under an advisory lock.
  - Main tables: `scan_runs`, `snapshots`, `auctions`, `auction_revisions`, `lots`, `lot_revisions`, `lot_observations` (append-only bid, bid count and time), `spec_values`, `images`, `outcomes`, `machine_keys`, `cpu_catalogue`.
  - Full-text search uses `tsvector` plus `pg_trgm` for model names.
- **Raw responses** go to an object store copied from Groundwork's `ObjectStore`: write once, `.tmp` then rename, SHA-256, re-verified on read. An update trigger blocks edits to `snapshots`, `lot_revisions` and `spec_values` (like `prevent_snapshot_update()`).
- **Bidder fields are redacted before writing.** Before a response is stored, `high_bidder`, `winner`, `highbidder_username` and the bid history's `user_name` and `buyer_number` are replaced with `"[redacted]"`. The snapshot records the SHA-256 of the original bytes and the list of paths removed. Citations point into the redacted copy, which is the stored source.
  - This is a deliberate exception to Groundwork's "keep original bytes" rule. A bidder's username is personal data BidScout has no use for.
  - Staff names, emails and mobiles in auction intros are never surfaced (the same rule BidEdge follows).
- Everything sits under `.local-groundwork/bidscout/` locally. Nothing scraped goes into Git.

### 3.5 CPU catalogue

The specs say "i5 10500" or "Ryzen 5 Pro 4650u". A small hand-made table, `cpu_catalogue` (model → vendor, family, generation, cores, launch year), turns those into the filters above. It is seeded from a reviewed list of CPUs that actually appear in the data, and each row cites where its facts came from, such as the manufacturer's spec page. An unknown CPU is shown as written and listed for review.

## 4. Deal scoring (no invented values)

### 4.1 All-in price
Read from each auction's own premium and GST wording, as above.

### 4.2 Comparable sales
Comparables are closed number8 lots with the same `machine_key`. If there are fewer than 3, a looser key is used: same type, CPU generation, RAM band and storage type. The looseness is stated, e.g. "similar: 10th-gen i5, 16 GB, SSD".

### 4.3 Deal marker
This lot's current all-in price compared with the comparables' final all-in prices:

- **Below past sales** when it is under the 25th percentile.
- **In range** between the 25th and 75th.
- **Above past sales** over the 75th.
- **Not enough history** when there are fewer than 3 comparables. Most lots sit at a low bid until the final hour, so the marker is really "where would this likely end", shown as a range of past finals beside the current bid.

Faults change the comparison: a "won't boot" lot is only compared with other faulty lots. Retail prices from other sites are out of scope for v1. Final bids are "final bids", not confirmed sales; the payment can fail, and the platform only shows the bid.

## 5. Stack and layout

```
bidscout/
  PLAN.md            this file
  package.json       own package, not part of the BidEdge build
  server/            Fastify API, worker (scan lane), transport, schema.sql
  shared/            clean-text, spec parsers, machine keys, deal maths (pure, tested)
  src/               React + Vite UI (feed, lot page, side-panel citations, live card)
  scripts/           scan CLI, check-citations, backfill
  tests/             node:test, fixtures loaded from .local-groundwork/bidscout/fixtures
```

TypeScript, Node 22, Fastify, Postgres, React and Vite: the same stack as BidEdge, so the patterns copy across. The modules to copy and adapt rather than import are:

- `server/storage.ts` (object store);
- the lease and fencing helpers from `server/gets/intake.ts`;
- the text folding in `server/brief/refs.ts`;
- `src/brief/Live.tsx` and `src/brief/locate.ts`.

Separate ports from BidEdge: UI 5188, API 4328. AI, used only for free-text fallback and OCR clean-up, goes through the same Claude CLI subscription path that BidEdge uses, with `provider_calls`-style ledger keys so a call is never paid for twice.

## 6. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Permission asked; spike | A written reply from number 8 solutions. 3 auctions' responses saved locally as fixtures (2140, 2203, one mixed sale) |
| M1 | Ingestion core | `npm run scan` discovers auctions, lists lots, drills into computer lots, stores redacted snapshots, finishes `complete` or `partial` with reconciled counters. Tests use a fake transport (as `gets-intake.test.ts` does) and cover leases, resume, skip-unchanged and redaction |
| M2 | Computer parser and citations | ITAD and labelled templates parsed. Every value carries a span; `check-citations` passes on all fixtures. Parser accuracy measured on 100 hand-labelled lots, aiming for 95%+ on CPU, RAM and storage |
| M3 | Deal feed UI | Feed, facets, search, lot page, side-panel citations, all-in price, closing timeline, Scan now with live card. Checked in a browser on desktop and phone |
| M4 | History and comparables | Backfill run once. Machine keys, comparables and the deal marker show their comparables |
| M5 | Depth | Watchlist and max-bid planner, batch view, photo OCR for spec stickers, model fallback for free-text lots, CPU catalogue review screen |

Each milestone is its own PR. Nothing is deployed until you say so.

## 7. Decisions for Shaun

1. **Permission:** OK to contact number 8 solutions as described in §0, from your name or a BidScout address?
2. **Who it's for:** just you, or eventually other buyers? That decides sign-in, hosting and how carefully the data can be reused.
3. **Repository:** start in this folder (as asked) and move it to its own repository at M1? I recommend moving.
4. **Scope:** computers only (laptops, desktops, all-in-ones, servers, tablets, monitors, parts), or computers first with other categories later?
5. **Other sites:** only number8.bid, or other NZ auction sites later? If later, keep the AuctionMethod adapter separate from the computer parser from the start, which the layout above already does.
