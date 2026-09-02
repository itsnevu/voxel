// SQLite persistence layer for Reel Fortune 3D.
// Everything the server treats as truth lives here: accounts, saved game state,
// sessions, an action log used for server-side rate limiting, and minted deeds.
//
// Production concerns handled in this module:
//   - versioned, transactional migrations (schema_meta.version)
//   - a tuned pragma set applied to every connection
//   - a boot-time integrity check that refuses to serve a corrupt file
//   - checkpoint / incremental-vacuum / stats helpers for the ops endpoints
//   - a hard cap on concurrent sessions per account

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

/* ============================================================================
   LOGGING — optional, and deliberately loaded the awkward way.

   log.js may not exist in this build, and if it does it is free to import
   db.js. A static import would therefore be both a hard dependency and a
   potential evaluation cycle; a top-level `await import()` would turn that
   cycle into a deadlock (two modules each waiting on the other's evaluation
   promise). So: fire the dynamic import and never await it. Until it lands —
   and forever, if the file is absent — the built-in fallback below carries the
   message, in log.js's own format, so no line is dropped and nothing downstream
   can tell which of the two wrote it.
   ========================================================================== */
// Call shape matches log.js: a short constant message plus a fields object,
// never string concatenation, so the lines stay greppable and machine-readable.
//
// The fallback mirrors log.js's own format decision (JSON unless LOG_PRETTY),
// because the migration lines below are emitted at boot, before the dynamic
// import can possibly have resolved. Without this they would be the one part
// of the startup log a collector could not parse.
const PRETTY_FALLBACK = /^(1|true|yes|on)$/i.test(String(process.env.LOG_PRETTY || ''));
function fallbackEmit(level, msg, fields) {
  const stream = level === 'error' ? process.stderr : process.stdout;
  let line;
  if (PRETTY_FALLBACK) {
    line = `[db] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`;
  } else {
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(), level, msg, mod: 'db', ...(fields || {}),
      });
    } catch {
      line = `{"level":"${level}","msg":${JSON.stringify(String(msg))},"mod":"db"}`;
    }
  }
  try {
    stream.write(`${line}\n`);
  } catch {
    /* a closed or full stdout must never throw into a migration */
  }
}
let log = {
  info: (m, f) => fallbackEmit('info', m, f),
  warn: (m, f) => fallbackEmit('warn', m, f),
  error: (m, f) => fallbackEmit('error', m, f),
};

// Only attempt the import when the file is actually there, so a genuine
// failure (syntax error, bad export) surfaces instead of being mistaken for
// "this build has no logger".
if (fs.existsSync(path.join(HERE, 'log.js'))) {
  import('./log.js')
    .then((mod) => {
      const base = (mod && (mod.log || mod.logger || mod.default)) || null;
      if (!base || typeof base.info !== 'function') return;
      // child() stamps { mod: 'db' } onto every line; without it, fall back to
      // the plain logger and keep the tag in the message.
      const s = typeof mod.child === 'function' ? mod.child({ mod: 'db' }) : null;
      const via = (lvl) => {
        const fn = (s && s[lvl]) || base[lvl] || base.info;
        return s ? (m, f) => fn(m, f) : (m, f) => fn(`[db] ${m}`, f);
      };
      log = { info: via('info'), warn: via('warn'), error: via('error') };
    })
    .catch((e) => console.warn('[db] log.js present but failed to load:', e && e.message));
}

/* ------------------------------------------------------------------ knobs -- */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACTION_LOG_TTL_MS = 60 * 60 * 1000; // 1 hour

const intEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

// How many live sessions one account may hold. Ten covers phone + desktop +
// a few stale tabs; past that the oldest token is evicted so a leaked or
// looping client cannot grow the table without bound.
const MAX_SESSIONS_PER_USER = intEnv('MAX_SESSIONS_PER_USER', 10);

// Reclaim pages once the freelist passes this share of the file, so routine
// calls to vacuumIfNeeded() are almost always a cheap no-op.
const VACUUM_FREELIST_RATIO = 0.15;
const VACUUM_MIN_PAGES = 512;

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

/* ============================================================================
   PRAGMAS — applied at module load so any consumer that touches the handle
   before initSchema() still gets a correctly configured connection, and again
   at the top of initSchema(). Every one of them is idempotent.
   ========================================================================== */
