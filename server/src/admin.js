/* ============================================================================
   admin.js — the moderation console.
   ----------------------------------------------------------------------------
   The `reports` table has been filling up since the realtime layer landed and
   nothing has ever read it. This module is the other half of that loop: it
   surfaces what players filed, lets a moderator look the accused up, and turns
   a decision into a sanction the rest of the server actually enforces.

   SECURITY MODEL
     * Every route lives under /api/admin and is gated by one shared secret
       carried in the `X-Admin-Token` header. The token is NEVER accepted from
       the query string: nginx writes URLs to its access log verbatim, and a
       token in a log file is a token on disk forever.
     * If ADMIN_TOKEN is unset the console does not exist — every path answers a
       flat 404. "Off" means invisible, not "open to everyone".
     * A wrong token gets the same 404 as an unknown path, so a stranger cannot
       even learn that a console is mounted here. Every rejection is logged with
       the caller's IP so the operator sees probing in the log instead.
     * 30 requests per minute per IP, applied BEFORE the token check, so the
       secret cannot be brute-forced at line rate.

   WHAT THIS MODULE OWNS
     The `sanctions` table, created here with CREATE TABLE IF NOT EXISTS so it
     can land while another change to db.js is in flight. One row per punished
     account; a row whose two deadlines have both passed is inert and gets swept.

   WHAT THIS MODULE DOES NOT DO
     It does not enforce anything on its own. A ban revokes sessions and asks the
     realtime layer to cut the socket, but the *doors* — login, WebSocket accept,
     chat — are in other files, and this module only exports the two predicates
     they should call. See "ENFORCEMENT WIRING" below for exactly where.

   Mount from index.js, BEFORE the `unknown /api/* -> 404` catch-all:

       import * as RT from './realtime.js';
       import { child } from './log.js';
       import { mountAdmin } from './admin.js';

       mountAdmin(app, { db: DB, log: child({ mod: 'admin' }), realtime: RT });

   deps.db     — the db.js module namespace (or the raw better-sqlite3 handle).
   deps.log    — { info, warn, error } called as (message, fields), which is the
                 convention log.js already uses; console stands in if absent.
   deps.realtime — the realtime.js namespace. Every capability beyond the two
                   functions it already exports is feature-detected, so this
                   module keeps working as that file grows a presence or kick API.
   ========================================================================== */

import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

// Fallback source for the raw SQLite handle when deps.db turns out to be
// something unexpected. Importing db.js is read-only — the singleton Database
// it exports is the same object index.js and realtime.js already share.
import * as DB from './db.js';
import { ipRateLimit } from './middleware.js';
import * as CLIENT_ERRORS from './clienterrors.js';

/* ------------------------------------------------------------- tuning ----- */
const RL_WINDOW_MS = 60 * 1000;      // rate-limit window
const RL_MAX = 30;                   // …and requests allowed inside it, per IP

const REPORTS_LIMIT_DEFAULT = 100;
const REPORTS_LIMIT_MAX = 500;
const PLAYERS_LIMIT_DEFAULT = 50;
const PLAYERS_LIMIT_MAX = 200;

const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // "most reported" lookback
const HOT_LIMIT = 10;

const MINUTES_MAX = 525600;          // one year, for a timed sanction
const BAN_MINUTES_MAX = MINUTES_MAX * 10;
const REASON_MAX = 200;
const USERNAME_MAX = 64;
const QUERY_MAX = 64;

/* A ban with no end date. A real timestamp rather than a sentinel like -1, so
   every "until" field in this module means the same thing and JSON consumers
   need no special case. 2100-01-01T00:00:00Z. */
const PERMANENT = 4102444800000;

/* Fully inert sanction rows are swept once they are this old, which keeps a
   month of recent moderation history visible in /players. */
const SANCTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* Worlds, for the per-room head count. WORLD_KEYS from game/rules.js would be
   authoritative, but importing it just for a label list would couple the admin
   console to the game rules; the realtime adapter uses whatever presence
   reports and falls back to this list only for counts. */
const FALLBACK_WORLDS = ['isle', 'mine', 'volcano', 'frost', 'cave'];

const COUNTED_TABLES = [
  'users', 'saves', 'sessions', 'action_log',
  'reports', 'deeds', 'crew_members', 'crew_requests', 'sanctions',
];

/* ============================================================================
   DATABASE PLUMBING
   ----------------------------------------------------------------------------
   Every query in this file is a prepared statement against the raw handle.
   Nothing here calls into the db.js repositories: those are being edited in
   parallel, and an admin console that breaks when a helper is renamed is worse
   than one that owns its own SQL.
   ========================================================================== */

let injectedDb = null;   // whatever mountAdmin was handed as deps.db
let rawDb = null;        // the resolved better-sqlite3 Database

/** Is this object a usable better-sqlite3 handle? */
function isHandle(x) {
  return !!x && typeof x.prepare === 'function' && typeof x.exec === 'function';
}

