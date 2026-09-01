/* ============================================================================
   realtime.js — presence, chat and shared-resource news over one WebSocket.
   ----------------------------------------------------------------------------
   This socket carries NO money. Every coin, roll, drop and price still goes
   through the authenticated HTTP actions in index.js/actions.js, so a forged
   frame here can at worst make an avatar teleport or say something rude — it
   can never make anyone richer.

   Rooms are worlds. The client already builds each isle from a seeded PRNG, so
   ore node 17 and tree 4 mean the same thing in every browser standing on the
   same isle; that is why the shared-resource registry can be a pair of integer
   keyed maps instead of anything spatial.

   All realtime state is in memory and deliberately disposable: a restart drops
   presence and un-depletes every node, which is the correct failure mode for a
   feature that must never block the economy.

   Wire protocol (the client half lives in net.js + game.js §16):
     client -> {t:"hello", world, title, wardrobe}
              (the equipped Angler is NOT sent: the server reads it from the save)
               {t:"pos", x, y, z, face, act}     act: ""|"fish"|"mine"|"chop"|"dig"
               {t:"chat", m}
               {t:"mute", id}   {t:"unmute", id}
               {t:"report", id, reason?}
               {t:"ping"}
     server -> {t:"welcome", id, world, peers, nodes, trees, serverTime}
               {t:"join", p}      {t:"leave", id}
               {t:"snap", a:[[id,x,y,z,face,act], ...]}
               {t:"chat", id, name, m, at}   {t:"chat_err", m}
               {t:"mute_ok", id}  {t:"unmute_ok", id}  {t:"report_ok"}
               {t:"node", i, until}   {t:"tree", i, until}   {t:"pong"}
               {t:"suspended", until, why}   {t:"signed_out"}
   The last two are sent immediately before the socket is closed with 4403/4401,
   because a close code alone reaches no client that ignores the close event.
   ========================================================================== */

import { WebSocketServer } from 'ws';
// The namespace import exists alongside the named one because `reports` is
// being added to db.js separately; DB.reports is undefined until it lands,
// and the report handler guards for that instead of crashing.
import * as DB from './db.js';
import { sessions, users, saves } from './db.js';
import { isBanned, isMuted } from './admin.js';
import { WORLDS } from './game/rules.js';

/* ------------------------------------------------------------- tuning ----- */
const TICK_MS = 100;                   // position broadcast cadence (10Hz)
const PING_MS = 30 * 1000;             // protocol-level ping to every socket
const DEAD_MS = 60 * 1000;             // no pong / no traffic for this long -> cut
const HELLO_MS = 15 * 1000;            // authenticated but silent -> cut
const SWEEP_MS = 60 * 1000;            // registry expiry sweep

const MAX_FRAME = 8 * 1024;            // a frame larger than this closes the socket
const MAX_BUFFER = 512 * 1024;         // socket backlog we refuse to grow past

const POS_RATE = 20;                   // position updates per second, per peer
const POS_BURST = 20;                  // …with this much burst headroom
const CHAT_GAP = 1200;                 // ms between chat lines, per peer
const HELLO_GAP = 1000;                // ms between hellos, per peer

const CHAT_MAX = 200;                  // chars, after sanitising
const CHAT_DEDUPE_MS = 10 * 1000;      // identical repeat inside this window -> dropped
const CHAT_STRIKES = 3;                // masked lines inside the window before…
const CHAT_STRIKE_WINDOW_MS = 60 * 1000;
const CHAT_COOLDOWN_MS = 60 * 1000;    // …the peer loses chat for this long

const MUTE_MAX = 200;                  // per-peer mute list cap (receiver-side)
const REPORT_GAP_MS = 30 * 1000;       // one report per peer per 30s
const REASON_MAX = 120;                // chars kept of a report reason
const TITLE_MAX = 32;                  // matches index.js TITLE_MAX_LEN
const WARDROBE_MAX_COLOR = 31;         // matches index.js WARDROBE_MAX_COLOR
const WARDROBE_SLOTS = ['band', 'scarf', 'vest'];

const COORD_LIMIT = 1024;              // the widest isle is 96 units across
const MAX_RES_ID = 8191;               // ore/tree ids are small array indices
const MAX_RES_ENTRIES = 4096;          // depleted entries kept per world per kind

const DEFAULT_WORLD = 'isle';
const ACTS = new Set(['', 'fish', 'mine', 'chop', 'dig']);
const KINDS = { node: 'nodes', tree: 'trees' };

const OPEN = 1;                        // ws.readyState === WebSocket.OPEN

