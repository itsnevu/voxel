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

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
/* `x | 0` is ToInt32, so it silently WRAPS past 2^31: a hand-edited
   `pearls: 4294967296` reads back as 0, and 2147483648 as a negative. Worse,
   a CREDIT written as `(coins | 0) + n` turns a nine-figure purse into
   -1294967206 the moment it crosses the boundary, which then normalises to 0
   on the next load. Floor the Number instead, then clamp at the call site —
   out-of-range values saturate, not wrap. Exported because every credit site
   in economy.js has to go through it too. */
export const int0 = (v) => Math.max(0, Math.floor(num(v, 0)));

/* Own-property test. Every table lookup keyed by a string that came out of a
   save file goes through this: a plain `WORLDS[k]` answers truthily for
   '__proto__', 'constructor' and 'toString', which is enough to walk a bogus
   key past an `if (WORLDS[k])` gate. */
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

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

/* The quarry's node split (game.js:759): coal 40%, iron 30%, gold 20%,
   diamond 10%. Both rollOreType() and oreTypeFor() read it from here, so a
   random node and a keyed one can never drift apart. */
const oreTypeAt = (r) => (r < 0.4 ? 'coal' : r < 0.7 ? 'iron' : r < 0.9 ? 'gold' : 'diamond');

/** Ore node type roll used by the quarry (game.js:759). */
export function rollOreType() {
  return oreTypeAt(Math.random());
}

/* Fold an arbitrary key into a small non-negative integer. Only used to feed
   hash(), so it needs to be stable and well-spread, not cryptographic.
   Exported because the client's copy of the world clock (see THE WORLD CLOCK,
   below) has to fold world keys exactly the same way. */
