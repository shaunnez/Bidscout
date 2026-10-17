import { useEffect, useRef, useState } from "react";
import { FAULT_LABEL } from "../shared/specs/computer.ts";
import { api, type Citation, type LotDetail, type SpecValue } from "./api.ts";
import { DealBadge, MAJOR, specChips, useNow } from "./Feed.tsx";
import { money, nzDate, nzShort, timeLeft } from "./format.ts";

const FIELD_LABEL: Record<string, string> = {
  deviceType: "Type", make: "Make", model: "Model", cpu: "Processor", cpuFamily: "CPU family", cpuGen: "Generation",
  ramGb: "Memory", storage: "Storage", screenIn: "Screen", gpu: "Graphics", os: "Operating system", fault: "Fault",
  faultsListed: "Faults",
};
const SPEC_ORDER = ["deviceType", "make", "model", "cpu", "cpuGen", "ramGb", "storage", "screenIn", "gpu", "os", "faultsListed", "fault"];

type CiteRequest = { title: string; load: () => Promise<Citation> };

export function LotDrawer({ id, onClose, onOpenLot }: { id: number; onClose: () => void; onOpenLot: (id: number) => void }) {
  const [d, setD] = useState<LotDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cite, setCite] = useState<CiteRequest | null>(null);
  const [img, setImg] = useState(0);
  const [watched, setWatched] = useState(false);
  const now = useNow(true);

  useEffect(() => {
    setD(null);
    setCite(null);
    setImg(0);
    api.lot(id).then((x) => { setD(x); setWatched(x.lot.watched); }).catch((e) => setErr(e.message));
  }, [id]);
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
          {l && <span className="bar-title">Lot {l.lot_number} · {l.auction_title}</span>}
          {l && <button className={`watch ${watched ? "on" : ""}`} onClick={toggleWatch}>{watched ? "★ Watching" : "☆ Watch"}</button>}
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

            <section>
              <h3>Past sales of this machine</h3>
              {d.comps.length === 0 ? (
                <p className="muted">No closed number8 lots with the same {l.is_it ? "machine or similar spec" : "title"} yet. Reading past sales on the Scans page builds this up.</p>
              ) : (
                <>
                  <p className="muted small">{l.comp_kind === "similar" ? "Similar spec (same type, CPU family and generation, RAM band and drive type)" : "Same make, model, CPU, RAM and storage"}{l.major_fault ? ", also with a major fault" : ", without major faults"}. All-in uses each sale's premium and 15% GST.</p>
                  <table className="comps">
                    <thead><tr><th>Closed</th><th>Lot</th><th className="r">Final bid</th><th className="r">All-in</th></tr></thead>
                    <tbody>
                      {d.comps.map((c) => (
                        <tr key={c.id}>
                          <td>{nzShort(c.closed_at)}</td>
                          <td><button className="link" onClick={() => onOpenLot(c.id)}>{c.title}</button>{c.faults.length > 0 && <span className="muted small"> · {c.faults.map((f) => FAULT_LABEL[f] ?? f).join(", ")}</span>}</td>
                          <td className="r"><button className="cite inline" onClick={() => setCite({ title: "Final bid", load: () => api.field(c.outcome_snapshot_id, `${c.outcome_path}.current_bid`) })}>{money(c.final_bid)}</button></td>
                          <td className="r">{money(c.all_in)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
              {d.terms?.payment_due && <p className="small muted">Payment due {d.terms.payment_due}.</p>}
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
        {c?.kind === "field" && (
          <>
            <p className="verdict ok">Value as published in the stored response</p>
            <div className="passage mono">
              <div><span className="dim">{c.path} = </span><mark ref={mark}>{JSON.stringify(c.value)}</mark></div>
              {c.context && Object.entries(c.context).map(([k, v]) => <div key={k} className="dim">{k}: {JSON.stringify(v)}</div>)}
            </div>
          </>
        )}
        {c && (
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
