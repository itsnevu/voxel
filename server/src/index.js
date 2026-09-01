/* ============================================================================
   Reel Fortune 3D — authoritative game server
   ----------------------------------------------------------------------------
   The browser renders and sends INTENTS. Every coin, roll, drop and price is
   decided here. Nothing economic is ever read back from the client payload.

   Layout:
     src/index.js      <- this file (HTTP surface only, no game math)
     src/log.js        <- structured JSON logging, redaction by field name
     src/middleware.js <- request id, security headers, access log, error handler
     src/admin.js      <- moderation console + the sanction predicates
     src/db.js         <- sqlite repositories, migrations, maintenance
     src/auth.js       <- register/login/session middleware
     src/progress.js   <- achievements and Isle Ledger deeds, server-side
     src/game/rules.js <- fish tables, upgrade costs, newState()
     src/game/economy.js <- market epochs, stock prices, dividends
     src/game/actions.js <- one handler per intent

   The mount order further down is load bearing, and middleware.js explains why:
     requestId -> securityHeaders -> cors -> express.json -> accessLog
       -> routes -> admin console -> notFoundJson -> static -> errorHandler
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import * as DB from './db.js';
import { requireAuth, mountAuth } from './auth.js';
import { mountWalletAuth } from './wallet.js';
import { mountNft, ownsToken } from './nft.js';
import * as EV from './events.js';
import { HANDLERS, RATE } from './game/actions.js';
import { newState, normalizeState, int0, BOATS, boatSeats, crewSlots, MAX_BOAT } from './game/rules.js';
import { payDividends, mktEpochNow } from './game/economy.js';
// Both forms of the same module: the named imports are what the routes call,
// the namespace is what admin.js feature-detects against (it looks for a kick
// hook and a presence listing under several plausible names, so handing it the
// whole module means the console gains those the day realtime.js grows them).
import * as RT from './realtime.js';
import { attach, onlineTotal, roomCount, broadcast, announceAll, announceChar, closeAllSockets } from './realtime.js';
import { log, child, logLevel } from './log.js';
import {
  requestId, securityHeaders, accessLog, notFoundJson, errorHandler,
  installProcessGuards, onFatal, ipRateLimit
} from './middleware.js';
import { mountAdmin, isBanned } from './admin.js';
import * as PROGRESS from './progress.js';
import * as CLIENT_ERRORS from './clienterrors.js';

const { initSchema, saves, sessions, actions: actionLog, deedsRepo, crews } = DB;

/* ---------------------------------------------------------------- paths ---- */
const HERE = path.dirname(fileURLToPath(import.meta.url));   // <root>/server/src
const SERVER_ROOT = path.resolve(HERE, '..');                // <root>/server
// GAME_DIR is resolved relative to the server package root, so the default
// '../' lands on the project root that holds index.html + game.js + lib/.
const GAME_DIR = path.resolve(SERVER_ROOT, process.env.GAME_DIR || '../');

const PORT = Number(process.env.PORT) || 8787;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ============================================================================
   PROCESS GUARDS — installed before anything else can throw.
   unhandledRejection is logged and survived; uncaughtException runs the onFatal
   hooks at the bottom of this file and then exits, so systemd can put a healthy
   process in our place. middleware.js explains the asymmetry.
   ========================================================================== */
installProcessGuards();

/* ============================================================================
   CONFIGURATION — validated BEFORE the database is opened or a port is bound.
   ----------------------------------------------------------------------------
   A production process that starts with the example secret is worse than one
   that refuses to start: the first is silently forgeable and nobody notices for
   months, the second is a thirty-second fix at deploy time.
   ========================================================================== */

// CORS_ORIGIN may be '*' (default) or a comma separated allow-list.
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
const ORIGIN_LIST = CORS_ORIGIN === '*'
  ? null
  : CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

/* The value .env.example ships with, plus the shapes people type when they mean
   "I will fix this before launch". Matching runs on a normalised copy — lower
   case, punctuation stripped — so change-me-to-32-random-bytes, CHANGE_ME and
   "Change Me" are one and the same string here. Getting this list wrong in the
   lenient direction is the whole failure mode: a guard that does not recognise
   the placebo it was written for is not a guard. */
const LEDGER_PLACEHOLDERS = new Set([
  'changemeto32randombytes',
  'changeme',
  'change',
  'secret',
  'ledgersecret',
  'placeholder',
  'example',
  'testsecret',
  'pleasechange',
  'xxx'
]);

const LEDGER_MIN_LEN = 32;   // 32 hex chars = 16 bytes of entropy

/** True when this is the example value rather than a real secret. */
function isPlaceholderSecret(value) {
  const flat = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return true;
  if (LEDGER_PLACEHOLDERS.has(flat)) return true;
  // `change-me-<anything>` and `<anything>_CHANGEME` both mean the same thing.
  return flat.includes('changeme') || flat.includes('pleasechange');
}

let LEDGER_SECRET = (process.env.LEDGER_SECRET || '').trim();

if (IS_PROD) {
  if (isPlaceholderSecret(LEDGER_SECRET)) {
    log.error('refusing to start · LEDGER_SECRET is unset or still the example value', {
      env: 'LEDGER_SECRET',
      present: LEDGER_SECRET.length > 0,
      hint: 'openssl rand -hex 32'
    });
    process.exit(1);
  }
  if (LEDGER_SECRET.length < LEDGER_MIN_LEN) {
    // Short but genuinely random: not worth refusing a deploy over, loud enough
    // that the next deploy fixes it.
    log.warn('LEDGER_SECRET is shorter than recommended', {
      length: LEDGER_SECRET.length, recommended: LEDGER_MIN_LEN
    });
  }
  if (!process.env.ADMIN_TOKEN) {
    log.warn('ADMIN_TOKEN is not set · every /api/admin path will answer 404');
  }
  if (!ORIGIN_LIST) {
    log.warn('CORS_ORIGIN is "*" · fine while the game is served from this same ' +
             'origin, but credentialed CORS can never be enabled alongside a wildcard');
  }
} else if (!LEDGER_SECRET) {
  LEDGER_SECRET = crypto.randomBytes(32).toString('hex');
  log.warn('LEDGER_SECRET missing · using an ephemeral dev secret ' +
           '(signatures will not survive a restart)');
}

/* --------------------------------------------------------------- boot ----- */
initSchema();

// Read once. The schema version cannot change while the process runs, and
// /api/health has to stay cheap enough for an uptime probe every few seconds.
let SCHEMA_VERSION = 0;
try {
  SCHEMA_VERSION = DB.stats().schemaVersion | 0;
} catch (e) {
  log.error('could not read the schema version at boot', { err: e });
}

/* ----------------------------------------------------------------------------
   BUILD_ID — which copy of the CLIENT this box is serving.

   A tab left open across a deploy keeps running the JavaScript it loaded hours
   ago. Today it finds out the hard way: a move comes back UNKNOWN_ACTION and
   09-social tells the player a reload is the fix, one lost spin too late. The
   client cannot answer "am I stale?" on its own — it has no idea what is
   current — but the box serving the files does.

   So: hash what we serve, once, at boot, and report it from /api/health. A
   client that saw one value and later sees another knows to reload BEFORE it
   loses a move. Content, not mtime — a redeploy that rewrites identical files
   must not read as a new build and nag everyone for nothing.

   Null when this box is API-only (nginx serving the static files itself, or a
   test with an empty GAME_DIR); the field is then absent and the client simply
   never runs the check.
   -------------------------------------------------------------------------- */
const BUILD_FILES = [
  'index.html', 'game.js', 'net.js', 'sw.js',
  ...Array.from({ length: 15 }, (_, i) => `mods/${String(i).padStart(2, '0')}-`),
];

function computeBuildId() {
  try {
    const h = crypto.createHash('sha256');
    let seen = 0;
    for (const entry of BUILD_FILES) {
      /* The mod slots are listed by prefix: their short names are theirs to
         change, and a rename is a new build either way. */
      if (entry.endsWith('-')) {
        const dir = path.join(GAME_DIR, 'mods');
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => n.startsWith(path.basename(entry))).sort(); }
        catch { continue; }
        for (const n of names) { h.update(n); h.update(fs.readFileSync(path.join(dir, n))); seen++; }
        continue;
      }
      try { h.update(entry); h.update(fs.readFileSync(path.join(GAME_DIR, entry))); seen++; }
      catch { /* not served from here; a missing file is not an error */ }
    }
    if (!seen) return null;                 // API-only box: nothing to stamp
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    log.warn('could not stamp the client build', { err: e });
    return null;
  }
}
const BUILD_ID = computeBuildId();

/* One line an operator can paste into a bug report. Never a secret value —
   only whether one is configured. The admin field is deliberately NOT called
   `adminToken`: log.js redacts any field whose name says "token", and
   "[redacted]" would answer a question nobody asked. */
log.info('configuration', {
  env: process.env.NODE_ENV || 'development',
  port: PORT,
  gameDir: GAME_DIR,
  dbPath: process.env.DB_PATH || '(default: server/data/reelfortune.db)',
  corsOrigin: CORS_ORIGIN,
  schemaVersion: SCHEMA_VERSION,
  logLevel,
  ledgerSigning: LEDGER_SECRET ? 'configured' : 'disabled',
  adminConsole: process.env.ADMIN_TOKEN ? 'enabled' : 'disabled',
  node: process.version,
  pid: process.pid
});

const CREW_REQUEST_TTL = 24 * 60 * 60 * 1000;   // unanswered boarding knocks expire after a day