function applyPragmas() {
  // auto_vacuum has to be set before the first table exists to take on a fresh
  // file; on an established database it is inert until a full VACUUM runs.
  // Setting it first is what later makes incremental_vacuum meaningful.
  try { db.pragma('auto_vacuum = INCREMENTAL'); } catch { /* non-fatal */ }

  // WAL keeps readers from blocking the single writer; the busy timeout stops
  // spurious SQLITE_BUSY throws when several requests land at once.
  const mode = String(db.pragma('journal_mode = WAL', { simple: true }) || '').toLowerCase();
  if (mode !== 'wal') {
    // Network filesystems refuse WAL. Worth shouting about: the concurrency
    // assumptions the rest of the server makes no longer hold.
    log.warn('journal_mode is not WAL (is the file on a network mount?)',
      { mode, path: DB_PATH });
  }

  db.pragma('synchronous = NORMAL');   // safe under WAL; fsync only at checkpoints
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -16000');    // negative = KiB, so 16 MB of page cache
  db.pragma('temp_store = MEMORY');    // sorts and temp tables stay off disk

  // Memory-mapped reads. 128 MB by default: generous for this workload, small
  // enough to sit comfortably on a 1 GB VPS alongside Node's heap.
  try { db.pragma(`mmap_size = ${intEnv('DB_MMAP_MB', 128) * 1024 * 1024}`); } catch { /* optional */ }

  // Bound how much work `PRAGMA optimize` is allowed to do later on.
  try { db.pragma('analysis_limit = 400'); } catch { /* older SQLite */ }
}

applyPragmas();

/* ============================================================================
   INTEGRITY — a corrupt page file must stop the boot, loudly. Serving from a
   damaged database quietly writes bad data on top of bad data.
   ========================================================================== */
function integrityCheck() {
  if (process.env.DB_SKIP_INTEGRITY_CHECK === '1') {
    log.warn('integrity check skipped (DB_SKIP_INTEGRITY_CHECK=1)');
    return;
  }

  let rows;
  try {
    rows = db.pragma('quick_check');
  } catch (e) {
    throw new Error(
      `Database integrity check could not run on ${DB_PATH}: ${e && e.message}. ` +
      'The file may be unreadable, truncated, or not a SQLite database.'
    );
  }

  const problems = (Array.isArray(rows) ? rows : [])
    .map((r) => String((r && r.quick_check) ?? r ?? ''))
    .filter((v) => v && v.toLowerCase() !== 'ok');

  if (problems.length) {
    throw new Error(
      `Database integrity check FAILED for ${DB_PATH}:\n  ` +
      problems.slice(0, 10).join('\n  ') +
      (problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : '') +
      '\nRefusing to start. Restore the newest good backup, or recover with:\n' +
      `  sqlite3 "${DB_PATH}" ".recover" | sqlite3 recovered.db\n` +
      'Set DB_SKIP_INTEGRITY_CHECK=1 only to inspect a known-bad file.'
    );
  }
}

/* ============================================================================
   MIGRATIONS — an ordered list, each step run once inside its own transaction
   and stamped into schema_meta. Anything already applied is skipped.

   v1 is the schema as it stood before versioning existed, written to be fully
   idempotent (IF NOT EXISTS / column probes) so a database created by the old
   code adopts version 1 without a single row changing.

   KNOWN LIMIT: every step runs inside db.transaction(), and SQLite ignores
   `PRAGMA foreign_keys` (set ON at line ~150) while a transaction is open. The
   12-step table-rebuild recipe — the only way to drop a column or change a
   constraint — needs foreign_keys OFF *outside* a transaction, so it cannot be
   expressed here. Nothing declares REFERENCES today, so this is latent; the
   step that first needs a rebuild has to run its own connection-level dance
   rather than being bolted onto this runner.
   ========================================================================== */

/**
 * True when `table` already has a column named `col`.
 *
 * Deliberately uncaught. `table_info` on a table that does not exist returns an
 * empty list rather than raising, so a throw from here is never "no such table"
 * — it is a real failure, and answering `false` to it would have a migration
 * ALTER a table it knows nothing about. Letting it propagate rolls the step's
 * transaction back and leaves the version unstamped, so the next boot retries.
 */
function hasColumn(table, col) {
  return db.pragma(`table_info(${table})`).some((c) => c.name === col);
}

