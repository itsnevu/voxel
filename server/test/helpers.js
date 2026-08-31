/* ============================================================================
   test/helpers.js — the harness every suite boots on.
   ----------------------------------------------------------------------------
   Goals, in order:

     SELF-CONTAINED  Nothing here talks to a server that was already running,
                     to the repo's data/ directory, or to a fixed port. Each
                     suite spawns its OWN `node src/index.js` on a free port
                     with DB_PATH pointing at a throwaway file, so two suites
                     running in parallel (node --test does that by default)
                     can never see each other's rows.

     ISOLATED IPs    auth.js and wallet.js rate-limit register/login/guest per
                     IP, in memory, with budgets as low as 5 per 10 minutes.
                     index.js sets `trust proxy: 1`, so an X-Forwarded-For
                     header decides req.ip — every request therefore gets its
                     own synthetic client address and one suite's traffic can
                     never exhaust another test's budget. A test that WANTS to
                     trip the limiter passes an explicit `ip`.

     ALWAYS CLEANED  stop() kills the child and removes the temp directory
                     (.db, .db-wal and .db-shm together). A process-exit hook
                     is the backstop for a suite that dies mid-run.

   Why a child process rather than `import('../src/index.js')`: index.js calls
   app.listen() at module scope and never exports the server, so an in-process
   import would leave a listening handle nobody can close and `node --test`
   would hang after the last assertion. Spawning also exercises the real boot
   path — schema init, static mount, websocket attach — which is what a VPS
   will actually run.
   ========================================================================== */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.js');

const BOOT_TIMEOUT_MS = 20_000;
const BOOT_POLL_MS = 50;
const BOOT_ATTEMPTS = 4;

/** Every server this process started, so the exit hooks can still reap them. */
const live = new Set();

/** Synchronous, idempotent teardown — the only kind an exit hook may do. */
function reapAll() {
  for (const handle of live) {
    try { handle.child.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(handle.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  live.clear();
}

process.on('exit', reapAll);

/* A plain `exit` hook is not enough. Node's DEFAULT signal handling terminates
   without running exit hooks at all, so a Ctrl+C halfway through a run would
   leave both a live server and its temp database behind. Installing handlers
   overrides that default: reap first, then leave by the conventional
   128+signal code so a CI runner still sees an interrupt as an interrupt.
   (`node --test --watch` also stops file processes with SIGTERM, so this is
   what keeps watch mode from accumulating servers on every rerun.) */
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => { reapAll(); process.exit(code); });
}

/* ------------------------------------------------------------- utilities -- */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A username that always satisfies auth.js's /^[A-Za-z0-9_]{3,20}$/. */
export const uniqueName = (prefix = 'u') =>
  `${prefix}${randomBytes(6).toString('hex')}`.slice(0, 20);

/**
 * A free TCP port. There is an unavoidable gap between closing this probe and
 * the child binding, so startServer() retries the whole boot if it loses that
 * race rather than failing the suite.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/* Synthetic client addresses. A fresh one per request by default, so no test
   inherits another's rate-limit budget. 10.x is private space and never
   resolves to anything real. */
let ipCounter = 0;
function nextIp() {
  const n = ++ipCounter;
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

/* ---------------------------------------------------------------- boot ---- */

async function bootOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelfortune-test-'));
  const dbPath = path.join(dir, 'test.db');
  /* An empty static root: express.static must not be handed the real project
     tree during tests, and nothing in the suites fetches a game asset. */
  const gameDir = path.join(dir, 'public');
  fs.mkdirSync(gameDir, { recursive: true });

  const port = await freePort();

  const child = spawn(process.execPath, [ENTRY], {
    cwd: SERVER_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH: dbPath,
      GAME_DIR: gameDir,
      CORS_ORIGIN: '*',
      /* Fixed so /api/ledger/claim signatures are reproducible within a run
         and the boot never prints its "ephemeral dev secret" warning. */
      LEDGER_SECRET: 'test-ledger-secret-not-for-production',
    },
  });

  let output = '';
  const capture = (chunk) => { output += chunk.toString('utf8'); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  /* A spawn that never starts must reject the boot, not crash the runner. */
  child.on('error', (err) => { exited = { code: null, signal: null, err }; });

  const origin = `http://127.0.0.1:${port}`;
  const handle = { child, dir, port, origin };
  live.add(handle);

  const startedAt = Date.now();
  const deadline = startedAt + BOOT_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited) break;
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body && body.ok) { healthy = true; break; }
      }
    } catch { /* not listening yet */ }
    await sleep(BOOT_POLL_MS);
  }

  if (!healthy) {
    live.delete(handle);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
    const waited = Date.now() - startedAt;
    const why = exited
      ? `exited (code ${exited.code}, signal ${exited.signal}` +
        `${exited.err ? `, spawn error: ${exited.err.message}` : ''})`
      : `never answered /api/health (still ${child.exitCode === null && child.signalCode === null ? 'running' : 'gone'})`;
    /* An empty tail is the worst report this can give: it reads as "the child
       said nothing was wrong" when it almost always means the child never got
       far enough to say anything. Spell out which of the two it was. */
    const tail = output
      ? `\n${output.slice(-2000)}`
      : '\n  (the child wrote nothing at all to stdout or stderr)';
    throw new Error(`server ${why} during boot on port ${port} after ${waited}ms${tail}`);
  }

  return { handle, output: () => output };
}