/* ============================================================================
   SCHEDULED MAINTENANCE
   ----------------------------------------------------------------------------
   Every timer here is unref()'d so none of them can hold a shutting-down
   process open, and every one is in `TIMERS` so shutdown() can stop them before
   the database handle goes away — a checkpoint firing into a closing handle is
   a stack trace in the log at the exact moment nobody is reading it.
   ========================================================================== */
const SWEEP_EVERY = 10 * 60 * 1000;         // expired sessions + stale crew knocks
const CHECKPOINT_EVERY = 5 * 60 * 1000;     // fold the WAL back into the main file
const VACUUM_EVERY = 6 * 60 * 60 * 1000;    // hand free pages back to the filesystem
const DERBY_EVERY = 30 * 1000;              // settle closed derbies

const TIMERS = [];
function every(ms, fn) {
  const timer = setInterval(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  TIMERS.push(timer);
  return timer;
}

every(SWEEP_EVERY, () => {
  try { sessions.sweep(); } catch (e) { log.error('session sweep failed', { err: e }); }
  try { crews.sweep(CREW_REQUEST_TTL); } catch (e) { log.error('crew sweep failed', { err: e }); }
});

/* SQLite is happy to run untouched for months, right up until the WAL is a
   gigabyte: under continuous read traffic the natural checkpoint may never get
   a quiet moment. Checkpoint often, vacuum rarely — db.js makes both of these
   a cheap no-op when there is nothing to do. */
every(CHECKPOINT_EVERY, () => {
  try {
    const r = DB.checkpoint();
    if (r && r.busy) log.debug('wal checkpoint busy', r);
  } catch (e) { log.error('wal checkpoint failed', { err: e }); }
});

every(VACUUM_EVERY, () => {
  try {
    const r = DB.vacuumIfNeeded();
    if (r && r.reclaimed > 0) log.info('database vacuumed', r);
  } catch (e) { log.error('vacuum failed', { err: e }); }
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);           // nginx sits in front of us

/* ============================================================================
   MIDDLEWARE — the order below is the contract middleware.js documents.
   An id first, so every line written from here down can be tied to one request;
   headers before any handler can answer, so even a 404 or a static asset gets
   the policy; the access log after the body parser so it can name the user.
   ========================================================================== */
app.use(requestId);
app.use(securityHeaders);

app.use(cors({
  origin: ORIGIN_LIST ? ORIGIN_LIST : '*',
  // Wildcard origins may not be combined with credentials, so cookies-based
  // sessions only work once CORS_ORIGIN names real origins.
  credentials: !!ORIGIN_LIST,
  methods: ['GET', 'POST', 'OPTIONS'],
  // auth.js reads the session token from `Authorization: Bearer …` or `X-Auth-Token`.
  // X-Admin-Token is listed so the moderation console can be driven from a
  // browser page on an allowed origin; curl needs no CORS at all.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token', 'X-Admin-Token'],
  maxAge: 600
}));

app.use(express.json({ limit: '64kb' }));

// One line per completed response. LOG_ACCESS_QUIET=/api/health,/lib drops
// uptime probes and asset fetches to debug level on a busy box.
app.use(accessLog);

/* ------------------------------------------------------------- helpers ---- */
const nowMs = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ----------------------------------------------------------------------------
   Every error answer carries BOTH a human sentence and a stable machine code.
   The browser shows the sentence; the notification centre keys its explanation,
   its retry policy and its "sign in again" prompt off the code, because English
   copy is allowed to change and a client must never have to match on it.
   -------------------------------------------------------------------------- */
function httpErr(res, status, code, error, extra) {
  const body = { error, code };
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}

/* ============================================================================
   SAVE LOADING
   ----------------------------------------------------------------------------
   Two situations look identical through db.js's saves.get(), which answers null
   for both, and they must never be handled alike:

     no row yet          -> mint a newState() and persist it (a first login)
     row present, broken -> DO NOT WRITE. A newState() here silently replaces a
                            player's entire history with an empty save, and the
                            old bytes are gone for good.

   So the row is read straight from the table: its bare presence is exactly the
   signal saves.get() throws away. Rows that do parse go through normalizeState()
   rather than being trusted or discarded, so a legacy or half-malformed save is
   repaired in place. Anything unreadable raises SaveUnreadable, every route
   answers 503, and the stored bytes stay on disk for a human to rescue.
   ========================================================================== */

/** A save row exists but could not be turned into a state. Never overwrite it. */
class SaveUnreadable extends Error {
  constructor(userId) {
    super(`save for user ${userId} could not be read`);
    this.name = 'SaveUnreadable';
    this.userId = userId;
  }
}

// undefined = not resolved yet, null = unavailable, else (userId) => row|undefined
let readSaveRow;

/**
 * Resolve a direct reader for the saves row. The raw better-sqlite3 handle is
 * discovered the same way the leaderboard does it, so db.js stays untouched.
 */
function resolveSaveRowReader() {
  if (readSaveRow !== undefined) return readSaveRow;
  readSaveRow = null;

  const raw = DB.db || DB.database || (DB.default && DB.default.db);
  if (!raw || typeof raw.prepare !== 'function') {
    log.error('no raw db handle · cannot tell a missing save from a corrupt one');
    return readSaveRow;
  }

  try {
    const stmt = raw.prepare('SELECT state FROM saves WHERE user_id = ?');
    stmt.get(0);                       // smoke test: fail here, not per-request
    readSaveRow = (userId) => stmt.get(userId);
  } catch (e) {
    log.error('save row reader unavailable', { err: e });
    readSaveRow = null;
  }
  return readSaveRow;
}

// Resolve at boot so a broken build shouts into the log immediately instead of
// on some unlucky player's first request.
resolveSaveRowReader();

/**
 * Load a user's save. A fresh state is minted ONLY when the player genuinely
 * has no row yet; every existing row is normalised, never replaced.
 *
 * @throws {SaveUnreadable} when a row exists but cannot be parsed — the caller
 *         must answer 503 and leave the stored save alone.
 */
function loadState(userId) {
  const readRow = resolveSaveRowReader();

  if (!readRow) {
    // Without the row probe there is no way to tell "new player" from "corrupt
    // save", and guessing wrong destroys progress. Refuse instead: a loud
    // outage is recoverable, a wiped save is not.
    const state = (() => {
      try { return saves.get(userId); }
      catch (e) { log.error('save read failed', { userId, err: e }); return null; }
    })();
    if (state && typeof state === 'object' && !Array.isArray(state)) return normalizeState(state);
    throw new SaveUnreadable(userId);
  }

  let row;
  try {
    row = readRow(userId);
  } catch (e) {
    // A failed read is not proof the save is gone. Refuse rather than reset.
    log.error('save row read failed', { userId, err: e });
    throw new SaveUnreadable(userId);
  }

  if (!row) {
    // No row at all: this really is a first login.
    const fresh = newState();
    saves.put(userId, fresh);
    return fresh;
  }

  let parsed;
  try {
    parsed = JSON.parse(row.state);
  } catch (e) {
    log.error('unparseable save left untouched', { userId, err: e });
    throw new SaveUnreadable(userId);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error('save row is not a state object · left untouched', { userId });
    throw new SaveUnreadable(userId);
  }

  return normalizeState(parsed);
}

/** 503 for a save we refused to read. Nothing has been written. */
function refuseUnreadable(res) {
  res.set('Retry-After', '30');
  return httpErr(res, 503, 'SAVE_UNREADABLE',
    'your save could not be read · it has been left untouched, please try again shortly');
}

/**
 * Request-scoped loadState: answers 503 and returns null when the save is
 * unreadable, so handlers can bail with `if (!state) return;`.
 */
/* express 4 ignores a rejected promise from a handler: an async route that
   throws would hang the request instead of reaching errorHandler. Same wrapper
   auth.js and wallet.js use, for the same reason. */
const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function loadStateFor(req, res) {
  try {
    return loadState(req.userId);
  } catch (e) {
    if (e instanceof SaveUnreadable) { refuseUnreadable(res); return null; }
    throw e;
  }
}

/**
 * Canonical deed hash. game.js renders a cosmetic 0x… string client-side; the
 * ledger table needs a stable one that survives a re-render, so we derive it
 * deterministically from the deed id and its mint block.
 */
function deedHash(deedId, blockNo) {
  const h = crypto.createHash('sha256').update(`${deedId}|${blockNo}`).digest('hex');
  return '0x' + h.slice(0, 20);
}

/**
 * Mirror state.deeds (minted by progress.js) into the ledger table so
 * /api/ledger and /api/ledger/claim have rows to work with. Cheap: only writes
 * deeds the table has not seen yet.
 */
function syncDeeds(userId, state) {
  const deeds = state && state.deeds;
  if (!deeds || typeof deeds !== 'object') return;
  for (const deedId of Object.keys(deeds)) {
    const blockNo = Number(deeds[deedId]) || 0;
    if (!blockNo) continue;
    try {
      if (deedsRepo.has(userId, deedId)) continue;
      deedsRepo.add(userId, deedId, blockNo, deedHash(deedId, blockNo));
    } catch (e) {
      log.error('deed sync failed', { userId, deedId, err: e });
    }
  }
}

/* ----------------------------------------------------------------------------
   Fields the server tracks nowhere and must therefore never echo back.

   Empty, and that is the point. `ach` and `deeds` used to be listed here,
   back when game.js was the only thing that evaluated them and the server held
   a permanently empty {} that SRV.apply() would have copied straight over the
   player's real trophy case. progress.js now owns both tables: they are paid
   and stamped on the server after every action, mirrored into the ledger by
   syncDeeds(), and so they belong in the reply.

   Withholding them was quietly lossy. The `earned` field next to the state is
   a one-shot delta — it names what was won by THAT request — so a player who
   signed in on a second device, or cleared local storage, had nothing to
   rebuild from and saw an empty trophy case forever.

   Both fields are additive for a client that does not read them: game.js copies
   unknown keys onto its state and renders from its own copy, so an old build
   sees its own values replaced by the server's authoritative ones and a build
   that never looks at them is unaffected.
   -------------------------------------------------------------------------- */
const CLIENT_OWNED_FIELDS = [];

/** The state as the client may see it: everything the server actually owns. */
function clientState(state) {
  if (!state || typeof state !== 'object') return state;
  const out = { ...state };
  for (const k of CLIENT_OWNED_FIELDS) delete out[k];
  return out;
}

/** Standard success envelope for anything that hands back a full state. */
function stateEnvelope(state, extra) {
  return Object.assign({
    state: clientState(state),
    epoch: mktEpochNow(),
    serverTime: nowMs()
  }, extra || {});
}

/* ============================================================================
   SANCTION ENFORCEMENT
   ----------------------------------------------------------------------------
   admin.js owns the sanctions table and exports the predicate; the doors are
   here. A ban already deletes every session row, so the usual outcome is a 401
   on the very next request. This gate closes the remaining window — a token
   minted microseconds before the ban landed — and it is what a player who is
   mid-session actually sees, with the reason and the end date attached rather
   than a bare "unauthorized".

   Reads and cosmetics stay open on purpose: a suspended player should still be
   able to load the isle, see their crew and read WHY they cannot act. Every
   door that MOVES something is closed: actions, saves, the ledger claim, every
   crew mutation, and filing a report (a banned account reporting the people who
   reported it is a retaliation channel, not a moderation one).

   isBanned() is fail-open by design (see admin.js): a broken sanctions table
   must never lock the whole playerbase out of their own accounts. The try/catch
   below says the same thing a second time, because a throw inside a gate is
   precisely how an authoritative server locks itself out of production.

   The socket is covered too, in realtime.js: the handshake refuses a banned
   account, the heartbeat cuts one banned mid-session within PING_MS, kick()
   drops it the instant /api/admin/ban lands, and isMuted() gags chat. The
   front doors are in auth.js and wallet.js, after the credential check so
   neither becomes an oracle for who is suspended.
   ========================================================================== */
function requireNotBanned(req, res, next) {
  let ban = null;
  try {
    ban = isBanned(req.userId);
  } catch (e) {
    log.error('ban lookup failed · allowing the request', { userId: req.userId, err: e });
    return next();
  }
  if (!ban || !ban.banned) return next();

  const until = Number(ban.until) || 0;
  return httpErr(res, 403, 'ACCOUNT_SUSPENDED', 'this account is suspended', {
    reason: ban.reason || 'moderation action',
    until,
    // The wall-clock form too: the client shows this to a human, and epoch
    // milliseconds mean nothing to one.
    untilIso: until > 0 ? new Date(until).toISOString() : null
  });
}

/* ============================================================================
   AUTH  — POST /api/auth/{register,login,logout}, GET /api/auth/me
   ========================================================================== */
mountAuth(app);
mountWalletAuth(app);
mountNft(app);

/* ============================================================================
   GET /api/state — the client's only way to learn what it owns.
   ========================================================================== */
app.get('/api/state', requireAuth, (req, res) => {
  const state = loadStateFor(req, res);
  if (!state) return;

  // Dividends accrue on market epochs, not on player actions, so they are
  // settled whenever the player checks in. payDividends() is epoch-guarded and
  // therefore safe to call on every request.
  let dividends = 0;
  try { dividends = payDividends(state) || 0; }
  catch (e) { log.error('dividend settlement failed', { userId: req.userId, err: e }); }

  if (dividends > 0) saves.put(req.userId, state);
  syncDeeds(req.userId, state);

  res.json(stateEnvelope(state, dividends > 0 ? { dividends } : null));
});

/* ============================================================================
   POST /api/action/:name — the one door every economic change walks through.
   Body is an intent ("I finished reeling"), never a result.
   ========================================================================== */
const ANTI_MACRO_WINDOW = 60 * 1000;   // look back one minute…
const ANTI_MACRO_MAX = 60;             // …and allow at most this many of one action

/* The handful of refusals a correct client can still collect through no fault
   of its own: two players racing for the same node, and the auto-rig's own
   cadence floor. actions.js owns the wording (mine/chop/catch); it is matched
   here rather than exported because a refusal carries nothing but its message. */
const CONTENDED_REFUSAL = /vein is already stripped|already felled that tree|resetting the line/i;

app.post('/api/action/:name', requireAuth, requireNotBanned, (req, res) => {
  const name = String(req.params.name || '');

  // hasOwnProperty guard: '/api/action/constructor' must not resolve.
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name) || typeof HANDLERS[name] !== 'function') {
    return httpErr(res, 404, 'UNKNOWN_ACTION', 'unknown action');
  }

  const userId = req.userId;
  const t = nowMs();

  /* Stamping the log is what the cooldown and the anti-macro window read back,
     so it has to happen on EVERY attempt that got past those gates, not only on
     the ones that succeeded. Marking only the success path made a rejected body
     free: a client could hammer this route with an intent the handler refuses
     and still pay for a full state load and dividend pass each time, at
     whatever rate it liked, because nothing it did ever moved `last`.

     But not every refusal is the caller's doing. A stripped vein, a felled tree
     and a rig still resetting the line are decided by the world and by the
     server clock, not by the body that was sent: charging them the per-action
     cooldown lets whoever reached the node first spend YOUR next 500ms, and lets
     a hair of auto-rig drift eat a manual 2500ms cast. Those go to a second lane
     that the anti-macro window still sums — so hammering a stripped vein stays
     bounded exactly as before — while `last`, and with it the cooldown, only
     moves for an attempt the caller could have avoided making. */
  const contendedLane = name + ':contended';
  const markAttempt = (refusal) => {
    const lane = (refusal && CONTENDED_REFUSAL.test(refusal)) ? contendedLane : name;
    try { actionLog.mark(userId, lane); }
    catch (e) { log.error('action log write failed', { userId, action: lane, err: e }); }
  };

  // --- cooldown: one action may not fire faster than its RATE ---------------
  const minGap = RATE[name] || 0;
  if (minGap > 0) {
    let last = 0;
    try { last = actionLog.last(userId, name) || 0; }
    catch (e) { log.error('action cooldown lookup failed', { userId, action: name, err: e }); }
    const elapsed = t - last;
    if (last > 0 && elapsed < minGap) {
      res.set('Retry-After', String(Math.ceil((minGap - elapsed) / 1000)));
      return httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: minGap - elapsed });
    }
  }

  // --- anti-macro: a human cannot sustain 60 of the same action per minute --
  try {
    const since = t - ANTI_MACRO_WINDOW;
    const tries = actionLog.countSince(userId, name, since)
                + actionLog.countSince(userId, contendedLane, since);
    if (tries > ANTI_MACRO_MAX) {
      res.set('Retry-After', '60');
      return httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: ANTI_MACRO_WINDOW });
    }
  } catch (e) { log.error('anti-macro lookup failed', { userId, action: name, err: e }); }

  const state = loadStateFor(req, res);
  if (!state) return;

  // Settle any owed dividends first so the handler sees the true balance.
  let dividends = 0;
  try { dividends = payDividends(state) || 0; }
  catch (e) { log.error('dividend settlement failed', { userId, err: e }); }

  let out;
  try {
    out = HANDLERS[name](state, req.body && typeof req.body === 'object' ? req.body : {});
  } catch (e) {
    log.error('action handler threw', { userId, action: name, err: e });
    markAttempt();
    return httpErr(res, 500, 'ACTION_FAILED', 'action failed');
  }

  if (!out || out.ok !== true) {
    const msg = (out && out.error) ? String(out.error) : 'invalid action';
    // A rejected action still persists any dividends we just credited.
    if (dividends > 0) saves.put(userId, state);
    markAttempt(msg);
    return httpErr(res, 400, 'ACTION_REJECTED', msg);
  }

  /* Resolved once per request and used by both the event broadcasts and the
     deed announcement below. It has to live out here: scoping it inside the
     catch/spin branch left the announcement referencing a name that was not in
     scope, and the only reason nobody saw a ReferenceError is that it happened
     inside a best-effort try. */
  let username = '';
  try {
    const u = DB.users.findById(userId);
    username = u && u.username ? String(u.username) : '';
  } catch (e) { log.error('user lookup failed', { userId, err: e }); }

  // --- multiplayer events: derby scoring, wanted bounty, spin drama ---------
  // Runs BEFORE the save below so a bounty credited here persists. Defensive:
  // an events/realtime hiccup must never turn a valid action into a 500.
  if (name === 'catch' || name === 'spin') {
    if (!out.result || typeof out.result !== 'object') out.result = {};
    const result = out.result;

    /* The derby and the wanted-fish bounty are contests between people who are
       actually at the rod. An unattended auto-rig catch scores neither — it
       still banks the fish, it just does not compete. */
    if (name === 'catch' && result.fish && !result.auto) {
      try {
        EV.recordCatch(state.world, userId, username, result.fish.kg || 0);
        /* A fish hooked under one poster can land a moment after the 3-minute
           rotation. Try the live epoch, then the one just gone — claims are
           deduped per world+epoch, so the second try can never double-pay. */
        const epNow = mktEpochNow();
        const bounty = EV.tryClaimWanted(state.world, epNow, userId, result.fish.name)
          || EV.tryClaimWanted(state.world, epNow - 1, userId, result.fish.name);
        if (bounty > 0) {
          state.coins += bounty;
          state.stats.earned += bounty;
          result.wanted = bounty;
          broadcast(state.world, {
            t: 'drama', kind: 'wanted', name: username,
            fish: result.fish.name, bounty
          });
        }
      } catch (e) { log.error('catch event failed', { userId, err: e }); }
    }

    if (name === 'spin') {
      try {
        broadcast(state.world, {
          t: 'drama', kind: 'spin', name: username,
          won: !!result.won, color: result.color, payout: result.payout || 0,
          fish: (result.fish && result.fish.name) || null,
          lost: result.lost || null
        });
      } catch (e) { log.error('spin event failed', { userId, err: e }); }
    }
  }

  /* Achievements and deeds are decided HERE, not by the client: a bounty is paid
     once, by the side that owns the coin balance. Loud deeds tell the room. */
  let earned = null;
  try {
    earned = PROGRESS.evaluate(state, mktEpochNow());
    if (earned.ach.length || earned.deeds.length) {
      log.info('progress earned', {
        userId,
        ach: earned.ach.map(a => a.id),
        deeds: earned.deeds.map(d => d.id),
        coins: earned.coins
      });
      for (const d of earned.deeds) {
        if (!d.loud) continue;
        try { announceAll({ t: 'drama', kind: 'deed', name: username, deed: d.name }); }
        catch (e) { log.error('deed announcement failed', { userId, deed: d.id, err: e }); }
      }
    }
  } catch (e) { log.error('progress evaluate failed', { userId, err: e }); }

  saves.put(userId, state);
  markAttempt();
  syncDeeds(userId, state);

  res.json(stateEnvelope(state, {
    ok: true,
    result: out.result || {},
    ...(earned && (earned.ach.length || earned.deeds.length) ? { earned } : null),
    ...(dividends > 0 ? { dividends } : null)
  }));
});

