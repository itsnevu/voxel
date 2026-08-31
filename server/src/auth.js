// Account + session handling.
//
// Tokens are returned in the JSON body (not as cookies) so the browser client
// can keep one in localStorage and send it back as `Authorization: Bearer ...`.
// That also keeps the API usable cross-origin without cookie/CORS credential
// gymnastics.

import express from 'express';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { users, sessions } from './db.js';
import { isBanned } from './admin.js';
import { ipRateLimit } from './middleware.js';

/* scrypt off the event loop. The sync form burns ~22ms of CPU inside the
   handler, which is 22ms nothing else on this single-threaded process can move
   — including the 10Hz realtime tick. The async form does the same work on
   libuv's threadpool, so a burst of logins costs latency to the people logging
   in rather than a stutter for everyone already playing. */
const scryptAsync = promisify(scrypt);

// scrypt work factors. 128 * N * r = 16 MiB per hash, under Node's default
// 32 MiB maxmem, and slow enough to make offline cracking expensive.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200; // refuse absurd inputs: scrypt cost scales with length

/** Derive a "salt:hash" hex string for a plaintext password. Async; the stored
 *  format is byte-identical to what the sync version wrote, so every existing
 *  digest still verifies. */
export async function hashPassword(pw) {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(String(pw), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time comparison of a plaintext password against a stored digest. */
/* One precomputed hash so a login for a nonexistent user costs the same scrypt
   as a wrong password does. Started once at boot and awaited thereafter, so it
   is a resolved promise long before the first login and the equalisation still
   costs exactly one scrypt — never two, never zero. */
const DECOY_HASH = hashPassword('decoy-not-a-real-password');

export async function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || typeof pw !== 'string') return false;
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;

  const saltHex = stored.slice(0, sep);
  const hashHex = stored.slice(sep + 1);
  if (!saltHex || !hashHex) return false;

  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await scryptAsync(pw, salt, expected.length, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
  } catch {
    return false;
  }

  // Lengths always match here, but timingSafeEqual throws if they ever differ.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Pull a session token out of the request (Bearer header, x-auth-token, or body). */
function tokenFrom(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const header = req.headers?.['x-auth-token'];
  if (typeof header === 'string' && header) return header;
  const body = req.body;
  if (body && typeof body.token === 'string' && body.token) return body.token;
  return null;
}

/** Express middleware: sets req.userId, or answers 401. */
export function requireAuth(req, res, next) {
  const token = tokenFrom(req);
  const userId = token ? sessions.verify(token) : null;
  if (!userId) {
    return res.status(401).json({ error: 'not authenticated', code: 'UNAUTHENTICATED' });
  }
  req.userId = userId;
  req.token = token;
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP): 10 register/login attempts per 10 minutes.
// Good enough for a single-process VPS deployment. Register and login share one
// budget on purpose — an attacker who can spend ten guesses per window must not
// get twenty by alternating doors.
// ---------------------------------------------------------------------------

const rateLimit = ipRateLimit({ max: 10, windowMs: 10 * 60 * 1000 });

function publicUser(row) {
  return { id: row.id, username: row.username, created_at: row.created_at };
}

/* express 4 does not notice a rejected promise from a handler, so an async one
   that throws would hang the request and surface as an unhandledRejection three
   files away. Every async route below is wrapped instead. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The front door half of the ban. Deliberately AFTER the password check: asking
 * first would turn this route into an oracle that tells anyone which accounts
 * are suspended, whereas behind it only the account's real owner ever learns.
 * The shape matches index.js's ACCOUNT_SUSPENDED answer so one client branch
 * handles a ban wherever it is met.
 */
function suspended(res, userId) {
  let ban = null;
  // isBanned() is fail-open by design (see admin.js) and this try says the same
  // thing again: a broken sanctions table must never lock everyone out.
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

export function mountAuth(app) {
  // Parse JSON locally so auth works regardless of the app's global middleware.
  // express.json() sets req._body, so a second parse upstream is a no-op.
  const json = express.json({ limit: '64kb' });

  // rateLimit runs before json so malformed bodies still consume an attempt.
  app.post('/api/auth/register', rateLimit, json, wrap(async (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'username must be 3-20 characters: letters, numbers, or underscore',
        code: 'BAD_USERNAME',
      });
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return res.status(400).json({
        error: `password must be at least ${MIN_PASSWORD} characters`,
        code: 'BAD_PASSWORD',
      });
    }
    if (users.findByName(username)) {
      return res.status(409).json({ error: 'username already taken', code: 'USERNAME_TAKEN' });
    }

    // Hashed before the insert, and awaited before anything touches SQLite, so
    // the synchronous better-sqlite3 calls below still run as one unit.
    const passHash = await hashPassword(password);

    let id;
    try {
      id = users.create(username, passHash);
    } catch (err) {
      // Lost a race against a concurrent registration of the same name.
      if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'username already taken', code: 'USERNAME_TAKEN' });
      }
      throw err;
    }

    const token = sessions.create(id);
    const user = users.findById(id);
    res.status(201).json({ token, user: publicUser(user) });
  }));

  app.post('/api/auth/login', rateLimit, json, wrap(async (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const row = username ? users.findByName(username) : null;
    // Same message AND the same work for both failure modes: an unknown user
    // still pays one scrypt against a decoy hash, so response time cannot be
    // used to enumerate which usernames exist.
    const okPass = row
      ? await verifyPassword(password, row.pass_hash)
      : (await verifyPassword(password, await DECOY_HASH), false);
    if (!okPass) {
      return res.status(401).json({ error: 'invalid username or password', code: 'BAD_CREDENTIALS' });
    }

    if (suspended(res, row.id)) return;

    const token = sessions.create(row.id);
    res.json({ token, user: publicUser(row) });
  }));

  app.post('/api/auth/logout', json, (req, res) => {
    const token = tokenFrom(req);
    if (token) sessions.destroy(token);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const row = users.findById(req.userId);
    if (!row) return res.status(401).json({ error: 'not authenticated', code: 'UNAUTHENTICATED' });
    // This route IS session resume: the client calls it on every boot with a
    // stored token. A ban revokes the sessions row, so the usual answer is the
    // 401 above — but a token minted in the instant before the ban landed would
    // sail through, and this is where that window closes.
    if (suspended(res, req.userId)) return;
    res.json({ user: publicUser(row) });
  });
}
