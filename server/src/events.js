/* ============================================================================
   events.js — deterministic multiplayer events driven by the wall clock.
   Two events, no cron, no db, no I/O:

     - FISHING DERBY: the first 10 minutes of every hour. Catches reported
       while the window is open score total kg per user, per world; the next
       sweep after the window closes crowns one champion per world and hands
       the payout to the caller.

     - WANTED FISH: one bounty species per world per market epoch (3 min),
       derived purely from hash(epoch, seed) — every client and the server
       agree on the target without exchanging a byte. First claim per
       world+epoch takes the bounty.

   The derby is mirrored to a store when one is attached (see setDerbyStore):
   memory stays the fast path and the only thing scoring reads, while the store
   makes a restart mid-race survivable and keeps a permanent record of every
   champion. With no store attached the module behaves exactly as it always
   did — pure, in-memory, no I/O — which is how the tests run it.

   The wanted claim is still memory-only: a restart re-opens the current
   bounty, which is acceptable for a 3-minute epoch. Every entry point is
   defensive — malformed arguments are a safe no-op.
   ============================================================================ */

import { hash, WORLDS, TABLE } from './game/rules.js';
import { MKT_MS } from './game/economy.js';

/* ---- clocks -------------------------------------------------------------- */
const HOUR = MKT_MS * 20;            // 20 market epochs = 60 minutes
const DERBY_MS = 10 * 60 * 1000;     // the derby window: minutes 0-10
const DERBY_PEARLS = 150;            // champion's prize, per world

const derbyId = (now) => Math.floor(now / HOUR);

/* Own-property test — a plain WORLDS[k] answers truthily for '__proto__'. */
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const worldOf = (k) => (typeof k === 'string' && has(WORLDS, k) ? WORLDS[k] : null);

/* ============================================================================
   FISHING DERBY
   ============================================================================ */

/* derbyId -> Map(world -> Map(String(userId) -> {userId, username, kg})) */
const derbies = new Map();

/* Optional durability. Null means "behave like a pure module" — no store call
   is ever made, and every function below keeps its old signature and result.
   A store that throws must never cost a player their catch, so every call
   through it is wrapped: the tally in memory is what scoring trusts. */
let store = null;

const tell = (method, ...args) => {
  if (!store || typeof store[method] !== 'function') return undefined;
  try { return store[method](...args); } catch (err) {
    if (typeof store.onError === 'function') { try { store.onError(method, err); } catch { /* last resort */ } }
    return undefined;
  }
};

/**
 * Attach (or with null, detach) the persistence adapter. Called once at boot,
 * before the first catch is reported. Replays whatever the store still holds
 * for derbies that have not settled, so a restart in the middle of a race
 * resumes it with every kilogram intact rather than from zero.
 *
 * The adapter is duck-typed on purpose — the tests hand it a plain object.
 */
export function setDerbyStore(next) {
  store = next && typeof next === 'object' ? next : null;
  if (!store) return 0;

  const cur = derbyId(Date.now());
  const rows = tell('scoresFrom', cur) || [];
  let restored = 0;
  for (const row of rows) {
    if (!row) continue;
    const id = Math.floor(+row.derby_id);
    const kg = +row.kg;
    if (!Number.isFinite(id) || id < cur || !Number.isFinite(kg) || kg <= 0) continue;
    const w = String(row.world ?? '').slice(0, 32);
    if (!w || row.user_id == null) continue;

    let worlds = derbies.get(id);
    if (!worlds) derbies.set(id, (worlds = new Map()));
    let users = worlds.get(w);
    if (!users) worlds.set(w, (users = new Map()));
    users.set(String(row.user_id), {
      userId: row.user_id,
      username: typeof row.username === 'string' ? row.username : '',
      kg
    });
    restored++;
  }
  return restored;
}

/**
 * Where the derby clock stands. When a derby is running the answer carries
 * `endsAt`; otherwise `nextAt` points at the top of the next hour. Pure —
 * pass a timestamp to ask about any moment.
 */
export function derbyInfo(now = Date.now()) {
  const t = Number.isFinite(+now) ? +now : Date.now();
  const id = derbyId(t);
  const active = t % HOUR < DERBY_MS;
  return active
    ? { active: true, id, endsAt: id * HOUR + DERBY_MS }
    : { active: false, id, nextAt: (id + 1) * HOUR };
}

/**
 * Score one landed fish for the running derby. Silently ignored when no
 * derby is open — the caller reports every catch and never checks the clock.
 */
export function recordCatch(world, userId, username, kg) {
  const now = Date.now();
  if (now % HOUR >= DERBY_MS) return;                       // no derby open
  if (typeof world !== 'string' || !world || userId == null) return;
  const add = +kg;
  /* kg comes from the server's own rollFish (a legendary tops out ~160kg);
     the ceiling only stops a broken caller from poisoning the leaderboard */
  if (!Number.isFinite(add) || add <= 0 || add > 10000) return;

  const id = derbyId(now);
  let worlds = derbies.get(id);
  if (!worlds) derbies.set(id, (worlds = new Map()));
  const w = world.slice(0, 32);
  let users = worlds.get(w);
  if (!users) worlds.set(w, (users = new Map()));

  const key = String(userId);
  let rec = users.get(key);
  if (!rec) users.set(key, (rec = { userId, username: '', kg: 0 }));
  rec.kg += add;
  rec.username = typeof username === 'string' ? username.slice(0, 40) : String(username ?? '');
  tell('bump', id, w, userId, rec.username, add);
}

