/**
 * robots.txt, read the way RFC 9309 says: use the group for our agent (else `*`), and the
 * longest matching rule wins, with Allow winning a tie. `*` matches anything, `$` ends a rule.
 */

interface Rule {
  allow: boolean;
  path: string;
}

export interface Robots {
  groups: Array<{ agents: string[]; rules: Rule[] }>;
}

/**
 * Does `rule` match the start of `text`? `*` is any run of characters, a final `$` anchors the
 * end. Greedy two-pointer matching, not regular expressions, so rules with several wildcards
 * can't backtrack for minutes (Trade Me's file has thousands of them).
 */
export function ruleMatches(rule: string, text: string): boolean {
  const anchored = rule.endsWith("$");
  const p = anchored ? rule.slice(0, -1) : rule + "*";
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < text.length) {
    if (i < p.length && p[i] !== "*" && p[i] === text[j]) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

export function parseRobots(text: string): Robots {
  const groups: Robots["groups"] = [];
  let current: Robots["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current || (key !== "allow" && key !== "disallow")) continue;
      if (key === "disallow" && value === "") continue; // "Disallow:" allows everything
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups };
}

/** Whether `agents` (most specific first) may fetch `url` (its path and query string). */
export function robotsAllows(robots: Robots, url: string, agents: string[]): boolean {
  const u = new URL(url, "https://example.invalid");
  const target = u.pathname + u.search;
  const wanted = agents.map((a) => a.toLowerCase());
  const named = robots.groups.filter((g) => g.agents.some((a) => wanted.includes(a)));
  const rules = (named.length ? named : robots.groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, target)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}
