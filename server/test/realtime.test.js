/* ============================================================================
   realtime.test.js — presence, chat and moderation over a real WebSocket.

   Two players stand on Fortune Isle and a third sails to the Great Mine. Every
   assertion here is made from what a peer's socket actually received, never
   from server internals, because the wire protocol is the contract the browser
   client is written against.

   The two behaviours worth stating out loud, since both are easy to regress:

     mute follows the ACCOUNT, not the socket. A muted player who reconnects is
     handed a fresh peer id, and if mute were keyed on that id they would walk
     straight back into every room they were muted in.

     a chat cooldown follows the ACCOUNT too. If it lived on the socket, F5
     would be the "undo" button for moderation.

   Chat carries a 1.2s per-peer gap, so `say()` below waits it out rather than
   having lines silently swallowed. That pacing is most of this file's runtime.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, registerUser, sleep } from './helpers.js';

const CHAT_GAP = 1200;          // realtime.js CHAT_GAP
const HELLO_GAP = 1000;         // realtime.js HELLO_GAP — a second hello inside this is ignored
const CLOSE_AUTH = 4401;        // bad or expired session token
const CLOSE_REPLACED = 4409;    // the same account opened a newer socket

/** When each socket last spoke, so `say` can respect the per-peer chat gap. */
const lastSaid = new Map();

/** Send a chat line, waiting out the cooldown the server enforces. */
async function say(sock, m) {
  const since = Date.now() - (lastSaid.get(sock) || 0);
  if (since < CHAT_GAP) await sleep(CHAT_GAP - since + 60);
  sock.send({ t: 'chat', m });
  lastSaid.set(sock, Date.now());
}

/** Say hello and return the welcome frame. */
async function enter(sock, world, extra = {}) {
  await sock.opened;
  sock.send({ t: 'hello', world, ...extra });
  return sock.waitType('welcome');
}

/**
 * Reconnect an account and settle the room before returning.
 *
 * The old socket's close, the newcomer's welcome and the room's `join` travel
 * on three different connections, so a test that drains straight after the
 * welcome can race the join and mistake it for a later event. Waiting for the
 * watcher to actually see the join makes the reconnect a single ordered step.
 */
async function reconnect({ server, old, watcher, token, world }) {
  const fresh = server.socket(token);

  /* one live socket per account: the newcomer evicts the old one */
  assert.equal((await old.closed).code, CLOSE_REPLACED, 'the old socket was not evicted');

  const welcome = await enter(fresh, world);
  await watcher.waitFor((m) => m.t === 'join' && m.p.id === welcome.id);
  watcher.drain();
  return { sock: fresh, id: welcome.id, welcome };
}

const isChat = (m) => m.t === 'chat';
const chatFrom = (name) => (m) => m.t === 'chat' && m.name === name;

