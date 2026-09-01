/* ============================================================================
   middleware.js — the express plumbing a public VPS needs, and nothing else.
   ----------------------------------------------------------------------------
   No helmet, no morgan, no dependency: every header and every log line here is
   written by hand so a deploy is `git pull && systemctl restart` and never an
   npm audit surprise.

   Mount order in index.js matters, because each piece feeds the next:

     app.use(requestId);          // must be first — everything below logs req.id
     app.use(securityHeaders);    // before any route can answer
     app.use(accessLog);          // starts the clock; writes on response finish
     …cors, body parser, routes…
     app.use(notFoundJson);       // /api/* never falls through to static files
     …static files, catch-all 404…
     app.use(errorHandler);       // LAST: express only calls a 4-arg handler here

   And once, at boot: installProcessGuards().

   What never reaches a client: stack traces, error messages we did not write,
   the request body, the query string. What never reaches the log: passwords,
   tokens, signatures — log.js redacts by field name, and nothing here hands it
   a body or a raw URL to begin with.
   ========================================================================== */

import crypto from 'node:crypto';
import { log } from './log.js';

/* -------------------------------------------------------------- tuning ---- */
const SLOW_MS = Number(process.env.LOG_SLOW_MS) > 0 ? Number(process.env.LOG_SLOW_MS) : 1000;

// Path prefixes whose successful responses drop to `debug`, so an uptime probe
// hitting /api/health every 5s does not bury the interesting lines.
//   LOG_ACCESS_QUIET=/api/health,/lib,/assets
const QUIET_PREFIXES = (process.env.LOG_ACCESS_QUIET || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const FATAL_GRACE_MS = Number(process.env.FATAL_GRACE_MS) > 0
  ? Number(process.env.FATAL_GRACE_MS)
  : 3000;

const HSTS_MAX_AGE = 31536000;   // one year; add `; preload` only when you mean it

const MAX_PATH_LOG = 256;

/* ============================================================================
   REQUEST ID
   ========================================================================== */

/**
 * Give every request a short correlation id. `req.id` is what ties an access
 * line, a warning inside a handler and a 500 response together — the id in
 * `{"error":"internal error","id":"9f2c1ab0"}` is greppable in journalctl.
 *
 * The id is always generated here and never taken from an inbound header: a
 * client-supplied X-Request-Id is attacker-controlled text that would land in
 * every log line for that request.
 */
export function requestId(req, res, next) {
  const id = crypto.randomUUID().slice(0, 8);
  req.id = id;
  try { res.setHeader('X-Request-Id', id); } catch { /* headers already sent */ }
  next();
}

/* ============================================================================
   ACCESS LOG
   ========================================================================== */

/** Strip the query string, control characters and any absurd length. */
function logPath(req) {
  const raw = String((req && (req.originalUrl || req.url)) || '');
  const noQuery = raw.split('?')[0];
  // Control characters would let a crafted URL forge extra lines in pretty mode.
  const clean = noQuery.replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > MAX_PATH_LOG ? `${clean.slice(0, MAX_PATH_LOG)}…` : clean;
}

const isQuiet = (path) => QUIET_PREFIXES.some(p => path === p || path.startsWith(p));

/**
 * One line per completed response: method, path, status, duration, req.id and
 * the authenticated user when there is one.
 *
 * The query string and the body are deliberately absent. `?token=…` in a URL and
 * a password in a JSON body are the two classic ways credentials end up on disk
 * forever, and neither is worth the debugging convenience.
 *
 * Warn level for status >= 500 or a response slower than LOG_SLOW_MS (1s): those
 * are the two lines an operator actually wants to be alerted on.
 */
export function accessLog(req, res, next) {
  const startedAt = process.hrtime.bigint();
  let written = false;

  const write = () => {
    if (written) return;
    written = true;
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);

    const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;
    const path = logPath(req);
    const status = res.statusCode;
    // 'close' before 'finish' means the client hung up mid-response; the status
    // we recorded was never actually delivered, so say so.
    const aborted = !res.writableEnded;

    const fields = {
      id: req.id,
      method: req.method,
      path,
      status,
      ms,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || undefined
    };
    // requireAuth sets req.userId; unauthenticated routes simply have none.
    if (req.userId !== undefined && req.userId !== null) fields.userId = req.userId;
    if (aborted) fields.aborted = true;

    const len = Number(typeof res.getHeader === 'function' ? res.getHeader('content-length') : NaN);
    if (Number.isFinite(len)) fields.len = len;

    let level = 'info';
    if (status >= 500 || ms > SLOW_MS) level = 'warn';
    else if (status < 400 && isQuiet(path)) level = 'debug';

    log[level]('request', fields);
  };

  const onFinish = () => write();
  const onClose = () => write();

  res.on('finish', onFinish);
  res.on('close', onClose);
  next();
}