/* Close codes. 4000-4999 is the application-private range. */
const CLOSE_AUTH = 4401;               // bad or expired session token
const CLOSE_REPLACED = 4409;           // same account opened a newer socket
const CLOSE_SILENT = 4408;             // never said hello
const CLOSE_BANNED = 4403;             // the account is under a standing ban
const CLOSE_TOO_BIG = 1009;            // frame over MAX_FRAME

/* The session token may ride in the handshake's subprotocol list instead of the
   query string. Same secret, but a header never lands in nginx's access log the
   way `/ws?token=…` does. */
const BEARER_PROTO = 'rf.bearer.';

/* --------------------------------------------------------------- state ---- */
/** world -> Set<peer>. A peer appears here only once it has said hello. */
const rooms = new Map();
/** userId -> peer. One live socket per account; a new one evicts the old. */
const byUser = new Map();

/* Per-ACCOUNT moderation state. Sockets come and go — a refresh, a tunnel
   blip, a deliberate reconnect to dodge a cooldown — but the consequences of
   what someone said should not. Entries are pruned once they are inert. */
const modByUser = new Map();
function modOf(userId) {
  let m = modByUser.get(userId);
  if (!m) { m = { maskedAt: [], chatCoolUntil: 0, reportAt: 0 }; modByUser.set(userId, m); }
  return m;
}
function pruneMod(t) {
  for (const [uid, m] of modByUser) {
    const busy = m.chatCoolUntil > t
      || m.maskedAt.some((at) => t - at < CHAT_STRIKE_WINDOW_MS)
      || t - m.reportAt < REPORT_GAP_MS;
    if (!busy && !byUser.has(uid)) modByUser.delete(uid);
  }
}
/** Every authenticated socket, hello'd or not — the heartbeat walks this. */
const conns = new Set();
/** world -> { node: Map<id, untilMs>, tree: Map<id, untilMs> } */
const depleted = new Map();

let wss = null;
let nextId = 1;
let timers = [];

/* ------------------------------------------------------------- helpers ---- */
const now = () => Date.now();
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Finite, inside the playfield, rounded — or null when the client sent junk. */
function coord(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < -COORD_LIMIT || n > COORD_LIMIT) return null;
  return r2(n);
}

/** Facing angle in radians, wrapped to [-PI, PI] so lerpAngle never spins. */
function angle(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const wrapped = Math.atan2(Math.sin(n), Math.cos(n));
  return r3(wrapped);
}

/**
 * Rooms are worlds, and worlds are a closed set — never an arbitrary string,
 * or a client could conjure a private room (or an unbounded number of them).
 * Returns '' for anything that is not a real isle.
 */
function cleanWorld(v) {
  const k = typeof v === 'string' ? v.trim() : '';
  return Object.prototype.hasOwnProperty.call(WORLDS, k) ? k : '';
}

/**
 * The handshake is the one place that forgives a bad world: a client carrying a
 * stale `reelfortune3d-world` in localStorage still has to land somewhere. Every
 * other entry point stays strict, so a garbage key can never read or write the
 * starting isle's registry by accident.
 */
const helloWorld = (v) => cleanWorld(v) || DEFAULT_WORLD;

/** Cosmetic only, and cosmetic-only is why it may come from the client at all. */
function cleanTitle(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, TITLE_MAX);
}

function cleanWardrobe(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const slot of WARDROBE_SLOTS) {
    const n = Number(v[slot]);
    if (!Number.isFinite(n)) continue;
    out[slot] = Math.min(WARDROBE_MAX_COLOR, Math.max(0, Math.trunc(n)));
  }
  return out;
}

/**
 * Chat sanitising. Control characters become spaces rather than vanishing, so
 * "a\nb" stays two words; runs collapse, then we trim and cut to `max`.
 * Returns '' for anything that survives as empty — those are dropped.
 * Report reasons go through the same wringer with a shorter cut.
 */
function cleanChat(v, max = CHAT_MAX) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* ----------------------------------------------------- chat moderation ---- */

/** Anything that smells like a URL becomes "[link]" — game chat has no
    legitimate need to carry one, and phishing links are the main abuse. */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]{2,})+\/\S*|\b[a-z0-9-]+\.(?:com|net|org|io|gg|ly|me|co|id|xyz|link|app)\b/gi;

/** Four-or-more of the same character in a row squeezed to three:
    "WOIIIIII" -> "WOIII". Enthusiasm survives; keysmash walls do not. */
const REPEAT_RE = /(.)\1{3,}/g;

/**
 * Profanity is masked, never blocked: the line still lands, letter-for-letter
 * replaced with ✱, so the room keeps its rhythm and the troll gets nothing.
 *
 * Matching is whole-token only, which is what dodges the Scunthorpe problem —
 * "class", "assist" and "kontrol" pass untouched because they are not equal to
 * any listed word, merely contain one. Tokens are lowercased and common
 * digit/leet swaps are undone first, so "4NJ1NG" still reads as "anjing".
 */
