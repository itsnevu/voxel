/* ============================================================================
   rules.js — authoritative game rules, ported 1:1 from the client (game.js).
   Pure data + pure functions. No I/O, no express, no db. ESM, Node 18+.

   Every constant here MUST stay byte-identical in value to its counterpart in
   /game.js — the client renders from these numbers, the server decides with
   them, and any drift shows up as "the UI said 40 coins but I got 38".
   ============================================================================ */

/* ---- tiny helpers (same semantics as the client's one-liners) ---- */
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const rand = (a, b) => a + Math.random() * (b - a);

/* ---- deterministic value noise (game.js:142-145) --------------------------
   Shared with economy.js so stock charts drawn on the client and prices
   settled on the server come from the exact same curve. Do not "improve"
   these: the whole market is a pure function of wall-clock epoch, and any
   change silently repriecs every share in every save. ------------------------ */
export function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* ============================================================================
   ORES
   ============================================================================ */
export const ORE_INFO = {
  wood:    { name: 'Wood',    price: 6,  color: 0x9a6b3a, glow: false, dot: '#9a6b3a' },
  coal:    { name: 'Coal',    price: 5,  color: 0x2e3338, glow: false, dot: '#565e66' },
  iron:    { name: 'Iron',    price: 12, color: 0xd8cfc4, glow: false, dot: '#d8cfc4' },
  gold:    { name: 'Gold',    price: 28, color: 0xffd24f, glow: true,  dot: '#ffd24f' },
  diamond: { name: 'Diamond', price: 70, color: 0x5ee8e2, glow: true,  dot: '#5ee8e2' }
};
export const ORE_KEYS = Object.keys(ORE_INFO);

/** Ore node type roll used by the quarry (game.js:759). */
export function rollOreType() {
  const r = Math.random();
  return r < 0.4 ? 'coal' : r < 0.7 ? 'iron' : r < 0.9 ? 'gold' : 'diamond';
}

/* Pearls track effort, not ore value (game.js:2113 + the chop's flat +1). */
export const PEARL_ORE = { wood: 1, coal: 1, iron: 1, gold: 2, diamond: 5 };

/* ============================================================================
   RARITY + FISH TABLES
   entries: [species, weight, cond?] — cond gates when the species can bite.
   ============================================================================ */
export const RORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
export const PEARL_RARITY = { common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 16 };

const F = (name, rar, val) => ({ name, rar, val });

/** Fortune Isle's table — also the fallback pool for an unknown world. */
export const TABLE = [
  [F('Sardine', 'common', 8), 40], [F('Perch', 'common', 12), 34], [F('Carp', 'common', 10), 30],
  [F('Bass', 'uncommon', 20), 26], [F('Trout', 'uncommon', 24), 22], [F('Snapper', 'uncommon', 34), 18],
  [F('Eel', 'rare', 44), 14], [F('Tuna', 'rare', 82), 10], [F('Koi', 'rare', 130), 8],
  [F('Sturgeon', 'epic', 128), 6], [F('Swordfish', 'epic', 156), 5], [F('Golden Carp', 'epic', 168), 4],
  [F('Anglerfish', 'legendary', 430), 2], [F('Star Koi', 'legendary', 620), 1],
  [F('Glowgill', 'uncommon', 40), 10, 'night'], [F('Moonfin', 'rare', 95), 7, 'night'],
  [F('Midnight Koi', 'epic', 210), 4, 'night'],
  [F('Rainrunner', 'uncommon', 38), 12, 'rain'], [F('Mistcarp', 'rare', 88), 6, 'rain'],
  [F('Thunder Eel', 'epic', 260), 5, 'storm'], [F('Storm Marlin', 'legendary', 750), 2, 'storm']
];

const MINE_FISH = [
  [F('Pebble Sardine', 'common', 9), 40], [F('Gravel Perch', 'common', 13), 34], [F('Rust Carp', 'common', 12), 30],
  [F('Copperfin', 'uncommon', 24), 24], [F('Tin Trout', 'uncommon', 26), 20], [F('Quarry Snapper', 'uncommon', 38), 16],
  [F('Iron Eel', 'rare', 60), 12], [F('Magnetite Tuna', 'rare', 95), 9], [F('Cobalt Koi', 'rare', 140), 7],
  [F('Silver Sturgeon', 'epic', 150), 6], [F('Drill Marlin', 'epic', 175), 4],
  [F('Motherlode Koi', 'legendary', 520), 2],
  [F('Lantern Glowgill', 'uncommon', 45), 9, 'night'], [F('Moonvein Eel', 'rare', 105), 6, 'night'],
  [F('Slag Eel', 'epic', 280), 4, 'storm'], [F('Forge Marlin', 'legendary', 780), 1, 'storm']
];