/* ============================================================================
   POST /api/save — cosmetics and preferences ONLY.
   The client used to own the whole save blob; now it may only nudge fields
   that cannot move a single coin. Everything else in the body is dropped on
   the floor without comment.
   ========================================================================== */
const WARDROBE_SLOTS = ['band', 'scarf', 'vest'];
const WARDROBE_MAX_COLOR = 31;   // generous bound; palette is far smaller
const TITLE_MAX_LEN = 32;

app.post('/api/save', requireAuth, requireNotBanned, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const state = loadStateFor(req, res);
  if (!state) return;
  let touched = false;

  // --- wardrobe colours: only after the 80-pearl wardrobe was bought here ---
  if (body.wardrobe && typeof body.wardrobe === 'object' && !Array.isArray(body.wardrobe)
      && state.ownedW && state.ownedW.wardrobe) {
    if (!state.wardrobe || typeof state.wardrobe !== 'object') state.wardrobe = {};
    for (const slot of WARDROBE_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(body.wardrobe, slot)) continue;
      const v = Number(body.wardrobe[slot]);
      if (!Number.isFinite(v)) continue;
      const idx = Math.min(WARDROBE_MAX_COLOR, Math.max(0, Math.trunc(v)));
      if (state.wardrobe[slot] !== idx) { state.wardrobe[slot] = idx; touched = true; }
    }
  }

  // --- equipped title: '' unequips. Titles are unlocked through the kiosk
  //     handler, so a player who owns none may never display one. The exact
  //     id->label table lives in the kiosk handler, hence the length/charset
  //     sanitising here rather than a strict membership test.
  if (typeof body.titleId === 'string') {
    const ownsAny = state.ownedT && Object.keys(state.ownedT).length > 0;
    const clean = body.titleId.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, TITLE_MAX_LEN);
    const next = ownsAny ? clean : '';
    if (state.titleId !== next) { state.titleId = next; touched = true; }
  }

  /* --- ach / deeds: NOT accepted. body.ach and body.deeds are read and dropped.
     Restricting the merge to ids progress.js defines closed the smaller hole and
     left the larger one open: membership says an id is real, never that it was
     earned. The predicates in progress.js are the only thing that knows, and
     they run in PROGRESS.evaluate() on the action route, so a merge here stamped
     genuine deeds onto accounts that had done nothing — syncDeeds() mirrored them
     into the ledger table and /api/ledger/claim HMAC-signed them for real.
     Worse for honest players: evaluate() skips any id already stamped, so a
     pre-stamped ach map burned every bounty behind it — the full table is 16,575
     coins, destroyed on the first save after sign-in by a client that had played
     offline. Nothing the client posts can prove either kind of progress anyway:
     no route lets a body write stats, dex, worlds or tool levels, so the server's
     own state is the only evidence there is. evaluate() re-derives both tables
     from it after every action and pays what is owed, which is exactly the
     migration a legacy save needs. */

  // --- tipEpoch: the kiosk sells a peek at the NEXT epoch's market mods for
  //     30 pearls, so accepting an arbitrary value would hand out the tip for
  //     free. The client may only clear or lower a tip it already paid for.
  if (body.tipEpoch != null) {
    const v = Number(body.tipEpoch);
    const cur = Number(state.tipEpoch) || 0;
    if (Number.isFinite(v) && v >= 0 && v <= cur) {
      const next = Math.trunc(v);
      if (cur !== next) { state.tipEpoch = next; touched = true; }
    }
  }

  if (touched) saves.put(req.userId, state);
  res.json(stateEnvelope(state, { ok: true, saved: touched }));
});