const MIGRATIONS = [
  {
    v: 1,
    name: 'baseline',
    up(database) {
      database.exec(`
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

      // Wallet support was bolted on after launch. Probe first — ALTER TABLE
      // ADD COLUMN raises on a duplicate, and inside a migration transaction
      // it is cleaner to ask than to catch.
      if (!hasColumn('users', 'wallet')) {
        try {
          database.exec('ALTER TABLE users ADD COLUMN wallet TEXT');
        } catch {
          /* raced or already present */
        }
      }

      // Partial unique index: at most one account per wallet address, while every
      // password-only account keeps wallet = NULL without colliding.
      database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet
                       ON users (wallet) WHERE wallet IS NOT NULL`);
    },
  },

  {
    v: 2,
    name: 'production-indexes',
    up(database) {
      database.exec(`
        -- sessions.user_id had no index at all: the per-user session cap and
        -- destroyAllForUser() both scan on it, as does every logout-everywhere.
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

        -- sessions.sweep() deletes the whole tail of action_log by timestamp;
        -- the (user_id, action, at) index cannot serve a bare range on "at".
        CREATE INDEX IF NOT EXISTS idx_action_log_at ON action_log (at);

        -- reports.list() is ORDER BY at DESC, id DESC LIMIT ?; matching the
        -- index to the sort turns the admin fetch into a bounded seek.
        CREATE INDEX IF NOT EXISTS idx_reports_at ON reports (at DESC, id DESC);

        -- saves.captains() sorts the leaderboard by recency.
        CREATE INDEX IF NOT EXISTS idx_saves_updated ON saves (updated_at DESC);
      `);

      // Deliberately NOT created, because they would be pure write amplification:
      //   saves(user_id) — user_id IS the rowid (INTEGER PRIMARY KEY), so lookups
      //                    are already direct rowid seeks.
      //   deeds(user_id) — covered as the leftmost prefix of the automatic index
      //                    behind PRIMARY KEY (user_id, deed_id).
      // Both access paths were confirmed against the queries in this file.
    },
  },
  {
    v: 3,
    name: 'chosen-usernames',
    up(database) {
      // A wallet account used to be born with a machine name ("w_1a2b3c"). Now
      // the address only proves ownership and the player names the angler
      // themselves, so we need to know which names were actually CHOSEN.
      if (!hasColumn('users', 'name_chosen')) {
        database.exec('ALTER TABLE users ADD COLUMN name_chosen INTEGER NOT NULL DEFAULT 0');
      }

      // Everyone who registered with a password typed their own name at the
      // door, so those are chosen by definition. The machine-named wallet and
      // guest accounts stay at 0 and get asked once, on their next sign-in.
      database.exec(`UPDATE users SET name_chosen = 1
                       WHERE wallet IS NULL
                         AND username NOT LIKE 'guest\\_%' ESCAPE '\\'`);
    },
  },
  {
    v: 4,
    name: 'derby-history',
    up(database) {
      // The derby used to live only in memory, so a deploy in the first ten
      // minutes of an hour silently voided the race everybody was fishing.
      // `derby_scores` is the running tally — rebuilt into memory on boot and
      // cleared once its derby settles. `derby_results` is the permanent
      // record: one champion per world per hour, and the only table the
      // history endpoint reads.
      database.exec(`
        CREATE TABLE IF NOT EXISTS derby_scores (
          derby_id INTEGER NOT NULL,
          world    TEXT    NOT NULL,
          user_id  INTEGER NOT NULL,
          username TEXT    NOT NULL DEFAULT '',
          kg       REAL    NOT NULL DEFAULT 0,
          PRIMARY KEY (derby_id, world, user_id)
        );

        CREATE TABLE IF NOT EXISTS derby_results (
          derby_id  INTEGER NOT NULL,
          world     TEXT    NOT NULL,
          user_id   INTEGER NOT NULL,
          username  TEXT    NOT NULL DEFAULT '',
          kg        REAL    NOT NULL DEFAULT 0,
          pearls    INTEGER NOT NULL DEFAULT 0,
          settled_at INTEGER NOT NULL,
          PRIMARY KEY (derby_id, world)
        );

        CREATE INDEX IF NOT EXISTS idx_derby_results_at
          ON derby_results (settled_at DESC);
        CREATE INDEX IF NOT EXISTS idx_derby_results_user
          ON derby_results (user_id, settled_at DESC);
      `);
    },
  },
];

