import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db.ts";

/**
 * Usernames and passwords, managed by an admin. Passwords are scrypt hashes; sessions are
 * random tokens kept in an httpOnly cookie, stored only as their SHA-256.
 */

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_COOKIE = "bidscout_session";
export const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "Use at least 8 characters.";
  if (password.length > 200) return "That password is too long.";
  return null;
}

export function usernameProblem(username: unknown): string | null {
  if (typeof username !== "string" || !/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(username)) return "Use 2–32 letters, numbers, dots, dashes or underscores.";
  return null;
}

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`, [tokenHash(token), userId, SESSION_DAYS]);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return token;
}

export async function endSession(db: Db, token: string) {
  await db.query(`DELETE FROM sessions WHERE token_hash=$1`, [tokenHash(token)]);
}

/** Ends every session of a user except the one with `keepToken` (if given). */
export async function endOtherSessions(db: Db, userId: number, keepToken?: string) {
  await db.query(`DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2`, [userId, keepToken ? tokenHash(keepToken) : ""]);
}

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  is_admin: boolean;
}

export async function userFromToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const r = await db.query(
    `SELECT u.id, u.username, u.display_name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now() AND NOT u.disabled`,
    [tokenHash(token)],
  );
  return r.rows[0] ?? null;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean, maxAgeDays = SESSION_DAYS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${secure ? "; Secure" : ""}`;
}

/**
 * The first admin. With no users yet, creates one named BIDSCOUT_ADMIN_USERNAME (default
 * "admin") whose password is BIDSCOUT_PASSWORD, so a hosted site keeps working with the
 * password already set. Locally, without a password, it uses "bidscout" and says so.
 * Returns a note for the log, or null when users already exist.
 */
export async function bootstrapAdmin(db: Db, opts: { username: string; password: string; local: boolean }): Promise<string | null> {
  const any = await db.query(`SELECT 1 FROM users LIMIT 1`);
  if (any.rowCount) return null;
  let password = opts.password;
  let note = `Created admin "${opts.username}" with the password in BIDSCOUT_PASSWORD.`;
  if (!password) {
    if (!opts.local) throw new Error("No users yet and BIDSCOUT_PASSWORD is not set: cannot create the first admin.");
    password = "bidscout";
    note = `Created local admin "${opts.username}" with password "bidscout". Change it in Profile.`;
  }
  const r = await db.query(
    `INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,true) RETURNING id`,
    [opts.username, opts.username, await hashPassword(password)],
  );
  // Carry the old shared watchlist over as the admin's favourites.
  await db.query(
    `INSERT INTO favourites (user_id, lot_id, max_all_in, note, added_at)
     SELECT $1, lot_id, max_all_in, note, added_at FROM watchlist ON CONFLICT DO NOTHING`,
    [r.rows[0].id],
  );
  return note;
}

/** At most 10 failed logins per username or address in 15 minutes. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 15 * 60_000, private now = () => Date.now()) {}
  private recent(key: string) {
    const t = this.now();
    const list = (this.fails.get(key) ?? []).filter((x) => t - x < this.windowMs);
    this.fails.set(key, list);
    return list;
  }
  blocked(...keys: string[]) {
    return keys.some((k) => this.recent(k).length >= this.max);
  }
  fail(...keys: string[]) {
    for (const k of keys) this.recent(k).push(this.now());
  }
  clear(...keys: string[]) {
    for (const k of keys) this.fails.delete(k);
  }
}
