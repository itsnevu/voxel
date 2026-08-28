/* ============================================================================
   log.js — structured logging, no dependencies.
   ----------------------------------------------------------------------------
   One JSON object per line, so `journalctl -u reelfortune -o cat | jq` works on
   a plain VPS without shipping a log stack:

     {"ts":"2026-08-28T04:11:09.412Z","level":"info","msg":"request",
      "id":"9f2c1ab0","method":"POST","path":"/api/action/cast","status":200,"ms":4.1}

   Writes go to stdout, except `error` which goes to stderr — that split is what
   lets systemd and most process managers colour and alert on failures without
   parsing anything.

   REDACTION IS THE POINT. This server handles passwords, session tokens, wallet
   signatures and guest keys; a log line is the easiest place for those to leak,
   because logging is exactly what people reach for while debugging. So every
   field is walked before it is written and anything whose *name* looks like a
   credential is replaced with "[redacted]" — the value is never inspected, never
   partially printed, never length-hinted. Matching is on a normalised key
   (lowercased, punctuation stripped) and is a SUBSTRING test, so pass_hash,
   passHash, X-Auth-Token, sessionToken and guest_key are all caught. A false
   positive costs a debugging session; a false negative costs a player's account.

   The walk stops at depth 4 (MAX_DEPTH). Deeper structures are replaced with
   "[truncated]" rather than stringified, because anything we did not walk is
   also anything we did not redact.

   Env:
     LOG_LEVEL=debug|info|warn|error   default info; lower levels are dropped
     LOG_PRETTY=1                      human-readable coloured output for dev
     NO_COLOR=1                        pretty output without ANSI colour

   Usage:
     import { log, child } from './log.js';
     log.info('server up', { port: 8787 });
     log.error('save failed', err);              // an Error may be passed bare
     const rlog = child({ id: req.id });         // fields pinned to every line
   ========================================================================== */

/* -------------------------------------------------------------- levels ---- */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function resolveLevel(raw) {
  const name = String(raw || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, name) ? name : 'info';
}

const LEVEL_NAME = resolveLevel(process.env.LOG_LEVEL);
const MIN_LEVEL = LEVELS[LEVEL_NAME];

const PRETTY = /^(1|true|yes|on)$/i.test(String(process.env.LOG_PRETTY || ''));
const COLOR = PRETTY && !process.env.NO_COLOR;

/* ------------------------------------------------------------ redaction --- */
// Normalised (lowercase, alphanumerics only) fragments. A field name CONTAINING
// any of these is redacted whole. Keep this list additive — removing an entry
// is how a credential ends up in a log file.
const SECRET_FRAGMENTS = Object.freeze([
  'password',
  'token',
  'signature',
  'passhash',
  'guestkey',
  'authorization',
  'cookie'
]);

const REDACTED = '[redacted]';

const MAX_DEPTH = 4;      // levels of nesting walked below the fields object
const MAX_ITEMS = 64;     // array entries / object keys kept per container
const MAX_STRING = 8192;  // a single string longer than this is clipped

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function isSecretKey(key) {
  const flat = normalizeKey(key);
  if (!flat) return false;
  for (const fragment of SECRET_FRAGMENTS) if (flat.includes(fragment)) return true;
  return false;
}

function clip(str) {
  if (str.length <= MAX_STRING) return str;
  return `${str.slice(0, MAX_STRING)}…[+${str.length - MAX_STRING} chars]`;
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function serializeError(err, depth, seen) {
  const out = {
    name: String(err.name || 'Error'),
    message: clip(String(err.message || ''))
  };
  if (err.code !== undefined) out.code = sanitize(err.code, depth + 1, seen);
  if (typeof err.stack === 'string') out.stack = clip(err.stack);
  // Errors thrown by express/http-errors and by our own code carry useful extra
  // properties (status, type, path…). They are ordinary fields, so they go
  // through the same redaction walk as anything else.
  for (const key of Object.keys(err)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'code') continue;
    if (isSecretKey(key)) { out[key] = REDACTED; continue; }
    const value = sanitize(err[key], depth + 1, seen);
    if (value !== undefined) out[key] = value;
  }
  if (err.cause !== undefined && out.cause === undefined) {
    out.cause = sanitize(err.cause, depth + 1, seen);
  }
  return out;
}

/**
 * Turn an arbitrary value into something safe to JSON.stringify: no secrets, no
 * cycles, bounded size, no throwing getters left unevaluated in a surprising way.
 */
function sanitize(value, depth, seen) {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':   return clip(value);
    case 'number':   return Number.isFinite(value) ? value : String(value);
    case 'boolean':  return value;
    case 'undefined': return undefined;
    case 'bigint':   return `${value}`;
    case 'symbol':   return String(value);
    case 'function': return `[function ${value.name || 'anonymous'}]`;
    default: break;
  }

  if (depth > MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) {
    seen.add(value);
    try { return serializeError(value, depth, seen); }
    catch { return { name: 'Error', message: '[unserializable error]' }; }
    finally { seen.delete(value); }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[bytes ${value.length}]`;
  if (isTypedArray(value)) return `[${value.constructor?.name || 'TypedArray'} ${value.length}]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      const take = Math.min(value.length, MAX_ITEMS);
      for (let i = 0; i < take; i++) {
        const item = sanitize(value[i], depth + 1, seen);
        out.push(item === undefined ? null : item);
      }
      if (value.length > take) out.push(`[+${value.length - take} more]`);
      return out;
    }

    if (value instanceof Map) return sanitizeEntries(value.entries(), value.size, depth, seen);
    if (value instanceof Set) return sanitize(Array.from(value), depth, seen);

    // Object.keys() does not fire getters; each value is then read on its own so
    // one hostile accessor costs its single field instead of the whole record.
    const keys = Object.keys(value);
    const readEntries = function* () {
      for (const key of keys) {
        let raw;
        try { raw = value[key]; } catch { raw = '[getter threw]'; }
        yield [key, raw];
      }
    };
    return sanitizeEntries(readEntries(), keys.length, depth, seen);
  } catch {
    // A throwing getter or an exotic proxy must not take the process with it.
    return '[unserializable]';
  } finally {
    seen.delete(value);
  }
}