const PROFANITY = new Set([
  // Indonesian
  'anjing', 'asu', 'babi', 'bajingan', 'bangsat', 'entot', 'goblok',
  'jancok', 'jancuk', 'jembut', 'kampret', 'keparat', 'kontol', 'lonte',
  'memek', 'ngentot', 'pepek', 'peler', 'tolol',
  // English
  'asshole', 'bastard', 'bitch', 'cock', 'cunt', 'dick', 'faggot', 'fuck',
  'fucker', 'fucking', 'motherfucker', 'nigga', 'nigger', 'pussy', 'shit',
  'slut', 'whore',
]);
const LEET = { 4: 'a', '@': 'a', 1: 'i', 3: 'e', 0: 'o', 5: 's', $: 's', 7: 't' };
const TOKEN_RE = /[a-z0-9@$]+/gi;
const LEET_RE = /[4@1305$7]/g;

/** Returns { text, masked } — `text` with profane tokens turned to ✱✱✱✱✱✱. */
function maskProfanity(text) {
  let masked = false;
  const out = text.replace(TOKEN_RE, (word) => {
    const norm = word.toLowerCase().replace(LEET_RE, (ch) => LEET[ch]);
    if (!PROFANITY.has(norm)) return word;
    masked = true;
    return '✱'.repeat(word.length);
  });
  return { text: out, masked };
}

/** Peer ids are small positive integers handed out by this module. */
function peerIdArg(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Resource ids are array indices on the client; anything else is a bug or an attack. */
function resId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RES_ID) return null;
  return n;
}

/* ---------------------------------------------------------------- send ---- */
/**
 * Every write funnels through here: closed sockets are skipped, and a socket
 * whose backlog is already past MAX_BUFFER is left alone rather than fed more
 * (the heartbeat cuts it loose if it never drains).
 */
function rawSend(peer, raw) {
  const ws = peer.ws;
  if (!ws || ws.readyState !== OPEN || ws.bufferedAmount > MAX_BUFFER) return false;
  try {
    ws.send(raw);
    return true;
  } catch {
    return false;
  }
}

const send = (peer, obj) => rawSend(peer, JSON.stringify(obj));

/* A 4xxx close code is a message only if someone reads it, and the browser half
   of the client hands its close handler no event at all: every code lands in the
   same reconnect ladder, so a suspended account re-knocks every 30s forever and
   sees nothing but presence and chat quietly not working. These two send a typed
   frame first — ws flushes queued data before the close frame — so the reason
   survives even where only the code would not, and the close reason string
   carries the end date for a handler that reads `ev.reason` instead. */
function sayThenClose(ws, obj, code, reason) {
  try {
    if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(obj));
  } catch { /* the close still has to happen */ }
  try { ws.close(code, String(reason).slice(0, 60)); } catch { /* already gone */ }
}

