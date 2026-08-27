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

   Nothing in `body` is ever trusted for value: indices are range-checked,
   prices are recomputed from economy.js, and stake amounts must match the
   fixed ladder. The only client-supplied facts we accept are the ambient ones
   the server has no view of (night / wet), and those can only shift WHICH fish
   table is rolled — never how much anything is worth.

   Ported 1:1 from game.js; the line references below point at the original.
   ESM, Node 18+. No express, no db — pure state transitions.
   ============================================================================ */

import { randomInt } from 'node:crypto';

import {
  RORDER, ORE_INFO, ORE_KEYS, PEARL_ORE,
  MAXLVL, WORLDS, WORLD_ORDER,
  ROD_BASE, PICK_BASE, AXE_BASE, UP_REQ, AXE_REQ,
  upCost, axeCost,
  cap, rollFish, pearlsForFish, dexNameOf,
  rand, clamp
} from './rules.js';

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
  mine: 900,
  chop: 900,
  dig: 1200,
  sell: 250,
  craft: 400,
  stock: 400,
  kiosk: 400,
  spin: 1500,
  travel: 2000
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
const BET_COLORS = new Set(['red', 'black', 'green']);
const COIN_STAKES = [50, 250, 1000];          // game.js:1981
const GREEN_MULT = 14, COLOR_MULT = 2;        // game.js:2036

