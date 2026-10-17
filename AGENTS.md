# BidScout: notes for agents

A personal deal scanner for number8.bid (Shaun only, for now). Read `README.md` for how it runs and `PLAN.md` for the decisions behind it.

## Rules

- **Scrape with consideration.** All requests go through `server/transport.ts`: one at a time, at least 1 s apart (default 1.2 s plus jitter), slowing down after slow replies, honouring `Retry-After`, stopping after repeated 429/503 or a challenge page, and never touching `/admin` or `/myaccount`. Never add parallel fetching, a second transport or a schedule without Shaun asking. Shaun has permission from number 8 solutions (17 Oct 2026).
- **Everything is cited.** A value shown to Shaun comes from a stored snapshot and a span of `cleanText()` of one field, or from a raw field of a stored response. Never show a guessed value; missing stays missing. If you change `cleanText`, bump `CLEAN_VERSION`. If you change a parser, bump `PARSER_VERSION` and run `npm run reparse`. Old `spec_values` stay; they are immutable.
- **No personal data.** Bidder usernames, buyer numbers, emails and mobile numbers are redacted before anything is stored (`server/redact.ts`). Don't surface staff names or contacts from auction intros.
- **No scraped data in Git.** Snapshots live in `.data/` and the database. Test fixtures are made-up lots in number8's formats.
- Show dates in New Zealand time. The all-in price is bid × (1 + premium) × (1 + GST), with each rate cited from the auction's payment terms when they have been read; otherwise the GST is labelled "assumed".
- Run `npm run typecheck`, `npm test` and `npm run test:db` before pushing. Check UI changes in a browser.
- **Deploying needs Shaun's go-ahead, and he runs `railway up` himself.** Hosted BidScout must have `BIDSCOUT_PASSWORD` set (the server enforces it), a volume at `/data`, and exactly one replica.
