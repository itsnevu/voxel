/* ============================================================================
   clienterror.test.js — POST /api/client-error and the buffer behind it.

   Two halves, and only one of them needs a server. clienterrors.js is a plain
   in-memory Map with no I/O, so its collapse-and-evict behaviour is tested
   directly and exactly; the route is tested over HTTP because what matters
   there is who is allowed to post, how much, and how often.

   The buffer is module state shared by every importer in this process, so the
   unit half calls reset() first and uses call sites nothing else writes.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, registerUser } from './helpers.js';
import * as CE from '../src/clienterrors.js';

/* -------------------------------------------------------------- the buffer -- */

describe('clienterrors buffer', () => {
  it('collapses an identical fault instead of filling the window with it', () => {
    CE.reset();
    for (let i = 0; i < 50; i++) {
      CE.add({ where: 'render:loop', level: 'error', msg: 'x is not a function', userId: 1 });
    }
    const rows = CE.recent();
    assert.equal(rows.length, 1, 'fifty reports of one fault is one fault');
    assert.equal(rows[0].count, 50);
    assert.equal(CE.stats().reports, 50);
  });

  it('separates faults that differ in level, call site or message', () => {
    CE.reset();
    CE.add({ where: 'a', level: 'error', msg: 'boom' });
    CE.add({ where: 'a', level: 'warn', msg: 'boom' });
    CE.add({ where: 'b', level: 'error', msg: 'boom' });
    CE.add({ where: 'a', level: 'error', msg: 'bang' });
    assert.equal(CE.recent().length, 4);
  });

  it('counts distinct players, never lists them', () => {
    CE.reset();
    CE.add({ where: 'sell', level: 'error', msg: 'nope', userId: 7 });
    CE.add({ where: 'sell', level: 'error', msg: 'nope', userId: 9 });
    CE.add({ where: 'sell', level: 'error', msg: 'nope', userId: 7 });
    const row = CE.recent()[0];
    assert.equal(row.users, 2, 'two players, three reports');
    assert.equal(typeof row.users, 'number', 'the console must never receive user ids');
  });

  it('lists the most recently seen fault first', () => {
    CE.reset();
    CE.add({ where: 'old', level: 'error', msg: 'stopped happening' });
    CE.add({ where: 'new', level: 'error', msg: 'still happening' });
    CE.add({ where: 'old', level: 'error', msg: 'stopped happening' });
    /* All three land inside the same millisecond, so `last` cannot separate
       them and only the buffer's own touch order can. `old` was seen again, so
       `old` is on top — an operator reads the top of this list first. */
    assert.equal(CE.recent()[0].where, 'old');
    assert.equal(CE.recent()[1].where, 'new');
  });

  it('evicts the fault that stopped, never the one still going', () => {
    CE.reset();
    const CAP = CE.stats().cap;
    CE.add({ where: 'chronic', level: 'error', msg: 'still going' });
    CE.add({ where: 'quiet', level: 'error', msg: 'went away' });
    for (let i = 0; i < CAP - 2; i++) {
      CE.add({ where: 'filler' + i, level: 'error', msg: 'noise' });
      /* Touched all the way through, so it is never the oldest key. */
      CE.add({ where: 'chronic', level: 'error', msg: 'still going' });
    }
    CE.add({ where: 'overflow', level: 'error', msg: 'one too many' });

    const wheres = CE.recent(CAP).map((r) => r.where);
    assert.equal(CE.stats().faults, CAP, 'the buffer holds its ceiling and no more');
    assert.ok(wheres.includes('chronic'), 'a fault still happening must survive the churn');
    assert.ok(!wheres.includes('quiet'), 'the one nobody has seen since is what goes');
  });

  it('strips control characters and caps what it keeps', () => {
    CE.reset();
    CE.add({
      where: 'a\x00b\x07c',
      level: 'error',
      msg: 'line\x00one \t\t collapsed',
      stack: 'at a\nat b\n'.repeat(40),
    });
    const row = CE.recent()[0];
    assert.equal(row.where, 'a b c');
    assert.equal(row.msg, 'line one collapsed');
    assert.ok(row.stack.split('\n').length <= 12, 'a stack is trimmed to something readable');
    assert.ok(!/[\x00-\x1f]/.test(row.msg), 'no control byte survives');
  });

  it('falls back to a usable level and call site rather than storing junk', () => {
    CE.reset();
    CE.add({ where: '', level: 'catastrophe', msg: 'no where given' });
    const row = CE.recent()[0];
    assert.equal(row.where, 'unknown');
    assert.equal(row.level, 'error');
  });
});

/* --------------------------------------------------------------- the route -- */

describe('POST /api/client-error', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { if (server) await server.stop(); });

  const fault = (msg = 'something broke') =>
    ({ where: 'atlas:draw', level: 'error', msg, name: 'TypeError', stack: 'at draw' });

  it('refuses an anonymous report', async () => {
    const res = await server.post('/api/client-error', { body: { errors: [fault()] } });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
  });

  it('records a signed-in report', async () => {
    const user = await registerUser(server);
    const res = await server.post('/api/client-error', {
      token: user.token,
      body: { build: 'abc123', errors: [fault('recorded please')] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.kept, 1);
  });

  it('rejects a post with nothing in it', async () => {
    const user = await registerUser(server);
    for (const body of [{}, { errors: [] }, { errors: 'not an array' }]) {
      const res = await server.post('/api/client-error', { token: user.token, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(res.body.code, 'MISSING_ERRORS');
    }
  });

  it('takes the first ten of an oversized batch and drops the rest', async () => {
    const user = await registerUser(server);
    const errors = Array.from({ length: 40 }, (_, i) => fault('overflow ' + i));
    const res = await server.post('/api/client-error', { token: user.token, body: { errors } });
    assert.equal(res.status, 200);
    assert.equal(res.body.kept, 10, 'a client cannot widen the batch by asking');
  });

  it('survives entries that are not objects at all', async () => {
    const user = await registerUser(server);
    const res = await server.post('/api/client-error', {
      token: user.token,
      body: { errors: [null, 'a string', 42, fault('the only real one')] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.kept, 1);
  });

  it('rate limits a client that will not stop reporting', async () => {
    const user = await registerUser(server);
    const ip = '10.90.90.90';           // one bucket, shared on purpose
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const res = await server.post('/api/client-error', {
        token: user.token, ip, body: { errors: [fault('flood ' + i)] },
      });
      if (res.status === 429) {
        sawLimit = true;
        assert.equal(res.body.code, 'RATE_LIMIT');
        assert.ok(res.headers.get('retry-after'), 'a 429 must say when to come back');
        break;
      }
    }
    assert.ok(sawLimit, 'an unbounded error beacon is its own outage');
  });
});