function sanitizeEntries(entries, knownSize, depth, seen) {
  const out = {};
  let kept = 0;
  let total = 0;
  for (const [rawKey, rawValue] of entries) {
    total++;
    if (kept >= MAX_ITEMS) continue;
    const key = typeof rawKey === 'string' ? rawKey : String(rawKey);
    kept++;
    if (isSecretKey(key)) { out[key] = REDACTED; continue; }
    const value = sanitize(rawValue, depth + 1, seen);
    if (value !== undefined) out[key] = value;
  }
  const size = knownSize === undefined ? total : knownSize;
  if (size > kept) out['…'] = `[+${size - kept} more]`;
  return out;
}

/** Shape whatever was passed as `fields` into a plain object of fields. */
function toFieldObject(fields) {
  if (fields === undefined || fields === null) return null;
  if (fields instanceof Error) return { err: fields };
  if (typeof fields !== 'object' || Array.isArray(fields)) return { value: fields };
  return fields;
}

function mergeFields(base, fields) {
  const extra = toFieldObject(fields);
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };      // call-site fields win over the child's base
}

/* ------------------------------------------------------------- output ----- */
const RESERVED = new Set(['ts', 'level', 'msg']);

function safeStringify(record) {
  try {
    return JSON.stringify(record);
  } catch {
    // sanitize() should make this impossible; the fallback exists so a logging
    // bug can never be the thing that takes the server down.
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      log_error: 'fields could not be serialized'
    });
  }
}

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const paint = (code, text) => (COLOR ? `${code}${text}${RESET}` : text);

function prettyValue(value) {
  if (typeof value === 'string') {
    return value.length && /^[\w.@:\/+-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') return String(value);
  try { return JSON.stringify(value); } catch { return '[unserializable]'; }
}

function prettyLine(record) {
  const time = record.ts.slice(11, 23);                       // HH:MM:SS.mmm
  const level = record.level.toUpperCase().padEnd(5);
  const parts = [paint(DIM, time), paint(COLORS[record.level] || '', level), record.msg];

  // The stack is printed under the line instead of inside it: a one-line JSON
  // stack is unreadable, and pretty mode exists exactly for reading.
  let trailer = '';
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key)) continue;
    if (key === 'err' && value && typeof value === 'object' && typeof value.stack === 'string') {
      trailer = `\n${paint(DIM, value.stack.split('\n').map(l => `    ${l}`).join('\n'))}`;
      const { stack, ...rest } = value;
      if (Object.keys(rest).length) parts.push(`${paint(DIM, 'err=')}${prettyValue(rest)}`);
      continue;
    }
    parts.push(`${paint(DIM, `${key}=`)}${prettyValue(value)}`);
  }
  return parts.join(' ') + trailer;
}

function emit(level, msg, fields, base) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const record = {
    ts: new Date().toISOString(),
    level,
    msg: clip(typeof msg === 'string' ? msg : String(msg === undefined ? '' : msg))
  };

  const merged = mergeFields(base, fields);
  if (merged) {
    let safe;
    try { safe = sanitize(merged, 0, new Set()); }
    catch { safe = { log_error: 'fields could not be sanitized' }; }

    if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
      for (const [key, value] of Object.entries(safe)) {
        if (value === undefined) continue;
        // A field literally named ts/level/msg would corrupt the envelope for
        // every downstream parser, so it is kept but renamed rather than lost.
        record[RESERVED.has(key) ? `${key}_` : key] = value;
      }
    } else if (safe !== undefined) {
      record.fields = safe;
    }
  }

  const line = PRETTY ? prettyLine(record) : safeStringify(record);
  const stream = level === 'error' ? process.stderr : process.stdout;
  try {
    stream.write(`${line}\n`);
  } catch {
    /* A closed or full stdout must never throw into the caller. */
  }
}

/* ------------------------------------------------------------ loggers ----- */
function makeLogger(base) {
  return {
    debug: (msg, fields) => emit('debug', msg, fields, base),
    info:  (msg, fields) => emit('info',  msg, fields, base),
    warn:  (msg, fields) => emit('warn',  msg, fields, base),
    error: (msg, fields) => emit('error', msg, fields, base),
    /** Nest further: child fields merge on top of this logger's own. */
    child: (moreFields) => makeLogger(mergeFields(base, moreFields) || null)
  };
}

/** The process-wide logger. */
export const log = makeLogger(null);

/**
 * A logger that stamps `baseFields` onto every line it writes.
 *   const rlog = child({ id: req.id, userId });
 *   rlog.warn('slow save', { ms: 2400 });
 */
export function child(baseFields) {
  return makeLogger(toFieldObject(baseFields));
}

/**
 * True when a line at `level` would actually be written. Use it to skip building
 * expensive debug fields that would only be thrown away.
 */
export function levelEnabled(level) {
  const want = LEVELS[String(level || '').toLowerCase()];
  return want !== undefined && want >= MIN_LEVEL;
}

/** The active threshold, for a boot banner. */
export const logLevel = LEVEL_NAME;