/* ============================================================================
   POST /api/nft/equip — wear one of your Anglers, or { tokenId: 0 } to go back
   to the default hero.
   ----------------------------------------------------------------------------
   Separate from /api/save because it is the one cosmetic the client cannot be
   trusted about at all: the others are bounded numbers, this one is a claim of
   ownership. So the token id in the body is never believed — it is checked
   against the chain, for the address SIWE proved for THIS account, before it is
   written. A guest or password account has no address and so can only ever be
   the default hero, which is exactly the rule we want.
   ========================================================================== */
app.post('/api/nft/equip', requireAuth, requireNotBanned, wrapAsync(async (req, res) => {
  /* Typed before it is converted. Number(null) is 0 and 0 is the "take it off"
     path, so a coercing read would turn a malformed body into a silent unequip
     — the player presses wear, something is wrong with the request, and the
     server cheerfully undresses them and reports success. */
  const raw = req.body ? req.body.tokenId : undefined;
  const tokenId = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    return res.status(400).json({ error: 'bad token id', code: 'BAD_TOKEN' });
  }

  const state = loadStateFor(req, res);
  if (!state) return;

  // 0 is "take it off" and needs no chain call: undressing is always allowed,
  // including for a player whose wallet has since been emptied.
  if (tokenId === 0) {
    if (state.charTokenId !== 0) {
      state.charTokenId = 0;
      saves.put(req.userId, state);
      try { announceChar(req.userId); } catch (e) { log.warn({ msg: 'skin announce failed', err: String(e) }); }
    }
    return res.json(stateEnvelope(state, { ok: true, charTokenId: 0 }));
  }

  const row = DB.users.findById(req.userId);
  const addr = row && row.wallet ? String(row.wallet).toLowerCase() : '';
  if (!addr) {
    return res.status(403).json({
      error: 'connect a wallet to wear an Angler',
      code: 'NO_WALLET',
    });
  }

  if (!(await ownsToken(addr, tokenId))) {
    /* Covers three cases with one answer on purpose — not yours, does not
       exist, and chain unreachable all mean "not right now", and telling them
       apart would let anyone probe the collection through this route. */
    return res.status(403).json({
      error: 'that Angler is not in this wallet',
      code: 'NOT_OWNED',
    });
  }

  if (state.charTokenId !== tokenId) {
    state.charTokenId = tokenId;
    saves.put(req.userId, state);
    // Saved first, then announced: announceChar re-reads the save, so the write
    // has to have landed or the isle would be told the old token.
    try { announceChar(req.userId); } catch (e) { log.warn({ msg: 'skin announce failed', err: String(e) }); }
  }
  res.json(stateEnvelope(state, { ok: true, charTokenId: tokenId }));
}));

/* ============================================================================
   GET /api/leaderboard — public, cached 30s.
   ----------------------------------------------------------------------------
   The db.js contract only guarantees saves.get/put, so there is no listing
   primitive to call. We use whichever of these db.js actually offers, in order:
     1. saves.leaderboard(limit) / saves.top(limit)  — if it grows one
     2. the raw better-sqlite3 handle, if db.js exports it, queried with json1
   Table and column names are discovered from sqlite_master once and cached, so
   this keeps working whatever db.js chose to call things.
   ========================================================================== */
const LEADERBOARD_LIMIT = 20;
const LEADERBOARD_TTL = 30 * 1000;
let lbCache = { at: 0, entries: null };
let lbQuery;   // undefined = not probed yet, null = unavailable, else () => rows

const qid = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const pick = (cols, ...patterns) => {
  for (const p of patterns) { const hit = cols.find(c => p.test(c)); if (hit) return hit; }
  return null;
};

