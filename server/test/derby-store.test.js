/* ============================================================================
   derby-store.test.js — the derby's durability layer.

   events.js keeps every score in memory and mirrors it to an optional store.
   The store here is a plain object, which is the point: the module duck-types
   it, so these tests exercise the real code path with no database in sight.

   The clock is pinned per call the same way events.test.js does it, and each
   test claims its own hour so the module's long-lived maps cannot leak between
   them.
   ========================================================================== */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { recordCatch, sweepDerbies, setDerbyStore } from '../src/events.js';
import { MKT_MS } from '../src/game/economy.js';

const HOUR = MKT_MS * 20;
const DERBY_MS = 10 * 60 * 1000;
const DERBY_PEARLS = 150;

const realNow = Date.now;
function at(t, fn) {
  Date.now = () => t;
  try { return fn(); } finally { Date.now = realNow; }
}

/* Far enough ahead that events.test.js and this file never share an hour. */
let hourCursor = Math.floor(realNow() / HOUR) + 90_000;
const nextHourStart = () => (hourCursor += 10) * HOUR;

/** A store that records what it was told, so assertions read as a transcript. */
function fakeStore(seed = []) {
  return {
    rows: seed.slice(),
    bumps: [],
    crowns: [],
    cleared: [],
    errors: [],
    /* Hands back everything it holds — the guards under test live in
       events.js, not here, and a real SQL store never returns a null row. */
    scoresFrom() { return this.rows.slice(); },
    bump(id, world, userId, username, kg) { this.bumps.push({ id, world, userId, username, kg }); },
    crown(row) {
      const dup = this.crowns.some((c) => c.derbyId === row.derbyId && c.world === row.world);
      this.crowns.push(row);
      return !dup;                       // INSERT OR IGNORE, in miniature
    },
    clearScores(id) { this.cleared.push(id); },
    onError(method, err) { this.errors.push({ method, err }); }
  };
}

/* Nothing may leave a store attached — the rest of the suite runs pure. */
afterEach(() => setDerbyStore(null));

describe('setDerbyStore', () => {
  it('is optional: with no store the module behaves exactly as before', () => {
    setDerbyStore(null);
    const start = nextHourStart();
    at(start + 1000, () => recordCatch('isle', 7, 'nemo', 12));
    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));
    assert.equal(paid.length, 1);
    assert.equal(paid[0].userId, 7);
  });

  it('rejects a non-object without throwing', () => {
    assert.equal(setDerbyStore('nope'), 0);
    assert.equal(setDerbyStore(undefined), 0);
  });

  it('replays live tallies so a restart mid-derby resumes the race', () => {
    const start = nextHourStart();
    const id = Math.floor(start / HOUR);
    const store = fakeStore([
      { derby_id: id, world: 'isle', user_id: 4, username: 'ada', kg: 30 },
      { derby_id: id, world: 'isle', user_id: 9, username: 'bo', kg: 12 }
    ]);

    // Boot inside the window, exactly as index.js does after initSchema().
    const restored = at(start + 2000, () => setDerbyStore(store));
    assert.equal(restored, 2);

    // Ada's 30kg survived the "restart": she wins without catching anything new.
    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));
    assert.equal(paid.length, 1);
    assert.equal(paid[0].username, 'ada');
    assert.equal(paid[0].kg, 30);
  });

  it('ignores replayed rows that are stale, malformed or empty', () => {
    const start = nextHourStart();
    const id = Math.floor(start / HOUR);
    const store = fakeStore([
      { derby_id: id - 5, world: 'isle', user_id: 1, username: 'old', kg: 99 },  // settled hour
      { derby_id: id, world: 'isle', user_id: 2, username: 'zero', kg: 0 },      // no weight
      { derby_id: id, world: '', user_id: 3, username: 'noworld', kg: 5 },       // no world
      { derby_id: id, world: 'isle', user_id: null, username: 'nouser', kg: 5 }, // no user
      { derby_id: 'x', world: 'isle', user_id: 5, username: 'nan', kg: 5 },      // junk id
      null,
      { derby_id: id, world: 'isle', user_id: 6, username: 'good', kg: 8 }
    ]);
    const restored = at(start + 2000, () => setDerbyStore(store));
    assert.equal(restored, 1);

    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));
    assert.equal(paid.length, 1);
    assert.equal(paid[0].username, 'good');
  });
});

