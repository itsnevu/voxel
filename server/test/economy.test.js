/* ============================================================================
   economy.test.js — the parts of the game that must give the same answer twice.

   No server here: economy.js, rules.js and the actions.js handlers are pure, and
   that purity is the whole security argument. The client draws a stock chart
   from the same `hash`/`vnoise` the server settles trades with, and it derives
   an ore node's type from the same two integers — so "deterministic" is not a
   nice property, it is the reason the client can be trusted to render prices at
   all.

   The five things being pinned down:
     - a price is a function of (ticker, epoch) and nothing else
     - an ore node's type is a function of (world, node id) and nothing else
     - a dividend quarter is paid exactly once, and a mangled save is repaired
       rather than replaced
     - the roulette keeps a house edge on every bet, charm or no charm
     - a credit to a huge balance saturates instead of wrapping negative
   ========================================================================== */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MKT_CATS, MKT_MS, mktEpochNow, mktModsAt, priceMult,
  STOCKS, STOCK_KEYS, STOCK_CAP, DIV_Q,
  stockPrice, stockAsk, stockBid, quoteAll, portfolioValue,
  grantShare, payDividends, isTicker,
} from '../src/game/economy.js';

import {
  hash, oreTypeFor, rollOreType, normalizeState, newState,
  WORLDS, MAXLVL, MAX_BOAT,
} from '../src/game/rules.js';

import { HANDLERS } from '../src/game/actions.js';

const QUARTER_MS = MKT_MS * DIV_Q;

/* ============================================================================
   THE EXCHANGE
   ========================================================================== */

describe('stock prices are a pure function of the epoch', () => {
  const EPOCHS = Array.from({ length: 240 }, (_, i) => mktEpochNow() - 120 + i);

  it('gives byte-identical quotes on a second pass', () => {
    const first = EPOCHS.map((e) => STOCK_KEYS.map((k) => stockPrice(k, e)));
    /* churn the global PRNG in between: a price that moved because of this
       would mean the client could never predict what it will be charged */
    for (let i = 0; i < 1000; i++) Math.random();
    const second = EPOCHS.map((e) => STOCK_KEYS.map((k) => stockPrice(k, e)));
    assert.deepEqual(second, first);
  });

  it('quotes whole coins, never below 1, and never inverts the spread', () => {
    for (const e of EPOCHS) {
      for (const k of STOCK_KEYS) {
        const price = stockPrice(k, e);
        assert.ok(Number.isInteger(price), `${k}@${e} priced ${price}`);
        assert.ok(price >= 1);

        const ask = stockAsk(k, e);
        const bid = stockBid(k, e);
        assert.ok(Number.isInteger(ask) && Number.isInteger(bid));
        assert.ok(bid >= 1, `${k}@${e} bid ${bid}`);
        assert.ok(ask > bid, `${k}@${e} spread inverted: ask ${ask} <= bid ${bid}`);
        /* the spread always costs the player: you buy above the mid and sell
           at or below it (a 1-coin quote floors the bid at 1 rather than 0) */
        assert.ok(ask > price, `${k}@${e} ask ${ask} not above mid ${price}`);
        assert.ok(bid <= price, `${k}@${e} bid ${bid} above mid ${price}`);
      }
    }
  });

  it('actually moves — a frozen price would make the market decoration', () => {
    for (const k of STOCK_KEYS) {
      const distinct = new Set(EPOCHS.map((e) => stockPrice(k, e)));
      assert.ok(distinct.size > 5, `${k} only ever quoted ${distinct.size} value(s)`);
    }
  });

  it('answers 0 for anything that is not a ticker', () => {
    const e = mktEpochNow();
    for (const k of ['NOPE', '', 'digg', 'REELL', 'reel']) {
      assert.equal(isTicker(k), false, `${k} must not be tradeable`);
      assert.equal(stockPrice(k, e), 0);
    }
    for (const k of STOCK_KEYS) assert.equal(isTicker(k), true);
  });

  it('isTicker is the own-property guard every call site must use', () => {
    /* KNOWN GAP, deliberately pinned rather than papered over: stockPrice()
       reaches STOCKS[k] with a plain index, so an inherited key answers
       truthily and the function throws on `s.cats`. isTicker() does the
       hasOwnProperty test properly, and every current caller gates on it (or
       on STOCK_KEYS) BEFORE pricing — which is why no route can reach this.
       If economy.js ever grows an ungated call site, the guard below is the
       thing that has to move into stockPrice() itself. */
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(isTicker(k), false, `${k} must never look like a ticker`);
      assert.equal(STOCK_KEYS.includes(k), false);
      assert.equal(grantShare(newState(), k).granted, false, `${k} minted a share`);
    }
  });

  it('hands the client the same numbers quoteAll() claims', () => {
    const e = mktEpochNow();
    const quote = quoteAll(e);
    assert.equal(quote.epoch, e);
    assert.deepEqual(quote.mods, mktModsAt(e));
    for (const k of STOCK_KEYS) {
      assert.equal(quote.stocks[k].price, stockPrice(k, e));
      assert.equal(quote.stocks[k].prev, stockPrice(k, e - 1));
      assert.equal(quote.stocks[k].ask, stockAsk(k, e));
      assert.equal(quote.stocks[k].bid, stockBid(k, e));
    }
  });

  it('values a portfolio at the bid', () => {
    const e = mktEpochNow();
    const state = newState();
    state.stocks.own = { REEL: 3, HARB: 2 };
    state.stocks.basis = { REEL: 10, HARB: 100 };
    const { value, cost } = portfolioValue(state, e);
    assert.equal(value, 3 * stockBid('REEL', e) + 2 * stockBid('HARB', e));
    assert.equal(cost, 3 * 10 + 2 * 100);
  });
});