/* Tie-break: the smaller userId wins. Ids are numeric in the db, but compare
   lexically when either side refuses to be a number. */
function lesserId(a, b) {
  const na = +a, nb = +b;
  if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb;
  return String(a) < String(b);
}

/**
 * Settle every derby whose window has closed: one champion per world
 * (highest total kg, ties to the smallest userId), each handed to
 * `payout({userId, username, world, kg, pearls})` exactly once. Entries are
 * dropped after the attempt — a payout that throws is not retried, because a
 * partial write followed by a retry could pay twice. Without a usable
 * `payout` nothing is settled, but derbies older than two hours are still
 * pruned so the map cannot grow unbounded.
 */
export function sweepDerbies(payout) {
  const now = Date.now();
  const cur = derbyId(now);
  const fn = typeof payout === 'function' ? payout : null;

  for (const [id, worlds] of derbies) {
    const ended = id < cur || (id === cur && now % HOUR >= DERBY_MS);
    if (!ended) continue;
    if (!fn) {                                   // retention only: > 2 hours old
      if (id <= cur - 2) derbies.delete(id);
      continue;
    }
    for (const [world, users] of worlds) {
      let best = null;
      for (const rec of users.values()) {
        if (!best || rec.kg > best.kg || (rec.kg === best.kg && lesserId(rec.userId, best.userId))) {
          best = rec;
        }
      }
      if (!best || !(best.kg > 0)) continue;

      /* Claim the settlement BEFORE paying it. crown() is INSERT OR IGNORE, so
         it answers false when this derby+world was already crowned — by an
         earlier sweep, or by the process that died before this one booted.
         Ordered this way a crash between the two loses a payout; the other
         order pays it twice, and the module has always preferred the former. */
      if (store && tell('crown', {
        derbyId: id, world, userId: best.userId,
        username: best.username, kg: +best.kg.toFixed(1), pearls: DERBY_PEARLS
      }) === false) continue;

      try {
        fn({
          userId: best.userId,
          username: best.username,
          world,
          kg: +best.kg.toFixed(1),
          pearls: DERBY_PEARLS
        });
      } catch { /* settled once, win or lose — see the docblock */ }
    }
    derbies.delete(id);
    tell('clearScores', id);
  }
}

/* ============================================================================
   WANTED FISH
   ============================================================================ */

/* Salt folded into every world's seed before it meets hash(). Frozen: change
   it and every client disagrees with the server about the current bounty. */
const WANTED_SALT = 8887;

/**
 * The bounty species for a world at a market epoch — a pure function, so the
 * client can render the poster and the server can settle the claim without a
 * price feed. Pool: the world's own table (TABLE for an unknown world),
 * uncommon/rare/epic only, condition-gated species excluded — the target
 * must be catchable all epoch, not only at night. Null when the arguments
 * are unusable or the pool is somehow empty.
 */
export function wantedFor(world, epoch) {
  const e = Math.floor(+epoch);
  if (!Number.isFinite(e)) return null;

  const w = worldOf(world);
  const table = w && Array.isArray(w.fish) && w.fish.length ? w.fish : TABLE;
  const pool = [];
  for (const entry of table) {
    if (!entry || !entry[0] || entry[2]) continue;          // cond-gated: skip
    const r = entry[0].rar;
    if (r === 'uncommon' || r === 'rare' || r === 'epic') pool.push(entry[0]);
  }
  if (!pool.length) return null;

  const seed = (w && Number.isFinite(w.seed) ? w.seed : 0) + WANTED_SALT;
  const f = pool[Math.floor(hash(e, seed) * pool.length) % pool.length];
  return { name: f.name, bounty: Math.max(200, (f.val | 0) * 3) };
}

/* epoch -> Set(world) of already-paid bounties. Two epochs of retention. */
const wantedClaims = new Map();

/* The server's fish carry a '✦ ' shiny prefix (legacy saves: '✨ ') — the
   poster names the plain species, so strip the prefix before comparing. */
const plainName = (n) => (typeof n === 'string' ? n.replace(/^[✦✨]\s*/u, '') : '');

/**
 * Claim the bounty on a caught fish. Returns the bounty in coins, or 0 when
 * the fish is not the wanted species, the bounty was already claimed for
 * that world+epoch, or the epoch is not the live one (the previous epoch
 * gets a grace window for catches landed on the boundary). First come,
 * first served — per world, per epoch, regardless of who claims.
 */
export function tryClaimWanted(world, epoch, userId, fishName) {
  const e = Math.floor(+epoch);
  if (!Number.isFinite(e)) return 0;
  const cur = Math.floor(Date.now() / MKT_MS);
  if (e > cur || e < cur - 1) return 0;                     // live or grace only

  const wanted = wantedFor(world, e);
  if (!wanted || plainName(fishName) !== wanted.name) return 0;

  const key = typeof world === 'string' ? world.slice(0, 32) : String(world);
  let set = wantedClaims.get(e);
  if (set && set.has(key)) return 0;                        // already claimed
  if (!set) wantedClaims.set(e, (set = new Set()));
  set.add(key);

  /* retention: keep the live epoch and the grace epoch, drop the rest */
  for (const old of wantedClaims.keys()) if (old < cur - 1) wantedClaims.delete(old);
  return wanted.bounty;
}
