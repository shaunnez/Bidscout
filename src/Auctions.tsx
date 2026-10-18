import { useEffect, useState } from "react";
import { api, type Auction } from "./api.ts";
import { auctionParts, saleReason } from "./auction.ts";
import { useNow } from "./Feed.tsx";
import { money, nzDate, nzShort, timeLeft } from "./format.ts";

/** "Full payment must be made no later than 12pm … on Friday 23rd" → "12pm … on Friday 23rd". */
export const payBy = (s: string) => s.replace(/^full payment\s+(?:must be made\s+)?(?:no later than|by)\s*/i, "");

const nzTime = (d: string | null) =>
  d ? new Date(d).toLocaleTimeString("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit" }) : "";

/** "Thu, 22 Oct, 7:00 pm – 7:24 pm": when the first and last lots are due to close. */
export function closingWindow(a: Pick<Auction, "ends_at" | "lots_close_at">) {
  if (!a.ends_at) return null;
  const first = new Date(a.ends_at).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return a.lots_close_at && a.lots_close_at !== a.ends_at ? `${first} – ${nzTime(a.lots_close_at)}` : first;
}

export function Auctions({ openAuction }: { openAuction: (a: Pick<Auction, "id" | "live">) => void }) {
  const [scope, setScope] = useState<"live" | "closed">("live");
  const [items, setItems] = useState<Auction[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    setItems(null);
    api.auctions(scope).then((r) => setItems(r.auctions)).catch((e) => setErr(e.message));
  }, [scope]);

  const openLots = items?.reduce((n, a) => n + a.open_lots, 0) ?? 0;
  return (
    <div className="auctions">
      <div className="results-head">
        <div>
          <h1>Auctions</h1>
          <p className="sub">
            {!items ? "Loading…" : scope === "live"
              ? `${items.length} live auction${items.length === 1 ? "" : "s"} · ${openLots.toLocaleString()} open lots`
              : `${items.length} recent auctions with recorded results`}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Which auctions">
          <button className={scope === "live" ? "on" : ""} onClick={() => setScope("live")}>Live</button>
          <button className={scope === "closed" ? "on" : ""} onClick={() => setScope("closed")}>Recently closed</button>
        </div>
      </div>
      {err && <p className="err">{err}</p>}
      {items && !items.length && <div className="empty"><h2>No auctions here yet</h2><p>A live scan lists number8.bid's auctions.</p></div>}
      {items && scope === "live" && (
        <div className="auction-grid">
          {items.map((a) => <AuctionCard key={a.id} a={a} now={now} onOpen={() => openAuction(a)} />)}
        </div>
      )}
      {items && scope === "closed" && items.length > 0 && <ClosedTable items={items} onOpen={openAuction} />}
    </div>
  );
}

