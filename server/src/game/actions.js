/* ============================================================================
   actions.js — the authoritative intent handlers.

   The client never computes an outcome; it sends an INTENT ("I finished
   reeling", "sell slot 3", "spin on red") and this module decides what
   actually happened. Every roll, price and payout is drawn HERE.

   Contract, per handler:
       (state, body) -> { ok: true, result: {...} }
                     |  { ok: false, error: 'human-readable reason' }
   Handlers MUTATE `state` in place; the caller persists it and ships the new
   state back to the client. A handler that returns `ok:false` must not have
   changed anything the player can notice.

   RESULT SHAPE — the client reads these fields by name, so they are part of
   the wire contract. Every successful result carries:
       message : a short, display-ready line for a toast
   plus, per action:
       sell   -> { gained, kept? }        coins that landed in the purse
       stock  -> { gained }               on 'sell'; 'buy' needs only message
       craft  -> { name, level }          the tool that came off the bench
       mine   -> { type, got, pearls, share? }   type is decided by the SERVER
       chop   -> { got, pearls, share? }
       dig    -> { coins?, ... }          coins only when coins were paid
       spin   -> { winIdx, color, won, payout }
       catch  -> { fish, pearls, isNew, isRec, share?, treasure?, auto? }
       travel -> { unlocked:true } when buying a charter; absent when sailing
       boat   -> { name, level }
   `share` is the bare ticker string the client toasts, never an object.

   Nothing in `body` is ever trusted for value: indices are range-checked,
   prices are recomputed from economy.js, and stake amounts must match the
   fixed ladder. The only client-supplied facts we accept are the ambient ones
   the server has no view of (night / weather) and the ID of the thing being
   worked (which ore node, which tree) — and those can only shift WHICH table
   is rolled, never how much anything is worth.

   Ported 1:1 from game.js; the line references below point at the original.
   ESM, Node 18+. No express, no db — pure state transitions.
   ============================================================================ */

import { randomInt } from 'node:crypto';

import {
  RORDER, ORE_INFO, ORE_KEYS, PEARL_ORE,
  MAXLVL, WORLDS, WORLD_ORDER,
  ROD_BASE, PICK_BASE, AXE_BASE, UP_REQ, AXE_REQ,
  ROD_NAMES, PICK_NAMES, AXE_NAMES,
  BAITS, BAIT_ORDER, BAIT_MAX, baitOf,
  BOATS, BOAT_REQ, MAX_BOAT, haveOres,
  upCost, axeCost,
  cap, rollFish, pearlsForFish, dexNameOf, AUTO, RIGS, MAX_RIG, rigOf,
  rollOreType, oreTypeFor,
  rand, clamp
} from './rules.js';
/* realtime.js never imports this module, so this stays a one-way dependency */
import { nodes as sharedNodes } from '../realtime.js';

import {
  STOCK_KEYS, STOCK_CAP,
  mktEpochNow, mktModsAt, priceMult,
  stockPrice, stockAsk, stockBid,
  grantShare
} from './economy.js';

/* ============================================================================
   RATE — minimum milliseconds between two accepted calls of the same action.
   Enforced by the route layer via actions.last()/mark(); it is the ceiling on
   how fast a scripted client can farm, so these track the real interaction
   times in game.js (a mining hold is ~1.7s at Lv.1, a spin animation 4.4s).
   ============================================================================ */
export const RATE = {
  catch: 2500,
  mine: 500,
  chop: 500,
  dig: 1200,
  sell: 250,
  craft: 400,
  bait: 400,
  stock: 400,
  kiosk: 400,
  spin: 1500,
  travel: 2000,
  boat: 1000
};

/* ============================================================================
   Local constants the client owns but rules.js/economy.js do not export.
   ============================================================================ */

/* Roulette wheel (game.js:508) — pocket 0 is the green jackpot, then the ring
   alternates red/black. 15 pockets: 7 red, 7 black, 1 green. */
const NSEG = 15;
const SEG = (() => {
  const s = ['green'];
  for (let i = 1; i < NSEG; i++) s[i] = i % 2 === 1 ? 'red' : 'black';
  return s;
})();
/* Must mirror game.js betWins()/betPay()/COIN_STAKES exactly, or the outside
   bets the table renders would all bounce off the server with a 400. */
const BET_KINDS = new Set(['red', 'black', 'green', 'odd', 'even', 'high']);
const COIN_STAKES = [50, 250, 1000, 5000];
function betWins(bet, idx) {
  const col = SEG[idx];
  if (bet === 'red' || bet === 'black' || bet === 'green') return col === bet;
  if (idx === 0) return false;                 // the green zero eats every outside bet
  if (bet === 'odd') return idx % 2 === 1;
  if (bet === 'even') return idx % 2 === 0;
  if (bet === 'high') return idx >= 8;
  return false;
}
const GREEN_MULT = 14, COLOR_MULT = 2;        // game.js:2354
const betPay = (bet) => (bet === 'green' ? GREEN_MULT : COLOR_MULT);
/* The Lucky Charm re-rolls ONE losing spin in five (game.js:2412). It nudges
   the odds; it does not rig them — the second pocket can lose again. */
const CHARM_REROLL_IN = 5;

/* Pearl kiosk (game.js:1806-1842) — every price here is PEARLS, never coins. */
const BUCKET_COST = [150, 300, 600, 1000];    // game.js:1807
const MAX_BUCKET_TIER = BUCKET_COST.length;   // tier 4 == MAX
const WARDROBE_COST = 80, CHUM_COST = 80, TIP_COST = 30;
const PET_COST = 400, CHARM_COST = 600;       // game.js:2030-2032
const CHUM_MS = 600000;                       // 10 minutes (game.js:1891)
const KIOSK_TITLES = {                        // game.js:1820
  t1: { name: 'Deckhand',       cost: 50 },
  t2: { name: 'Pearl Diver',    cost: 150 },
  t3: { name: 'Eel Whisperer',  cost: 500 },
  t4: { name: 'Isle Legend',    cost: 2500 }
};
const W_SLOTS = ['band', 'scarf', 'vest'];    // game.js:1810
const W_COLORS = 8;                           // WPAL.length (game.js:1806)

