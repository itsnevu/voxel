/* ============================================================================
   progress.js — achievements and Isle Ledger deeds, decided by the SERVER.

   These were evaluated client-side, which meant two things: a hand-edited save
   could hand itself every coin bounty in the table, and an honest player lost
   the lot on any reload the server did not know about. Both tables are ported
   here verbatim from game.js so the wording, thresholds and rewards a player
   already earned stay exactly as they were.

   Contract: evaluate(state) mutates `state` (paying bounties into state.coins,
   stamping state.ach / state.deeds) and returns what just happened so the route
   layer can toast it and broadcast the loud ones.

   Pure functions over state — no db, no express, no sockets.
   ESM, Node 18+.
   ============================================================================ */

import { ALL_FISH, WORLD_ORDER } from './game/rules.js';

/* Species count for the "complete the Fishdex" gates. Derived once: ALL_FISH is
   the union of every world's table, deduped by name, exactly as the client
   builds it. */
const DEX_TOTAL = ALL_FISH.length;

const dexNames = (s) => (s && s.dex && typeof s.dex === 'object') ? Object.keys(s.dex) : [];
const stat = (s, k) => Number(s && s.stats && s.stats[k]) || 0;

/* ---------------------------------------------------------------------------
   ACHIEVEMENTS — [id, name, description, coin reward, test]
   Ported 1:1 from game.js:2322. Reward is paid once, the first time the test
   passes; `ach[id]` then stays truthy forever.
   --------------------------------------------------------------------------- */
export const ACH = [
  ['fish1',    'First Catch',          'catch your first fish',            25,   s => stat(s, 'caught') >= 1],
  ['fish25',   'Angler',               'catch 25 fish',                    100,  s => stat(s, 'caught') >= 25],
  ['fish100',  'Master Angler',        'catch 100 fish',                   300,  s => stat(s, 'caught') >= 100],
  ['fish500',  'Sea Legend',           'catch 500 fish',                   1500, s => stat(s, 'caught') >= 500],
  ['mine10',   'Prospector',           'mine 10 ores',                     50,   s => stat(s, 'mined') >= 10],
  ['mine100',  'Quarry Boss',          'mine 100 ores',                    300,  s => stat(s, 'mined') >= 100],
  ['rich1k',   'First Grand',          'earn 1,000 coins',                 100,  s => stat(s, 'earned') >= 1000],
  ['rich10k',  'Tycoon',               'earn 10,000 coins',                500,  s => stat(s, 'earned') >= 10000],
  ['rich100k', 'Isle Magnate',         'earn 100,000 coins',               3000, s => stat(s, 'earned') >= 100000],
  ['spin10',   'Regular',              'spin the wheel 10 times',          100,  s => stat(s, 'spins') >= 10],
  ['win5',     'Eel Tamer',            'win 5 spins',                      150,  s => stat(s, 'winsCt') >= 5],
  ['big1k',    'High Roller',          'a single win worth 1,000+',        250,  s => stat(s, 'bestWin') >= 1000],
  ['dex5',     'Collector',            '5 species in the Fishdex',         150,  s => dexNames(s).length >= 5],
  ['dexAll',   'Completionist',        'every species in the Fishdex',     2000, s => DEX_TOTAL > 0 && dexNames(s).length >= DEX_TOTAL],
  ['world2',   'Set Sail',             'unlock a second island',           400,  s => (s.worlds || []).length >= 2],
  ['world4',   'Archipelago',          'unlock every island',              5000, s => (s.worlds || []).length >= WORLD_ORDER.length],
  ['boat1',    'Shipwright',           'build your first real boat',       150,  s => (s.boatLvl | 0) >= 1],
  ['boat4',    'Admiral of the Isles', 'launch the Gilded Galleon',        2500, s => (s.boatLvl | 0) >= 4]
];

/* ---------------------------------------------------------------------------
   ISLE LEDGER DEEDS — [id, name, description, test]
   Purely fictional certificates: no wallet, no chain, no resale value. They pay
   no coins; the reward is the certificate itself. `deeds[id]` stores the market
   epoch it was minted at, which the client renders as a "block number".
   --------------------------------------------------------------------------- */
