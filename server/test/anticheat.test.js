/* ============================================================================
   anticheat.test.js — the client is a renderer, not a source of truth.

   Everything here attacks the server the way a scripted client would: claim a
   result instead of an intent, name a resource that does not exist, stake more
   than the gear allows, or simply POST a fat save blob full of coins. The
   server is expected to answer with its own numbers, a 400, or a 429 — never
   with the numbers it was handed.

   Note on ordering inside a test: a rejected action DOES mark the action log —
   hammering the route with a body the handler refuses used to be free, so the
   400 path now costs the same cooldown as the 200 path. A loop of malformed
   bodies therefore needs one fresh account per attempt, or the second one comes
   back 429 and proves nothing about the body it sent.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, registerUser } from './helpers.js';
import { WORLDS, RAR_ORDER, oreTypeFor } from '../src/game/rules.js';
import { mktEpochNow } from '../src/game/economy.js';
import { ACH, DEEDS } from '../src/progress.js';

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

    it('ignores ach and deeds from the body — real ids included', async () => {
      const user = await registerUser(server);
      const save = (body) => server.post('/api/save', { token: user.token, body });

      /* REAL ids, so this cannot pass merely because the id was unrecognised —
         the forged-id case is the test underneath. Membership only says an id
         exists; nothing a client posts can show it was EARNED, and progress.js's
         predicates are the only thing that knows. */
      const ACH_ID = ACH[0][0];               // fish1
      const DEED_ID = DEEDS[0][0];            // d_arrive

      for (const body of [
        { ach: { [ACH_ID]: 1 } },
        { ach: { [ACH_ID]: 9 } },
        { deeds: { [DEED_ID]: 12 } },
        { deeds: { [DEED_ID]: mktEpochNow() } },
        { ach: { [ACH_ID]: 1 }, deeds: { [DEED_ID]: 12 } },
      ]) {
        const res = await save(body);
        assert.equal(res.body.saved, false, `${JSON.stringify(body)} counted as a change`);
        assert.equal(res.body.state.ach[ACH_ID], undefined);
        assert.equal(res.body.state.deeds[DEED_ID], undefined);
      }

      /* malformed shapes are dropped by the same rule, not a different path */
      assert.equal((await save({ ach: 'all of them' })).body.saved, false);
      assert.equal((await save({ deeds: [DEED_ID] })).body.saved, false);

      const reloaded = await server.get('/api/state', { token: user.token });
      assert.equal(reloaded.body.state.ach[ACH_ID], undefined);
      assert.equal(reloaded.body.state.deeds[DEED_ID], undefined);
    });

    it('still awards a trophy the player actually earns', async () => {
      /* The refusal above is only safe because the server pays trophies itself.
         A suite that asserted the refusal alone would pass just as happily with
         achievements broken outright, so this is the other half of the contract. */
      const user = await registerUser(server);
      const ACH_ID = ACH[0][0];               // fish1 · one landed fish earns it

      const before = await server.get('/api/state', { token: user.token });
      assert.equal(before.body.state.ach[ACH_ID], undefined);

      const res = await server.post('/api/action/catch', { token: user.token, body: {} });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      const after = await server.get('/api/state', { token: user.token });
      assert.ok(after.body.state.ach[ACH_ID],
        `${ACH_ID} was not stamped by the server after a real catch`);
    });

    it('will not mint a trophy id that progress.js does not define', async () => {
      const user = await registerUser(server);
      /* well-formed enough to pass DEED_ID_RE and to look real in a save file —
         which is exactly why a charset test was never enough */
      const FORGED = 'plot_a';

      const res = await server.post('/api/save', {
        token: user.token,
        body: { ach: { firstFish: 1 }, deeds: { [FORGED]: 12, d_atlantis: 7 } },
      });
      assert.equal(res.body.saved, false, 'an invented id is not a change');
      assert.equal(res.body.state.ach.firstFish, undefined);
      assert.equal(res.body.state.deeds[FORGED], undefined);
      assert.equal(res.body.state.deeds.d_atlantis, undefined);

      /* and it never reached the ledger table behind the reply. /api/ledger
         mirrors state.deeds into `deeds`, and /api/ledger/claim HMAC-signs
         whatever it finds there — a forged id used to come back as a genuine
         signature over a deed that does not exist. */
      const ledger = await server.get('/api/ledger', { token: user.token });
      assert.equal(ledger.status, 200);
      assert.deepEqual(ledger.body.deeds.map((row) => row.deed_id), []);

      const claim = await server.post('/api/ledger/claim', {
        token: user.token,
        body: { deedId: FORGED, address: '0x' + '1'.repeat(40) },
      });
      assert.equal(claim.status, 400);
      assert.equal(claim.body.code, 'DEED_NOT_MINTED');
      assert.equal(claim.body.signature, undefined);
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
    /**
     * One rejected attempt, on an account that has never acted before.
     *
     * A refusal marks the action log exactly like a success, so a test that
     * posts two bad bodies of the SAME action from one player gets a 429 for
     * the second and learns nothing about the body it sent. Registering is
     * ~25ms of scrypt; a fresh account per attempt is the cheap way to keep
     * each assertion about the thing it claims to be about.
     */
    async function attempt(name, body) {
      const user = await registerUser(server);
      const res = await server.post(`/api/action/${name}`, { token: user.token, body });
      return { user, res };
    }

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
      /* The fish itself pays nothing until it is sold — but a FIRST catch also
         earns the "First Catch" achievement, and that bounty is real coin the
         server pays. So are the events.js wanted-poster winnings, on the roll
         in fifteen or so where the species drawn happens to be the one the
         world is hunting this epoch. Nothing ELSE may add a coin. */
      const bounty = (res.body.earned && res.body.earned.coins) || 0;
      const wanted = res.body.result.wanted || 0;
      assert.equal(s.coins, bounty + wanted,
        'a catch pays nothing beyond the achievement bounty and the wanted poster');
      assert.ok(bounty === 0 || res.body.earned.ach.some(a => a.id === 'fish1'),
        'any coins on a first catch must come from the First Catch achievement');
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
      /* Fortune Isle has no quarry (oreN 0) — only the four grass starters,
         so ids 0..3 exist and nothing else does. */
      /* NaN is deliberately spelled as a string: JSON.stringify turns a real
         NaN into null, which the handler reads as "no id given" instead.
         The first two bodies ARE that "no id given" — the widest version of
         this hole, because an absent node fell through to a blind ore roll
         that skipped both the starter-node table and the depletion write. */
      const bad = [{}, { node: null }, { type: 'diamond' },
        { node: -1 }, { node: -100 }, { node: 4 }, { node: 90 }, { node: 1e9 },
        { node: 2.5 }, { node: 'NaN' }, { node: 'diamond' }, { node: {} }];

      for (const body of bad) {
        const { user, res } = await attempt('mine', body);
        assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be refused`);
        assert.match(res.body.error, /ore node/i);

        /* and it banked nothing on the way out */
        const state = await server.get('/api/state', { token: user.token });
        assert.deepEqual(state.body.state.ores,
          { wood: 0, coal: 0, iron: 0, gold: 0, diamond: 0 },
          `body ${JSON.stringify(body)} still produced ore`);
      }

      /* an id the client really could hold still works */
      const miner = await registerUser(server);
      const good = await server.post('/api/action/mine', { token: miner.token, body: { node: 3 } });
      assert.equal(good.status, 200);
    });

    it('rejects tree ids outside the world\'s tree count', async () => {
      const treeMax = WORLDS.isle.treeMax;                 // 90

      /* {} and null again first: a chop at no tree in particular used to skip
         the felled check and the depletion write the same way. */
      for (const body of [{}, { tree: null }, { tree: -1 }, { tree: treeMax },
        { tree: treeMax + 500 }, { tree: 1.5 }, { tree: 'oak' }]) {
        const { user, res } = await attempt('chop', body);
        assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be refused`);
        assert.match(res.body.error, /tree/i);

        const state = await server.get('/api/state', { token: user.token });
        assert.equal(state.body.state.ores.wood, 0,
          `body ${JSON.stringify(body)} still produced wood`);
      }

      const { res: good } = await attempt('chop', { tree: 0 });
      assert.equal(good.status, 200);
      assert.ok(good.body.state.ores.wood >= 1);
    });

    it('answers 429 when one action is repeated faster than its cooldown', async () => {
      /* tree 7, not tree 0: a felled tree stays felled for 35 seconds for
         EVERYONE in the world, so two tests that both want a successful chop
         cannot want the same one. */
      const { user, res: first } = await attempt('chop', { tree: 7 });
      assert.equal(first.status, 200);

      /* a DIFFERENT tree, so only the cooldown can be what refuses it */
      const second = await server.post('/api/action/chop', { token: user.token, body: { tree: 8 } });
      assert.equal(second.status, 429);
      assert.match(second.body.error, /too fast/i);
      assert.ok(second.body.retryAfter > 0);
      assert.ok(Number(second.headers.get('retry-after')) >= 1);

      /* the refused call banked nothing */
      const after = await server.get('/api/state', { token: user.token });
      assert.equal(after.body.state.ores.wood, first.body.state.ores.wood);

      /* and a REFUSED body pays the same cooldown as an accepted one: hammering
         the route with an intent the handler rejects used to be free */
      const { user: macro, res: junk } = await attempt('chop', { tree: -1 });
      assert.equal(junk.status, 400);
      const next = await server.post('/api/action/chop', { token: macro.token, body: { tree: 9 } });
      assert.equal(next.status, 429, 'a rejected action must still mark the log');
    });

    it('will not accept a wager the rod does not cover', async () => {
      /* a level 1 rod covers a 250 chip and no more */
      for (const coinStake of [1000, 5000, 25_000, 100_000]) {
        const { res } = await attempt('spin', { bet: 'red', coinStake });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /rod only covers a 250 chip/i);
      }

      /* inside the cap but off the fixed ladder is still refused */
      const offLadder = await attempt('spin', { bet: 'red', coinStake: 100 });
      assert.equal(offLadder.res.status, 400);
      assert.match(offLadder.res.body.error, /must be one of/i);

      /* on the ladder and inside the cap — refused only for lack of coins,
         which proves the cap check let it through */
      const broke = await attempt('spin', { bet: 'red', coinStake: 250 });
      assert.equal(broke.res.status, 400);
      assert.match(broke.res.body.error, /not enough coins/i);

      /* other ways to stake nothing */
      for (const body of [{ bet: 'red' }, { bet: 'purple', coinStake: 50 },
        { bet: 'red', stakeIdx: 0 }, { bet: 'red', coinStake: 250, stakeIdx: 0 }]) {
        const { res } = await attempt('spin', body);
        assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused`);
      }

      const state = await server.get('/api/state', { token: broke.user.token });
      assert.equal(state.body.state.coins, 0, 'a refused spin may not move coins');
      assert.equal(state.body.state.stats.spins, 0);
    });

    it('will not sell, craft, trade or sail on credit', async () => {
      const broke = [
        ['sell',  { kind: 'fish', index: 0 }],
        ['sell',  { kind: 'fish', index: -1 }],
        ['sell',  { kind: 'ore', oreKey: 'diamond' }],
        ['sell',  { kind: 'ore', oreKey: '__proto__' }],
        ['sell',  { kind: 'allfish' }],
        ['craft', { tool: 'rod' }],
        ['craft', { tool: '__proto__' }],
        ['boat',  {}],
        ['stock', { op: 'buy', ticker: 'REEL' }],
        ['stock', { op: 'sell', ticker: 'REEL' }],
        ['stock', { op: 'buy', ticker: 'BOGUS' }],
        ['kiosk', { item: 'bucket' }],
        ['bait',  { op: 'buy', id: 'siren', packs: 20 }],
      ];

      for (const [name, body] of broke) {
        const { user, res } = await attempt(name, body);
        assert.equal(res.status, 400, `${name} ${JSON.stringify(body)} was not refused`);

        const s = (await server.get('/api/state', { token: user.token })).body.state;
        assert.equal(s.coins, 0);
        assert.equal(s.pearls, 0);
        assert.equal(s.rodLvl, 1);
        assert.equal(s.boatLvl, 0);
        assert.deepEqual(s.stocks.own, {});
        assert.deepEqual(s.bucket, []);
      }
    });

    it('gates travel on the hull and the purse', async () => {
      /* a raft cannot make the long crossings */
      for (const world of ['mine', 'volcano', 'frost']) {
        const { res } = await attempt('travel', { world });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /voyage/i);
      }

      /* the cave needs no boat, but it still costs 750 coins */
      const cave = await attempt('travel', { world: 'cave' });
      assert.equal(cave.res.status, 400);
      assert.match(cave.res.body.error, /not enough coins/i);

      /* and there is no such place as Atlantis */
      assert.equal((await attempt('travel', { world: 'atlantis' })).res.status, 400);
      assert.equal((await attempt('travel', { world: '__proto__' })).res.status, 400);

      const state = await server.get('/api/state', { token: cave.user.token });
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
