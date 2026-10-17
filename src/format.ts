const NZ = "Pacific/Auckland";

export const money = (n: number | null | undefined, cents = false) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "–"
    : Number(n).toLocaleString("en-NZ", { style: "currency", currency: "NZD", maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 });

export const nzDate = (d: string | Date | null | undefined, withTime = true) =>
  d
    ? new Date(d).toLocaleString("en-NZ", {
        timeZone: NZ, weekday: "short", day: "numeric", month: "short", year: "numeric",
        ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      })
    : "–";

export const nzShort = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-NZ", { timeZone: NZ, day: "numeric", month: "short", year: "2-digit" }) : "–";

export function timeLeft(ends: string | null, now: number): { text: string; urgent: boolean; over: boolean } {
  if (!ends) return { text: "–", urgent: false, over: false };
  const ms = new Date(ends).getTime() - now;
  if (ms <= 0) return { text: "Closing time passed", urgent: false, over: true };
  const m = Math.floor(ms / 60000);
  if (m < 1) return { text: "Less than 1 min left", urgent: true, over: false };
  if (m < 60) return { text: `${m} min left`, urgent: true, over: false };
  const h = Math.floor(m / 60);
  if (h < 24) return { text: `${h}h ${m % 60}m left`, urgent: h < 3, over: false };
  const d = Math.floor(h / 24);
  return { text: `${d}d ${h % 24}h left`, urgent: false, over: false };
}

export const gb = (n: number | null | undefined) =>
  n === null || n === undefined ? null : n >= 1000 ? `${+(n / 1000).toFixed(2)} TB` : `${n} GB`;

export const ago = (d: string | null | undefined, now = Date.now()) => {
  if (!d) return "never";
  const s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