/** Ban expiry as something a banner can print without a date library. */
function banUntilText(until) {
  if (!until) return '';
  const d = new Date(until);
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

/**
 * Close one socket for a standing ban, telling it why. `until`/`why` come from
 * the sanction row rather than the caller so every door reports the same thing;
 * `fallback` only names the close when there is no row to read (kick() is
 * exported and may be cutting a socket for some other reason entirely).
 */
function closeBanned(ws, userId, fallback = 'suspended') {
  // A sanction lookup that throws must not leave the socket open: cutting it
  // with a vaguer reason is the safe half of the failure.
  let ban = { banned: false, until: 0, reason: '' };
  try { ban = isBanned(userId); } catch (e) { console.error('[rt.ban]', e); }
  if (!ban.banned) {
    try { ws.close(CLOSE_BANNED, String(fallback).slice(0, 60)); } catch { /* already gone */ }
    return;
  }
  const stamp = banUntilText(ban.until);
  sayThenClose(
    ws,
    { t: 'suspended', until: ban.until || 0, why: ban.reason || '' },
    CLOSE_BANNED,
    stamp ? `suspended until ${stamp}` : 'suspended',
  );
}

/** Serialise once, deliver many. `exceptId` skips the peer that caused the event. */
function roomSend(world, obj, exceptId) {
  const room = rooms.get(world);
  if (!room || room.size === 0) return;
  const raw = JSON.stringify(obj);
  for (const peer of room) {
    if (exceptId != null && peer.id === exceptId) continue;
    rawSend(peer, raw);
  }
}

/**
 * Public broadcast primitives for other modules (events, announcements).
 * Both serialise once and skip non-OPEN/backed-up sockets via rawSend.
 */
export function broadcast(world, obj) {
  roomSend(cleanWorld(world), obj);   // '' -> no room -> no-op, by design
}

/**
 * Tell this player's isle that they changed Angler, without making them
 * reconnect to be seen in it.
 *
 * Called by /api/nft/equip AFTER the on-chain ownership check has passed. The
 * token is re-read from the save here rather than passed in, so there is only
 * one path by which a skin can reach other players' screens, and it starts at
 * the database.
 *
 * A no-op when the player has no live socket, which is the common case: they
 * will carry the new skin into their next hello anyway.
 */
export function announceChar(userId) {
  const peer = byUser.get(Number(userId));
  if (!peer || !peer.world) return false;

  let next = 0;
  try {
    const st = saves.get(peer.userId);
    const id = st && st.charTokenId;
    if (Number.isInteger(id) && id > 0) next = id;
  } catch (e) { console.error('[rt.char]', e); return false; }

  if (peer.charTokenId === next) return false;
  peer.charTokenId = next;
  // Sent to the whole room INCLUDING the wearer: their own hero is redrawn by
  // the wardrobe mod, but every other client needs to be told.
  roomSend(peer.world, { t: 'skin', id: peer.id, charTokenId: next });
  return true;
}

export function announceAll(obj) {
  const raw = JSON.stringify(obj);
  for (const room of rooms.values()) {
    for (const peer of room) rawSend(peer, raw);
  }
}

/** The public shape of a peer: display name from the DB, cosmetics from hello. */
function peerPayload(p) {
  return {
    id: p.id,
    name: p.name,
    title: p.title,
    x: p.x, y: p.y, z: p.z,
    face: p.face,
    act: p.act,
    wardrobe: p.wardrobe,
    // 0 = the default hero. Read from the save on the server (see onHello), so
    // this is a token the player demonstrably owns, not one they claimed.
    charTokenId: p.charTokenId || 0,
  };
}

/* ============================================================================
   SHARED RESOURCE REGISTRY
   ----------------------------------------------------------------------------
   One player swinging a pick should make the node vanish on every screen in
   that world. actions.js owns the decision (and the loot); this owns the news.
   ========================================================================== */

/** The two maps for a world, created on demand. */
function bucket(world) {
  let b = depleted.get(world);
  if (!b) {
    b = { node: new Map(), tree: new Map() };
    depleted.set(world, b);
  }
  return b;
}

/** Drop entries whose respawn has already come round. */
function pruneBucket(b, t) {
  for (const kind of Object.keys(KINDS)) {
    const map = b[kind];
    for (const [id, until] of map) if (until <= t) map.delete(id);
  }
  return b.node.size + b.tree.size;
}

function sweepRegistry() {
  const t = now();
  for (const [world, b] of depleted) {
    if (pruneBucket(b, t) === 0) depleted.delete(world);
  }
  pruneMod(t);   // moderation state outlives sockets, so it needs its own broom
}

export const nodes = {
  /**
   * Mark one ore node or tree as harvested until `untilMs`, and tell the world.
   *
   * Returns true only when this call is what took the resource down. It returns
   * false when the arguments are unusable, when `untilMs` is already in the
   * past, or when the resource is ALREADY depleted — so a caller that races two
   * players onto the same node can use the return value to decide who won:
   *
   *     if (!nodes.deplete(state.world, 'node', id, Date.now() + RESPAWN)) {
   *       return err('someone else got there first');
   *     }
   */
  deplete(world, kind, id, untilMs) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return false;
    const key = cleanWorld(world);
    if (!key) return false;
    const i = resId(id);
    if (i === null) return false;

    const until = Number(untilMs);
    if (!Number.isFinite(until)) return false;

    const t = now();
    if (until <= t) return false;                 // nothing to mark

    const b = bucket(key);
    const map = b[kind];

    const standing = map.get(i);
    if (standing !== undefined) {
      if (standing > t) return false;             // already down — first swing wins
      map.delete(i);                              // respawned; this swing may retake it
    }

    // Keep a runaway world from growing an unbounded map.
    if (map.size >= MAX_RES_ENTRIES) {
      pruneBucket(b, t);
      if (map.size >= MAX_RES_ENTRIES) return false;
    }

    const stamp = Math.round(until);
    map.set(i, stamp);
    roomSend(key, { t: kind, i, until: stamp });
    return true;
  },

  /** Is this resource currently harvested? Expired entries clear themselves. */
  isDown(world, kind, id) {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return false;
    const key = cleanWorld(world);
    if (!key) return false;
    const b = depleted.get(key);
    if (!b) return false;
    const i = resId(id);
    if (i === null) return false;

    const until = b[kind].get(i);
    if (until === undefined) return false;
    if (until <= now()) {
      b[kind].delete(i);
      return false;
    }
    return true;
  },

  /** Everything still down in a world, in the wire shape `welcome` expects. */
  snapshot(world) {
    const out = { nodes: [], trees: [] };
    const key = cleanWorld(world);
    const b = key ? depleted.get(key) : null;
    if (!b) return out;

    const t = now();
    for (const [kind, field] of Object.entries(KINDS)) {
      const map = b[kind];
      for (const [id, until] of map) {
        if (until <= t) { map.delete(id); continue; }
        out[field].push([id, until]);
      }
    }
    return out;
  },
};

