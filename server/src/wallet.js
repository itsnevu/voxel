// Wallet (Sign-In With Ethereum, EIP-4361) and guest authentication.
//
// The wallet is used purely as an identity: signing a server-issued, origin-
// bound challenge proves control of an address. There is NO transaction, NO fee, no
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
import { isBanned } from './admin.js';
import { ipRateLimit } from './middleware.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const NONCE_TTL_MS = 5 * 60 * 1000;

/* Live challenges per address. The cap is what keeps the by-address fallback
   below cheap: a verify that arrives without its nonce id costs at most this
   many signature recoveries. */
const NONCE_PER_ADDRESS = 5;

/* ----------------------------------------------------------------------------
   ORIGIN BINDING
   ----------------------------------------------------------------------------
   Without a domain in the signed text there is nothing to bind a signature to
   this site. A third-party page could fetch a nonce for a visitor's address,
   hand them the server's own message to sign — MetaMask's domain-mismatch
   warning cannot fire when there is no domain field to mismatch — and trade the
   signature for a 30-day session here. So the message is EIP-4361, the domain
   comes from the request's own Origin, and the origin is checked against the
   configured CORS allow-list again at verify time, when it actually matters.

   CORS_ORIGIN='*' (the dev default) accepts any origin, exactly as the CORS
   policy it mirrors already does. Naming real origins there is what turns this
   into a closed door; index.js already warns at boot when it is a wildcard.
   -------------------------------------------------------------------------- */
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').trim();
const ORIGIN_LIST = CORS_ORIGIN === '*'
  ? null
  : CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

/* SIWE requires a chain id. The wallet is an identity here and never signs a
   transaction, so the value is cosmetic — but it must be present and stable, or
   the wallet will not recognise the text as a sign-in request at all. */
const CHAIN_ID = Number(process.env.WALLET_CHAIN_ID) > 0
  ? Math.trunc(Number(process.env.WALLET_CHAIN_ID))
  : 1;

/** `scheme://host[:port]`, or '' for anything that is not an absolute http URL. */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** The origin this very request was addressed to, from Host + the proxy's proto. */
function selfOrigin(req) {
  const host = req.headers && req.headers.host;
  if (typeof host !== 'string' || !host) return '';
  const fwd = req.headers['x-forwarded-proto'];
  const proto = fwd ? String(fwd).split(',')[0].trim().toLowerCase()
    : (req.secure ? 'https' : (req.protocol || 'http'));
  return normalizeOrigin(`${proto}://${host}`);
}

/** The origin to bind a challenge to: the browser's, or ours for a curl caller. */
function requestOrigin(req) {
  return normalizeOrigin(req.headers && req.headers.origin) || selfOrigin(req);
}

/**
 * Is this origin allowed to mint sessions here? Same allow-list CORS uses, plus
 * our own origin — the page is served from this host, and a deployment that
 * names only its CDN in CORS_ORIGIN must not lock out its own login page.
 */
function originAllowed(origin, req) {
  if (!origin) return false;
  if (!ORIGIN_LIST) return true;
  if (ORIGIN_LIST.includes(origin)) return true;
  return origin === selfOrigin(req);
}