/* ============================================================================
   IP RATE LIMIT
   ----------------------------------------------------------------------------
   One fixed-window counter per client IP, held in a Map. auth.js, wallet.js and
   admin.js each grew their own copy of this, byte-for-byte the same loop with a
   different budget and a different 429 body; they now all call this factory.

   Fixed window, not a sliding one: a burst straddling the boundary can spend
   two budgets, which is the price of never allocating per-request. Every user
   of this is a coarse abuse ceiling, not an accounting limit — the per-user,
   per-action cooldowns that decide who may act live in the action log instead.

   In-memory, so the budget is per process: a multi-instance deployment needs a
   shared store, and this file is where that would go.
   ========================================================================== */

const RL_MAP_CAP = 5000;   // prune only once the map is worth walking

const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

/**
 * @param {object} opts
 * @param {number} opts.max        requests allowed per window, per IP
 * @param {number} opts.windowMs   window length
 * @param {string} [opts.message]  `error` field of the 429 body
 * @param {string|null} [opts.code] `code` field; null omits it
 * @param {(req)=>string} [opts.key] override the bucket key (defaults to IP)
 * @returns {Function} express middleware
 */
export function ipRateLimit(opts) {
  const max = Number(opts && opts.max) || 0;
  const windowMs = Number(opts && opts.windowMs) || 0;
  const message = (opts && opts.message) || 'too many attempts, try again later';
  const code = (opts && 'code' in opts) ? opts.code : 'RATE_LIMIT';
  const keyOf = (opts && opts.key) || clientIp;
  const hits = new Map();   // key -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    // Cheap opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > RL_MAP_CAP) {
      for (const [k, rec] of hits) if (rec.resetAt <= now) hits.delete(k);
    }

    const key = keyOf(req);
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;

    if (rec.count > max) {
      const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      const body = { error: message };
      if (code) body.code = code;
      return res.status(429).json(body);
    }
    next();
  };
}

/* ============================================================================
   SECURITY HEADERS
   ----------------------------------------------------------------------------
   The policy is tuned to the game as it actually ships, not to a generic
   template — index.html loads three local <script src> files (no inline JS, so
   script-src stays 'self' with no escape hatch), one inline <style> block, and
   Google Fonts. connect-src is 'self' and nothing else: a bare `ws:`/`wss:`
   scheme matches EVERY host, which would let an injected script stream a save
   to any listener on the internet. 'self' already covers the same-origin
   WebSocket realtime.js rides on — the scheme upgrade is part of the origin
   match, so ws://<this host>/ws and wss://<this host>/ws both pass.

   The one exception to that is the mint page, which is a chain client: it has
   to reach a JSON-RPC endpoint that is by definition not this origin. So
   connect-src gains the RPC ORIGIN and nothing else — derived from the same
   NFT_RPC_URL the server itself calls, so the page can only talk to the node
   the operator already chose. Deployments that mint on several chains list the
   extra origins in CSP_CONNECT_EXTRA. Never widen this to a bare scheme or a
   wildcard: `https:` matches every host on the internet, which is precisely
   the hole 'self' was protecting.

   If you ever add an inline <script>, do NOT add 'unsafe-inline' here — that
   single word is what turns any future XSS into a full account takeover. Move
   the code into a .js file instead.

   nginx.conf also sets X-Frame-Options. A duplicate identical value is harmless;
   if you make the two disagree, drop one — `proxy_hide_header` in nginx is the
   easiest way to let the app own the policy.
   ========================================================================== */

/**
 * Origins the page may open a connection to, beyond this one.
 *
 * Read from env rather than from nft.js so this module stays a leaf: nft.js
 * imports auth.js, which imports this file, and a cycle here would be a boot
 * order bug hiding behind a security header.
 *
 * Anything that is not an absolute http(s) URL is dropped rather than passed
 * through — a malformed entry must not become a stray token in the policy.
 */