/* ============================================================================
   PRESENCE
   ========================================================================== */

export function roomCount(world) {
  const key = cleanWorld(world);
  const room = key ? rooms.get(key) : null;
  return room ? room.size : 0;
}

export function onlineTotal() {
  let n = 0;
  for (const room of rooms.values()) n += room.size;
  return n;
}

/**
 * Close every live socket with an explicit reason. Used by the shutdown path so
 * a deploy reads as "server restarting" in the client's chat log instead of an
 * unexplained drop — the client's reconnect backoff then does the rest.
 */
export function closeAllSockets(code = 1001, reason = 'server restarting') {
  let n = 0;
  for (const peer of Array.from(conns)) {
    try { peer.ws.close(code, reason); n++; } catch { /* already gone */ }
  }
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  return n;
}

/**
 * Cut one account's socket now. admin.js feature-detects this so /api/admin/ban
 * lands instantly instead of waiting for the next heartbeat to notice.
 * Returns false when the account has no live socket, which is not an error.
 */
export function kick(userId, reason = 'kicked') {
  const peer = byUser.get(Number(userId));
  if (!peer) return false;
  dropPeer(peer);
  closeBanned(peer.ws, peer.userId, reason);
  return true;
}

function joinRoom(peer, world) {
  let room = rooms.get(world);
  if (!room) rooms.set(world, (room = new Set()));
  room.add(peer);
  peer.world = world;
  // `welcome`/`join` already carried this position; do not echo it again.
  peer.dirty = false;
  return room;
}

function leaveRoom(peer) {
  const world = peer.world;
  if (!world) return;
  peer.world = '';

  const room = rooms.get(world);
  if (room) {
    room.delete(peer);
    if (room.size === 0) rooms.delete(world);
  }
  roomSend(world, { t: 'leave', id: peer.id });
}

/** Idempotent teardown — close, error and eviction all land here. */
function dropPeer(peer) {
  if (peer.gone) return;
  peer.gone = true;
  conns.delete(peer);
  if (byUser.get(peer.userId) === peer) byUser.delete(peer.userId);
  leaveRoom(peer);
}

/* ------------------------------------------------------- message handlers -- */

/** A position budget that refills at POS_RATE/s; overflow is dropped, not fatal. */
function allowPos(peer, t) {
  const dt = Math.max(0, t - peer.posAt);
  peer.posAt = t;
  peer.posTokens = Math.min(POS_BURST, peer.posTokens + (dt * POS_RATE) / 1000);
  if (peer.posTokens < 1) return false;
  peer.posTokens -= 1;
  return true;
}

function onHello(peer, msg, t) {
  if (t - peer.helloAt < HELLO_GAP) return;
  peer.helloAt = t;

  const world = helloWorld(msg.world);
  peer.title = cleanTitle(msg.title);
  peer.wardrobe = cleanWardrobe(msg.wardrobe);

  // The display name is ALWAYS the account name. The client never gets a say.
  let row = null;
  try { row = users.findById(peer.userId); } catch (e) { console.error('[rt.users]', e); }
  peer.name = row && row.username ? String(row.username) : 'angler';

  /* The equipped Angler, for the same reason and from the same direction: it is
     read out of this account's save, which only /api/nft/equip can write and
     only after checking the chain. Taking it from `msg` instead would let
     anybody broadcast a legendary they have never owned — the wardrobe indices
     above are bounded numbers and cost nothing to fake, but this one is a claim
     of property, so it comes from the server's own records. */
  peer.charTokenId = 0;
  try {
    const st = saves.get(peer.userId);
    const id = st && st.charTokenId;
    if (Number.isInteger(id) && id > 0) peer.charTokenId = id;
  } catch (e) { console.error('[rt.char]', e); }

  // A second hello means the player sailed: the old isle sees them leave.
  if (peer.world) leaveRoom(peer);

  const room = joinRoom(peer, world);

  const peers = [];
  for (const other of room) if (other !== peer) peers.push(peerPayload(other));

  const snap = nodes.snapshot(world);
  send(peer, {
    t: 'welcome',
    id: peer.id,
    world,
    peers,
    nodes: snap.nodes,
    trees: snap.trees,
    serverTime: t,
  });

  roomSend(world, { t: 'join', p: peerPayload(peer) }, peer.id);
}