function resolveLeaderboardQuery() {
  if (lbQuery !== undefined) return lbQuery;
  lbQuery = null;

  if (typeof saves.leaderboard === 'function') {
    lbQuery = (n) => saves.leaderboard(n);
    return lbQuery;
  }
  if (typeof saves.top === 'function') {
    lbQuery = (n) => saves.top(n);
    return lbQuery;
  }

  const db = DB.db || DB.database || (DB.default && DB.default.db);
  if (!db || typeof db.prepare !== 'function') return lbQuery;

  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const saveTable = pick(tables, /^saves?$/i, /save/i);
    const userTable = pick(tables, /^users?$/i, /user/i);
    if (!saveTable || !userTable) return lbQuery;

    const saveCols = db.prepare(`PRAGMA table_info(${qid(saveTable)})`).all().map(c => c.name);
    const userCols = db.prepare(`PRAGMA table_info(${qid(userTable)})`).all().map(c => c.name);

    const stateCol = pick(saveCols, /^(state|data|json|save|blob|payload)$/i);
    const saveUserCol = pick(saveCols, /^(user_?id|uid|owner|player_?id)$/i);
    const userIdCol = pick(userCols, /^(id|user_?id)$/i);
    const nameCol = pick(userCols, /^(username|name|handle|login)$/i);
    if (!stateCol || !saveUserCol || !userIdCol || !nameCol) return lbQuery;

    const sql =
      `SELECT u.${qid(nameCol)} AS username,` +
      ` CAST(COALESCE(json_extract(s.${qid(stateCol)}, '$.stats.earned'), 0) AS INTEGER) AS earned,` +
      ` CAST(COALESCE(json_extract(s.${qid(stateCol)}, '$.pearlsLife'), 0) AS INTEGER) AS pearls,` +
      ` COALESCE(json_extract(s.${qid(stateCol)}, '$.titleId'), '') AS title` +
      ` FROM ${qid(saveTable)} s JOIN ${qid(userTable)} u ON u.${qid(userIdCol)} = s.${qid(saveUserCol)}` +
      ` ORDER BY earned DESC LIMIT ?`;

    const stmt = db.prepare(sql);
    stmt.all(1);            // smoke test: fails loudly here rather than per-request
    lbQuery = (n) => stmt.all(n);
  } catch (e) {
    log.error('leaderboard disabled', { err: e });
    lbQuery = null;
  }
  return lbQuery;
}

app.get('/api/leaderboard', (req, res) => {
  const t = nowMs();
  if (lbCache.entries && t - lbCache.at < LEADERBOARD_TTL) {
    return res.json({ entries: lbCache.entries, cachedAt: lbCache.at, serverTime: t });
  }

  const run = resolveLeaderboardQuery();
  if (!run) {
    return res.json({ entries: [], unavailable: true, serverTime: t });
  }

  let rows = [];
  try {
    rows = run(LEADERBOARD_LIMIT) || [];
  } catch (e) {
    log.error('leaderboard query failed', { err: e });
    return httpErr(res, 500, 'LEADERBOARD_UNAVAILABLE', 'leaderboard unavailable');
  }

  const entries = rows
    .map(r => ({
      username: String(r.username || 'anonymous'),
      earned: Number(r.earned) || 0,
      pearls: Number(r.pearls) || 0,
      title: String(r.title || '')
    }))
    .filter(r => r.earned > 0)
    .slice(0, LEADERBOARD_LIMIT)
    .map((r, i) => ({ rank: i + 1, ...r }));

  lbCache = { at: t, entries };
  res.json({ entries, cachedAt: t, serverTime: t });
});

/* ============================================================================
   ISLE LEDGER
   ----------------------------------------------------------------------------
   Deeds are trophies minted by progress.js. /claim binds one to a wallet
   address so a future contract could recognise it.

   !! PLACEHOLDER SIGNATURE !!
   A real on-chain mint needs an ECDSA secp256k1 signature over an EIP-191
   personal_sign digest, produced with a minter private key (viem's
   `privateKeyToAccount().signMessage()` or ethers' `Wallet.signMessage()`), and
   the contract recovers the signer with ecrecover. We deliberately ship no
   crypto dependency, so what follows is an HMAC-SHA256 tag instead: it proves
   *this server* authorised the pairing and is unforgeable without
   LEDGER_SECRET, but no smart contract can verify it. Swapping in real signing
   means replacing signClaim() below and nothing else — the payload string is
   already the message that would be signed.

   LEDGER_SECRET itself is resolved and validated in the CONFIGURATION section
   at the top of this file: in production a missing or example value is a
   refusal to boot, not a runtime 503.
   ========================================================================== */
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DEED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLAIM_RATE = 3000;              // ms between claims, per user
const CLAIM_MAX_PER_MIN = 10;
const CLAIM_ACTION = 'ledger_claim';

/** The exact bytes a real signer would sign, EIP-191 framed. */
function claimPayload(address, deedId, userId, blockNo) {
  const body =
    `Reel Fortune 3D · Isle Ledger claim\n` +
    `deed: ${deedId}\n` +
    `block: ${blockNo}\n` +
    `player: ${userId}\n` +
    `address: ${address}`;
  return `\x19Ethereum Signed Message:\n${body.length}${body}`;
}

/** Placeholder for ECDSA signing — see the block comment above. */
function signClaim(address, deedId, userId) {
  return '0x' + crypto.createHmac('sha256', LEDGER_SECRET)
    .update(`${address}|${deedId}|${userId}`)
    .digest('hex');
}

app.get('/api/ledger', requireAuth, (req, res) => {
  const state = loadStateFor(req, res);
  if (!state) return;
  syncDeeds(req.userId, state);

  let rows = [];
  try { rows = deedsRepo.list(req.userId) || []; }
  catch (e) { log.error('deed listing failed', { userId: req.userId, err: e }); }

  res.json({ deeds: rows, epoch: mktEpochNow(), serverTime: nowMs() });
});

app.post('/api/ledger/claim', requireAuth, requireNotBanned, (req, res) => {
  if (!LEDGER_SECRET) {
    return httpErr(res, 503, 'LEDGER_DISABLED', 'ledger signing is not configured');
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const deedId = String(body.deedId || '');
  const rawAddr = String(body.address || '').trim();

  if (!DEED_ID_RE.test(deedId)) return httpErr(res, 400, 'BAD_DEED_ID', 'invalid deedId');
  if (!ADDR_RE.test(rawAddr)) return httpErr(res, 400, 'BAD_ADDRESS', 'invalid address');
  const address = rawAddr.toLowerCase();

  const userId = req.userId;
  const t = nowMs();

  // Same throttling shape as game actions.
  try {
    const last = actionLog.last(userId, CLAIM_ACTION) || 0;
    if (last > 0 && t - last < CLAIM_RATE) {
      res.set('Retry-After', '3');
      return httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: CLAIM_RATE - (t - last) });
    }
    if (actionLog.countSince(userId, CLAIM_ACTION, t - ANTI_MACRO_WINDOW) > CLAIM_MAX_PER_MIN) {
      res.set('Retry-After', '60');
      return httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: ANTI_MACRO_WINDOW });
    }
  } catch (e) { log.error('ledger rate lookup failed', { userId, err: e }); }

  // Make sure the deed exists for this player before signing anything.
  const state = loadStateFor(req, res);
  if (!state) return;
  syncDeeds(userId, state);

  let owned = false;
  try { owned = !!deedsRepo.has(userId, deedId); }
  catch (e) { log.error('deed ownership lookup failed', { userId, deedId, err: e }); }
  if (!owned) return httpErr(res, 400, 'DEED_NOT_MINTED', 'deed not minted for this player');

  const blockNo = Number(state.deeds && state.deeds[deedId]) || 0;
  const payload = claimPayload(address, deedId, userId, blockNo);
  const signature = signClaim(address, deedId, userId);

  try {
    deedsRepo.setClaim(userId, deedId, address, signature);
  } catch (e) {
    log.error('deed claim write failed', { userId, deedId, err: e });
    return httpErr(res, 500, 'CLAIM_FAILED', 'could not record claim');
  }
  try { actionLog.mark(userId, CLAIM_ACTION); }
  catch (e) { log.error('action log write failed', { userId, action: CLAIM_ACTION, err: e }); }

  res.json({
    payload,
    signature,
    deedId,
    address,
    blockNo,
    hash: deedHash(deedId, blockNo),
    // Loud enough that nobody wires this into a mint by accident.
    scheme: 'hmac-sha256-placeholder',
    onChainReady: false
  });
});

/* ============================================================================
   CREW — who may ride on whose boat.
   ----------------------------------------------------------------------------
   A hull seats a fixed number of people INCLUDING its captain, so the raft
   (1 seat) can never take anyone and a Gilded Galleon carries nine guests.
   Boarding is two-sided: the sailor knocks (POST /request), the captain decides
   (POST /admit | /deny). Nobody is ever seated by their own say-so.

   Invariants, all re-checked inside crews.admit()'s transaction:
     - a player is aboard at most one boat  (crew_members.member_id is the PK)
     - a captain with crew aboard cannot themselves board someone else
     - a manifest never exceeds seats-1
   ========================================================================== */
const CREW_LIST_LIMIT = 40;
const CREW_MAX_OUTGOING = 5;                    // knock on at most five hulls at once
const CREW_RATE = 1500;                         // ms between crew writes, per user
const CREW_ACTION = 'crew_write';