/**
 * Version 0 means one thing only: nothing has ever been stamped. Every other
 * outcome — including "the read failed" — must stop the boot, because the
 * runner turns 0 into "replay from v1" and a replay over a populated database
 * is how a transient error becomes data loss.
 *
 * SQLite does not give a missing table its own error code. better-sqlite3
 * raises SqliteError { code: 'SQLITE_ERROR', message: 'no such table:
 * schema_meta' } — the same code a corrupt page, a stale busy_timeout, or a
 * typo'd column carries, so matching on it would be matching on nothing.
 * Ask sqlite_master instead: it exists in every SQLite file, so a throw from
 * THAT query can never mean "fresh database".
 */
function schemaMetaExists() {
  return !!db.prepare(
    `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`
  ).get();
}

function unreadableVersion(detail) {
  return new Error(
    `Database schema version could not be read from ${DB_PATH}: ${detail}. ` +
    'schema_meta is present but unreadable, so this build cannot tell which ' +
    'migrations have already run.\nRefusing to start: treating that as a fresh ' +
    'database would replay every migration over live player data.\n' +
    'Retry once — a SQLITE_BUSY can outlive the 5s busy_timeout under load. If it ' +
    'persists, inspect the file:\n' +
    `  sqlite3 "${DB_PATH}" "PRAGMA integrity_check; SELECT * FROM schema_meta;"\n` +
    'and restore the newest good backup if that does not come back clean.'
  );
}

function readVersion() {
  let present;
  try {
    present = schemaMetaExists();
  } catch (e) {
    throw unreadableVersion(`the schema catalogue itself is unreadable (${e && e.message})`);
  }
  if (!present) return 0; // genuinely fresh file — the only honest 0

  let row;
  try {
    row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version');
  } catch (e) {
    throw unreadableVersion(e && e.message);
  }
  // The table exists but nothing is stamped yet: runMigrations() creates it
  // before the first step runs, so this is a fresh file one line further on.
  if (!row) return 0;

  const n = Number(row.value);
  if (!Number.isFinite(n) || n < 0) {
    throw unreadableVersion(`schema_meta.version is ${JSON.stringify(row.value)}, not a version number`);
  }
  return Math.floor(n);
}

function writeVersion(v) {
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v));
}

