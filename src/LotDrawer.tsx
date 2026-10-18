import { useEffect, useRef, useState } from "react";
import { FAULT_LABEL } from "../shared/specs/computer.ts";
import { api, type Auction, type Citation, type LotDetail, type SpecValue, type TradeMeItem, type TradeMeLookup, type TradeMeState } from "./api.ts";
import { auctionParts, saleReason } from "./auction.ts";
import { lookupQuery } from "./lookup.ts";
import { closingWindow, payBy } from "./Auctions.tsx";
import { DealBadge, MAJOR, specChips, useNow } from "./Feed.tsx";
import { money, nzDate, nzShort, timeLeft } from "./format.ts";

const FIELD_LABEL: Record<string, string> = {
  deviceType: "Type", make: "Make", model: "Model", cpu: "Processor", cpuFamily: "CPU family", cpuGen: "Generation",
  ramGb: "Memory", storage: "Storage", screenIn: "Screen", gpu: "Graphics", os: "Operating system", fault: "Fault",
  faultsListed: "Faults",
};
const SPEC_ORDER = ["deviceType", "make", "model", "cpu", "cpuGen", "ramGb", "storage", "screenIn", "gpu", "os", "faultsListed", "fault"];

type CiteRequest = { title: string; load: () => Promise<Citation> };

