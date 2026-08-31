/* ============================================================================
   migration.test.js — the migration runner is only allowed to replay from
   scratch against a database that IS scratch.

   runMigrations() decides everything from readVersion(), and a 0 there means
   "start at v1". That is correct exactly once — on a file nobody has stamped —
   and catastrophic on a populated one, because v1 stays idempotent only until
   the first step that carries a backfill UPDATE or a seed INSERT. So the thing
   under test is not "do the migrations work" but "which failures are allowed to
   look like a fresh database". Answer: one. A missing schema_meta. Everything
   else has to stop the boot.

   Each case runs in its OWN child process, because db.js opens its handle at
   module scope from DB_PATH: one process gets one database, forever, and a
   second boot of the same file is only a real second boot if it is a second
   process. The child prints one RESULT line of JSON on success; on failure it
   prints the error and exits non-zero, which is precisely the behaviour the
   third case asserts.
   ========================================================================== */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_MODULE = path.resolve(HERE, '..', 'src', 'db.js');

/* The version a fresh file must reach is whatever the last entry in MIGRATIONS
   says, and MIGRATIONS is module-private. Reading it out of the source keeps
   this test honest when a v3 lands, rather than pinning a number that someone
   then has to remember to bump — the same trick parity.test.js uses on game.js. */
function latestVersionInSource() {
  const src = fs.readFileSync(DB_MODULE, 'utf8');
  const versions = [...src.matchAll(/^\s*v:\s*(\d+),\s*$/gm)].map((m) => Number(m[1]));
  assert.ok(versions.length > 0, 'no `v: N,` migration entries found in db.js');
  return Math.max(...versions);
}

/* The child. Kept as one string so nothing is written inside the repo. It
   reports the stamped version plus the table list, which is the only evidence
   that distinguishes "migrated" from "said it migrated". */
const CHILD = `
const db = await import(process.env.DB_MODULE_URL);
try {
  db.initSchema();
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((r) => r.name);
  const row = db.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  console.log('RESULT ' + JSON.stringify({ version: row ? Number(row.value) : null, tables }));
  db.close();
} catch (e) {
  console.error('BOOT-REFUSED ' + (e && e.message));
  process.exit(3);
}
`;

/**
 * Boot db.js once against `dbPath`. Returns the child's exit code, its stderr,
 * the RESULT payload (null when it refused), and the structured log lines
 * db.js emitted — `migration applied` in there is the replay this test hunts.
 */
function boot(dbPath) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: path.resolve(HERE, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      DB_MODULE_URL: pathToFileUrl(DB_MODULE),
    },
  });

  const stdout = res.stdout || '';
  const logs = [];
  for (const line of (stdout + '\n' + (res.stderr || '')).split('\n')) {
    if (!line.startsWith('{')) continue;
    try { logs.push(JSON.parse(line)); } catch { /* not one of ours */ }
  }

  const hit = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return {
    code: res.status,
    stderr: res.stderr || '',
    stdout,
    logs,
    result: hit ? JSON.parse(hit.slice(7)) : null,
    applied: logs.filter((l) => l.msg === 'migration applied').map((l) => l.v),
    said: (msg) => logs.some((l) => l.msg === msg),
  };
}

/* fileURLToPath's inverse, without pulling in url.pathToFileURL's edge cases
   for a path we produced ourselves two lines above. */
function pathToFileUrl(p) {
  return new URL(`file://${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`).href;
}

let dir;
const fresh = (name) => path.join(dir, `${name}.db`);

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelfortune-migration-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('migrations', () => {
  it('takes a fresh database to the current version', () => {
    const target = latestVersionInSource();
    const run = boot(fresh('fresh'));

    assert.equal(run.code, 0, `boot failed:\n${run.stderr}`);
    assert.equal(run.result.version, target);
    assert.deepEqual(run.applied, [...Array(target)].map((_, i) => i + 1),
      'every step should have run exactly once, in order');
    assert.ok(run.said('schema migrated'));

    // The stamp is worthless if the DDL did not actually land.
    for (const t of ['users', 'saves', 'sessions', 'action_log', 'deeds', 'schema_meta']) {
      assert.ok(run.result.tables.includes(t), `missing table ${t}`);
    }
  });

  it('leaves an already-current database alone', () => {
    const target = latestVersionInSource();
    const p = fresh('current');
    assert.equal(boot(p).code, 0);

    // A row only the second boot can destroy. saves.state is the one column a
    // future data migration would plausibly rewrite, so put the canary there.
    const seed = new Database(p);
    seed.prepare("INSERT INTO users (username, pass_hash, created_at) VALUES ('canary', 'x', 1)").run();
    seed.prepare("INSERT INTO saves (user_id, state, updated_at) VALUES (1, '{\"boatLvl\":3}', 1)").run();
    seed.close();

    const again = boot(p);
    assert.equal(again.code, 0, `second boot failed:\n${again.stderr}`);
    assert.equal(again.result.version, target);
    assert.deepEqual(again.applied, [], 'nothing should have re-run');
    assert.ok(again.said('schema up to date'));
    assert.ok(!again.said('schema migrated'));

    const check = new Database(p);
    const save = check.prepare('SELECT state FROM saves WHERE user_id = 1').get();
    const users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    check.close();
    assert.equal(save.state, '{"boatLvl":3}');
    assert.equal(users, 1);
  });

  it('refuses to migrate when schema_meta is present but unreadable', () => {
    const p = fresh('unreadable');
    assert.equal(boot(p).code, 0);

    const seed = new Database(p);
    seed.prepare("INSERT INTO users (username, pass_hash, created_at) VALUES ('canary', 'x', 1)").run();
    // Not a missing table: schema_meta is right there in sqlite_master, it just
    // cannot answer. Standing in for the corrupt page or the SQLITE_BUSY that
    // outlived busy_timeout — both of which the old catch-all turned into 0.
    seed.exec('DROP TABLE schema_meta');
    seed.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, wrong_column TEXT)');
    seed.close();

    const run = boot(p);
    assert.equal(run.code, 3, `expected a refused boot, got ${run.code}:\n${run.stdout}`);
    assert.deepEqual(run.applied, [], 'a failed version read must not replay anything');
    assert.match(run.stderr, /Refusing to start/);
    assert.match(run.stderr, /schema_meta/);
    assert.ok(run.stderr.includes(p), 'the operator has to be told which file');
    assert.match(run.stderr, /sqlite3 /, 'and what to run next');

    const check = new Database(p);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    check.close();
  });

  it('still treats a genuinely absent schema_meta as version 0', () => {
    // The one failure that is allowed to look like a fresh database, on a file
    // that is otherwise fully built — this is how a pre-versioning database
    // adopts v1, and narrowing readVersion() must not have broken it.
    const p = fresh('adopt');
    assert.equal(boot(p).code, 0);

    const seed = new Database(p);
    seed.prepare("INSERT INTO users (username, pass_hash, created_at) VALUES ('legacy', 'x', 1)").run();
    seed.exec('DROP TABLE schema_meta');
    seed.close();

    const run = boot(p);
    assert.equal(run.code, 0, `legacy adoption failed:\n${run.stderr}`);
    assert.equal(run.result.version, latestVersionInSource());

    const check = new Database(p);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1,
      'v1 is idempotent, so adoption must not have touched a row');
    check.close();
  });
});
