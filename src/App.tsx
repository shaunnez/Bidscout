import { useCallback, useEffect, useMemo, useState } from "react";
import { account, api, setOnSignedOut, type Auction, type Me, type ScanRun, type Summary } from "./api.ts";
import { Auctions } from "./Auctions.tsx";
import { Feed } from "./Feed.tsx";
import { ago } from "./format.ts";
import { Login } from "./Login.tsx";
import { LotDrawer } from "./LotDrawer.tsx";
import { Profile } from "./Profile.tsx";
import { Scans } from "./Scans.tsx";
import { Settings } from "./Settings.tsx";

export type Route = { page: "deals" | "auctions" | "history" | "watch" | "scans" | "settings" | "profile"; params: URLSearchParams };

function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const page = (["auctions", "history", "watch", "scans", "settings", "profile"] as const).find((p) => p === path) ?? "deals";
  return { page, params: new URLSearchParams(qs ?? "") };
}

export function useRoute() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((page: Route["page"], params?: URLSearchParams, replace = false) => {
    const qs = params?.toString();
    const hash = `#/${page === "deals" ? "" : page}${qs ? `?${qs}` : ""}`;
    if (replace) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
    setRoute(readHash());
  }, []);
  return { route, go };
}

/** Polls the current scan while one is active (every 3s), otherwise every 30s. */
export function useScan() {
  const [run, setRun] = useState<ScanRun | null>(null);
  const active = run?.state === "queued" || run?.state === "running";
  const refresh = useCallback(() => api.currentScan().then((r) => setRun(r.run)).catch(() => {}), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, active ? 3000 : 30000);
    return () => clearInterval(t);
  }, [active, refresh]);
  return { run, active, refresh };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const loadMe = useCallback(() => account.me().then(setMe).catch(() => setMe(null)), []);
  useEffect(() => {
    setOnSignedOut(() => setMe(null));
    loadMe();
  }, [loadMe]);
  if (me === undefined) return <div className="login-wrap"><p className="muted">Loading…</p></div>;
  if (me === null) return <Login onSignedIn={loadMe} />;
  return <SignedIn me={me} setMe={setMe} />;
}

function SignedIn({ me, setMe }: { me: Me; setMe: (m: Me | null) => void }) {
  const { route, go } = useRoute();
  const [menu, setMenu] = useState(false);
  const scan = useScan();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [q, setQ] = useState(route.params.get("q") ?? "");
  const lotId = Number(route.params.get("lot")) || null;

  useEffect(() => {
    api.summary().then(setSummary).catch(() => {});
  }, [scan.run?.state, scan.run?.finished_at]);
  useEffect(() => setQ(route.params.get("q") ?? ""), [route.params]);

  const setParams = useCallback(
    (mut: (p: URLSearchParams) => void, replace = false) => {
      const p = new URLSearchParams(route.params);
      mut(p);
      go(route.page, p, replace);
    },
    [route, go],
  );

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const page = route.page === "scans" || route.page === "settings" || route.page === "profile" || route.page === "auctions" ? "deals" : route.page;
    const p = new URLSearchParams(page === route.page ? route.params : undefined);
    if (q.trim()) p.set("q", q.trim());
    else p.delete("q");
    p.delete("page");
    go(page, p);
  };

  const openLot = useCallback((id: number) => setParams((p) => p.set("lot", String(id))), [setParams]);
  const closeLot = useCallback(() => setParams((p) => p.delete("lot")), [setParams]);
  /** An auction's lots: live ones in Live deals, finished ones in Past sales. */
  const openAuction = useCallback((a: Pick<Auction, "id" | "live">) => go(a.live ? "deals" : "history", new URLSearchParams({ auction: String(a.id) })), [go]);
  const progress = useMemo(() => {
    const r = scan.run;
    if (!r || !scan.active) return null;
    if (r.kind === "history") return r.pages_total ? `${r.pages_read}/${r.pages_total} pages` : `${r.pages_read} pages`;
    if (r.phase === "details") return `${r.details_read}/${r.details_total} lot pages`;
    return `${r.lots_seen} lots`;
  }, [scan.run, scan.active]);

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); go("deals"); }}>
          <span className="brand-mark" aria-hidden>B</span>
          <span>BidScout</span>
        </a>
        <form className="search" onSubmit={submitSearch} role="search">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lots: thinkpad t14, rtx 3060, 27 inch, forklift…" aria-label="Search lots" />
        </form>
        <nav className="tabs">
          {([["deals", "Live deals"], ["tm", "Trade Me deals"], ["auctions", "Auctions"], ["history", "Past sales"], ["watch", `Favourites${summary?.watching ? ` (${summary.watching})` : ""}`], ["scans", "Scans"]] as const).map(([p, label]) => {
            // "Trade Me deals" is Live deals for IT lots with Trade Me prices, cheapest against Trade Me first.
            const tmView = route.page === "deals" && route.params.has("tm");
            const on = p === "tm" ? tmView : p === "deals" ? route.page === "deals" && !tmView : route.page === p;
            const open = () => (p === "tm" ? go("deals", new URLSearchParams({ it: "1", tm: "1", sort: "tm" })) : go(p));
            return <a key={p} href={p === "tm" ? "#/?it=1&tm=1&sort=tm" : `#/${p === "deals" ? "" : p}`} className={on ? "on" : ""} onClick={(e) => { e.preventDefault(); open(); }}>{label}</a>;
          })}
        </nav>
        <button
          className={`scan-btn ${scan.active ? "busy" : ""}`}
          onClick={() => (scan.active ? go("scans") : api.startScan({ kind: "live" }).then(() => { scan.refresh(); go("scans"); }))}
          title={summary?.last_live_scan ? `Last live scan ${ago(summary.last_live_scan)}` : "No scan yet"}
        >
          <span className="dot" aria-hidden />
          {scan.active ? <>Scanning <small>{progress}</small></> : <>Scan now <small>{summary?.last_live_scan ? ago(summary.last_live_scan) : "never"}</small></>}
        </button>
        <div className="user-menu">
          <button className="avatar" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Account menu">{me.display_name.slice(0, 1).toUpperCase()}</button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <div className="menu-who"><b>{me.display_name}</b><span className="muted small">{me.username}{me.is_admin ? " · admin" : ""}</span></div>
              <button onClick={() => { setMenu(false); go("profile"); }}>Profile</button>
              <button onClick={() => { setMenu(false); go("settings"); }}>Settings{me.is_admin ? " & people" : ""}</button>
              <button onClick={() => account.logout().finally(() => setMe(null))}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      <main className="body">
        {route.page === "scans" ? (
          <Scans scan={scan} openLot={openLot} />
        ) : route.page === "auctions" ? (
          <Auctions openAuction={openAuction} />
        ) : route.page === "settings" ? (
          <Settings me={me} />
        ) : route.page === "profile" ? (
          <Profile me={me} onSaved={setMe} />
        ) : (
          <Feed key={route.page} page={route.page} params={route.params} setParams={setParams} openLot={openLot} summary={summary} scanFinished={scan.run?.finished_at ?? null} />
        )}
      </main>

      {lotId && <LotDrawer id={lotId} onClose={closeLot} onOpenLot={openLot} onOpenAuction={openAuction} />}
    </div>
  );
}