/* Tool -> (state key, coin curve, ore ladder). game.js:1863-1871 */
const CRAFT_SPEC = {
  rod:  { key: 'rodLvl',  base: ROD_BASE,  reqs: UP_REQ,  names: ROD_NAMES },
  pick: { key: 'pickLvl', base: PICK_BASE, reqs: UP_REQ,  names: PICK_NAMES },
  axe:  { key: 'axeLvl',  base: AXE_BASE,  reqs: AXE_REQ, names: AXE_NAMES }
};

/* Quarry: `wood` comes from the axe, not the pick. */
const MINE_TYPES = ['coal', 'iron', 'gold', 'diamond'];

/* Treasure maps are grid cells on the client's 96x96 heightmap (game.js:140).
   The server has no terrain, so it picks a cell and the client re-validates
   that the X actually landed on reachable land before it lets you dig. */
const GRID = 96;

/* Mining is the main source of share certificates ("mineral rights") — the
   per-level drop chance shared by gold and the common ores (game.js:2115). */
const oreShareChance = (pickLvl) => 0.06 + 0.015 * (pickLvl - 1);

/* Dig loot table (game.js:2174). Coal twice = double weight. */
const DIG_ORES = ['coal', 'coal', 'iron', 'gold', 'diamond'];

/* ============================================================================
   Small helpers
   ============================================================================ */

const ok = (result) => ({ ok: true, result });
const err = (error) => ({ ok: false, error });

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const int0 = (v) => Math.max(0, Math.floor(num(v, 0)));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const randCell = () => randomInt(0, GRID);

/* Own-property test. Every lookup keyed by a CLIENT-supplied string goes
   through this: a plain `TABLE[body.item]` answers truthily for '__proto__',
   'constructor' and 'toString', which is enough to walk a bogus id past an
   `if (TABLE[id])` gate. */
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Integer from an untrusted body field, or `null` when it is not one. */
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = +v;
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** The world record for `state`, falling back to the starting isle. */
const worldOf = (state) => WORLDS[state.world] || WORLDS.isle;

/** Display name for an ore key, without trusting the key to exist. */
const oreName = (k) => (has(ORE_INFO, k) ? ORE_INFO[k].name : String(k));

/** The first ingredient of `req` the player is short of, or null. */
function shortOre(ores, req) {
  for (const k in req) if ((ores?.[k] | 0) < req[k]) return k;
  return null;
}

/**
 * Put a share drop on a result in the shape the client renders: a bare ticker
 * string it can toast ("+1 share REEL"), plus the price it fetched when the
 * portfolio was full and economy.js liquidated the certificate instead.
 */
function attachShare(result, share) {
  if (!share) return result;
  result.share = share.ticker;
  if (share.soldFor != null) result.shareSoldFor = share.soldFor;
  return result;
}

/**
 * Ambient weather out of an untrusted body, in the { wet, storm } shape that
 * envOf() in rules.js reads.
 *
 * The client sends `wet` as the weather STATE ('clear' | 'rain' | 'storm' |
 * 'snow' | 'ash'); older builds sent a bare boolean, so both are accepted.
 * Collapsing it into one boolean is what kept every storm-gated species
 * (Thunder Eel, Storm Marlin, Blizzard Eel, ...) permanently unspawnable:
 * envOf only sees a storm through an explicit `storm` flag or the literal
 * string 'storm'. Snow and ash are weather of their own — they are NOT rain,
 * and the client's condOK() agrees (game.js:1713).
 */
function weatherOf(body) {
  const w = body.wet;
  const storm = !!body.storm || (typeof w === 'string' && w.trim().toLowerCase() === 'storm');
  if (typeof w === 'string') return { wet: storm || w.trim().toLowerCase() === 'rain', storm };
  return { wet: storm || !!w, storm };
}

/**
 * Defensive top-up for a state that skipped normalizeState() (a legacy row, a
 * hand-written test fixture). Never rewrites a valid field — it only fills in
 * containers so a handler can `+=` without exploding halfway through a
 * mutation and leaving the save torn.
 */