const VOLCANO_FISH = [
  [F('Ash Sardine', 'common', 10), 40], [F('Soot Perch', 'common', 14), 32],
  [F('Emberfin', 'uncommon', 26), 24], [F('Cinder Snapper', 'uncommon', 36), 18],
  [F('Magma Eel', 'rare', 70), 12], [F('Basalt Tuna', 'rare', 100), 9],
  [F('Obsidian Sturgeon', 'epic', 160), 6], [F('Pyro Koi', 'epic', 200), 4],
  [F('Phoenix Marlin', 'legendary', 800), 2],
  [F('Lava Glowgill', 'uncommon', 48), 10, 'night'], [F('Ashmoon Koi', 'epic', 240), 4, 'night'],
  [F('Eruption Eel', 'epic', 300), 4, 'storm'], [F('Inferno Marlin', 'legendary', 900), 1, 'storm']
];

const FROST_FISH = [
  [F('Ice Sardine', 'common', 9), 40], [F('Frost Perch', 'common', 13), 33],
  [F('Snowfin', 'uncommon', 24), 22], [F('Glacier Trout', 'uncommon', 26), 20],
  [F('Crystal Eel', 'rare', 75), 11], [F('Arctic Tuna', 'rare', 105), 9],
  [F('Frozen Sturgeon', 'epic', 165), 5], [F('Snowflake Koi', 'epic', 210), 4],
  [F('Aurora Marlin', 'legendary', 850), 2],
  [F('Polar Glowgill', 'uncommon', 50), 9, 'night'], [F('Moonfrost Koi', 'epic', 230), 4, 'night'],
  [F('Blizzard Eel', 'epic', 290), 4, 'storm'], [F('Yeti Carp', 'legendary', 820), 1, 'storm']
];

/* cave: eternal night, so its glow species are the everyday population. */
const CAVE_FISH = [
  [F('Cave Guppy', 'common', 10), 40], [F('Blind Perch', 'common', 14), 32],
  [F('Glowgill', 'uncommon', 40), 20], [F('Echo Snapper', 'uncommon', 36), 16],
  [F('Dweller Eel', 'rare', 78), 12], [F('Moonfin', 'rare', 95), 8], [F('Crystal Koi', 'rare', 150), 6],
  [F('Midnight Koi', 'epic', 210), 5], [F('Fossil Sturgeon', 'epic', 170), 4],
  [F('Abyss Anglerfish', 'legendary', 900), 2], [F('Wyrm Eel', 'legendary', 850), 1]
];

/* ============================================================================
   WORLDS — themed islands unlocked at the Harbor.
   Render-only fields (palettes, sky/water hex) are intentionally omitted; the
   server only needs economy + spawn parameters. `seed`/`hMul`/`treeMax` are
   kept so a future server-side terrain check can reproduce the client's map.
   ============================================================================ */
export const WORLDS = {
  isle:    { name: 'Fortune Isle',  sub: 'world 1 · fishing haven', cost: 0,     seed: 0,   hMul: 1,    stoneH: 6, fishMul: 1,   oreN: 0,  oreYield: 1, treeMax: 90, fish: TABLE },
  mine:    { name: 'The Great Mine', sub: 'world 2 · ore ×2',       cost: 2500,  seed: 57,  hMul: 1.3,  stoneH: 5, fishMul: 1.1, oreN: 30, oreYield: 2, treeMax: 40, fish: MINE_FISH },
  volcano: { name: 'Cinder Atoll',  sub: 'world 3 · danger pays',   cost: 8000,  seed: 191, hMul: 1.45, stoneH: 5, fishMul: 2.2, oreN: 22, oreYield: 1, treeMax: 26, fish: VOLCANO_FISH },
  frost:   { name: 'Frostbite Isle', sub: 'world 4 · frozen riches', cost: 15000, seed: 311, hMul: 1.2, stoneH: 6, fishMul: 4,   oreN: 26, oreYield: 1, treeMax: 60, fish: FROST_FISH },
  cave:    { name: 'The Undermine', sub: 'the mining cave',         cost: 750,   seed: 777, hMul: 1.15, stoneH: 5, fishMul: 2,   oreN: 40, oreYield: 1, treeMax: 16, cave: true, fish: CAVE_FISH }
};
/* Sailing order at the Harbor. `cave` is NOT here: it is reached by the shaft. */
export const WORLD_ORDER = ['isle', 'mine', 'volcano', 'frost'];
export const WORLD_KEYS = Object.keys(WORLDS);