export function LotDrawer({ id, onClose, onOpenLot, onOpenAuction }: {
  id: number; onClose: () => void; onOpenLot: (id: number) => void; onOpenAuction: (a: Pick<Auction, "id" | "live">) => void;
}) {
  const [d, setD] = useState<LotDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cite, setCite] = useState<CiteRequest | null>(null);
  const [img, setImg] = useState(0);
  const [watched, setWatched] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const now = useNow(true);

  useEffect(() => {
    setD(null);
    setCite(null);
    setImg(0);
    api.lot(id).then((x) => { setD(x); setWatched(x.lot.watched); }).catch((e) => setErr(e.message));
  }, [id, reload]);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      await api.refreshLot(id);
      setRefreshMsg(`Checked number8.bid at ${new Date().toLocaleTimeString("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit" })}`);
      setReload((n) => n + 1);
    } catch (e) {
      setRefreshMsg((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (cite ? setCite(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cite, onClose]);

  const l = d?.lot;
  const tl = l ? timeLeft(l.ends_at, now) : null;
  const specs = d ? [...d.specs].filter((s) => s.field !== "cpuFamily").sort((a, b) => SPEC_ORDER.indexOf(a.field) - SPEC_ORDER.indexOf(b.field)) : [];
  const lastObs = d?.observations.at(-1);
  const images = l?.images?.length ? l.images : l?.thumb_url ? [l.thumb_url] : [];
  const toggleWatch = async () => {
    if (!l) return;
    if (watched) await api.unwatch(l.id);
    else await api.watch(l.id);
    setWatched(!watched);
  };

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="Lot details">
        <div className="drawer-bar">
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
          {l && (
            <span className="bar-title">
              Lot {l.lot_number} ·{" "}
              <button className="link" onClick={() => onOpenAuction({ id: l.auction_id, live: l.status === "open" })} title={l.auction_title}>{auctionParts(l.auction_title).headline}</button>
            </span>
          )}
          {l && <button className={`watch ${watched ? "on" : ""}`} onClick={toggleWatch}>{watched ? "★ Favourite" : "☆ Favourite"}</button>}
        </div>
        {err && <p className="err">{err}</p>}
        {!d && !err && <p className="pad muted">Loading…</p>}
        {l && d && (
          <div className="drawer-body">
            {images.length > 0 && (
              <div className="gallery">
                <img src={images[img]} alt={l.title} />
                {images.length > 1 && (
                  <div className="strip">
                    {images.map((u, i) => <button key={u} className={i === img ? "on" : ""} onClick={() => setImg(i)}><img src={u} alt="" loading="lazy" /></button>)}
                  </div>
                )}
              </div>
            )}
            <h2 className="lot-title">{l.title}</h2>
            {l.photo_fields.length > 0 && <p className="small muted">{l.photo_fields.map((f) => FIELD_LABEL[f] ?? f).join(", ")} read from the photos (see below).</p>}
            <div className="chips">
              {specChips(l).map((c) => <span key={c} className="chip">{c}</span>)}
              {l.faults.map((f) => <span key={f} className={`fault ${MAJOR.has(f) ? "major" : ""}`}>{FAULT_LABEL[f] ?? f}</span>)}
            </div>

            <section className="pricebox">
              <div>
                <div className="allin big">{money(l.all_in, true)}</div>
                <div className="allin-label">{l.status === "closed" ? "Final price, all-in" : "All-in at the current bid"}</div>
              </div>
              <div className="breakdown">
                {l.status === "closed" ? (
                  <Cited label="Final bid" value={l.final_bid ? money(l.final_bid, true) : "No bids"}
                    onCite={l.outcome_snapshot_id ? () => setCite({ title: "Final bid", load: () => api.field(l.outcome_snapshot_id!, `${l.outcome_path}.current_bid`) }) : undefined} />
                ) : (
                  <Cited label={(l.bid_count ?? 0) > 0 ? `Current bid (${l.bid_count})` : "Starting bid"} value={money(l.price, true)}
                    onCite={lastObs ? () => setCite({ title: "Current bid", load: () => api.field(lastObs.snapshot_id, `${lastObs.snapshot_path}.${(l.bid_count ?? 0) > 0 ? "current_bid" : "starting_bid"}`) }) : undefined} />
                )}
                <Cited label={`Buyer's premium ${l.premium_rate}%`} value={money((l.price ?? 0) * l.premium_rate / 100, true)}
                  onCite={d.terms?.premium_rate ? () => setCite({ title: "Buyer's premium", load: () => api.terms(l.auction_id, "premium") }) : undefined} />
                <Cited label={`GST ${l.gst_rate}%${l.gst_assumed ? " (assumed)" : ""}`} value={money((l.price ?? 0) * (1 + l.premium_rate / 100) * l.gst_rate / 100, true)}
                  onCite={!l.gst_assumed ? () => setCite({ title: "GST", load: () => api.terms(l.auction_id, "gst") }) : undefined} />
              </div>
              <div className="when">
                {l.status === "closed" ? (
                  <span>Closed {nzDate(l.closed_at)}</span>
                ) : (
                  <>
                    <span className={tl?.urgent ? "urgent" : ""}>{tl?.text}</span>
                    <span className="muted"> · closes {nzDate(l.ends_at)} (later if bids arrive in the last 5 minutes)</span>
                  </>
                )}
              </div>
              <DealBadge lot={l} />
              {l.item_url && <a className="primary" href={l.item_url} target="_blank" rel="noreferrer">{l.status === "closed" ? "View on number8.bid" : "Bid on number8.bid"} ↗</a>}
            </section>

            {(l.expected_mid !== null || l.spec_score !== null) && (
              <section className="likely">
                <h3>What it's likely to cost</h3>
                {l.expected_mid !== null ? (
                  <p>
                    Expected final <b>{money(l.expected_low)}–{money(l.expected_high)}</b> all-in (middle {money(l.expected_mid)}), from {l.comp_n} past
                    sale{l.comp_n === 1 ? "" : "s"} of {l.comp_kind === "machine" ? "the same machine" : l.comp_kind === "similar" ? "similar machines" : "machines with a similar spec score"}, listed below.
                    {l.status === "open" && (l.all_in ?? 0) >= (l.expected_low ?? 0) ? " The current bid is already in that range." : ""}
                  </p>
                ) : l.status === "open" ? <p className="muted">Not enough past sales to estimate a final price yet.</p> : null}
                {l.value_index !== null && l.comp_kind !== "spec" && (
                  <p>
                    <b>Value {l.value_index}</b>: machines with this spec score typically close at {money(l.spec_p50)} ({l.spec_n} sales).
                    {l.value_index >= 115 ? " This one is expected to cost less than typical for what it is." : l.value_index <= 85 ? " This one usually sells for more than typical for its spec." : " About typical for its spec."}
                  </p>
                )}
                {l.spec_score !== null && l.score_parts && (
                  <details>
                    <summary>Spec score {l.spec_score}{l.score_incomplete ? " (RAM or storage not stated)" : ""}</summary>
                    <ul className="score-parts">
                      {l.score_parts.map((p, i) => <li key={i}><span>{p.label}</span><b>{p.points ? `+${p.points}` : ""}</b></li>)}
                    </ul>
                    <p className="small muted">BidScout's own measure from the cited specs (CPU tier and age, RAM, storage, faults). Not a benchmark.</p>
                  </details>
                )}
              </section>
            )}

            <PriceLookup lot={l} tradeMe={d.tradeMe} onCite={setCite} />

            <section className="social-box">
              <div className="social-head">
                <h3>Friends</h3>
                {l.status === "open" && <button className="ghost small-btn" onClick={refresh} disabled={refreshing}>{refreshing ? "Checking…" : "Refresh now"}</button>}
              </div>
              {refreshMsg && <p className="small muted">{refreshMsg}</p>}
              {l.friend_high_bidder && <p className="friend-line"><b>{l.friend_high_bidder}</b> is the high bidder. Check with them before bidding.</p>}
              {d.friendBids.filter((b) => b.kind === "bid").length > 0 && (
                <ul className="friend-bids">
                  {d.friendBids.filter((b) => b.kind === "bid").slice(0, 8).map((b, i) => (
                    <li key={i}><b>{b.display_name}</b> bid {money(b.amount)}{b.bid_at ? ` · ${nzDate(b.bid_at)}` : ""}</li>
                  ))}
                </ul>
              )}
              {!l.friend_high_bidder && !d.friendBids.length && <p className="small muted">No friends have bid on this lot{l.status === "open" ? " as of the last check" : ""}.</p>}
              <p className="small muted">
                {d.watchers.length ? <>Favourited by {d.watchers.map((w) => w.display_name).join(", ")}.</> : "Nobody has favourited this lot."}
              </p>
            </section>

            <AuctionBox lot={l} terms={d.terms} onOpen={() => onOpenAuction({ id: l.auction_id, live: l.status === "open" })} />

            {specs.length > 0 && (
              <section>
                <h3>Details <small className="muted">each one opens the words it came from</small></h3>
                <table className="specs">
                  <tbody>
                    {specs.map((s) => (
                      <tr key={s.id}>
                        <th>{FIELD_LABEL[s.field] ?? s.field}</th>
                        <td>
                          <button className={`cite ${s.field === "fault" ? "fault-cite" : ""}`} onClick={() => setCite({ title: FIELD_LABEL[s.field] ?? s.field, load: () => api.cite(s.id) })}>
                            {displayValue(s)}
                            <span className="q">“{s.quote.length > 60 ? s.quote.slice(0, 57) + "…" : s.quote}”</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="footnote">Read by code from the listing text; nothing here is guessed. Missing rows were not stated in the listing.</p>
              </section>
            )}

            {d.photoValues.length === 0 && l.photo_ocr_at && (
              <p className="small muted">📷 {l.photos_read || "The"} photo{l.photos_read === 1 ? "" : "s"} checked {nzDate(l.photo_ocr_at)}: no spec text found.</p>
            )}
            {d.photoValues.length > 0 && (
              <section>
                <h3>Read from photos <small className="muted">text found on stickers or screens in the photos</small></h3>
                <table className="specs">
                  <tbody>
                    {d.photoValues.map((v) => (
                      <tr key={v.id}>
                        <th>{FIELD_LABEL[v.field] ?? v.field}{l.photo_fields.includes(v.field) && <span className="from-photo">used</span>}</th>
                        <td>
                          <button className="cite" onClick={() => setCite({ title: `${FIELD_LABEL[v.field] ?? v.field} (photo)`, load: () => api.photoValue(v.id) })}>
                            {v.value}
                            <span className="q">“{v.quote}” · {Math.round(v.confidence)}% confident</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="footnote">Read by OCR. A photo value is only used when the listing doesn't state that spec and the text is at least 60% confident.</p>
              </section>
            )}

            <section>
              <h3>{l.comp_kind === "spec" ? "Past sales with a similar spec" : l.comp_kind === "similar" ? "Past sales of similar machines" : l.is_it ? "Past sales of this machine" : "Past sales"}</h3>
              {d.comps.length === 0 ? (
                <p className="muted">No closed number8 lots with the same {l.is_it ? "machine or similar spec" : "title"} yet. Reading past sales on the Scans page builds this up.</p>
              ) : (
                <>
                  <p className="muted small">{l.comp_kind === "similar" ? "Similar machines (same type, CPU family and generation, RAM band and drive type)" : l.comp_kind === "spec" ? "Similar spec score (same form factor, within half a point)" : "Same make, model, CPU, RAM and storage"}{l.major_fault ? ", also with a major fault" : ", without major faults"}. All-in uses each sale's premium and 15% GST.</p>
                  <div className="table-wrap">
                    <table className="table compact">
                      <thead><tr><th>Lot</th><th>Closed</th><th className="r">Final bid</th><th className="r">All-in</th></tr></thead>
                      <tbody>
                        {d.comps.map((c) => (
                          <tr key={c.id}>
                            <td>
                              <div className="cell-lot">
                                {c.thumb_url ? <img src={c.thumb_url} alt="" loading="lazy" /> : <span className="no-thumb" />}
                                <div>
                                  <button className="link" onClick={() => onOpenLot(c.id)}>{c.title}</button>
                                  {c.faults.length > 0 && <div className="cell-tags">{c.faults.map((f) => <span key={f} className={`fault ${MAJOR.has(f) ? "major" : ""}`}>{FAULT_LABEL[f] ?? f}</span>)}</div>}
                                </div>
                              </div>
                            </td>
                            <td className="nowrap">{nzShort(c.closed_at)}{c.bid_count ? <div className="muted small">{c.bid_count} bids</div> : null}</td>
                            <td className="r num"><button className="cite inline" onClick={() => setCite({ title: "Final bid", load: () => api.field(c.outcome_snapshot_id, `${c.outcome_path}.current_bid`) })}>{money(c.final_bid)}</button></td>
                            <td className="r num"><b>{money(c.all_in)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            {d.observations.length > 1 && (
              <section>
                <h3>Bid movement seen by BidScout</h3>
                <ol className="timeline">
                  {d.observations.map((o) => (
                    <li key={o.id}>
                      <span>{nzDate(o.observed_at)}</span>
                      <button className="cite inline" onClick={() => setCite({ title: "Bid at that time", load: () => api.field(o.snapshot_id, `${o.snapshot_path}.current_bid`) })}>{money(o.current_bid)}</button>
                      <span className="muted">{o.bid_count ?? 0} bids{o.status === "closed" ? " · closed" : ""}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {l.bid_history.length > 0 && (
              <section>
                <h3>Bid history <small className="muted">from the lot page; bidders not stored</small></h3>
                <ol className="timeline">
                  {l.bid_history.slice(0, 12).map((b, i) => <li key={i}><span>{b.at ? nzDate(b.at) : "–"}</span><b>{money(b.bid)}</b></li>)}
                </ol>
              </section>
            )}

            <section>
              <h3>Listing text</h3>
              <pre className="desc">{l.description || "No description."}</pre>
              <p className="small muted">
                Category {l.category ?? "not set"} · first seen {nzDate(l.first_seen)} · {d.revisions.length} listing version{d.revisions.length === 1 ? "" : "s"}
                {l.detail_read_at ? ` · lot page read ${nzDate(l.detail_read_at)}` : ""}
              </p>
            </section>
          </div>
        )}
      </aside>
      {cite && <SourcePanel request={cite} onClose={() => setCite(null)} />}
    </div>
  );
}

function displayValue(s: SpecValue) {
  if (s.field === "cpuGen") {
    const n = Number(s.value);
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
    return `${n}${suffix} gen Intel Core`;
  }
  return s.value;
}

function Cited({ label, value, onCite }: { label: string; value: string; onCite?: () => void }) {
  return (
    <div className="cited-row">
      <span>{label}</span>
      {onCite ? <button className="cite inline" onClick={onCite}>{value}</button> : <b>{value}</b>}
    </div>
  );
}

/** Shows the stored text with the quoted words marked, plus where and when it was fetched. */
function SourcePanel({ request, onClose }: { request: CiteRequest; onClose: () => void }) {
  const [c, setC] = useState<Citation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mark = useRef<HTMLElement>(null);
  useEffect(() => {
    setC(null);
    request.load().then(setC).catch((e) => setErr(e.message));
  }, [request]);
  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center" });
  }, [c]);

  return (
    <aside className="source" aria-label="Source">
      <div className="drawer-bar">
        <button className="icon" onClick={onClose} aria-label="Back">←</button>
        <span className="bar-title">Source · {request.title}</span>
      </div>
      <div className="source-body">
        {err && <p className="err">{err}</p>}
        {!c && !err && <p className="muted">Loading the stored response…</p>}
        {c?.kind === "spec" && (
          <>
            <p className={`verdict ${c.verified ? "ok" : "bad"}`}>
              {c.verified ? "✓ Quote found at its saved position in the stored listing" : "✕ The quote no longer matches the stored text"}
            </p>
            <p className="small muted">{c.value} · read by {c.method.replace("parser:", "")} rules from the lot {c.source}</p>
            <div className="passage">
              {c.start > 0 && <span className="dim">{c.text.slice(0, c.start)}</span>}
              <mark ref={mark}>{c.text.slice(c.start, c.end)}</mark>
              <span className="dim">{c.text.slice(c.end)}</span>
            </div>
            <p className="small muted">Field <code>{c.path}</code> of the stored response, as cleaned text (HTML removed).</p>
          </>
        )}
        {c?.kind === "photo" && (
          <>
            <p className="verdict ok">Text read from this photo by OCR · {Math.round(c.confidence)}% confident</p>
            <p className="small muted">{c.value} · found as “{c.quote}”</p>
            <div className="photo-cite">
              <img src={c.image} alt="Lot photo" />
              {c.width && c.height && c.boxes.map(([x, y, w, h], i) => (
                <span key={i} className="box" ref={i === 0 ? (mark as React.RefObject<HTMLSpanElement>) : undefined}
                  style={{ left: `${(x / c.width!) * 100}%`, top: `${(y / c.height!) * 100}%`, width: `${(w / c.width!) * 100}%`, height: `${(h / c.height!) * 100}%` }} />
              ))}
            </div>
            <dl className="meta-list">
              <dt>Photo</dt><dd><a href={c.imageUrl} target="_blank" rel="noreferrer">Original on number8.bid ↗</a></dd>
              <dt>Read</dt><dd>{nzDate(c.readAt)} · <code>{c.ocr}</code></dd>
              <dt>Stored copy</dt><dd><code>sha256 {c.sha256.slice(0, 16)}…</code></dd>
            </dl>
          </>
        )}
        {c?.kind === "field" && (
          <>
            <p className="verdict ok">Value as published in the stored response</p>
            <div className="passage mono">
              <div><span className="dim">{c.path} = </span><mark ref={mark}>{JSON.stringify(c.value)}</mark></div>
              {c.context && Object.entries(c.context).map(([k, v]) => <div key={k} className="dim">{k}: {JSON.stringify(v)}</div>)}
            </div>
          </>
        )}
        {c?.kind === "external" && (
          <>
            <p className="verdict ok">Price found on the {c.site} listing page</p>
            <p className="small muted">{c.value} · the words around it, as read through Firecrawl</p>
            <div className="passage">
              <span className="dim">{c.excerpt.slice(0, c.start)}</span>
              <mark ref={mark}>{c.excerpt.slice(c.start, c.end)}</mark>
              <span className="dim">{c.excerpt.slice(c.end)}</span>
            </div>
            <dl className="meta-list">
              <dt>Page</dt><dd><a href={c.url} target="_blank" rel="noreferrer">Open on {c.site} ↗</a></dd>
              <dt>Read</dt><dd>{nzDate(c.fetchedAt)}</dd>
              <dt>Page text</dt><dd><code>sha256 {c.sha256.slice(0, 16)}…</code><div className="small muted">Only these words were kept, with any contact details removed.</div></dd>
            </dl>
          </>
        )}
        {c && (c.kind === "spec" || c.kind === "field") && (
          <dl className="meta-list">
            <dt>Fetched</dt><dd>{nzDate(c.snapshot.fetchedAt)}</dd>
            <dt>Request</dt><dd><code>{c.snapshot.method} {c.snapshot.url.replace("https://www.number8.bid", "")}</code>{c.snapshot.request && <div><code className="wrap">{decodeURIComponent(c.snapshot.request)}</code></div>}</dd>
            <dt>Stored copy</dt><dd><code>sha256 {c.snapshot.sha256.slice(0, 16)}…</code>{c.snapshot.redactions.length > 0 && <div className="small muted">{c.snapshot.redactions.length} bidder or contact fields removed before storing</div>}</dd>
            {c.kind === "spec" && c.lotUrl && <><dt>Lot</dt><dd><a href={c.lotUrl} target="_blank" rel="noreferrer">Open on number8.bid ↗</a></dd></>}
          </dl>
        )}
      </div>
    </aside>
  );
}

/** The auction this lot is in: where to collect, when it closes, the fees, and links to it. */
function AuctionBox({ lot, terms, onOpen }: { lot: LotDetail["lot"]; terms: LotDetail["terms"]; onOpen: () => void }) {
  const { headline, location, unreserved } = auctionParts(lot.auction_title);
  const reason = saleReason(lot.auction_title, lot.auction_instructions);
  const closes = closingWindow({ ends_at: lot.auction_ends_at, lots_close_at: lot.auction_lots_close_at });
  return (
    <section className="auction-box">
      <h3>Auction</h3>
      <div className="tags">
        {unreserved && <span className="tag">Unreserved</span>}
        {reason && <span className="tag reason">{reason}</span>}
      </div>
      <p className="auction-box-title">{headline}</p>
      <dl className="meta-list wide">
        <dt>Pick up</dt><dd>{[lot.auction_address, location ?? lot.auction_city].filter(Boolean).join(", ") || "Not listed"}</dd>
        {closes && <><dt>{lot.status === "closed" ? "Closed" : "Lots close"}</dt><dd>{closes}</dd></>}
        <dt>Fees</dt><dd>{lot.premium_rate}% buyer's premium + {lot.gst_rate}% GST{lot.gst_assumed ? " (assumed)" : ""}</dd>
        {terms?.payment_due && <><dt>Pay by</dt><dd>{payBy(terms.payment_due)}</dd></>}
        {lot.auction_instructions && <><dt>Seller</dt><dd>{lot.auction_instructions}</dd></>}
      </dl>
      <div className="auction-actions">
        <button className="ghost" onClick={onOpen}>All lots in this auction</button>
        {lot.auction_url && <a className="ghost" href={lot.auction_url} target="_blank" rel="noreferrer">Auction on number8.bid ↗</a>}
      </div>
    </section>
  );
}

/** Links to search other sites for a guide price. BidScout opens them; it doesn't read them. */
function PriceLookup({ lot, tradeMe, onCite }: { lot: LotDetail["lot"]; tradeMe: TradeMeState; onCite: (c: CiteRequest) => void }) {
  const [q, setQ] = useState(() => lookupQuery(lot));
  useEffect(() => setQ(lookupQuery(lot)), [lot.id]);
  const e = encodeURIComponent(q.trim());
  const sites: Array<[string, string, string]> = [
    ["Trade Me", `https://www.trademe.co.nz/a/search?search_string=${e}`, "Listings on now"],
    ["eBay sold", `https://www.ebay.com/sch/i.html?_nkw=${e}&LH_Sold=1&LH_Complete=1`, "What it sold for"],
    ["PriceSpy", `https://pricespy.co.nz/search?search=${e}`, "New price in NZ"],
    ["Google", `https://www.google.com/search?q=${e}`, "Specs and SKU"],
  ];
  return (
    <section className="lookup">
      <h3>Check prices elsewhere</h3>
      <input value={q} onChange={(ev) => setQ(ev.target.value)} aria-label="Search for" spellCheck={false} />
      <div className="lookup-links">
        {sites.map(([name, href, hint]) => (
          <a key={name} href={href} target="_blank" rel="noreferrer" className={!q.trim() ? "disabled" : ""}>
            <b>{name} ↗</b><span>{hint}</span>
          </a>
        ))}
      </div>
      <TradeMePrices lot={lot} state={tradeMe} query={q.trim()} onCite={onCite} />
    </section>
  );
}

const TM_KIND: Record<string, string> = { sold: "Sold", current_bid: "Current bid", buy_now: "Buy Now", asking: "Asking", starting: "Starts at" };
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null;
};

/** The Trade Me prices button and what it found (server/trademe.ts). */
function TradeMePrices({ lot, state, query, onCite }: { lot: LotDetail["lot"]; state: TradeMeState; query: string; onCite: (c: CiteRequest) => void }) {
  const [res, setRes] = useState<TradeMeLookup | null>(state.latest);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ranHere, setRanHere] = useState(0);
  useEffect(() => {
    setRes(state.latest);
    setErr(null);
    setRanHere(0);
  }, [lot.id, state.latest]);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.tradeMe(lot.id, query);
      setRes(r);
      if (!r.cached) setRanHere((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const priced = (res?.items ?? []).filter((i) => i.verified && i.price);
  const isSold = (i: TradeMeItem) => i.status === "sold" || i.price_kind === "sold";
  const sold = priced.filter(isSold).map((i) => Number(i.price));
  const live = priced.filter((i) => !isSold(i)).map((i) => Number(i.price));
  const cite = (i: TradeMeItem) =>
    onCite({
      title: "Trade Me price",
      load: async () => ({ kind: "external", site: "Trade Me", url: i.url, value: `${TM_KIND[i.price_kind ?? ""] ?? "Price"} ${money(i.price)}`, excerpt: i.excerpt!, start: i.quote_start!, end: i.quote_end!, fetchedAt: i.fetched_at, sha256: i.page_sha256 }),
    });
  return (
    <div className="tm">
      <div className="tm-head">
        <button className="primary small-btn" onClick={run} disabled={busy || !query || (!state.available && !res)}>
          {busy ? "Reading Trade Me…" : res ? "Look again" : "Trade Me prices"}
        </button>
        <span className="muted small">{state.available ? `${state.used + ranHere} of ${state.dailyLimit} lookups used today · answers kept 3 days` : state.reason}</span>
      </div>
      {busy && <p className="muted small">Finding listings with a web search, then reading up to 5 of them one at a time. Usually 20–60 seconds.</p>}
      {err && <p className="err small">{err}</p>}
      {res && !busy && (
        <>
          <p className="tm-summary">
            {priced.length === 0
              ? <>No confirmed prices from {res.found} listing{res.found === 1 ? "" : "s"}{res.searched ? ` (${res.searched} search results)` : ""}.</>
              : <>
                  {sold.length > 0 && <>Sold <b>{money(Math.min(...sold))}{sold.length > 1 ? `–${money(Math.max(...sold))}` : ""}</b> ({sold.length}) · </>}
                  {live.length > 0 && <>On now <b>{money(Math.min(...live))}{live.length > 1 ? `–${money(Math.max(...live))}` : ""}</b>, median {money(median(live))} ({live.length})</>}
                  {lot.expected_mid !== null && <> · BidScout expects {money(lot.expected_low)}–{money(lot.expected_high)} all-in here</>}
                </>}
          </p>
          {res.items.length > 0 && (
            <div className="table-wrap">
              <table className="table compact">
                <thead><tr><th>Trade Me listing</th><th>Status</th><th className="r">Price</th></tr></thead>
                <tbody>
                  {res.items.map((i) => (
                    <tr key={i.id} className={i.verified ? "" : "muted"}>
                      <td>
                        <a href={i.url} target="_blank" rel="noreferrer">{i.title ?? `Listing ${i.listing_id}`} ↗</a>
                        <div className="muted small">{[i.condition, i.location, i.bid_count !== null ? `${i.bid_count} bids` : null, i.closes].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="nowrap"><span className={`tag ${i.status === "sold" ? "reason" : ""}`}>{i.status ?? "?"}</span></td>
                      <td className="r num">
                        {i.price === null ? "–" : i.verified
                          ? <button className="cite inline" onClick={() => cite(i)}>{money(i.price)}</button>
                          : <span title="Read by Firecrawl but not found in the page text, so not used">{money(i.price)}?</span>}
                        <div className="muted small">{TM_KIND[i.price_kind ?? ""] ?? ""}{i.buy_now && i.price_kind !== "buy_now" ? ` · Buy Now ${money(i.buy_now)}` : ""}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="footnote">
            Web search for “{res.query}”, {nzDate(res.created_at)}{res.cached ? " (saved answer)" : ""}. Each price opens the words it came from on the listing.
            Greyed prices couldn't be found in the page text and aren't counted. Trade Me prices are asking or sold prices before any fees.
          </p>
        </>
      )}
    </div>
  );
}