describe('the rotating market', () => {
  it('picks one hot and one surplus category per epoch, forever consistently', () => {
    const now = mktEpochNow();
    for (let e = now - 500; e <= now + 500; e++) {
      const a = mktModsAt(e);
      const b = mktModsAt(e);
      assert.deepEqual(a, b);
      assert.ok(MKT_CATS.includes(a.hot), `bad hot ${a.hot} at ${e}`);
      assert.ok(MKT_CATS.includes(a.cold), `bad cold ${a.cold} at ${e}`);
      assert.notEqual(a.hot, a.cold, `hot and cold collided at ${e}`);
    }
  });

  it('prices a category by its standing in that epoch', () => {
    const now = mktEpochNow();
    for (let e = now - 50; e <= now + 50; e++) {
      const { hot, cold } = mktModsAt(e);
      for (const cat of MKT_CATS) {
        const expected = cat === hot ? 1.6 : cat === cold ? 0.75 : 1;
        assert.equal(priceMult(cat, e), expected, `${cat} at epoch ${e}`);
      }
    }
  });

  it('reads the wall clock the same way the client does', () => {
    const mine = Math.floor(Date.now() / MKT_MS);
    assert.ok(Math.abs(mktEpochNow() - mine) <= 1);
  });
});

/* ============================================================================
   ORE NODES
   ========================================================================== */

