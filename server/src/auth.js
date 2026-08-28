// Account + session handling.
//
// Tokens are returned in the JSON body (not as cookies) so the browser client
// can keep one in localStorage and send it back as `Authorization: Bearer ...`.
// That also keeps the API usable cross-origin without cookie/CORS credential
// gymnastics.

import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { users, sessions } from './db.js';

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

/** Derive a "salt:hash" hex string for a plaintext password. */
export function hashPassword(pw) {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(String(pw), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time comparison of a plaintext password against a stored digest. */
/* One precomputed hash so a login for a nonexistent user costs the same scrypt
   as a wrong password does. Computed once at boot, never compared for real. */
const DECOY_HASH = hashPassword('decoy-not-a-real-password');

export function verifyPassword(pw, stored) {
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
    actual = scryptSync(pw, salt, expected.length, {
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
// Good enough for a single-process VPS deployment.
// ---------------------------------------------------------------------------

const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 10;
const attempts = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneAttempts(now) {
  for (const [ip, rec] of attempts) {
    if (rec.resetAt <= now) attempts.delete(ip);
  }
}

function rateLimit(req, res, next) {
  const now = Date.now();
  // Cheap opportunistic cleanup so the map cannot grow without bound.
  if (attempts.size > 5000) pruneAttempts(now);

  const ip = clientIp(req);
  let rec = attempts.get(ip);
  if (!rec || rec.resetAt <= now) {
    rec = { count: 0, resetAt: now + RL_WINDOW_MS };
    attempts.set(ip, rec);
  }
  rec.count += 1;

  if (rec.count > RL_MAX) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'too many attempts, try again later', code: 'RATE_LIMIT' });
  }
  next();
}

function publicUser(row) {
  return { id: row.id, username: row.username, created_at: row.created_at };
}

export function mountAuth(app) {
  // Parse JSON locally so auth works regardless of the app's global middleware.
  // express.json() sets req._body, so a second parse upstream is a no-op.
  const json = express.json({ limit: '64kb' });

  // rateLimit runs before json so malformed bodies still consume an attempt.
  app.post('/api/auth/register', rateLimit, json, (req, res) => {
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

    let id;
    try {
      id = users.create(username, hashPassword(password));
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
  });

  app.post('/api/auth/login', rateLimit, json, (req, res) => {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const row = username ? users.findByName(username) : null;
    // Same message AND the same work for both failure modes: an unknown user
    // still pays one scrypt against a decoy hash, so response time cannot be
    // used to enumerate which usernames exist.
    const okPass = row
      ? verifyPassword(password, row.pass_hash)
      : (verifyPassword(password, DECOY_HASH), false);
    if (!okPass) {
      return res.status(401).json({ error: 'invalid username or password', code: 'BAD_CREDENTIALS' });
    }

    const token = sessions.create(row.id);
    res.json({ token, user: publicUser(row) });
  });

  app.post('/api/auth/logout', json, (req, res) => {
    const token = tokenFrom(req);
    if (token) sessions.destroy(token);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const row = users.findById(req.userId);
    if (!row) return res.status(401).json({ error: 'not authenticated', code: 'UNAUTHENTICATED' });
    res.json({ user: publicUser(row) });
  });
}