function onPos(peer, msg, t) {
  if (!peer.world) return;                 // still pre-hello: nowhere to put them
  if (!allowPos(peer, t)) return;          // over budget — drop, never disconnect

  const x = coord(msg.x), y = coord(msg.y), z = coord(msg.z);
  if (x === null || y === null || z === null) return;
  const face = angle(msg.face);
  if (face === null) return;

  const act = typeof msg.act === 'string' && ACTS.has(msg.act) ? msg.act : '';

  if (x === peer.x && y === peer.y && z === peer.z && face === peer.face && act === peer.act) {
    return;                                // nothing actually moved
  }
  peer.x = x; peer.y = y; peer.z = z;
  peer.face = face; peer.act = act;
  peer.dirty = true;
}

/**
 * Chat, in layers. The philosophy: defuse rather than silence. URLs and
 * profanity are rewritten and the line still lands; only repetition (dedupe)
 * and repeat offenders (cooldown) are actually dropped, and the cooldown
 * announces itself so the player is never left wondering.
 */
function onChat(peer, msg, t) {
  if (!peer.world) return;
  if (t - peer.chatAt < CHAT_GAP) return;

  // In cooldown: the socket stays, the megaphone doesn't.
  if (t < peer.mod.chatCoolUntil) {
    peer.chatAt = t;
    send(peer, { t: 'chat_err', m: 'cooldown' });
    return;
  }

  /* A moderator mute outranks every layer below. Checked after the CHAT_GAP
     throttle so the answer cannot be used as a free rate-limit probe, and the
     stamp is refreshed so a muted player spamming the box still pays the gap. */
  const gag = isMuted(peer.userId);
  if (gag.muted) {
    peer.chatAt = t;
    send(peer, { t: 'chat_err', m: 'muted', until: gag.until });
    return;
  }

  let m = cleanChat(msg.m);
  if (!m) return;
  peer.chatAt = t;

  m = m
    .replace(URL_RE, '[link]')
    .replace(REPEAT_RE, '$1$1$1')
    .trim()
    .slice(0, CHAT_MAX);   // "[link]" can be longer than a short URL was
  if (!m) return;

  // Same line (case-insensitive) as their previous one inside 10s: silent
  // drop. Refreshing the stamp on the drop means a line spammed continuously
  // never gets through again until the sender actually pauses.
  const norm = m.toLowerCase();
  if (norm === peer.lastChatNorm && t - peer.lastChatNormAt < CHAT_DEDUPE_MS) {
    peer.lastChatNormAt = t;
    return;
  }
  peer.lastChatNorm = norm;
  peer.lastChatNormAt = t;
  peer.lastChatText = m;   // pre-mask, so a report shows a moderator the real line

  const { text, masked } = maskProfanity(m);
  if (masked) {
    peer.mod.maskedAt.push(t);
    peer.mod.maskedAt = peer.mod.maskedAt.filter((at) => t - at < CHAT_STRIKE_WINDOW_MS);
    if (peer.mod.maskedAt.length >= CHAT_STRIKES) {
      // Third strike: this line still goes out (masked), then the megaphone
      // goes away for a minute and the peer is told exactly why.
      peer.mod.chatCoolUntil = t + CHAT_COOLDOWN_MS;
      peer.mod.maskedAt.length = 0;
      send(peer, { t: 'chat_err', m: 'cooldown' });
    }
  }

  // Hand-rolled rather than roomSend: recipients who muted this sender are
  // skipped. Mute is the receiver's preference, never a judgement of the sender.
  const room = rooms.get(peer.world);
  if (!room) return;
  const raw = JSON.stringify({ t: 'chat', id: peer.id, name: peer.name, m: text, at: t });
  for (const other of room) {
    if (other.mutedUsers.has(peer.userId)) continue;
    rawSend(other, raw);
  }
}

/**
 * Mute lives on the RECEIVER: it filters what this peer hears and costs the
 * muted player nothing. It is stored by ACCOUNT, not by socket id — otherwise
 * the muted player reconnects, is handed a fresh peer id, and walks straight
 * back into every mute list in the room. The client still speaks peer ids, so
 * we resolve one to its account here and answer with the id it sent.
 */
function peerByIdInRoom(peer, id) {
  for (const other of conns) if (other.id === id && other.world === peer.world) return other;
  return null;
}
function onMute(peer, msg) {
  const id = peerIdArg(msg.id);
  if (id === null || id === peer.id) return;
  const target = peerByIdInRoom(peer, id);
  if (!target) return;                          // gone already: nothing to mute
  if (!peer.mutedUsers.has(target.userId)) {
    if (peer.mutedUsers.size >= MUTE_MAX) return;   // silently full — no ack to lie with
    peer.mutedUsers.add(target.userId);
  }
  send(peer, { t: 'mute_ok', id });
}