export function foldKey(v) {
  const s = String(v ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h;
}

/* A world's lane in the hashes — ore types and the weather clock both ride it.
   The shipped `seed` is what the client uses to lay the isle out, so keyed ore
   types stay in the same family of numbers; an unrecognised key still gets its
   own lane rather than colliding on isle. Exported: the client duplicates this
   to derive its own weather, so the lane has to be readable in one place. */
export function worldSeed(world) {
  const w = typeof world === 'string' && has(WORLDS, world) ? WORLDS[world] : null;
  return w && Number.isFinite(w.seed) ? w.seed : foldKey(world);
}

/**
 * The ore type of one quarry node, derived rather than rolled.
 *
 * `mine` cannot trust the client to say WHICH node it just broke open — a
 * scripted client would report `diamond` every swing. Instead the client sends
 * the node's id and the server derives the type here, so the answer is fixed
 * the first time a node is named and identical on every later call.
 *
 * Deterministic by construction: hash() is pure float math over the two
 * integers below, so oreTypeFor(w, id) === oreTypeFor(w, id) always. The odds
 * match rollOreType(): coal 40%, iron 30%, gold 20%, diamond 10%.
 */
export function oreTypeFor(world, nodeId) {
  const n = +nodeId;
  /* keep the hash inputs small and integral: huge or fractional ids still map
     to a stable lane, but never to a float that sin() cannot resolve apart */
  const id = Number.isFinite(n) ? (((Math.trunc(n) % 100003) + 100003) % 100003) : foldKey(nodeId);
  /* the +1s keep node 0 of world `isle` (seed 0) off hash()'s sin(0) === 0 */
  const r = hash(id + 1, worldSeed(world) + 1);
  /* Ids at or past the world's quarry count are the grass "starter" nodes the
     client scatters near spawn so a mine-less isle can still craft its way to
     tier 3. They are coal/iron only — and BOTH sides must agree, or the player
     would break open a coal rock and be handed a diamond. */
  const w = typeof world === 'string' && has(WORLDS, world) ? WORLDS[world] : null;
  const quarry = w && Number.isFinite(w.oreN) ? w.oreN : 0;
  if (Number.isFinite(n) && Math.trunc(n) >= quarry) return r < 0.6 ? 'coal' : 'iron';
  return oreTypeAt(r);
}

/* Pearls track effort, not ore value (game.js:2113 + the chop's flat +1). */
export const PEARL_ORE = { wood: 1, coal: 1, iron: 1, gold: 2, diamond: 5 };

/* ============================================================================
   RARITY + FISH TABLES
   entries: [species, weight, cond?] — cond gates when the species can bite.
   ============================================================================ */
export const RORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
export const RAR_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const PEARL_RARITY = { common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 16 };

/* ---- LUCK ---------------------------------------------------------------
   One number bends the whole draw. `luck` scales every entry's weight by
   rarity: commons thin out, the top of the table swells. At luck 0 the table
   is exactly the shipped one, so a bare Lv.1 rod with no bait plays as before.
   Weights never go below 5% of base, so no species is ever impossible.
   ------------------------------------------------------------------------ */
export const LUCK_W = { common: -0.55, uncommon: -0.15, rare: 0.9, epic: 1.7, legendary: 2.6 };
export const luckWeight = (rar, luck) =>
  (luck > 0 ? Math.max(0.05, 1 + luck * (LUCK_W[rar] || 0)) : 1);

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

/* Neon Shoals: a drowned city under permanent night, so like the cave it has no
   night-only species — its glow fish ARE the everyday population. Weather still
   runs, and the rain-fed and storm-fed entries are where its best money is. */
const NEON_FISH = [
  [F('Chrome Sardine', 'common', 12), 38], [F('Static Perch', 'common', 16), 32],
  [F('Fiberfin', 'uncommon', 30), 24], [F('Circuit Snapper', 'uncommon', 42), 18],
  [F('Voltage Eel', 'rare', 90), 12], [F('Datastream Tuna', 'rare', 120), 9],
  [F('Hologram Koi', 'epic', 240), 5], [F('Reactor Sturgeon', 'epic', 260), 4],
  [F('Neon Leviathan', 'legendary', 1100), 2],
  [F('Acid Rainrunner', 'uncommon', 55), 11, 'rain'], [F('Sodium Carp', 'rare', 130), 6, 'rain'],
  [F('Blackout Eel', 'epic', 320), 4, 'storm'], [F('Skyline Marlin', 'legendary', 1200), 1, 'storm']
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
  cave:    { name: 'The Undermine', sub: 'the mining cave',         cost: 750,   seed: 777, hMul: 1.15, stoneH: 5, fishMul: 2,   oreN: 40, oreYield: 1, treeMax: 16, cave: true, fish: CAVE_FISH },
  /* The exclusive one. `nft` is the gate: only an account WEARING an Angler may
     charter it, and charTokenId is written by /api/nft/equip alone, after the
     chain has answered for the address SIWE proved. `night` is render-only on
     the client but is carried here too, because the fish table depends on it —
     no 'night' conditions, since it is never anything else. */
  neon:    { name: 'Neon Shoals',   sub: 'world 5 · anglers only',  cost: 30000, seed: 909, hMul: 1.05, stoneH: 5, fishMul: 6, oreN: 18, oreYield: 2, treeMax: 10, night: true, nft: true, fish: NEON_FISH }
};
/* Sailing order at the Harbor. `cave` is NOT here: it is reached by the shaft. */
export const WORLD_ORDER = ['isle', 'mine', 'volcano', 'frost', 'neon'];
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

/**
 * Rod luck — what a craft actually buys you at the water.
 * This REPLACES the old "reroll the draw up to 9 times at p=0.3" loop: that
 * loop saturated near Lv.10 (almost every draw already landed epic+), which
 * left no headroom for bait to matter. One additive dial keeps rod and bait
 * legible together. Lv.1 = 0 (the shipped table untouched), Lv.10 = +1.62,
 * which is a little ahead of where the old reroll ladder topped out.
 */
export const rodLuck = (lvl) => +(0.18 * (clamp(lvl | 0 || 1, 1, MAXLVL) - 1)).toFixed(4);

/* ============================================================================
   BAIT — the consumable half of fishing luck.
   Bought by the pack with COINS at the Bait Shack, spent one per fish landed
   (a snapped line costs you nothing). `min` is a hard floor: the pool is
   filtered to that rarity and up, so Siren's Chum literally cannot hook a
   sardine. `shiny` scales the 1.8% mutation roll.
   The ladder is deliberately priced against Fortune Isle's cheap fish: the
   top two baits only turn a profit once you are fishing a high-value world.
   ============================================================================ */
export const BAITS = {
  worm:   { name: 'Garden Worm',   sub: 'wriggly, cheap, honest',        cost: 60,   pack: 10, luck: 0.4, min: null,        shiny: 1,   tint: '#c98b6a' },
  shrimp: { name: 'Brine Shrimp',  sub: 'nothing small bothers with it', cost: 180,  pack: 10, luck: 0.9, min: 'uncommon',  shiny: 1.2, tint: '#ff9f7a' },
  squid:  { name: 'Squid Strip',   sub: 'the deep answers this one',     cost: 400,  pack: 10, luck: 1.6, min: 'rare',      shiny: 1.5, tint: '#c9b6ff' },
  glow:   { name: 'Glowworm Lure', sub: 'burns cold, draws big',         cost: 900,  pack: 10, luck: 2.4, min: 'epic',      shiny: 2,   tint: '#8ef7c9' },
  siren:  { name: "Siren's Chum",  sub: 'only legends answer',           cost: 6000, pack: 10, luck: 3.2, min: 'legendary', shiny: 3,   tint: '#ffd24f' }
};
export const BAIT_ORDER = ['worm', 'shrimp', 'squid', 'glow', 'siren'];
export const BAIT_MAX = 999;   // per-kind stack ceiling

/** The bait record for an id, or null for '' / an unknown id. */
export function baitOf(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BAITS, id) ? BAITS[id] : null;
}

