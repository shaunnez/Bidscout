import { useEffect, useState } from "react";
import { account, type Me } from "./api.ts";

export function Profile({ me, onSaved }: { me: Me; onSaved: (m: Me) => void }) {
  const [form, setForm] = useState({ display_name: me.display_name, email: me.email ?? "", n8_username: me.n8_username ?? "", n8_bidder_number: me.n8_bidder_number ?? "" });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setForm({ display_name: me.display_name, email: me.email ?? "", n8_username: me.n8_username ?? "", n8_bidder_number: me.n8_bidder_number ?? "" }), [me]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const m = await account.saveMe({ ...form, ...(pw.next ? { current_password: pw.current, new_password: pw.next } : {}) });
      onSaved(m);
      setPw({ current: "", next: "" });
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <form className="panel-page" onSubmit={save}>
      <h1>Profile</h1>
      <section className="card">
        <h3>You</h3>
        <label>Name others see<input {...field("display_name")} /></label>
        <label>Email <span className="muted small">for the weekly digest</span><input type="email" {...field("email")} /></label>
      </section>
      <section className="card">
        <h3>Your number8.bid identity</h3>
        <p className="muted small">
          So friends in BidScout can see when you're bidding, and you don't bid against each other. BidScout checks bid
          histories against these before anything is stored; nobody else's bidder details are kept.
        </p>
        <label>number8 username<input {...field("n8_username")} placeholder="as shown in bid histories" /></label>
        <label>Bidder number<input {...field("n8_bidder_number")} placeholder="optional" /></label>
      </section>
      <section className="card">
        <h3>Change password</h3>
        <label>Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
        <label>New password<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} placeholder="at least 8 characters" /></label>
      </section>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
      <button className="primary">Save</button>
    </form>
  );
}
