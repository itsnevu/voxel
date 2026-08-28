/* ============================================================================
   events.test.js — the two clock-driven multiplayer events.

   events.js has no database and no I/O: a derby is a Map keyed by the hour and
   a wanted poster is a pure function of (world, market epoch). That makes both
   testable exactly, with one caveat — recordCatch(), sweepDerbies() and
   tryClaimWanted() all read the wall clock themselves. So the clock is
   substituted for the length of each call and restored in a `finally`, which
   lets a test stand inside a derby window, step past its close, and watch the
   payout happen once.

   Every test claims its own hour and its own market epoch (the cursors below),
   because the module's maps outlive individual tests.
   ========================================================================== */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { derbyInfo, recordCatch, sweepDerbies, wantedFor, tryClaimWanted } from '../src/events.js';
import { MKT_MS, mktEpochNow } from '../src/game/economy.js';
import { WORLDS, TABLE } from '../src/game/rules.js';

const HOUR = MKT_MS * 20;            // events.js: 20 market epochs
const DERBY_MS = 10 * 60 * 1000;     // the window: minutes 0-10 of every hour
const DERBY_PEARLS = 150;

/* ---- clock control -------------------------------------------------------- */

const realNow = Date.now;

/** Run `fn` with the wall clock pinned to `t`. Always restores. */
function at(t, fn) {
  Date.now = () => t;
  try { return fn(); } finally { Date.now = realNow; }
}

/* Hours and epochs far enough ahead that no test can inherit another's state.
   Each helper hands out a fresh, unshared slot. */
let hourCursor = Math.floor(realNow() / HOUR) + 10_000;
const nextHourStart = () => (hourCursor += 10) * HOUR;

let epochCursor = Math.floor(realNow() / MKT_MS) + 100_000;
const nextEpochTime = () => (epochCursor += 5) * MKT_MS + 1000;

/** Collect every payout one sweep hands out. */
function sweepAt(t) {
  const paid = [];
  at(t, () => sweepDerbies((w) => paid.push(w)));
  return paid;
}

/* ============================================================================
   THE DERBY CLOCK
   ========================================================================== */

describe('derbyInfo', () => {
  it('reports the window it is standing in', () => {
    const start = nextHourStart();
    const id = start / HOUR;

    assert.deepEqual(derbyInfo(start), { active: true, id, endsAt: start + DERBY_MS });
    assert.deepEqual(derbyInfo(start + 1), { active: true, id, endsAt: start + DERBY_MS });
    assert.deepEqual(derbyInfo(start + DERBY_MS - 1), { active: true, id, endsAt: start + DERBY_MS });

    /* the instant it closes it is closed — no off-by-one grace */
    assert.deepEqual(derbyInfo(start + DERBY_MS), { active: false, id, nextAt: start + HOUR });
    assert.deepEqual(derbyInfo(start + HOUR - 1), { active: false, id, nextAt: start + HOUR });
    assert.deepEqual(derbyInfo(start + HOUR), { active: true, id: id + 1, endsAt: start + HOUR + DERBY_MS });
  });

  it('gives the same answer for the same moment, always', () => {
    const start = nextHourStart();
    for (const offset of [0, 1, 60_000, DERBY_MS, DERBY_MS + 1, HOUR - 1]) {
      assert.deepEqual(derbyInfo(start + offset), derbyInfo(start + offset));
    }
  });

  it('falls back to the live clock and to sane values for junk', () => {
    const live = derbyInfo();
    assert.equal(typeof live.active, 'boolean');
    assert.equal(live.id, Math.floor(realNow() / HOUR));
    assert.ok(live.active ? live.endsAt > 0 : live.nextAt > 0);

    for (const junk of ['nope', Number.NaN, undefined, {}]) {
      const info = derbyInfo(junk);
      assert.equal(typeof info.active, 'boolean');
      assert.ok(Number.isFinite(info.id));
    }
  });
});

/* ============================================================================
   DERBY SCORING AND SETTLEMENT
   ========================================================================== */