describe('oreTypeFor is stable', () => {
  const MINEABLE = ['coal', 'iron', 'gold', 'diamond'];

  it('gives one node the same ore every single time', () => {
    for (const world of Object.keys(WORLDS)) {
      const quarry = WORLDS[world].oreN | 0;
      for (let id = 0; id < quarry + 4; id++) {
        const a = oreTypeFor(world, id);
        assert.ok(MINEABLE.includes(a), `${world}#${id} produced ${a}`);
        /* stir the PRNG: a keyed node must not be a roll in disguise */
        for (let i = 0; i < 20; i++) Math.random();
        assert.equal(oreTypeFor(world, id), a, `${world}#${id} drifted`);
        assert.equal(oreTypeFor(world, String(id)), a, `${world}#"${id}" disagreed`);
      }
    }
  });

  it('keeps the grass starter nodes to coal and iron on every isle', () => {
    /* Ids at or past the quarry count are the starters the client scatters
       near spawn. Both sides must agree, or a player breaks open a coal rock
       and is handed a diamond. */
    for (const world of Object.keys(WORLDS)) {
      const quarry = WORLDS[world].oreN | 0;
      for (let id = quarry; id < quarry + 12; id++) {
        const type = oreTypeFor(world, id);
        assert.ok(type === 'coal' || type === 'iron', `${world}#${id} starter gave ${type}`);
      }
    }
    /* Fortune Isle has no quarry at all, so every node it has is a starter */
    for (let id = 0; id < 4; id++) {
      assert.ok(['coal', 'iron'].includes(oreTypeFor('isle', id)));
    }
  });

  it('gives each world its own lane', () => {
    const quarry = WORLDS.cave.oreN | 0;
    const cave = [];
    const volcano = [];
    for (let id = 0; id < quarry; id++) {
      cave.push(oreTypeFor('cave', id));
      volcano.push(oreTypeFor('volcano', id));
    }
    assert.notDeepEqual(cave, volcano, 'two worlds produced an identical vein map');
  });

  it('survives ids that were never meant to be node ids', () => {
    const odd = ['__proto__', 'constructor', '', 'abc', {}, null, undefined,
      1.5, -7, 1e12, Number.NaN, Number.POSITIVE_INFINITY];
    for (const id of odd) {
      const a = oreTypeFor('mine', id);
      assert.ok(MINEABLE.includes(a), `id ${String(id)} produced ${a}`);
      assert.equal(oreTypeFor('mine', id), a, `id ${String(id)} was not stable`);
    }
    /* an unrecognised world still gets a lane rather than throwing */
    assert.ok(MINEABLE.includes(oreTypeFor('__proto__', 3)));
    assert.ok(MINEABLE.includes(oreTypeFor(undefined, 3)));
  });

  it('rolls a blind node on the documented 40/30/20/10 split', () => {
    /* Exact thresholds rather than a sample: coal < .4 <= iron < .7 <= gold
       < .9 <= diamond. Substituting Math.random keeps this deterministic. */
    const real = Math.random;
    try {
      const table = [
        [0, 'coal'], [0.399999, 'coal'],
        [0.4, 'iron'], [0.699999, 'iron'],
        [0.7, 'gold'], [0.899999, 'gold'],
        [0.9, 'diamond'], [0.999999, 'diamond'],
      ];
      for (const [r, expected] of table) {
        Math.random = () => r;
        assert.equal(rollOreType(), expected, `r=${r}`);
      }
    } finally {
      Math.random = real;
    }
  });
});

/* ============================================================================
   DIVIDENDS
   ========================================================================== */

/** The payout economy.js should compute for `own` over quarters [from..to]. */
function expectedDividends(own, from, to) {
  let total = 0;
  for (let d = from; d <= to; d++) {
    for (const k of STOCK_KEYS) {
      const n = own[k] | 0;
      if (!n) continue;
      const s = STOCKS[k];
      if (!s.yield || hash(d, s.salt + 77) <= 0.25) continue;
      total += n * Math.ceil(stockPrice(k, d * DIV_Q) * s.yield);
    }
  }
  return total;
}

/** A minimal save carrying a portfolio and nothing else. */
function holder(own, lastDiv, coins = 1000) {
  return {
    coins,
    stats: { earned: 0, divEarned: 0 },
    stocks: { own: { ...own }, basis: {}, lastDiv, lastShareEpoch: 0, gotFirst: 0 },
  };
}