function AuctionCard({ a, now, onOpen }: { a: Auction; now: number; onOpen: () => void }) {
  const { headline, location, unreserved } = auctionParts(a.title);
  const reason = saleReason(a.title, a.instructions);
  const tl = timeLeft(a.next_close ?? a.ends_at, now);
  const soon = a.next_close && new Date(a.next_close).getTime() - now < 86_400_000;
  const thumbs = (a.thumbs?.length ? a.thumbs : a.thumb_url ? [a.thumb_url] : []).slice(0, 4);
  const withBids = a.open_lots ? Math.round((a.lots_with_bids / a.lots) * 100) : 0;
  return (
    <article className="auction-card">
      <button className="card-hit" onClick={onOpen} aria-label={`Browse ${headline}`} />
      <div className={`auction-photos n${thumbs.length}`}>
        {thumbs.map((u) => <img key={u} src={u} alt="" loading="lazy" />)}
        {!thumbs.length && <span className="muted">No photos</span>}
        <span className={`countdown ${tl.urgent ? "urgent" : soon ? "soon" : ""}`}>{tl.over ? "Closing now" : `Closes in ${tl.text.replace(" left", "")}`}</span>
      </div>
      <div className="auction-body">
        <div className="tags">
          {unreserved && <span className="tag">Unreserved</span>}
          {reason && <span className="tag reason">{reason}</span>}
          {a.it_lots > 0 && <span className="tag it">{a.it_lots === a.lots ? "All computer & IT" : `${a.it_lots} computer & IT lots`}</span>}
        </div>
        <h2 title={a.title}>{headline}</h2>
        <p className="where">
          <PinIcon />
          <span>{[a.address, location ?? a.city, a.postcode].filter(Boolean).join(", ") || "Location not listed"}</span>
        </p>
        <dl className="auction-stats">
          <div><dt>Lots</dt><dd>{a.lots.toLocaleString()}</dd></div>
          <div><dt>Bids</dt><dd>{a.bids.toLocaleString()}</dd></div>
          <div><dt>With bids</dt><dd>{withBids}%</dd></div>
          <div className={a.good_value ? "good" : ""}><dt>Good value</dt><dd>{a.good_value}</dd></div>
        </dl>
        <ul className="auction-facts">
          {closingWindow(a) && <li><b>Closes</b> {closingWindow(a)}</li>}
          {a.premium_rate !== null && <li><b>Fees</b> {a.premium_rate}% buyer's premium + {a.gst_rate ?? 15}% GST</li>}
          {a.payment_due && <li><b>Pay by</b> {payBy(a.payment_due)}</li>}
          {a.instructions && <li className="muted">{a.instructions}</li>}
        </ul>
        {(a.group_favourites > 0 || a.friend_high > 0) && (
          <div className="social">
            {a.my_favourites > 0 && <span className="watchers">★ {a.my_favourites} of yours</span>}
            {a.group_favourites - a.my_favourites > 0 && <span className="watchers">★ {a.group_favourites - a.my_favourites} by others</span>}
            {a.friend_high > 0 && <span className="friend">A friend leads on {a.friend_high}</span>}
          </div>
        )}
        <div className="auction-actions">
          <button className="primary" onClick={onOpen}>Browse {a.open_lots.toLocaleString()} lots</button>
          {a.url && <a className="ghost" href={a.url} target="_blank" rel="noreferrer">number8.bid ↗</a>}
        </div>
      </div>
    </article>
  );
}

function ClosedTable({ items, onOpen }: { items: Auction[]; onOpen: (a: Auction) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Auction</th><th>Closed</th><th className="r">Sold</th><th className="r">Total of final bids</th><th className="r">Top lot</th><th /></tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const { headline, location } = auctionParts(a.title);
            const thumb = a.thumbs?.[0] ?? a.thumb_url;
            return (
              <tr key={a.id} className="clickable" onClick={() => onOpen(a)}>
                <td>
                  <div className="cell-lot">
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="no-thumb" />}
                    <div>
                      <button className="link strong" onClick={(e) => { e.stopPropagation(); onOpen(a); }}>{headline}</button>
                      <div className="muted small">{[location ?? a.city, saleReason(a.title, a.instructions)].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                </td>
                <td className="nowrap" title={nzDate(a.last_closed ?? a.ends_at)}>{nzShort(a.last_closed ?? a.ends_at)}</td>
                <td className="r num">{a.sold.toLocaleString()}<span className="muted"> / {a.lots.toLocaleString()}</span></td>
                <td className="r num">{money(a.sold_total)}</td>
                <td className="r num">{money(a.top_final)}</td>
                <td className="r">{a.url && <a href={a.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="On number8.bid">↗</a>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="footnote">Final bids before buyer's premium and GST, from lots BidScout has recorded. Past sales read on the Scans page fill in older auctions.</p>
    </div>
  );
}

/** A compact version for the top of a feed filtered to one auction. */
export function AuctionBanner({ id, onClear }: { id: number; onClear: () => void }) {
  const [a, setA] = useState<Auction | null>(null);
  const now = useNow();
  useEffect(() => {
    setA(null);
    api.auction(id).then(setA).catch(() => {});
  }, [id]);
  if (!a) return <div className="auction-banner loading"><span className="muted">Loading auction…</span></div>;
  const { headline, location, unreserved } = auctionParts(a.title);
  const reason = saleReason(a.title, a.instructions);
  const tl = timeLeft(a.next_close ?? a.ends_at, now);
  return (
    <section className="auction-banner">
      {(a.thumb_url ?? a.thumbs?.[0]) && <img src={a.thumb_url ?? a.thumbs![0]} alt="" />}
      <div className="banner-main">
        <div className="tags">
          {unreserved && <span className="tag">Unreserved</span>}
          {reason && <span className="tag reason">{reason}</span>}
          <span className={`tag ${a.live ? (tl.urgent ? "urgent" : "") : ""}`}>{a.live ? (tl.over ? "Closing now" : `Closes in ${tl.text.replace(" left", "")}`) : `Closed ${nzShort(a.last_closed ?? a.ends_at)}`}</span>
        </div>
        <h2 title={a.title}>{headline}</h2>
        <p className="muted small">
          {[a.address, location ?? a.city, a.postcode].filter(Boolean).join(", ")}
          {closingWindow(a) ? ` · ${a.live ? "closes" : "closed"} ${closingWindow(a)}` : ""}
          {a.premium_rate !== null ? ` · ${a.premium_rate}% premium + GST` : ""}
        </p>
        {a.instructions && <p className="muted small">{a.instructions}</p>}
      </div>
      <div className="banner-side">
        <div className="banner-stats">
          <span><b>{a.lots.toLocaleString()}</b> lots</span>
          <span><b>{a.bids.toLocaleString()}</b> bids</span>
          {a.live ? <span><b>{a.good_value}</b> good value</span> : <span><b>{money(a.sold_total)}</b> sold</span>}
        </div>
        <div className="banner-actions">
          {a.url && <a className="ghost" href={a.url} target="_blank" rel="noreferrer">number8.bid ↗</a>}
          <button className="ghost" onClick={onClear}>Show all lots ✕</button>
        </div>
      </div>
    </section>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="10" r="2.5" fill="currentColor" />
    </svg>
  );
}