/**
 * Boot a server nobody else is sharing.
 *
 * Returns a handle with:
 *   origin / wsOrigin / port
 *   request(method, path, opts) -> { status, headers, text, body }
 *   get(path, opts) / post(path, opts)
 *   socket(token)  -> a websocket wrapper (see openSocket)
 *   stop()         -> kill + delete the temp DB; safe to call twice
 *
 * Request options: { token, body, raw, ip, headers }. `body` is JSON-encoded;
 * `raw` is sent verbatim (for malformed-payload tests). `ip` pins the
 * X-Forwarded-For address so a test can deliberately share a rate-limit
 * bucket across calls.
 */
export async function startServer() {
  let lastErr;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      const { handle, output } = await bootOnce();
      return makeServer(handle, output);
    } catch (err) {
      lastErr = err;
      /* Printed as it happens, not merely rethrown at the end. A suite that
         dies in before() is reported by node --test as "0 fail, N cancelled":
         the throw below never reaches a TAP diagnostic, so without this the
         only evidence of three dead children is a summary that looks like
         nothing ran. */
      console.error(`[helpers] boot attempt ${attempt}/${BOOT_ATTEMPTS} failed: ${err.message}`);
    }
  }
  throw new Error(
    `no server booted in ${BOOT_ATTEMPTS} attempts — see the attempt logs above`,
    { cause: lastErr });
}

function makeServer(handle, output) {
  const { child, dir, port, origin } = handle;
  const wsOrigin = `ws://127.0.0.1:${port}`;
  const sockets = new Set();

  async function request(method, pathname, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    headers['X-Forwarded-For'] = opts.ip || nextIp();

    /* fetch refuses to attach a body to GET/HEAD, and callers loop over mixed
       method lists — so the payload is simply dropped for those verbs. */
    const bodyAllowed = method !== 'GET' && method !== 'HEAD';
    let payload;
    if (bodyAllowed && opts.raw !== undefined) {
      payload = opts.raw;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    } else if (bodyAllowed && opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(origin + pathname, { method, headers, body: payload });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not json — keep text */ }
    return { status: res.status, headers: res.headers, text, body };
  }

  const server = {
    port,
    origin,
    wsOrigin,
    output,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),

    socket(token) {
      const sock = openSocket(wsOrigin, token);
      sockets.add(sock);
      return sock;
    },

    async stop() {
      for (const sock of sockets) { try { sock.close(); } catch { /* already gone */ } }
      sockets.clear();
      live.delete(handle);
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await Promise.race([done, sleep(3000)]);
      }
      /* -wal and -shm sit beside the .db file, so the whole directory goes. */
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  return server;
}