describe('recordCatch + sweepDerbies', () => {
  it('crowns one champion per world and pays them exactly once', () => {
    const start = nextHourStart();

    at(start + 60_000, () => {
      recordCatch('isle', 7, 'alice', 12.5);
      recordCatch('isle', 7, 'alice', 2.5);      // totals accumulate: 15.0
      recordCatch('isle', 9, 'bob', 14);
      recordCatch('mine', 9, 'bob', 3);
    });

    const paid = sweepAt(start + DERBY_MS + 1000);
    assert.equal(paid.length, 2, `expected one champion per world, got ${JSON.stringify(paid)}`);

    const byWorld = Object.fromEntries(paid.map((w) => [w.world, w]));
    assert.deepEqual(byWorld.isle, {
      userId: 7, username: 'alice', world: 'isle', kg: 15, pearls: DERBY_PEARLS,
    });
    assert.deepEqual(byWorld.mine, {
      userId: 9, username: 'bob', world: 'mine', kg: 3, pearls: DERBY_PEARLS,
    });

    /* the settlement interval runs every 30s forever — it must never pay the
       same derby a second time */
    assert.deepEqual(sweepAt(start + DERBY_MS + 2000), []);
    assert.deepEqual(sweepAt(start + HOUR * 2), []);
  });

  it('does not settle a derby that is still running', () => {
    const start = nextHourStart();
    at(start + 30_000, () => recordCatch('isle', 3, 'carol', 20));

    assert.deepEqual(sweepAt(start + 60_000), [], 'the window was still open');

    const paid = sweepAt(start + DERBY_MS);
    assert.equal(paid.length, 1);
    assert.equal(paid[0].userId, 3);
  });

  it('breaks a tie in favour of the smaller user id', () => {
    const start = nextHourStart();
    at(start + 5_000, () => {
      recordCatch('isle', 42, 'late', 5);
      recordCatch('isle', 8, 'early', 5);
    });

    const paid = sweepAt(start + DERBY_MS + 1);
    assert.equal(paid.length, 1);
    assert.equal(paid[0].userId, 8);
    assert.equal(paid[0].username, 'early');
  });

  it('ignores catches landed while no derby is open', () => {
    const start = nextHourStart();
    at(start + DERBY_MS + 5_000, () => recordCatch('isle', 5, 'dave', 90));
    at(start + HOUR - 1, () => recordCatch('isle', 5, 'dave', 90));

    assert.deepEqual(sweepAt(start + HOUR + 1000), []);
  });

  it('treats malformed catches as a no-op', () => {
    const start = nextHourStart();

    at(start + 1000, () => {
      recordCatch('isle', null, 'nobody', 10);          // no user
      recordCatch('isle', undefined, 'nobody', 10);
      recordCatch('', 1, 'nobody', 10);                 // no world
      recordCatch(null, 1, 'nobody', 10);
      recordCatch(123, 1, 'nobody', 10);
      recordCatch('isle', 1, 'nobody', 0);              // no weight
      recordCatch('isle', 1, 'nobody', -3);
      recordCatch('isle', 1, 'nobody', 'heavy');
      recordCatch('isle', 1, 'nobody', Number.NaN);
      recordCatch('isle', 1, 'nobody', 10_001);         // beyond any real fish
    });

    assert.deepEqual(sweepAt(start + DERBY_MS + 1), []);
  });

  it('does not retry a payout that threw', () => {
    const start = nextHourStart();
    at(start + 1000, () => recordCatch('isle', 11, 'erin', 7));

    at(start + DERBY_MS + 1, () => {
      sweepDerbies(() => { throw new Error('the database was down'); });
    });

    /* Settled once, win or lose: a partial write followed by a retry could pay
       the prize twice, so the entry is dropped either way. */
    assert.deepEqual(sweepAt(start + DERBY_MS + 2), []);
  });

  it('prunes stale derbies even with no payout function', () => {
    const start = nextHourStart();
    at(start + 1000, () => recordCatch('isle', 13, 'frank', 30));

    /* two hours on, with nobody to pay: retention still has to run or the map
       grows for the life of the process */
    at(start + HOUR * 3, () => sweepDerbies());
    assert.deepEqual(sweepAt(start + HOUR * 3), []);
  });
});

/* ============================================================================
   WANTED FISH
   ========================================================================== */

describe('wantedFor', () => {
  const HUNTABLE = ['uncommon', 'rare', 'epic'];

  it('names a species that world can actually produce, all epoch long', () => {
    const now = mktEpochNow();
    for (const world of Object.keys(WORLDS)) {
      for (let e = now; e < now + 40; e++) {
        const wanted = wantedFor(world, e);
        assert.ok(wanted, `${world}@${e} named nobody`);

        const entry = WORLDS[world].fish.find((row) => row[0].name === wanted.name);
        assert.ok(entry, `${world}@${e} wants ${wanted.name}, which does not swim there`);
        assert.equal(entry[2], undefined,
          `${wanted.name} is condition-gated and cannot be catchable all epoch`);
        assert.ok(HUNTABLE.includes(entry[0].rar),
          `${wanted.name} is ${entry[0].rar} — the pool is uncommon..epic`);
        assert.equal(wanted.bounty, Math.max(200, (entry[0].val | 0) * 3));
      }
    }
  });

  it('is the same poster on every screen', () => {
    const now = mktEpochNow();
    for (let e = now - 20; e < now + 20; e++) {
      for (const world of Object.keys(WORLDS)) {
        assert.deepEqual(wantedFor(world, e), wantedFor(world, e));
      }
    }
    /* a numeric string is the same epoch as the number */
    assert.deepEqual(wantedFor('isle', String(now)), wantedFor('isle', now));
    assert.deepEqual(wantedFor('isle', now + 0.7), wantedFor('isle', now));
  });

  it('rotates rather than sticking on one species', () => {
    const now = mktEpochNow();
    const seen = new Set();
    for (let e = now; e < now + 200; e++) seen.add(wantedFor('isle', e).name);
    assert.ok(seen.size > 1, 'the same fish was wanted for 200 straight epochs');
  });

  it('falls back to the isle table for a world nobody has heard of', () => {
    const e = mktEpochNow();
    const names = new Set(TABLE.map((row) => row[0].name));
    for (const world of ['nowhere', '__proto__', '', null, undefined, 42]) {
      const wanted = wantedFor(world, e);
      assert.ok(wanted && names.has(wanted.name), `${String(world)} produced ${JSON.stringify(wanted)}`);
    }
  });

  it('answers null for an epoch that is not a number', () => {
    /* `null` and `[]` are deliberately absent: both coerce to 0, which is a
       perfectly real (if ancient) epoch rather than a malformed one. */
    for (const e of ['soon', '12abc', Number.NaN, undefined, {}]) {
      assert.equal(wantedFor('isle', e), null, `epoch ${String(e)} should have no poster`);
    }
  });
});

