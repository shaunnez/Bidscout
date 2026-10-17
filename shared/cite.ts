import { cleanText } from "./clean.ts";

/** Reads a dotted path like "items.12.description" from a parsed snapshot. */
export function resolvePath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur;
}

export interface Span {
  start: number;
  end: number;
  quote: string;
}

/** True when the quote is exactly the text at [start, end) of the cleaned field. */
export function spanMatches(fieldValue: unknown, span: Span): boolean {
  return cleanText(fieldValue).slice(span.start, span.end) === span.quote;
}