/** Combined species list (unique by name) — drives Fishdex completion. */
export const ALL_FISH = (() => {
  const out = [], seen = new Set();
  for (const k of WORLD_KEYS) {
    const wf = WORLDS[k].fish;
    if (!wf) continue;
    for (const e of wf) if (!seen.has(e[0].name)) { seen.add(e[0].name); out.push(e); }
  }
  return out;
})();

/* ============================================================================
   TOOLS + PROGRESSION
   ============================================================================ */
export const CAP_BASE = 12, MAXLVL = 10;
export const ROD_BASE = 250, PICK_BASE = 200, AXE_BASE = 180;

export const ROD_NAMES  = ['', 'Old Rod', 'Birch Rod', 'Lucky Rod', 'Fiber Rod', 'Golden Rod', 'Prism Rod', 'Storm Rod', 'Mythic Rod', 'Abyss Rod', 'Poseidon Rod'];
export const PICK_NAMES = ['', 'Rusty Pick', 'Stone Pick', 'Iron Pick', 'Steel Pick', 'Golden Pick', 'Crystal Pick', 'Obsidian Pick', 'Mythril Pick', 'Dragon Pick', 'Titan Pick'];
export const AXE_NAMES  = ['', 'Dull Axe', 'Stone Axe', 'Iron Axe', 'Steel Axe', 'Golden Axe', 'Crystal Axe', 'Obsidian Axe', 'Mythril Axe', 'Dragon Axe', 'Titan Axe'];

/** Coin cost to go from `lvl` -> `lvl+1`. */
export const upCost = (base, lvl) => Math.round(base * Math.pow(1.75, lvl - 1));
/** The axe has its own gentler ladder — wood is a 6-coin commodity. */
export const axeCost = (lvl) => Math.round(90 * Math.pow(1.5, lvl - 1));

/* Ore ingredients for the next tier, indexed by TARGET level. */
export const UP_REQ  = [null, null, { wood: 5 }, { wood: 8, coal: 4 }, { iron: 4 }, { iron: 8 }, { gold: 3 }, { gold: 6 }, { diamond: 2 }, { diamond: 4 }, { diamond: 7 }];
export const AXE_REQ = [null, null, { wood: 5 }, { wood: 10, coal: 3 }, { iron: 3 }, { iron: 6 }, { gold: 2 }, { gold: 4 }, { gold: 6 }, { gold: 8 }, { gold: 10 }];

/* ---- the fleet: coins + ores buy the next hull at the Harbor dock ---- */
export const BOATS = [
  { name: 'Driftwood Raft', sub: 'lashed logs & a prayer',     cost: 0,     req: {},                      luck: 0 },
  { name: 'Cork Dinghy',    sub: 'a real hull at last',        cost: 600,   req: { wood: 12 },            luck: 0.06 },
  { name: 'Teal Sloop',     sub: 'painted hull · single sail', cost: 2400,  req: { wood: 20, iron: 8 },   luck: 0.12 },
  { name: 'Storm Trawler',  sub: 'iron-clad workhorse',        cost: 8000,  req: { iron: 14, gold: 8 },   luck: 0.2 },
  { name: 'Gilded Galleon', sub: 'pride of the archipelago',   cost: 22000, req: { gold: 14, diamond: 6 }, luck: 0.3 }
];
export const MAX_BOAT = BOATS.length - 1;
/** Boat level needed to UNLOCK each isle. */
export const BOAT_REQ = { isle: 0, mine: 1, volcano: 2, frost: 3 };

/** True when `ores` covers every ingredient in `req`. */
export function haveOres(ores, req) {
  if (!req) return true;
  for (const k in req) if ((ores?.[k] | 0) < req[k]) return false;
  return true;
}

/* ============================================================================
   STATE
   ============================================================================ */
export const STATE_VERSION = 1;

/** A brand-new save. Same shape as the client's `state`, plus `world` + `v`. */
export function newState() {
  return {
    v: STATE_VERSION,
    world: 'isle',
    coins: 0,
    bucket: [],
    ores: { wood: 0, coal: 0, iron: 0, gold: 0, diamond: 0 },
    rodLvl: 1, pickLvl: 1, axeLvl: 1, boatLvl: 0,
    dex: {},
    treasure: null,
    worlds: ['isle'],
    ach: {},
    stocks: { own: {}, basis: {}, lastDiv: null, lastShareEpoch: 0, gotFirst: 0 },
    pearls: 0, pearlsLife: 0,
    wardrobe: {}, titleId: '', ownedT: {}, ownedW: {},
    bucketTier: 0,
    boosts: { chumUntil: 0 },
    tipEpoch: 0,
    deeds: {},
    stats: { caught: 0, mined: 0, earned: 0, bestWin: 0, spins: 0, winsCt: 0, losses: 0, divEarned: 0 }
  };
}

