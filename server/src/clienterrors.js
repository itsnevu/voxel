/* ============================================================================
   clienterrors.js — the ring buffer behind POST /api/client-error.

   The server has had structured logging since the production layer landed and
   could still not see the half of the game that actually runs: RF.errors is a
   300-entry buffer in somebody's tab, read by nobody but that player's own
   notification drawer. A bug that only fires on one Android Chrome build has
   been, until now, completely invisible from here.

   Deliberately NOT a table. A crash loop writes as fast as the network allows,
   and the failure mode of putting that in SQLite is a database that grows while
   the thing being reported is already going wrong. Memory has a hard ceiling
   and dies with the process, which is the right trade for a signal an operator
   reads live and acts on within the hour; the durable copy is the structured
   log line, which journald already rotates.

   Identical faults COLLAPSE. One player stuck in a broken render loop must read
   as "1 fault, seen 400 times", not as 400 entries that push every other fault
   out of the window — that is exactly how a ring buffer loses the bug you
   needed while faithfully recording the one you already knew about.
   ========================================================================== */

const CAP = 200;             // distinct faults kept
const WHERE_MAX = 80;
const MSG_MAX = 300;
const STACK_MAX = 1200;
const UA_MAX = 180;

/** key -> record, insertion-ordered, so the oldest key is the first one out. */
const faults = new Map();

const clean = (v, max) => String(v ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/** A stack keeps its newlines — it is unreadable as one line — but nothing else. */
const cleanStack = (v) => String(v ?? '')
  .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ')
  .split('\n').slice(0, 12).join('\n')
  .slice(0, STACK_MAX);

/**
 * Record one client-side fault.
 *
 * @param {object} f
 * @param {string} f.where    the RF.err() call site ('atlas:draw', 'action:sell')
 * @param {string} f.level    'warn' | 'error' | 'fatal'
 * @param {string} f.msg      the message
 * @param {string} [f.name]   the error's constructor name
 * @param {string} [f.stack]  a trimmed stack
 * @param {string} [f.build]  the client build the tab was running
 * @param {string} [f.ua]     user agent, taken from the REQUEST, never the body
 * @param {number|null} [f.userId]
 * @returns {object} the stored record
 */
export function add(f) {
  const where = clean(f.where, WHERE_MAX) || 'unknown';
  const msg = clean(f.msg, MSG_MAX);
  const level = ['warn', 'error', 'fatal'].includes(f.level) ? f.level : 'error';
  const key = `${level}|${where}|${msg}`;

  const now = Date.now();
  let rec = faults.get(key);
  if (rec) {
    /* Re-insert so a fault that is STILL happening is young again: the buffer
       should evict what stopped, not what is loudest right now. */
    faults.delete(key);
    rec.count++;
    rec.last = now;
    if (f.userId != null) rec.users.add(f.userId);
  } else {
    rec = {
      key, where, msg, level,
      name: clean(f.name, 60),
      stack: cleanStack(f.stack),
      build: clean(f.build, 24),
      ua: clean(f.ua, UA_MAX),
      first: now, last: now, count: 1,
      users: new Set(f.userId != null ? [f.userId] : []),
    };
  }
  faults.set(key, rec);

  while (faults.size > CAP) faults.delete(faults.keys().next().value);
  return rec;
}

/**
 * Most recently seen first. `users` becomes a count — the console needs to know
 * whether a fault hit one player or forty, never which ones.
 */
export function recent(limit = 100) {
  const out = [];
  /* Reverse insertion order, THEN a stable sort. add() re-inserts a fault it has
     seen again, so the map already runs oldest-touched to newest-touched — and
     several faults inside one millisecond carry the same `last`, which a sort on
     that field alone cannot separate. Walking backwards first means those ties
     come out newest-first instead of exactly upside down. */
  for (const rec of [...faults.values()].reverse()) {
    out.push({
      where: rec.where, msg: rec.msg, level: rec.level, name: rec.name,
      stack: rec.stack, build: rec.build, ua: rec.ua,
      first: rec.first, last: rec.last, count: rec.count, users: rec.users.size,
    });
  }
  out.sort((a, b) => b.last - a.last);
  return out.slice(0, Math.max(1, Math.min(500, limit | 0)));
}

/** Distinct faults held, and how many reports they represent. */
export function stats() {
  let reports = 0;
  for (const rec of faults.values()) reports += rec.count;
  return { faults: faults.size, reports, cap: CAP };
}

/** Tests boot many servers in one process image; each deserves a clean slate. */
export function reset() { faults.clear(); }