function onUnmute(peer, msg) {
  const id = peerIdArg(msg.id);
  if (id === null) return;
  const target = peerByIdInRoom(peer, id);
  if (target) peer.mutedUsers.delete(target.userId);
  send(peer, { t: 'unmute_ok', id });
}

/**
 * Report: heavily throttled, stored via DB.reports when that module has
 * landed (it is being added to db.js separately — hence the typeof guard),
 * and always acked so the client UX is identical whether or not the target
 * was still online to snapshot.
 */
function onReport(peer, msg, t) {
  if (t - peer.mod.reportAt < REPORT_GAP_MS) return;
  const id = peerIdArg(msg.id);
  if (id === null || id === peer.id) return;
  peer.mod.reportAt = t;

  let target = null;
  for (const p of conns) {
    if (p.id === id) { target = p; break; }
  }

  if (target && typeof DB.reports?.add === 'function') {
    const reason = cleanChat(msg.reason, REASON_MAX);
    try {
      DB.reports.add(peer.userId, target.name, reason, target.lastChatText.slice(0, CHAT_MAX));
    } catch (e) {
      console.error('[rt.report]', e);
    }
  }
  send(peer, { t: 'report_ok' });
}

/**
 * One frame. Nothing in here may throw: an exception on a socket handler in
 * Node is an unhandled rejection away from taking the whole server down.
 */