describe('dividends are paid once per quarter', () => {
  const OWN = { HARB: 4, LUMB: 7, DIGG: 3 };

  it('pays every owed quarter, then nothing at all', () => {
    const dNow = Math.floor(Date.now() / QUARTER_MS);

    /* Pick a window that genuinely pays: 25% of quarters the board retains
       earnings, so a fixed window could legitimately be worth zero and the
       test would prove nothing. */
    let from = dNow;
    while (from > dNow - 40 && expectedDividends(OWN, from, dNow) === 0) from--;
    const expected = expectedDividends(OWN, from, dNow);
    assert.ok(expected > 0, 'no quarter in the last 40 paid anything — cannot test');

    const state = holder(OWN, from - 1);
    const paid = payDividends(state);

    assert.equal(paid, expected);
    assert.equal(state.coins, 1000 + expected);
    assert.equal(state.stats.earned, expected);
    assert.equal(state.stats.divEarned, expected);
    assert.equal(state.stocks.lastDiv, dNow);

    /* The route layer calls payDividends() on EVERY request. Hammering it must
       not print a single extra coin. */
    for (let i = 0; i < 5; i++) assert.equal(payDividends(state), 0);
    assert.equal(state.coins, 1000 + expected);
    assert.equal(state.stats.earned, expected);
  });

  it('caps offline catch-up at 24 quarters', () => {
    const dNow = Math.floor(Date.now() / QUARTER_MS);
    const state = holder(OWN, dNow - 500);
    const paid = payDividends(state);

    assert.equal(paid, expectedDividends(OWN, dNow - 23, dNow));
    assert.equal(state.stocks.lastDiv, dNow);
    /* a year-old save must not out-earn a day-old one */
    assert.ok(paid <= expectedDividends(OWN, dNow - 23, dNow));
  });

  it('snaps a save from the future forward and pays it nothing', () => {
    const dNow = Math.floor(Date.now() / QUARTER_MS);
    const state = holder(OWN, dNow + 100);

    assert.equal(payDividends(state), 0);
    assert.equal(state.coins, 1000);
    assert.equal(state.stocks.lastDiv, dNow);
    /* and it stays snapped rather than paying out on the next call */
    assert.equal(payDividends(state), 0);
    assert.equal(state.coins, 1000);
  });

  it('gives a brand new portfolio no free catch-up', () => {
    const dNow = Math.floor(Date.now() / QUARTER_MS);
    /* lastDiv null (never paid) must read as "start the clock now", not as
       quarter 0 — which is 1970 and would look like 24 quarters owed. */
    const state = holder(OWN, null);
    assert.equal(payDividends(state), 0);
    assert.equal(state.stocks.lastDiv, dNow);

    const fresh = normalizeState({ stocks: { own: { HARB: 100 } } });
    assert.equal(fresh.stocks.lastDiv, null);
    assert.equal(payDividends(fresh), 0);
    assert.equal(fresh.coins, 0);
  });

  it('ignores states with nothing to pay', () => {
    const dNow = Math.floor(Date.now() / QUARTER_MS);
    assert.equal(payDividends(null), 0);
    assert.equal(payDividends('nope'), 0);
    assert.equal(payDividends({}), 0);

    const empty = holder({}, dNow - 30);
    assert.equal(payDividends(empty), 0);
    assert.equal(empty.coins, 1000);
    assert.equal(empty.stocks.lastDiv, dNow);
  });
});

describe('dropped share certificates', () => {
  it('drops at most one per market epoch', () => {
    const state = newState();
    const first = grantShare(state, 'REEL');
    assert.equal(first.granted, true);
    assert.equal(state.stocks.own.REEL, 1);
    assert.equal(state.stocks.lastShareEpoch, mktEpochNow());

    /* the pity cap: a player spamming catch/mine cannot farm certificates */
    for (let i = 0; i < 20; i++) {
      assert.equal(grantShare(state, 'REEL').granted, false);
      assert.equal(grantShare(state, 'DIGG').granted, false);
    }
    assert.equal(state.stocks.own.REEL, 1);
    assert.equal(state.stocks.own.DIGG, undefined);
  });

  it('liquidates at the bid once the position is capped', () => {
    const state = newState();
    state.stocks.own.EEL = STOCK_CAP;
    const drop = grantShare(state, 'EEL');

    assert.equal(drop.granted, true);
    assert.equal(drop.full, true);
    assert.equal(state.stocks.own.EEL, STOCK_CAP, 'the cap must hold');
    assert.equal(state.coins, drop.soldFor);
    assert.ok(drop.soldFor >= 1);
  });

  it('refuses tickers that do not exist', () => {
    const state = newState();
    for (const k of ['NOPE', '__proto__', '', null, 7]) {
      assert.equal(grantShare(state, k).granted, false);
    }
    assert.equal(grantShare(null, 'REEL').granted, false);
    assert.deepEqual(state.stocks.own, {});
  });
});