const boatOf = (lvl) => BOATS[Math.min(Math.max(lvl | 0, 0), MAX_BOAT)] || BOATS[0];

/** Public shape of a hull — never leaks costs or requirements the client has. */
const hullInfo = (lvl) => {
  const b = boatOf(lvl);
  return { lvl: Math.min(Math.max(lvl | 0, 0), MAX_BOAT), name: b.name, sub: b.sub, seats: b.seats };
};

/** One shared cooldown across every crew write; admitting is not a hot path. */
function crewRateLimited(userId, res) {
  let last = 0;
  try { last = actionLog.last(userId, CREW_ACTION) || 0; }
  catch (e) { log.error('crew rate lookup failed', { userId, err: e }); }
  const gap = nowMs() - last;
  if (last > 0 && gap < CREW_RATE) {
    res.set('Retry-After', '1');
    httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: CREW_RATE - gap });
    return true;
  }
  return false;
}
const markCrew = (userId) => {
  try { actionLog.mark(userId, CREW_ACTION); }
  catch (e) { log.error('action log write failed', { userId, action: CREW_ACTION, err: e }); }
};

/** Resolve a username from the body to a real account, or null. */
function lookupUser(body, field) {
  const raw = body && body[field];
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 32) return null;
  return DB.users.findByName(name);
}

/** The full crew picture for one player: their deck, their berth, their knocks. */
function crewView(userId, username) {
  const lvl = saves.boatLvl(userId);
  const berth = crews.berthOf(userId);
  const manifest = crews.manifest(userId);

  let berthOut = null;
  if (berth) {
    const capLvl = saves.boatLvl(berth.ownerId);
    berthOut = {
      captain: berth.captain,
      joinedAt: berth.joinedAt,
      boat: hullInfo(capLvl),
      // Shipmates, the captain included, so a guest can see who else is aboard.
      crew: crews.manifest(berth.ownerId).map(m => ({ username: m.username, joinedAt: m.joinedAt }))
    };
  }

  return {
    you: {
      username,
      boat: hullInfo(lvl),
      slots: crewSlots(lvl),          // berths this captain can hand out
      aboard: manifest.length,
      // A guest's own hull is moored: you cannot host while you are a passenger.
      hosting: !berth
    },
    manifest: manifest.map(m => ({ username: m.username, joinedAt: m.joinedAt })),
    requests: berth ? [] : crews.requestsFor(userId).map(r => ({
      username: r.username, at: r.at, boat: hullInfo(r.boatLvl)
    })),
    berth: berthOut,
    outgoing: crews.requestsBy(userId).map(r => ({ captain: r.captain, at: r.at })),
    serverTime: nowMs()
  };
}

/* ---- GET /api/crew — everything the Harbor panel needs in one round trip -- */
app.get('/api/crew', requireAuth, (req, res) => {
  if (!loadStateFor(req, res)) return;         // make sure a save (and boatLvl) exists
  const me = DB.users.findById(req.userId);
  res.json(crewView(req.userId, me ? me.username : ''));
});

/* ---- GET /api/crew/captains — hulls with a free berth, most recent first --
   The listing query is the most expensive read in the file: two json_extract
   calls and a correlated COUNT per row, over every save, run synchronously by
   better-sqlite3 on the only thread there is. One client polling it in a loop
   used to stall the 10Hz tick for everybody, so it gets two ceilings — a shared
   cache so the query runs at most once per CAPTAINS_TTL however many people
   ask, and a per-account budget so nobody can spin the rest of the handler
   (which is per-user and cannot be cached) at line rate. */
const CAPTAINS_TTL = 5 * 1000;
const CAPTAINS_MAX_PER_MIN = 30;
let captainsCache = { at: 0, rows: null };

