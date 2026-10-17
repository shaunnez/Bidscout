/**
 * Turns listing HTML into the plain text that citations point into.
 * Deterministic and versioned: a citation's offsets are only valid for the
 * CLEAN_VERSION that produced them, so changing this function means a new version.
 */
export const CLEAN_VERSION = "clean-v1";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", times: "×", deg: "°",
  reg: "®", trade: "™", copy: "©", frac12: "½", middot: "·", bull: "•", eacute: "é",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function cleanText(input: unknown): string {
  if (input === null || input === undefined) return "";
  let s = String(input);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]/g, " ");
  s = s
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
  return s.trim();
}

/** Loose comparison form for search keys (not for citations). */
export const fold = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