/** Bucket capacity for a state (client: CAP_BASE + 2 per bucket tier). */
export function cap(state) {
  return CAP_BASE + 2 * (state?.bucketTier | 0);
}

/* Tickers are declared in economy.js, but normalizeState has to reject unknown
   keys without importing it (rules.js must stay dependency-free) — so keep a
   local mirror of the set here. Must match economy.js's STOCK_KEYS. */
const STOCK_TICKERS = new Set(['DIGG', 'REEL', 'LUMB', 'EEL', 'HARB']);

/**
 * Coerce an untrusted/legacy save row into a valid state.
 * Mirrors the client's load() clamping, but NEVER trusts a field: anything
 * missing or malformed falls back to the newState() default rather than
 * throwing, so one bad row can't lock a player out of their account.
 */
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const st = newState();
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

  st.coins = Math.max(0, Math.floor(num(s.coins, 0)));
  st.bucket = Array.isArray(s.bucket) ? s.bucket.filter((f) => f && typeof f === 'object').slice(0, 64) : [];
  const ores = obj(s.ores);
  if (ores) for (const k in st.ores) st.ores[k] = Math.max(0, ores[k] | 0);
  const stats = obj(s.stats);
  if (stats) for (const k in st.stats) st.stats[k] = Math.max(0, num(stats[k], 0));
  if (obj(s.dex)) st.dex = s.dex;
  if (obj(s.ach)) st.ach = s.ach;
  if (obj(s.treasure) && s.treasure.i != null) st.treasure = s.treasure;
  if (Array.isArray(s.worlds) && s.worlds.length) {
    const w = s.worlds.filter((k) => typeof k === 'string' && WORLDS[k]);
    if (w.length) st.worlds = [...new Set(w)];
  }
  if (!st.worlds.includes('isle')) st.worlds.unshift('isle');

  const sk = obj(s.stocks);
  if (sk) {
    const own = obj(sk.own);
    if (own) for (const k in own) if (STOCK_TICKERS.has(k)) st.stocks.own[k] = clamp(own[k] | 0, 0, 100);
    const basis = obj(sk.basis);
    if (basis) for (const k in basis) {
      const b = +basis[k];
      if (STOCK_TICKERS.has(k) && Number.isFinite(b) && b > 0) st.stocks.basis[k] = b;
    }
    /* Must stay `null` (never 0) for a save that has not been paid yet:
       +null is 0, and quarter 0 is 1970 — which would read as "24 quarters
       owed" and pay a brand-new portfolio a full catch-up on first load. */
    st.stocks.lastDiv = typeof sk.lastDiv === 'number' && Number.isFinite(sk.lastDiv) ? sk.lastDiv : null;
    st.stocks.lastShareEpoch = Math.max(0, num(sk.lastShareEpoch, 0));
    st.stocks.gotFirst = sk.gotFirst ? 1 : 0;
  }

  st.pearls = Math.max(0, s.pearls | 0);
  st.pearlsLife = Math.max(0, s.pearlsLife | 0);
  if (obj(s.wardrobe)) st.wardrobe = s.wardrobe;
  if (obj(s.ownedW)) st.ownedW = s.ownedW;
  if (obj(s.ownedT)) st.ownedT = s.ownedT;
  if (obj(s.deeds)) st.deeds = s.deeds;
  st.titleId = typeof s.titleId === 'string' ? s.titleId.slice(0, 40) : '';
  st.bucketTier = clamp(s.bucketTier | 0, 0, 4);
  st.tipEpoch = Math.max(0, num(s.tipEpoch, 0));
  const boosts = obj(s.boosts);
  if (boosts) st.boosts.chumUntil = Math.max(0, num(boosts.chumUntil, 0));
  st.rodLvl = clamp(s.rodLvl | 0 || 1, 1, MAXLVL);
  st.pickLvl = clamp(s.pickLvl | 0 || 1, 1, MAXLVL);
  st.axeLvl = clamp(s.axeLvl | 0 || 1, 1, MAXLVL);
  st.boatLvl = clamp(s.boatLvl | 0, 0, MAX_BOAT);
  st.world = typeof s.world === 'string' && WORLDS[s.world] ? s.world : 'isle';
  /* an unowned isle in `world` would let a client teleport by editing its save */
  if (st.world !== 'cave' && !st.worlds.includes(st.world)) st.world = 'isle';
  if (st.world === 'cave' && !st.worlds.includes('cave')) st.world = 'isle';
  if (st.treasure && st.treasure.w == null) st.treasure.w = st.world; // legacy maps
  st.v = STATE_VERSION;
  return st;
}

