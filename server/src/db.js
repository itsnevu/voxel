// SQLite persistence layer for Reel Fortune 3D.
// Everything the server treats as truth lives here: accounts, saved game state,
// sessions, an action log used for server-side rate limiting, and minted deeds.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(HERE, '..', 'data', 'reelfortune.db');

// DB_PATH lets the VPS point at a volume; otherwise keep the file next to the
// server package so the location never depends on the current working dir.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : DEFAULT_DB;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// WAL keeps readers from blocking the single writer; the busy timeout stops
// spurious SQLITE_BUSY throws when several requests land at once.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACTION_LOG_TTL_MS = 60 * 60 * 1000; // 1 hour

// Statements are prepared lazily and memoised: the tables do not exist until
// initSchema() runs, so preparing at module load would throw.
const stmtCache = new Map();
function q(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE COLLATE NOCASE,
      pass_hash  TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS saves (
      user_id    INTEGER PRIMARY KEY,
      state      TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER,
      created_at INTEGER,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS action_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action  TEXT,
      at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_action_log_user_action_at
      ON action_log (user_id, action, at);

    CREATE TABLE IF NOT EXISTS deeds (
      user_id    INTEGER,
      deed_id    TEXT,
      block_no   INTEGER,
      hash       TEXT,
      minted_at  INTEGER,
      claim_addr TEXT,
      claim_sig  TEXT,
      PRIMARY KEY (user_id, deed_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
  `);
}

export const users = {
  /** Insert a new account. Throws on duplicate username (UNIQUE COLLATE NOCASE). */
  create(username, passHash) {
    const info = q(
      'INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'
    ).run(String(username), String(passHash), Date.now());
    return info.lastInsertRowid;
  },

  findByName(name) {
    return q('SELECT * FROM users WHERE username = ?').get(String(name)) || null;
  },

  findById(id) {
    return q('SELECT * FROM users WHERE id = ?').get(id) || null;
  },
};

export const saves = {
  /** Returns the parsed state object, or null when absent/corrupt. */
  get(userId) {
    const row = q('SELECT state FROM saves WHERE user_id = ?').get(userId);
    if (!row || !row.state) return null;
    try {
      const parsed = JSON.parse(row.state);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null; // treat an unreadable save as "no save" rather than 500ing
    }
  },

  put(userId, stateObj) {
    q(`INSERT INTO saves (user_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state,
                                          updated_at = excluded.updated_at`)
      .run(userId, JSON.stringify(stateObj), Date.now());
  },
};

export const sessions = {
  create(userId) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    q('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, now, now + SESSION_TTL_MS);
    return token;
  },

  /** Returns the owning user id, or null when the token is unknown or expired. */
  verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const row = q('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      q('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return row.user_id;
  },

  destroy(token) {
    if (typeof token !== 'string' || !token) return;
    q('DELETE FROM sessions WHERE token = ?').run(token);
  },

  /** Drop expired sessions and stale rate-limit history. Call on an interval. */
  sweep() {
    const now = Date.now();
    q('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    q('DELETE FROM action_log WHERE at < ?').run(now - ACTION_LOG_TTL_MS);
  },
};

export const actions = {
  /** Epoch ms of the most recent occurrence, or 0 if never. */
  last(userId, action) {
    const row = q('SELECT MAX(at) AS at FROM action_log WHERE user_id = ? AND action = ?')
      .get(userId, String(action));
    return row && row.at ? row.at : 0;
  },

  mark(userId, action) {
    q('INSERT INTO action_log (user_id, action, at) VALUES (?, ?, ?)')
      .run(userId, String(action), Date.now());
  },

  countSince(userId, action, sinceMs) {
    const row = q('SELECT COUNT(*) AS n FROM action_log WHERE user_id = ? AND action = ? AND at >= ?')
      .get(userId, String(action), sinceMs);
    return row ? row.n : 0;
  },
};

export const deedsRepo = {
  /** Idempotent: re-minting an existing deed leaves the original record intact. */
  add(userId, deedId, blockNo, hash) {
    q(`INSERT OR IGNORE INTO deeds
         (user_id, deed_id, block_no, hash, minted_at, claim_addr, claim_sig)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`)
      .run(userId, String(deedId), blockNo | 0, String(hash), Date.now());
  },

  list(userId) {
    return q('SELECT * FROM deeds WHERE user_id = ? ORDER BY minted_at ASC, deed_id ASC')
      .all(userId);
  },

  has(userId, deedId) {
    const row = q('SELECT 1 AS x FROM deeds WHERE user_id = ? AND deed_id = ?')
      .get(userId, String(deedId));
    return !!row;
  },

  setClaim(userId, deedId, addr, sig) {
    q('UPDATE deeds SET claim_addr = ?, claim_sig = ? WHERE user_id = ? AND deed_id = ?')
      .run(addr == null ? null : String(addr), sig == null ? null : String(sig),
           userId, String(deedId));
  },
};