/* ----------------------------------------------------------- websockets --- */

/**
 * A websocket with a message log a test can wait on.
 *
 * Reads are SEQUENTIAL: waitFor() scans from a cursor and, on a match, moves
 * the cursor past it. That keeps the 10Hz `snap` traffic from being mistaken
 * for a later event, and makes "the second chat line" mean the second one.
 *
 *   await sock.opened                 resolves once the socket is connected
 *   sock.send(obj)                    JSON-encodes and sends
 *   await sock.waitFor(pred, ms)      next unread message matching pred
 *   sock.seen(pred)                   any unread match, without consuming
 *   sock.drain()                      declare everything so far as read
 *   await sock.closed                 { code, reason }
 */
export function openSocket(wsOrigin, token) {
  const url = `${wsOrigin}/ws${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`;
  const ws = new WebSocket(url);

  const messages = [];
  const waiters = [];
  let cursor = 0;

  let resolveOpen, rejectOpen, resolveClosed;
  const opened = new Promise((res, rej) => { resolveOpen = res; rejectOpen = rej; });
  const closed = new Promise((res) => { resolveClosed = res; });
  /* An unauthorised socket is closed before it ever opens; nothing should be
     an unhandled rejection just because a test only awaits `closed`. */
  opened.catch(() => {});

  const pump = () => {
    for (let w = 0; w < waiters.length; w++) {
      const waiter = waiters[w];
      for (let i = cursor; i < messages.length; i++) {
        if (!waiter.pred(messages[i])) continue;
        cursor = i + 1;
        clearTimeout(waiter.timer);
        waiters.splice(w, 1);
        waiter.resolve(messages[i]);
        return pump();          // the cursor moved; re-run for the next waiter
      }
    }
  };

  ws.on('open', () => resolveOpen(ws));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    messages.push(msg);
    pump();
  });
  ws.on('error', (err) => rejectOpen(err));
  ws.on('close', (code, reason) => {
    const info = { code, reason: reason ? reason.toString('utf8') : '' };
    rejectOpen(new Error(`socket closed before opening (code ${code})`));
    resolveClosed(info);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`socket closed (code ${code}) while waiting`));
    }
  });

  return {
    ws,
    url,
    opened,
    closed,
    messages,

    send(obj) { ws.send(JSON.stringify(obj)); },

    waitFor(pred, ms = 4000) {
      for (let i = cursor; i < messages.length; i++) {
        if (pred(messages[i])) { cursor = i + 1; return Promise.resolve(messages[i]); }
      }
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`timed out after ${ms}ms waiting for a message; unread: ` +
            JSON.stringify(messages.slice(cursor).map((m) => m.t))));
        }, ms);
        waiters.push(waiter);
      });
    },

    /** Convenience: the next unread frame of this protocol type. */
    waitType(type, ms) { return this.waitFor((m) => m.t === type, ms); },

    seen(pred) { return messages.slice(cursor).some(pred); },
    unread() { return messages.slice(cursor); },
    drain() { cursor = messages.length; },

    close() {
      try { ws.close(); } catch { /* already gone */ }
    },
  };
}

/* ------------------------------------------------------------- accounts --- */

/** Register a fresh account and hand back its credentials plus a live token. */
export async function registerUser(server, opts = {}) {
  const username = opts.username || uniqueName();
  const password = opts.password || 'correct horse battery';
  const res = await server.post('/api/auth/register', {
    body: { username, password },
    ip: opts.ip,
  });
  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${res.text}`);
  }
  return { username, password, token: res.body.token, id: res.body.user.id };
}

/** GET /api/state as `token`, asserting nothing — callers inspect the result. */
export async function getState(server, token) {
  const res = await server.get('/api/state', { token });
  return res;
}

/** POST one game intent. Returns the raw response envelope. */
export async function action(server, token, name, body = {}) {
  return server.post(`/api/action/${name}`, { token, body });
}
