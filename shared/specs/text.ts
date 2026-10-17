/** Offset-keeping helpers: every match is reported as a span of the original field. */

export type SourceField = "title" | "description";

export interface Seg {
  source: SourceField;
  text: string;
  offset: number;
}

export interface Hit {
  source: SourceField;
  start: number;
  end: number;
  quote: string;
}

export interface Found extends Hit {
  field: string;
  value: string;
  num?: number;
  method: string;
}

export const whole = (source: SourceField, text: string): Seg => ({ source, text, offset: 0 });

export function trimSeg(s: Seg): Seg {
  const lead = s.text.length - s.text.trimStart().length;
  const text = s.text.trim();
  return { source: s.source, text, offset: s.offset + lead };
}

export function sub(s: Seg, start: number, end: number): Seg {
  return trimSeg({ source: s.source, text: s.text.slice(start, end), offset: s.offset + start });
}

export function hitOf(s: Seg, start: number, end: number): Hit {
  return { source: s.source, start: s.offset + start, end: s.offset + end, quote: s.text.slice(start, end) };
}

/** First match of `re` in the segment; `group` selects a capture group for the span. */
export function find(s: Seg, re: RegExp, group = 0): (Hit & { m: RegExpExecArray }) | null {
  const flags = re.flags.includes("d") ? re.flags.replace("g", "") : re.flags.replace("g", "") + "d";
  const m = new RegExp(re.source, flags).exec(s.text);
  if (!m || !m.indices?.[group]) return null;
  const [a, b] = m.indices[group]!;
  return { ...hitOf(s, a, b), m };
}

export function findAll(s: Seg, re: RegExp): Array<Hit & { m: RegExpExecArray }> {
  const flags = (re.flags.includes("g") ? re.flags : re.flags + "g") + (re.flags.includes("d") ? "" : "d");
  const rx = new RegExp(re.source, flags);
  const out: Array<Hit & { m: RegExpExecArray }> = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s.text))) {
    if (m[0] === "") {
      rx.lastIndex++;
      continue;
    }
    const [a, b] = m.indices![0]!;
    out.push({ ...hitOf(s, a, b), m });
  }
  return out;
}

/**
 * Splits a segment on labels ("Make – HP", "CPU: Core i5"). Returns each label's value
 * segment, running to the next label. Labels are matched case-insensitively.
 */
export function splitLabels(s: Seg, labels: string[], sep: string): Map<string, Seg & { labelHit: Hit }> {
  const alt = labels
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s*"))
    .join("|");
  const rx = new RegExp(`(?:^|(?<=[\\s.,;:)\\]–-])|(?<=[a-z0-9]))(${alt})\\s*${sep}\\s*`, "gi");
  const marks: Array<{ label: string; at: number; valueAt: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s.text))) {
    const label = labels.find((l) => l.replace(/\s+/g, "").toLowerCase() === m![1]!.replace(/\s+/g, "").toLowerCase())!;
    marks.push({ label, at: m.index, valueAt: m.index + m[0].length });
  }
  const out = new Map<string, Seg & { labelHit: Hit }>();
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : s.text.length;
    if (out.has(mk.label)) return;
    const value = sub(s, mk.valueAt, Math.max(mk.valueAt, end));
    out.set(mk.label, { ...value, labelHit: hitOf(s, mk.at, mk.valueAt) });
  });
  return out;
}
