// Wallet (Sign-In-With-Ethereum style) and guest authentication.
//
// The wallet is used purely as an identity: signing a server-issued nonce
// message proves control of an address. There is NO transaction, NO fee, no
// funds are touched, and nothing here connects to the in-game coin economy.
// Guests get a throwaway account whose random password is returned once
// (guestKey) so the client can stash it in localStorage and log in normally
// next time.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { users, sessions, wallets } from './db.js';
import { hashPassword } from './auth.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_TTL_MS = 5 * 60 * 1000;

// addrLower -> { message, exp }. In-memory and single-use: the same trade-off
// as the login rate limiter — fine for a single-process VPS deployment.
const pendingNonces = new Map();

function prunePendingNonces(now) {
  for (const [addr, rec] of pendingNonces) {
    if (rec.exp <= now) pendingNonces.delete(addr);
  }
}

/** The exact text the wallet is asked to sign. Rebuilt nowhere else — the
 *  stored copy is what gets hashed at verify time, so client and server can
 *  never disagree about whitespace. */
function loginMessage(addr, nonce) {
  return `Reel Fortune 3D wants you to sign in\n\nAddress: ${addr}\nNonce: ${nonce}\n\nThis signature only proves wallet ownership. No transaction, no fees, no funds are involved.`;
}

/** EIP-191 personal_sign digest: keccak256("\x19Ethereum Signed Message:\n" + len + message). */
function personalDigest(message) {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

/**
 * Recover the signing address from a 65-byte (r||s||v) hex signature over
 * `digest`. Returns the lowercased 0x address, or null when the signature is
 * malformed or recovery fails.
 */
function recoverAddress(digest, signature) {
  const hex = String(signature).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;

  const sig = Buffer.from(hex, 'hex');
  let v = sig[64];
  if (v === 27 || v === 28) v -= 27; // both classic and raw recovery ids accepted
  if (v !== 0 && v !== 1) return null;

  try {
    const pubkey = secp256k1.Signature
      .fromCompact(sig.subarray(0, 64))
      .addRecoveryBit(v)
      .recoverPublicKey(digest)
      .toRawBytes(false); // 65 bytes, 0x04-prefixed uncompressed point
    const hash = keccak_256(pubkey.subarray(1));
    return '0x' + Buffer.from(hash.subarray(hash.length - 20)).toString('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers for minting accounts
// ---------------------------------------------------------------------------

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** n random chars from [a-z0-9], rejection-sampled so no modulo bias. */
function randChars(n) {
  let out = '';
  while (out.length < n) {
    const bytes = randomBytes(n * 2);
    for (let i = 0; i < bytes.length && out.length < n; i++) {
      if (bytes[i] < 252) out += ALPHANUM[bytes[i] % 36]; // 252 = 36 * 7
    }
  }
  return out;
}

/**
 * Create the account for a freshly verified wallet and bind the address.
 * Username is "w_" + first 6 hex chars of the address (already lowercase, so
 * it passes the 3-20 [a-z0-9_] username rule), with a numeric suffix when the
 * name is taken. The password is random 32-byte noise nobody ever sees:
 * wallet accounts sign in by signature, not by password.
 */
function createWalletUser(addrLower) {
  const base = `w_${addrLower.slice(2, 8)}`;
  const passHash = hashPassword(randomBytes(32).toString('hex'));
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? base : `${base}${i + 1}`;
    if (users.findByName(name)) continue;
    let id;
    try {
      id = users.create(name, passHash);
    } catch (err) {
      // Lost a race against a concurrent registration of the same name.
      if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) continue;
      throw err;
    }
    wallets.attach(id, addrLower);
    return id;
  }
  throw new Error('could not allocate wallet username');
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP) — same shape as auth.js, different budgets.
// ---------------------------------------------------------------------------

function makeRateLimiter(max, windowMs) {
  const hits = new Map(); // ip -> { count, resetAt }
  return function rateLimit(req, res, next) {
    const now = Date.now();
    // Cheap opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 5000) {
      for (const [ip, rec] of hits) {
        if (rec.resetAt <= now) hits.delete(ip);
      }
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'too many attempts, try again later' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountWalletAuth(app) {
  const json = express.json({ limit: '16kb' });
  const walletLimit = makeRateLimiter(20, 10 * 60 * 1000); // nonce + verify pool
  const guestLimit = makeRateLimiter(5, 10 * 60 * 1000);

  // Step 1: hand out a single-use nonce wrapped in the message to sign.
  app.get('/api/auth/wallet/nonce', walletLimit, (req, res) => {
    const addr = typeof req.query.address === 'string' ? req.query.address : '';
    if (!ADDRESS_RE.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    const now = Date.now();
    if (pendingNonces.size > 5000) prunePendingNonces(now);

    const nonce = randomBytes(16).toString('hex');
    const message = loginMessage(addr, nonce);
    pendingNonces.set(addr.toLowerCase(), { message, exp: now + NONCE_TTL_MS });
    res.json({ address: addr, nonce, message });
  });

  // Step 2: the signature over that message proves ownership -> session token.
  app.post('/api/auth/wallet/verify', walletLimit, json, (req, res) => {
    const body = req.body || {};
    const addr = typeof body.address === 'string' ? body.address : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!ADDRESS_RE.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }

    const addrLower = addr.toLowerCase();
    const entry = pendingNonces.get(addrLower);
    // Single use: even a failed attempt burns the nonce, so a signature can
    // never be replayed and brute-forcing gets one guess per nonce.
    pendingNonces.delete(addrLower);
    if (!entry || entry.exp <= Date.now()) {
      return res.status(400).json({ error: 'nonce missing or expired, request a new one' });
    }

    const recovered = recoverAddress(personalDigest(entry.message), signature);
    if (!recovered || recovered !== addrLower) {
      return res.status(401).json({ error: 'signature does not match address' });
    }

    let row = wallets.findUser(addrLower);
    if (!row) {
      // Handlers run synchronously (better-sqlite3), so create+attach cannot
      // interleave with another request; the catch is belt-and-braces for the
      // unique wallet index anyway.
      try {
        row = users.findById(createWalletUser(addrLower));
      } catch (err) {
        row = wallets.findUser(addrLower);
        if (!row) throw err;
      }
    }

    const token = sessions.create(row.id);
    res.json({ token, username: row.username, wallet: addrLower });
  });

  // One-click guest account. The random password is returned exactly once as
  // guestKey; the client stores it and uses the normal login route afterwards.
  app.post('/api/auth/guest', guestLimit, (req, res) => {
    const guestKey = randChars(24);
    const passHash = hashPassword(guestKey);

    let id = null;
    let username = '';
    for (let tries = 0; tries < 20 && id === null; tries++) {
      username = `guest_${randChars(6)}`;
      if (users.findByName(username)) continue;
      try {
        id = users.create(username, passHash);
      } catch (err) {
        if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) continue;
        throw err;
      }
    }
    if (id === null) {
      return res.status(500).json({ error: 'could not allocate guest account' });
    }

    const token = sessions.create(id);
    res.json({ token, username, guestKey });
  });
}