function runMigrations() {
  // The bookkeeping table has to exist before it can record anything, so it
  // lives outside the migration list.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
             key   TEXT PRIMARY KEY,
             value TEXT
           )`);

  const from = readVersion();
  const target = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].v : 0;

  if (from > target) {
    // Someone rolled the code back under a newer database. Newer schemas are
    // additive here, so this is a warning rather than a stop, but it should
    // never pass unnoticed.
    log.warn('schema is newer than this build understands', { found: from, supported: target });
    return;
  }
  if (from === target) {
    log.info('schema up to date', { version: from });
    return;
  }

  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    const t0 = Date.now();
    // Each migration is all-or-nothing: a throw rolls the whole step back and
    // leaves the recorded version untouched, so the next boot retries it.
    db.transaction(() => {
      m.up(db);
      writeVersion(m.v);
    })();
    log.info('migration applied', { v: m.v, name: m.name, ms: Date.now() - t0 });
  }

  log.info('schema migrated', { from, to: readVersion() });
}

export function initSchema() {
  applyPragmas();
  integrityCheck();
  runMigrations();

  // Refresh the query planner's statistics once the schema is settled.
  try { db.pragma('optimize'); } catch { /* advisory only */ }
}

/* ============================================================================
   MAINTENANCE — safe to call on a timer and again during shutdown.
   ========================================================================== */

/**
 * Fold the WAL back into the main file and truncate it. Without this a busy
 * server's -wal file grows until the next natural checkpoint, which under
 * continuous read traffic may be a very long time.
 * Returns {busy, log, checkpointed} or null when the handle is closed.
 */
export function checkpoint() {
  if (!db.open) return null;
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)');
    const r = (Array.isArray(rows) ? rows[0] : rows) || {};
    // busy = 1 means a reader held the WAL open; harmless, the next call gets it.
    return {
      busy: r.busy | 0,
      log: r.log | 0,
      checkpointed: r.checkpointed | 0,
    };
  } catch (e) {
    log.error('checkpoint failed', { err: e && e.message });
    return null;
  }
}

/**
 * Hand free pages back to the filesystem when enough have accumulated.
 * Cheap and a no-op in the common case, so it is safe on a schedule.
 * Returns {reclaimed, freelist, pages} — reclaimed is 0 when nothing ran.
 */
export function vacuumIfNeeded() {
  const result = { reclaimed: 0, freelist: 0, pages: 0 };
  if (!db.open) return result;

  try {
    const freelist = db.pragma('freelist_count', { simple: true }) | 0;
    const pages = db.pragma('page_count', { simple: true }) | 0;
    result.freelist = freelist;
    result.pages = pages;

    if (freelist < VACUUM_MIN_PAGES) return result;
    if (pages > 0 && freelist / pages < VACUUM_FREELIST_RATIO) return result;

    // incremental_vacuum only does work when auto_vacuum is INCREMENTAL (2).
    // On a database created before that pragma was set it reports NONE, and
    // switching it over needs a full VACUUM — a blocking rewrite that is an
    // operator's decision, not something to spring on a live server.
    const mode = db.pragma('auto_vacuum', { simple: true }) | 0;
    if (mode !== 2) {
      log.warn(
        'free pages cannot be reclaimed: auto_vacuum is not INCREMENTAL. ' +
        'Run a full VACUUM in a maintenance window to enable it.',
        { freelist, pages, autoVacuum: mode }
      );
      return result;
    }

    db.pragma(`incremental_vacuum(${freelist})`);
    const after = db.pragma('freelist_count', { simple: true }) | 0;
    result.reclaimed = Math.max(0, freelist - after);
    result.freelist = after;
    if (result.reclaimed > 0) log.info('incremental vacuum', { reclaimedPages: result.reclaimed });
    return result;
  } catch (e) {
    log.error('vacuumIfNeeded failed', { err: e && e.message });
    return result;
  }
}

/** Byte size of a path, or 0 when it does not exist. */
function fileBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Row counts plus on-disk footprint, for the health/admin endpoints. */
export function stats() {
  const out = {
    users: 0,
    saves: 0,
    sessions: 0,
    reports: 0,
    dbBytes: 0,
    walBytes: 0,
    // extras beyond the required shape — useful on a dashboard, cheap to read
    sessionsActive: 0,
    deeds: 0,
    schemaVersion: 0,
    freelistPages: 0,
    pageCount: 0,
  };
  if (!db.open) return out;

  const count = (table) => {
    try {
      const row = q(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return row ? row.n | 0 : 0;
    } catch {
      return 0; // table not created yet (stats() called before initSchema)
    }
  };

  out.users = count('users');
  out.saves = count('saves');
  out.sessions = count('sessions');
  out.reports = count('reports');
  out.deeds = count('deeds');

  try {
    const row = q('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now());
    out.sessionsActive = row ? row.n | 0 : 0;
  } catch { /* pre-schema */ }

  out.dbBytes = fileBytes(DB_PATH);
  out.walBytes = fileBytes(`${DB_PATH}-wal`);

  // readVersion() throws on an unreadable schema_meta by design. stats() feeds
  // dashboards, not decisions, so swallow it here — refusing the boot is
  // runMigrations()' job — but keep it out of the page counters' try so one
  // sick table does not blank the whole block.
  try { out.schemaVersion = readVersion(); } catch { /* reported as 0 */ }
  try {
    out.freelistPages = db.pragma('freelist_count', { simple: true }) | 0;
    out.pageCount = db.pragma('page_count', { simple: true }) | 0;
  } catch { /* advisory only */ }

  return out;
}

let closed = false;

/** Checkpoint, then close. Idempotent — safe from several shutdown paths. */
export function close() {
  if (closed) return;
  closed = true;
  if (!db.open) return;

  try { db.pragma('optimize'); } catch { /* advisory */ }
  checkpoint();
  try {
    db.close();
    log.info('closed cleanly');
  } catch (e) {
    log.error('close failed', { err: e && e.message });
  }
}

/* ============================================================================
   REPOSITORIES
   ========================================================================== */

export const users = {
  /** Insert a new account. Throws on duplicate username (UNIQUE COLLATE NOCASE). */
  create(username, passHash, nameChosen = 1) {
    const info = q(
      'INSERT INTO users (username, pass_hash, created_at, name_chosen) VALUES (?, ?, ?, ?)'
    ).run(String(username), String(passHash), Date.now(), nameChosen ? 1 : 0);
    return info.lastInsertRowid;
  },

  findByName(name) {
    return q('SELECT * FROM users WHERE username = ?').get(String(name)) || null;
  },

  findById(id) {
    return q('SELECT * FROM users WHERE id = ?').get(id) || null;
  },

  /**
   * Claim a name for an account that has not chosen one yet. Returns false when
   * the name is taken; the caller turns that into a 409.
   *
   * The name_chosen = 0 guard is inside the UPDATE, not in a read before it, so
   * two requests racing to rename the same account cannot both win: SQLite
   * applies them one after the other and the second matches no rows.
   */
  claimName(id, name) {
    try {
      const info = q('UPDATE users SET username = ?, name_chosen = 1 WHERE id = ? AND name_chosen = 0')
        .run(String(name), id);
      return info.changes > 0;
    } catch (err) {
      if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) return false;
      throw err;
    }
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

/**
 * Issue a token and evict everything past the per-user cap, atomically. Split
 * out so create() stays readable; the transaction matters because two logins
 * racing must not both decide a different row is the oldest.
 */
const issueSession = db.transaction((userId, token, now) => {
  q('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);

  // Expired rows for this account are dead weight; clear them before counting
  // so a pile of stale tokens cannot evict a live one.
  q('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now);

  // Keep the newest N. rowid breaks ties when two tokens share a millisecond.
  q(`DELETE FROM sessions
      WHERE user_id = ?
        AND token NOT IN (
          SELECT token FROM sessions
           WHERE user_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
        )`).run(userId, userId, MAX_SESSIONS_PER_USER);
});

export const sessions = {
  create(userId) {
    const token = randomBytes(32).toString('hex');
    issueSession(userId, token, Date.now());
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

/**
 * Log out every device for one account — used by "sign out everywhere", by a
 * password change, and by moderation when an account is banned.
 * Returns the number of sessions revoked.
 */
export function destroyAllForUser(userId) {
  if (userId == null) return 0;
  return q('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

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

/* ============================================================================
   DERBY — the hourly fishing race.
   ----------------------------------------------------------------------------
   Two tables, two lifetimes. `derby_scores` is scratch: it exists so a restart
   mid-race does not void the race, and it is dropped the moment its derby
   settles. `derby_results` is the record, and nothing ever deletes from it.
   ========================================================================== */
export const derbies = {
  /** Add to a running tally. The username is refreshed on every catch so a
   *  rename mid-derby lands on the scoreboard rather than the old name. */
  bump(derbyId, world, userId, username, kg) {
    q(`INSERT INTO derby_scores (derby_id, world, user_id, username, kg)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(derby_id, world, user_id) DO UPDATE SET
         kg       = kg + excluded.kg,
         username = excluded.username`)
      .run(derbyId | 0, String(world), userId, String(username ?? ''), +kg || 0);
  },

  /** Every live tally at or after `sinceId` — what boot replays into memory. */
  scoresFrom(sinceId) {
    return q(`SELECT derby_id, world, user_id, username, kg
                FROM derby_scores WHERE derby_id >= ?`).all(sinceId | 0);
  },

  /** Crown a champion. IGNORE, not REPLACE: a derby is settled exactly once,
   *  and a double sweep must never overwrite a paid result. */
  crown({ derbyId, world, userId, username, kg, pearls }) {
    const info = q(`INSERT OR IGNORE INTO derby_results
                      (derby_id, world, user_id, username, kg, pearls, settled_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(derbyId | 0, String(world), userId, String(username ?? ''),
           +kg || 0, pearls | 0, Date.now());
    return info.changes > 0;
  },

  /** Drop the scratch tallies for derbies that have settled. */
  clearScores(throughId) {
    q('DELETE FROM derby_scores WHERE derby_id <= ?').run(throughId | 0);
  },

  /** Recent champions, newest first. `world` narrows to one isle. */
  history({ world = null, limit = 20 } = {}) {
    const n = Math.min(Math.max(limit | 0, 1), 100);
    return world
      ? q(`SELECT * FROM derby_results WHERE world = ?
             ORDER BY settled_at DESC LIMIT ?`).all(String(world), n)
      : q(`SELECT * FROM derby_results
             ORDER BY settled_at DESC LIMIT ?`).all(n);
  },

  /** How many derbies one angler has won, and their heaviest winning haul. */
  recordFor(userId) {
    return q(`SELECT COUNT(*) AS wins, COALESCE(MAX(kg), 0) AS bestKg
                FROM derby_results WHERE user_id = ?`).get(userId)
      || { wins: 0, bestKg: 0 };
  },
};