/* ============================================================================
   BIG NUMBERS — a credit must never be able to bankrupt someone
   ========================================================================== */

describe('a credit to a huge balance saturates instead of wrapping', () => {
  /* Past 2^31-1 and still an exact integer in a double. Reachable: a Frostbite
     legendary that has ridden a few green pockets sells for eight figures. */
  const NEAR_MAX = 3_000_000_000;
  const I32_MAX = 2 ** 31 - 1;

  it('is the ToInt32 wrap that this is defending against', () => {
    /* The bug in one line, kept here so the assertions below have something to
       be compared against: `| 0` turns a three-billion purse negative, and the
       loader then reads a negative balance as no balance at all. */
    assert.ok((NEAR_MAX | 0) < 0);
    assert.equal(normalizeState({ coins: (NEAR_MAX | 0) + 90 }).coins, 0);
  });

  it('keeps a fortune whole when a full portfolio liquidates into it', () => {
    const state = newState();
    state.coins = NEAR_MAX;
    state.stocks.own.EEL = STOCK_CAP;

    const drop = grantShare(state, 'EEL');
    assert.equal(drop.granted, true);
    assert.ok(drop.soldFor >= 1);
    assert.equal(state.coins, NEAR_MAX + drop.soldFor);
    assert.ok(state.coins > I32_MAX, 'the credit wrapped');

    /* and the balance survives the trip through the loader, which is where a
       wrapped negative would have been floored to zero */
    const reloaded = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(reloaded.coins, state.coins);
  });

  it('keeps a fortune whole when a dividend quarter pays out', () => {
    const own = { HARB: 100, LUMB: 100, DIGG: 100 };
    const dNow = Math.floor(Date.now() / QUARTER_MS);

    /* the board retains earnings a quarter in four, so walk back to a window
       that genuinely pays rather than trusting a fixed one */
    let from = dNow;
    while (from > dNow - 40 && expectedDividends(own, from, dNow) === 0) from--;
    const expected = expectedDividends(own, from, dNow);
    assert.ok(expected > 0, 'no quarter in the last 40 paid anything — cannot test');

    const state = holder(own, from - 1, NEAR_MAX);
    assert.equal(payDividends(state), expected);
    assert.equal(state.coins, NEAR_MAX + expected);
    assert.ok(state.coins > I32_MAX, 'the credit wrapped');
    assert.equal(state.stats.earned, expected);

    const reloaded = normalizeState(JSON.parse(JSON.stringify(state)));
    assert.equal(reloaded.coins, state.coins);
    assert.ok(reloaded.coins > 0, 'a wrapped balance normalises to nothing on the next load');
  });

  it('keeps a fortune whole when the wheel pays out', () => {
    const state = newState();
    state.coins = NEAR_MAX;
    state.rodLvl = MAXLVL;                 // the top chip needs the Poseidon Rod

    const STAKE = 5000;                    // the largest rung of the coin ladder
    let wins = 0;
    for (let i = 0; i < 200 && wins < 3; i++) {
      const before = state.coins;
      const out = HANDLERS.spin(state, { bet: 'red', coinStake: STAKE });
      assert.equal(out.ok, true, out.error);
      assert.ok(state.coins > I32_MAX, `balance fell to ${state.coins}`);
      if (out.result.won) { wins++; assert.equal(state.coins, before + STAKE); }
    }
    assert.ok(wins >= 3, 'red never came up in 200 spins');
    assert.ok(normalizeState(JSON.parse(JSON.stringify(state))).coins > I32_MAX);
  });
});