describe('scoring through a store', () => {
  it('mirrors every catch as a delta, not a total', () => {
    const start = nextHourStart();
    const store = fakeStore();
    at(start, () => setDerbyStore(store));

    at(start + 100, () => recordCatch('isle', 3, 'cy', 4));
    at(start + 200, () => recordCatch('isle', 3, 'cy', 6));

    assert.equal(store.bumps.length, 2);
    assert.deepEqual(store.bumps.map((b) => b.kg), [4, 6]);   // deltas — the row sums them
    assert.equal(store.bumps[0].world, 'isle');
    assert.equal(store.bumps[0].userId, 3);
  });

  it('does not mirror a catch the module itself rejects', () => {
    const start = nextHourStart();
    const store = fakeStore();
    at(start, () => setDerbyStore(store));

    at(start + 100, () => recordCatch('isle', 3, 'cy', -1));       // negative
    at(start + 100, () => recordCatch('isle', 3, 'cy', 99999));    // over the ceiling
    at(start + 100, () => recordCatch('', 3, 'cy', 5));            // no world
    at(start + DERBY_MS + 5, () => recordCatch('isle', 3, 'cy', 5)); // window shut

    assert.equal(store.bumps.length, 0);
  });

  it('survives a store that throws — the tally in memory still wins', () => {
    const start = nextHourStart();
    const store = fakeStore();
    store.bump = function () { throw new Error('disk on fire'); };
    at(start, () => setDerbyStore(store));

    at(start + 100, () => recordCatch('isle', 11, 'jo', 20));
    assert.deepEqual(store.errors.map((e) => e.method), ['bump']);

    /* One sweep settles every derby whose window has shut, so it may also be
       collecting hours left behind by the tests above. Assert on this test's
       own champion rather than on the size of the whole payout list. */
    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));
    const mine = paid.filter((w) => w.userId === 11);
    assert.deepEqual(mine.map((w) => w.username), ['jo']);
    assert.equal(mine[0].kg, 20);
  });
});

describe('settling through a store', () => {
  it('crowns before paying, and clears the scratch scores after', () => {
    const start = nextHourStart();
    const id = Math.floor(start / HOUR);
    const store = fakeStore();
    at(start, () => setDerbyStore(store));
    at(start + 100, () => recordCatch('isle', 5, 'kai', 42));

    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));

    assert.equal(store.crowns.length, 1);
    assert.deepEqual(
      { ...store.crowns[0] },
      { derbyId: id, world: 'isle', userId: 5, username: 'kai', kg: 42, pearls: DERBY_PEARLS }
    );
    assert.equal(paid.length, 1);
    assert.deepEqual(store.cleared, [id]);
  });

  it('refuses to pay a derby another process already crowned', () => {
    const start = nextHourStart();
    const id = Math.floor(start / HOUR);
    const store = fakeStore();
    // Pre-seed the crown: this is the record a died-mid-sweep process left.
    store.crowns.push({ derbyId: id, world: 'isle', userId: 5, username: 'kai', kg: 42, pearls: DERBY_PEARLS });
    at(start, () => setDerbyStore(store));
    at(start + 100, () => recordCatch('isle', 5, 'kai', 42));

    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));

    assert.equal(paid.length, 0, 'the prize must never be handed out twice');
    assert.deepEqual(store.cleared, [id]);
  });

  it('still pays when no store is attached, however the sweep is called', () => {
    setDerbyStore(null);
    const start = nextHourStart();
    at(start + 100, () => recordCatch('isle', 8, 'rae', 3));
    const paid = [];
    at(start + DERBY_MS + 1, () => sweepDerbies((w) => paid.push(w)));
    assert.equal(paid.length, 1);
  });
});
