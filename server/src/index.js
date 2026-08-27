/* ============================================================================
   Reel Fortune 3D — authoritative game server
   ----------------------------------------------------------------------------
   The browser renders and sends INTENTS. Every coin, roll, drop and price is
   decided here. Nothing economic is ever read back from the client payload.

   Layout:
     src/index.js      <- this file (HTTP surface only, no game math)
     src/db.js         <- sqlite repositories
     src/auth.js       <- register/login/session middleware
     src/game/rules.js <- fish tables, upgrade costs, newState()
     src/game/economy.js <- market epochs, stock prices, dividends
     src/game/actions.js <- one handler per intent
   ========================================================================== */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import * as DB from './db.js';
import { requireAuth, mountAuth } from './auth.js';
import { HANDLERS, RATE } from './game/actions.js';
import { newState, BOATS, boatSeats, crewSlots, MAX_BOAT } from './game/rules.js';
import { payDividends, mktEpochNow } from './game/economy.js';

const { initSchema, saves, sessions, actions: actionLog, deedsRepo, crews } = DB;

/* ---------------------------------------------------------------- paths ---- */
const HERE = path.dirname(fileURLToPath(import.meta.url));   // <root>/server/src
const SERVER_ROOT = path.resolve(HERE, '..');                // <root>/server
// GAME_DIR is resolved relative to the server package root, so the default
// '../' lands on the project root that holds index.html + game.js + lib/.
const GAME_DIR = path.resolve(SERVER_ROOT, process.env.GAME_DIR || '../');

const PORT = Number(process.env.PORT) || 8787;
const IS_PROD = process.env.NODE_ENV === 'production';

/* --------------------------------------------------------------- boot ----- */
initSchema();

const CREW_REQUEST_TTL = 24 * 60 * 60 * 1000;   // unanswered boarding knocks expire after a day

// Drop expired sessions every 10 minutes. unref() so the timer never keeps a
// shutting-down process alive.
const sweepTimer = setInterval(() => {
  try { sessions.sweep(); } catch (e) { console.error('[sessions.sweep]', e); }
  try { crews.sweep(CREW_REQUEST_TTL); } catch (e) { console.error('[crews.sweep]', e); }
}, 10 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);           // nginx sits in front of us

/* ---------------------------------------------------------------- cors ---- */
// CORS_ORIGIN may be '*' (default) or a comma separated allow-list.
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
const ORIGIN_LIST = CORS_ORIGIN === '*'
  ? null
  : CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: ORIGIN_LIST ? ORIGIN_LIST : '*',
  // Wildcard origins may not be combined with credentials, so cookies-based
  // sessions only work once CORS_ORIGIN names real origins.
  credentials: !!ORIGIN_LIST,
  methods: ['GET', 'POST', 'OPTIONS'],
  // auth.js reads the session token from `Authorization: Bearer …` or `X-Auth-Token`.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token'],
  maxAge: 600
}));

app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------- helpers ---- */
const nowMs = () => Date.now();

/** Load a user's save, creating (and persisting) a fresh one on first login. */
function loadState(userId) {
  let state = null;
  try { state = saves.get(userId); } catch (e) { console.error('[saves.get]', e); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = newState();
    saves.put(userId, state);
  }
  return state;
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
 * Mirror state.deeds (minted by the game rules) into the ledger table so
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
      console.error('[deeds.sync]', deedId, e);
    }
  }
}

/** Standard success envelope for anything that hands back a full state. */
function stateEnvelope(state, extra) {
  return Object.assign({
    state,
    epoch: mktEpochNow(),
    serverTime: nowMs()
  }, extra || {});
}

/* ============================================================================
   AUTH  — POST /api/auth/{register,login,logout}, GET /api/auth/me
   ========================================================================== */
mountAuth(app);

/* ============================================================================
   GET /api/state — the client's only way to learn what it owns.
   ========================================================================== */