const captainsLimit = ipRateLimit({
  max: CAPTAINS_MAX_PER_MIN, windowMs: 60 * 1000, message: 'too fast',
  // Per account, not per IP: a shared NAT must not throttle a whole household.
  key: (req) => 'u' + (req.userId != null ? req.userId
    : (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'))
});

app.get('/api/crew/captains', requireAuth, captainsLimit, (req, res) => {
  let rows = captainsCache.rows;
  if (!rows || nowMs() - captainsCache.at > CAPTAINS_TTL) {
    try { rows = saves.captains(CREW_LIST_LIMIT * 2, 1) || []; }
    catch (e) {
      log.error('captain listing failed', { userId: req.userId, err: e });
      return httpErr(res, 500, 'UNAVAILABLE', 'unavailable');
    }
    captainsCache = { at: nowMs(), rows };
  }

  const mine = new Set(crews.requestsBy(req.userId).map(r => r.ownerId));
  const berth = crews.berthOf(req.userId);

  const captains = rows
    .filter(r => r.userId !== req.userId)
    .map(r => {
      const hull = hullInfo(r.boatLvl);
      const slots = crewSlots(r.boatLvl);
      return {
        username: r.username,
        boat: hull,
        slots,
        aboard: r.aboard | 0,
        free: Math.max(0, slots - (r.aboard | 0)),
        pending: mine.has(r.userId),
        seenAt: r.seenAt
      };
    })
    .filter(c => c.slots > 0)
    .slice(0, CREW_LIST_LIMIT);

  res.json({ captains, aboard: !!berth, serverTime: nowMs() });
});

/* ---- POST /api/crew/request { captain } — knock on a hull ----------------- */
app.post('/api/crew/request', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;

  const target = lookupUser(req.body, 'captain');
  if (!target) return httpErr(res, 404, 'NO_SUCH_CAPTAIN', 'no such captain');
  if (target.id === req.userId) return httpErr(res, 400, 'OWN_BOAT', 'that is your own boat');

  if (crews.berthOf(req.userId)) {
    return httpErr(res, 409, 'ALREADY_ABOARD', 'you are already aboard a boat · leave it first');
  }
  if (crews.count(req.userId) > 0) {
    return httpErr(res, 409, 'HOSTING_CREW', 'send your own crew ashore before boarding another boat');
  }
  if (crews.berthOf(target.id)) {
    return httpErr(res, 409, 'CAPTAIN_IS_GUEST', 'that captain is sailing as a guest right now');
  }

  const slots = crewSlots(saves.boatLvl(target.id));
  if (slots <= 0) return httpErr(res, 409, 'HULL_HAS_NO_BERTHS', 'that hull has no room for crew');
  if (crews.count(target.id) >= slots) return httpErr(res, 409, 'CREW_FULL', 'that crew is full');

  if (crews.hasRequest(target.id, req.userId)) {
    return httpErr(res, 409, 'ALREADY_WAITING', 'already waiting on that captain');
  }
  if (crews.requestsBy(req.userId).length >= CREW_MAX_OUTGOING) {
    return httpErr(res, 429, 'TOO_MANY_REQUESTS_OUT', `you may only await ${CREW_MAX_OUTGOING} captains at once`);
  }

  crews.addRequest(target.id, req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/cancel { captain } — withdraw your own knock ---------- */
app.post('/api/crew/cancel', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'captain');
  if (!target) return httpErr(res, 404, 'NO_SUCH_CAPTAIN', 'no such captain');

  crews.dropRequest(target.id, req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/admit { user } — the captain's yes -------------------- */
app.post('/api/crew/admit', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;

  const target = lookupUser(req.body, 'user');
  if (!target) return httpErr(res, 404, 'NO_SUCH_SAILOR', 'no such sailor');
  if (target.id === req.userId) return httpErr(res, 400, 'OWN_BOAT', 'you already crew your own boat');
  if (crews.berthOf(req.userId)) {
    return httpErr(res, 409, 'GUEST_ELSEWHERE', 'you are a guest aboard another boat · step ashore to captain your own');
  }

  const seats = boatSeats(saves.boatLvl(req.userId));
  let outcome;
  try { outcome = crews.admit(req.userId, target.id, seats); }
  catch (e) {
    log.error('crew admit failed', { userId: req.userId, targetId: target.id, err: e });
    return httpErr(res, 500, 'ADMIT_FAILED', 'could not admit');
  }

  const MSG = {
    'no-request': [404, 'that sailor is not waiting to board'],
    'aboard':     [409, 'that sailor already boarded another boat'],
    'captain':    [409, 'that sailor has their own crew aboard'],
    'full':       [409, 'your boat is full · a bigger hull seats more']
  };
  if (outcome !== 'ok') {
    const [code, error] = MSG[outcome] || [400, 'could not admit'];
    return httpErr(res, code, 'CREW_REJECTED', error);
  }

  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, admitted: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/deny { user } — the captain's no ---------------------- */
app.post('/api/crew/deny', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'user');
  if (!target) return httpErr(res, 404, 'NO_SUCH_SAILOR', 'no such sailor');

  if (!crews.dropRequest(req.userId, target.id)) {
    return httpErr(res, 404, 'NOT_WAITING', 'that sailor is not waiting to board');
  }
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, denied: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/kick { user } — put a shipmate ashore ----------------- */
app.post('/api/crew/kick', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'user');
  if (!target) return httpErr(res, 404, 'NO_SUCH_SAILOR', 'no such sailor');

  if (!crews.removeMember(req.userId, target.id)) {
    return httpErr(res, 404, 'NOT_ABOARD', 'that sailor is not on your boat');
  }
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, removed: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/leave — step ashore under your own steam ------------- */
app.post('/api/crew/leave', requireAuth, requireNotBanned, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const left = crews.leave(req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, left: !!left, ...crewView(req.userId, me ? me.username : '') });
});

/* ============================================================================
   FISHING DERBY — clock is public, settlement is server-side.
   ----------------------------------------------------------------------------
   events.js keeps derby scores in memory; this file owns the two ends the
   world sees: the countdown (below) and the payout sweep (the interval after
   it). Catches are scored inside POST /api/action/:name.
   ========================================================================== */

// Deliberately unauthenticated: the shell shows the derby countdown before
// sign-in, and the reply carries nothing but the wall clock.
app.get('/api/derby', (req, res) => {
  res.json({ derby: EV.derbyInfo(), serverTime: nowMs() });
});

// Settle closed derbies every 30s: credit the champion's pearls and tell every
// isle. loadState() may throw SaveUnreadable — an unreadable champion save is
// skipped (events.js never retries a payout, so the prize is forfeit rather
// than risked being paid twice).
every(DERBY_EVERY, () => {
  try {
    EV.sweepDerbies((w) => {
      let st = null;
      try { st = loadState(w.userId); }
      catch (e) {
        log.error('derby payout skipped · save unreadable', { userId: w.userId, err: e });
        return;
      }
      if (!st) return;
      // int0, not `| 0`: ToInt32 wraps at 2^31, so a long-lived pearlsLife
      // could take a derby prize and come back negative (see rules.js).
      st.pearls = int0(st.pearls) + int0(w.pearls);
      st.pearlsLife = int0(st.pearlsLife) + int0(w.pearls);
      saves.put(w.userId, st);
      announceAll({
        t: 'drama', kind: 'derby', name: w.username, world: w.world,
        kg: +w.kg.toFixed(1), pearls: w.pearls
      });
    });
  } catch (e) { log.error('derby sweep failed', { err: e }); }
});

/* ============================================================================
   POST /api/report — a player flags another by name (HTTP twin of the
   websocket report, for when the target is no longer online as a peer).
   ========================================================================== */
const REPORT_RATE = 15 * 1000;          // one report per user per 15s
const REPORT_ACTION = 'report';
const REPORT_TARGET_MAX = 20;
const REPORT_REASON_MAX = 120;

/** Control chars out, whitespace collapsed, cut to `max`. */
const cleanReportField = (v, max) => String(v ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

app.post('/api/report', requireAuth, requireNotBanned, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const target = cleanReportField(body.target, REPORT_TARGET_MAX);
  const reason = cleanReportField(body.reason, REPORT_REASON_MAX);
  if (!target) return httpErr(res, 400, 'MISSING_TARGET', 'missing target');

  const t = nowMs();
  try {
    const last = actionLog.last(req.userId, REPORT_ACTION) || 0;
    if (last > 0 && t - last < REPORT_RATE) {
      res.set('Retry-After', String(Math.ceil((REPORT_RATE - (t - last)) / 1000)));
      return httpErr(res, 429, 'RATE_LIMIT', 'too fast', { retryAfter: REPORT_RATE - (t - last) });
    }
  } catch (e) { log.error('report rate lookup failed', { userId: req.userId, err: e }); }

  try {
    DB.reports.add(req.userId, target, reason, '');
  } catch (e) {
    log.error('report write failed', { userId: req.userId, err: e });
    return httpErr(res, 500, 'REPORT_FAILED', 'could not record report');
  }
  try { actionLog.mark(req.userId, REPORT_ACTION); }
  catch (e) { log.error('action log write failed', { userId: req.userId, action: REPORT_ACTION, err: e }); }

  res.json({ ok: true });
});

/* ============================================================================
   CLIENT ERRORS — POST /api/client-error

   The one half of this game the server could never see. RF.err() funnels every
   client fault into a 300-entry ring buffer inside somebody's tab, where the
   only thing that reads it is that same player's notification drawer. A bug
   that fires on one Android Chrome build and nowhere else has been invisible
   from here since the day the game shipped.

   requireAuth costs nothing it would otherwise catch: the client only posts
   when RFNet.online is true, which already means signed in. It removes the
   anonymous flood surface completely, and it is what makes "how many DIFFERENT
   players hit this" answerable — the number that separates a broken build from
   one person with a broken extension.

   The user agent is read from the REQUEST HEADER, never from the body: a client
   that can name its own browser can name someone else's.
   ========================================================================== */
const CLIENT_ERROR_BATCH = 10;          // faults accepted per post; the rest are dropped
const clientErrorLimit = ipRateLimit({
  max: 12, windowMs: 10 * 60 * 1000,
  message: 'too many error reports, slow down',
});

app.post('/api/client-error', clientErrorLimit, requireAuth, requireNotBanned, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const list = Array.isArray(body.errors) ? body.errors.slice(0, CLIENT_ERROR_BATCH) : [];
  if (!list.length) return httpErr(res, 400, 'MISSING_ERRORS', 'nothing to record');

  const ua = String(req.get('user-agent') || '').slice(0, 200);
  const build = body.build;
  let kept = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    try {
      const rec = CLIENT_ERRORS.add({
        where: raw.where, level: raw.level, msg: raw.msg, name: raw.name,
        stack: raw.stack, build, ua, userId: req.userId,
      });
      kept++;
      /* The durable copy. The ring buffer is what an operator reads live; this
         is what is still there tomorrow. Logged once per POST per fault, not
         once per occurrence — `count` carries the volume. */
      log.warn('client fault', {
        where: rec.where, level: rec.level, msg: rec.msg, name: rec.name,
        build: rec.build, count: rec.count, userId: req.userId,
      });
    } catch (e) {
      log.error('client fault record failed', { userId: req.userId, err: e });
    }
  }

  res.json({ ok: true, kept });
});

/* ============================================================================
   HEALTH AND READINESS
   ----------------------------------------------------------------------------
   Two endpoints, because a proxy asks two different questions:

     /api/health  liveness  — "is this process still worth talking to?"
     /api/ready   readiness — "should new traffic be routed here?"

   Both do a REAL round trip to SQLite, because a process that is up with a
   closed or corrupt database is exactly the failure a flat {ok:true} hides.
   The probe is a prepared `SELECT 1` rather than db.stats(): stats() runs five
   COUNT(*) queries and two stat() calls, which is a strange amount of work to
   repeat every five seconds for an uptime check.

   Readiness additionally requires a migrated schema and flips to 503 the
   instant shutdown begins, so a load balancer drains us before the listener
   closes. Health reports the same drain, one signal ahead of the socket dying.

   Both are unauthenticated on purpose — the shell polls them before sign-in —
   and neither leaks anything but numbers.
   ========================================================================== */
const BOOTED_AT = Date.now();

let pingStmt;                 // prepared once; this runs on every probe
let SHUTTING_DOWN = false;

/**
 * A real query against SQLite. Returns null when healthy, or a short reason
 * when it is not — the reason goes into the 503 body so an operator reads the
 * cause instead of guessing at it.
 */
function probeDatabase() {
  try {
    const handle = DB.db;
    if (!handle || typeof handle.prepare !== 'function') return 'no database handle';
    if (handle.open === false) return 'database handle is closed';
    if (!pingStmt) pingStmt = handle.prepare('SELECT 1 AS ok');
    const row = pingStmt.get();
    if (!row || row.ok !== 1) return 'database probe returned nothing';
    return null;
  } catch (e) {
    log.error('database probe failed', { err: e });
    return 'database probe threw';
  }
}

/** The facts both endpoints report, healthy or not. */
function healthFacts() {
  let online = null;
  try { online = onlineTotal(); } catch { online = null; }
  return {
    service: 'reelfortune',
    now: Date.now(),
    uptimeMs: Date.now() - BOOTED_AT,
    uptime: process.uptime(),
    epoch: mktEpochNow(),
    schemaVersion: SCHEMA_VERSION,
    /* Absent, not null, on an API-only box: the client tests for the field's
       presence and skips the whole staleness check when there is nothing to
       compare against. */
    ...(BUILD_ID ? { build: BUILD_ID } : {}),
    online,
    serverTime: nowMs()
  };
}

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const facts = healthFacts();

  if (SHUTTING_DOWN) {
    res.set('Retry-After', '15');
    return res.status(503).json({ ok: false, reason: 'shutting down', db: 'draining', ...facts });
  }

  const failure = probeDatabase();
  if (failure) {
    res.set('Retry-After', '5');
    return res.status(503).json({ ok: false, reason: failure, db: 'unavailable', ...facts });
  }

  res.json({ ok: true, db: 'ok', ...facts });
});

app.get('/api/ready', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const facts = healthFacts();

  const refuse = (reason) => {
    res.set('Retry-After', '5');
    return res.status(503).json({ ok: false, ready: false, reason, ...facts });
  };

  if (SHUTTING_DOWN) return refuse('shutting down');

  const failure = probeDatabase();
  if (failure) return refuse(failure);

  // A schema version of 0 means the migrations never recorded one, which is a
  // half-initialised database and not somewhere to send players.
  if (!(SCHEMA_VERSION > 0)) return refuse('schema not migrated');

  res.json({ ok: true, ready: true, ...facts });
});

/* ------------------------------------------------------------- online ----- */
// Head-count per isle, straight out of the realtime layer. Deliberately
// unauthenticated: the shell shows how busy each world is before you sign in,
// and it leaks nothing but numbers.
app.get('/api/online', (req, res) => {
  res.json({
    total: onlineTotal(),
    rooms: {
      isle: roomCount('isle'),
      mine: roomCount('mine'),
      volcano: roomCount('volcano'),
      frost: roomCount('frost'),
      cave: roomCount('cave')
    }
  });
});

