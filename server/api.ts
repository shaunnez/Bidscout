import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { cleanText, CLEAN_VERSION } from "../shared/clean.ts";
import { resolvePath } from "../shared/cite.ts";
import { PARSER_VERSION } from "../shared/specs/computer.ts";
import {
  bootstrapAdmin, createSession, endOtherSessions, endSession, hashPassword, LoginLimiter, passwordProblem, readCookie,
  SESSION_COOKIE, sessionCookie, userFromToken, usernameProblem, verifyPassword, type SessionUser,
} from "./auth.ts";
import { isLoopback } from "./config.ts";
import { appContext } from "./context.ts";
import { MIN_PHOTO_CONFIDENCE, OCR_VERSION } from "../shared/specs/photo.ts";
import { getAuction, listAuctions } from "./auctions.ts";
import { photoSummary } from "./photo-summary.ts";
import { refreshLot } from "./scan/refresh.ts";
import { startRun, type RunKind, type RunOptions } from "./scan/runner.ts";
import { getScanSettings, getTradeMeSettings, LIVE_HOURS, saveScanSettings, saveTradeMeSettings, TRADEME_LIMITS } from "./settings.ts";
import { latestForLot, LookupError, tradeMeLookup, tradeMeStatus } from "./trademe.ts";
import { LOT_COLUMNS, LOT_JOINS, parseQuery, searchLots } from "./search.ts";
import { loadSnapshotDoc } from "./snapshots.ts";
import { runWorkerLoop } from "./worker.ts";

const ctx = await appContext();
const { db, store, config } = ctx;
const hasUsers = (await db.query(`SELECT 1 FROM users LIMIT 1`)).rowCount;
if (!isLoopback(config.host) && !hasUsers && !config.password) {
  console.error(`Refusing to listen on ${config.host}: there are no users yet and BIDSCOUT_PASSWORD is not set for the first admin.`);
  process.exit(1);
}
const bootNote = await bootstrapAdmin(db, {
  username: process.env.BIDSCOUT_ADMIN_USERNAME?.trim() || "admin",
  password: config.password,
  local: isLoopback(config.host),
});
if (bootNote) console.log(bootNote);

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const app = Fastify({ logger: { level: "warn" }, trustProxy: true });
const limiter = new LoginLimiter();
app.decorateRequest("user", null);

app.get("/api/health", async () => {
  await db.query("SELECT 1");
  return { ok: true };
});

// Everything under /api needs a signed-in user, except health and sign-in. The UI bundle is public.
const PUBLIC_API = new Set(["/api/health", "/api/auth/login"]);
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/") || PUBLIC_API.has(req.url.split("?")[0]!)) return;
  req.user = await userFromToken(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  if (!req.user) return reply.code(401).send({ error: "Sign in required" });
});

const requireAdmin = async (req: { user: SessionUser | null }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
  if (!req.user?.is_admin) return reply.code(403).send({ error: "Admins only" });
};
const uid = (req: { user: SessionUser | null }) => req.user!.id;

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const keys = [`u:${username.toLowerCase()}`, `ip:${req.ip}`];
  if (limiter.blocked(...keys)) return reply.code(429).send({ error: "Too many attempts. Try again in 15 minutes." });
  const u = (await db.query(`SELECT id, password_hash, disabled FROM users WHERE lower(username)=lower($1)`, [username])).rows[0];
  const ok = !!u && !u.disabled && (await verifyPassword(password, u.password_hash));
  if (!ok) {
    limiter.fail(...keys);
    return reply.code(401).send({ error: "Wrong username or password" });
  }
  // Only this username's failures are forgiven; the address keeps its count.
  limiter.clear(keys[0]!);
  await db.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
  const token = await createSession(db, Number(u.id));
  reply.header("Set-Cookie", sessionCookie(token, req.protocol === "https"));
  return { ok: true };
});

app.post("/api/auth/logout", async (req, reply) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) await endSession(db, token);
  reply.header("Set-Cookie", sessionCookie("", req.protocol === "https", 0));
  return { ok: true };
});

const ME_COLUMNS = `id, username, display_name, is_admin, email, n8_username, n8_bidder_number, created_at`;

app.get("/api/me", async (req) => (await db.query(`SELECT ${ME_COLUMNS} FROM users WHERE id=$1`, [uid(req)])).rows[0]);

