/* ============================================================================
   nft.test.js — what the chain says you may wear.

   Two things are worth testing here and neither needs a blockchain.

   1. The ABI decoder. `uint256[]` comes back as an offset, a length and a run
      of 32-byte words, and every field is attacker-influenced: a hostile or
      broken RPC that answers with a length of 2^256-1 must not become an
      allocation, and a truncated payload must not become a NaN token id.

   2. The equip gate. A token id in a request body is a claim, not a fact, so
      the route must refuse one the address does not hold — and must refuse
      every token for an account that has no address at all, which is what
      "guests get the default character" actually means.

   The RPC is a real local HTTP server that answers eth_call with whatever the
   test wants, so the JSON-RPC round trip is exercised for real while staying
   hermetic.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer, registerUser, uniqueName } from './helpers.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/* ------------------------------------------------------ wallet fixtures --- */

function newWallet() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false);
  const addr = '0x' + Buffer.from(keccak_256(pub.subarray(1)).subarray(-20)).toString('hex');
  return { priv, address: addr };
}

function personalDigest(message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

function signMessage(priv, message) {
  const sig = secp256k1.sign(personalDigest(message), priv);
  return '0x' + Buffer.from(sig.toCompactRawBytes()).toString('hex')
    + (27 + sig.recovery).toString(16).padStart(2, '0');
}

/** A wallet account with a name, so it has an address the chain can be asked about. */
async function walletUser(server) {
  const wallet = newWallet();
  const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
  const verify = await server.post('/api/auth/wallet/verify', {
    body: { address: wallet.address, signature: signMessage(wallet.priv, nonce.body.message) },
  });
  const claimed = await server.post('/api/auth/wallet/claim', {
    body: { claim: verify.body.claim, username: uniqueName('angler') },
  });
  assert.equal(claimed.status, 201, `wallet setup failed: ${claimed.text}`);
  return { ...claimed.body, address: wallet.address.toLowerCase() };
}

/* -------------------------------------------------------- the fake chain -- */

/** ABI-encode a uint256[] the way a well-behaved contract returns one. */
function encodeUintArray(ids) {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  return '0x' + word(32) + word(ids.length) + ids.map(word).join('');
}

/**
 * An HTTP server that speaks just enough JSON-RPC. `reply` decides what each
 * eth_call answers, so a test can hand back tokens, garbage, or an error.
 */
async function startFakeChain(reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
      calls.push(parsed);
      const out = reply(parsed, calls.length);
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/* ============================================================================ */

describe('nft', () => {
  describe('ABI decoding, through a real RPC round trip', () => {
    let chain, server, answer;

    before(async () => {
      answer = () => ({ body: { jsonrpc: '2.0', id: 1, result: encodeUintArray([]) } });
      chain = await startFakeChain((...a) => answer(...a));
      server = await startServer({
        env: { NFT_RPC_URL: chain.url, NFT_CONTRACT: CONTRACT, NFT_CHAIN_ID: '31337' },
      });
    });
    after(async () => {
      await server.stop();
      await chain.stop();
    });

    /** Sign in a wallet-less account and read its characters. */
    async function charactersFor(token, query = '') {
      return server.get(`/api/nft/characters${query}`, { token });
    }

    it('publishes the chain it is pointed at', async () => {
      const res = await server.get('/api/nft/config');
      assert.equal(res.status, 200);
      assert.equal(res.body.chainId, 31337);
      assert.equal(res.body.contract, CONTRACT.toLowerCase());
      assert.equal(res.body.configured, true);
    });

    it('survives an RPC that lies about how long the array is', async () => {
      const user = await walletUser(server);
      const word = (n) => BigInt(n).toString(16).padStart(64, '0');

      const nonsense = [
        // Length says 2^256-1, payload carries nothing. A decoder that trusted
        // it would try to build an array of that size.
        '0x' + word(32) + 'f'.repeat(64),
        // Length of 3, but only one word actually follows.
        '0x' + word(32) + word(3) + word(9),
        // Offset points past the end of the payload.
        '0x' + word(4096) + word(1) + word(9),
        '0x',
        '0x00',
      ];

      for (const result of nonsense) {
        answer = () => ({ body: { jsonrpc: '2.0', id: 1, result } });
        const res = await server.get('/api/nft/characters?fresh=1', { token: user.token });
        assert.equal(res.status, 200, `payload ${result.slice(0, 12)} should not break the route`);
        assert.ok(Array.isArray(res.body.tokens));
        assert.ok(res.body.tokens.every(Number.isInteger),
          `payload ${result.slice(0, 12)} produced a non-integer token id`);
      }
    });

    it('keeps the last known collection when the chain goes dark', async () => {
      const user = await walletUser(server);

      answer = () => ({ body: { jsonrpc: '2.0', id: 1, result: encodeUintArray([3, 4]) } });
      const good = await server.get('/api/nft/characters?fresh=1', { token: user.token });
      assert.deepEqual(good.body.tokens, [3, 4]);

      // An unreachable chain must not read as "you own nothing" — that would
      // undress a player whose only problem is a flaky RPC.
      answer = () => ({ status: 500, body: { error: { message: 'down' } } });
      const dark = await server.get('/api/nft/characters?fresh=1', { token: user.token });
      assert.equal(dark.status, 200);
      assert.equal(dark.body.ok, false);
      assert.equal(dark.body.stale, true);
      assert.deepEqual(dark.body.tokens, [3, 4]);
    });

    it('gives an account with no wallet an empty collection, not an error', async () => {
      const user = await registerUser(server, { username: uniqueName('landlubber') });
      const before = chain.calls.length;
      const res = await charactersFor(user.token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.tokens, []);
      assert.equal(res.body.reason, 'NO_WALLET');
      // No wallet means no reason to have asked the chain anything.
      assert.equal(chain.calls.length, before);
    });
  });

  /* ---------------------------------------------------------- the gate ---- */

  describe('equipping a character', () => {
    let chain, server, owned;

    before(async () => {
      owned = [];
      chain = await startFakeChain(() => ({
        body: { jsonrpc: '2.0', id: 1, result: encodeUintArray(owned) },
      }));
      server = await startServer({
        env: { NFT_RPC_URL: chain.url, NFT_CONTRACT: CONTRACT, NFT_CHAIN_ID: '31337' },
      });
    });
    after(async () => {
      await server.stop();
      await chain.stop();
    });

    it('refuses every Angler to an account with no wallet', async () => {
      const user = await registerUser(server, { username: uniqueName('guestish') });
      const res = await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 7 } });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'NO_WALLET');
    });

    it('still lets anyone go back to the default hero', async () => {
      const user = await registerUser(server, { username: uniqueName('default') });
      const res = await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 0 } });
      assert.equal(res.status, 200);
      // Undressing is unconditional, so it must not have cost a chain call.
      const before = chain.calls.length;
      await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 0 } });
      assert.equal(chain.calls.length, before);
    });

    it('lets a wallet wear an Angler it holds, and refuses one it does not', async () => {
      const user = await walletUser(server);

      owned = [];
      const before = await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 417 } });
      assert.equal(before.status, 403);
      assert.equal(before.body.code, 'NOT_OWNED');

      owned = [12, 417, 900];
      const after = await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 417 } });
      assert.equal(after.status, 200);
      assert.equal(after.body.charTokenId, 417);

      const mine = await server.get('/api/nft/characters', { token: user.token });
      assert.deepEqual(mine.body.tokens, [12, 417, 900]);
      assert.equal(mine.body.wallet, user.address);
    });

    it('stops a sold Angler from being re-equipped', async () => {
      const user = await walletUser(server);

      owned = [55];
      assert.equal((await server.post('/api/nft/equip',
        { token: user.token, body: { tokenId: 55 } })).status, 200);

      // Sold on. The next attempt must consult the chain again, not a cache.
      owned = [];
      const again = await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 55 } });
      assert.equal(again.status, 403);
      assert.equal(again.body.code, 'NOT_OWNED');
    });

    it('rejects a token id that is not a positive integer', async () => {
      const user = await registerUser(server, { username: uniqueName('bad') });
      for (const tokenId of [-1, 1.5, 'seven', null]) {
        const res = await server.post('/api/nft/equip', { token: user.token, body: { tokenId } });
        assert.equal(res.status, 400, `${tokenId} should not be a token id`);
        assert.equal(res.body.code, 'BAD_TOKEN');
      }
    });
  });

  /* ------------------------------------------------ the exclusive isle ---- */

  describe('an isle that only opens for Angler holders', () => {
    let chain, server, owned;

    before(async () => {
      owned = [];
      chain = await startFakeChain(() => ({
        body: { jsonrpc: '2.0', id: 1, result: encodeUintArray(owned) },
      }));
      server = await startServer({
        env: { NFT_RPC_URL: chain.url, NFT_CONTRACT: CONTRACT, NFT_CHAIN_ID: '31337' },
      });
    });
    after(async () => {
      await server.stop();
      await chain.stop();
    });

    const travel = (token, world) =>
      server.post('/api/action/travel', { token, body: { world } });

    it('refuses the isle to an account with no wallet at all', async () => {
      const user = await registerUser(server, { username: uniqueName('landlubber') });
      const res = await travel(user.token, 'neon');
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'NO_WALLET');
    });

    it('closes the isle once the Angler has been sold', async () => {
      const user = await walletUser(server);

      /* Own one, wear it: this is the state actions.js reads, and on its own it
         would let the unlock through for ever after. */
      owned = [21];
      assert.equal((await server.post('/api/nft/equip',
        { token: user.token, body: { tokenId: 21 } })).status, 200);

      // sold — the chain no longer lists it, but charTokenId still says 21
      owned = [];
      const me = await server.get('/api/state', { token: user.token });
      assert.equal(me.body.state.charTokenId, 21,
        'the stale record is the whole point of this test');

      const res = await travel(user.token, 'neon');
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'NOT_OWNED');
    });

    it('ignores a client that simply claims it owns one', async () => {
      /* actions.js reads body.anglerOwned, so the obvious attack is to send it.
         The route deletes the field before the gate runs and only the gate may
         set it — this is the test that says so. */
      const user = await walletUser(server);
      owned = [];
      const res = await server.post('/api/action/travel',
        { token: user.token, body: { world: 'neon', anglerOwned: true } });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'NOT_OWNED');
    });

    it('opens for a holder who is wearing the default hero', async () => {
      /* Owning and wearing are different facts. Someone who took the costume
         off still holds the token, and the isle is gated on holding. */
      const user = await walletUser(server);
      owned = [33];
      assert.equal((await server.post('/api/nft/equip',
        { token: user.token, body: { tokenId: 33 } })).status, 200);
      assert.equal((await server.post('/api/nft/equip',
        { token: user.token, body: { tokenId: 0 } })).status, 200);   // take it off

      const me = await server.get('/api/state', { token: user.token });
      assert.equal(me.body.state.charTokenId, 0, 'wearing nothing');

      const res = await travel(user.token, 'neon');
      assert.notEqual(res.status, 403, `a holder must not be refused: ${res.text}`);
    });

    it('refuses rather than opens when the chain cannot be reached', async () => {
      const user = await walletUser(server);
      owned = [7];
      await server.post('/api/nft/equip', { token: user.token, body: { tokenId: 7 } });

      const stop = await chain.stop();          // the RPC goes dark
      const res = await travel(user.token, 'neon');
      assert.equal(res.status, 503, 'an unreachable chain must not open the door');
      assert.equal(res.body.code, 'CHAIN_UNREACHABLE');
      return stop;
    });
  });

  /* ------------------------------------------------- what others can see -- */

  describe('showing an Angler to the rest of the isle', () => {
    let chain, server, owned;

    before(async () => {
      owned = [];
      chain = await startFakeChain(() => ({
        body: { jsonrpc: '2.0', id: 1, result: encodeUintArray(owned) },
      }));
      server = await startServer({
        env: { NFT_RPC_URL: chain.url, NFT_CONTRACT: CONTRACT, NFT_CHAIN_ID: '31337' },
      });
    });
    after(async () => {
      await server.stop();
      await chain.stop();
    });

    /** Say hello on `world` and return the welcome frame. */
    async function enter(sock, world, extraFields) {
      await sock.opened;
      sock.send(Object.assign({ t: 'hello', world }, extraFields || {}));
      return sock.waitFor((m) => m.t === 'welcome');
    }

    it('tells an arriving player which Angler everyone is already wearing', async () => {
      const wearer = await walletUser(server);
      owned = [77];
      assert.equal((await server.post('/api/nft/equip',
        { token: wearer.token, body: { tokenId: 77 } })).status, 200);

      const a = server.socket(wearer.token);
      await enter(a, 'isle');

      const watcher = await walletUser(server);
      const b = server.socket(watcher.token);
      const welcome = await enter(b, 'isle');

      const seen = welcome.peers.find((p) => p.name === wearer.username);
      assert.ok(seen, 'the wearer should be standing on the isle');
      assert.equal(seen.charTokenId, 77, 'a peer arriving late must still see the costume');
    });

    it('shows a change of Angler without anybody reconnecting', async () => {
      const wearer = await walletUser(server);
      const watcher = await walletUser(server);

      const a = server.socket(wearer.token);
      await enter(a, 'cove');
      const b = server.socket(watcher.token);
      await enter(b, 'cove');
      // `a` is who hears about b arriving — a join never goes back to the
      // player it announces. Waiting on the wrong socket here is why this test
      // failed the first time it ran.
      await a.waitFor((m) => m.t === 'join');

      owned = [500];
      assert.equal((await server.post('/api/nft/equip',
        { token: wearer.token, body: { tokenId: 500 } })).status, 200);

      const on = await b.waitFor((m) => m.t === 'skin');
      assert.equal(on.charTokenId, 500);

      // …and taking it off has to travel too, or an unequip is invisible.
      assert.equal((await server.post('/api/nft/equip',
        { token: wearer.token, body: { tokenId: 0 } })).status, 200);
      const off = await b.waitFor((m) => m.t === 'skin');
      assert.equal(off.id, on.id);
      assert.equal(off.charTokenId, 0);
    });

    it('ignores an Angler the client simply claims in its hello', async () => {
      /* The wardrobe indices in a hello are bounded numbers and cost nothing to
         fake. A token id is a claim of PROPERTY, so it must not be taken from
         the client at all — this is the test that says so. */
      const liar = await walletUser(server);
      const watcher = await walletUser(server);

      const a = server.socket(liar.token);
      await enter(a, 'reef', { charTokenId: 999, wardrobe: { band: 1 } });

      const b = server.socket(watcher.token);
      const welcome = await enter(b, 'reef');
      const seen = welcome.peers.find((p) => p.name === liar.username);
      assert.ok(seen);
      assert.equal(seen.charTokenId, 0, 'a claimed token must never reach another screen');
      assert.equal(seen.wardrobe.band, 1, 'ordinary wardrobe colours still come from the client');
    });

    it('keeps a guest on the default hero in front of everyone', async () => {
      const guest = await registerUser(server, { username: uniqueName('landlocked') });
      const watcher = await walletUser(server);

      const a = server.socket(guest.token);
      await enter(a, 'bay', { charTokenId: 42 });
      const b = server.socket(watcher.token);
      const welcome = await enter(b, 'bay');

      const seen = welcome.peers.find((p) => p.name === guest.username);
      assert.ok(seen);
      assert.equal(seen.charTokenId, 0);
    });
  });
});