describe('realtime', () => {
  let server;
  let alice, bob, carol;

  /* Sockets and peer ids, established by the first test and reused after. */
  let a, b;
  let aliceId, bobId;

  before(async () => {
    server = await startServer();
    alice = await registerUser(server);
    bob = await registerUser(server);
    carol = await registerUser(server);
  });

  after(async () => { await server.stop(); });

  /* ======================================================== authentication */

  it('refuses a socket without a valid session', async () => {
    for (const token of [undefined, '', 'not-a-real-token', 'f'.repeat(64)]) {
      const sock = server.socket(token);
      const closed = await sock.closed;
      assert.equal(closed.code, CLOSE_AUTH, `token ${JSON.stringify(token)} was let in`);
    }
  });

  /* ============================================================== presence */

  it('introduces the peers already standing on the isle', async () => {
    a = server.socket(alice.token);
    const welcomeA = await enter(a, 'isle', { title: 'Deckhand', wardrobe: { band: 2, scarf: 99 } });

    assert.equal(welcomeA.world, 'isle');
    assert.ok(welcomeA.id > 0);
    assert.deepEqual(welcomeA.peers, [], 'the first arrival has the isle to themselves');
    assert.deepEqual(welcomeA.nodes, []);
    assert.deepEqual(welcomeA.trees, []);
    aliceId = welcomeA.id;

    b = server.socket(bob.token);
    /* the client may claim any name it likes; the server uses the account's */
    const welcomeB = await enter(b, 'isle', { name: 'Administrator', title: 'Pearl Diver' });
    bobId = welcomeB.id;

    assert.notEqual(bobId, aliceId);
    assert.equal(welcomeB.peers.length, 1);
    assert.equal(welcomeB.peers[0].id, aliceId);
    assert.equal(welcomeB.peers[0].name, alice.username);
    assert.equal(welcomeB.peers[0].title, 'Deckhand');
    /* a wardrobe colour is clamped to the palette bound, not taken as given */
    assert.equal(welcomeB.peers[0].wardrobe.band, 2);
    assert.equal(welcomeB.peers[0].wardrobe.scarf, 31);

    const join = await a.waitType('join');
    assert.equal(join.p.id, bobId);
    assert.equal(join.p.name, bob.username, 'the display name is the account name, always');
    assert.notEqual(join.p.name, 'Administrator');
  });

  it('counts heads per isle over HTTP', async () => {
    const online = await server.get('/api/online');
    assert.equal(online.status, 200);
    assert.equal(online.body.rooms.isle, 2);
    assert.equal(online.body.total, 2);
  });

  /* ============================================================== position */

  it('broadcasts a position snapshot to the rest of the room', async () => {
    b.send({ t: 'pos', x: 12.345, y: 2, z: -8.5, face: 1.2, act: 'fish' });

    const snap = await a.waitFor((m) => m.t === 'snap' && m.a.some((row) => row[0] === bobId));
    const row = snap.a.find((r) => r[0] === bobId);
    /* [id, x, y, z, face, act] — coords to 2dp, facing to 3dp */
    assert.deepEqual(row, [bobId, 12.35, 2, -8.5, 1.2, 'fish']);
  });

  it('drops positions that are off the map or malformed', async () => {
    a.drain();
    /* Infinity and NaN are spelled as strings on purpose: JSON.stringify turns
       the real values into `null`, which the server reads as a perfectly valid
       0 — so the literal forms would test nothing at all. */
    for (const junk of [
      { x: 5000, y: 0, z: 0, face: 0 },              // outside COORD_LIMIT
      { x: -2048, y: 0, z: 0, face: 0 },
      { x: 1, y: 1, z: 1, face: 'Infinity' },
      { x: 1, y: 1, z: 1, face: 'NaN' },
      { x: 'over-there', y: 1, z: 1, face: 0 },
      { x: 1, y: 1, face: 0 },                       // no z at all
    ]) {
      b.send({ t: 'pos', ...junk });
    }
    await sleep(350);                                // several 10Hz ticks
    assert.equal(a.seen((m) => m.t === 'snap'), false,
      `junk made it onto the wire: ${JSON.stringify(a.unread())}`);

    /* an unknown action string degrades to idle rather than being echoed */
    b.send({ t: 'pos', x: 4, y: 0, z: 4, face: 0, act: 'hacking' });
    const snap = await a.waitFor((m) => m.t === 'snap' && m.a.some((r) => r[0] === bobId));
    assert.deepEqual(snap.a.find((r) => r[0] === bobId), [bobId, 4, 0, 4, 0, '']);
  });

  it('answers a ping', async () => {
    b.send({ t: 'ping' });
    await b.waitType('pong');
    /* an unknown frame type is ignored, not fatal */
    b.send({ t: 'definitely-not-a-real-message', payload: 1 });
    b.send({ t: 'ping' });
    await b.waitType('pong');
  });

  /* ================================================================== chat */

  it('delivers a chat line to the room', async () => {
    await say(b, 'ahoy from the pier');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.id, bobId);
    assert.equal(chat.name, bob.username);
    assert.equal(chat.m, 'ahoy from the pier');
    assert.ok(chat.at > 0);
  });

  it('silently drops an identical line repeated inside the dedupe window', async () => {
    a.drain();
    await say(b, 'ahoy from the pier');           // same line, seconds later
    await say(b, 'AHOY FROM THE PIER');           // and the shouty version
    await sleep(200);
    assert.equal(a.seen(isChat), false, 'a repeat got through');
  });

  it('masks anything that looks like a link', async () => {
    await say(b, 'free coins at www.definitely-not-a-scam.example now');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.m, 'free coins at [link] now');
    assert.ok(!chat.m.includes('example'));
  });

  it('squeezes a keysmash wall down to something readable', async () => {
    await say(b, 'WOIIIIIIIIIIII');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.m, 'WOIII');
  });

  /* ================================================== mute is per ACCOUNT */

  it('keeps a muted player muted through their own reconnect', async () => {
    a.send({ t: 'mute', id: bobId });
    const ack = await a.waitFor((m) => m.t === 'mute_ok');
    assert.equal(ack.id, bobId);

    a.drain();
    await say(b, 'can you still hear me');
    await sleep(300);
    assert.equal(a.seen(isChat), false, 'a muted line was delivered');

    /* Bob reconnects: new socket, new peer id, same account. If mute were
       keyed on the peer id he would be audible again — which is the whole
       reason realtime.js resolves a peer id to its account before muting. */
    const previousId = bobId;
    const rejoined = await reconnect({
      server, old: b, watcher: a, token: bob.token, world: 'isle',
    });
    b = rejoined.sock;
    bobId = rejoined.id;
    assert.notEqual(bobId, previousId, 'a reconnect should get a fresh peer id');

    await say(b, 'back again, can you hear me now');
    await sleep(300);
    assert.equal(a.seen(isChat), false, 'reconnecting shook off the mute');

    /* and unmuting restores him — mute is a preference, not a punishment */
    a.send({ t: 'unmute', id: bobId });
    await a.waitFor((m) => m.t === 'unmute_ok');

    await say(b, 'testing testing');
    const heard = await a.waitFor(isChat);
    assert.equal(heard.m, 'testing testing');
    assert.equal(heard.name, bob.username);
  });

  /* ============================================ profanity, strikes, cooldown */

  it('masks profanity but still delivers the line', async () => {
    await say(b, 'you are anjing');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.m, 'you are ✱✱✱✱✱✱', 'the line should land, defused');
  });

  it('sees through digit and symbol swaps', async () => {
    await say(b, 'total b4b1 move');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.m, 'total ✱✱✱✱ move');
  });

  it('leaves innocent words that merely contain one alone', async () => {
    /* whole-token matching is what dodges the Scunthorpe problem */
    await say(b, 'assist the class with kontrol');
    const chat = await a.waitFor(isChat);
    assert.equal(chat.m, 'assist the class with kontrol');
  });

  it('takes the megaphone away on the third strike, and keeps it away after a reconnect', async () => {
    /* two strikes are already on record from the tests above */
    await say(b, 'you are tolol');
    const masked = await a.waitFor(isChat);
    assert.equal(masked.m, 'you are ✱✱✱✱✱', 'the third strike still lands before the cooldown');

    const warned = await b.waitFor((m) => m.t === 'chat_err');
    assert.equal(warned.m, 'cooldown');

    a.drain();
    await say(b, 'a perfectly polite sentence');
    const refused = await b.waitFor((m) => m.t === 'chat_err');
    assert.equal(refused.m, 'cooldown');
    await sleep(200);
    assert.equal(a.seen(isChat), false, 'a line was broadcast during a cooldown');

    /* Reconnecting must not clear it: moderation state belongs to the account,
       or F5 becomes the undo button. */
    const rejoined = await reconnect({
      server, old: b, watcher: a, token: bob.token, world: 'isle',
    });
    b = rejoined.sock;
    bobId = rejoined.id;

    await say(b, 'fresh socket, same account');
    const still = await b.waitFor((m) => m.t === 'chat_err');
    assert.equal(still.m, 'cooldown');
    await sleep(200);
    assert.equal(a.seen(isChat), false, 'the cooldown did not survive the reconnect');
  });

  /* ======================================================= room isolation */

  it('keeps each isle in its own room', async () => {
    const c = server.socket(carol.token);
    const welcomeC = await enter(c, 'mine');

    assert.equal(welcomeC.world, 'mine');
    assert.deepEqual(welcomeC.peers, [], 'the Great Mine should be empty');

    const online = await server.get('/api/online');
    assert.equal(online.body.rooms.isle, 2);
    assert.equal(online.body.rooms.mine, 1);
    assert.equal(online.body.total, 3);

    /* nobody on Fortune Isle was told about an arrival on another isle */
    assert.equal(a.seen((m) => m.t === 'join'), false);

    /* Alice talks on the isle. Bob (same room) hears it; Carol does not.
       Bob is still in his chat cooldown, so Alice does the talking. */
    c.drain();
    b.drain();
    await say(a, 'anyone selling squid strips');

    const heard = await b.waitFor(chatFrom(alice.username));
    assert.equal(heard.m, 'anyone selling squid strips');
    await sleep(300);
    assert.equal(c.seen(isChat), false, 'chat leaked across isles');

    /* and a peer in another room cannot be muted or reported into existence */
    a.send({ t: 'mute', id: welcomeC.id });
    await sleep(200);
    assert.equal(a.seen((m) => m.t === 'mute_ok'), false);

    c.close();
    await c.closed;
    /* give the server its own close handler a moment before the head count in
       the next test reads the rooms */
    await sleep(150);
  });

  it('will not put an uninvited angler on the exclusive isle', async () => {
    /* Neon Shoals is chartered, not asked for. Nothing about being seen there is
       cosmetic — it is what the isle sells — so a hello naming it from an account
       with no charter lands on the starting isle instead, exactly like a stale
       key would. The ordinary isles are deliberately NOT checked this way. */
    const sock = server.socket(carol.token);
    const welcome = await enter(sock, 'neon');

    assert.equal(welcome.world, 'isle', 'an unchartered exclusive isle let a stranger in');

    sock.close();
    await sock.closed;
    await sleep(150);
  });

  it('will not conjure a private room out of an unknown world name', async () => {
    /* A stale localStorage key must still land the player somewhere real —
       rooms are worlds, and worlds are a closed set. */
    const sock = server.socket(carol.token);
    const welcome = await enter(sock, 'atlantis');

    assert.equal(welcome.world, 'isle', 'an unknown world falls back to the starting isle');
    assert.deepEqual(
      welcome.peers.map((p) => p.name).sort(),
      [alice.username, bob.username].sort(),
      'the fallback landed somewhere other than the isle everyone is standing on',
    );
  });

  /* =============================================================== leaving */

  it('tells the room when someone disconnects', async () => {
    b.drain();
    a.close();
    await a.closed;

    const leave = await b.waitFor((m) => m.t === 'leave' && m.id === aliceId);
    assert.equal(leave.id, aliceId);
  });
  /* ================================================================= boats */

  describe('boats', () => {
    it('shows the hull the account owns, not the one the client asks for', async () => {
      const s1 = server.socket(alice.token);
      await enter(s1, 'isle');

      const s2 = server.socket(bob.token);
      await enter(s2, 'isle');
      await s1.waitFor((m) => m.t === 'join');

      /* Alice owns no boat, so climbing aboard announces nothing at all —
         there is no hull to draw and the message is dropped rather than
         broadcast as a raft she does not have. */
      s1.send({ t: 'boat', on: true });
      await sleep(250);
      assert.equal(s2.seen((m) => m.t === 'boat'), false,
        'a player with no boat must not appear afloat');
    });

    it('never lets the client choose which hull it is seen in', async () => {
      const s3 = server.socket(alice.token);
      await enter(s3, 'isle');

      /* The wire has no field for it, but a client could still try. The level
         is read from the save, so anything sent here is ignored outright. */
      s3.send({ t: 'boat', on: true, lvl: 4, b: 4, boat: 4 });
      await sleep(250);
      assert.equal(s3.seen((m) => m.t === 'boat' && m.lvl > 0), false,
        'a claimed hull level must never reach the room');
    });

    it('puts the skipper back ashore when they sail to another isle', async () => {
      const s4 = server.socket(alice.token);
      await enter(s4, 'isle');
      /* Sailing is a second hello on the same socket, and the server rate-limits
         those: sent inside HELLO_GAP it is dropped on the floor and no welcome
         ever comes back. Waiting the gap out is what a real client does too —
         travel reloads the page, which takes far longer than a second. */
      await sleep(HELLO_GAP + 100);
      await enter(s4, 'cove');
      await sleep(HELLO_GAP + 100);
      const w = await enter(s4, 'isle');
      assert.ok(!(w.peers || []).some((p) => p.boat),
        'a hull must not survive a change of isle');
    });
  });
});
