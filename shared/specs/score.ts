import { COMPUTER_TYPES, type ComputerSummary } from "./computer.ts";

/**
 * BidScout spec score: a rough, explainable measure of how much computer a lot is, built only
 * from parsed (cited) values. It is not a benchmark. It exists to compare machines of different
 * makes and models, and to group "similar spec" past sales when no identical machine has sold.
 *
 *   score = (2 × CPU points + RAM points + storage points) × condition
 */

export const SCORE_VERSION = "score-v1";

const CPU_BASE: Record<string, number> = {
  i3: 1, i5: 2, i7: 3, i9: 4,
  "core ultra 5": 2.6, "core ultra 7": 3.4, "core ultra 9": 4.2,
  xeon: 2.5,
  "ryzen 3": 1, "ryzen 5": 2, "ryzen 7": 3, "ryzen 9": 4,
  "apple m": 3.5,
  celeron: 0.4, pentium: 0.6, atom: 0.3, amd: 0.5,
};

export interface ScorePart {
  label: string;
  points: number;
}

export interface SpecScore {
  score: number;
  parts: ScorePart[];
  /** RAM or storage wasn't stated, so the score may be low. */
  incomplete: boolean;
  /** Groups past sales with a similar score: form factor, half-point score band, fault bucket. */
  key: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** How recent the CPU is, as a multiplier (Intel Core generation, Ryzen series, Apple M chip). */
export function cpuAgeFactor(s: Pick<ComputerSummary, "cpu" | "cpuFamily" | "cpuGen">): { factor: number; why: string } {
  const fam = s.cpuFamily ?? "";
  if (/^i[3579]$/.test(fam)) {
    if (s.cpuGen === null) return { factor: 0.7, why: "generation not stated" };
    return { factor: Math.min(1.4, Math.max(0.4, 0.4 + 0.1 * (s.cpuGen - 4))), why: `${s.cpuGen}th gen` };
  }
  if (fam.startsWith("ryzen")) {
    const series = Number(/Ryzen\s*\d\s*(\d)\d{3}/i.exec(s.cpu ?? "")?.[1] ?? NaN);
    if (!Number.isFinite(series)) return { factor: 0.9, why: "series not stated" };
    const f = series <= 2 ? 0.6 : series === 3 ? 0.8 : series <= 5 ? 1 : series <= 7 ? 1.2 : 1.3;
    return { factor: f, why: `${series}000 series` };
  }
  if (fam === "apple m") {
    const chip = Number(/M(\d)/.exec(s.cpu ?? "")?.[1] ?? 1);
    return { factor: chip >= 3 ? 1.3 : chip === 2 ? 1.15 : 1, why: `M${chip}` };
  }
  if (fam.startsWith("core ultra")) return { factor: 1.3, why: "Core Ultra" };
  if (fam === "xeon") return { factor: 0.8, why: "Xeon" };
  return { factor: 1, why: "" };
}

export function specScore(s: ComputerSummary): SpecScore | null {
  if (!s.isIt || !s.deviceType || !COMPUTER_TYPES.has(s.deviceType) || !s.cpuFamily) return null;
  const base = CPU_BASE[s.cpuFamily];
  if (base === undefined) return null;
  const age = cpuAgeFactor(s);
  const parts: ScorePart[] = [];
  const cpu = base * age.factor;
  parts.push({ label: `CPU ${s.cpu ?? s.cpuFamily}${age.why ? ` (${age.why})` : ""} × 2`, points: round1(cpu * 2) });
  let ram = 0;
  if (s.ramGb !== null) {
    ram = Math.min(6, Math.max(0, Math.log2(s.ramGb / 4) + 1));
    parts.push({ label: `${s.ramGb} GB RAM`, points: round1(ram) });
  }
  let storage = 0;
  if (s.storageType === "ssd" && s.storageGb) storage = Math.min(2.5, Math.max(0.5, 1 + 0.5 * Math.log2(s.storageGb / 256)));
  else if (s.storageType === "hdd" || s.storageType === "emmc") storage = 0.3;
  if (s.storageGb !== null) parts.push({ label: s.storageGb === 0 ? "No drive" : `${s.storageGb} GB ${s.storageType ?? ""}`.trim(), points: round1(storage) });
  const minor = s.faults.filter((f) => !["cosmetic", "no-cables"].includes(f));
  const condition = s.majorFault ? 0.35 : minor.length ? 0.9 : 1;
  if (condition < 1) parts.push({ label: s.majorFault ? "Major fault × 0.35" : "Minor fault × 0.9", points: 0 });
  const score = round1((cpu * 2 + ram + storage) * condition);
  const form = s.deviceType === "laptop" || s.deviceType === "tablet" ? "portable" : s.deviceType === "server" ? "server" : "desktop";
  return {
    score,
    parts,
    incomplete: s.ramGb === null || s.storageGb === null,
    key: ["s", form, (Math.round(score * 2) / 2).toFixed(1), s.majorFault ? "fault" : "ok"].join("|"),
  };
}
