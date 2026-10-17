import { useEffect, useMemo, useState } from "react";
import { DEVICE_LABEL, FAULT_LABEL } from "../shared/specs/computer.ts";
import { api, type Facet, type Lot, type SearchResult, type Summary } from "./api.ts";
import { gb, money, nzDate, timeLeft } from "./format.ts";

export const MAJOR = new Set(["wont-boot", "no-power", "locked", "screen", "damaged", "unknown"]);

export function useNow(fast = false) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 15000);
    return () => clearInterval(t);
  }, [fast]);
  return now;
}

interface Props {
  page: "deals" | "history" | "watch";
  params: URLSearchParams;
  setParams: (mut: (p: URLSearchParams) => void, replace?: boolean) => void;
  openLot: (id: number) => void;
  summary: Summary | null;
  scanFinished: string | null;
}

export function Feed({ page, params, setParams, openLot, summary, scanFinished }: Props) {
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const now = useNow(true);

  // The query sent to the API: the URL's filters plus the page's own scope.
  const qs = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete("lot");
    if (page === "history") p.set("status", "closed");
    else if (page === "watch") {
      p.set("status", "all");
      p.set("watch", "1");
    } else p.set("status", "live");
    if (!params.has("it") && page !== "watch") p.set("it", "1");
    if (p.get("it") === "0") p.delete("it");
    return p.toString();
  }, [params, page]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.lots(qs)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [qs, scanFinished]);

  const set = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null || value === "") p.delete(key);
      else p.set(key, value);
      p.delete("page");
    }, true);
  const toggleIn = (key: string, value: string) => {
    const cur = new Set((params.get(key) ?? "").split(",").filter(Boolean));
    if (cur.has(value)) cur.delete(value);
    else cur.add(value);
    set(key, [...cur].join(","));
  };
  const itOnly = page !== "watch" && params.get("it") !== "0";
  const sort = params.get("sort") ?? (page === "history" ? "ended" : "closing");
  const pageNo = Number(params.get("page") ?? 1);
  const pages = data ? Math.ceil(data.total / data.perPage) : 0;
  const anyFilter = [...params.keys()].some((k) => !["lot", "sort", "page"].includes(k));

  return (
    <div className="feed">
      <button className="filters-toggle" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
        {showFilters ? "Hide filters" : "Filters"}{anyFilter ? " · on" : ""}
      </button>
      <aside className={`filters ${showFilters ? "open" : ""}`} aria-label="Filters">
        {page !== "watch" && (
          <div className="seg" role="group" aria-label="Scope">
            <button className={itOnly ? "on" : ""} onClick={() => set("it", null)}>Computers &amp; IT</button>
            <button className={!itOnly ? "on" : ""} onClick={() => set("it", "0")}>All categories</button>
          </div>
        )}
        {data && itOnly && <FacetList title="Type" facet={data.facets.type} param="type" params={params} toggle={toggleIn} label={(v) => DEVICE_LABEL[v] ?? v} />}
        {data && !itOnly && <FacetList title="Category" facet={data.facets.category} param="category" params={params} toggle={toggleIn} />}
        {data && <FacetList title="Make" facet={data.facets.make} param="make" params={params} toggle={toggleIn} limit={8} />}
        {data && itOnly && <FacetList title="Processor" facet={data.facets.cpu} param="cpu" params={params} toggle={toggleIn} label={cpuLabel} limit={8} />}
        {itOnly && (
          <div className="fgroup">
            <h4>Specs</h4>
            <Select label="Intel gen" value={params.get("minGen")} onChange={(v) => set("minGen", v)} options={[["", "Any"], ["6", "6th+"], ["8", "8th+"], ["10", "10th+"], ["11", "11th+"], ["12", "12th+"]]} />
            <Select label="RAM" value={params.get("minRam")} onChange={(v) => set("minRam", v)} options={[["", "Any"], ["8", "8 GB+"], ["16", "16 GB+"], ["32", "32 GB+"], ["64", "64 GB+"]]} />
            <Select label="Storage" value={params.get("minStorage")} onChange={(v) => set("minStorage", v)} options={[["", "Any"], ["240", "240 GB+"], ["500", "500 GB+"], ["1000", "1 TB+"], ["2000", "2 TB+"]]} />
            <label className="check"><input type="checkbox" checked={params.get("ssd") === "1"} onChange={(e) => set("ssd", e.target.checked ? "1" : null)} /> SSD only</label>
          </div>
        )}
        <div className="fgroup">
          <h4>Condition</h4>
          {([["any", "Any"], ["minor", "No major faults"], ["none", "No faults listed"]] as const).map(([v, l]) => (
            <label key={v} className="radio"><input type="radio" name="faults" checked={(params.get("faults") ?? "any") === v} onChange={() => set("faults", v === "any" ? null : v)} /> {l}</label>
          ))}
        </div>
        <div className="fgroup">
          <h4>Price</h4>
          <MaxPrice value={params.get("maxAllIn")} onChange={(v) => set("maxAllIn", v)} />
          {page === "deals" && (
            <Select label="Closing" value={params.get("closingHours")} onChange={(v) => set("closingHours", v)} options={[["", "Any time"], ["2", "Within 2 hours"], ["24", "Within 24 hours"], ["72", "Within 3 days"], ["168", "Within a week"]]} />
          )}
        </div>
        {anyFilter && <button className="link" onClick={() => setParams((p) => { for (const k of [...p.keys()]) if (k !== "lot") p.delete(k); })}>Clear all filters</button>}
      </aside>

      <section className="results">
        <div className="results-head">
          <div>
            <h1>{page === "history" ? "Past sales" : page === "watch" ? "Watchlist" : itOnly ? "Live computer & IT lots" : "All live lots"}</h1>
            <p className="sub">
              {data ? `${data.total.toLocaleString()} ${data.total === 1 ? "lot" : "lots"}` : "Loading…"}
              {page === "history" && summary ? ` · from ${summary.sold.toLocaleString()} recorded final bids` : ""}
              {page === "deals" && summary ? ` · ${summary.live_auctions} live auctions on number8.bid` : ""}
              {params.get("q") ? ` · matching “${params.get("q")}”` : ""}
            </p>
          </div>
          <Select
            label="Sort"
            value={sort}
            onChange={(v) => set("sort", v)}
            options={page === "history"
              ? [["ended", "Most recent"], ["price", "Lowest final"], ["bids", "Most bids"]]
              : [["closing", "Closing soonest"], ["deal", "Best vs past sales"], ["price", "Lowest all-in"], ["bids", "Most bids"], ["newest", "Newest"]]}
          />
        </div>
        {error && <p className="err">{error}</p>}
        {data && !data.items.length && !loading && <Empty page={page} summary={summary} />}
        <ol className={`lots ${loading ? "loading" : ""}`}>
          {data?.items.map((l) => <LotRow key={l.id} lot={l} now={now} onOpen={() => openLot(l.id)} />)}
        </ol>
        {pages > 1 && (
          <div className="pager">
            <button disabled={pageNo <= 1} onClick={() => setParams((p) => p.set("page", String(pageNo - 1)))}>Previous</button>
            <span>Page {pageNo} of {pages}</span>
            <button disabled={pageNo >= pages} onClick={() => setParams((p) => p.set("page", String(pageNo + 1)))}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}

const cpuLabel = (v: string) => (/^i[3579]$/.test(v) ? `Core ${v}` : v.replace(/\b\w/g, (c) => c.toUpperCase()).replace("Apple M", "Apple M-series"));

function FacetList({ title, facet, param, params, toggle, label = (v) => v, limit = 12 }: {
  title: string; facet: Facet[]; param: string; params: URLSearchParams; toggle: (k: string, v: string) => void; label?: (v: string) => string; limit?: number;
}) {
  const [more, setMore] = useState(false);
  const chosen = new Set((params.get(param) ?? "").split(",").filter(Boolean));
  if (!facet.length && !chosen.size) return null;
  const shown = more ? facet : facet.slice(0, limit);
  for (const c of chosen) if (!shown.some((f) => f.value === c)) shown.push({ value: c, n: 0 });
  return (
    <div className="fgroup">
      <h4>{title}</h4>
      {shown.map((f) => (
        <label key={f.value} className="check">
          <input type="checkbox" checked={chosen.has(f.value)} onChange={() => toggle(param, f.value)} />
          <span className="fl">{label(f.value)}</span>
          <span className="count">{f.n}</span>
        </label>
      ))}
      {facet.length > limit && <button className="link" onClick={() => setMore(!more)}>{more ? "Fewer" : `${facet.length - limit} more`}</button>}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string) => void; options: ReadonlyArray<readonly [string, string]> }) {
  return (
    <label className="select">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function MaxPrice({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return (
    <form className="maxprice" onSubmit={(e) => { e.preventDefault(); onChange(v.trim() || null); }}>
      <span>Max all-in</span>
      <div><b>$</b><input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))} onBlur={() => onChange(v.trim() || null)} placeholder="any" /></div>
    </form>
  );
}

export function specChips(l: Pick<Lot, "device_type" | "cpu" | "ram_gb" | "storage_gb" | "storage_type" | "screen_in" | "gpu">) {
  const chips: string[] = [];
  if (l.device_type) chips.push(DEVICE_LABEL[l.device_type] ?? l.device_type);
  if (l.cpu) chips.push(l.cpu);
  if (l.ram_gb) chips.push(`${l.ram_gb} GB RAM`);
  if (l.storage_gb !== null && l.storage_gb !== undefined) chips.push(l.storage_gb === 0 ? "No drive" : `${gb(l.storage_gb)}${l.storage_type && l.storage_type !== "unknown" && l.storage_type !== "none" ? " " + (l.storage_type === "emmc" ? "flash" : l.storage_type.toUpperCase()) : ""}`);
  if (l.screen_in) chips.push(`${l.screen_in}″`);
  if (l.gpu) chips.push(l.gpu);
  return chips;
}

export function DealBadge({ lot }: { lot: Lot }) {
  if (!lot.comp_n || lot.comp_p50 === null) return null;
  const allIn = lot.all_in ?? 0;
  const live = lot.status === "open";
  let tone = "neutral";
  let text = `Past finals ${money(lot.comp_p25)}–${money(lot.comp_p75)}`;
  if (lot.comp_n < 3) text = `${lot.comp_n} past sale${lot.comp_n > 1 ? "s" : ""}: ${money(lot.comp_p50)}`;
  if (lot.comp_n >= 3 && lot.comp_p25 !== null && lot.comp_p75 !== null) {
    if (!live && allIn < lot.comp_p25) tone = "good";
    if (!live && allIn > lot.comp_p75) tone = "high";
    if (live && (lot.bid_count ?? 0) > 0 && allIn > lot.comp_p75) tone = "high";
  }
  return (
    <span className={`deal ${tone}`} title={`${lot.comp_n} closed number8 lots, ${lot.comp_kind === "similar" ? "similar spec" : "same machine"}; all-in final prices. Median ${money(lot.comp_p50)}.`}>
      {text}
      <small>{lot.comp_kind === "similar" ? "similar" : "same"} · {lot.comp_n}</small>
    </span>
  );
}

function LotRow({ lot, now, onOpen }: { lot: Lot; now: number; onOpen: () => void }) {
  const tl = timeLeft(lot.ends_at, now);
  const chips = specChips(lot);
  const closed = lot.status === "closed";
  return (
    <li className={`lot ${lot.watched ? "watched" : ""}`}>
      <button className="lot-hit" onClick={onOpen} aria-label={`Open ${lot.title}`} />
      <div className="thumb">{lot.thumb_url ? <img src={lot.thumb_url} alt="" loading="lazy" /> : <span>No photo</span>}</div>
      <div className="lot-main">
        <h3>{lot.title}</h3>
        {chips.length > 0 && <div className="chips">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
        {lot.faults.length > 0 && (
          <div className="faults">
            {lot.faults.map((f) => <span key={f} className={`fault ${MAJOR.has(f) ? "major" : ""}`}>{FAULT_LABEL[f] ?? f}</span>)}
          </div>
        )}
        <p className="meta">
          Lot {lot.lot_number ?? "–"} · {lot.auction_title.replace(/\s+-\s+[^-]+$/, "")}{lot.city ? ` · ${lot.city}` : ""}
          {lot.quantity && lot.quantity > 1 ? ` · qty ${lot.quantity}` : ""}
        </p>
      </div>
      <div className="lot-price">
        <div className="allin">{money(lot.all_in)}</div>
        <div className="allin-label">{closed ? "final, all-in" : "all-in now"}{lot.gst_assumed ? "*" : ""}</div>
        <div className="bid">
          {closed
            ? lot.final_bid ? `Final bid ${money(lot.final_bid)} · ${lot.bid_count} bids` : "No bids"
            : (lot.bid_count ?? 0) > 0 ? `Bid ${money(lot.current_bid)} · ${lot.bid_count} bid${lot.bid_count === 1 ? "" : "s"}` : `No bids · starts ${money(lot.starting_bid)}`}
        </div>
        <div className={`left ${tl.urgent ? "urgent" : ""}`} title={nzDate(lot.ends_at)}>
          {closed ? `Closed ${nzDate(lot.closed_at, false)}` : tl.text}
        </div>
        <DealBadge lot={lot} />
      </div>
    </li>
  );
}

function Empty({ page, summary }: { page: string; summary: Summary | null }) {
  if (summary && summary.live + summary.closed === 0)
    return (
      <div className="empty">
        <h2>No lots yet</h2>
        <p>Press <b>Scan now</b> to read number8.bid's live auctions. Then read past sales on the Scans page to build price history.</p>
      </div>
    );
  return (
    <div className="empty">
      <h2>{page === "watch" ? "Nothing on your watchlist" : "No lots match"}</h2>
      <p>{page === "watch" ? "Open a lot and press Watch to keep it here." : "Try fewer filters, or All categories."}</p>
    </div>
  );
}