function onMessage(peer, data, isBinary) {
  try {
    peer.seenAt = now();
    if (isBinary) return;                        // the protocol is text-only

    if (data.length > MAX_FRAME) {
      peer.ws.close(CLOSE_TOO_BIG, 'frame too large');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;                                    // malformed JSON is simply ignored
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    const t = peer.seenAt;
    switch (msg.t) {
      case 'hello':  onHello(peer, msg, t);  break;
      case 'pos':    onPos(peer, msg, t);    break;
      case 'chat':   onChat(peer, msg, t);   break;
      case 'mute':   onMute(peer, msg);      break;
      case 'unmute': onUnmute(peer, msg);    break;
      case 'report': onReport(peer, msg, t); break;
      case 'ping':   send(peer, { t: 'pong' }); break;
      default: break;                            // unknown types are ignored
    }
  } catch (e) {
    console.error('[rt.message]', e);
  }
}

/* ------------------------------------------------------------- the loop --- */

/**
 * 10Hz. Only peers whose position actually changed go out, batched per room, so
 * a quiet isle costs nothing and a busy one costs one JSON.stringify per tick.
 */
function tick() {
  try {
    for (const room of rooms.values()) {
      let batch = null;
      for (const peer of room) {
        if (!peer.dirty) continue;
        peer.dirty = false;
        (batch || (batch = [])).push([peer.id, peer.x, peer.y, peer.z, peer.face, peer.act]);
      }
      if (!batch) continue;

      const raw = JSON.stringify({ t: 'snap', a: batch });
      // When the only mover is the recipient, the frame is pure echo: skip it.
      const solo = batch.length === 1 ? batch[0][0] : null;
      for (const peer of room) {
        if (peer.id === solo) continue;
        rawSend(peer, raw);
      }
    }
  } catch (e) {
    console.error('[rt.tick]', e);
  }
}

/** Ping everyone, cut whoever has gone quiet, never said hello, or is jammed. */
function heartbeat() {
  const t = now();
  for (const peer of conns) {
    const ws = peer.ws;
    try {
      if (ws.readyState !== OPEN) { dropPeer(peer); continue; }

      if (t - peer.seenAt > DEAD_MS) { ws.terminate(); continue; }
      if (!peer.world && t - peer.openedAt > HELLO_MS) {
        ws.close(CLOSE_SILENT, 'no hello');
        continue;
      }
      // A backlog that survived a whole heartbeat is never going to drain.
      if (ws.bufferedAmount > MAX_BUFFER) { ws.terminate(); continue; }

      // A ban landing mid-session revokes the sessions row, but this socket
      // authenticated once at connect and would otherwise outlive it. kick()
      // usually gets here first; this is the backstop, within one PING_MS.
      if (isBanned(peer.userId).banned) { closeBanned(ws, peer.userId); continue; }

      ws.ping();
    } catch (e) {
      console.error('[rt.heartbeat]', e);
      try { ws.terminate(); } catch { /* already gone */ }
      dropPeer(peer);
    }
  }
}

/* ============================================================================
   ATTACH
   ========================================================================== */

/** Every subprotocol the client offered, in the order it offered them. */
function offeredProtocols(req) {
  const raw = req && req.headers && req.headers['sec-websocket-protocol'];
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

/** The `rf.bearer.<token>` subprotocol the client offered, verbatim, or null. */
function bearerProtocol(req) {
  for (const p of offeredProtocols(req)) {
    if (p.length > BEARER_PROTO.length && p.startsWith(BEARER_PROTO)) return p;
  }
  return null;
}

/**
 * Pull the session token out of the handshake.
 *
 * The subprotocol wins when it is offered: `Sec-WebSocket-Protocol` is a header,
 * and a header stays out of nginx's access log, out of a Referer and out of
 * browser history — all of which `/ws?token=…` walks straight into. The query
 * string stays supported because a client that predates the subprotocol (or a
 * curl one-liner) must keep connecting; net.js sends both during the changeover.
 */
function tokenFrom(req) {
  const proto = bearerProtocol(req);
  if (proto) return proto.slice(BEARER_PROTO.length);
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token');
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Subprotocol negotiation. RFC 6455 lets the server answer with no
 * Sec-WebSocket-Protocol at all, but a browser that offered one and hears
 * nothing back reports `ws.protocol === ''` and some proxies get unhappy, so the
 * bearer protocol is echoed verbatim whenever it was offered. Returning false
 * for anything else means we never echo an unrecognised protocol back.
 */
function selectProtocol(protocols, req) {
  const proto = bearerProtocol(req);
  if (proto && (!protocols || protocols.has(proto))) return proto;
  return false;
}

function onConnection(ws, req) {
  // --- authenticate before anything else touches shared state --------------
  let userId = null;
  try {
    const token = tokenFrom(req);
    if (token) userId = sessions.verify(token);
  } catch (e) {
    console.error('[rt.verify]', e);
  }
  if (!userId) {
    // Same blind spot as the ban close: an expired token otherwise reads as a
    // network blip and the ladder retries a session that will never verify.
    sayThenClose(ws, { t: 'signed_out' }, CLOSE_AUTH, 'unauthorised');
    return;
  }

  // The front door, before any shared state is touched: a suspended account
  // gets no presence, no chat and no room membership at all.
  if (isBanned(userId).banned) {
    closeBanned(ws, userId);
    return;
  }

  // --- one socket per account: the newcomer wins ---------------------------
  const previous = byUser.get(userId);
  if (previous) {
    dropPeer(previous);
    try { previous.ws.close(CLOSE_REPLACED, 'replaced by a newer connection'); }
    catch { /* already gone */ }
  }

  const t = now();
  /* Moderation state belongs to the ACCOUNT, not the socket. Without this a
     player in a chat cooldown gets the megaphone back by pressing F5, and the
     report throttle resets on every reconnect. `modOf` keeps it across sockets. */
  const mod = modOf(userId);
  const peer = {
    id: nextId++,
    userId,
    ws,
    world: '',                 // set by hello; until then they are in no room
    name: 'angler',
    title: '',
    wardrobe: {},
    charTokenId: 0,
    x: 0, y: 0, z: 0, face: 0, act: '',
    dirty: false,
    gone: false,
    openedAt: t,
    seenAt: t,
    posAt: t,
    posTokens: POS_BURST,
    chatAt: 0,
    helloAt: 0,
    // -- chat moderation state --
    lastChatNorm: '',          // previous line, lowercased, for the dedupe check
    lastChatNormAt: 0,
    lastChatText: '',          // previous line pre-mask, attached to reports
    mod,                       // shared, per-account: strikes, cooldown, report gap
    mutedUsers: new Set(),     // ACCOUNT ids this RECEIVER chose not to hear
  };

  conns.add(peer);
  byUser.set(userId, peer);

  ws.on('message', (data, isBinary) => onMessage(peer, data, isBinary));
  ws.on('pong', () => { peer.seenAt = now(); });
  ws.on('close', () => dropPeer(peer));
  ws.on('error', (err) => {
    console.error('[rt.socket]', err && err.message ? err.message : err);
    dropPeer(peer);
  });
}

/**
 * Mount the realtime endpoint on an existing http.Server. Idempotent: calling
 * it twice returns the server already listening rather than double-binding.
 */
export function attach(httpServer) {
  if (wss) return wss;

  wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: MAX_FRAME,     // an oversized frame closes the socket for us
    perMessageDeflate: false,  // frames are tiny; compression would cost more
    clientTracking: false,     // `conns` is the authoritative set
    handleProtocols: selectProtocol,
  });

  wss.on('connection', onConnection);
  wss.on('error', (err) => console.error('[rt.server]', err));

  timers = [
    setInterval(tick, TICK_MS),
    setInterval(heartbeat, PING_MS),
    setInterval(sweepRegistry, SWEEP_MS),
  ];
  // Never let a background timer hold a shutting-down process open.
  for (const timer of timers) if (typeof timer.unref === 'function') timer.unref();

  return wss;
}
