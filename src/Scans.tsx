import { useEffect, useState } from "react";
import { account, api, type PhotoSummary, type ScanRun, type ScanSettings } from "./api.ts";
import { useNow } from "./Feed.tsx";
import { nzDate } from "./format.ts";

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Scans({ scan, openLot }: { scan: { run: ScanRun | null; active: boolean; refresh: () => void }; openLot: (id: number) => void }) {
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [maxPages, setMaxPages] = useState("200");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [settings, setSettings] = useState<ScanSettings | null>(null);
  useEffect(() => {
    account.settings().then((r) => setSettings(r.scan)).catch(() => {});
  }, []);
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
          <p className="sub">
            {settings?.scheduleEnabled
              ? `Live auctions are scanned every ${settings.liveEveryHours} hour${settings.liveEveryHours === 1 ? "" : "s"}${settings.historyWeekly ? ", plus a weekly past-sales top-up" : ""}, and whenever you start one. `
              : "Scans only run when you start them (schedule off in Settings). "}
            One scan at a time, at most {settings?.concurrency ?? 1} request{(settings?.concurrency ?? 1) === 1 ? "" : "s"} at once with starts at least {(settings?.concurrency ?? 1) > 1 ? "0.3" : "1.2"} s apart, dropping to one at a time when number8.bid is slow (back up after 20 quick replies), and stopping if it asks.
          </p>
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

      <PhotoReading openLot={openLot} refreshKey={scan.run?.photos_read ?? 0} />

      <h2 className="h2">Recent scans</h2>
      <div className="table-wrap">
      <table className="table">
        <thead><tr><th>#</th><th>Kind</th><th>Started</th><th>Result</th><th className="r">Requests</th><th className="r">Lots</th><th className="r">New</th><th className="r">Changed</th><th className="r">Closed</th><th className="r">Photos</th><th>Note</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="muted num">{r.id}</td>
              <td className="nowrap"><b>{r.kind === "live" ? "Live" : "Past sales"}</b>{r.trigger === "schedule" ? <div className="muted small">scheduled</div> : null}</td>
              <td className="nowrap">{nzDate(r.started_at ?? r.created_at)}</td>
              <td><span className={`state ${r.state}`}>{r.state}</span></td>
              <td className="r num">{r.requests}{r.retries ? <small className="muted"> ({r.retries} retried)</small> : null}</td>
              <td className="r num">{r.lots_seen.toLocaleString()}</td>
              <td className="r num">{r.lots_new.toLocaleString()}</td>
              <td className="r num">{r.lots_changed.toLocaleString()}</td>
              <td className="r num">{r.lots_closed.toLocaleString()}</td>
              <td className="r num">{r.photos_read ? r.photos_read.toLocaleString() : <span className="muted">–</span>}</td>
              <td className="small muted">{r.stop_reason ?? r.last_error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function Bar({ label, done, total }: { label: string; done: number; total: number | null }) {
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

const PHOTO_FIELD: Record<string, string> = { cpu: "CPU", ramGb: "RAM", storage: "Storage" };

/** Where and when reading specs from photos has worked (server/photo-summary.ts). */
function PhotoReading({ openLot, refreshKey }: { openLot: (id: number) => void; refreshKey: number }) {
  const [s, setS] = useState<PhotoSummary | null>(null);
  useEffect(() => {
    api.photoSummary().then(setS).catch(() => {});
  }, [refreshKey]);
  if (!s) return null;
  return (
    <section className="photo-reading">
      <h2 className="h2">Specs read from photos</h2>
      <p className="sub">
        {s.available ? "OCR is installed." : "OCR (tesseract) isn't installed here, so scans skip photos. The hosted Docker image includes it."}{" "}
        After each live scan, computer lots missing a CPU model, RAM or storage have up to 3 photos read. A value needs {s.minConfidence}% confidence and only fills a spec the listing left out.
      </p>
      <dl className="auction-stats photo-stats">
        <div><dt>Lots read</dt><dd>{s.lots_read.toLocaleString()}</dd></div>
        <div><dt>Photos read</dt><dd>{s.photos_read.toLocaleString()}</dd></div>
        <div className={s.lots_with_values ? "good" : ""}><dt>Found specs</dt><dd>{s.lots_with_values.toLocaleString()}</dd></div>
        <div className={s.lots_using ? "good" : ""}><dt>Specs used</dt><dd>{s.lots_using.toLocaleString()}</dd></div>
        <div><dt>Waiting</dt><dd>{s.waiting.toLocaleString()}</dd></div>
      </dl>
      {s.recent.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Lot</th><th>Read</th><th className="r">Photos</th><th>Found</th></tr></thead>
            <tbody>
              {s.recent.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => openLot(r.id)}>
                  <td>
                    <div className="cell-lot">
                      {r.thumb_url ? <img src={r.thumb_url} alt="" loading="lazy" /> : <span className="no-thumb" />}
                      <div><span className="link strong">{r.title}</span>{r.status === "closed" && <div className="muted small">closed</div>}</div>
                    </div>
                  </td>
                  <td className="nowrap">{nzDate(r.read_at)}</td>
                  <td className="r num">{r.photos}</td>
                  <td>
                    {r.found.length === 0 ? <span className="muted">No spec text</span> : (
                      <div className="cell-tags">
                        {r.found.map((f, i) => (
                          <span key={i} className={`chip ${r.photo_fields.includes(f.field) ? "used" : "quiet"}`} title={`${Math.round(f.confidence)}% confident${r.photo_fields.includes(f.field) ? ", used because the listing didn't say" : ", not used: the listing already says"}`}>
                            {PHOTO_FIELD[f.field] ?? f.field} {f.value}{r.photo_fields.includes(f.field) ? " ✓" : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No photos read yet.{s.available ? " The next live scan reads them." : ""}</p>}
      <p className="footnote">✓ = used to fill a spec the listing left out. Open a lot to see the photo with the words boxed.</p>
    </section>
  );
}
