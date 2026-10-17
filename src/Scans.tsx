import { useEffect, useState } from "react";
import { api, type ScanRun } from "./api.ts";
import { useNow } from "./Feed.tsx";
import { nzDate } from "./format.ts";

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Scans({ scan }: { scan: { run: ScanRun | null; active: boolean; refresh: () => void } }) {
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [maxPages, setMaxPages] = useState("200");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.scans().then((r) => setRuns(r.runs)).catch(() => {});
  }, [scan.run?.state, scan.run?.pages_read, scan.run?.details_read]);

  const start = async (kind: "live" | "history", resume = false) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.startScan({ kind, resume, options: kind === "history" ? { maxPages: Number(maxPages) || undefined } : {} });
      if (r.reused) setMsg("A scan is already running; it was not restarted.");
      scan.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lastHistory = runs.find((r) => r.kind === "history");
  const canResume = lastHistory && ["partial", "cancelled", "failed"].includes(lastHistory.state);

  return (
    <div className="scans">
      <div className="scan-head">
        <div>
          <h1>Scans</h1>
          <p className="sub">Scans only run when you start them. One at a time, at least 1.2 s between requests, slowing down when number8.bid is slow, and stopping if it asks.</p>
        </div>
      </div>

      {scan.run && <LiveCard run={scan.run} onStop={() => api.cancelScan(scan.run!.id).then(scan.refresh)} />}

      <div className="scan-actions">
        <div className="action">
          <h3>Live auctions</h3>
          <p>Lists every live auction (and those that ended in the last 3 days, to record final bids), reads every lot, and opens new or changed lots for photos, bid history and payment terms. Usually 10–20 minutes the first time, a few minutes after that.</p>
          <button className="primary" disabled={scan.active || busy} onClick={() => start("live")}>Scan live auctions</button>
        </div>
        <div className="action">
          <h3>Past sales</h3>
          <p>Reads number8.bid's past sales, 60 lots a page, for the final bids that price history is built from. About 2,200 pages in all; run it in chunks and continue later.</p>
          <div className="row">
            <label className="select"><span>Pages this run</span>
              <select value={maxPages} onChange={(e) => setMaxPages(e.target.value)}>
                <option value="50">50 (~1 min)</option><option value="200">200 (~5 min)</option><option value="500">500 (~12 min)</option><option value="0">All remaining</option>
              </select>
            </label>
            <button className="primary" disabled={scan.active || busy} onClick={() => start("history", !!canResume)}>
              {canResume ? `Continue from page ${lastHistory?.cursor?.page ?? "?"}` : "Read past sales"}
            </button>
          </div>
        </div>
      </div>
      {msg && <p className="err">{msg}</p>}

      <h2 className="h2">Recent scans</h2>
      <table className="runs">
        <thead><tr><th>#</th><th>Kind</th><th>Started</th><th>Result</th><th className="r">Requests</th><th className="r">Lots</th><th className="r">New</th><th className="r">Changed</th><th className="r">Closed</th><th>Note</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.kind === "live" ? "Live" : "Past sales"}</td>
              <td>{nzDate(r.started_at ?? r.created_at)}</td>
              <td><span className={`state ${r.state}`}>{r.state}</span></td>
              <td className="r">{r.requests}{r.retries ? <small className="muted"> ({r.retries} retried)</small> : null}</td>
              <td className="r">{r.lots_seen.toLocaleString()}</td>
              <td className="r">{r.lots_new.toLocaleString()}</td>
              <td className="r">{r.lots_changed.toLocaleString()}</td>
              <td className="r">{r.lots_closed.toLocaleString()}</td>
              <td className="small">{r.stop_reason ?? r.last_error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ label, done, total }: { label: string; done: number; total: number | null }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="bar">
      <div className="bar-label"><span>{label}</span><span>{done.toLocaleString()}{total ? ` / ${total.toLocaleString()}` : ""}</span></div>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${total ? pct : 4}%` }} /></div>
    </div>
  );
}

function LiveCard({ run, onStop }: { run: ScanRun; onStop: () => void }) {
  const now = useNow(true);
  const active = run.state === "queued" || run.state === "running";
  const started = run.started_at ? new Date(run.started_at).getTime() : now;
  const elapsed = (run.finished_at ? new Date(run.finished_at).getTime() : now) - started;
  const stages = run.kind === "live" ? ["auctions", "lots", "details", "finish"] : ["pages", "finish"];
  const stageIdx = run.phase === "done" ? stages.length : stages.indexOf(run.phase === "queued" ? stages[0]! : run.phase);
  let eta = "";
  if (active && run.kind === "live" && run.phase === "details" && run.details_read > 5) {
    const per = elapsed / Math.max(1, run.requests);
    eta = ` · about ${clock((run.details_total - run.details_read) * per)} to go`;
  }
  if (active && run.kind === "history" && run.pages_total && run.pages_read > 3) {
    const per = elapsed / run.pages_read;
    const limit = Number(run.options?.maxPages) || run.pages_total;
    eta = ` · about ${clock((Math.min(limit, run.pages_total - (run.cursor?.page ?? 0)) - run.pages_read) * per)} to go`;
  }
  return (
    <section className={`live ${active ? "on" : ""}`}>
      <div className="live-top">
        <span className={`badge ${active ? "pulse" : ""}`}>{active ? "LIVE" : run.state.toUpperCase()}</span>
        <h3>{run.kind === "live" ? "Live auctions scan" : "Past sales scan"} #{run.id}</h3>
        <span className="muted">{clock(elapsed)}{eta}</span>
        {active && <button className="ghost" onClick={onStop}>Stop</button>}
      </div>
      <ol className="stages">
        {stages.map((s, i) => <li key={s} className={i < stageIdx ? "done" : i === stageIdx ? "now" : ""}>{({ auctions: "Find auctions", lots: "Read lots", details: "Open lot pages", pages: "Read past sales", finish: "Price history" } as Record<string, string>)[s]}</li>)}
      </ol>
      <div className="bars">
        {run.kind === "live" ? (
          <>
            <Bar label="Auctions read" done={run.auctions_listed} total={run.auctions_queued || null} />
            <Bar label="Lot pages opened" done={run.details_read} total={run.details_total || null} />
          </>
        ) : (
          <Bar label="Past-sales pages" done={run.pages_read} total={Number(run.options?.maxPages) || run.pages_total} />
        )}
      </div>
      <div className="counts">
        <span><b>{run.lots_seen.toLocaleString()}</b> lots read</span>
        <span><b>{run.lots_new.toLocaleString()}</b> new</span>
        <span><b>{run.lots_changed.toLocaleString()}</b> changed</span>
        <span><b>{run.observations.toLocaleString()}</b> bid moves</span>
        <span><b>{run.lots_closed.toLocaleString()}</b> closed</span>
        <span><b>{run.requests.toLocaleString()}</b> requests</span>
        <span className={run.retries ? "warn" : ""}><b>{run.retries}</b> retries</span>
        <span className={run.throttles ? "warn" : ""}><b>{run.throttles}</b> slow-downs</span>
      </div>
      {run.ticker.length > 0 && (
        <ul className="ticker">{run.ticker.map((t, i) => <li key={i}><span className="muted">{new Date(t.at).toLocaleTimeString("en-NZ", { timeZone: "Pacific/Auckland" })}</span> {t.text}</li>)}</ul>
      )}
      {(run.stop_reason || run.last_error) && <p className="small warn">{run.stop_reason ?? run.last_error}</p>}
    </section>
  );
}