/** EIP-55 mixed-case checksum. EIP-4361 requires it, and wallets check it. */
function toChecksumAddress(addrLower) {
  const body = addrLower.slice(2);
  const hash = Buffer.from(keccak_256(Buffer.from(body, 'utf8'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/* nonce id -> { message, addr, origin, exp }. In-memory and single-use: the
   same trade-off as the login rate limiter — fine for a single-process VPS.

   Keyed by NONCE, never by address. Keyed by address, anyone could burn a
   victim's in-flight challenge simply by asking for one of their own (or by
   posting a garbage signature) the instant before they signed. */
const pendingNonces = new Map();

function prunePendingNonces(now) {
  for (const [id, rec] of pendingNonces) {
    if (rec.exp <= now) pendingNonces.delete(id);
  }
}

/** Live challenges for one address, newest first. */
function noncesFor(addrLower, now) {
  const out = [];
  for (const [id, rec] of pendingNonces) {
    if (rec.addr === addrLower && rec.exp > now) out.push([id, rec]);
  }
  return out.reverse();   // Map iterates in insertion order; we want the latest
}

/** Keep at most NONCE_PER_ADDRESS live challenges per address, dropping oldest. */
function capNoncesFor(addrLower, now) {
  const live = noncesFor(addrLower, now);
  for (let i = NONCE_PER_ADDRESS - 1; i < live.length; i++) pendingNonces.delete(live[i][0]);
}

/**
 * The exact text the wallet is asked to sign, in EIP-4361 (Sign-In With
 * Ethereum) form. Rebuilt nowhere else — the stored copy is what gets hashed at
 * verify time, so client and server can never disagree about whitespace.
 *
 * The field order and the blank lines are not style: a wallet parses this
 * literally, and it is only because `domain` sits on the first line that
 * MetaMask can compare it against the page asking for the signature and warn
 * when they differ. That warning is the whole point of this shape.
 */
function loginMessage({ domain, uri, address, nonce, issuedAt, expiry }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to Reel Fortune 3D. This signature only proves wallet ownership. No transaction, no fees, no funds are involved.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiry}`,
  ].join('\n');
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
async function createWalletUser(addrLower) {
  const base = `w_${addrLower.slice(2, 8)}`;
  // Awaited up front so the create/attach pair below stays one synchronous run
  // of better-sqlite3 calls, exactly as it was.
  const passHash = await hashPassword(randomBytes(32).toString('hex'));
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

/* express 4 ignores a rejected promise from a handler, so an async one that
   throws would hang the request instead of reaching errorHandler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** The suspended-account answer, in index.js's ACCOUNT_SUSPENDED shape. */
function suspended(res, userId) {
  let ban = null;
  // isBanned() is fail-open by design (see admin.js); so is this.
  try { ban = isBanned(userId); } catch { return false; }
  if (!ban || !ban.banned) return false;

  const until = Number(ban.until) || 0;
  res.status(403).json({
    error: 'this account is suspended',
    code: 'ACCOUNT_SUSPENDED',
    reason: ban.reason || 'moderation action',
    until,
    untilIso: until > 0 ? new Date(until).toISOString() : null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountWalletAuth(app) {
  const json = express.json({ limit: '16kb' });
  // Per-IP ceilings, from middleware.js's shared limiter. Separate factory calls
  // mean separate maps, so a guest flood cannot spend the wallet budget.
  const walletLimit = ipRateLimit({ max: 20, windowMs: 10 * 60 * 1000 }); // nonce + verify pool
  const guestLimit = ipRateLimit({ max: 5, windowMs: 10 * 60 * 1000 });

  // Step 1: hand out a single-use nonce wrapped in the message to sign.
  app.get('/api/auth/wallet/nonce', walletLimit, (req, res) => {
    const addr = typeof req.query.address === 'string' ? req.query.address : '';
    if (!ADDRESS_RE.test(addr)) {
      return res.status(400).json({ error: 'invalid address', code: 'BAD_ADDRESS' });
    }

    // Refused here as well as at verify. The verify-time check is the one that
    // decides anything; this one just saves a stranger's page the round trip.
    const origin = requestOrigin(req);
    if (!originAllowed(origin, req)) {
      return res.status(403).json({ error: 'this origin may not sign in here', code: 'BAD_ORIGIN' });
    }

    const now = Date.now();
    prunePendingNonces(now);

    const addrLower = addr.toLowerCase();
    const nonce = randomBytes(16).toString('hex');
    const exp = now + NONCE_TTL_MS;
    const message = loginMessage({
      domain: new URL(origin).host,
      uri: origin,
      // EIP-55, not whatever casing the caller typed: a wallet renders the
      // checksummed form and a mismatch reads as a tampered message.
      address: toChecksumAddress(addrLower),
      nonce,
      issuedAt: new Date(now).toISOString(),
      expiry: new Date(exp).toISOString(),
    });

    pendingNonces.set(nonce, { message, addr: addrLower, origin, exp });
    capNoncesFor(addrLower, now);
    res.json({ address: addr, nonce, message });
  });

  // Step 2: the signature over that message proves ownership -> session token.
  app.post('/api/auth/wallet/verify', walletLimit, json, wrap(async (req, res) => {
    const body = req.body || {};
    const addr = typeof body.address === 'string' ? body.address : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!ADDRESS_RE.test(addr)) {
      return res.status(400).json({ error: 'invalid address', code: 'BAD_ADDRESS' });
    }

    const now = Date.now();
    const addrLower = addr.toLowerCase();
    prunePendingNonces(now);

    /* Which challenge is this a signature over?

       With the nonce id in the body there is exactly one candidate and it is
       burned pass or fail — only whoever asked for it knows its id, so burning
       it can never cost anyone else their login.

       Without one (the client that predates this route sends address+signature
       and nothing else) every live challenge for the address is tried and only
       the one that actually verifies is burned. That is what keeps a stranger's
       decoy nonce from consuming the challenge the real owner is mid-way
       through signing. Bounded by NONCE_PER_ADDRESS, so it is at most five
       recoveries and a rate-limited five at that. */
    const nonceId = typeof body.nonce === 'string' ? body.nonce.trim().toLowerCase() : '';
    let candidates;
    if (nonceId) {
      if (!NONCE_RE.test(nonceId)) {
        return res.status(400).json({ error: 'nonce missing or expired, request a new one', code: 'NONCE_EXPIRED' });
      }
      const rec = pendingNonces.get(nonceId);
      pendingNonces.delete(nonceId);
      candidates = rec && rec.addr === addrLower && rec.exp > now ? [[nonceId, rec]] : [];
    } else {
      candidates = noncesFor(addrLower, now);
    }
    if (!candidates.length) {
      return res.status(400).json({ error: 'nonce missing or expired, request a new one', code: 'NONCE_EXPIRED' });
    }

    let entry = null;
    for (const [id, rec] of candidates) {
      const recovered = recoverAddress(personalDigest(rec.message), signature);
      if (recovered && recovered === addrLower) { entry = rec; pendingNonces.delete(id); break; }
    }
    if (!entry) {
      return res.status(401).json({ error: 'signature does not match address', code: 'BAD_SIGNATURE' });
    }

    /* The check the whole EIP-4361 rewrite exists for. The origin baked into
       the text they signed must still be one we accept, and — when the browser
       tells us — must be the origin this exchange is coming from. A signature
       farmed on someone else's page carries that page's domain and dies here. */
    const seen = normalizeOrigin(req.headers && req.headers.origin);
    if (!originAllowed(entry.origin, req) || (seen && seen !== entry.origin)) {
      return res.status(403).json({ error: 'this origin may not sign in here', code: 'BAD_ORIGIN' });
    }

    let row = wallets.findUser(addrLower);
    if (!row) {
      // better-sqlite3 is synchronous and createWalletUser awaits its one hash
      // before touching the database, so create+attach still cannot interleave;
      // the catch is belt-and-braces for the unique wallet index anyway.
      try {
        row = users.findById(await createWalletUser(addrLower));
      } catch (err) {
        row = wallets.findUser(addrLower);
        if (!row) throw err;
      }
    }

    // The second front door gets the same bouncer as the first, and for the
    // same reason: after the proof of ownership, never before it.
    if (suspended(res, row.id)) return;

    const token = sessions.create(row.id);
    res.json({ token, username: row.username, wallet: addrLower });
  }));

  // One-click guest account. The random password is returned exactly once as
  // guestKey; the client stores it and uses the normal login route afterwards.
  app.post('/api/auth/guest', guestLimit, wrap(async (req, res) => {
    const guestKey = randChars(24);
    const passHash = await hashPassword(guestKey);

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
      return res.status(500).json({ error: 'could not allocate guest account', code: 'GUEST_ALLOC_FAILED' });
    }

    const token = sessions.create(id);
    res.json({ token, username, guestKey });
  }));
}