/* ============================================================================
   MODERATION CONSOLE
   ----------------------------------------------------------------------------
   Mounted after every game route and BEFORE the `unknown /api/* -> 404`
   catch-all below, or the catch-all would swallow every admin path. Dark by
   default: with no ADMIN_TOKEN set, every route under /api/admin answers 404
   rather than 401, so the surface is absent rather than merely locked.

   `realtime: RT` hands over the whole module rather than a hand-picked pair of
   functions, because admin.js feature-detects a kick hook and a presence
   listing under several plausible names — passing the namespace means the
   console gains "who is online, by name" and instant socket cuts on the day
   realtime.js exports them, with no edit here.
   ========================================================================== */
const adminConsole = mountAdmin(app, {
  db: DB,
  log: child({ mod: 'admin' }),
  realtime: RT
});

/* ---- unknown /api/* never falls through to the static file server -------- */
// notFoundJson calls next() for non-API paths, so the static handler below
// still gets its turn at them.
app.use(notFoundJson);

/* ============================================================================
   STATIC GAME FILES
   GAME_DIR is the project root, which also contains server/ — so the server
   source, its .env and the git history must be shut out explicitly.
   ========================================================================== */
const BLOCKED_PATH = /^\/(?:server|node_modules|\.git|\.env|contracts)(?:\/|$)/i;

app.use((req, res, next) => {
  if (BLOCKED_PATH.test(req.path)) return httpErr(res, 403, 'FORBIDDEN', 'forbidden');
  next();
});

/* /mint serves mint.html — ".html" in a URL people type and share is an
   implementation detail leaking into the product.

   It needs its own route rather than express.static's `extensions` option
   because the repo has BOTH a mint.html file and a mint/ directory (the page's
   scripts). Static's directory handling wins that race and 301s to "/mint/",
   which has no index and 404s. An explicit route settles it in one place, and
   /mint.html keeps working, so no link anybody has already shared can break. */
app.get('/mint', (req, res, next) => {
  res.sendFile(path.join(GAME_DIR, 'mint.html'), { headers: { 'Cache-Control': 'no-cache' } },
    (err) => { if (err) next(); });
});

app.use(express.static(GAME_DIR, {
  index: 'index.html',
  dotfiles: 'ignore',
  etag: true,
  setHeaders(res, filePath) {
    // The HTML shell must never be cached or players get stale client code
    // after a deploy; hashed-free assets get a short revalidating window.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=300');
  }
}));

/* ------------------------------------------------------------------ 404 --- */
// Called with no `next`, which is notFoundJson's signal to answer rather than
// fall through: there is nothing below this point but the error handlers.
app.use((req, res) => notFoundJson(req, res));

/* ============================================================================
   ERRORS — two handlers, and the order between them matters.
   ----------------------------------------------------------------------------
   The first one owns the failures this file has a stable machine code for. A
   client keys its retry policy off `code`, never off the English sentence, so
   SAVE_UNREADABLE and the body-parser rejections keep answering in that shape
   rather than being flattened into the generic envelope.

   Everything else — every unexpected throw — is handed to middleware.js's
   errorHandler, which is deliberately the last word: it logs the stack next to
   the request id and tells the client nothing but {error, id}. No stack, no
   message we did not write, not even in development, because the id is what
   turns a bug report into a `journalctl | grep`.
   ========================================================================== */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A save we refused to read: 503, never 500, and never a silent overwrite.
  if (err instanceof SaveUnreadable) {
    log.warn('save unreadable', { id: req && req.id, userId: err.userId });
    return refuseUnreadable(res);
  }

  // Body-parser failures. They are the client's fault and saying which one
  // plainly saves everybody a packet capture.
  if (err && err.type === 'entity.too.large') {
    log.warn('payload too large', { id: req && req.id, path: req && req.path });
    return httpErr(res, 413, 'PAYLOAD_TOO_LARGE', 'payload too large');
  }
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.body !== undefined))) {
    log.warn('malformed json', { id: req && req.id, path: req && req.path });
    return httpErr(res, 400, 'MALFORMED_JSON', 'malformed json');
  }

  return next(err);
});

app.use(errorHandler);

/* --------------------------------------------------------------- listen --- */
// Bound to loopback on purpose: nginx terminates TLS and proxies to us.
const server = app.listen(PORT, '127.0.0.1', () => {
  log.info('server listening', {
    url: `http://127.0.0.1:${PORT}`,
    gameDir: GAME_DIR,
    corsOrigin: CORS_ORIGIN,
    epoch: mktEpochNow(),
    adminConsole: adminConsole && adminConsole.enabled ? 'enabled' : 'disabled'
  });
});

server.on('error', (err) => {
  // EADDRINUSE and EACCES land here, and neither is survivable: nothing is
  // listening, so staying up would only be a process that answers nothing.
  log.error('http server error', { err });
  process.exit(1);
});

// The realtime layer rides on the same HTTP server: attach() takes the socket
// upgrades for itself and leaves every route above untouched.
attach(server);

/* ============================================================================
   GRACEFUL SHUTDOWN
   ----------------------------------------------------------------------------
   systemd sends SIGTERM on both `restart` and `stop`, and a deploy that drops
   in-flight requests or leaves the WAL unmerged is a deploy that loses coins.
   A restart should look like a blink to a player, not a mystery disconnect:

     1. flip /api/health and /api/ready to 503, so the proxy stops sending work
     2. stop the maintenance timers, so none of them fire into a closing handle
     3. close the listener to new connections; in-flight requests finish
     4. close every WebSocket with 1001 "going away" — the code a browser reads
        as "restarting, reconnect shortly" rather than as an error
     5. checkpoint the WAL back into the .db file, then close it
     6. exit 0

   SHUTDOWN_GRACE_MS is a hard deadline, not a suggestion. The deadline timer is
   deliberately NOT unref'd: an unref'd one lets an idle loop exit around it,
   and the whole point is that a socket which will never close cannot keep a
   half-dead process holding the port. Eight seconds sits comfortably inside
   systemd's default 90s TimeoutStopSec.
   ========================================================================== */
const SHUTDOWN_GRACE_MS = 8000;
const SOCKET_FLUSH_MS = 300;      // long enough for a close frame to leave
const LISTENER_WAIT_MS = 2000;    // then we stop waiting on server.close()

async function shutdown(signal, code = 0) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  log.info('shutdown started', { signal });

  const deadline = setTimeout(() => {
    log.error('graceful shutdown timed out · exiting anyway', { graceMs: SHUTDOWN_GRACE_MS });
    process.exit(code);
  }, SHUTDOWN_GRACE_MS);

  for (const timer of TIMERS) {
    try { clearInterval(timer); } catch { /* never thrown in practice */ }
  }

  const listenerClosed = new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
  if (typeof server.closeIdleConnections === 'function') {
    try { server.closeIdleConnections(); } catch { /* older node */ }
  }

  // realtime.js owns the peer set (it runs with clientTracking off, so
  // wss.clients is empty by design); closeAllSockets also stops its own timers.
  let sockets = 0;
  try { sockets = closeAllSockets(1001, 'server restarting') || 0; }
  catch (e) { log.error('socket close failed', { err: e }); }
  if (sockets > 0) log.info('websockets closed', { sockets, code: 1001 });

  /* An upgraded socket still counts as a server connection, so without this
     server.close() would wait on a peer that is never going to answer. Give the
     close frames a moment to leave, then drop whatever is left holding on. */
  await sleep(SOCKET_FLUSH_MS);
  if (typeof server.closeAllConnections === 'function') {
    try { server.closeAllConnections(); } catch { /* older node */ }
  }
  await Promise.race([listenerClosed, sleep(LISTENER_WAIT_MS)]);
  log.info('listener closed');

  // Fold the WAL back in before closing, so the .db file on disk is complete
  // even if the -wal sibling is lost along with the machine.
  try {
    const cp = DB.checkpoint();
    log.info('wal checkpointed', cp || { skipped: true });
  } catch (e) {
    log.error('checkpoint failed during shutdown', { err: e });
  }
  try {
    DB.close();
  } catch (e) {
    log.error('database close failed', { err: e });
  }

  clearTimeout(deadline);
  log.info('shutdown complete', { signal });
  // stdout to the journal flushes asynchronously; a bare exit() here can eat
  // the line above. Not unref'd, so the loop cannot leave without us.
  setTimeout(() => process.exit(code), 50);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (SHUTTING_DOWN) {
      // A second Ctrl+C means "I am not waiting" — honour it.
      log.warn('second signal during shutdown · exiting now', { signal: sig });
      process.exit(1);
    }
    shutdown(sig).catch((e) => {
      log.error('shutdown failed', { signal: sig, err: e });
      process.exit(1);
    });
  });
}

/* An uncaughtException takes a different path. middleware.js gives these hooks
   FATAL_GRACE_MS (3s) and then exits regardless, and the state they run against
   is by definition broken — so everything here is synchronous best-effort, and
   the only goals are getting the WAL onto disk and releasing the port. */
onFatal(() => {
  SHUTTING_DOWN = true;
  for (const timer of TIMERS) {
    try { clearInterval(timer); } catch { /* nothing to stop */ }
  }
  try { closeAllSockets(1012, 'server error'); } catch { /* nothing left to close */ }
  try { server.close(); } catch { /* never listening */ }
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch { /* older node */ }
  try { DB.close(); } catch { /* db.close() logs its own failure */ }
});

export default app;