export const DEEDS = [
  ['d_arrive', 'Deed of Arrival',       'first catch or ore on the isle',   s => stat(s, 'caught') + stat(s, 'mined') >= 1],
  ['d_leg',    'Legendary Angler',      'land a legendary fish',            s => dexNames(s).some(hasLegendary)],
  ['d_w2',     'Charter · Great Mine',  'claim the second island',          s => (s.worlds || []).includes('mine')],
  ['d_w3',     'Charter · Cinder Atoll','claim the volcanic isle',          s => (s.worlds || []).includes('volcano')],
  ['d_w4',     'Charter · Frostbite',   'claim the frozen isle',            s => (s.worlds || []).includes('frost')],
  ['d_rod',    "Poseidon's Patent",     'forge the Poseidon Rod',           s => (s.rodLvl | 0) >= 10],
  ['d_pick',   'Titan Mining Rights',   'forge the Titan Pick',             s => (s.pickLvl | 0) >= 10],
  ['d_axe',    "Timber Baron's Seal",   'forge the Titan Axe',              s => (s.axeLvl | 0) >= 10],
  ['d_eel',    'Meme Lord Certificate', 'hold 25+ EEL shares at once',      s => ((s.stocks && s.stocks.own && s.stocks.own.EEL) | 0) >= 25],
  ['d_div',    'Dividend Baron',        'collect 1,000 in dividends',       s => stat(s, 'divEarned') >= 1000],
  ['d_win',    'Whale of the Eel',      'win 2,500+ on a single spin',      s => stat(s, 'bestWin') >= 2500],
  ['d_dex',    'Master of the Dex',     'complete the entire Fishdex',      s => DEX_TOTAL > 0 && dexNames(s).length >= DEX_TOTAL]
];

/* The two id namespaces, as sets. /api/save merges a legacy client's trophy
   blob into the server's state, and the ledger claim route HMAC-signs whatever
   deed ids it finds there — so the merge has to be able to ask whether an id is
   one of ours, not merely whether it looks like one. */
export const ACH_IDS = new Set(ACH.map(e => e[0]));
export const DEED_IDS = new Set(DEEDS.map(e => e[0]));

/* A name in the dex is legendary if any world's table lists it as such. */
const LEGENDARY = new Set(
  ALL_FISH.filter(e => e && e[0] && e[0].rar === 'legendary').map(e => e[0].name)
);
function hasLegendary(name) {
  /* shiny catches are stored under the plain name, but be forgiving either way */
  return LEGENDARY.has(name) || LEGENDARY.has(String(name).replace(/^✦\s*/, ''));
}

/* The deeds a client should treat as loud enough to announce to the room. */
const LOUD_DEEDS = new Set(['d_leg', 'd_dex', 'd_win', 'd_eel', 'd_w4']);

/**
 * Evaluate both tables against a state, paying and stamping anything newly
 * earned. Safe to call after every action: an already-earned id is skipped, so
 * a bounty is never paid twice however often this runs.
 *
 * @param {object} state  mutated in place
 * @param {number} epoch  current market epoch, stamped into new deeds
 * @returns {{ach:Array<{id,name,reward}>, deeds:Array<{id,name,loud}>, coins:number}}
 */
export function evaluate(state, epoch) {
  const out = { ach: [], deeds: [], coins: 0 };
  if (!state || typeof state !== 'object') return out;

  if (!state.ach || typeof state.ach !== 'object') state.ach = {};
  if (!state.deeds || typeof state.deeds !== 'object') state.deeds = {};
  if (!state.stats || typeof state.stats !== 'object') state.stats = {};

  for (const [id, name, , reward, test] of ACH) {
    if (state.ach[id]) continue;
    let hit = false;
    try { hit = !!test(state); } catch { hit = false; }   // a torn save must not 500 an action
    if (!hit) continue;
    state.ach[id] = 1;
    const pay = Math.max(0, reward | 0);
    if (pay) {
      state.coins = (Number(state.coins) || 0) + pay;
      state.stats.earned = (Number(state.stats.earned) || 0) + pay;
      out.coins += pay;
    }
    out.ach.push({ id, name, reward: pay });
  }

  const stamp = Number.isFinite(epoch) ? Math.trunc(epoch) : 0;
  for (const [id, name, , test] of DEEDS) {
    if (state.deeds[id]) continue;
    let hit = false;
    try { hit = !!test(state); } catch { hit = false; }
    if (!hit) continue;
    state.deeds[id] = stamp;
    out.deeds.push({ id, name, loud: LOUD_DEEDS.has(id) });
  }

  return out;
}

/** Total counts, handy for /api/state and the admin console. */
export function progressOf(state) {
  const ach = state && state.ach ? Object.keys(state.ach).length : 0;
  const deeds = state && state.deeds ? Object.keys(state.deeds).length : 0;
  return { ach, achTotal: ACH.length, deeds, deedTotal: DEEDS.length };
}