app.get('/api/state', requireAuth, (req, res) => {
  const state = loadState(req.userId);

  // Dividends accrue on market epochs, not on player actions, so they are
  // settled whenever the player checks in. payDividends() is epoch-guarded and
  // therefore safe to call on every request.
  let dividends = 0;
  try { dividends = payDividends(state) || 0; } catch (e) { console.error('[payDividends]', e); }

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

app.post('/api/action/:name', requireAuth, (req, res) => {
  const name = String(req.params.name || '');

  // hasOwnProperty guard: '/api/action/constructor' must not resolve.
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name) || typeof HANDLERS[name] !== 'function') {
    return res.status(404).json({ error: 'unknown action' });
  }

  const userId = req.userId;
  const t = nowMs();

  // --- cooldown: one action may not fire faster than its RATE ---------------
  const minGap = RATE[name] || 0;
  if (minGap > 0) {
    let last = 0;
    try { last = actionLog.last(userId, name) || 0; } catch (e) { console.error('[actions.last]', e); }
    const elapsed = t - last;
    if (last > 0 && elapsed < minGap) {
      res.set('Retry-After', String(Math.ceil((minGap - elapsed) / 1000)));
      return res.status(429).json({ error: 'too fast', retryAfter: minGap - elapsed });
    }
  }

  // --- anti-macro: a human cannot sustain 60 of the same action per minute --
  try {
    if (actionLog.countSince(userId, name, t - ANTI_MACRO_WINDOW) > ANTI_MACRO_MAX) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'too fast', retryAfter: ANTI_MACRO_WINDOW });
    }
  } catch (e) { console.error('[actions.countSince]', e); }

  const state = loadState(userId);

  // Settle any owed dividends first so the handler sees the true balance.
  let dividends = 0;
  try { dividends = payDividends(state) || 0; } catch (e) { console.error('[payDividends]', e); }

  let out;
  try {
    out = HANDLERS[name](state, req.body && typeof req.body === 'object' ? req.body : {});
  } catch (e) {
    console.error(`[action:${name}]`, e);
    return res.status(500).json({ error: 'action failed' });
  }

  if (!out || out.ok !== true) {
    const msg = (out && out.error) ? String(out.error) : 'invalid action';
    // A rejected action still persists any dividends we just credited.
    if (dividends > 0) saves.put(userId, state);
    return res.status(400).json({ error: msg });
  }

  saves.put(userId, state);
  try { actionLog.mark(userId, name); } catch (e) { console.error('[actions.mark]', e); }
  syncDeeds(userId, state);

  res.json(stateEnvelope(state, {
    ok: true,
    result: out.result || {},
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

app.post('/api/save', requireAuth, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const state = loadState(req.userId);
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
    const clean = body.titleId.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TITLE_MAX_LEN);
    const next = ownsAny ? clean : '';
    if (state.titleId !== next) { state.titleId = next; touched = true; }
  }

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
    console.error('[leaderboard] disabled:', e.message);
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
    console.error('[leaderboard]', e);
    return res.status(500).json({ error: 'leaderboard unavailable' });
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
   Deeds are trophies minted by the game rules. /claim binds one to a wallet
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
   ========================================================================== */
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const DEED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLAIM_RATE = 3000;              // ms between claims, per user
const CLAIM_MAX_PER_MIN = 10;
const CLAIM_ACTION = 'ledger_claim';

let LEDGER_SECRET = process.env.LEDGER_SECRET || '';
if (!LEDGER_SECRET) {
  if (IS_PROD) {
    console.error('[ledger] LEDGER_SECRET is not set — /api/ledger/claim will refuse to sign.');
  } else {
    LEDGER_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[ledger] LEDGER_SECRET missing; using an ephemeral dev secret. ' +
                 'Signatures will not survive a restart.');
  }
}

/** The exact bytes a real signer would sign, EIP-191 framed. */
function claimPayload(address, deedId, userId, blockNo) {
  const body =
    `Reel Fortune 3D — Isle Ledger claim\n` +
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
  const state = loadState(req.userId);
  syncDeeds(req.userId, state);

  let rows = [];
  try { rows = deedsRepo.list(req.userId) || []; } catch (e) { console.error('[deeds.list]', e); }

  res.json({ deeds: rows, epoch: mktEpochNow(), serverTime: nowMs() });
});