/** Total luck going into one draw: the rod's ladder plus whatever is on the hook. */
export function fishLuck({ rodLvl = 1, bait = null } = {}) {
  const b = baitOf(bait);
  return rodLuck(rodLvl) + (b ? b.luck : 0);
}

/* ============================================================================
   AUTO-FISHING — the "lazy line".
   A rig propped up on the shore that fishes while nobody is at the keyboard.
   It is deliberately the WORST way to fish: no hand sets the hook, no hand
   plays the fish, so it only ever brings up whatever swims into it — the
   cheap end of the water.

   `W` is the dial that matters. It multiplies each species' table weight AFTER
   the world's own weights, so on Fortune Isle a legendary goes from ~1 in 220
   casts to ~1 in 26,000. The rest just make sure an unattended catch is never
   worth as much as one you actually fought:
     luck   the rod ladder counts a quarter, and bait is not on the hook at all
     val    landed rough off a slack line — the Trader pays 30% less
     shiny  the mutation is four times rarer
     pearls half the activity points
     gapMs  floor between two auto catches, enforced server-side on top of
            RATE.catch. The client paces itself just above it.
   ============================================================================ */
export const AUTO = {
  W: { common: 1, uncommon: 0.45, rare: 0.1, epic: 0.03, legendary: 0.008 },
  luck: 0.25,
  val: 0.7,
  shiny: 0.25,
  pearls: 0.5,
  gapMs: 4500
};
/**
 * The rig's rarity multiplier for a species. `q` is the rig's quality, from
 * RIGS below: it lifts everything ABOVE common, and never commons themselves,
 * so a better rig thins the sardines out rather than raising the whole table.
 * Even the top rig lands well short of a held rod — that is the point of it.
 */
export const autoWeight = (rar, q = 1) => {
  const w = has(AUTO.W, rar) ? AUTO.W[rar] : 1;
  return rar === 'common' ? w : w * (q > 0 ? q : 1);
};

/* ---- THE RIG LADDER -----------------------------------------------------
   Bought with PEARLS at the Pearl Kiosk, so the rig is paid for with activity
   rather than with coins — you cannot buy your way straight to an AFK income.

     gapMs  the floor between two catches, enforced here on every request
     q      quality, fed to autoWeight() above
     bite   how long the rig waits for a bite, as a multiple of the rod's own
            bite timer (client-side pacing only; the server does not time it)

   Mk I is free and every save starts with it: the whole feature has to be
   reachable by someone who just walked off the boat, or it is not the "more
   people can play" button it was asked to be.
   ------------------------------------------------------------------------ */