app.put<{ Body: { display_name?: string; email?: string | null; n8_username?: string | null; n8_bidder_number?: string | null; current_password?: string; new_password?: string } }>(
  "/api/me",
  async (req, reply) => {
    const b = req.body ?? {};
    const cur = (await db.query(`SELECT password_hash, email, n8_username, n8_bidder_number FROM users WHERE id=$1`, [uid(req)])).rows[0];
    // Fields left out of the request keep their value.
    const clean = (v: unknown, max: number, keep: string | null = null) =>
      v === undefined ? keep : typeof v === "string" ? v.trim().slice(0, max) || null : null;
    // A number8 username or bidder number can belong to one member only, or bids would be misattributed.
    const n8User = clean(b.n8_username, 80, cur.n8_username);
    const n8Number = clean(b.n8_bidder_number, 40, cur.n8_bidder_number);
    const ids = [n8User, n8Number].filter((v): v is string => !!v).map((v) => v.toLowerCase());
    if (ids.length) {
      const clash = await db.query(
        `SELECT display_name FROM users WHERE id <> $1 AND (lower(n8_username) = ANY($2) OR lower(n8_bidder_number) = ANY($2)) LIMIT 1`,
        [uid(req), ids],
      );
      if (clash.rowCount) return reply.code(400).send({ error: `${clash.rows[0].display_name} already uses that number8 username or bidder number` });
    }
    if (b.new_password !== undefined) {
      const problem = passwordProblem(b.new_password);
      if (problem) return reply.code(400).send({ error: problem });
      if (!(await verifyPassword(String(b.current_password ?? ""), cur.password_hash)))
        return reply.code(400).send({ error: "Your current password is wrong" });
      await db.query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [uid(req), await hashPassword(b.new_password)]);
      // Sign out everywhere else; this session stays.
      await endOtherSessions(db, uid(req), readCookie(req.headers.cookie, SESSION_COOKIE));
    }
    await db.query(
      `UPDATE users SET display_name=COALESCE($2, display_name), email=$3, n8_username=$4, n8_bidder_number=$5, updated_at=now() WHERE id=$1`,
      [uid(req), clean(b.display_name, 60), clean(b.email, 200, cur.email), n8User, n8Number],
    );
    return (await db.query(`SELECT ${ME_COLUMNS} FROM users WHERE id=$1`, [uid(req)])).rows[0];
  },
);

// ---------------------------------------------------------------- admin: users and settings

app.get("/api/admin/users", { preHandler: requireAdmin }, async () => ({
  users: (await db.query(
    `SELECT id, username, display_name, is_admin, disabled, email, n8_username, n8_bidder_number, created_at,
            COALESCE(last_login_at, (SELECT max(created_at) FROM sessions s WHERE s.user_id=u.id)) AS last_sign_in
     FROM users u ORDER BY lower(username)`,
  )).rows,
}));