app.post('/api/ledger/claim', requireAuth, (req, res) => {
  if (!LEDGER_SECRET) {
    return res.status(503).json({ error: 'ledger signing is not configured' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const deedId = String(body.deedId || '');
  const rawAddr = String(body.address || '').trim();

  if (!DEED_ID_RE.test(deedId)) return res.status(400).json({ error: 'invalid deedId' });
  if (!ADDR_RE.test(rawAddr)) return res.status(400).json({ error: 'invalid address' });
  const address = rawAddr.toLowerCase();

  const userId = req.userId;
  const t = nowMs();

  // Same throttling shape as game actions.
  try {
    const last = actionLog.last(userId, CLAIM_ACTION) || 0;
    if (last > 0 && t - last < CLAIM_RATE) {
      res.set('Retry-After', '3');
      return res.status(429).json({ error: 'too fast', retryAfter: CLAIM_RATE - (t - last) });
    }
    if (actionLog.countSince(userId, CLAIM_ACTION, t - ANTI_MACRO_WINDOW) > CLAIM_MAX_PER_MIN) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'too fast', retryAfter: ANTI_MACRO_WINDOW });
    }
  } catch (e) { console.error('[ledger.rate]', e); }

  // Make sure the deed exists for this player before signing anything.
  const state = loadState(userId);
  syncDeeds(userId, state);

  let owned = false;
  try { owned = !!deedsRepo.has(userId, deedId); } catch (e) { console.error('[deeds.has]', e); }
  if (!owned) return res.status(400).json({ error: 'deed not minted for this player' });

  const blockNo = Number(state.deeds && state.deeds[deedId]) || 0;
  const payload = claimPayload(address, deedId, userId, blockNo);
  const signature = signClaim(address, deedId, userId);

  try {
    deedsRepo.setClaim(userId, deedId, address, signature);
  } catch (e) {
    console.error('[deeds.setClaim]', e);
    return res.status(500).json({ error: 'could not record claim' });
  }
  try { actionLog.mark(userId, CLAIM_ACTION); } catch (e) { console.error('[actions.mark]', e); }

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
  try { last = actionLog.last(userId, CREW_ACTION) || 0; } catch (e) { console.error('[crew.rate]', e); }
  const gap = nowMs() - last;
  if (last > 0 && gap < CREW_RATE) {
    res.set('Retry-After', '1');
    res.status(429).json({ error: 'too fast', retryAfter: CREW_RATE - gap });
    return true;
  }
  return false;
}
const markCrew = (userId) => {
  try { actionLog.mark(userId, CREW_ACTION); } catch (e) { console.error('[crew.mark]', e); }
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
  loadState(req.userId);                       // make sure a save (and boatLvl) exists
  const me = DB.users.findById(req.userId);
  res.json(crewView(req.userId, me ? me.username : ''));
});

