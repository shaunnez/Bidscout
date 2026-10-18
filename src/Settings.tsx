import { useEffect, useState } from "react";
import { account, type AdminUser, type Me, type ScanSettings } from "./api.ts";
import { nzDate } from "./format.ts";

export function Settings({ me }: { me: Me }) {
  const [scan, setScan] = useState<ScanSettings | null>(null);
  const [hours, setHours] = useState<number[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [nu, setNu] = useState({ username: "", display_name: "", password: "", is_admin: false });

  const load = () => {
    account.settings().then((r) => { setScan(r.scan); setHours(r.liveHourOptions); }).catch(() => {});
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
      {me.is_admin && (
        <section className="card">
          <h3>People</h3>
          <table className="runs">
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
