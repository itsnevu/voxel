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

    -- CREW: who is riding on whose boat.
    -- member_id is the PRIMARY KEY, so a player can be aboard exactly one boat
    -- at a time — the "leave before you board another" rule is the schema.
    CREATE TABLE IF NOT EXISTS crew_members (
      member_id INTEGER PRIMARY KEY,
      owner_id  INTEGER NOT NULL,
      joined_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_crew_members_owner ON crew_members (owner_id);

    -- Boarding requests awaiting the captain's ADMIT/DENY. A player may knock on
    -- several hulls at once; admitting one clears the rest.
    CREATE TABLE IF NOT EXISTS crew_requests (
      owner_id INTEGER NOT NULL,
      user_id  INTEGER NOT NULL,
      at       INTEGER,
      PRIMARY KEY (owner_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_crew_requests_user ON crew_requests (user_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

    -- Player-filed reports (abuse, bugs, scam attempts). target is free text so
    -- it can name a user, a chat line, or anything else the client sends.
    CREATE TABLE IF NOT EXISTS reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER,
      target      TEXT,
      reason      TEXT,
      detail      TEXT,
      at          INTEGER
    );
  `);

  // --- Idempotent migrations for columns added after the original schema ---
  // ALTER TABLE ADD COLUMN throws when the column already exists; that error is
  // the "already migrated" signal, so it is deliberately swallowed.
  try {
    db.exec('ALTER TABLE users ADD COLUMN wallet TEXT');
  } catch {
    /* column already present */
  }

  // Partial unique index: at most one account per wallet address, while every
  // password-only account keeps wallet = NULL without colliding.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet
             ON users (wallet) WHERE wallet IS NOT NULL`);
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

export const wallets = {
  /** Account bound to a (lowercased) wallet address, or null. */
  findUser(addrLower) {
    return q('SELECT * FROM users WHERE wallet = ?').get(String(addrLower)) || null;
  },

  /** Bind a wallet address to an account. Throws if the address is taken. */
  attach(userId, addrLower) {
    q('UPDATE users SET wallet = ? WHERE id = ?').run(String(addrLower), userId);
  },
};

export const reports = {
  add(reporterId, target, reason, detail) {
    q('INSERT INTO reports (reporter_id, target, reason, detail, at) VALUES (?, ?, ?, ?, ?)')
      .run(reporterId, String(target), String(reason), String(detail), Date.now());
  },

  /** Newest first, capped so an admin fetch can never drag the whole table. */
  list(limit = 100) {
    return q('SELECT * FROM reports ORDER BY at DESC, id DESC LIMIT ?').all(limit | 0);
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

  /** Just the boat level out of a save — cheap enough to call per crew row. */
  boatLvl(userId) {
    const row = q(`SELECT CAST(COALESCE(json_extract(state, '$.boatLvl'), 0) AS INTEGER) AS lvl
                   FROM saves WHERE user_id = ?`).get(userId);
    return row ? row.lvl | 0 : 0;
  },

  /**
   * Captains who own a hull that can actually carry someone (boatLvl >= 1),
   * newest activity first, with their current crew count folded in.
   */
  captains(limit, minLvl = 1) {
    return q(`SELECT u.id            AS userId,
                     u.username      AS username,
                     CAST(COALESCE(json_extract(s.state, '$.boatLvl'), 0) AS INTEGER) AS boatLvl,
                     COALESCE(json_extract(s.state, '$.titleId'), '')                 AS title,
                     (SELECT COUNT(*) FROM crew_members m WHERE m.owner_id = u.id)    AS aboard,
                     s.updated_at    AS seenAt
              FROM saves s JOIN users u ON u.id = s.user_id
              WHERE boatLvl >= ?
              ORDER BY s.updated_at DESC
              LIMIT ?`).all(minLvl | 0, limit | 0);
  },
};

/* ============================================================================
   CREW — boarding requests and the crew manifests they turn into.
   Capacity is a game rule, not a schema one, so every seat check is passed in
   by the caller and enforced inside a transaction (see admit()).
   ========================================================================== */
export const crews = {
  /** Everyone riding on `ownerId`'s boat, in boarding order. */
  manifest(ownerId) {
    return q(`SELECT m.member_id AS userId, u.username AS username, m.joined_at AS joinedAt
              FROM crew_members m JOIN users u ON u.id = m.member_id
              WHERE m.owner_id = ? ORDER BY m.joined_at ASC`).all(ownerId);
  },

  count(ownerId) {
    const row = q('SELECT COUNT(*) AS n FROM crew_members WHERE owner_id = ?').get(ownerId);
    return row ? row.n : 0;
  },

  /** The boat `userId` is currently aboard, or null when they sail alone. */
  berthOf(userId) {
    return q(`SELECT m.owner_id AS ownerId, u.username AS captain, m.joined_at AS joinedAt
              FROM crew_members m JOIN users u ON u.id = m.owner_id
              WHERE m.member_id = ?`).get(userId) || null;
  },

  /** Requests waiting on `ownerId`'s decision, oldest first. */
  requestsFor(ownerId) {
    return q(`SELECT r.user_id AS userId, u.username AS username, r.at AS at,
                     CAST(COALESCE(json_extract(s.state, '$.boatLvl'), 0) AS INTEGER) AS boatLvl
              FROM crew_requests r
              JOIN users u ON u.id = r.user_id
              LEFT JOIN saves s ON s.user_id = r.user_id
              WHERE r.owner_id = ? ORDER BY r.at ASC`).all(ownerId);
  },

  /** Requests `userId` has knocked with, still unanswered. */
  requestsBy(userId) {
    return q(`SELECT r.owner_id AS ownerId, u.username AS captain, r.at AS at
              FROM crew_requests r JOIN users u ON u.id = r.owner_id
              WHERE r.user_id = ? ORDER BY r.at ASC`).all(userId);
  },

  hasRequest(ownerId, userId) {
    return !!q('SELECT 1 AS x FROM crew_requests WHERE owner_id = ? AND user_id = ?')
      .get(ownerId, userId);
  },

  addRequest(ownerId, userId) {
    q('INSERT OR REPLACE INTO crew_requests (owner_id, user_id, at) VALUES (?, ?, ?)')
      .run(ownerId, userId, Date.now());
  },

  dropRequest(ownerId, userId) {
    return q('DELETE FROM crew_requests WHERE owner_id = ? AND user_id = ?')
      .run(ownerId, userId).changes;
  },

  removeMember(ownerId, memberId) {
    return q('DELETE FROM crew_members WHERE owner_id = ? AND member_id = ?')
      .run(ownerId, memberId).changes;
  },

  /** Step ashore from whatever boat you are on. */
  leave(memberId) {
    return q('DELETE FROM crew_members WHERE member_id = ?').run(memberId).changes;
  },

  /**
   * Seat a pending requester. Every precondition is re-checked here because the
   * captain's click races with the requester boarding elsewhere.
   * Returns 'ok' | 'no-request' | 'full' | 'aboard' | 'captain'.
   */
  admit: db.transaction((ownerId, memberId, seats) => {
    if (!q('SELECT 1 AS x FROM crew_requests WHERE owner_id = ? AND user_id = ?')
          .get(ownerId, memberId)) return 'no-request';
    if (q('SELECT 1 AS x FROM crew_members WHERE member_id = ?').get(memberId)) return 'aboard';
    if (q('SELECT 1 AS x FROM crew_members WHERE owner_id = ?').get(memberId)) return 'captain';

    const n = q('SELECT COUNT(*) AS n FROM crew_members WHERE owner_id = ?').get(ownerId).n;
    if (n + 1 > Math.max(0, (seats | 0) - 1)) return 'full';

    q('INSERT INTO crew_members (member_id, owner_id, joined_at) VALUES (?, ?, ?)')
      .run(memberId, ownerId, Date.now());
    // A seated sailor is done knocking on every other hull.
    q('DELETE FROM crew_requests WHERE user_id = ?').run(memberId);
    return 'ok';
  }),

  /** Send the whole crew ashore (used when a captain boards someone else). */
  disband(ownerId) {
    return q('DELETE FROM crew_members WHERE owner_id = ?').run(ownerId).changes;
  },

  /** Drop rows pointing at accounts that no longer exist, plus stale knocks. */
  sweep(requestTtlMs) {
    q(`DELETE FROM crew_requests WHERE at < ?`).run(Date.now() - requestTtlMs);
    q(`DELETE FROM crew_members WHERE member_id NOT IN (SELECT id FROM users)
                                   OR owner_id  NOT IN (SELECT id FROM users)`).run();
    q(`DELETE FROM crew_requests WHERE user_id NOT IN (SELECT id FROM users)
                                    OR owner_id NOT IN (SELECT id FROM users)`).run();
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