function connectOrigins() {
  /* Same unset-vs-empty rule as nft.js: a deployment that empties NFT_RPC_URL is
     saying there is no chain, and must not then have a loopback address written
     into its Content-Security-Policy. */
  const rpc = process.env.NFT_RPC_URL === undefined
    ? 'http://127.0.0.1:8545'
    : process.env.NFT_RPC_URL;
  const raw = [rpc].concat(String(process.env.CSP_CONNECT_EXTRA || '').split(','));
  const out = [];
  for (const entry of raw) {
    const value = String(entry || '').trim();
    if (!value) continue;
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      /* not a URL: dropped */
    }
  }
  return out;
}

/** The exact Content-Security-Policy sent with every response. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  ["connect-src 'self'"].concat(connectOrigins()).join(' '),
  "object-src 'none'",
  "base-uri 'self'",
  // The game posts no forms at all, and frames nothing: both directives exist
  // to give an injected <form> or <iframe> nowhere to point.
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'self'"
].join('; ');

/** True when the browser reached us over TLS, directly or through the proxy. */
function isHttps(req) {
  if (req.secure) return true;
  // nginx sets this; it may arrive as a list, in which case the client-facing
  // hop is the first entry.
  const fwd = req.headers && req.headers['x-forwarded-proto'];
  if (!fwd) return false;
  return String(fwd).split(',')[0].trim().toLowerCase() === 'https';
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);

  // HSTS only over TLS. Sending it on a plain-http dev box would pin localhost
  // to https in the developer's browser for a year.
  if (isHttps(req)) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
  }
  next();
}

/* ============================================================================
   404
   ========================================================================== */

const isApiPath = (path) => path === '/api' || path.startsWith('/api/');

/**
 * Unknown /api/* answers JSON, never the static index.html — a fetch() that
 * receives an HTML page for a typo'd endpoint fails with a confusing JSON parse
 * error three layers away from the real mistake.
 *
 * Mounted after the routes and before the static handler it calls next() for
 * non-API paths; used as the final catch-all (where express passes no next) it
 * answers 404 for everything.
 */
export function notFoundJson(req, res, next) {
  const path = String((req && (req.path || req.url)) || '').split('?')[0];
  if (isApiPath(path) || typeof next !== 'function') {
    return res.status(404).json({ error: 'not found', id: req.id });
  }
  return next();
}

/* ============================================================================
   ERROR HANDLER
   ========================================================================== */

const CLIENT_TEXT = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  405: 'method not allowed',
  408: 'request timeout',
  409: 'conflict',
  413: 'payload too large',
  415: 'unsupported media type',
  429: 'too many requests'
};

/** Decide the status and the (safe, hand-written) message a client may see. */
function classify(err) {
  const type = err && err.type;

  // express.json() failures. They are the client's fault and saying so plainly
  // saves everyone a packet capture.
  if (type === 'entity.too.large') return { status: 413, message: 'payload too large' };
  if (type === 'entity.parse.failed') return { status: 400, message: 'malformed json' };
  if (type === 'entity.verify.failed') return { status: 400, message: 'malformed body' };
  if (type === 'encoding.unsupported') return { status: 415, message: 'unsupported encoding' };
  if (type === 'request.aborted') return { status: 400, message: 'request aborted', aborted: true };

  // A SyntaxError carrying a `body` is body-parser's; a bare SyntaxError is our
  // own bug and must stay a 500.
  if (err instanceof SyntaxError && err.body !== undefined) {
    return { status: 400, message: 'malformed json' };
  }

  const raw = Number(err && (err.status || err.statusCode));
  if (Number.isInteger(raw) && raw >= 400 && raw <= 499) {
    // http-errors marks 4xx messages as safe to show; anything else gets our own
    // wording, because an error message we did not write may quote a file path,
    // a SQL fragment or a token.
    const message = (err.expose === true && typeof err.message === 'string' && err.message)
      ? err.message
      : (CLIENT_TEXT[raw] || 'request rejected');
    return { status: raw, message };
  }

  return { status: 500, message: 'internal error' };
}

