import { useEffect, useState } from "react";
import { account, type AdminUser, type Me, type ProbeReport, type ScanSettings, type SettingsResponse } from "./api.ts";
import { nzDate } from "./format.ts";

export function Settings({ me }: { me: Me }) {
  const [scan, setScan] = useState<ScanSettings | null>(null);
  const [hours, setHours] = useState<number[]>([]);
  const [tm, setTm] = useState<Pick<SettingsResponse, "trademe" | "trademeLimitOptions" | "trademeKeySet" | "parallelKeySet" | "autoLimitOptions" | "autoProgress"> | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [probeQuery, setProbeQuery] = useState("thinkpad t480");
  const [probe, setProbe] = useState<{ busy: boolean; report: ProbeReport | null; error: string | null }>({ busy: false, report: null, error: null });
  const [nu, setNu] = useState({ username: "", display_name: "", password: "", is_admin: false });

  const load = () => {
    account.settings().then((r) => { setScan(r.scan); setHours(r.liveHourOptions); setTm(r); }).catch(() => {});
    if (me.is_admin) account.users().then((r) => setUsers(r.users)).catch(() => {});
  };
  useEffect(load, [me.is_admin]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const runProbe = async () => {
    setProbe({ busy: true, report: null, error: null });
    try {
      setProbe({ busy: false, report: await account.probeParallel(probeQuery), error: null });
    } catch (e) {
      setProbe({ busy: false, report: null, error: (e as Error).message });
    }
  };
  const saveScan = (patch: Partial<ScanSettings>) => run(() => account.saveSettings(patch), "Scan settings saved.");

  return (
    <div className="panel-page">
      <h1>Settings</h1>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
      {scan && (
        <section className="card">
          <h3>Scans</h3>
          {!me.is_admin && <p className="muted small">Only admins can change these.</p>}
          <label className="check"><input type="checkbox" disabled={!me.is_admin} checked={scan.scheduleEnabled} onChange={(e) => saveScan({ scheduleEnabled: e.target.checked })} /> Scan live auctions automatically</label>
          <label className="select"><span>Every</span>
            <select disabled={!me.is_admin || !scan.scheduleEnabled} value={scan.liveEveryHours} onChange={(e) => saveScan({ liveEveryHours: Number(e.target.value) })}>
              {hours.map((h) => <option key={h} value={h}>{h === 1 ? "hour" : `${h} hours`}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" disabled={!me.is_admin || !scan.scheduleEnabled} checked={scan.historyWeekly} onChange={(e) => saveScan({ historyWeekly: e.target.checked })} /> Top up past sales once a week (stops at sales already stored)</label>
          <label className="select"><span>Requests at a time</span>
            <select disabled={!me.is_admin} value={scan.concurrency} onChange={(e) => saveScan({ concurrency: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <p className="muted small">Starts stay at least 0.3 s apart, and a scan drops to one request at a time if number8.bid slows down or asks us to back off.</p>
        </section>
      )}
      {tm && (
        <section className="card">
          <h3>Trade Me prices</h3>
          <p className="muted small">
            A button on each lot that runs Trade Me's own search for it (one results page, two at most) and reads the listings
            shown: title, price, location and closing date, each price quoted from the results page. It runs when someone
            presses the button (or automatically, below), through Parallel when it's set up, else a plain browser; if Trade Me blocks it, it stops. Answers are reused for 3 days.
            Trade Me's robots.txt asks bots not to use its search pages; you chose to use them for this (18 Oct 2026).
          </p>
          {!tm.trademeKeySet && <p className="warn small">Needs Chromium (included in the Docker image) or a Firecrawl API key (FIRECRAWL_API_KEY).</p>}
          <label className="check">
            <input type="checkbox" disabled={!me.is_admin || !tm.trademeKeySet} checked={tm.trademe.enabled}
              onChange={(e) => run(() => account.saveTradeMe({ enabled: e.target.checked }), e.target.checked ? "Trade Me prices on." : "Trade Me prices off.")} />
            Turn on Trade Me prices
          </label>
          <label className="select"><span>Lookups per day (whole group)</span>
            <select disabled={!me.is_admin} value={tm.trademe.dailyLimit} onChange={(e) => run(() => account.saveTradeMe({ dailyLimit: Number(e.target.value) }), "Saved.")}>
              {tm.trademeLimitOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <p className="muted small">Pasting listing links (reading those listing pages) needs a Firecrawl key. Trade Me's terms still apply; ask them if you plan to use it a lot.</p>
          {tm.parallelKeySet && (
            <div className="probe">
              <h4>Automatic prices</h4>
              <p className="muted small">
                Looks up every open IT lot the way the button would, through Parallel only, one search every 20 seconds or so.
                Lots that need the same search share one answer, and answers are kept for 3 days, then refreshed while the lot is
                still open. New lots are picked up after each scan. If Trade Me refuses Parallel, or lookups keep failing, it turns
                itself off and says why here.
              </p>
              <label className="check">
                <input type="checkbox" disabled={!me.is_admin || !tm.trademe.enabled} checked={tm.trademe.autoEnabled}
                  onChange={(e) => run(() => account.saveTradeMe({ autoEnabled: e.target.checked }), e.target.checked ? "Automatic prices on." : "Automatic prices off.")} />
                Look up open IT lots automatically
              </label>
              <label className="select"><span>Automatic lookups per day</span>
                <select disabled={!me.is_admin} value={tm.trademe.autoDailyLimit} onChange={(e) => run(() => account.saveTradeMe({ autoDailyLimit: Number(e.target.value) }), "Saved.")}>
                  {tm.autoLimitOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <p className="muted small">
                {tm.autoProgress.priced} of {tm.autoProgress.openLots} open IT lots have Trade Me prices · {tm.autoProgress.used} of {tm.autoProgress.dailyLimit} automatic lookups used in the last 24 hours.
                {" "}Each lookup reads one or two pages through Parallel (about $0.001 a page).
              </p>
              {tm.trademe.autoStopped && <p className="warn small">Stopped {nzDate(tm.trademe.autoStopped.at)}: {tm.trademe.autoStopped.reason}</p>}
            </div>
          )}
          {me.is_admin && tm.parallelKeySet && (
            <div className="probe">
              <h4>Test Parallel</h4>
              <p className="muted small">Reads one Trade Me results page through Parallel (from Parallel's servers) and says whether listings and prices came back. Nothing is stored.</p>
              <div className="probe-row">
                <input value={probeQuery} onChange={(e) => setProbeQuery(e.target.value)} placeholder="Search words" aria-label="Search words" />
                <button disabled={probe.busy || !probeQuery.trim()} onClick={runProbe}>{probe.busy ? "Testing… (up to a minute)" : "Test"}</button>
              </div>
              {probe.error && <p className="warn small">{probe.error}</p>}
              {probe.report && (
                <div className="small">
                  <p className={probe.report.verdict === "ok" || probe.report.verdict === "no-results" ? "ok" : "warn"}>
                    <strong>{probe.report.verdict === "ok" ? "Works" : probe.report.verdict === "no-results" ? "Works (no results)" : probe.report.verdict === "blocked" ? "Blocked" : "Didn't work"}</strong>
                    {" "}· {probe.report.message} · {probe.report.status ? `HTTP ${probe.report.status} · ` : ""}{(probe.report.ms / 1000).toFixed(1)} s
                  </p>
                  <p>
                    <a href={probe.report.url} target="_blank" rel="noreferrer">Open the same results page on Trade Me</a> to compare
                    {probe.report.listingUrls.length > 0 && <> · listings found: {probe.report.listingUrls.map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer">{i ? ", " : ""}{i + 1}</a>)}</>}
                  </p>
                  {probe.report.pageStart && <p className="muted">Page started: “{probe.report.pageStart}”</p>}
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {me.is_admin && (
        <section className="card">
          <h3>People</h3>
          <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Username</th><th>Name</th><th>number8 ID</th><th>Last sign-in</th><th>Role</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.disabled ? "muted" : ""}>
                  <td>{u.username}</td>
                  <td>{u.display_name}</td>
                  <td>{[u.n8_username, u.n8_bidder_number].filter(Boolean).join(" · ") || <span className="muted">not set</span>}</td>
                  <td>{u.last_sign_in ? nzDate(u.last_sign_in) : <span className="muted">never</span>}</td>
                  <td>{u.is_admin ? "Admin" : "Member"}{u.disabled ? " · disabled" : ""}</td>
                  <td className="row-actions">
                    {u.id !== me.id && (
                      <>
                        <button className="link" onClick={() => run(() => account.updateUser(u.id, { is_admin: !u.is_admin }), "Role changed.")}>{u.is_admin ? "Make member" : "Make admin"}</button>
                        <button className="link" onClick={() => run(() => account.updateUser(u.id, { disabled: !u.disabled }), u.disabled ? "Enabled." : "Disabled.")}>{u.disabled ? "Enable" : "Disable"}</button>
                      </>
                    )}
                    <button className="link" onClick={() => { const p = prompt(`New password for ${u.username} (8+ characters)`); if (p) run(() => account.updateUser(u.id, { password: p }), "Password reset; they'll need to sign in again."); }}>Reset password</button>
                    {u.id !== me.id && <button className="link danger" onClick={() => confirm(`Delete ${u.username}? Their favourites go too.`) && run(() => account.deleteUser(u.id), "Deleted.")}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <form className="new-user" onSubmit={(e) => { e.preventDefault(); run(() => account.createUser(nu), `Created ${nu.username}.`).then(() => setNu({ username: "", display_name: "", password: "", is_admin: false })); }}>
            <h4>Add someone</h4>
            <input placeholder="username" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
            <input placeholder="name others see" value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} />
            <input placeholder="password (8+)" type="password" autoComplete="new-password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
            <label className="check"><input type="checkbox" checked={nu.is_admin} onChange={(e) => setNu({ ...nu, is_admin: e.target.checked })} /> Admin</label>
            <button className="primary" disabled={!nu.username || nu.password.length < 8}>Add</button>
          </form>
        </section>
      )}
    </div>
  );
}