export const RIGS = [
  null,
  { name: 'Driftwood Rig', sub: 'two sticks and a lot of patience', cost: 0,    gapMs: 4500, q: 1,   bite: 1    },
  { name: 'Braced Rig',    sub: 'a hull cleat and a brass bell',    cost: 700,  gapMs: 3800, q: 1.7, bite: 0.78 },
  { name: 'Tidewatch Rig', sub: 'it reads the water for you',       cost: 2000, gapMs: 3100, q: 2.6, bite: 0.6  }
];
export const MAX_RIG = RIGS.length - 1;
/** The rig record for a level — always a real rig, never null. */
export const rigOf = (lvl) => RIGS[clamp((lvl | 0) || 1, 1, MAX_RIG)];

/** Coin cost to go from `lvl` -> `lvl+1`. */
export const upCost = (base, lvl) => Math.round(base * Math.pow(1.75, lvl - 1));
/** The axe has its own gentler ladder — wood is a 6-coin commodity. */
export const axeCost = (lvl) => Math.round(90 * Math.pow(1.5, lvl - 1));

/* Ore ingredients for the next tier, indexed by TARGET level. */
export const UP_REQ  = [null, null, { wood: 5 }, { wood: 8, coal: 4 }, { iron: 4 }, { iron: 8 }, { gold: 3 }, { gold: 6 }, { diamond: 2 }, { diamond: 4 }, { diamond: 7 }];
export const AXE_REQ = [null, null, { wood: 5 }, { wood: 10, coal: 3 }, { iron: 3 }, { iron: 6 }, { gold: 2 }, { gold: 4 }, { gold: 6 }, { gold: 8 }, { gold: 10 }];

/* ---- the fleet: coins + ores buy the next hull at the Harbor dock ---- */
export const BOATS = [
  { name: 'Driftwood Raft', sub: 'lashed logs & a prayer',     cost: 0,     req: {},                      luck: 0,    seats: 1 },
  { name: 'Cork Dinghy',    sub: 'a real hull at last',        cost: 600,   req: { wood: 12 },            luck: 0.06, seats: 2 },
  { name: 'Teal Sloop',     sub: 'painted hull · single sail', cost: 2400,  req: { wood: 20, iron: 8 },   luck: 0.12, seats: 4 },
  { name: 'Storm Trawler',  sub: 'iron-clad workhorse',        cost: 8000,  req: { iron: 14, gold: 8 },   luck: 0.2,  seats: 6 },
  { name: 'Gilded Galleon', sub: 'pride of the archipelago',   cost: 22000, req: { gold: 14, diamond: 6 }, luck: 0.3,  seats: 10 }
];
export const MAX_BOAT = BOATS.length - 1;

/** Seats INCLUDING the captain. A raft seats one, so it can never take crew. */
export function boatSeats(lvl) {
  const b = BOATS[clamp(lvl | 0, 0, MAX_BOAT)];
  return b ? b.seats : 1;
}
/** Berths a captain of `lvl` can hand out — seats minus their own. */
export const crewSlots = (lvl) => Math.max(0, boatSeats(lvl) - 1);
/** Boat level needed to UNLOCK each isle. */
export const BOAT_REQ = { isle: 0, mine: 1, volcano: 2, frost: 3, neon: 4 };

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
    // 0 = the default hero everyone starts as; anything else is an owned Angler
    // token id, and only /api/nft/equip may set it (after an on-chain check).
    charTokenId: 0,
    /* one-off Pearl Kiosk unlocks (game.js:1604) — flags, not counters:
       `pet` is the Spirit Fish that follows you, `charm` the Lucky Charm that
       re-rolls one losing spin in five. Both are 0/1 and never spent. */
    pet: 0, charm: 0,
    bucketTier: 0,
    bait: {}, baitId: '',
    boosts: { chumUntil: 0 },
    /* wall-clock ms of the last auto-rig catch — the server's own pacing floor
       for the lazy line, so it cannot be run faster than the rig's gapMs */
    autoAt: 0,
    rigLvl: 1,          // everybody owns Mk I; the Kiosk sells the two above it
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