function ensure(state) {
  if (!Number.isFinite(state.coins)) state.coins = 0;
  if (!Array.isArray(state.bucket)) state.bucket = [];
  if (!state.ores || typeof state.ores !== 'object') state.ores = {};
  for (const k of ORE_KEYS) state.ores[k] = int0(state.ores[k]);
  if (!state.dex || typeof state.dex !== 'object') state.dex = {};

  if (!state.stats || typeof state.stats !== 'object') state.stats = {};
  for (const k of ['caught', 'mined', 'earned', 'bestWin', 'spins', 'winsCt', 'losses', 'divEarned', 'wood']) {
    state.stats[k] = int0(state.stats[k]);
  }

  if (!state.stocks || typeof state.stocks !== 'object') state.stocks = {};
  const sk = state.stocks;
  if (!sk.own || typeof sk.own !== 'object') sk.own = {};
  if (!sk.basis || typeof sk.basis !== 'object') sk.basis = {};
  for (const k of STOCK_KEYS) sk.own[k] = clamp(int0(sk.own[k]), 0, STOCK_CAP);
  if (!('lastDiv' in sk)) sk.lastDiv = null;
  sk.lastShareEpoch = int0(sk.lastShareEpoch);
  sk.gotFirst = sk.gotFirst ? 1 : 0;

  if (!Array.isArray(state.worlds) || !state.worlds.length) state.worlds = ['isle'];
  if (!WORLDS[state.world]) state.world = state.worlds.find((k) => WORLDS[k]) || 'isle';

  state.rodLvl = clamp(int0(state.rodLvl) || 1, 1, MAXLVL);
  state.pickLvl = clamp(int0(state.pickLvl) || 1, 1, MAXLVL);
  state.axeLvl = clamp(int0(state.axeLvl) || 1, 1, MAXLVL);
  /* the fleet starts on a raft at level 0, so this one is NOT `|| 1` */
  state.boatLvl = clamp(int0(state.boatLvl), 0, MAX_BOAT);
  state.pearls = int0(state.pearls);
  state.pearlsLife = int0(state.pearlsLife);
  state.bucketTier = clamp(int0(state.bucketTier), 0, MAX_BUCKET_TIER);
  state.tipEpoch = int0(state.tipEpoch);
  /* one-off Pearl Kiosk unlocks: flags, never counters, so an older save reads 0 */
  state.pet = state.pet ? 1 : 0;
  state.charm = state.charm ? 1 : 0;

  if (!state.bait || typeof state.bait !== 'object') state.bait = {};
  for (const k of BAIT_ORDER) {
    const n = clamp(int0(state.bait[k]), 0, BAIT_MAX);
    if (n > 0) state.bait[k] = n; else delete state.bait[k];
  }
  /* an equipped bait you have none of is the same as no bait at all */
  if (typeof state.baitId !== 'string' || !(state.bait[state.baitId] > 0)) state.baitId = '';

  if (!state.boosts || typeof state.boosts !== 'object') state.boosts = { chumUntil: 0 };
  state.boosts.chumUntil = int0(state.boosts.chumUntil);
  if (!state.wardrobe || typeof state.wardrobe !== 'object') state.wardrobe = {};
  if (!state.ownedW || typeof state.ownedW !== 'object') state.ownedW = {};
  if (!state.ownedT || typeof state.ownedT !== 'object') state.ownedT = {};
  if (typeof state.titleId !== 'string') state.titleId = '';
  if (state.treasure && (state.treasure.i == null || state.treasure.j == null)) state.treasure = null;
  return state;
}

/**
 * Wrap a handler body with input guards. A thrown error becomes a clean
 * `ok:false` rather than a 500 — the route layer only has to persist when
 * `ok` is true, so a crash mid-mutation is discarded with the response.
 */