app.post<{ Body: { username?: string; display_name?: string; password?: string; is_admin?: boolean } }>(
  "/api/admin/users",
  { preHandler: requireAdmin },
  async (req, reply) => {
    const b = req.body ?? {};
    const problem = usernameProblem(b.username) ?? passwordProblem(b.password);
    if (problem) return reply.code(400).send({ error: problem });
    const taken = await db.query(`SELECT 1 FROM users WHERE lower(username)=lower($1)`, [b.username]);
    if (taken.rowCount) return reply.code(400).send({ error: "That username is taken" });
    const r = await db.query(
      `INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.username, String(b.display_name ?? "").trim().slice(0, 60) || b.username, await hashPassword(b.password!), !!b.is_admin],
    );
    return { id: r.rows[0].id };
  },
);

app.put<{ Params: { id: string }; Body: { display_name?: string; is_admin?: boolean; disabled?: boolean; password?: string } }>(
  "/api/admin/users/:id",
  { preHandler: requireAdmin },
  async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (id === uid(req) && (b.is_admin === false || b.disabled === true))
      return reply.code(400).send({ error: "You can't remove your own admin rights or disable yourself" });
    if (b.password !== undefined) {
      const problem = passwordProblem(b.password);
      if (problem) return reply.code(400).send({ error: problem });
      await db.query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [id, await hashPassword(b.password)]);
      await db.query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
    }
    await db.query(
      `UPDATE users SET display_name=COALESCE($2, display_name), is_admin=COALESCE($3, is_admin), disabled=COALESCE($4, disabled), updated_at=now() WHERE id=$1`,
      [id, typeof b.display_name === "string" ? b.display_name.trim().slice(0, 60) || null : null, typeof b.is_admin === "boolean" ? b.is_admin : null, typeof b.disabled === "boolean" ? b.disabled : null],
    );
    if (b.disabled) await db.query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
    return { ok: true };
  },
);

app.delete<{ Params: { id: string } }>("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
  const id = Number(req.params.id);
  if (id === uid(req)) return reply.code(400).send({ error: "You can't delete yourself" });
  await db.query(`DELETE FROM users WHERE id=$1`, [id]);
  return { ok: true };
});

app.get("/api/settings", async () => ({
  scan: await getScanSettings(db), liveHourOptions: LIVE_HOURS,
  trademe: await getTradeMeSettings(db), trademeLimitOptions: TRADEME_LIMITS, trademeKeySet: !!ctx.firecrawl || ctx.tradeMeSearchers.length > 0, trademeMethods: ctx.tradeMeSearchers.map((x) => x.name),
}));

app.put<{ Body: { scan?: Record<string, unknown>; trademe?: Record<string, unknown> } }>("/api/settings", { preHandler: requireAdmin }, async (req) => ({
  scan: req.body?.scan ? await saveScanSettings(db, req.body.scan as never, uid(req)) : await getScanSettings(db),
  trademe: req.body?.trademe ? await saveTradeMeSettings(db, req.body.trademe as never, uid(req)) : await getTradeMeSettings(db),
}));

const snapshotMeta = (m: Record<string, unknown>) => ({
  id: m.id,
  method: m.method,
  url: m.url,
  request: m.request_body,
  fetchedAt: m.fetched_at,
  sha256: m.stored_sha256,
  originalSha256: m.original_sha256,
  redactions: m.redactions,
});

app.get<{ Querystring: { scope?: string } }>("/api/auctions", async (req) => ({
  auctions: await listAuctions(db, uid(req), req.query.scope === "closed" ? "closed" : "live"),
}));

app.get<{ Params: { id: string } }>("/api/auctions/:id", async (req, reply) => {
  const a = await getAuction(db, uid(req), Number(req.params.id));
  return a ?? reply.code(404).send({ error: "No such auction" });
});

app.get("/api/photos/summary", async () => photoSummary(db));

app.get("/api/lots", async (req) => searchLots(db, parseQuery(req.query as Record<string, unknown>), uid(req)));

app.get<{ Params: { id: string } }>("/api/lots/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const r = await db.query(
    `SELECT ${LOT_COLUMNS}, l.description, l.images, l.bid_history, l.current_revision_id, l.machine_key, l.loose_key,
            l.detail_read_at, l.outcome_snapshot_id, l.outcome_path, l.score_key, a.url AS auction_url, a.city AS auction_city,
            l.photo_ocr_at, (SELECT count(*)::int FROM photo_reads pr WHERE pr.lot_id = l.id AND pr.ocr_version = '${OCR_VERSION}') AS photos_read,
            a.address AS auction_address, a.lots_close_at AS auction_lots_close_at, a.instructions AS auction_instructions
     FROM lots l ${LOT_JOINS} WHERE l.id=$2`,
    [uid(req), id],
  );
  const lot = r.rows[0];
  if (!lot) return reply.code(404).send({ error: "No such lot" });
  const [specs, obs, terms, revs, watchers, friendBids, photoValues] = await Promise.all([
    db.query(
      `SELECT id, field, value, num, source, start_offset, end_offset, quote, method FROM spec_values
       WHERE lot_revision_id=$1 AND parser_version=$2 ORDER BY id`,
      [lot.current_revision_id, PARSER_VERSION],
    ),
    db.query(
      `SELECT id, observed_at, current_bid, bid_count, ends_at, status, snapshot_id, snapshot_path FROM lot_observations WHERE lot_id=$1 ORDER BY observed_at`,
      [id],
    ),
    db.query(`SELECT * FROM auction_terms WHERE auction_id=$1 ORDER BY id DESC LIMIT 1`, [lot.auction_id]),
    db.query(`SELECT id, created_at, snapshot_id FROM lot_revisions WHERE lot_id=$1 ORDER BY id`, [id]),
    db.query(
      `SELECT u.id, u.display_name, f.added_at FROM favourites f JOIN users u ON u.id=f.user_id
       WHERE f.lot_id=$1 AND NOT u.disabled ORDER BY f.added_at`,
      [id],
    ),
    db.query(
      `SELECT fb.user_id, u.display_name, fb.kind, fb.amount, fb.bid_at, fb.seen_at, fb.snapshot_id FROM friend_bids fb
       JOIN users u ON u.id=fb.user_id WHERE fb.lot_id=$1 ORDER BY COALESCE(fb.bid_at, fb.seen_at) DESC LIMIT 30`,
      [id],
    ),
    db.query(
      `SELECT pv.id, pv.field, pv.value, pv.quote, pv.confidence, pr.image_url FROM photo_values pv
       JOIN photo_reads pr ON pr.id = pv.photo_read_id
       WHERE pv.lot_id=$1 AND pr.ocr_version=$2 AND pv.confidence >= $3 ORDER BY pv.confidence DESC`,
      [id, OCR_VERSION, MIN_PHOTO_CONFIDENCE],
    ),
  ]);
  const suffix = lot.major_fault ? "|fault" : "";
  const compKey = lot.comp_kind === "similar" ? lot.loose_key : lot.comp_kind === "spec" ? lot.score_key : lot.machine_key;
  const compCol = lot.comp_kind === "similar" ? "l.loose_key" : lot.comp_kind === "spec" ? "l.score_key" : "l.machine_key";
  const comps = compKey
    ? await db.query(
        `SELECT l.id, l.title, l.final_bid, l.closed_at, l.buyer_premium, l.faults, l.ram_gb, l.storage_gb, l.cpu, l.item_url, l.thumb_url, l.bid_count,
                l.outcome_snapshot_id, l.outcome_path, a.title AS auction_title,
                l.final_bid * (1 + COALESCE(l.buyer_premium,0)/100.0) * 1.15 AS all_in
         FROM lots l JOIN auctions a ON a.id=l.auction_id
         WHERE l.status='closed' AND l.final_bid > 0 AND l.id <> $1
           AND ${compCol} = $2 AND l.major_fault = $3
         ORDER BY l.closed_at DESC NULLS LAST LIMIT 20`,
        [id, compKey, !!suffix],
      )
    : { rows: [] };
  return {
    lot, specs: specs.rows, observations: obs.rows, terms: terms.rows[0] ?? null, revisions: revs.rows, comps: comps.rows,
    watchers: watchers.rows, friendBids: friendBids.rows, photoValues: photoValues.rows,
    tradeMe: { ...(await tradeMeStatus(db, { firecrawl: ctx.firecrawl, searchers: ctx.tradeMeSearchers })), latest: await latestForLot(db, id) },
  };
});

/** Trade Me prices for a lot (server/trademe.ts): Trade Me search, or listing links the person pasted. Reuses answers under 3 days old. */
app.post<{ Params: { id: string }; Body: { query?: string; links?: string[] } }>("/api/lots/:id/trademe", async (req, reply) => {
  try {
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 20).map(String) : undefined;
    return await tradeMeLookup(
      { db, firecrawl: ctx.firecrawl, robots: ctx.tradeMeRobots, searchers: ctx.tradeMeSearchers },
      { lotId: Number(req.params.id), userId: uid(req), query: String(req.body?.query ?? ""), links },
    );
  } catch (e) {
    const status = e instanceof LookupError ? e.status : 502;
    return reply.code(status).send({ error: (e as Error).message });
  }
});

/** The exact words behind a spec value, re-read from the stored snapshot and checked. */
app.get<{ Params: { id: string } }>("/api/cite/:id", async (req, reply) => {
  const r = await db.query(
    `SELECT v.*, r.snapshot_id, r.snapshot_path, r.lot_id, l.item_url FROM spec_values v
     JOIN lot_revisions r ON r.id=v.lot_revision_id JOIN lots l ON l.id=r.lot_id WHERE v.id=$1`,
    [Number(req.params.id)],
  );
  const v = r.rows[0];
  if (!v) return reply.code(404).send({ error: "No such citation" });
  const { doc, meta } = await loadSnapshotDoc(db, store, v.snapshot_id);
  const fieldPath = `${v.snapshot_path}.${v.source}`;
  const text = cleanText(resolvePath(doc, fieldPath));
  return {
    kind: "spec",
    field: v.field,
    value: v.value,
    method: v.method,
    source: v.source,
    path: fieldPath,
    text,
    start: v.start_offset,
    end: v.end_offset,
    quote: v.quote,
    verified: text.slice(v.start_offset, v.end_offset) === v.quote,
    clean: CLEAN_VERSION,
    lotUrl: v.item_url,
    snapshot: snapshotMeta(meta),
  };
});

/** A spec value read from a lot photo: the stored photo, the OCR words it came from, and their boxes. */
app.get<{ Params: { id: string } }>("/api/photo-values/:id", async (req, reply) => {
  const r = await db.query(
    `SELECT pv.*, pr.id AS read_id, pr.image_url, pr.image_sha256, pr.width, pr.height, pr.ocr_version, pr.created_at AS read_at, l.item_url
     FROM photo_values pv JOIN photo_reads pr ON pr.id = pv.photo_read_id JOIN lots l ON l.id = pv.lot_id WHERE pv.id=$1`,
    [Number(req.params.id)],
  );
  const v = r.rows[0];
  if (!v) return reply.code(404).send({ error: "No such photo value" });
  return {
    kind: "photo", field: v.field, value: v.value, quote: v.quote, confidence: Number(v.confidence), boxes: v.boxes,
    width: v.width, height: v.height, image: `/api/photos/${v.read_id}/image`, imageUrl: v.image_url, sha256: v.image_sha256,
    ocr: v.ocr_version, readAt: v.read_at, lotUrl: v.item_url,
  };
});

/** The stored copy of a lot photo (re-hashed on read). */
app.get<{ Params: { id: string } }>("/api/photos/:id/image", async (req, reply) => {
  const r = await db.query(`SELECT image_sha256, content_type FROM photo_reads WHERE id=$1`, [Number(req.params.id)]);
  if (!r.rows[0]) return reply.code(404).send({ error: "No such photo" });
  reply.header("Cache-Control", "private, max-age=86400").type(r.rows[0].content_type);
  return store.get(r.rows[0].image_sha256);
});

/** A raw field from a stored response (a bid, a close time, a final bid). */
app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/snapshots/:id/field", async (req, reply) => {
  const p = req.query.path ?? "";
  if (!/^[\w.]+$/.test(p)) return reply.code(400).send({ error: "Bad path" });
  const { doc, meta } = await loadSnapshotDoc(db, store, Number(req.params.id));
  const value = resolvePath(doc, p);
  const parent = p.includes(".") ? resolvePath(doc, p.split(".").slice(0, -1).join(".")) : null;
  const context = parent && typeof parent === "object" && !Array.isArray(parent)
    ? Object.fromEntries(
        Object.entries(parent as Record<string, unknown>)
          .filter(([k]) => ["id", "lot_number", "title", "current_bid", "bid_count", "end_time", "ends", "starting_bid", "buyer_premium", "category_name"].includes(k)),
      )
    : null;
  return { kind: "field", path: p, value, context, snapshot: snapshotMeta(meta) };
});

/** Premium or GST wording from an auction's payment terms. */
app.get<{ Params: { auction: string; which: string } }>("/api/terms/:auction/:which", async (req, reply) => {
  const t = (await db.query(`SELECT * FROM auction_terms WHERE auction_id=$1 ORDER BY id DESC LIMIT 1`, [Number(req.params.auction)])).rows[0];
  if (!t) return reply.code(404).send({ error: "Terms not read yet" });
  const which = req.params.which === "gst" ? "gst" : "premium";
  const { doc, meta } = await loadSnapshotDoc(db, store, t.snapshot_id);
  const text = cleanText(resolvePath(doc, t.snapshot_path));
  const start = t[`${which}_start`];
  const end = t[`${which}_end`];
  const quote = t[`${which}_quote`];
  return {
    kind: "spec", field: which, value: `${t[`${which}_rate`]}%`, method: "parser:terms", source: "payment terms",
    path: t.snapshot_path, text, start, end, quote, verified: quote !== null && text.slice(start, end) === quote,
    clean: CLEAN_VERSION, snapshot: snapshotMeta(meta),
  };
});

app.get("/api/scans/current", async () => {
  const r = await db.query(`SELECT * FROM scan_runs ORDER BY (state IN ('queued','running')) DESC, id DESC LIMIT 1`);
  return { run: r.rows[0] ?? null };
});

app.get("/api/scans", async () => {
  const r = await db.query(`SELECT * FROM scan_runs ORDER BY id DESC LIMIT 25`);
  return { runs: r.rows };
});

app.post<{ Body: { kind?: RunKind; resume?: boolean; options?: RunOptions } }>("/api/scans", async (req) => {
  const kind: RunKind = req.body?.kind === "history" ? "history" : "live";
  const opts = req.body?.options ?? {};
  const options: RunOptions = {};
  if (Number(opts.maxPages) > 0) options.maxPages = Number(opts.maxPages);
  if (Number(opts.maxDetails) > 0) options.maxDetails = Number(opts.maxDetails);
  if (typeof opts.category === "string" && opts.category) options.category = opts.category;
  return startRun(db, kind, options, !!req.body?.resume, { trigger: "manual", startedBy: uid(req) });
});

app.post<{ Params: { id: string } }>("/api/scans/:id/cancel", async (req) => {
  await db.query(`UPDATE scan_runs SET state='cancelled', finished_at=now(), stop_reason='Stopped by you' WHERE id=$1 AND state IN ('queued','running')`, [Number(req.params.id)]);
  return { ok: true };
});

app.put<{ Params: { id: string }; Body: { maxAllIn?: number | null; note?: string | null } }>("/api/favourites/:id", async (req) => {
  await db.query(
    `INSERT INTO favourites (user_id, lot_id, max_all_in, note) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, lot_id) DO UPDATE SET max_all_in=EXCLUDED.max_all_in, note=EXCLUDED.note`,
    [uid(req), Number(req.params.id), req.body?.maxAllIn ?? null, req.body?.note ?? null],
  );
  return { ok: true };
});

app.delete<{ Params: { id: string } }>("/api/favourites/:id", async (req) => {
  await db.query(`DELETE FROM favourites WHERE user_id=$1 AND lot_id=$2`, [uid(req), Number(req.params.id)]);
  return { ok: true };
});

/** One request to number8.bid now: the latest bid, close time and friends' bids for this lot. */
app.post<{ Params: { id: string } }>("/api/lots/:id/refresh", async (req, reply) => {
  const abort = new AbortController();
  try {
    await refreshLot(db, store, ctx.makeTransport(abort.signal), Number(req.params.id));
    return { ok: true };
  } catch (e) {
    return reply.code(502).send({ error: `Could not refresh: ${(e as Error).message}` });
  }
});

app.get("/api/summary", async (req) => {
  const r = await db.query(`
    SELECT count(*) FILTER (WHERE status='open')::int AS live,
           count(*) FILTER (WHERE status='open' AND is_it)::int AS live_it,
           count(*) FILTER (WHERE status='closed')::int AS closed,
           count(*) FILTER (WHERE status='closed' AND final_bid > 0)::int AS sold,
           (SELECT count(*)::int FROM auctions WHERE ends_at > now()) AS live_auctions,
           (SELECT count(*)::int FROM favourites WHERE user_id=$1) AS watching,
           (SELECT max(finished_at) FROM scan_runs WHERE kind='live' AND state='complete') AS last_live_scan,
           (SELECT max(finished_at) FROM scan_runs WHERE kind='history' AND state IN ('complete','partial')) AS last_history_scan
    FROM lots`, [uid(req)]);
  return r.rows[0];
});

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

await app.listen({ port: config.apiPort, host: config.host });
console.log(`BidScout on http://${config.host}:${config.apiPort}${config.password ? " (password required)" : ""}`);

if (process.env.BIDSCOUT_INLINE_WORKER !== "0") {
  console.log("Scan worker running in this process (set BIDSCOUT_INLINE_WORKER=0 to use npm run worker instead).");
  void runWorkerLoop(ctx);
}