describe('tryClaimWanted', () => {
  it('pays the first claim of a world+epoch and nothing after it', () => {
    const t = nextEpochTime();
    at(t, () => {
      const e = Math.floor(t / MKT_MS);
      const wanted = wantedFor('isle', e);

      assert.equal(tryClaimWanted('isle', e, 1, wanted.name), wanted.bounty);
      assert.ok(wanted.bounty >= 200);

      /* first come, first served — per world, per epoch, whoever it is */
      assert.equal(tryClaimWanted('isle', e, 2, wanted.name), 0);
      assert.equal(tryClaimWanted('isle', e, 1, wanted.name), 0);
    });
  });

  it('runs a separate bounty on every isle', () => {
    const t = nextEpochTime();
    at(t, () => {
      const e = Math.floor(t / MKT_MS);
      const isle = wantedFor('isle', e);
      const mine = wantedFor('mine', e);

      assert.equal(tryClaimWanted('isle', e, 1, isle.name), isle.bounty);
      /* claiming on Fortune Isle must not close the poster in the Great Mine */
      assert.equal(tryClaimWanted('mine', e, 1, mine.name), mine.bounty);
      assert.equal(tryClaimWanted('mine', e, 2, mine.name), 0);
    });
  });

  it('recognises a shiny catch of the wanted species', () => {
    const t = nextEpochTime();
    at(t, () => {
      const e = Math.floor(t / MKT_MS);
      const wanted = wantedFor('isle', e);
      /* the server prefixes a mutated catch with '✦ ' (legacy saves: '✨ ') */
      assert.equal(tryClaimWanted('isle', e, 1, `✦ ${wanted.name}`), wanted.bounty);
    });
  });

  it('does not burn the bounty on a wrong guess', () => {
    const t = nextEpochTime();
    at(t, () => {
      const e = Math.floor(t / MKT_MS);
      const wanted = wantedFor('isle', e);
      const wrong = wanted.name === 'Sardine' ? 'Perch' : 'Sardine';

      assert.equal(tryClaimWanted('isle', e, 1, wrong), 0);
      assert.equal(tryClaimWanted('isle', e, 1, ''), 0);
      assert.equal(tryClaimWanted('isle', e, 1, null), 0);
      assert.equal(tryClaimWanted('isle', e, 1, undefined), 0);

      /* the real target is still claimable after all that */
      assert.equal(tryClaimWanted('isle', e, 1, wanted.name), wanted.bounty);
    });
  });

  it('accepts the live epoch and one grace epoch, nothing else', () => {
    const t = nextEpochTime();
    at(t, () => {
      const cur = Math.floor(t / MKT_MS);

      /* the future is not claimable */
      const ahead = wantedFor('isle', cur + 1);
      assert.equal(tryClaimWanted('isle', cur + 1, 1, ahead.name), 0);

      /* nor is a poster two rotations gone */
      const stale = wantedFor('isle', cur - 2);
      assert.equal(tryClaimWanted('isle', cur - 2, 1, stale.name), 0);

      /* a fish hooked under the previous poster can still land: one epoch of
         grace, because the 3-minute rotation does not wait for the reel */
      const grace = wantedFor('isle', cur - 1);
      assert.equal(tryClaimWanted('isle', cur - 1, 1, grace.name), grace.bounty);

      /* and the live poster is a separate claim */
      const live = wantedFor('isle', cur);
      assert.equal(tryClaimWanted('isle', cur, 1, live.name), live.bounty);
    });
  });

  it('answers 0 for an unusable epoch', () => {
    const t = nextEpochTime();
    at(t, () => {
      for (const e of ['soon', Number.NaN, undefined, null, {}]) {
        assert.equal(tryClaimWanted('isle', e, 1, 'Bass'), 0);
      }
    });
  });
});