/* ============================================================================
   FISHING
   ============================================================================ */

/** Does a species' spawn condition hold under the given weather/time? */
export function condOK(cond, { night = false, rain = false, storm = false } = {}) {
  if (!cond) return true;
  if (cond === 'night') return !!night;
  if (cond === 'rain') return !!rain || !!storm;
  if (cond === 'storm') return !!storm;
  return true;
}

/** Weather flags from the loose `{night, wet}` shape the API speaks. */
function envOf({ night = false, wet = false, storm = false } = {}) {
  const isStorm = !!storm || wet === 'storm';
  return { night: !!night, rain: !!wet || isStorm, storm: isStorm };
}

/** The condition-filtered table for a world. */
export function fishPool(world = 'isle', env = {}) {
  const w = WORLDS[world];
  const table = (w && w.fish) || TABLE;
  const e = envOf(env);
  return table.filter((entry) => condOK(entry[2], e));
}

/**
 * One weighted draw from a world's pool — the client's rollOnce().
 * Returns null only if the pool is somehow empty (never, for shipped tables).
 */
export function rollOnce(opts = {}) {
  const { world = 'isle', fishMul } = opts;
  const mul = Number.isFinite(+fishMul) ? +fishMul : (WORLDS[world]?.fishMul || 1);
  const pool = fishPool(world, opts);
  if (!pool.length) return null;

  let tot = 0;
  for (const e of pool) tot += e[1];
  let r = Math.random() * tot;
  for (const e of pool) {
    r -= e[1];
    if (r <= 0) {
      const t = e[0];
      const val = Math.round(t.val * mul * rand(0.85, 1.18));
      return {
        uid: (Date.now() + Math.random()).toString(36),
        name: t.name,
        rar: t.rar,
        val,
        kg: +(t.val / 9 * rand(0.5, 1.6) + 0.2).toFixed(1),
        wins: 0
      };
    }
  }
  /* floating-point tail: the last entry is the correct answer */
  const t = pool[pool.length - 1][0];
  return {
    uid: (Date.now() + Math.random()).toString(36),
    name: t.name, rar: t.rar,
    val: Math.round(t.val * mul * rand(0.85, 1.18)),
    kg: +(t.val / 9 * rand(0.5, 1.6) + 0.2).toFixed(1),
    wins: 0
  };
}

/**
 * The full catch roll — the client's rollFish().
 *   - rod level rerolls: min(rodLvl-1, 9) tries at p=0.3, keep the rarer fish
 *   - rain/storm grants one extra reroll at p=0.12
 *   - 1.8% shiny mutation: ×5 value and a '✦ ' name prefix
 * `fishMul` defaults to the world's multiplier when omitted.
 */
export function rollFish({ rodLvl = 1, fishMul, night = false, wet = false, storm = false, world = 'isle' } = {}) {
  const opts = { world, fishMul, night, wet, storm };
  let f = rollOnce(opts);
  if (!f) return null;

  const rr = Math.min(clamp(rodLvl | 0 || 1, 1, MAXLVL) - 1, 9);
  for (let k = 0; k < rr; k++) {
    if (Math.random() < 0.3) {
      const g = rollOnce(opts);
      if (g && RORDER[g.rar] > RORDER[f.rar]) f = g;
    }
  }
  const e = envOf({ night, wet, storm });
  if ((e.rain || e.storm) && Math.random() < 0.12) {
    const g = rollOnce(opts);
    if (g && RORDER[g.rar] > RORDER[f.rar]) f = g;
  }
  if (Math.random() < 0.018) { f.shiny = true; f.val *= 5; f.name = '✦ ' + f.name; }
  return f;
}

/** Strip the shiny prefix to get the Fishdex key for a catch. */
export const dexNameOf = (fish) =>
  fish?.shiny ? String(fish.name).replace('✨ ', '').replace('✦ ', '') : String(fish?.name || '');

/**
 * Pearls awarded for a catch: flat activity points by rarity, never scaled by
 * world or price. Shiny triples; a new species adds 5, a personal record 2
 * (the caller knows those from the dex, hence the optional second argument).
 */
export function pearlsForFish(fish, { isNew = false, isRecord = false } = {}) {
  if (!fish) return 0;
  let pp = PEARL_RARITY[fish.rar] || 1;
  if (fish.shiny) pp *= 3;
  if (isNew) pp += 5;
  else if (isRecord) pp += 2;
  return pp;
}