/* ---- GET /api/crew/captains — hulls with a free berth, most recent first -- */
app.get('/api/crew/captains', requireAuth, (req, res) => {
  let rows = [];
  try { rows = saves.captains(CREW_LIST_LIMIT * 2, 1) || []; }
  catch (e) { console.error('[crew.captains]', e); return res.status(500).json({ error: 'unavailable' }); }

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
app.post('/api/crew/request', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;

  const target = lookupUser(req.body, 'captain');
  if (!target) return res.status(404).json({ error: 'no such captain' });
  if (target.id === req.userId) return res.status(400).json({ error: 'that is your own boat' });

  if (crews.berthOf(req.userId)) {
    return res.status(409).json({ error: 'you are already aboard a boat — leave it first' });
  }
  if (crews.count(req.userId) > 0) {
    return res.status(409).json({ error: 'send your own crew ashore before boarding another boat' });
  }
  if (crews.berthOf(target.id)) {
    return res.status(409).json({ error: 'that captain is sailing as a guest right now' });
  }

  const slots = crewSlots(saves.boatLvl(target.id));
  if (slots <= 0) return res.status(409).json({ error: 'that hull has no room for crew' });
  if (crews.count(target.id) >= slots) return res.status(409).json({ error: 'that crew is full' });

  if (crews.hasRequest(target.id, req.userId)) {
    return res.status(409).json({ error: 'already waiting on that captain' });
  }
  if (crews.requestsBy(req.userId).length >= CREW_MAX_OUTGOING) {
    return res.status(429).json({ error: `you may only await ${CREW_MAX_OUTGOING} captains at once` });
  }

  crews.addRequest(target.id, req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/cancel { captain } — withdraw your own knock ---------- */
app.post('/api/crew/cancel', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'captain');
  if (!target) return res.status(404).json({ error: 'no such captain' });

  crews.dropRequest(target.id, req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/admit { user } — the captain's yes -------------------- */
app.post('/api/crew/admit', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;

  const target = lookupUser(req.body, 'user');
  if (!target) return res.status(404).json({ error: 'no such sailor' });
  if (target.id === req.userId) return res.status(400).json({ error: 'you already crew your own boat' });
  if (crews.berthOf(req.userId)) {
    return res.status(409).json({ error: 'you are a guest aboard another boat — step ashore to captain your own' });
  }

  const seats = boatSeats(saves.boatLvl(req.userId));
  let outcome;
  try { outcome = crews.admit(req.userId, target.id, seats); }
  catch (e) { console.error('[crew.admit]', e); return res.status(500).json({ error: 'could not admit' }); }

  const MSG = {
    'no-request': [404, 'that sailor is not waiting to board'],
    'aboard':     [409, 'that sailor already boarded another boat'],
    'captain':    [409, 'that sailor has their own crew aboard'],
    'full':       [409, 'your boat is full — a bigger hull seats more']
  };
  if (outcome !== 'ok') {
    const [code, error] = MSG[outcome] || [400, 'could not admit'];
    return res.status(code).json({ error });
  }

  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, admitted: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/deny { user } — the captain's no ---------------------- */
app.post('/api/crew/deny', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'user');
  if (!target) return res.status(404).json({ error: 'no such sailor' });

  if (!crews.dropRequest(req.userId, target.id)) {
    return res.status(404).json({ error: 'that sailor is not waiting to board' });
  }
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, denied: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/kick { user } — put a shipmate ashore ----------------- */
app.post('/api/crew/kick', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const target = lookupUser(req.body, 'user');
  if (!target) return res.status(404).json({ error: 'no such sailor' });

  if (!crews.removeMember(req.userId, target.id)) {
    return res.status(404).json({ error: 'that sailor is not on your boat' });
  }
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, removed: target.username, ...crewView(req.userId, me ? me.username : '') });
});

/* ---- POST /api/crew/leave — step ashore under your own steam ------------- */
app.post('/api/crew/leave', requireAuth, (req, res) => {
  if (crewRateLimited(req.userId, res)) return;
  const left = crews.leave(req.userId);
  markCrew(req.userId);
  const me = DB.users.findById(req.userId);
  res.json({ ok: true, left: !!left, ...crewView(req.userId, me ? me.username : '') });
});

/* ------------------------------------------------------------- health ----- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, epoch: mktEpochNow(), serverTime: nowMs(), uptime: process.uptime() });
});

/* ---- unknown /api/* never falls through to the static file server -------- */
app.use((req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  next();
});

/* ============================================================================
   STATIC GAME FILES
   GAME_DIR is the project root, which also contains server/ — so the server
   source, its .env and the git history must be shut out explicitly.
   ========================================================================== */
const BLOCKED_PATH = /^\/(?:server|node_modules|\.git|\.env|contracts)(?:\/|$)/i;

app.use((req, res, next) => {
  if (BLOCKED_PATH.test(req.path)) return res.status(403).json({ error: 'forbidden' });
  next();
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

/* ------------------------------------------------------------ 404 / 500 --- */
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body parser failures arrive here as well.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload too large' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'malformed json' });
  }
  console.error('[unhandled]', err);
  res.status(500).json({
    error: 'internal error',
    ...(IS_PROD ? null : { detail: String((err && err.message) || err) })
  });
});

/* --------------------------------------------------------------- listen --- */
// Bound to loopback on purpose: nginx terminates TLS and proxies to us.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Reel Fortune 3D server on http://127.0.0.1:${PORT}`);
  console.log(`  static game dir : ${GAME_DIR}`);
  console.log(`  cors origin     : ${CORS_ORIGIN}`);
  console.log(`  market epoch    : ${mktEpochNow()}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — closing.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export default app;
