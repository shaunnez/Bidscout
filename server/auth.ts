import crypto from "node:crypto";

/**
 * One shared password (HTTP Basic, any username) for a hosted BidScout.
 * Browsers show their own sign-in prompt and remember it for the session.
 */
export function passwordAccepted(header: string | undefined, password: string): boolean {
  if (!password) return true;
  const m = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const given = decoded.slice(decoded.indexOf(":") + 1);
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(password).digest();
  return crypto.timingSafeEqual(a, b);
}