/* Hard ceiling on stored bucket entries. Well above any reachable cap() — this
   only stops a hand-edited row from carrying an unbounded array into memory. */
const BUCKET_HARD_MAX = 64;

/**
 * Rebuild one bucket entry from scratch.
 *
 * Fish are the only free-form objects a save carries into the economy: `sell`
 * reads `.val`, the roulette reads and rewrites `.wins`, and the Fishdex is
 * keyed off `.name`. Copying the row field by field means an edited save can
 * neither smuggle extra properties into a handler nor hand one a `.val` of
 * `"1e9"`, `NaN` or -1.
 *
 * Magnitudes are floored but never capped: a fish that rode six green pockets
 * is legitimately worth a fortune, and clamping it would rewrite the payout
 * table. Returns null for anything too broken to keep.
 */
function normalizeFish(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const name = typeof f.name === 'string' ? f.name.slice(0, 64).trim() : '';
  if (!name) return null;

  const int = (v) => (Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : 0);
  const out = {
    uid: typeof f.uid === 'string' && f.uid ? f.uid.slice(0, 32) : (Date.now() + Math.random()).toString(36),
    name,
    rar: RAR_ORDER.includes(f.rar) ? f.rar : 'common',
    val: int(f.val),
    kg: Number.isFinite(+f.kg) ? Math.max(0, +Math.abs(+f.kg).toFixed(1)) : 0,
    wins: int(f.wins)
  };
  /* shiny is cosmetic here — the ×5 was already banked into `val` when the
     fish was rolled, so re-reading the flag must not multiply it again */
  if (f.shiny) out.shiny = true;
  return out;
}

