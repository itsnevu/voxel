/* ============================================================================
   auth.test.js — who the server believes you are.

   Three doorways lead to a session token and all three are exercised here
   against a real running server: username+password, a wallet signature over a
   server-issued nonce, and a one-click guest account whose returned guestKey
   must still work as a password on the next visit.

   The wallet half uses @noble (already a dependency of the server, so no new
   package) to make a genuine secp256k1 keypair, derive its Ethereum address
   the way wallet.js does, and produce a real EIP-191 personal_sign signature.
   Nothing is stubbed: if recoverAddress() ever stops agreeing with a standard
   signer, these fail.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { startServer, registerUser, uniqueName } from './helpers.js';

/* ------------------------------------------------------ wallet fixtures --- */

/** A throwaway keypair plus the checksum-free lowercase address for it. */
function newWallet() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false);        // 65 bytes, 0x04-prefixed
  const addr = '0x' + Buffer.from(keccak_256(pub.subarray(1)).subarray(-20)).toString('hex');
  return { priv, address: addr };
}

/** The exact digest wallet.js hashes: keccak256("\x19Ethereum Signed Message:\n" + len + msg). */
function personalDigest(message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

/** A 65-byte r||s||v signature hex string, v in the classic 27/28 form. */
function signMessage(priv, message) {
  const sig = secp256k1.sign(personalDigest(message), priv);
  const rs = Buffer.from(sig.toCompactRawBytes());
  return '0x' + Buffer.concat([rs, Buffer.from([sig.recovery + 27])]).toString('hex');
}

/* ============================================================================ */

describe('auth', () => {
  let server;

  before(async () => { server = await startServer(); });
  after(async () => { await server.stop(); });

  /* ------------------------------------------------------ password auth --- */

  describe('register / login / logout', () => {
    it('registers an account and returns a working token', async () => {
      const username = uniqueName();
      const res = await server.post('/api/auth/register', {
        body: { username, password: 'a-good-long-password' },
      });

      assert.equal(res.status, 201);
      assert.equal(typeof res.body.token, 'string');
      assert.ok(res.body.token.length >= 32);
      assert.equal(res.body.user.username, username);
      assert.equal(typeof res.body.user.id, 'number');
      /* the password digest must never leave the database */
      assert.equal(res.body.user.pass_hash, undefined);

      const me = await server.get('/api/auth/me', { token: res.body.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, username);
    });

    it('refuses a duplicate username, case-insensitively', async () => {
      const user = await registerUser(server);
      const again = await server.post('/api/auth/register', {
        body: { username: user.username.toUpperCase(), password: 'another-password' },
      });
      assert.equal(again.status, 409);
    });

    it('refuses malformed usernames and short passwords', async () => {
      const bad = [
        { username: 'ab', password: 'a-good-long-password' },
        { username: 'has-a-dash', password: 'a-good-long-password' },
        { username: 'x'.repeat(21), password: 'a-good-long-password' },
        { username: uniqueName(), password: 'short' },
        { username: uniqueName() },
        {},
      ];
      for (const body of bad) {
        const res = await server.post('/api/auth/register', { body });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }
    });

    it('logs in with the right password and rejects the wrong one', async () => {
      const user = await registerUser(server);

      const good = await server.post('/api/auth/login', {
        body: { username: user.username, password: user.password },
      });
      assert.equal(good.status, 200);
      assert.equal(good.body.user.id, user.id);
      assert.notEqual(good.body.token, user.token);      // a second, independent session

      const bad = await server.post('/api/auth/login', {
        body: { username: user.username, password: 'not-the-password' },
      });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.token, undefined);
    });

    it('answers unknown users exactly like a wrong password', async () => {
      const unknown = await server.post('/api/auth/login', {
        body: { username: uniqueName(), password: 'a-good-long-password' },
      });
      const user = await registerUser(server);
      const wrongPass = await server.post('/api/auth/login', {
        body: { username: user.username, password: 'a-good-long-password' },
      });

      assert.equal(unknown.status, 401);
      assert.equal(wrongPass.status, 401);
      /* identical wording: the reply may not reveal which usernames exist */
      assert.deepEqual(unknown.body, wrongPass.body);
    });

    it('accepts the token as X-Auth-Token as well as a bearer', async () => {
      const user = await registerUser(server);
      const res = await server.get('/api/auth/me', { headers: { 'X-Auth-Token': user.token } });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, user.username);
    });

    it('destroys the session on logout, leaving other sessions alone', async () => {
      const user = await registerUser(server);
      const second = await server.post('/api/auth/login', {
        body: { username: user.username, password: user.password },
      });
      const otherToken = second.body.token;

      const out = await server.post('/api/auth/logout', { token: user.token });
      assert.equal(out.status, 200);

      const dead = await server.get('/api/auth/me', { token: user.token });
      assert.equal(dead.status, 401);

      const alive = await server.get('/api/auth/me', { token: otherToken });
      assert.equal(alive.status, 200);
    });

    it('rejects unknown, empty and absent tokens', async () => {
      for (const opts of [{}, { token: 'not-a-token' }, { token: 'x'.repeat(64) }]) {
        const res = await server.get('/api/auth/me', opts);
        assert.equal(res.status, 401);
      }
    });

    it('rate-limits repeated login attempts from one address', async () => {
      /* Every other request in the suite carries its own synthetic IP; this
         one pins a single address so the 10-per-10-minutes budget applies. */
      const ip = '198.51.100.7';
      const username = uniqueName();
      let limited = null;

      for (let i = 0; i < 12 && !limited; i++) {
        const res = await server.post('/api/auth/login', {
          ip, body: { username, password: 'wrong-password-here' },
        });
        if (res.status === 429) limited = { at: i + 1, res };
        else assert.equal(res.status, 401);
      }

      assert.ok(limited, 'the limiter never fired within 12 attempts');
      assert.equal(limited.at, 11, 'ten attempts should be allowed, the eleventh refused');
      assert.ok(Number(limited.res.headers.get('retry-after')) > 0);

      /* the budget is per address: an untouched one still works */
      const fresh = await server.post('/api/auth/login', {
        ip: '198.51.100.8', body: { username, password: 'wrong-password-here' },
      });
      assert.equal(fresh.status, 401);
    });
  });

  /* ------------------------------------------------------- wallet (SIWE) -- */

  describe('wallet sign-in', () => {
    it('turns a real signature over the issued nonce into a session', async () => {
      const wallet = newWallet();

      const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      assert.equal(nonce.status, 200);
      assert.equal(typeof nonce.body.nonce, 'string');
      assert.ok(nonce.body.message.includes(nonce.body.nonce));
      assert.ok(nonce.body.message.includes(wallet.address));

      const verify = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: signMessage(wallet.priv, nonce.body.message) },
      });
      assert.equal(verify.status, 200);
      assert.equal(verify.body.wallet, wallet.address.toLowerCase());
      assert.match(verify.body.username, /^w_[0-9a-f]{6}/);

      const me = await server.get('/api/auth/me', { token: verify.body.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, verify.body.username);
    });

    it('returns the same account when the same wallet signs in again', async () => {
      const wallet = newWallet();

      const first = await signIn(server, wallet);
      const second = await signIn(server, wallet);

      assert.equal(first.username, second.username);
      assert.notEqual(first.token, second.token);

      const me = await server.get('/api/auth/me', { token: second.token });
      assert.equal(me.body.user.username, first.username);
    });

    it('rejects a signature made by a different key', async () => {
      const wallet = newWallet();
      const impostor = newWallet();

      const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      const res = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: signMessage(impostor.priv, nonce.body.message) },
      });

      assert.equal(res.status, 401);
      assert.equal(res.body.token, undefined);
    });

    it('rejects a signature over a message the server never issued', async () => {
      const wallet = newWallet();
      await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);

      const forged = signMessage(wallet.priv, 'Reel Fortune 3D wants you to sign in\n\nNonce: 00');
      const res = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: forged },
      });
      assert.equal(res.status, 401);
    });

    it('rejects malformed signatures and addresses', async () => {
      const wallet = newWallet();

      const badAddr = await server.post('/api/auth/wallet/verify', {
        body: { address: '0xnope', signature: '0x' + '11'.repeat(65) },
      });
      assert.equal(badAddr.status, 400);

      await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      const shortSig = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: '0xdeadbeef' },
      });
      assert.equal(shortSig.status, 401);

      const noNonce = await server.get('/api/auth/wallet/nonce?address=0x1234');
      assert.equal(noNonce.status, 400);
    });

    it('burns the nonce after one use — a valid signature cannot be replayed', async () => {
      const wallet = newWallet();
      const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      const signature = signMessage(wallet.priv, nonce.body.message);

      const first = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature },
      });
      assert.equal(first.status, 200);

      const replay = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature },
      });
      assert.equal(replay.status, 400);
      assert.match(replay.body.error, /nonce/i);
    });

    it('burns the nonce even on a FAILED attempt', async () => {
      const wallet = newWallet();
      const impostor = newWallet();
      const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);

      const failed = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: signMessage(impostor.priv, nonce.body.message) },
      });
      assert.equal(failed.status, 401);

      /* the real owner's own signature over that same nonce is now worthless:
         one guess per nonce, so a signature cannot be brute-forced */
      const retry = await server.post('/api/auth/wallet/verify', {
        body: { address: wallet.address, signature: signMessage(wallet.priv, nonce.body.message) },
      });
      assert.equal(retry.status, 400);
      assert.match(retry.body.error, /nonce/i);
    });

    it('issues a different nonce every time', async () => {
      const wallet = newWallet();
      const a = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      const b = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
      assert.notEqual(a.body.nonce, b.body.nonce);
    });
  });

  /* ---------------------------------------------------------- guest play -- */

  describe('guest accounts', () => {
    it('mints a playable account and hands back a reusable key', async () => {
      const guest = await server.post('/api/auth/guest');
      assert.equal(guest.status, 200);
      assert.match(guest.body.username, /^guest_[a-z0-9]{6}$/);
      assert.equal(typeof guest.body.guestKey, 'string');
      assert.equal(guest.body.guestKey.length, 24);

      const me = await server.get('/api/auth/me', { token: guest.body.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, guest.body.username);

      /* the whole point of guestKey: the browser stores it and logs back in */
      const relogin = await server.post('/api/auth/login', {
        body: { username: guest.body.username, password: guest.body.guestKey },
      });
      assert.equal(relogin.status, 200);
      assert.equal(relogin.body.user.id, me.body.user.id);

      /* the returning guest finds the same save, not a new one */
      const state = await server.get('/api/state', { token: relogin.body.token });
      assert.equal(state.status, 200);
      assert.equal(state.body.state.world, 'isle');
    });

    it('gives every guest its own account and key', async () => {
      const a = await server.post('/api/auth/guest');
      const b = await server.post('/api/auth/guest');
      assert.notEqual(a.body.username, b.body.username);
      assert.notEqual(a.body.guestKey, b.body.guestKey);

      /* one guest's key must not open another guest's account */
      const crossed = await server.post('/api/auth/login', {
        body: { username: a.body.username, password: b.body.guestKey },
      });
      assert.equal(crossed.status, 401);
    });

    it('rate-limits guest minting per address', async () => {
      const ip = '203.0.113.44';
      const seen = [];
      for (let i = 0; i < 7; i++) {
        const res = await server.post('/api/auth/guest', { ip });
        seen.push(res.status);
      }
      assert.deepEqual(seen.slice(0, 5), [200, 200, 200, 200, 200]);
      assert.equal(seen[5], 429, 'the sixth guest from one address should be refused');
    });
  });
});

/** Nonce -> signature -> token, the whole wallet handshake in one call. */
async function signIn(server, wallet) {
  const nonce = await server.get(`/api/auth/wallet/nonce?address=${wallet.address}`);
  const res = await server.post('/api/auth/wallet/verify', {
    body: { address: wallet.address, signature: signMessage(wallet.priv, nonce.body.message) },
  });
  assert.equal(res.status, 200, `wallet sign-in failed: ${res.text}`);
  return res.body;
}