function handler(fn) {
  return (state, body) => {
    if (!state || typeof state !== 'object') return err('No save loaded');
    try {
      ensure(state);
      return fn(state, body && typeof body === 'object' ? body : {});
    } catch (e) {
      return err('Action failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  };
}

/** Pearls are flat activity points — earned only, never bought or converted. */
function addPearls(state, n) {
  const v = int0(n);
  if (!v) return 0;
  state.pearls += v;
  state.pearlsLife += v;
  return v;
}

/**
 * Award a share certificate. economy.js owns the pity-cap (one dropped share
 * per market epoch) and the portfolio-full auto-sale, so we just report what
 * it decided. Returns a result-shaped object, or null when nothing dropped.
 */
function tryShare(state, ticker) {
  if (!STOCK_KEYS.includes(ticker)) return null;
  const g = grantShare(state, ticker);
  if (!g || !g.granted) return null;
  return g.soldFor != null ? { ticker, soldFor: g.soldFor } : { ticker };
}

/**
 * Roll one fish for the world the player is standing in, with whatever is on
 * the hook. `useBait: false` for a fish that was not caught on a line at all
 * (the buried one in a treasure chest) — no hook, no bait bonus, no bait spent.
 * `auto: true` swaps in the lazy line's crushed table (rules.js AUTO).
 */
function rollFor(state, body, { useBait: withBait = true, auto = false } = {}) {
  const { wet, storm } = weatherOf(body);
  return rollFish({
    world: state.world,
    rodLvl: state.rodLvl,
    bait: withBait ? state.baitId : null,
    boatLvl: state.boatLvl,
    fishMul: worldOf(state).fishMul,
    night: !!body.night,
    wet,
    storm,
    auto,
    rigLvl: state.rigLvl
  });
}

/**
 * Spend one of the equipped bait. Called only once a fish is actually in the
 * bucket — a snapped line costs the player nothing. Returns what the client
 * needs to narrate it, or null when no bait was on the hook.
 */
function useBait(state) {
  const id = state.baitId;
  const b = baitOf(id);
  if (!b || !(state.bait[id] > 0)) return null;
  const left = state.bait[id] - 1;
  if (left > 0) state.bait[id] = left;
  else { delete state.bait[id]; state.baitId = ''; }
  return { id, name: b.name, left, out: left === 0 };
}

/**
 * The client's onCatch() (game.js:1568): bucket, Fishdex, pearls, and the two
 * things a catch can also snag — a Reel Fisheries share and a bottled map.
 * Shared by `catch` and by `dig`'s buried-fish branch.
 */
function landFish(state, fish, { allowMap = true, auto = false } = {}) {
  state.stats.caught++;
  state.bucket.push(fish);

  const key = dexNameOf(fish);
  if (!has(state.dex, key) || !state.dex[key] || typeof state.dex[key] !== 'object') {
    state.dex[key] = { n: 0, best: 0 };
  }
  const d = state.dex[key];
  d.n = int0(d.n) + 1;
  const isNew = d.n === 1;

  const kg = num(fish.kg, 0);
  let isRec = false;
  if (kg > num(d.best, 0)) { d.best = kg; isRec = true; }

  const pearls = addPearls(state, pearlsForFish(fish, { isNew, isRecord: isRec, auto }));

  /* epic+ catches can come with a Reel Fisheries share certificate */
  let share = null;
  if ((RORDER[fish.rar] | 0) >= 3 && Math.random() < 0.05) share = tryShare(state, 'REEL');

  /* rare chance the catch also snags a bottled treasure map. The client owns
     the heightmap, so it re-checks that (i,j) is diggable land before showing
     the X; an unreachable cell simply never gets dug. */
  let treasure = null;
  if (allowMap && !state.treasure && Math.random() < 0.08) {
    state.treasure = { i: randCell(), j: randCell(), w: state.world };
    treasure = { ...state.treasure };
  }

  return { isNew, isRec, pearls, share, treasure };
}

/* ============================================================================
   HANDLERS
   ============================================================================ */
export const HANDLERS = {

  /* --------------------------------------------------------------------------
     catch — the client reports that the reel minigame finished; the SERVER
     decides what was on the hook. body: { night, wet, storm? }
     `wet` is the client's weather state ('clear'|'rain'|'storm'|'snow'|'ash');
     a bare boolean from an older build still reads as rain.
     -------------------------------------------------------------------------- */
  catch: handler((state, body) => {
    const limit = cap(state);
    if (state.bucket.length >= limit) {
      return err(`Bucket is full (${limit}) · sell your catch at the Trader first`);
    }

    /* `auto` is the one fact in `body` a client may assert about itself, and
       asserting it can only ever make the catch worse — the lazy line rolls a
       crushed table, spends no bait, and bottles no maps. It also carries its
       own cadence floor ON TOP of RATE.catch, so alternating held-rod and auto
       casts cannot be used to fish faster than a held rod alone. */
    const auto = !!body.auto;
    const now = Date.now();
    if (auto) {
      const gap = rigOf(state.rigLvl).gapMs;
      const last = num(state.autoAt, 0);
      if (last > now) state.autoAt = 0;            // clock skew / hand-edited save
      else if (last > 0 && now - last < gap) {
        return err('The rig is still resetting the line…');
      }
    }

    const fish = rollFor(state, body, { useBait: !auto, auto });
    if (!fish) return err('Nothing is biting here');

    if (auto) state.autoAt = now;
    /* no bottled maps off an unattended rig: the map roll is flat 8% per catch
       and is the one drop the crushed rarity table does not already gate */
    const { isNew, isRec, pearls, share, treasure } =
      landFish(state, fish, { allowMap: !auto, auto });
    /* spent AFTER the fish is banked, so a rejected catch never eats a bait */
    const bait = auto ? null : useBait(state);

    const result = { fish, pearls, isNew, isRec, bucket: state.bucket.length, cap: limit,
      message: `Landed ${fish.name} · ◈${fish.val}` };
    if (auto) result.auto = true;
    attachShare(result, share);
    if (treasure) result.treasure = treasure;
    if (bait) result.bait = bait;
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     mine — one completed pick swing on an ore node. body: { node }
     game.js:2109-2118
     -------------------------------------------------------------------------- */
  mine: handler((state, body) => {
    /* The client may NOT choose what it digs up. A node's ore is a pure function
       of (world, node id), so the server derives it and every client agrees —
       otherwise a script would simply mine diamond (70c) every time instead of
       coal (5c). `body.type` is never read at all; an older client that sends
       no node id gets a blind roll on the same odds instead. */
    /* The id must be one the client could actually have: 0 .. quarry+3 (the four
       grass starters sit past the quarry count). Without this a negative id slips
       past the starter-node gate — opening the full table on a coal-only isle —
       and past realtime's id check, so the vein never records as depleted:
       unlimited diamonds at the rate limit. */
    const rawId = body.node;
    const nodeMax = (worldOf(state).oreN | 0) + 4;
    const idNum = +rawId;
    const hasId = rawId !== undefined && rawId !== null
      && Number.isInteger(idNum) && idNum >= 0 && idNum < nodeMax;
    if (rawId !== undefined && rawId !== null && !hasId) return err('No such ore node');
    const type = hasId ? oreTypeFor(state.world, idNum) : rollOreType();
    if (!MINE_TYPES.includes(type)) {
      return err(`Unknown ore node · expected one of ${MINE_TYPES.join(', ')}`);
    }
    /* shared world: a vein someone already stripped stays stripped for everyone */
    if (hasId && sharedNodes.isDown(state.world, 'node', idNum)) {
      return err('that vein is already stripped');
    }

    const lvl = state.pickLvl;
    const bonus = Math.random() < Math.min(0.85, 0.15 + 0.08 * (lvl - 1)) ? 1 : 0;
    const crit = lvl >= 6 && Math.random() < 0.2 ? 1 : 0;
    const yieldMul = Math.max(1, Math.floor(num(worldOf(state).oreYield, 1)));
    const got = (1 + bonus + crit) * yieldMul;

    state.ores[type] += got;
    state.stats.mined += got;
    const pearls = addPearls(state, PEARL_ORE[type] || 1);

    /* mineral rights: diamond always certificates, gold and the rest roll */
    const chance = oreShareChance(lvl);
    let share = null;
    if (type === 'diamond') share = tryShare(state, pick(STOCK_KEYS));
    else if (type === 'gold') {
      if (Math.random() < chance) share = tryShare(state, Math.random() < 0.5 ? 'HARB' : 'EEL');
    } else if (Math.random() < chance) share = tryShare(state, 'DIGG');

    if (hasId) sharedNodes.deplete(state.world, 'node', idNum, Date.now() + 45000);

    const result = { type, got, pearls, ores: state.ores[type],
      message: `+${got} ${oreName(type)}` };
    attachShare(result, share);
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     chop — one completed axe swing on a tree. game.js:2142-2145
     -------------------------------------------------------------------------- */
  chop: handler((state, body) => {
    const rawTree = body && body.tree;
    const treeNum = +rawTree;
    const treeMax = (worldOf(state).treeMax | 0) || 200;   // client caps tree count per world
    const hasTree = rawTree !== undefined && rawTree !== null
      && Number.isInteger(treeNum) && treeNum >= 0 && treeNum < treeMax;
    if (rawTree !== undefined && rawTree !== null && !hasTree) return err('No such tree');
    if (hasTree && sharedNodes.isDown(state.world, 'tree', treeNum)) {
      return err('someone already felled that tree');
    }
    const lvl = state.axeLvl;
    const got = 1
      + (Math.random() < Math.min(0.85, 0.35 + 0.08 * (lvl - 1)) ? 1 : 0)
      + (lvl >= 6 && Math.random() < 0.2 ? 1 : 0);

    state.ores.wood += got;
    state.stats.mined += got;
    state.stats.wood = (state.stats.wood | 0) + got;   // wood bounties read this
    const pearls = addPearls(state, 1);

    const share = Math.random() < 0.04 ? tryShare(state, 'LUMB') : null;

    if (hasTree) sharedNodes.deplete(state.world, 'tree', treeNum, Date.now() + 35000);

    const result = { got, pearls, ores: state.ores.wood, message: `+${got} Wood` };
    attachShare(result, share);
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     dig — spend the treasure map. game.js:2168-2178
     The map is consumed FIRST: whatever the loot roll does, the X is gone, so
     a client that replays the intent gets "no map" rather than a second prize.
     -------------------------------------------------------------------------- */
  dig: handler((state, body) => {
    if (!state.treasure) return err('You have no treasure map');

    const spot = { ...state.treasure };
    state.treasure = null;
    let pearls = addPearls(state, 10);

    const result = { spot, pearls, message: '' };
    const r = Math.random();

    if (r < 0.55) {
      const g = Math.round(rand(150, 600) * (1 + 0.12 * (state.rodLvl + state.pickLvl)));
      state.coins += g;
      state.stats.earned += g;
      result.kind = 'coins';
      result.coins = g;
      result.message = `Buried treasure! +${g} coins`;
      return ok(result);
    }

    if (r < 0.85) {
      const k = pick(DIG_ORES);
      const n = 2 + ((Math.random() * 4) | 0);   // 2..5
      state.ores[k] += n;
      state.stats.mined += n;
      result.kind = 'ore';
      result.ore = k;
      result.amount = n;
      result.message = `Treasure! +${n} ${oreName(k)}`;
      return ok(result);
    }

    /* a rare fish was buried here — only if there is room to hold it */
    if (state.bucket.length < cap(state)) {
      let fish = null;
      for (let i = 0; i < 25; i++) {
        const f = rollFor(state, body, { useBait: false });
        if (!f) break;
        fish = f;
        if ((RORDER[f.rar] | 0) >= 2) break;    // rare+ or give up after 25
      }
      if (fish) {
        /* no fresh map from a chest — one treasure at a time */
        const land = landFish(state, fish, { allowMap: false });
        pearls += land.pearls;
        result.kind = 'fish';
        result.fish = fish;
        result.pearls = pearls;
        result.isNew = land.isNew;
        result.isRec = land.isRec;
        result.message = `A rare fish was buried here?! ${fish.name}`;
        attachShare(result, land.share);
        return ok(result);
      }
    }

    /* bucket full (or the pool was empty): the chest pays a consolation purse */
    const g = 300;
    state.coins += g;
    state.stats.earned += g;
    result.kind = 'coins';
    result.coins = g;
    result.message = `The chest held ◈${g}`;
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     sell — the Trader. body: { kind:'fish'|'ore'|'allfish', index?, oreKey? }
     Prices come from priceMult() on the CURRENT market epoch; the client's
     displayed number is a preview, this is the settlement. game.js:1848-1860
     -------------------------------------------------------------------------- */
  sell: handler((state, body) => {
    const kind = String(body.kind || '');

    if (kind === 'fish') {
      const i = intOrNull(body.index);
      if (i === null || i < 0 || i >= state.bucket.length || !state.bucket[i]) {
        return err('No such fish in your bucket');
      }
      const fish = state.bucket[i];
      const coins = Math.round(Math.max(0, num(fish.val, 0)) * priceMult('fish'));
      state.bucket.splice(i, 1);
      state.coins += coins;
      state.stats.earned += coins;
      return ok({ kind, coins, gained: coins, sold: 1, fish, bucket: state.bucket.length,
        message: `+${coins} coins` });
    }

    if (kind === 'ore') {
      const k = String(body.oreKey || '');
      if (!ORE_KEYS.includes(k)) return err('Unknown ore');
      const n = state.ores[k] | 0;
      if (n <= 0) return err(`You have no ${ORE_INFO[k].name}`);
      const coins = Math.round(n * ORE_INFO[k].price * priceMult(k));
      state.ores[k] = 0;
      state.coins += coins;
      state.stats.earned += coins;
      return ok({ kind, oreKey: k, amount: n, coins, gained: coins,
        message: `+${coins} coins` });
    }

    if (kind === 'allfish') {
      if (!state.bucket.length) return err('Bucket empty');
      const pm = priceMult('fish');
      let coins = 0, sold = 0, kept = 0;
      /* ★ starred fish (a roulette win rides on them) are never bulk-sold */
      state.bucket = state.bucket.filter((f) => {
        if (!f || typeof f !== 'object') return false;
        if ((f.wins | 0) > 0) { kept++; return true; }
        coins += Math.round(Math.max(0, num(f.val, 0)) * pm);
        sold++;
        return false;
      });
      if (!sold) {
        return err(kept ? 'Only ★ starred fish left · sell them one by one' : 'Bucket empty');
      }
      state.coins += coins;
      state.stats.earned += coins;
      return ok({ kind, coins, gained: coins, sold, kept, bucket: state.bucket.length,
        message: `+${coins} coins` + (kept ? ` (kept ${kept} ★)` : '') });
    }

    return err("Unknown sell kind · expected 'fish', 'ore' or 'allfish'");
  }),

  /* --------------------------------------------------------------------------
     craft — forge the next tool tier. body: { tool:'rod'|'pick'|'axe' }
     game.js:1863-1871
     -------------------------------------------------------------------------- */
  craft: handler((state, body) => {
    const tool = String(body.tool || '');
    if (!has(CRAFT_SPEC, tool)) return err("Unknown tool · expected 'rod', 'pick' or 'axe'");
    const spec = CRAFT_SPEC[tool];

    const lvl = state[spec.key];
    if (lvl >= MAXLVL) return err('That tool is already at max level');

    const cost = tool === 'axe' ? axeCost(lvl) : upCost(spec.base, lvl);
    const req = spec.reqs[lvl + 1] || {};

    if (state.coins < cost) return err(`Not enough coins · that costs ${cost}`);
    for (const k in req) {
      if ((state.ores[k] | 0) < req[k]) {
        const name = ORE_INFO[k] ? ORE_INFO[k].name : k;
        return err(`Not enough ${name} · you need ${req[k]}`);
      }
    }

    state.coins -= cost;
    for (const k in req) state.ores[k] -= req[k];
    state[spec.key] = lvl + 1;

    const newName = (spec.names && spec.names[lvl + 1]) || tool;
    return ok({ tool, level: lvl + 1, name: newName, cost, spent: { ...req },
      message: `${newName} crafted!` });
  }),

  /* --------------------------------------------------------------------------
     boat — the Harbor shipwright. Coins AND ore lay down the next hull, the
     same ledger the client's buyBoat() keeps (game.js:2313). The hull is what
     gates the long voyages (see `travel`) and the crew berths, so it is bought
     here rather than inferred from anything the client reports.
     -------------------------------------------------------------------------- */
  boat: handler((state) => {
    const level = state.boatLvl + 1;
    if (level > MAX_BOAT) return err('Your fleet is complete · there is nothing bigger to build');
    const b = BOATS[level];

    if (state.coins < b.cost) return err(`Not enough coins · the ${b.name} costs ${b.cost}`);
    if (!haveOres(state.ores, b.req)) {
      const k = shortOre(state.ores, b.req);
      return err(`Not enough ${oreName(k)} · the ${b.name} needs ${b.req[k]}`);
    }

    state.coins -= b.cost;
    for (const k in b.req) state.ores[k] -= b.req[k];
    state.boatLvl = level;

    return ok({ name: b.name, level, cost: b.cost, spent: { ...b.req }, seats: b.seats,
      message: `${b.name} launched!` });
  }),

  /* --------------------------------------------------------------------------
     stock — the Isle Exchange. body: { op:'buy'|'sell', ticker }
     One share per call, priced at the current epoch's ask/bid. game.js:1876-1886
     -------------------------------------------------------------------------- */
  stock: handler((state, body) => {
    const op = String(body.op || '');
    const k = String(body.ticker || '');
    if (!STOCK_KEYS.includes(k)) return err(`Unknown ticker · expected one of ${STOCK_KEYS.join(', ')}`);

    const e = mktEpochNow();
    const sk = state.stocks;
    const own = sk.own[k] | 0;

    if (op === 'buy') {
      if (own >= STOCK_CAP) return err(`Position capped · you already hold ${STOCK_CAP} ${k}`);
      const ask = stockAsk(k, e);
      if (state.coins < ask) return err(`Not enough coins · ${k} is asking ${ask}`);

      state.coins -= ask;
      /* basis tracks the mid price, not the ask: the spread is the fee you paid */
      const p = stockPrice(k, e);
      sk.basis[k] = (num(sk.basis[k], p) * own + p) / (own + 1);
      sk.own[k] = own + 1;

      return ok({ op, ticker: k, price: ask, own: sk.own[k], basis: sk.basis[k], epoch: e,
        message: `Bought 1 ${k} for ◈${ask}` });
    }

    if (op === 'sell') {
      if (own <= 0) return err(`You own no ${k}`);
      const bid = stockBid(k, e);
      sk.own[k] = own - 1;
      state.coins += bid;
      /* only REAL profit counts toward lifetime earnings — selling at a loss
         must not inflate the stat, and round-tripping must not print money */
      const profit = Math.max(0, bid - Math.round(num(sk.basis[k], bid)));
      state.stats.earned += profit;

      return ok({ op, ticker: k, price: bid, own: sk.own[k], profit, epoch: e,
        gained: bid, message: `Sold 1 ${k} for ◈${bid}` });
    }

    return err("Unknown stock op · expected 'buy' or 'sell'");
  }),

  /* --------------------------------------------------------------------------
     kiosk — the Pearl Kiosk. Everything here is bought with PEARLS.
     body: { item:'wardrobe'|'chum'|'bucket'|'tip'|'t1'..'t4'|'wcolor', slot?, color? }
     game.js:1888-1903
     -------------------------------------------------------------------------- */
  /* --------------------------------------------------------------------------
     bait — the Bait Shack. body: { op: 'buy'|'equip', id, packs }
       buy   : coins -> `packs` packs of `id` (BAITS[id].pack each)
       equip : put `id` on the hook; '' (or an id you are out of) bares it
     -------------------------------------------------------------------------- */
  bait: handler((state, body) => {
    const op = String(body.op || 'buy');
    const id = String(body.id || '');

    if (op === 'equip') {
      if (id === '') {
        state.baitId = '';
        return ok({ op, baitId: '', bait: state.bait, message: 'Bare hook' });
      }
      if (!baitOf(id)) return err('Unknown bait');
      if (!(state.bait[id] > 0)) return err(`You are out of ${BAITS[id].name}`);
      /* clicking the equipped bait again takes it back off the hook */
      state.baitId = state.baitId === id ? '' : id;
      return ok({ op, baitId: state.baitId, bait: state.bait,
        message: state.baitId ? `${BAITS[id].name} on the hook` : 'Bare hook' });
    }

    if (op !== 'buy') return err('Unknown bait action');
    const b = baitOf(id);
    if (!b) return err('Unknown bait');

    const packs = clamp(intOrNull(body.packs) ?? 1, 1, 20);
    const have = int0(state.bait[id]);
    /* buy only as many whole packs as the stack ceiling can still hold */
    const room = Math.max(0, BAIT_MAX - have);
    const fit = Math.min(packs, Math.floor(room / b.pack));
    if (fit < 1) return err(`You cannot carry any more ${b.name}`);

    const cost = b.cost * fit;
    if (state.coins < cost) return err(`Not enough coins · that costs ${cost}, you have ${state.coins}`);

    state.coins -= cost;
    state.bait[id] = have + b.pack * fit;
    if (!state.baitId) state.baitId = id;      // first bait you buy goes straight on the hook

    return ok({ op, id, name: b.name, packs: fit, count: b.pack * fit, cost,
                bait: state.bait, baitId: state.baitId, coins: state.coins,
                message: `+${b.pack * fit} ${b.name}` });
  }),

  kiosk: handler((state, body) => {
    const item = String(body.item || '');

    /* recolouring is free once the wardrobe is owned */
    if (item === 'wcolor') {
      if (!state.ownedW.wardrobe) return err('Buy the Hero Wardrobe first');
      const slot = String(body.slot || '');
      if (!W_SLOTS.includes(slot)) return err(`Unknown slot · expected one of ${W_SLOTS.join(', ')}`);
      const color = intOrNull(body.color);
      if (color === null || color < 0 || color >= W_COLORS) return err('Unknown wardrobe color');
      state.wardrobe[slot] = color;
      return ok({ item, slot, color, cost: 0, pearls: state.pearls, message: 'Colors updated' });
    }

    /* spend() only debits once every precondition above it has passed */
    const spend = (cost) => {
      if (state.pearls < cost) return false;
      state.pearls -= cost;
      return true;
    };
    const short = (cost) => err(`Not enough pearls · that costs ${cost}, you have ${state.pearls}`);

    if (item === 'wardrobe') {
      if (state.ownedW.wardrobe) return err('You already own the Hero Wardrobe');
      if (!spend(WARDROBE_COST)) return short(WARDROBE_COST);
      state.ownedW.wardrobe = 1;
      return ok({ item, cost: WARDROBE_COST, pearls: state.pearls,
        message: 'Wardrobe unlocked · pick your colors!' });
    }

    if (item === 'chum') {
      if (Date.now() < state.boosts.chumUntil) return err('There is already chum in the water');
      if (!spend(CHUM_COST)) return short(CHUM_COST);
      state.boosts.chumUntil = Date.now() + CHUM_MS;
      return ok({ item, cost: CHUM_COST, chumUntil: state.boosts.chumUntil, pearls: state.pearls,
        message: 'Chum in the water · bites 2× faster for 10 min' });
    }

    if (item === 'bucket') {
      if (state.bucketTier >= MAX_BUCKET_TIER) return err('Your Deep Bucket is already maxed');
      const cost = BUCKET_COST[state.bucketTier];
      if (!spend(cost)) return short(cost);
      state.bucketTier++;
      return ok({ item, cost, bucketTier: state.bucketTier, cap: cap(state), pearls: state.pearls,
        message: `Deep Bucket! Capacity is now ${cap(state)}` });
    }

    if (item === 'rig') {
      if (state.rigLvl >= MAX_RIG) return err('The Tidewatch Rig is the last one there is');
      const next = state.rigLvl + 1;
      const cost = RIGS[next].cost;
      if (!spend(cost)) return short(cost);
      state.rigLvl = next;
      const r = rigOf(next);
      return ok({ item, cost, rigLvl: next, pearls: state.pearls,
        message: `${r.name} · the rig works a line every ${(r.gapMs / 1000).toFixed(1)}s now` });
    }

    if (item === 'tip') {
      if (!spend(TIP_COST)) return short(TIP_COST);
      /* the tip reveals the NEXT rotation, so it is only worth its 30 pearls
         until that epoch actually arrives */
      const epoch = mktEpochNow() + 1;
      state.tipEpoch = epoch;
      const m = mktModsAt(epoch);
      return ok({ item, cost: TIP_COST, tipEpoch: epoch, hot: m.hot, cold: m.cold, pearls: state.pearls,
        message: `Tip: next HOT ${m.hot} · SURPLUS ${m.cold}` });
    }

    /* The Spirit Fish is pure cosmetics — the client draws the companion off
       `state.pet`. The Lucky Charm is not: `spin` reads `state.charm`. */
    if (item === 'pet') {
      if (state.pet) return err('A Spirit Fish already swims at your shoulder');
      if (!spend(PET_COST)) return short(PET_COST);
      state.pet = 1;
      return ok({ item, cost: PET_COST, pet: 1, pearls: state.pearls,
        message: 'A Spirit Fish drifts to your side…' });
    }

    if (item === 'charm') {
      if (state.charm) return err('The Lucky Charm is already on your belt');
      if (!spend(CHARM_COST)) return short(CHARM_COST);
      state.charm = 1;
      return ok({ item, cost: CHARM_COST, charm: 1, pearls: state.pearls,
        message: '🍀 Lucky Charm · the wheel likes you now' });
    }

    if (has(KIOSK_TITLES, item)) {
      const title = KIOSK_TITLES[item];
      /* already owned: this is an equip/unequip toggle, and it is free */
      if (has(state.ownedT, item) && state.ownedT[item]) {
        state.titleId = state.titleId === title.name ? '' : title.name;
        return ok({ item, cost: 0, titleId: state.titleId, owned: true, pearls: state.pearls,
          message: state.titleId ? `Title equipped: ${title.name}` : 'Title put away' });
      }
      if (!spend(title.cost)) return short(title.cost);
      state.ownedT[item] = 1;
      state.titleId = title.name;
      return ok({ item, cost: title.cost, titleId: state.titleId, owned: true, pearls: state.pearls,
        message: `Title equipped: ${title.name}` });
    }

    return err('Unknown kiosk item');
  }),

  /* --------------------------------------------------------------------------
     spin — the Spinning Eel roulette. body: { bet, stakeIdx?, coinStake? }

     THE most abuse-prone action in the game, so the wheel is drawn from
     crypto.randomInt: not seedable, not predictable from a previous result,
     and never sent to the client before it is settled. The client's wheel
     animation is decoration played back over `winIdx`.

     The stake is committed here too — coins leave the purse in the same call
     that decides the outcome, so there is no "close the tab on a loss" window.
     game.js:2006-2057
     -------------------------------------------------------------------------- */
  spin: handler((state, body) => {
    const bet = String(body.bet || '');
    if (!BET_KINDS.has(bet)) return err("Pick a bet · red, black, green, odd, even or high");

    const idxRaw = intOrNull(body.stakeIdx);
    const coinRaw = intOrNull(body.coinStake);
    const wantsFish = idxRaw !== null && idxRaw >= 0;
    const wantsCoins = coinRaw !== null && coinRaw > 0;
    if (wantsFish && wantsCoins) return err('Stake a fish or coins · not both');

    let fish = null, fishIdx = -1, stake = 0;

    if (wantsFish) {
      if (idxRaw >= state.bucket.length || !state.bucket[idxRaw]) {
        return err('No such fish in your bucket');
      }
      fishIdx = idxRaw;
      fish = state.bucket[fishIdx];
    } else if (wantsCoins) {
      /* the rod gates how large a chip the table will take (game.js betCap) —
         enforce it here too, or the gear requirement is pure decoration */
      const stakeCap = [250, 1000, 5000, 25000, 100000][clamp(Math.floor((state.rodLvl - 1) / 2), 0, 4)];
      if (coinRaw > stakeCap) {
        return err(`Your rod only covers a ${stakeCap} chip · upgrade it to bet bigger`);
      }
      if (!COIN_STAKES.includes(coinRaw)) {
        return err(`Coin stake must be one of ${COIN_STAKES.join(', ')}`);
      }
      stake = coinRaw;
      if (state.coins < stake) return err('Not enough coins for that stake');
      state.coins -= stake;                    // committed the moment the ball rolls
    } else {
      return err('Nothing staked · bet a fish or coins');
    }

    let winIdx = randomInt(0, NSEG);
    /* the Lucky Charm re-rolls a single losing spin in five — the second pocket
       is drawn just as blind as the first, so it can lose again */
    if (state.charm && !betWins(bet, winIdx) && randomInt(0, CHARM_REROLL_IN) === 0) {
      winIdx = randomInt(0, NSEG);
    }
    const color = SEG[winIdx];
    const won = betWins(bet, winIdx);

    state.stats.spins++;
    const result = { winIdx, color, bet, won, payout: 0, message: '' };

    if (!won) {
      state.stats.losses++;
      if (fish) {
        state.bucket.splice(fishIdx, 1);
        result.fish = fish;
        result.lost = fish.name;
        result.bucket = state.bucket.length;
        result.message = `the eel swallowed your ${fish.name}. Gone.`;
      } else {
        result.stake = stake;
        result.message = `the eel gulped your ◈${stake}.`;
      }
      result.payout = 0;
      return ok(result);
    }

    const mult = betPay(bet);
    state.stats.winsCt++;
    result.mult = mult;

    /* the jackpot pocket also pays out a meme-stock certificate */
    if (color === 'green') attachShare(result, tryShare(state, 'EEL'));

    if (fish) {
      const before = Math.max(0, Math.round(num(fish.val, 0)));
      fish.val = before * mult;
      fish.wins = (fish.wins | 0) + 1;         // ★ — excluded from Sell All
      state.stats.bestWin = Math.max(state.stats.bestWin, fish.val);
      result.fish = fish;
      result.before = before;
      result.payout = fish.val;
      result.message = `${fish.name} ◈${before} → ◈${fish.val}. Spin again or cash out.`;
    } else {
      const gain = stake * mult;
      state.coins += gain;
      state.stats.earned += gain - stake;      // net, so a 2× win isn't double-counted
      state.stats.bestWin = Math.max(state.stats.bestWin, gain);
      result.stake = stake;
      result.payout = gain;
      result.message = `◈${stake} → ◈${gain}!`;
    }

    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     travel — the Harbor. body: { world }
     Two distinct moves behind one intent: buying a charter for an isle you do
     not own yet, and sailing to one you do. game.js:1757-1766
     -------------------------------------------------------------------------- */
  travel: handler((state, body) => {
    const k = String(body.world || '');
    /* 'cave' (The Undermine) is reached by descending a shaft, not by sailing, so
       it is not in WORLD_ORDER — but it is still a real world the player can be in
       and must be buyable/travellable, or the client's reload lands somewhere the
       server disagrees with and bounces the player straight back out. */
    if (!WORLD_ORDER.includes(k) && !(k === 'cave' && has(WORLDS, k))) {
      return err(`Unknown island · expected one of ${WORLD_ORDER.join(', ')}`);
    }
    const w = WORLDS[k];

    if (!state.worlds.includes(k)) {
      /* a charter also needs a hull that survives the crossing — the same gate
         the client draws its Unlock button from (game.js:1932), so both sides
         agree on which voyages are legal. The shaft needs no boat. */
      const need = k === 'cave' ? 0 : (has(BOAT_REQ, k) ? BOAT_REQ[k] | 0 : 0);
      if (state.boatLvl < need) {
        return err(`Your ${BOATS[state.boatLvl].name} can't make that voyage · `
          + `build a ${BOATS[need].name} at the Harbor dock`);
      }
      const cost = int0(w.cost);
      if (state.coins < cost) return err(`Not enough coins · ${w.name} costs ${cost}`);
      state.coins -= cost;
      state.worlds.push(k);
      /* unlocking is not sailing: the player still has to press SAIL */
      return ok({ world: k, name: w.name, unlocked: true, sailed: false, cost,
        worlds: [...state.worlds], message: `${w.name} unlocked!` });
    }

    if (state.world === k) {
      return ok({ world: k, name: w.name, unlocked: false, sailed: false, already: true,
        message: `You are already on ${w.name}` });
    }

    state.world = k;
    return ok({ world: k, name: w.name, unlocked: false, sailed: true,
      message: `Sailing to ${w.name}…` });
  })
};