/**
 * Coerce an untrusted/legacy save row into a valid state.
 * Mirrors the client's load() clamping, but NEVER trusts a field: anything
 * missing or malformed falls back to the newState() default rather than
 * throwing, so one bad row can't lock a player out of their account.
 */
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const st = newState();
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

  st.coins = int0(s.coins);
  st.bucket = Array.isArray(s.bucket)
    ? s.bucket.slice(0, BUCKET_HARD_MAX).map(normalizeFish).filter(Boolean)
    : [];
  const ores = obj(s.ores);
  if (ores) for (const k in st.ores) st.ores[k] = int0(ores[k]);
  const stats = obj(s.stats);
  if (stats) for (const k in st.stats) st.stats[k] = Math.max(0, num(stats[k], 0));
  if (obj(s.dex)) st.dex = s.dex;
  if (obj(s.ach)) st.ach = s.ach;
  /* a map is two grid cells plus the isle it was buried on; the client owns the
     heightmap, so it re-checks the cell is diggable land before showing the X */
  const tr = obj(s.treasure);
  if (tr && Number.isFinite(+tr.i) && Number.isFinite(+tr.j)) {
    st.treasure = {
      i: int0(tr.i),
      j: int0(tr.j),
      w: typeof tr.w === 'string' && has(WORLDS, tr.w) ? tr.w : null
    };
  }
  if (Array.isArray(s.worlds) && s.worlds.length) {
    const w = s.worlds.filter((k) => typeof k === 'string' && has(WORLDS, k));
    if (w.length) st.worlds = [...new Set(w)];
  }
  if (!st.worlds.includes('isle')) st.worlds.unshift('isle');

  const sk = obj(s.stocks);
  if (sk) {
    const own = obj(sk.own);
    if (own) for (const k in own) if (STOCK_TICKERS.has(k)) st.stocks.own[k] = clamp(int0(own[k]), 0, 100);
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

  st.pearls = int0(s.pearls);
  st.pearlsLife = int0(s.pearlsLife);
  /* lifetime pearls can only ever be >= the unspent balance */
  if (st.pearlsLife < st.pearls) st.pearlsLife = st.pearls;
  /* Pearl Kiosk one-offs: truthy means owned, and ownership is never a count */
  st.pet = s.pet ? 1 : 0;
  st.charm = s.charm ? 1 : 0;
  if (obj(s.wardrobe)) st.wardrobe = s.wardrobe;
  if (obj(s.ownedW)) st.ownedW = s.ownedW;
  if (obj(s.ownedT)) st.ownedT = s.ownedT;
  if (obj(s.deeds)) st.deeds = s.deeds;
  st.titleId = typeof s.titleId === 'string' ? s.titleId.slice(0, 40) : '';

  /* Carried through a normalize so an equipped Angler survives a reload, but
     never widened here: this is the sanitiser, not the authority. Ownership is
     re-checked on the chain by /api/nft/equip every time it is set. */
  st.charTokenId = Number.isInteger(s.charTokenId) && s.charTokenId > 0 ? s.charTokenId : 0;
  st.bucketTier = clamp(int0(s.bucketTier), 0, 4);
  const bait = obj(s.bait);
  if (bait) for (const k of BAIT_ORDER) {
    const n = clamp(int0(bait[k]), 0, BAIT_MAX);
    if (n > 0) st.bait[k] = n;
  }
  /* an equipped bait you have none of is the same as no bait at all */
  st.baitId = typeof s.baitId === 'string' && st.bait[s.baitId] > 0 ? s.baitId : '';
  st.tipEpoch = Math.max(0, num(s.tipEpoch, 0));
  st.autoAt = Math.max(0, num(s.autoAt, 0));
  st.rigLvl = clamp(int0(s.rigLvl) || 1, 1, MAX_RIG);
  const boosts = obj(s.boosts);
  if (boosts) st.boosts.chumUntil = Math.max(0, num(boosts.chumUntil, 0));
  st.rodLvl = clamp(int0(s.rodLvl) || 1, 1, MAXLVL);
  st.pickLvl = clamp(int0(s.pickLvl) || 1, 1, MAXLVL);
  st.axeLvl = clamp(int0(s.axeLvl) || 1, 1, MAXLVL);
  st.boatLvl = clamp(int0(s.boatLvl), 0, MAX_BOAT);
  st.world = typeof s.world === 'string' && has(WORLDS, s.world) ? s.world : 'isle';
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

/* ---- THE WORLD CLOCK: time of day and weather -----------------------------
   THE CONTRACT — read it before touching a number below.

   dayPhaseAt() and weatherAt() are pure functions of the wall clock and of
   nothing else: the same ms in gives the same sky out, on every machine, with
   or without a network. That is the whole point of them. The catch roll used
   to take night and weather from the request body, which is not an ambient
   fact at all — it is a +36% raise on every catch for anyone willing to type
   `storm` — while a file:// client with no server still has to know what the
   sky is doing. One clock, derived from Date.now() on both sides, answers both.

   game.js carries a hand-copy of this arithmetic, constant for constant: its
   `dayT` / isNight() and its `wState` weather machine (§14b SKY) read the same
   numbers out of the same wall clock, and the HUD sky readout, the moon, the
   weather toasts, every storm-gated species and the odds card in
   mods/01-angler.js all hang off that. THIS FILE IS THE SOURCE OF TRUTH; the
   client copies it, never the other way round. server/test/parity.test.js
   samples both sides and fails on drift, so a change made here and not
   mirrored there is caught rather than quietly paying the player wrong.

   Everything the client must duplicate is exported and named below — day
   length, night thresholds, weather period, weather salt, the per-world
   weather split, and the world's hash lane (worldSeed/foldKey/hash, above).
   If you add an input to either function, export it here first.
   -------------------------------------------------------------------------- */

/** One in-game day, in ms. The client spells the same span in seconds as
    DAY_LEN = 420, so DAY_MS === DAY_LEN * 1000 and neither may move alone. */
export const DAY_MS = 420000;
/** Night is the tail of the cycle plus its head: the client's isNight() is
    exactly `dayT < NIGHT_END || dayT > NIGHT_START`. */
export const NIGHT_END = 0.13, NIGHT_START = 0.72;

/**
 * Where the wall clock sits in the day cycle.
 * `t` is the client's `dayT` — [0,1), 0 is midnight — and `night` applies the
 * client's isNight() split to it. Same ms in, same answer out, on any machine.
 * The lunar `dayCount` the client draws the moon phase from is the whole part
 * of the same division, Math.floor(ms / DAY_MS), so the moon rides this too.
 * The cave is the one exemption on the client: it has no sky, so game.js pins
 * dayT there rather than reading the clock. Nothing in CAVE_FISH is
 * night-gated, so the roll cannot disagree with what is drawn down there.
 */
export function dayPhaseAt(ms) {
  const t = ((num(ms, 0) / DAY_MS) % 1 + 1) % 1;
  return { t, night: t < NIGHT_END || t > NIGHT_START };
}

/* Weather rides its own tick, slower than a cast and slower than the market's.
   The client used to reroll on a rand(70,160)s timer; a fixed two minutes sits
   in the middle of that window — the sky turns about as often as it always
   did — and is the only cadence both sides can agree on without talking. */
export const WEATHER_MS = 120000;
/** The weather tick the wall clock is in. */
export const weatherEpochNow = () => Math.floor(Date.now() / WEATHER_MS);
/** Keeps the weather lane clear of the market's hash(e, 7) / hash(e, 13). */
export const WEATHER_SALT = 613;

/* ---- the per-world weather split ------------------------------------------
   Thresholds on the [0,1) hash: below `clear` the sky is clear, below `storm`
   it is that world's own `wet` kind, at or above `storm` it storms. The splits
   are the client's own (game.js's weather state machine, which keys them off
   isCold()/isAsh()): frost snows, the volcano throws ash, every other isle
   rains, and all three can storm.
   -------------------------------------------------------------------------- */
export const WEATHER_MIX = {
  frost:   { wet: 'snow', clear: 0.45, storm: 0.85 },
  volcano: { wet: 'ash',  clear: 0.5,  storm: 0.82 }
};
/** Isle, mine, and any key this build does not recognise — the client's `else`
    branch, which is the one that rains. */
export const WEATHER_MIX_DEFAULT = { wet: 'rain', clear: 0.55, storm: 0.88 };
/** The split for a world. Own-property safe, and never null. */
export const weatherMixOf = (world) =>
  (typeof world === 'string' && has(WEATHER_MIX, world) ? WEATHER_MIX[world] : WEATHER_MIX_DEFAULT);

/**
 * The weather over `world` during weather epoch `epoch`, as the client's
 * `wState` string: 'clear' | 'rain' | 'snow' | 'ash' | 'storm'.
 *
 * Each isle rolls on its own hash lane, so two worlds are never handed the
 * same sky by accident, and the split it rolls against is WEATHER_MIX above.
 * The cave has no sky at all — the client forces 'clear' underground, so this
 * does too, and neither side ever draws rain onto stone.
 */
export function weatherAt(world, epoch = weatherEpochNow()) {
  const w = typeof world === 'string' && has(WORLDS, world) ? WORLDS[world] : null;
  if (w && w.cave) return 'clear';
  const e = Math.floor(num(epoch, 0));
  /* the +1 keeps epoch 0 of world `isle` (seed 0) off hash()'s sin(0) === 0 */
  const r = hash(e + 1, worldSeed(world) + WEATHER_SALT);
  const mix = weatherMixOf(world);
  return r < mix.clear ? 'clear' : r < mix.storm ? mix.wet : 'storm';
}

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

/**
 * The condition-filtered table for a world. `minRar` is bait's rarity floor:
 * anything below it is cut from the pool outright. A floor that would empty
 * the pool is ignored rather than obeyed — no world can be made unfishable.
 */
export function fishPool(world = 'isle', env = {}, minRar = null) {
  const w = WORLDS[world];
  const table = (w && w.fish) || TABLE;
  const e = envOf(env);
  const pool = table.filter((entry) => condOK(entry[2], e));
  const floor = RORDER[minRar];
  if (floor == null) return pool;
  const up = pool.filter((entry) => (RORDER[entry[0].rar] | 0) >= floor);
  return up.length ? up : pool;
}

/** Materialize a table entry into a caught-fish object. */
function makeFish(t, mul, auto = false) {
  return {
    uid: (Date.now() + Math.random()).toString(36),
    name: t.name,
    rar: t.rar,
    /* never below 1: an auto-caught sardine is cheap, not free */
    val: Math.max(1, Math.round(t.val * mul * rand(0.85, 1.18) * (auto ? AUTO.val : 1))),
    kg: +(t.val / 9 * rand(0.5, 1.6) + 0.2).toFixed(1),
    wins: 0
  };
}

/**
 * One weighted draw from a world's pool · the client's rollOnce().
 * `luck` re-weights the table by rarity, `minRar` floors it, and `auto` folds
 * the lazy line's rarity multipliers in on top of both.
 * Returns null only if the pool is somehow empty (never, for shipped tables).
 */
export function rollOnce(opts = {}) {
  const { world = 'isle', fishMul, luck = 0, minRar = null, auto = false, rigQ = 1 } = opts;
  const mul = Number.isFinite(+fishMul) ? +fishMul : (WORLDS[world]?.fishMul || 1);
  const pool = fishPool(world, opts, minRar);
  if (!pool.length) return null;

  const wt = pool.map((e) => e[1] * luckWeight(e[0].rar, luck) * (auto ? autoWeight(e[0].rar, rigQ) : 1));
  let tot = 0;
  for (const x of wt) tot += x;
  let r = Math.random() * tot;
  for (let i = 0; i < pool.length; i++) {
    r -= wt[i];
    if (r <= 0) return makeFish(pool[i][0], mul, auto);
  }
  /* floating-point tail: the last entry is the correct answer */
  return makeFish(pool[pool.length - 1][0], mul, auto);
}

/**
 * The full catch roll — the client's rollFish().
 *   - luck (rod ladder + bait) re-weights the table toward the rare end
 *   - bait's rarity floor cuts everything below it out of the pool
 *   - rain/storm grants one extra reroll at p=0.12
 *   - the boat's sea luck grants one more at its own rate
 *   - 1.8% shiny mutation (× the bait's shiny bonus): ×5 value, '✦ ' prefix
 * `fishMul` defaults to the world's multiplier when omitted.
 */
export function rollFish({ rodLvl = 1, bait = null, boatLvl = 0, fishMul,
                           night = false, wet = false, storm = false, world = 'isle',
                           auto = false, rigLvl = 1 } = {}) {
  /* an unattended hook carries no bait, so neither its luck nor its rarity
     floor apply — Siren's Chum cannot be left fishing for legendaries */
  const b = auto ? null : baitOf(bait);
  const opts = {
    world, fishMul, night, wet, storm, auto,
    rigQ: auto ? rigOf(rigLvl).q : 1,
    luck: auto ? rodLuck(rodLvl) * AUTO.luck : fishLuck({ rodLvl, bait }),
    minRar: b ? b.min : null
  };
  let f = rollOnce(opts);
  if (!f) return null;

  /* Weather and hull only stir up better fish for someone holding the rod. The
     lazy line gets one flat draw and no second chances. */
  if (!auto) {
    const e = envOf({ night, wet, storm });
    if ((e.rain || e.storm) && Math.random() < 0.12) {
      const g = rollOnce(opts);
      if (g && RORDER[g.rar] > RORDER[f.rar]) f = g;
    }
    /* a finer ship stirs finer fish (game.js:1726) */
    const bl = (BOATS[clamp(boatLvl | 0, 0, MAX_BOAT)] || BOATS[0]).luck;
    if (bl && Math.random() < bl) {
      const g = rollOnce(opts);
      if (g && RORDER[g.rar] > RORDER[f.rar]) f = g;
    }
  }
  if (Math.random() < 0.018 * (auto ? AUTO.shiny : (b ? b.shiny : 1))) {
    f.shiny = true; f.val *= 5; f.name = '✦ ' + f.name;
  }
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
export function pearlsForFish(fish, { isNew = false, isRecord = false, auto = false } = {}) {
  if (!fish) return 0;
  let pp = PEARL_RARITY[fish.rar] || 1;
  if (fish.shiny) pp *= 3;
  /* the rig earns half the activity points; a first sighting is still a first
     sighting, so the discovery bonuses ride on top untouched */
  if (auto) pp = Math.max(1, Math.floor(pp * AUTO.pearls));
  if (isNew) pp += 5;
  else if (isRecord) pp += 2;
  return pp;
}
