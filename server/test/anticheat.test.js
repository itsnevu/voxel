/* ============================================================================
   anticheat.test.js — the client is a renderer, not a source of truth.

   Everything here attacks the server the way a scripted client would: claim a
   result instead of an intent, name a resource that does not exist, stake more
   than the gear allows, or simply POST a fat save blob full of coins. The
   server is expected to answer with its own numbers, a 400, or a 429 — never
   with the numbers it was handed.

   Note on ordering inside a test: a REJECTED action never marks the action log,
   so a run of 400s costs no cooldown. The successful call therefore goes last.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, registerUser } from './helpers.js';
import { WORLDS, RAR_ORDER, oreTypeFor } from '../src/game/rules.js';

/** Every species Fortune Isle can produce, shiny prefix stripped. */
const ISLE_SPECIES = new Set(WORLDS.isle.fish.map((entry) => entry[0].name));
const plainName = (n) => String(n).replace(/^[✦✨]\s*/u, '');

describe('anti-cheat', () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server.stop(); });

  /* ========================================================================
     POST /api/save — cosmetics and preferences only.
     ====================================================================== */

  describe('POST /api/save', () => {
    it('drops injected coins, ore, levels and pearls on the floor', async () => {
      const user = await registerUser(server);

      const res = await server.post('/api/save', {
        token: user.token,
        body: {
          coins: 999_999_999,
          pearls: 50_000,
          pearlsLife: 50_000,
          level: 99,
          rodLvl: 10, pickLvl: 10, axeLvl: 10, boatLvl: 4,
          ores: { wood: 999, coal: 999, iron: 999, gold: 999, diamond: 999 },
          bucket: [{ name: 'Star Koi', rar: 'legendary', val: 1_000_000, kg: 900 }],
          stats: { earned: 10_000_000 },
          stocks: { own: { HARB: 100, DIGG: 100 } },
          bucketTier: 4,
          pet: 1, charm: 1,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.saved, false, 'none of that should count as a change');

      const s = res.body.state;
      assert.equal(s.coins, 0);
      assert.equal(s.pearls, 0);
      assert.equal(s.pearlsLife, 0);
      assert.equal(s.rodLvl, 1);
      assert.equal(s.pickLvl, 1);
      assert.equal(s.axeLvl, 1);
      assert.equal(s.boatLvl, 0);
      assert.equal(s.bucketTier, 0);
      assert.equal(s.pet, 0);
      assert.equal(s.charm, 0);
      assert.deepEqual(s.ores, { wood: 0, coal: 0, iron: 0, gold: 0, diamond: 0 });
      assert.deepEqual(s.bucket, []);
      assert.deepEqual(s.stocks.own, {});
      assert.equal(s.stats.earned, 0);

      /* and nothing was quietly written behind the reply */
      const reloaded = await server.get('/api/state', { token: user.token });
      assert.equal(reloaded.body.state.coins, 0);
      assert.deepEqual(reloaded.body.state.ores, { wood: 0, coal: 0, iron: 0, gold: 0, diamond: 0 });
    });

    it('will not hand out cosmetics the player never bought', async () => {
      const user = await registerUser(server);

      const wardrobe = await server.post('/api/save', {
        token: user.token,
        body: { wardrobe: { band: 3, scarf: 5, vest: 7 } },
      });
      assert.equal(wardrobe.body.saved, false);
      assert.deepEqual(wardrobe.body.state.wardrobe, {});

      const title = await server.post('/api/save', {
        token: user.token,
        body: { titleId: 'Isle Legend' },
      });
      assert.equal(title.body.saved, false);
      assert.equal(title.body.state.titleId, '');
      assert.deepEqual(title.body.state.ownedT, {});
      assert.deepEqual(title.body.state.ownedW, {});
    });

    it('will not teleport the player to an unowned isle', async () => {
      const user = await registerUser(server);

      const res = await server.post('/api/save', {
        token: user.token,
        body: { world: 'frost', worlds: ['isle', 'mine', 'volcano', 'frost', 'cave'] },
      });

      assert.equal(res.body.saved, false);
      assert.equal(res.body.state.world, 'isle');
      assert.deepEqual(res.body.state.worlds, ['isle']);
    });

    it('accepts achievements and deeds APPEND-ONLY', async () => {
      const user = await registerUser(server);
      const save = (body) => server.post('/api/save', { token: user.token, body });

      /* a first sighting is a real change */
      assert.equal((await save({ ach: { firstFish: 5 } })).body.saved, true);
      /* the same value again changes nothing */
      assert.equal((await save({ ach: { firstFish: 5 } })).body.saved, false);
      /* and it may never go BACKWARDS — that is how a reward gets re-claimed */
      assert.equal((await save({ ach: { firstFish: 1 } })).body.saved, false);
      /* forwards is fine */
      assert.equal((await save({ ach: { firstFish: 9 } })).body.saved, true);

      /* junk keys and negative values are refused outright */
      assert.equal((await save({ ach: { 'not a key!': 1 } })).body.saved, false);
      assert.equal((await save({ ach: { deed_x: -4 } })).body.saved, false);
      assert.equal((await save({ ach: 'all of them' })).body.saved, false);

      /* deeds ratchet the same way */
      assert.equal((await save({ deeds: { plot_a: 12 } })).body.saved, true);
      assert.equal((await save({ deeds: { plot_a: 3 } })).body.saved, false);
    });

    it('will not let a client award itself the paid market tip', async () => {
      const user = await registerUser(server);
      const save = (body) => server.post('/api/save', { token: user.token, body });

      /* tipEpoch is bought for 30 pearls at the kiosk; the client may only
         clear or lower one it already paid for, never raise it */
      const forward = await save({ tipEpoch: 999_999_999 });
      assert.equal(forward.body.saved, false);
      assert.equal(forward.body.state.tipEpoch, 0);

      const negative = await save({ tipEpoch: -5 });
      assert.equal(negative.body.saved, false);
      assert.equal(negative.body.state.tipEpoch, 0);
    });

    it('refuses oversized and malformed bodies without touching the save', async () => {
      const user = await registerUser(server);

      const huge = await server.post('/api/save', {
        token: user.token,
        raw: JSON.stringify({ pad: 'x'.repeat(100_000) }),
      });
      assert.equal(huge.status, 413);

      const broken = await server.post('/api/save', {
        token: user.token,
        raw: '{"coins": 999,,,}',
      });
      assert.equal(broken.status, 400);

      const after = await server.get('/api/state', { token: user.token });
      assert.equal(after.body.state.coins, 0);
    });
  });

  /* ========================================================================
     POST /api/action/:name — the server draws every roll.
     ====================================================================== */

  describe('action outcomes are the server\'s to decide', () => {
    it('ignores a claimed catch and rolls its own fish', async () => {
      const user = await registerUser(server);

      const res = await server.post('/api/action/catch', {
        token: user.token,
        body: {
          /* everything a scripted client would love to assert */
          fish: { name: 'Star Koi', rar: 'legendary', val: 1_000_000, kg: 900 },
          pearls: 9999,
          coins: 500_000,
          isNew: true,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const fish = res.body.result.fish;
      assert.ok(ISLE_SPECIES.has(plainName(fish.name)), `unknown species ${fish.name}`);
      assert.ok(RAR_ORDER.includes(fish.rar));
      /* Fortune Isle's dearest species is 750 base; roll spread tops at 1.18
         and a shiny mutation multiplies by 5, so ~4425 is the ceiling. */
      assert.ok(fish.val >= 1 && fish.val <= 5000, `implausible value ${fish.val}`);
      assert.ok(fish.kg > 0);

      const s = res.body.state;
      assert.equal(s.coins, 0, 'a catch pays no coins until it is sold');
      assert.equal(s.bucket.length, 1);
      assert.deepEqual(s.bucket[0], fish);
      assert.equal(s.pearls, res.body.result.pearls);
      assert.ok(s.pearls > 0 && s.pearls <= 100);
    });

    it('derives the ore from the node id, never from the body', async () => {
      const user = await registerUser(server);

      const res = await server.post('/api/action/mine', {
        token: user.token,
        body: { node: 0, type: 'diamond', got: 999 },
      });

      assert.equal(res.status, 200);
      const expected = oreTypeFor('isle', 0);
      assert.equal(res.body.result.type, expected);
      assert.notEqual(res.body.result.type, 'diamond');
      assert.equal(res.body.state.ores.diamond, 0);
      assert.equal(res.body.state.ores[expected], res.body.result.got);
      assert.ok(res.body.result.got >= 1 && res.body.result.got <= 3);
    });

    it('rejects ore node ids outside the range the client could have', async () => {
      const user = await registerUser(server);
      /* Fortune Isle has no quarry (oreN 0) — only the four grass starters,
         so ids 0..3 exist and nothing else does. */
      /* NaN is deliberately spelled as a string: JSON.stringify turns a real
         NaN into null, which the handler reads as "no id given" instead. */
      const bad = [-1, -100, 4, 90, 1e9, 2.5, 'NaN', 'diamond', {}];

      for (const node of bad) {
        const res = await server.post('/api/action/mine', { token: user.token, body: { node } });
        assert.equal(res.status, 400, `node ${JSON.stringify(node)} should be refused`);
        assert.match(res.body.error, /ore node/i);
      }

      /* nothing was mined by any of that */
      const state = await server.get('/api/state', { token: user.token });
      assert.deepEqual(state.body.state.ores, { wood: 0, coal: 0, iron: 0, gold: 0, diamond: 0 });

      /* an id the client really could hold still works */
      const good = await server.post('/api/action/mine', { token: user.token, body: { node: 3 } });
      assert.equal(good.status, 200);
    });

    it('rejects tree ids outside the world\'s tree count', async () => {
      const user = await registerUser(server);
      const treeMax = WORLDS.isle.treeMax;                 // 90

      for (const tree of [-1, treeMax, treeMax + 500, 1.5, 'oak']) {
        const res = await server.post('/api/action/chop', { token: user.token, body: { tree } });
        assert.equal(res.status, 400, `tree ${tree} should be refused`);
        assert.match(res.body.error, /tree/i);
      }

      const good = await server.post('/api/action/chop', { token: user.token, body: { tree: 0 } });
      assert.equal(good.status, 200);
      assert.ok(good.body.state.ores.wood >= 1);
    });

    it('answers 429 when one action is repeated faster than its cooldown', async () => {
      const user = await registerUser(server);

      const first = await server.post('/api/action/chop', { token: user.token, body: {} });
      assert.equal(first.status, 200);

      const second = await server.post('/api/action/chop', { token: user.token, body: {} });
      assert.equal(second.status, 429);
      assert.match(second.body.error, /too fast/i);
      assert.ok(second.body.retryAfter > 0);
      assert.ok(Number(second.headers.get('retry-after')) >= 1);

      /* the refused call banked nothing */
      const after = await server.get('/api/state', { token: user.token });
      assert.equal(after.body.state.ores.wood, first.body.state.ores.wood);
    });

    it('will not accept a wager the rod does not cover', async () => {
      const user = await registerUser(server);
      const spin = (body) => server.post('/api/action/spin', { token: user.token, body });

      /* a level 1 rod covers a 250 chip and no more */
      for (const coinStake of [1000, 5000, 25_000, 100_000]) {
        const res = await spin({ bet: 'red', coinStake });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /rod only covers a 250 chip/i);
      }

      /* inside the cap but off the fixed ladder is still refused */
      const offLadder = await spin({ bet: 'red', coinStake: 100 });
      assert.equal(offLadder.status, 400);
      assert.match(offLadder.body.error, /must be one of/i);

      /* on the ladder and inside the cap — refused only for lack of coins,
         which proves the cap check let it through */
      const broke = await spin({ bet: 'red', coinStake: 250 });
      assert.equal(broke.status, 400);
      assert.match(broke.body.error, /not enough coins/i);

      /* other ways to stake nothing */
      assert.equal((await spin({ bet: 'red' })).status, 400);
      assert.equal((await spin({ bet: 'purple', coinStake: 50 })).status, 400);
      assert.equal((await spin({ bet: 'red', stakeIdx: 0 })).status, 400);
      assert.equal((await spin({ bet: 'red', coinStake: 250, stakeIdx: 0 })).status, 400);

      const state = await server.get('/api/state', { token: user.token });
      assert.equal(state.body.state.coins, 0, 'a refused spin may not move coins');
      assert.equal(state.body.state.stats.spins, 0);
    });

    it('will not sell, craft, trade or sail on credit', async () => {
      const user = await registerUser(server);
      const post = (name, body) => server.post(`/api/action/${name}`, { token: user.token, body });

      assert.equal((await post('sell', { kind: 'fish', index: 0 })).status, 400);
      assert.equal((await post('sell', { kind: 'fish', index: -1 })).status, 400);
      assert.equal((await post('sell', { kind: 'ore', oreKey: 'diamond' })).status, 400);
      assert.equal((await post('sell', { kind: 'ore', oreKey: '__proto__' })).status, 400);
      assert.equal((await post('sell', { kind: 'allfish' })).status, 400);
      assert.equal((await post('craft', { tool: 'rod' })).status, 400);
      assert.equal((await post('craft', { tool: '__proto__' })).status, 400);
      assert.equal((await post('boat', {})).status, 400);
      assert.equal((await post('stock', { op: 'buy', ticker: 'REEL' })).status, 400);
      assert.equal((await post('stock', { op: 'sell', ticker: 'REEL' })).status, 400);
      assert.equal((await post('stock', { op: 'buy', ticker: 'BOGUS' })).status, 400);
      assert.equal((await post('kiosk', { item: 'bucket' })).status, 400);
      assert.equal((await post('bait', { op: 'buy', id: 'siren', packs: 20 })).status, 400);

      const state = await server.get('/api/state', { token: user.token });
      const s = state.body.state;
      assert.equal(s.coins, 0);
      assert.equal(s.pearls, 0);
      assert.equal(s.rodLvl, 1);
      assert.equal(s.boatLvl, 0);
      assert.deepEqual(s.stocks.own, {});
    });

    it('gates travel on the hull and the purse', async () => {
      const user = await registerUser(server);
      const travel = (world) => server.post('/api/action/travel', { token: user.token, body: { world } });

      /* a raft cannot make the long crossings */
      for (const world of ['mine', 'volcano', 'frost']) {
        const res = await travel(world);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /voyage/i);
      }

      /* the cave needs no boat, but it still costs 750 coins */
      const cave = await travel('cave');
      assert.equal(cave.status, 400);
      assert.match(cave.body.error, /not enough coins/i);

      /* and there is no such place as Atlantis */
      const nowhere = await travel('atlantis');
      assert.equal(nowhere.status, 400);
      assert.equal((await travel('__proto__')).status, 400);

      const state = await server.get('/api/state', { token: user.token });
      assert.equal(state.body.state.world, 'isle');
      assert.deepEqual(state.body.state.worlds, ['isle']);
    });

    it('resolves no action name that is not a real handler', async () => {
      const user = await registerUser(server);
      for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
        const res = await server.post(`/api/action/${name}`, { token: user.token, body: {} });
        assert.equal(res.status, 404, `/api/action/${name} must not resolve`);
      }
    });
  });

  /* ========================================================================
     Authentication is not optional.
     ====================================================================== */

  describe('authentication', () => {
    it('refuses every state-bearing endpoint without a valid session', async () => {
      const guarded = [
        ['GET', '/api/state'],
        ['POST', '/api/save'],
        ['POST', '/api/action/catch'],
        ['GET', '/api/crew'],
        ['GET', '/api/ledger'],
        ['POST', '/api/ledger/claim'],
        ['POST', '/api/report'],
      ];

      for (const [method, path] of guarded) {
        const anon = await server.request(method, path, { body: {} });
        assert.equal(anon.status, 401, `${method} ${path} leaked to an anonymous caller`);

        const forged = await server.request(method, path, { token: 'f'.repeat(64), body: {} });
        assert.equal(forged.status, 401, `${method} ${path} accepted a forged token`);
      }
    });

    it('keeps the public endpoints public', async () => {
      for (const path of ['/api/health', '/api/online', '/api/derby', '/api/leaderboard']) {
        const res = await server.get(path);
        assert.equal(res.status, 200, `${path} should not require a session`);
      }
    });

    it('never falls through an unknown /api path to the static file server', async () => {
      const res = await server.get('/api/does-not-exist');
      assert.equal(res.status, 404);
      assert.equal(res.body.error, 'not found');

      /* the server package, its .env and the git tree are shut out explicitly */
      for (const path of ['/server/.env', '/.env', '/.git/config', '/node_modules/ws/package.json']) {
        const blocked = await server.get(path);
        assert.equal(blocked.status, 403, `${path} should be forbidden`);
      }
    });
  });
});