/* ============================================================================
   THE SPINNING EEL — the house has to win
   ========================================================================== */

describe('the roulette pays back less than it takes', () => {
  /* The wheel is drawn from crypto.randomInt, which nothing here can seed, so
     this is a sampled expected value rather than an enumerated one. The sample
     is sized off the variance of the worst case (green: 14x on 1 pocket in 15,
     sd ~3.5 per unit staked), so 200k spins put the analytic mean about eight
     standard errors clear of 1.0. Anything that genuinely inverts an edge moves
     the mean by 0.04 or more and fails every time, not one run in twenty. */
  const SPINS = 200_000;
  const STAKE = 50;                        // on COIN_STAKES and inside a Lv.1 rod's cap

  /* 15 pockets: 7 red, 7 black, 1 green. Every outside bet wins 7 of 15 at 2x
     and green wins 1 of 15 at 14x, so the bare wheel pays back 14/15 either
     way. The charm re-rolls one losing outside spin in twenty, which lifts the
     win rate from p to p + (1-p)/20*p — and is excluded from green, because a
     14x pocket that gets a second look is the one bet a re-roll turns
     profitable. Those two numbers are the whole house edge. */
  const P_OUTSIDE = 7 / 15;
  const EV_BARE = 2 * P_OUTSIDE;                                   // 0.9333
  const EV_CHARM = 2 * (P_OUTSIDE + (1 - P_OUTSIDE) / 20 * P_OUTSIDE); // 0.9582
  const EV_GREEN = 14 * (1 / 15);                                  // 0.9333

  /** Total returned per coin staked over SPINS spins of one bet kind. */
  function expectedValue(bet, charm) {
    const state = newState();
    state.charm = charm ? 1 : 0;
    /* park the share pity-cap in the far future: a green jackpot also rolls a
       certificate, and a full portfolio would liquidate it into `coins` and
       quietly inflate a measurement of the wheel */
    state.stocks.lastShareEpoch = 1e12;

    let gross = 0;
    for (let i = 0; i < SPINS; i++) {
      state.coins = STAKE;                 // exactly one chip, so nothing can be staked twice
      const out = HANDLERS.spin(state, { bet, coinStake: STAKE });
      assert.equal(out.ok, true, out.error);
      gross += out.result.payout;
    }
    return gross / (SPINS * STAKE);
  }

  for (const bet of ['red', 'black', 'green', 'odd', 'even', 'high']) {
    it(`keeps an edge on ${bet}, charm or no charm`, () => {
      const bare = expectedValue(bet, false);
      const charmed = expectedValue(bet, true);

      assert.ok(bare < 1, `${bet} pays ${bare.toFixed(4)} per coin with no charm`);
      assert.ok(charmed < 1, `${bet} pays ${charmed.toFixed(4)} per coin WITH the Lucky Charm`);

      const expectBare = bet === 'green' ? EV_GREEN : EV_BARE;
      const expectCharm = bet === 'green' ? EV_GREEN : EV_CHARM;
      assert.ok(Math.abs(bare - expectBare) < 0.05,
        `${bet} bare paid ${bare.toFixed(4)}, expected ~${expectBare.toFixed(4)}`);
      assert.ok(Math.abs(charmed - expectCharm) < 0.05,
        `${bet} charmed paid ${charmed.toFixed(4)}, expected ~${expectCharm.toFixed(4)}`);

      /* the charm has to be worth its 600 pearls without being worth more than
         the table — except on green, which it must not touch at all */
      if (bet === 'green') {
        assert.ok(Math.abs(charmed - bare) < 0.08,
          `the charm moved green from ${bare.toFixed(4)} to ${charmed.toFixed(4)}`);
      } else {
        assert.ok(charmed > bare,
          `the charm did nothing for ${bet}: ${bare.toFixed(4)} -> ${charmed.toFixed(4)}`);
      }
    });
  }
});