/* Pearl kiosk (game.js:1806-1842) — every price here is PEARLS, never coins. */
const BUCKET_COST = [150, 300, 600, 1000];    // game.js:1807
const MAX_BUCKET_TIER = BUCKET_COST.length;   // tier 4 == MAX
const WARDROBE_COST = 80, CHUM_COST = 80, TIP_COST = 30;
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
  rod:  { key: 'rodLvl',  base: ROD_BASE,  reqs: UP_REQ },
  pick: { key: 'pickLvl', base: PICK_BASE, reqs: UP_REQ },
  axe:  { key: 'axeLvl',  base: AXE_BASE,  reqs: AXE_REQ }
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
  for (const k of ['caught', 'mined', 'earned', 'bestWin', 'spins', 'winsCt', 'losses', 'divEarned']) {
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
  state.pearls = int0(state.pearls);
  state.pearlsLife = int0(state.pearlsLife);
  state.bucketTier = clamp(int0(state.bucketTier), 0, MAX_BUCKET_TIER);
  state.tipEpoch = int0(state.tipEpoch);

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

/** Roll one fish for the world the player is standing in. */
function rollFor(state, body) {
  return rollFish({
    world: state.world,
    rodLvl: state.rodLvl,
    fishMul: worldOf(state).fishMul,
    night: !!body.night,
    wet: !!body.wet
  });
}

/**
 * The client's onCatch() (game.js:1568): bucket, Fishdex, pearls, and the two
 * things a catch can also snag — a Reel Fisheries share and a bottled map.
 * Shared by `catch` and by `dig`'s buried-fish branch.
 */
function landFish(state, fish, { allowMap = true } = {}) {
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

  const pearls = addPearls(state, pearlsForFish(fish, { isNew, isRecord: isRec }));

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
     decides what was on the hook. body: { night, wet }
     -------------------------------------------------------------------------- */
  catch: handler((state, body) => {
    const limit = cap(state);
    if (state.bucket.length >= limit) {
      return err(`Bucket is full (${limit}) — sell your catch at the Trader first`);
    }

    const fish = rollFor(state, body);
    if (!fish) return err('Nothing is biting here');

    const { isNew, isRec, pearls, share, treasure } = landFish(state, fish);

    const result = { fish, pearls, isNew, isRec, bucket: state.bucket.length, cap: limit };
    if (share) result.share = share;
    if (treasure) result.treasure = treasure;
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     mine — one completed pick swing on an ore node. body: { type }
     game.js:2109-2118
     -------------------------------------------------------------------------- */
  mine: handler((state, body) => {
    const type = String(body.type || '');
    if (!MINE_TYPES.includes(type)) {
      return err(`Unknown ore node — expected one of ${MINE_TYPES.join(', ')}`);
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

    const result = { type, got, pearls, ores: state.ores[type] };
    if (share) result.share = share;
    return ok(result);
  }),

  /* --------------------------------------------------------------------------
     chop — one completed axe swing on a tree. game.js:2142-2145
     -------------------------------------------------------------------------- */
  chop: handler((state) => {
    const lvl = state.axeLvl;
    const got = 1
      + (Math.random() < Math.min(0.85, 0.35 + 0.08 * (lvl - 1)) ? 1 : 0)
      + (lvl >= 6 && Math.random() < 0.2 ? 1 : 0);

    state.ores.wood += got;
    state.stats.mined += got;
    const pearls = addPearls(state, 1);

    const share = Math.random() < 0.04 ? tryShare(state, 'LUMB') : null;

    const result = { got, pearls, ores: state.ores.wood };
    if (share) result.share = share;
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

    const result = { spot, pearls };
    const r = Math.random();

    if (r < 0.55) {
      const g = Math.round(rand(150, 600) * (1 + 0.12 * (state.rodLvl + state.pickLvl)));
      state.coins += g;
      state.stats.earned += g;
      result.kind = 'coins';
      result.coins = g;
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
      return ok(result);
    }

    /* a rare fish was buried here — only if there is room to hold it */
    if (state.bucket.length < cap(state)) {
      let fish = null;
      for (let i = 0; i < 25; i++) {
        const f = rollFor(state, body);
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
        if (land.share) result.share = land.share;
        return ok(result);
      }
    }

    /* bucket full (or the pool was empty): the chest pays a consolation purse */
    const g = 300;
    state.coins += g;
    state.stats.earned += g;
    result.kind = 'coins';
    result.coins = g;
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
      return ok({ kind, coins, sold: 1, fish, bucket: state.bucket.length });
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
      return ok({ kind, oreKey: k, amount: n, coins });
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
        return err(kept ? 'Only ★ starred fish left — sell them one by one' : 'Bucket empty');
      }
      state.coins += coins;
      state.stats.earned += coins;
      return ok({ kind, coins, sold, kept, bucket: state.bucket.length });
    }

    return err("Unknown sell kind — expected 'fish', 'ore' or 'allfish'");
  }),

  /* --------------------------------------------------------------------------
     craft — forge the next tool tier. body: { tool:'rod'|'pick'|'axe' }
     game.js:1863-1871
     -------------------------------------------------------------------------- */
  craft: handler((state, body) => {
    const tool = String(body.tool || '');
    if (!has(CRAFT_SPEC, tool)) return err("Unknown tool — expected 'rod', 'pick' or 'axe'");
    const spec = CRAFT_SPEC[tool];

    const lvl = state[spec.key];
    if (lvl >= MAXLVL) return err('That tool is already at max level');

    const cost = tool === 'axe' ? axeCost(lvl) : upCost(spec.base, lvl);
    const req = spec.reqs[lvl + 1] || {};

    if (state.coins < cost) return err(`Not enough coins — that costs ${cost}`);
    for (const k in req) {
      if ((state.ores[k] | 0) < req[k]) {
        const name = ORE_INFO[k] ? ORE_INFO[k].name : k;
        return err(`Not enough ${name} — you need ${req[k]}`);
      }
    }

    state.coins -= cost;
    for (const k in req) state.ores[k] -= req[k];
    state[spec.key] = lvl + 1;

    return ok({ tool, level: lvl + 1, cost, spent: { ...req } });
  }),

  /* --------------------------------------------------------------------------
     stock — the Isle Exchange. body: { op:'buy'|'sell', ticker }
     One share per call, priced at the current epoch's ask/bid. game.js:1876-1886
     -------------------------------------------------------------------------- */
  stock: handler((state, body) => {
    const op = String(body.op || '');
    const k = String(body.ticker || '');
    if (!STOCK_KEYS.includes(k)) return err(`Unknown ticker — expected one of ${STOCK_KEYS.join(', ')}`);

    const e = mktEpochNow();
    const sk = state.stocks;
    const own = sk.own[k] | 0;

    if (op === 'buy') {
      if (own >= STOCK_CAP) return err(`Position capped — you already hold ${STOCK_CAP} ${k}`);
      const ask = stockAsk(k, e);
      if (state.coins < ask) return err(`Not enough coins — ${k} is asking ${ask}`);

      state.coins -= ask;
      /* basis tracks the mid price, not the ask: the spread is the fee you paid */
      const p = stockPrice(k, e);
      sk.basis[k] = (num(sk.basis[k], p) * own + p) / (own + 1);
      sk.own[k] = own + 1;

      return ok({ op, ticker: k, price: ask, own: sk.own[k], basis: sk.basis[k], epoch: e });
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

      return ok({ op, ticker: k, price: bid, own: sk.own[k], profit, epoch: e });
    }

    return err("Unknown stock op — expected 'buy' or 'sell'");
  }),

  /* --------------------------------------------------------------------------
     kiosk — the Pearl Kiosk. Everything here is bought with PEARLS.
     body: { item:'wardrobe'|'chum'|'bucket'|'tip'|'t1'..'t4'|'wcolor', slot?, color? }
     game.js:1888-1903
     -------------------------------------------------------------------------- */
  kiosk: handler((state, body) => {
    const item = String(body.item || '');

    /* recolouring is free once the wardrobe is owned */
    if (item === 'wcolor') {
      if (!state.ownedW.wardrobe) return err('Buy the Hero Wardrobe first');
      const slot = String(body.slot || '');
      if (!W_SLOTS.includes(slot)) return err(`Unknown slot — expected one of ${W_SLOTS.join(', ')}`);
      const color = intOrNull(body.color);
      if (color === null || color < 0 || color >= W_COLORS) return err('Unknown wardrobe color');
      state.wardrobe[slot] = color;
      return ok({ item, slot, color, cost: 0, pearls: state.pearls });
    }

    /* spend() only debits once every precondition above it has passed */
    const spend = (cost) => {
      if (state.pearls < cost) return false;
      state.pearls -= cost;
      return true;
    };
    const short = (cost) => err(`Not enough pearls — that costs ${cost}, you have ${state.pearls}`);

    if (item === 'wardrobe') {
      if (state.ownedW.wardrobe) return err('You already own the Hero Wardrobe');
      if (!spend(WARDROBE_COST)) return short(WARDROBE_COST);
      state.ownedW.wardrobe = 1;
      return ok({ item, cost: WARDROBE_COST, pearls: state.pearls });
    }

    if (item === 'chum') {
      if (Date.now() < state.boosts.chumUntil) return err('There is already chum in the water');
      if (!spend(CHUM_COST)) return short(CHUM_COST);
      state.boosts.chumUntil = Date.now() + CHUM_MS;
      return ok({ item, cost: CHUM_COST, chumUntil: state.boosts.chumUntil, pearls: state.pearls });
    }

    if (item === 'bucket') {
      if (state.bucketTier >= MAX_BUCKET_TIER) return err('Your Deep Bucket is already maxed');
      const cost = BUCKET_COST[state.bucketTier];
      if (!spend(cost)) return short(cost);
      state.bucketTier++;
      return ok({ item, cost, bucketTier: state.bucketTier, cap: cap(state), pearls: state.pearls });
    }

    if (item === 'tip') {
      if (!spend(TIP_COST)) return short(TIP_COST);
      /* the tip reveals the NEXT rotation, so it is only worth its 30 pearls
         until that epoch actually arrives */
      const epoch = mktEpochNow() + 1;
      state.tipEpoch = epoch;
      const m = mktModsAt(epoch);
      return ok({ item, cost: TIP_COST, tipEpoch: epoch, hot: m.hot, cold: m.cold, pearls: state.pearls });
    }

    if (has(KIOSK_TITLES, item)) {
      const title = KIOSK_TITLES[item];
      /* already owned: this is an equip/unequip toggle, and it is free */
      if (has(state.ownedT, item) && state.ownedT[item]) {
        state.titleId = state.titleId === title.name ? '' : title.name;
        return ok({ item, cost: 0, titleId: state.titleId, owned: true, pearls: state.pearls });
      }
      if (!spend(title.cost)) return short(title.cost);
      state.ownedT[item] = 1;
      state.titleId = title.name;
      return ok({ item, cost: title.cost, titleId: state.titleId, owned: true, pearls: state.pearls });
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
    if (!BET_COLORS.has(bet)) return err("Pick a colour — 'red', 'black' or 'green'");

    const idxRaw = intOrNull(body.stakeIdx);
    const coinRaw = intOrNull(body.coinStake);
    const wantsFish = idxRaw !== null && idxRaw >= 0;
    const wantsCoins = coinRaw !== null && coinRaw > 0;
    if (wantsFish && wantsCoins) return err('Stake a fish or coins — not both');

    let fish = null, fishIdx = -1, stake = 0;

    if (wantsFish) {
      if (idxRaw >= state.bucket.length || !state.bucket[idxRaw]) {
        return err('No such fish in your bucket');
      }
      fishIdx = idxRaw;
      fish = state.bucket[fishIdx];
    } else if (wantsCoins) {
      if (!COIN_STAKES.includes(coinRaw)) {
        return err(`Coin stake must be one of ${COIN_STAKES.join(', ')}`);
      }
      stake = coinRaw;
      if (state.coins < stake) return err('Not enough coins for that stake');
      state.coins -= stake;                    // committed the moment the ball rolls
    } else {
      return err('Nothing staked — bet a fish or coins');
    }

    const winIdx = randomInt(0, NSEG);
    const color = SEG[winIdx];
    const won = color === bet;

    state.stats.spins++;
    const result = { winIdx, color, bet, won };

    if (!won) {
      state.stats.losses++;
      if (fish) {
        state.bucket.splice(fishIdx, 1);
        result.fish = fish;
        result.lost = fish.name;
        result.bucket = state.bucket.length;
      } else {
        result.stake = stake;
      }
      result.payout = 0;
      return ok(result);
    }

    const mult = color === 'green' ? GREEN_MULT : COLOR_MULT;
    state.stats.winsCt++;
    result.mult = mult;

    /* the jackpot pocket also pays out a meme-stock certificate */
    if (color === 'green') {
      const share = tryShare(state, 'EEL');
      if (share) result.share = share;
    }

    if (fish) {
      const before = Math.max(0, Math.round(num(fish.val, 0)));
      fish.val = before * mult;
      fish.wins = (fish.wins | 0) + 1;         // ★ — excluded from Sell All
      state.stats.bestWin = Math.max(state.stats.bestWin, fish.val);
      result.fish = fish;
      result.before = before;
      result.payout = fish.val;
    } else {
      const gain = stake * mult;
      state.coins += gain;
      state.stats.earned += gain - stake;      // net, so a 2× win isn't double-counted
      state.stats.bestWin = Math.max(state.stats.bestWin, gain);
      result.stake = stake;
      result.payout = gain;
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
    if (!WORLD_ORDER.includes(k)) {
      return err(`Unknown island — expected one of ${WORLD_ORDER.join(', ')}`);
    }
    const w = WORLDS[k];

    if (!state.worlds.includes(k)) {
      const cost = int0(w.cost);
      if (state.coins < cost) return err(`Not enough coins — ${w.name} costs ${cost}`);
      state.coins -= cost;
      state.worlds.push(k);
      /* unlocking is not sailing: the player still has to press SAIL */
      return ok({ world: k, name: w.name, unlocked: true, sailed: false, cost, worlds: [...state.worlds] });
    }

    if (state.world === k) {
      return ok({ world: k, name: w.name, unlocked: false, sailed: false, already: true });
    }

    state.world = k;
    return ok({ world: k, name: w.name, unlocked: false, sailed: true });
  })
};