/**
 * The last middleware. Logs everything, tells the client almost nothing.
 *
 * A 500 body is exactly {error:"internal error", id:"…"} — no stack, no message,
 * no `detail` in development either. The id is the whole point: the operator
 * greps it and gets the stack from the log, where it belongs.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const { status, message, aborted } = classify(err);
  const path = logPath(req);

  const fields = {
    id: req && req.id,
    method: req && req.method,
    path,
    status,
    err                       // log.js prints name/message/stack and redacts extras
  };
  if (req && req.userId !== undefined && req.userId !== null) fields.userId = req.userId;

  if (status >= 500) log.error('request failed', fields);
  else log.warn('request rejected', fields);

  // The socket is already gone (aborted upload, client navigated away) or a
  // route streamed part of a response before throwing. Writing now would either
  // throw again or append garbage after a valid body; hand it back to express,
  // whose final handler destroys the connection.
  if (aborted || res.headersSent) {
    if (typeof next === 'function') return next(err);
    if (!res.writableEnded) res.end();
    return undefined;
  }

  res.status(status).json({ error: message, id: req && req.id });
}

/* ============================================================================
   PROCESS GUARDS
   ========================================================================== */

const fatalHooks = [];
let guardsInstalled = false;
let fatalStarted = false;

/**
 * Register a teardown step to run when the process is dying from an
 * uncaughtException — closing the HTTP server and the sqlite handle, say:
 *
 *   onFatal(() => new Promise(r => server.close(r)));
 *   onFatal(() => db.close());
 *
 * Hooks may return a promise; they get FATAL_GRACE_MS (3s) in total, then the
 * process exits regardless. Keep them short and make them safe to run against a
 * half-broken state — that is the state they will always see.
 *
 * @returns {() => void} an unregister function.
 */
export function onFatal(fn) {
  if (typeof fn !== 'function') return () => {};
  fatalHooks.push(fn);
  return () => {
    const i = fatalHooks.indexOf(fn);
    if (i >= 0) fatalHooks.splice(i, 1);
  };
}

function beginFatalShutdown(code) {
  // A second throw during teardown must not restart the clock, or a crash loop
  // inside a hook keeps a corrupted process alive forever.
  if (fatalStarted) return;
  fatalStarted = true;

  // Deliberately NOT unref'd: this timer is the hard deadline. If a hook hangs
  // on a socket that will never close, this is what still gets us to exit(1) so
  // systemd's Restart= can put a healthy process in our place.
  const deadline = setTimeout(() => {
    log.error('fatal shutdown timed out · exiting anyway', { graceMs: FATAL_GRACE_MS });
    process.exit(code);
  }, FATAL_GRACE_MS);

  const hooks = fatalHooks.splice(0);
  const running = hooks.map((fn) => {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  });

  Promise.allSettled(running)
    .then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') log.error('fatal hook failed', { err: r.reason });
      }
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(deadline);
      // stdout to a pipe (systemd journal, docker) flushes asynchronously, so a
      // bare exit() here can swallow the very crash line we just wrote. This
      // timer is not unref'd either · an unref'd one would let an idle loop exit
      // with code 0 and hide the crash from the restart policy.
      setTimeout(() => process.exit(code), 50);
    });
}

/**
 * Install the two last-resort process handlers. Idempotent.
 *
 * unhandledRejection is logged and survived. Note the trade: registering a
 * handler switches off node's default "crash on unhandled rejection", which is
 * the right call for a game server where one bad await in a chat handler should
 * not disconnect everyone — but it means these lines are real bugs that nothing
 * else will ever remind you about. Read them.
 *
 * uncaughtException is NOT survived. Once a throw escapes every frame, the
 * invariants of whatever it was halfway through — a half-applied economy
 * transaction, a socket map with a ghost entry — are unknown, and an
 * authoritative server that keeps taking money in that state is worse than one
 * that is down. So: log it, run the onFatal hooks for up to 3 seconds so the
 * listener and sqlite close cleanly, then exit(1) and let systemd restart us.
 */
export function installProcessGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason instanceof Error ? { err: reason } : { reason });
  });

  process.on('uncaughtException', (err, origin) => {
    try {
      log.error('uncaught exception · shutting down', { origin, err });
    } catch { /* logging must never be what stops the shutdown */ }
    beginFatalShutdown(1);
  });
}