/* ============================================================================
   normalizeState — repair, never replace
   ========================================================================== */

describe('normalizeState rescues a broken save', () => {
  it('keeps the progress and fixes only what is malformed', () => {
    const raw = {
      coins: '5000',                       // a string that means 5000
      pearls: 40, pearlsLife: 3,           // lifetime below the balance: impossible
      rodLvl: 999, pickLvl: 0, axeLvl: -4, boatLvl: 99,
      ores: { wood: '12', coal: -5, iron: 3.9, gold: null, diamond: 2, uranium: 100 },
      bucket: 'not an array',
      worlds: ['isle', 'mine', '__proto__', 'atlantis', 'mine'],
      world: 'frost',                      // owned? no. so it must not stick
      dex: { Tuna: { n: 12, best: 9.4 } },
      ach: { firstFish: 1, allDex: 1 },
      stats: { caught: 40, mined: 12, earned: 90_000, bogus: 5 },
      bucketTier: 99,
      titleId: 'Isle Legend',
      tipEpoch: -3,
      bait: { worm: 5, siren: 99_999, nonsense: 4 },
      baitId: 'squid',                     // owns none: the hook must come up bare
      treasure: { i: '5', j: 2.7, w: 'nowhere' },
      pet: 'yes', charm: 0,
    };

    const s = normalizeState(raw);

    /* --- progress survives --- */
    assert.equal(s.coins, 5000);
    assert.equal(s.ores.wood, 12);
    assert.equal(s.ores.diamond, 2);
    assert.deepEqual(s.dex, { Tuna: { n: 12, best: 9.4 } });
    assert.deepEqual(s.ach, { firstFish: 1, allDex: 1 });
    assert.equal(s.stats.caught, 40);
    assert.equal(s.stats.earned, 90_000);
    assert.deepEqual(s.worlds, ['isle', 'mine']);
    assert.equal(s.titleId, 'Isle Legend');
    assert.equal(s.bait.worm, 5);

    /* --- and the nonsense is clamped, not obeyed --- */
    assert.equal(s.rodLvl, MAXLVL);
    assert.equal(s.pickLvl, 1);
    assert.equal(s.axeLvl, 1);
    assert.equal(s.boatLvl, MAX_BOAT);
    assert.equal(s.ores.coal, 0);
    assert.equal(s.ores.iron, 3);
    assert.equal(s.ores.gold, 0);
    assert.equal(s.ores.uranium, undefined, 'an invented ore must not enter the ledger');
    assert.deepEqual(s.bucket, []);
    assert.equal(s.world, 'isle', 'an unowned isle in `world` would be a free teleport');
    assert.equal(s.bucketTier, 4);
    assert.equal(s.tipEpoch, 0);
    assert.equal(s.bait.siren, 999);
    assert.equal(s.bait.nonsense, undefined);
    assert.equal(s.baitId, '');
    assert.equal(s.pearlsLife, 40, 'lifetime pearls can never sit below the balance');
    assert.equal(s.pet, 1);
    assert.equal(s.charm, 0);
    assert.equal(s.stats.bogus, undefined);
    assert.deepEqual(s.treasure, { i: 5, j: 2, w: 'isle' });
    assert.equal(s.v, newState().v);
  });

  it('rebuilds every fish rather than trusting one', () => {
    const s = normalizeState({
      bucket: [
        { name: '  Tuna  ', rar: 'mythical', val: '82.9', kg: -4.26, wins: 2.9, payout: 1e9 },
        { name: 'Star Koi', rar: 'legendary', val: 620, kg: 40, wins: 1, shiny: true },
        null,
        { rar: 'epic', val: 999 },                       // nameless: dropped
        'a fish',
      ],
    });

    assert.equal(s.bucket.length, 2);

    const tuna = s.bucket[0];
    assert.deepEqual(Object.keys(tuna).sort(), ['kg', 'name', 'rar', 'uid', 'val', 'wins']);
    assert.equal(tuna.name, 'Tuna');
    assert.equal(tuna.rar, 'common', 'an unknown rarity falls back, it does not pass through');
    assert.equal(tuna.val, 82);
    assert.equal(tuna.kg, 4.3);
    assert.equal(tuna.wins, 2);
    assert.equal(tuna.payout, undefined, 'a smuggled field must not reach a handler');

    assert.equal(s.bucket[1].shiny, true);
    assert.equal(s.bucket[1].val, 620, 'shiny is cosmetic here — the x5 was banked at roll time');
  });

  it('caps a hand-edited bucket instead of loading it whole', () => {
    const huge = Array.from({ length: 500 }, (_, i) => ({ name: `Fish${i}`, rar: 'common', val: 1 }));
    const s = normalizeState({ bucket: huge });
    assert.equal(s.bucket.length, 64);
  });

  it('saturates huge numbers instead of wrapping them negative', () => {
    /* `x | 0` is ToInt32 and silently wraps past 2^31: 4294967296 would read
       back as 0 and 2147483648 as negative. */
    const s = normalizeState({ pearls: 4_294_967_296, coins: 2_147_483_648 });
    assert.equal(s.pearls, 4_294_967_296);
    assert.equal(s.coins, 2_147_483_648);
    assert.ok(s.coins > 0 && s.pearls > 0);
  });

  it('drops invented tickers and clamps real ones', () => {
    /* JSON.parse rather than an object literal on purpose: `__proto__` in a
       literal sets the prototype, while a parsed save carries it as a real own
       key — which is exactly the shape an attacker would post. */
    const raw = JSON.parse(`{
      "stocks": {
        "own":   { "REEL": 500, "DIGG": -3, "MOON": 10, "__proto__": 5 },
        "basis": { "REEL": 42, "MOON": 1, "DIGG": -1 },
        "lastDiv": "soon",
        "gotFirst": "yes"
      }
    }`);
    const s = normalizeState(raw);

    assert.equal(Object.prototype.hasOwnProperty.call(s.stocks.own, '__proto__'), false);
    assert.equal(s.stocks.own.REEL, STOCK_CAP);
    assert.equal(s.stocks.own.DIGG, 0);
    assert.equal(s.stocks.own.MOON, undefined);
    assert.equal(s.stocks.basis.REEL, 42);
    assert.equal(s.stocks.basis.MOON, undefined);
    assert.equal(s.stocks.basis.DIGG, undefined, 'a non-positive basis is not a basis');
    assert.equal(s.stocks.lastDiv, null, 'an unusable lastDiv must stay null, never become 0');
    assert.equal(s.stocks.gotFirst, 1);
  });

  it('always returns a playable save, whatever it was handed', () => {
    for (const raw of [null, undefined, 0, 'save', [], [1, 2, 3], true]) {
      const s = normalizeState(raw);
      assert.equal(s.world, 'isle');
      assert.deepEqual(s.worlds, ['isle']);
      assert.equal(s.coins, 0);
      assert.equal(s.rodLvl, 1);
      assert.deepEqual(s.bucket, []);
      assert.equal(s.stocks.lastDiv, null);
    }
  });

  it('is idempotent — normalising twice changes nothing', () => {
    const once = normalizeState({
      coins: 1234, rodLvl: 4, worlds: ['isle', 'mine'], world: 'mine',
      bucket: [{ name: 'Koi', rar: 'rare', val: 130, kg: 12, wins: 0, uid: 'abc' }],
      stocks: { own: { REEL: 2 }, basis: { REEL: 40 }, lastDiv: 7 },
      stats: { caught: 3 },
    });
    const twice = normalizeState(JSON.parse(JSON.stringify(once)));
    assert.deepEqual(twice, once);
  });
});