/**
 * Find the raw handle. deps.db may be the db.js namespace (the common case),
 * the Database itself, or absent entirely — all three resolve here, with the
 * static import as the last resort so isBanned()/isMuted() work even when
 * mountAdmin() was never called because ADMIN_TOKEN is unset.
 */
function resolveDb() {
  if (rawDb) return rawDb;

  const candidates = [
    injectedDb,
    injectedDb && injectedDb.db,
    injectedDb && injectedDb.database,
    injectedDb && injectedDb.default && injectedDb.default.db,
    DB.db,
    DB.database,
    DB.default && DB.default.db,
  ];
  for (const c of candidates) {
    if (isHandle(c)) { rawDb = c; break; }
  }
  return rawDb;
}

/** Point mountAdmin's handle at the cache, discarding statements if it moved. */
function setDb(dep) {
  injectedDb = dep || null;
  const before = rawDb;
  rawDb = null;
  const after = resolveDb();
  if (before && after !== before) {
    stmtCache.clear();
    schemaState = 'pending';
  }
  return after;
}

// Statements are prepared on first use and memoised. Preparing eagerly is not
// an option: `sanctions` does not exist until ensureSchema() has run.
const stmtCache = new Map();
function q(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    const handle = resolveDb();
    if (!handle) throw new Error('admin: no SQLite handle available');
    stmt = handle.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

const tableCache = new Map();
/** Does a table exist? Cached once true — tables are only ever created at boot. */
function tableExists(name) {
  if (tableCache.get(name)) return true;
  const handle = resolveDb();
  if (!handle) return false;
  try {
    const row = handle
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(String(name));
    if (row) tableCache.set(name, true);
    return !!row;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- schema --- */

let schemaState = 'pending';   // 'pending' | 'ok' | 'failed'

/**
 * Create the sanctions table. Idempotent and deliberately self-contained: it
 * does not touch db.js's initSchema(), so this module can land while another
 * agent holds that file.
 *
 * Column meanings — both deadlines are epoch ms, 0 meaning "no such sanction":
 *   muted_until   the account may not speak in chat until this moment
 *   banned_until  the account may not hold a session until this moment
 *   reason        operator's note, shown to the player when a ban is refused
 *   at            when the row was last written, used by the sweep
 */
function ensureSchema() {
  if (schemaState === 'ok') return true;

  const handle = resolveDb();
  if (!handle) { schemaState = 'failed'; return false; }

  try {
    handle.exec(`
      CREATE TABLE IF NOT EXISTS sanctions (
        user_id      INTEGER PRIMARY KEY,
        muted_until  INTEGER NOT NULL DEFAULT 0,
        banned_until INTEGER NOT NULL DEFAULT 0,
        reason       TEXT,
        at           INTEGER NOT NULL DEFAULT 0
      );
    `);
    tableCache.set('sanctions', true);
    schemaState = 'ok';
    return true;
  } catch (e) {
    schemaState = 'failed';
    console.error('[admin.schema]', e);
    return false;
  }
}

/* ============================================================================
   SANCTION LOOKUPS — the two predicates the rest of the server calls.
   ----------------------------------------------------------------------------
   Both are deliberately fail-OPEN. If the table is missing or the read throws,
   they answer "not sanctioned". A broken admin table must never lock the whole
   playerbase out of their accounts; the failure is loud in the log instead.

   No caching. These run on login, on WebSocket accept and on chat lines, all of
   which are already rate limited, and a primary-key lookup in SQLite costs a
   few microseconds. A cache would only buy staleness — precisely the wrong
   trade when the point of a ban is that it takes effect NOW.
   ========================================================================== */

const SQL_SANCTION = 'SELECT muted_until, banned_until, reason FROM sanctions WHERE user_id = ?';

/** Raw row for an account, or null. Never throws. */
function sanctionRow(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  if (!ensureSchema()) return null;
  try {
    return q(SQL_SANCTION).get(id) || null;
  } catch (e) {
    console.error('[admin.sanction]', e);
    return null;
  }
}

/**
 * Is this account banned right now?
 * @returns {{banned: boolean, until: number, reason: string}}
 *          `until` is epoch ms (PERMANENT for an open-ended ban), 0 when clear.
 */
export function isBanned(userId) {
  const row = sanctionRow(userId);
  const until = row ? Number(row.banned_until) || 0 : 0;
  if (until > Date.now()) {
    return { banned: true, until, reason: row.reason ? String(row.reason) : '' };
  }
  return { banned: false, until: 0, reason: '' };
}

/**
 * Is this account muted right now?
 * @returns {{muted: boolean, until: number}}
 */
export function isMuted(userId) {
  const row = sanctionRow(userId);
  const until = row ? Number(row.muted_until) || 0 : 0;
  if (until > Date.now()) return { muted: true, until };
  return { muted: false, until: 0 };
}

/* ============================================================================
   ENFORCEMENT WIRING — where the two predicates above are called.
   ----------------------------------------------------------------------------
   This module still enforces nothing itself. The doors live in other files and
   each one calls in here; this is the map, so a route added later knows which
   gate it is missing.

   1. auth.js — the password front door.
      suspended() answers 403 ACCOUNT_SUSPENDED from POST /api/auth/login and
      from GET /api/auth/me, which is what session resume actually is. Both sit
      AFTER the credential check: asking first would turn either route into an
      oracle telling anyone which accounts are banned.

   2. wallet.js — the signature front door.
      Same suspended() answer in POST /api/auth/wallet/verify, after the
      signature has been recovered and the account row resolved.

      /api/auth/guest needs nothing: it mints a brand-new account id every call,
      so there is never a pre-existing sanction to find. (Ban evasion by
      re-rolling a guest is a separate problem and belongs to whoever owns guest
      throttling.)

   3. index.js — requireNotBanned, wrapped around requireAuth's output.
      /ban deletes every session row, so the usual answer is a 401 on the very
      next request; this gate closes the remaining window — a token minted
      microseconds before the ban landed. It guards every route that MOVES
      something: /api/action/:name, /api/save, /api/ledger/claim, the six crew
      mutations and /api/report. Reads stay open so a suspended player can still
      load the isle and read why they cannot act.

   4. realtime.js — the socket, and the megaphone.
      onConnection() refuses the handshake with CLOSE_BANNED (4403); heartbeat()
      cuts an account banned mid-session within one PING_MS; onChat() answers
      {t:'chat_err', m:'muted', until} after the CHAT_GAP throttle, so the gag
      cannot be spent as a free rate-limit probe; and kick(), which /ban
      feature-detects below, drops the socket the instant the sanction lands.

   5. Still open, and still optional — a presence listing would turn
      /api/admin/online from bare head-counts into names. Detected below as
      presence / presenceList / onlineList / listOnline / onlinePlayers / peers,
      expected to return [{ userId, name, world, id }] — the exact shape of
      realtime.js's peerPayload() plus the account id:

        export function presence() {
          const out = [];
          for (const [world, room] of rooms) {
            for (const p of room) out.push({ userId: p.userId, id: p.id, name: p.name, world });
          }
          return out;
        }
   ========================================================================== */

/* ============================================================================
   SMALL HELPERS
   ========================================================================== */

const now = () => Date.now();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** A wallet address as `0x1234…abcd`. Full addresses stay out of admin JSON. */
function maskWallet(wallet) {
  if (typeof wallet !== 'string') return null;
  const s = wallet.trim();
  if (!s) return null;
  if (s.length <= 12) return s;      // too short to be a real address; show as-is
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Wrap a search term for LIKE, escaping the wildcards a user could type. */
function likeArg(term) {
  return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Trim a free-text field to something safe to store and to print. Control
 * characters become spaces so a moderator note can never smuggle a newline
 * (or an ANSI escape) into the audit log and forge a second line there.
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Shape a sanction row for the wire, resolving "expired" to "clear". */
function sanctionView(row) {
  const t = now();
  const muted = row ? Number(row.muted_until) || 0 : 0;
  const banned = row ? Number(row.banned_until) || 0 : 0;
  return {
    muted: muted > t,
    mutedUntil: muted > t ? muted : 0,
    banned: banned > t,
    bannedUntil: banned > t ? banned : 0,
    permanent: banned >= PERMANENT,
    reason: row && row.reason ? String(row.reason) : '',
  };
}

/**
 * Parse a duration argument.
 *   absent / null  -> { permanent: true }   (only where the caller allows it)
 *   positive number-> { minutes }
 *   anything else  -> { error }
 * A typo'd `minutes: "soon"` must never be read as "forever", which is why
 * garbage is an error rather than a fallback.
 */
function parseMinutes(value, { allowPermanent, max }) {
  if (value === undefined || value === null || value === '') {
    if (allowPermanent) return { permanent: true, minutes: null };
    return { error: 'minutes is required and must be a positive number' };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: 'minutes must be a positive number' };
  }
  if (n > max) return { error: `minutes must be at most ${max}` };
  return { permanent: false, minutes: Math.round(n) };
}

/* ============================================================================
   LOGGING
   ----------------------------------------------------------------------------
   deps.log is whatever the logging change lands with. The call shape is
   (message, fields) — the common convention — but the human-readable half of
   every audit line repeats the action and target, so the record survives even
   under a logger that formats its arguments differently (pino's (obj, msg)
   ordering, for instance, renders the fields into the message instead).
   ========================================================================== */

function makeLog(injected) {
  const call = (level, fallback) => (msg, fields) => {
    if (injected && typeof injected[level] === 'function') {
      try { injected[level](msg, fields); return; } catch { /* fall through */ }
    }
    fallback(`[admin] ${msg}`, fields ? JSON.stringify(fields) : '');
  };
  return {
    info: call('info', console.log.bind(console)),
    warn: call('warn', console.warn.bind(console)),
    error: call('error', console.error.bind(console)),
  };
}

let log = makeLog(null);

/**
 * The audit trail. Every state-changing admin call goes through here, and the
 * field set is fixed — {admin, action, target, minutes} — so the log is
 * greppable and a filter on `admin:true` returns the whole moderation history.
 */
function audit(action, target, minutes, extra) {
  const shown = minutes === null || minutes === undefined ? 'permanent' : `${minutes}m`;
  log.info(`admin ${action}: ${target} (${shown})`, {
    admin: true,
    action,
    target: String(target),
    minutes: minutes === undefined ? null : minutes,
    ...(extra || {}),
  });
}

/* ============================================================================
   REALTIME ADAPTER
   ----------------------------------------------------------------------------
   realtime.js currently exports onlineTotal() and roomCount(world) and nothing
   else about who is where. Rather than reach into its module state — which this
   module cannot do and should not want to — every richer capability is
   feature-detected under the handful of names it might plausibly get, and each
   one degrades to something honest: counts without names, `online: null` rather
   than a guessed false, `kicked: false` with a note rather than a silent lie.
   ========================================================================== */

let rt = null;

/** First callable member of `names`, bound to the module, or null. */
function pick(names) {
  if (!rt) return null;
  for (const name of names) {
    const fn = rt[name];
    if (typeof fn === 'function') return fn.bind(rt);
  }
  return null;
}

/** Everyone online, as [{userId, peerId, name, world}], or null if unavailable. */
function presenceList() {
  const fn = pick(['presence', 'presenceList', 'onlineList', 'listOnline', 'onlinePlayers', 'peers']);
  if (!fn) return null;

  let raw;
  try { raw = fn(); } catch (e) { log.error('realtime presence failed', { err: String(e) }); return null; }
  if (!Array.isArray(raw)) return null;

  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const userId = Number(entry.userId ?? entry.user_id ?? entry.uid);
    if (!Number.isFinite(userId)) continue;
    out.push({
      userId,
      peerId: Number(entry.peerId ?? entry.id) || null,
      name: typeof entry.name === 'string' ? entry.name
        : (typeof entry.username === 'string' ? entry.username : ''),
      world: typeof entry.world === 'string' ? entry.world
        : (typeof entry.room === 'string' ? entry.room : ''),
    });
  }
  return out;
}

/** Head-count per world plus the total, from presence when possible. */
function onlineSnapshot() {
  const players = presenceList();
  const counts = {};
  const worlds = {};

  if (players) {
    for (const p of players) {
      const w = p.world || '(lobby)';
      counts[w] = (counts[w] || 0) + 1;
      (worlds[w] || (worlds[w] = [])).push(p);
    }
    return { detail: true, total: players.length, counts, worlds, players };
  }

  // Counts-only fallback: exactly what /api/online already publishes.
  const roomCount = pick(['roomCount']);
  const onlineTotal = pick(['onlineTotal']);
  if (!roomCount && !onlineTotal) {
    return { detail: false, total: null, counts: null, worlds: null, players: null };
  }
  if (roomCount) {
    for (const w of FALLBACK_WORLDS) {
      try { counts[w] = roomCount(w) | 0; } catch { counts[w] = 0; }
    }
  }
  let total = null;
  if (onlineTotal) {
    try { total = onlineTotal() | 0; } catch { total = null; }
  } else {
    total = Object.values(counts).reduce((a, b) => a + b, 0);
  }
  return { detail: false, total, counts, worlds: null, players: null };
}

/** Set of online account ids, or null when presence is unavailable. */
function onlineIds() {
  const players = presenceList();
  if (!players) return null;
  return new Set(players.map((p) => p.userId));
}

/**
 * Is one account online? `null` means "cannot tell" and is reported as such —
 * a false here would read as "definitely offline", which is a different claim.
 */
function isOnline(userId, cachedIds) {
  if (cachedIds instanceof Set) return cachedIds.has(userId);
  const fn = pick(['isOnline']);
  if (fn) {
    try { return !!fn(userId); } catch { return null; }
  }
  return null;
}

/** Ask the realtime layer to cut a socket. Returns true only if it confirmed. */
function kickSocket(userId, reason) {
  const fn = pick(['kick', 'kickUser', 'disconnectUser', 'dropUser', 'closeUser', 'evict']);
  if (!fn) return false;
  try { return fn(userId, reason) !== false; } catch (e) {
    log.error('realtime kick failed', { err: String(e) });
    return false;
  }
}

/* ============================================================================
   TOKEN CHECK + RATE LIMIT
   ========================================================================== */

let adminToken = '';

/**
 * Constant-time token comparison.
 *
 * timingSafeEqual throws on a length mismatch, so the two sides must be the
 * same length before it is called — and padding or truncating would leak the
 * secret's length through the throw. Hashing both sides to a fixed 32 bytes
 * equalises the length without ever short-circuiting on content, and the digest
 * comparison is exactly as strong as comparing the tokens themselves.
 */
function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (!adminToken) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(adminToken, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// The console keeps its own wording and omits the RATE_LIMIT code, so that a
// 429 from here never reads to a client like one from a game route.
const rateLimit = ipRateLimit({
  max: RL_MAX, windowMs: RL_WINDOW_MS,
  message: 'too many admin requests', code: null
});

/**
 * Token gate. A failure answers 404, not 401: the console should be
 * indistinguishable from a path that does not exist. The operator still learns
 * about every attempt from the log line.
 */
function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-token');
  if (!tokenMatches(provided)) {
    log.warn('admin auth rejected', {
      admin: true,
      action: 'auth-reject',
      ip: clientIp(req),
      path: req.originalUrl,
      presented: typeof provided === 'string' && provided.length > 0,
    });
    return res.status(404).json({ error: 'not found' });
  }
  next();
}

/* ============================================================================
   QUERIES
   ========================================================================== */

const SQL_REPORTS = `
  SELECT r.id            AS id,
         r.reporter_id   AS reporterId,
         r.target        AS target,
         r.reason        AS reason,
         r.detail        AS detail,
         r.at            AS at,
         ru.username     AS reporterName,
         tu.id           AS targetId,
         tu.username     AS targetName
  FROM reports r
  LEFT JOIN users ru ON ru.id = r.reporter_id
  LEFT JOIN users tu ON tu.username = r.target
  WHERE r.at >= ?
  ORDER BY r.at DESC, r.id DESC
  LIMIT ?`;

/* users.username is COLLATE NOCASE, so the join above and this grouping are
   both case-insensitive without any extra work. */
const SQL_HOT_TARGETS = `
  SELECT r.target AS target, COUNT(*) AS count, MAX(r.at) AS lastAt
  FROM reports r
  WHERE r.at >= ?
  GROUP BY r.target COLLATE NOCASE
  ORDER BY count DESC, lastAt DESC
  LIMIT ?`;

const PLAYER_COLUMNS = `
         u.id            AS id,
         u.username      AS username,
         u.wallet        AS wallet,
         u.created_at    AS createdAt,
         COALESCE(json_extract(s.state, '$.coins'), 0) AS coins,
         COALESCE(json_extract(s.state, '$.world'), '') AS world,
         s.updated_at    AS savedAt`;

const SQL_PLAYERS_ALL = `
  SELECT ${PLAYER_COLUMNS}
  FROM users u LEFT JOIN saves s ON s.user_id = u.id
  ORDER BY u.id DESC
  LIMIT ?`;

const SQL_PLAYERS_SEARCH = `
  SELECT ${PLAYER_COLUMNS}
  FROM users u LEFT JOIN saves s ON s.user_id = u.id
  WHERE u.username LIKE ? ESCAPE '\\'
     OR COALESCE(u.wallet, '') LIKE ? ESCAPE '\\'
  ORDER BY u.id DESC
  LIMIT ?`;

const SQL_FIND_USER = 'SELECT id, username FROM users WHERE username = ?';

const SQL_MUTE = `
  INSERT INTO sanctions (user_id, muted_until, banned_until, reason, at)
  VALUES (?, ?, 0, NULL, ?)
  ON CONFLICT(user_id) DO UPDATE SET muted_until = excluded.muted_until,
                                     at          = excluded.at`;

const SQL_UNMUTE = 'UPDATE sanctions SET muted_until = 0, at = ? WHERE user_id = ?';

const SQL_BAN = `
  INSERT INTO sanctions (user_id, muted_until, banned_until, reason, at)
  VALUES (?, 0, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET banned_until = excluded.banned_until,
                                     reason       = excluded.reason,
                                     at           = excluded.at`;

const SQL_UNBAN = 'UPDATE sanctions SET banned_until = 0, reason = NULL, at = ? WHERE user_id = ?';

const SQL_DROP_SESSIONS = 'DELETE FROM sessions WHERE user_id = ?';

/* Sweep rows that are inert AND stale. The staleness clause is what keeps a
   month of "was banned last week" visible in /players instead of vanishing the
   moment the ban lapses. */
const SQL_SWEEP = `
  DELETE FROM sanctions
  WHERE muted_until <= ? AND banned_until <= ? AND at < ?`;

const SQL_SANCTION_COUNTS = `
  SELECT SUM(CASE WHEN muted_until  > ? THEN 1 ELSE 0 END) AS muted,
         SUM(CASE WHEN banned_until > ? THEN 1 ELSE 0 END) AS banned,
         COUNT(*)                                          AS total
  FROM sanctions`;

/** Sanctions for a batch of account ids, as Map<id, view>. */
function sanctionsFor(ids) {
  const out = new Map();
  const wanted = [...new Set(ids.filter((id) => Number.isFinite(id)))];
  if (!wanted.length || !ensureSchema()) return out;

  for (const id of wanted) {
    try {
      const row = q(SQL_SANCTION).get(id);
      if (row) out.set(id, sanctionView(row));
    } catch (e) {
      console.error('[admin.sanctionsFor]', e);
      break;   // the table is unreadable; one log line is enough
    }
  }
  return out;
}

function sweepSanctions() {
  if (!ensureSchema()) return 0;
  const t = now();
  try {
    return q(SQL_SWEEP).run(t, t, t - SANCTION_TTL_MS).changes;
  } catch (e) {
    console.error('[admin.sweep]', e);
    return 0;
  }
}

/* ============================================================================
   MOUNT
   ========================================================================== */

/**
 * Mount the moderation console on an express app.
 *
 * @param {import('express').Express} app
 * @param {{db?: unknown, log?: {info?: Function, warn?: Function, error?: Function}, realtime?: unknown}} deps
 * @returns {{enabled: boolean}} so the caller can report the state at boot.
 */
export function mountAdmin(app, deps = {}) {
  log = makeLog(deps.log);
  rt = deps.realtime || null;
  setDb(deps.db);

  adminToken = typeof process.env.ADMIN_TOKEN === 'string' ? process.env.ADMIN_TOKEN.trim() : '';

  /* ---- feature off: every path answers 404, and nothing else is built ---- */
  if (!adminToken) {
    const dead = express.Router();
    dead.use((req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(404).json({ error: 'not found' });
    });
    app.use('/api/admin', dead);
    log.warn('ADMIN_TOKEN is not set · the moderation console is disabled (all /api/admin routes answer 404)', {
      admin: true, action: 'disabled', target: '-', minutes: null,
    });
    return { enabled: false };
  }

  if (adminToken.length < 24) {
    log.warn(`ADMIN_TOKEN is only ${adminToken.length} characters · use at least 32 random ones (openssl rand -hex 24)`, {
      admin: true, action: 'weak-token', target: '-', minutes: null,
    });
  }

  // The table is created at mount so the first ban is not also the first
  // CREATE TABLE, and so a broken database shouts at boot rather than later.
  if (!ensureSchema()) {
    log.error('sanctions table could not be created · mutes and bans will not persist', {
      admin: true, action: 'schema-failed', target: '-', minutes: null,
    });
  }

  const router = express.Router();
  const json = express.json({ limit: '16kb' });

  // No admin response is ever cacheable, by a browser or by nginx.
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(rateLimit);
  router.use(requireAdmin);

  /** 503 for a database that will not hold sanctions. */
  const needSchema = (res) => {
    if (ensureSchema()) return false;
    res.status(503).json({ error: 'sanctions table unavailable' });
    return true;
  };

  /** Resolve a {username} body field to an account row, answering on failure. */
  function resolveTarget(req, res) {
    const body = req.body || {};
    const username = cleanText(body.username, USERNAME_MAX);
    if (!username) {
      res.status(400).json({ error: 'username is required' });
      return null;
    }
    let row;
    try {
      row = q(SQL_FIND_USER).get(username);
    } catch (e) {
      log.error('user lookup failed', { err: String(e) });
      res.status(500).json({ error: 'lookup failed' });
      return null;
    }
    if (!row) {
      res.status(404).json({ error: 'no such account' });
      return null;
    }
    return row;
  }

  /* ---------------------------------------------------------------- index -- */
  router.get('/', (req, res) => {
    res.json({
      ok: true,
      console: 'reelfortune-admin',
      serverTime: now(),
      routes: [
        'GET  /api/admin/reports?limit=100&since=<ms>',
        'GET  /api/admin/players?q=<substr>&limit=50',
        'GET  /api/admin/online',
        'GET  /api/admin/stats',
        'POST /api/admin/mute    {username, minutes}',
        'POST /api/admin/unmute  {username}',
        'POST /api/admin/ban     {username, minutes?, reason}',
        'POST /api/admin/unban   {username}',
      ],
    });
  });

  /* -------------------------------------------------------------- reports -- */
  /* The whole reason this module exists: player reports, with both names
     resolved and the accused's current standing folded in, so a moderator can
     act on a row without a second request. */
  router.get('/reports', (req, res) => {
    if (!tableExists('reports')) {
      return res.json({ reports: [], hotTargets: [], count: 0, note: 'reports table not created yet' });
    }

    const limit = clampInt(req.query.limit, 1, REPORTS_LIMIT_MAX, REPORTS_LIMIT_DEFAULT);
    const since = clampInt(req.query.since, 0, Number.MAX_SAFE_INTEGER, 0);

    let rows;
    let hot = [];
    try {
      rows = q(SQL_REPORTS).all(since, limit);
      hot = q(SQL_HOT_TARGETS).all(now() - HOT_WINDOW_MS, HOT_LIMIT);
    } catch (e) {
      log.error('reports query failed', { err: String(e) });
      return res.status(500).json({ error: 'could not read reports' });
    }

    const marks = sanctionsFor(rows.map((r) => r.targetId));
    const online = onlineIds();

    res.json({
      count: rows.length,
      limit,
      since,
      reports: rows.map((r) => ({
        id: r.id,
        at: r.at,
        reason: r.reason || '',
        detail: r.detail || '',
        reporter: { id: r.reporterId, name: r.reporterName || null },
        // `target` is free text on the wire (realtime.js sends the peer's
        // display name), so it may or may not resolve to a live account.
        target: {
          text: r.target,
          id: r.targetId ?? null,
          name: r.targetName ?? null,
          online: r.targetId != null ? isOnline(r.targetId, online) : null,
          sanction: r.targetId != null ? (marks.get(r.targetId) || sanctionView(null)) : null,
        },
      })),
      // Triage aid: who is being reported repeatedly, over the last 7 days,
      // regardless of the `since` filter above.
      hotTargets: hot.map((h) => ({ target: h.target, count: h.count, lastAt: h.lastAt })),
      hotWindowMs: HOT_WINDOW_MS,
    });
  });

  /* -------------------------------------------------------------- players -- */
  router.get('/players', (req, res) => {
    const limit = clampInt(req.query.limit, 1, PLAYERS_LIMIT_MAX, PLAYERS_LIMIT_DEFAULT);
    const term = cleanText(req.query.q, QUERY_MAX);

    let rows;
    try {
      rows = term
        ? q(SQL_PLAYERS_SEARCH).all(likeArg(term), likeArg(term), limit)
        : q(SQL_PLAYERS_ALL).all(limit);
    } catch (e) {
      log.error('players query failed', { err: String(e) });
      return res.status(500).json({ error: 'could not read accounts' });
    }

    const marks = sanctionsFor(rows.map((r) => r.id));
    const online = onlineIds();

    res.json({
      count: rows.length,
      limit,
      q: term,
      players: rows.map((r) => ({
        id: r.id,
        username: r.username,
        // Masked, never whole: an admin needs to recognise an address, not to
        // copy one out of a console into somewhere it does not belong.
        wallet: maskWallet(r.wallet),
        hasWallet: !!r.wallet,
        createdAt: r.createdAt,
        // Read-only economy peek, straight out of the save. Nothing in this
        // module ever writes a save — an admin who could edit coins would make
        // every audit of the economy meaningless.
        coins: Number(r.coins) || 0,
        world: r.world || '',
        savedAt: r.savedAt || null,
        online: isOnline(r.id, online),
        sanction: marks.get(r.id) || sanctionView(null),
      })),
      // Honest about the limits of what we know.
      onlineKnown: online !== null,
    });
  });

  /* --------------------------------------------------------------- online -- */
  router.get('/online', (req, res) => {
    const snap = onlineSnapshot();
    const payload = {
      total: snap.total,
      counts: snap.counts,
      detail: snap.detail,
      serverTime: now(),
    };

    if (snap.detail) {
      const marks = sanctionsFor(snap.players.map((p) => p.userId));
      payload.worlds = {};
      for (const [world, list] of Object.entries(snap.worlds)) {
        payload.worlds[world] = list.map((p) => ({
          userId: p.userId,
          peerId: p.peerId,
          name: p.name,
          sanction: marks.get(p.userId) || sanctionView(null),
        }));
      }
    } else {
      payload.worlds = null;
      payload.note = 'realtime exposes head-counts only · see ENFORCEMENT WIRING (5) in admin.js '
                   + 'for the presence() export that turns this into names';
    }

    res.json(payload);
  });

  /* ----------------------------------------------------------------- mute -- */
  router.post('/mute', json, (req, res) => {
    if (needSchema(res)) return;
    const target = resolveTarget(req, res);
    if (!target) return;

    const dur = parseMinutes(req.body?.minutes, { allowPermanent: false, max: MINUTES_MAX });
    if (dur.error) return res.status(400).json({ error: dur.error });

    const until = now() + dur.minutes * 60 * 1000;
    try {
      // Deliberately leaves banned_until and reason alone: a mute and a ban are
      // independent sanctions on the same row, and muting must not quietly
      // shorten a standing ban.
      q(SQL_MUTE).run(target.id, until, now());
    } catch (e) {
      log.error('mute failed', { err: String(e) });
      return res.status(500).json({ error: 'could not apply mute' });
    }

    audit('mute', target.username, dur.minutes, { userId: target.id, until });
    res.json({ ok: true, username: target.username, userId: target.id, until, minutes: dur.minutes });
  });

  /* --------------------------------------------------------------- unmute -- */
  router.post('/unmute', json, (req, res) => {
    if (needSchema(res)) return;
    const target = resolveTarget(req, res);
    if (!target) return;

    let changed = 0;
    try {
      changed = q(SQL_UNMUTE).run(now(), target.id).changes;
    } catch (e) {
      log.error('unmute failed', { err: String(e) });
      return res.status(500).json({ error: 'could not lift mute' });
    }
    sweepSanctions();

    audit('unmute', target.username, null, { userId: target.id, changed: changed > 0 });
    res.json({ ok: true, username: target.username, userId: target.id, changed: changed > 0 });
  });

  /* ------------------------------------------------------------------ ban -- */
  router.post('/ban', json, (req, res) => {
    if (needSchema(res)) return;
    const target = resolveTarget(req, res);
    if (!target) return;

    // No `minutes` means permanent — the common case for a ban — but a
    // malformed one is an error, so a typo can never become a life sentence.
    const dur = parseMinutes(req.body?.minutes, { allowPermanent: true, max: BAN_MINUTES_MAX });
    if (dur.error) return res.status(400).json({ error: dur.error });

    const reason = cleanText(req.body?.reason, REASON_MAX);
    const until = dur.permanent ? PERMANENT : now() + dur.minutes * 60 * 1000;

    try {
      q(SQL_BAN).run(target.id, until, reason || null, now());
    } catch (e) {
      log.error('ban failed', { err: String(e) });
      return res.status(500).json({ error: 'could not apply ban' });
    }

    // Revoking the sessions is what makes the ban bite immediately: every HTTP
    // route runs through sessions.verify(), so the next request 401s.
    let revoked = 0;
    try {
      revoked = q(SQL_DROP_SESSIONS).run(target.id).changes;
    } catch (e) {
      log.error('session revoke failed', { err: String(e) });
    }

    // The WebSocket authenticates once at connect, so an open socket outlives
    // its session unless the realtime layer cuts it. realtime.js exports kick()
    // for exactly this; the heartbeat is the backstop if it ever goes away.
    const kicked = kickSocket(target.id, 'suspended');

    audit('ban', target.username, dur.permanent ? null : dur.minutes, {
      userId: target.id, until, reason, sessionsRevoked: revoked, kicked,
    });

    res.json({
      ok: true,
      username: target.username,
      userId: target.id,
      until,
      permanent: dur.permanent,
      minutes: dur.permanent ? null : dur.minutes,
      reason,
      sessionsRevoked: revoked,
      kicked,
      ...(kicked ? {} : {
        note: 'realtime exposed no kick hook · any open socket drops on its next '
            + 'heartbeat or reconnect (see ENFORCEMENT WIRING 4 in admin.js)',
      }),
    });
  });

  /* ---------------------------------------------------------------- unban -- */
  router.post('/unban', json, (req, res) => {
    if (needSchema(res)) return;
    const target = resolveTarget(req, res);
    if (!target) return;

    let changed = 0;
    try {
      changed = q(SQL_UNBAN).run(now(), target.id).changes;
    } catch (e) {
      log.error('unban failed', { err: String(e) });
      return res.status(500).json({ error: 'could not lift ban' });
    }
    sweepSanctions();

    audit('unban', target.username, null, { userId: target.id, changed: changed > 0 });
    res.json({ ok: true, username: target.username, userId: target.id, changed: changed > 0 });
  });

  /* ---------------------------------------------------------------- stats -- */
  /* What is breaking in players' browsers right now. Held in memory by
     clienterrors.js, newest first, identical faults collapsed with a count — so
     one player in a render loop reads as one row, not as the whole window. */
  router.get('/clienterrors', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    res.json({
      ...CLIENT_ERRORS.stats(),
      entries: CLIENT_ERRORS.recent(Number.isFinite(limit) ? limit : 100),
    });
  });

  router.get('/stats', (req, res) => {
    sweepSanctions();

    // db.stats() is being added to db.js separately; until it lands the table
    // counts below stand in for it rather than 500ing the whole route.
    let dbStats = null;
    const statsFn = injectedDb && typeof injectedDb.stats === 'function'
      ? injectedDb.stats.bind(injectedDb)
      : null;
    if (statsFn) {
      try { dbStats = statsFn(); } catch (e) { log.error('db.stats failed', { err: String(e) }); }
    }

    const tables = {};
    for (const name of COUNTED_TABLES) {
      if (!tableExists(name)) continue;
      try {
        // The table name is from COUNTED_TABLES, never from the request, so the
        // interpolation cannot carry anything a caller controls.
        tables[name] = q(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
      } catch { /* leave the entry out rather than fail the route */ }
    }

    let sizeBytes = null;
    try {
      const handle = resolveDb();
      const pages = handle.pragma('page_count', { simple: true });
      const pageSize = handle.pragma('page_size', { simple: true });
      sizeBytes = Number(pages) * Number(pageSize) || null;
    } catch { /* pragma unavailable; not worth failing over */ }

    let sanctions = null;
    if (ensureSchema()) {
      try {
        const t = now();
        const row = q(SQL_SANCTION_COUNTS).get(t, t);
        sanctions = { muted: row.muted || 0, banned: row.banned || 0, rows: row.rows || 0 };
      } catch (e) { log.error('sanction counts failed', { err: String(e) }); }
    }

    const snap = onlineSnapshot();
    const mem = process.memoryUsage();

    res.json({
      db: dbStats,
      tables,
      sizeBytes,
      sanctions,
      online: { total: snap.total, counts: snap.counts, detail: snap.detail },
      uptime: process.uptime(),
      serverTime: now(),
      node: process.version,
      pid: process.pid,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      adminSchema: schemaState,
    });
  });

  app.use('/api/admin', router);
  log.info('moderation console mounted at /api/admin', {
    admin: true, action: 'mounted', target: '/api/admin', minutes: null,
  });
  return { enabled: true };
}
