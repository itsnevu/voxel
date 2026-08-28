/* ============================================================================
   06-content — the ship's papers. A persisted journal of everything that
   happens, an almanac of every species in every sea, and a board of personal
   bests. The isle used to forget a legendary catch the moment the toast faded;
   from here on it keeps the receipts.
   ========================================================================== */
RF.mod('06-content', function (RF) {
  'use strict';

  /* ------------------------------------------------------------------ keys */
  const KEY_M = '06-content', KEY_J = '06-content-journal';
  const RAW_J = 'rf-mod-' + KEY_J;   // RF.store's own slot — read to verify a write, never written raw
  const CAP = 1200;                  // ring buffer ceiling, pruned oldest-first
  const PAGE = 140;                  // rows per render page; 1200 nodes at once janks a 1024x640 window

  /* Playing with storage switched off is a supported way to play, so the
     no-localStorage case is silent. A storage that exists but is FULL is not
     silent: that one is a real failure and goes down the funnel. */
  let storageOK = true;
  try { localStorage.getItem(RAW_J); } catch (e) { storageOK = false; }
  let memOnly = !storageOK;

  /* ------------------------------------------------------------- utilities */
  const two = n => (n < 10 ? '0' : '') + n;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  const fmt = n => { try { return RF.fn.fmt(n); } catch (e) { return String(Math.round(n || 0)); } };
  const ico = (n, s) => { try { return (RF.PIX && RF.PIX[n]) ? RF.fn.pixSVG(n, s || 13) : ''; } catch (e) { return ''; } };
  const fishIco = (col, s) => { try { return RF.fn.pixFish(col, s || 15); } catch (e) { return ''; } };
  const rarCol = r => (RF.RAR && RF.RAR[r]) || 'var(--muted)';
  const wname = k => (RF.WORLDS && RF.WORLDS[k] && RF.WORLDS[k].name) || k || '—';
  const $ = id => document.getElementById(id);
  const hhmm = t => { const d = new Date(t); return two(d.getHours()) + ':' + two(d.getMinutes()); };
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLab(t) {
    const k = dayKey(t), n = Date.now();
    if (k === dayKey(n)) return 'Today';
    if (k === dayKey(n - 864e5)) return 'Yesterday';
    const d = new Date(t);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONS[d.getMonth()];
  }
  function dateLab(t) { if (!t) return '—'; const d = new Date(t); return d.getDate() + ' ' + MONS[d.getMonth()] + ' · ' + hhmm(t); }
  function dur(ms) {
    ms = Math.max(0, ms | 0); const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's';
  }
  const say = o => {
    try {
      if (RF.api && RF.api.notify) RF.api.notify(o);
      else RF.fn.toast(esc(o.title + (o.body ? ' · ' + o.body : '')), o.level === 'error' ? 'bad' : o.level === 'warn' ? '' : 'good');
    } catch (e) { /* a toast that cannot be shown must never break the caller */ }
  };
  const sfx = n => { try { if (RF.sfx && RF.sfx[n]) RF.sfx[n](); } catch (e) { } };

  /* -------------------------------------------------------- kinds of entry */
  const KIND = {
    catch:   { i: 'fish',   lab: 'Catch',   c: 'var(--teal)' },
    mined:   { i: 'ore',    lab: 'Mining',  c: '#9fb2ba' },
    chopped: { i: 'wood',   lab: 'Timber',  c: '#c69a63' },
    dug:     { i: 'map',    lab: 'Digging', c: 'var(--gold)' },
    sold:    { i: 'chart',  lab: 'Trade',   c: 'var(--gold)' },
    crafted: { i: 'pick',   lab: 'Craft',   c: 'var(--ink)' },
    share:   { i: 'chart',  lab: 'Shares',  c: '#74e08a' },
    spin:    { i: 'wheel',  lab: 'Wheel',   c: 'var(--rose)' },
    travel:  { i: 'boat',   lab: 'Voyage',  c: 'var(--teal)' },
    unlock:  { i: 'island', lab: 'Charter', c: 'var(--gold)' },
    weather: { i: 'rain',   lab: 'Sky',     c: 'var(--muted)' },
    pearls:  { i: 'gem',    lab: 'Pearls',  c: 'var(--teal)' },
    ach:     { i: 'trophy', lab: 'Feat',    c: 'var(--gold)' },
    record:  { i: 'trophy', lab: 'Record',  c: 'var(--gold)' },
    recap:   { i: 'boat',   lab: 'Log',     c: 'var(--ink)' },
    error:   { i: 'storm',  lab: 'Fault',   c: 'var(--rose)' }
  };
  const kmeta = k => KIND[k] || { i: 'gem', lab: k || '?', c: 'var(--muted)' };
  const FILTERS = [
    ['all', 'All', null],
    ['fish', 'Fishing', ['catch']],
    ['land', 'Land', ['mined', 'chopped', 'dug']],
    ['trade', 'Trade', ['sold', 'crafted', 'share']],
    ['luck', 'Fortune', ['spin', 'pearls', 'ach', 'record']],
    ['sea', 'Sea', ['travel', 'unlock', 'weather', 'recap']],
    ['fault', 'Faults', ['error']]
  ];

  /* ---------------------------------------------------------------- state  */
  let rows = [], jseq = 0, jDirty = false, mDirty = false, lastFlush = 0;
  try {
    const blob = RF.store.get(KEY_J, null);
    if (blob && Array.isArray(blob.r)) {
      jseq = blob.seq | 0;
      rows = blob.r.filter(e => e && typeof e === 'object' && typeof e.k === 'string' && +e.t > 0);
      if (rows.length > CAP) rows = rows.slice(rows.length - CAP);
    }
  } catch (e) { RF.err('06-content:load', e); }

  /* Panel state lives up here so the error handler registered below can call
     touch() safely even while this module is still evaluating. */
  let root = null, openT = false, tab = 'journal', page = 1, q = '', filt = 'all';
  let isle = 'all', ghostOnly = false, sel = '', reFocus = false;

  let meta = null;
  try { meta = RF.store.get(KEY_M, null); } catch (e) { meta = null; }
  if (!meta || typeof meta !== 'object') meta = {};
  if (typeof meta.dex !== 'object' || !meta.dex) meta.dex = {};
  if (typeof meta.rec !== 'object' || !meta.rec) meta.rec = {};
  if (typeof meta.leg !== 'object' || !meta.leg) meta.leg = {};
  if (typeof meta.life !== 'object' || !meta.life) meta.life = { sessions: 0, ms: 0 };
  meta.streak = meta.streak | 0; meta.seen = meta.seen | 0; meta.v = 1;

  /* --------------------------------------------------------- persistence  */
  /* RF.store.set swallows the quota throw by design, so the only honest way to
     know a 200 KB journal actually landed is to look at what is in the slot
     afterwards. On a full disk we halve the buffer once, then fall back to
     memory for the rest of the session rather than fighting the browser. */
  function verify(seq) {
    try { const raw = localStorage.getItem(RAW_J); return !!raw && raw.lastIndexOf('"seq":' + seq, 48) >= 0; }
    catch (e) { return false; }
  }
  function writeJournal() {
    if (memOnly) return false;
    RF.store.set(KEY_J, { v: 1, seq: ++jseq, r: rows });
    if (verify(jseq)) return true;
    rows = rows.slice(Math.floor(rows.length / 2));       // halve, retry once
    RF.store.set(KEY_J, { v: 1, seq: ++jseq, r: rows });
    if (verify(jseq)) {
      say({ level: 'warn', title: 'Journal trimmed', body: 'Storage was full · the oldest half of the log was let go', tag: 'rf-content-quota', ttl: 6000 });
      return true;
    }
    memOnly = true;
    RF.err('06-content:persist', new Error('journal storage full · this session is kept in memory only'), 'warn');
    return false;
  }
  function flush(force) {
    const t = Date.now();
    if (!force && t - lastFlush < 4000) return;
    lastFlush = t;
    try {
      if (jDirty) { jDirty = false; writeJournal(); }
      if (mDirty) { mDirty = false; if (!memOnly) RF.store.set(KEY_M, meta); }
    } catch (e) { RF.err('06-content:flush', e); }
  }

  /* -------------------------------------------------------------- logging */
  function log(kind, summary, payload) {
    try {
      const e = { t: Date.now(), w: RF.worldKey, k: String(kind || 'record'), s: String(summary || ''), p: payload || null };
      const last = rows[rows.length - 1];
      /* pearls land on every catch and every ore, and a broken hook faults in
         bursts — folding those into the line above keeps a day readable. */
      if (last && last.k === e.k && e.t - last.t < 90000) {
        if (e.k === 'pearls' && last.p && e.p && last.p.why === e.p.why) {
          last.p.n += e.p.n; last.t = e.t;
          last.s = '+' + last.p.n + ' pearls' + (last.p.why ? ' · ' + last.p.why : '');
          jDirty = true; touch(); return last;
        }
        if (e.k === 'error' && last.p && e.p && last.p.where === e.p.where) {
          last.p.n = (last.p.n | 0) + 1; last.t = e.t;
          last.s = e.s + ' · x' + last.p.n;
          jDirty = true; touch(); return last;
        }
      }
      rows.push(e);
      if (rows.length > CAP) rows.splice(0, rows.length - CAP);
      jDirty = true; touch();
      return e;
    } catch (err) { RF.err('06-content:log', err); return null; }
  }
  let needRender = false;
  const touch = () => { if (openT && tab === 'journal') needRender = true; };

  /* ------------------------------------------------------- species master */
  /* ALL_FISH is the engine's unique-by-name roll-up and carries no isle, so the
     per-world tables are the real source and ALL_FISH is only the safety net. */
  function speciesList() {
    const out = [], seen = Object.create(null);
    const push = (e, wk) => {
      if (!e || !e[0] || typeof e[0].name !== 'string') return;
      const t = e[0]; let sp = seen[t.name];
      if (!sp) { sp = seen[t.name] = { name: t.name, rar: t.rar || 'common', val: +t.val || 0, cond: e[2] || '', isles: [] }; out.push(sp); }
      if (wk && sp.isles.indexOf(wk) < 0) sp.isles.push(wk);
      if (!sp.cond && e[2]) sp.cond = e[2];
    };
    const W = RF.WORLDS || {};
    for (const k in W) { const f = W[k] && W[k].fish; if (Array.isArray(f)) for (let i = 0; i < f.length; i++) push(f[i], k); }
    if (Array.isArray(RF.ALL_FISH)) for (let i = 0; i < RF.ALL_FISH.length; i++) push(RF.ALL_FISH[i], null);
    if (!out.length && Array.isArray(RF.TABLE)) for (let i = 0; i < RF.TABLE.length; i++) push(RF.TABLE[i], 'isle');
    const RO = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
    out.sort((a, b) => (RO[a.rar] - RO[b.rar]) || (a.val - b.val) || (a.name < b.name ? -1 : 1));
    return out;
  }
  const SPECIES = speciesList();
  const SPBY = Object.create(null); for (const s of SPECIES) SPBY[s.name] = s;
  const ISLES = (function () {
    const seen = [], W = RF.WORLDS || {};
    const order = Array.isArray(RF.WORLD_ORDER) ? RF.WORLD_ORDER.slice() : [];
    for (const k of order) if (W[k] && Array.isArray(W[k].fish)) seen.push(k);
    for (const k in W) if (W[k] && Array.isArray(W[k].fish) && seen.indexOf(k) < 0) seen.push(k);
    return seen;
  })();
  const CONDT = { night: 'only after dark', rain: 'only in rain or storm', storm: 'only in a storm' };
  const CONDI = { night: 'moon', rain: 'rain', storm: 'storm' };
  const dexBase = n => (RF.state && RF.state.dex && RF.state.dex[n]) || null;
  const dexMine = n => meta.dex[n] || null;
  function caughtN(n) { const a = dexBase(n), b = dexMine(n); return Math.max(a ? a.n | 0 : 0, b ? b.n | 0 : 0); }
  function bestKg(n) { const a = dexBase(n), b = dexMine(n); return Math.max(a ? +a.best || 0 : 0, b ? +b.best || 0 : 0); }
  const known = k => k === RF.worldKey || !!(RF.state && Array.isArray(RF.state.worlds) && RF.state.worlds.indexOf(k) >= 0);
  const plain = n => String(n || '').replace('✨ ', '').replace('✦ ', '');   // shiny prefixes are cosmetic
  const an = n => (/^[aeiou]/i.test(String(n || '').replace(/^[^A-Za-z]+/, '')) ? 'an ' : 'a ');

  /* --------------------------------------------------------- the records  */
  const RECS = [
    ['heavy',  'Heaviest fish',            'trophy', r => r.v + ' kg'],
    ['rich',   'Most valuable fish',       'fish',   r => '◈ ' + fmt(r.v)],
    ['sale',   'Richest single sale',      'chart',  r => '◈ ' + fmt(r.v)],
    ['vein',   'Longest ore vein',         'pick',   r => 'x' + r.v],
    ['win',    'Biggest wheel win',        'wheel',  r => '◈ ' + fmt(r.v)],
    ['streak', 'Longest win streak',       'wheel',  r => r.v + ' in a row'],
    ['caught', 'Most landed in a session', 'bucket', r => fmt(r.v) + ' fish'],
    ['sess',   'Longest session',          'boat',   r => dur(r.v)],
    ['dex',    'Deepest almanac',          'island', r => r.v + ' / ' + SPECIES.length]
  ];
  const RECBY = Object.create(null); for (const r of RECS) RECBY[r[0]] = r;
  function bump(key, v, note, quiet) {
    v = +v; if (!isFinite(v) || v <= 0) return false;
    const cur = meta.rec[key], had = cur && +cur.v > 0;
    if (had && v <= +cur.v) return false;
    meta.rec[key] = { v: v, n: note || '', t: Date.now(), w: RF.worldKey };
    mDirty = true;
    if (had && !quiet) celebrate(key, meta.rec[key]);
    return true;
  }
  function celebrate(key, rec) {
    const def = RECBY[key]; if (!def) return;
    const val = def[3](rec);
    say({ level: 'good', title: 'New record · ' + def[1], body: val + (rec.n ? ' · ' + rec.n : ''), tag: 'rf-content-rec-' + key, ttl: 5200 });
    log('record', def[1] + ' · ' + val + (rec.n ? ' · ' + rec.n : ''), { key: key, v: rec.v });
    if (RF.api && RF.api.renown) { try { RF.api.renown.add(20, 'record · ' + def[1]); } catch (e) { } }
  }

  /* ------------------------------------------------------- the session   */
  const ses = {
    t0: Date.now(), play: 0, dist: 0, caught: 0, rar: {}, best: null,
    ore: 0, oreBy: {}, wood: 0, spins: 0, spinNet: 0, sold: 0, pearls: 0,
    species: {}, earned0: null
  };
  const earnedNow = () => { try { return +RF.state.stats.earned || 0; } catch (e) { return 0; } };
  const sesEarned = () => Math.max(0, earnedNow() - (ses.earned0 == null ? earnedNow() : ses.earned0));

  /* Distance comes off pWorld between frames — one sqrt, no allocation. A jump
     bigger than a couple of tiles is a respawn or a cave mouth, not a walk. */
  let lx = null, lz = null;
  RF.on('frame', dt => {
    const p = RF.pWorld; if (!p) return;
    if (lx === null) { lx = p.x; lz = p.z; return; }
    const dx = p.x - lx, dz = p.z - lz; lx = p.x; lz = p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 4e-6 && d2 < 4) ses.dist += Math.sqrt(d2);
    if (RF.running) ses.play += dt > 0.2 ? 0.2 : dt;
  });

  function recap() {
    const rarN = ses.rar, sp = Object.keys(ses.species).length;
    return {
      t0: ses.t0, ms: Math.round(ses.play * 1000), earned: sesEarned(), caught: ses.caught,
      rar: rarN, best: ses.best, ore: ses.ore, oreBy: ses.oreBy, wood: ses.wood,
      spins: ses.spins, spinNet: Math.round(ses.spinNet), dist: Math.round(ses.dist),
      pearls: ses.pearls, sold: ses.sold, species: sp, world: RF.worldKey
    };
  }
  function recapLine(r) {
    const bits = [dur(r.ms), r.caught + ' landed', '◈ ' + fmt(r.earned)];
    if (r.ore) bits.push(r.ore + ' ore');
    if (r.spins) bits.push(r.spins + ' spins ' + (r.spinNet >= 0 ? '+' : '−') + '◈' + fmt(Math.abs(r.spinNet)));
    return bits.join(' · ');
  }
  let sesClosed = false;
  function closeSession(why) {
    const r = recap();
    if (sesClosed) return r;                            // travel already reloads into pagehide
    if (r.ms < 20000 && !r.caught && !r.ore) return r;   // a glance at the title screen is not a session
    sesClosed = true;
    bump('sess', r.ms, why || 'session', true);
    bump('caught', r.caught, 'in one session', true);
    log('recap', 'Session closed · ' + recapLine(r), { g: 0, r: r });
    meta.life.sessions = (meta.life.sessions | 0) + 1;
    meta.life.ms = (meta.life.ms | 0) + r.ms;
    mDirty = true; flush(true);
    return r;
  }

  /* ============================== EVENT WIRING ============================ */
  RF.on('start', () => {
    ses.t0 = Date.now(); ses.earned0 = earnedNow();
    if (!meta.seen) {
      meta.seen = 1; mDirty = true;
      say({ level: 'info', title: 'The ship’s journal is open', body: 'Press J for the log, the almanac and your records', tag: 'rf-content-intro', ttl: 7000 });
    }
  });

  RF.on('catch', (f, info) => {
    if (!f) return;
    const name = plain(f.name), kg = +f.kg || 0, val = +f.val || 0, sp = SPBY[name];
    ses.caught++; ses.rar[f.rar] = (ses.rar[f.rar] | 0) + 1; ses.species[name] = 1;
    if (!ses.best || val > (ses.best.val || 0)) ses.best = { name: f.name, val: val, kg: kg, rar: f.rar };
    // the almanac keeps what the engine's dex does not: dates and a weight spread
    const d = meta.dex[name] || (meta.dex[name] = { n: 0, best: 0, first: 0, last: 0, h: null });
    d.n++; d.last = Date.now(); if (!d.first) d.first = d.last;
    if (kg > (d.best || 0)) d.best = kg;
    if (sp && sp.val > 0) {
      const lo = sp.val / 9 * 0.5 + 0.2, hi = sp.val / 9 * 1.6 + 0.2, span = Math.max(0.01, hi - lo);
      let b = Math.floor((kg - lo) / span * 12); b = b < 0 ? 0 : b > 11 ? 11 : b;
      if (!Array.isArray(d.h) || d.h.length !== 12) d.h = [0,0,0,0,0,0,0,0,0,0,0,0];
      if (d.h[b] < 65000) d.h[b]++;
    }
    mDirty = true;
    if (f.rar === 'legendary' && !meta.leg[name]) {
      meta.leg[name] = Date.now();
      say({ level: 'good', title: 'First ' + name, body: 'The almanac has a new legend · ' + kg + ' kg', tag: 'rf-content-leg', ttl: 5600 });
      if (RF.api && RF.api.renown) { try { RF.api.renown.add(40, 'first ' + name); } catch (e) { } }
    }
    bump('heavy', kg, name);
    bump('rich', val, name);
    bump('caught', ses.caught, 'in one session', true);
    bump('dex', Object.keys(RF.state && RF.state.dex ? RF.state.dex : meta.dex).length, 'species', true);
    const tags = [];
    if (info && info.isNew) tags.push('new species');
    if (info && info.isRec) tags.push('personal best');
    if (info && info.auto) tags.push('auto-rig');
    log('catch', 'Landed ' + an(f.name) + f.name + ' · ' + kg + ' kg · ◈' + fmt(val) + (tags.length ? ' · ' + tags.join(' · ') : ''),
      { name: name, rar: f.rar, kg: kg, val: val, isNew: !!(info && info.isNew) });
  });

  RF.on('mined', d => {
    if (!d) return;
    const got = d.got | 0, oi = RF.ORE_INFO && RF.ORE_INFO[d.type], on = oi ? oi.name : d.type;
    ses.ore += got; ses.oreBy[d.type] = (ses.oreBy[d.type] | 0) + got;
    if ((d.combo | 0) > 1) bump('vein', d.combo | 0, on + ' vein');
    log('mined', 'Broke ' + an(on) + on + ' node · +' + got + (d.geode ? ' · geode!' : '') + ((d.combo | 0) > 1 ? ' · vein x' + d.combo : ''),
      { type: d.type, n: got, geode: !!d.geode, combo: d.combo | 0 });
  });

  RF.on('chopped', d => {
    const got = (d && d.got) | 0; ses.wood += got;
    log('chopped', 'Felled a tree · +' + got + ' wood', { n: got });
  });

  RF.on('dug', () => log('dug', 'Dug up the X · the bottle told the truth', null));

  RF.on('sold', d => {
    if (!d) return;
    const g = d.gained | 0; ses.sold += g;
    let s;
    if (d.kind === 'allfish') s = 'Sold the bucket · +◈' + fmt(g) + (d.kept ? ' · kept ' + d.kept + ' starred' : '');
    else if (d.kind === 'fish') { const fn = (d.fish && d.fish.name) || 'fish'; s = 'Sold ' + an(fn) + fn + ' · +◈' + fmt(g); }
    else {
      const oi = RF.ORE_INFO && RF.ORE_INFO[d.oreKey];
      s = 'Sold ' + (d.count | 0) + ' ' + (oi ? oi.name : d.oreKey) + ' · +◈' + fmt(g) + (d.bulk > 1 ? ' · bulk +' + Math.round((d.bulk - 1) * 100) + '%' : '');
    }
    bump('sale', g, d.kind === 'ore' ? ((RF.ORE_INFO && RF.ORE_INFO[d.oreKey] ? RF.ORE_INFO[d.oreKey].name : d.oreKey) + ' haul') : 'at the Trader');
    log('sold', s, { g: g, kind: d.kind });
  });

  RF.on('crafted', d => {
    if (!d) return;
    log('crafted', 'Forged the ' + (d.name || d.tool) + ' · ◈' + fmt(d.cost || 0), { tool: d.tool, lvl: d.lvl | 0 });
  });

  RF.on('share', d => {
    if (!d) return;
    log('share', 'Certificate · 1 ' + d.ticker + ' at ◈' + fmt(d.price) + ' · ' + (d.owned | 0) + ' held', { ticker: d.ticker, price: d.price | 0 });
  });

  RF.on('spin', d => {
    if (!d) return;
    ses.spins++;
    const mult = d.bet === 'green' ? 14 : 2;
    let net = 0, what;
    if (d.fish) {
      // the staked fish is mutated in place before the event fires, so the win
      // is what it is now minus what it must have been before the multiplier
      const v = +d.fish.val || 0;
      net = d.won ? Math.round(v - v / mult) : -v;
      what = 'your ' + d.fish.name;
    } else {
      const c = d.coins | 0;
      net = d.won ? (d.server ? (d.payout | 0) - c : c * (mult - 1)) : -c;
      what = '◈' + fmt(c);
    }
    ses.spinNet += net;
    if (d.won) {
      meta.streak = (meta.streak | 0) + 1; mDirty = true;
      if (meta.streak >= 2) bump('streak', meta.streak, 'on the wheel');
      bump('win', net, d.bet + ' paid ' + mult + 'x');
    } else if (meta.streak) { meta.streak = 0; mDirty = true; }
    log('spin', d.won
      ? 'The wheel paid ' + d.bet + ' · ' + what + ' · +◈' + fmt(net)
      : 'The eel swallowed ' + what + '. Gone.',
      { g: net, bet: d.bet, won: !!d.won, pocket: d.pocket | 0 });
  });

  RF.on('travel', d => {
    const from = (d && d.from) || RF.worldKey, to = d && d.to;
    log('travel', 'Set sail · ' + wname(from) + ' → ' + wname(to), { from: from, to: to });
    // the page reloads a beat from now — this is the natural chapter break
    const r = closeSession('sailed to ' + wname(to));
    say({ level: 'info', title: 'Session log · ' + dur(r.ms), body: recapLine(r) + ' · ' + r.dist + ' m walked', tag: 'rf-content-recap', ttl: 9000 });
    close();
  });

  RF.on('unlock', d => {
    if (!d) return;
    log('unlock', 'Chartered ' + wname(d.world) + ' · ◈' + fmt(d.cost || 0), { world: d.world });
  });

  RF.on('weather', (next, prev) => {
    const words = { clear: 'the skies cleared', rain: 'rain came in', storm: 'a storm broke', snow: 'snow began to fall', ash: 'ash began to fall' };
    log('weather', (words[next] || ('the sky turned ' + next)) + ' over ' + wname(RF.worldKey), { w: next, prev: prev || '' });
  });

  RF.on('pearls', (n, why) => {
    n = n | 0; if (n <= 0) return; ses.pearls += n;
    log('pearls', '+' + n + ' pearls' + (why ? ' · ' + why : ''), { n: n, why: why || '' });
  });

  RF.on('ach', (id, name, reward) => {
    log('ach', (name || id) + ' · +◈' + fmt(reward || 0), { g: reward | 0, id: id });
  });

  RF.on('error', rec => {
    if (!rec) return;
    // faults from this mod are already funnelled; logging them here would loop
    if (String(rec.where || '').indexOf('06-content') === 0) return;
    log('error', 'Fault in ' + rec.where + ' · ' + rec.msg, { where: rec.where, lvl: rec.level, n: 1 });
  });

  RF.on('panel', (name, isOpen) => { if (isOpen) close(); });

  RF.every(4, () => flush(false));
  RF.every(30, () => bump('sess', Math.round(ses.play * 1000), 'session', true));
  RF.every(0.5, () => {
    if (!needRender || !openT || tab !== 'journal') return;
    const a = document.activeElement;
    if (a && a.id === 'rf-content-q') return;           // never yank the caret out mid-search
    needRender = false; renderLog();
  });
  addEventListener('pagehide', () => { try { closeSession('window closed'); } catch (e) { } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); });

  /* ================================ EXPORT =============================== */
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = (head, body) => [head.map(cell).join(',')].concat(body.map(r => r.map(cell).join(','))).join('\r\n');
  function expJournal(as) {
    const src = rows.slice().reverse();
    if (as === 'json') return JSON.stringify(src.map(e => ({
      time: new Date(e.t).toISOString(), world: wname(e.w), kind: e.k, icon: kmeta(e.k).i, summary: e.s, payload: e.p || null
    })), null, 1);
    return csv(['time', 'world', 'kind', 'icon', 'summary', 'payload'],
      src.map(e => [new Date(e.t).toISOString(), wname(e.w), e.k, kmeta(e.k).i, e.s, e.p ? JSON.stringify(e.p) : '']));
  }
  function expAlmanac(as) {
    const src = SPECIES.map(sp => {
      const d = dexMine(sp.name) || {};
      return {
        species: sp.name, rarity: sp.rar, base_value: sp.val,
        isles: sp.isles.map(wname).join(' / '), condition: sp.cond ? CONDT[sp.cond] || sp.cond : 'any weather, any hour',
        caught: caughtN(sp.name), best_kg: bestKg(sp.name) || '',
        first: d.first ? new Date(d.first).toISOString() : '', last: d.last ? new Date(d.last).toISOString() : ''
      };
    });
    if (as === 'json') return JSON.stringify(src, null, 1);
    const head = ['species', 'rarity', 'base_value', 'isles', 'condition', 'caught', 'best_kg', 'first', 'last'];
    return csv(head, src.map(o => head.map(k => o[k])));
  }
  function expRecords(as) {
    const src = [];
    for (const [key, label, , show] of RECS) {
      const r = meta.rec[key];
      src.push({ record: label, value: r && r.v ? show(r) : '', detail: (r && r.n) || '', isle: r ? wname(r.w) : '', set: r && r.t ? new Date(r.t).toISOString() : '' });
    }
    for (const n in meta.leg) src.push({ record: 'First ' + n, value: 'legendary', detail: '', isle: '', set: new Date(meta.leg[n]).toISOString() });
    if (as === 'json') return JSON.stringify(src, null, 1);
    const head = ['record', 'value', 'detail', 'isle', 'set'];
    return csv(head, src.map(o => head.map(k => o[k])));
  }
  function expRecap(as) {
    const r = recap();
    const flat = {
      started: new Date(r.t0).toISOString(), played: dur(r.ms), coins_earned: r.earned, fish_landed: r.caught,
      species_seen: r.species, best_catch: r.best ? r.best.name + ' · ' + r.best.kg + ' kg' : '',
      ore_mined: r.ore, wood: r.wood, spins: r.spins, spin_net: r.spinNet, metres_walked: r.dist, pearls: r.pearls, isle: wname(r.world)
    };
    if (as === 'json') return JSON.stringify(flat, null, 1);
    const head = Object.keys(flat);
    return csv(head, [head.map(k => flat[k])]);
  }
  function copyOut(text, what) {
    const done = ok => {
      if (ok) { say({ level: 'good', title: 'Copied · ' + what, body: fmt(text.length) + ' characters on the clipboard', tag: 'rf-content-copy', ttl: 3600 }); return; }
      // file:// often has no clipboard at all, and a download link is blocked —
      // so the last resort is putting the text on screen to select by hand
      const d = $('rf-content-drawer'), ta = $('rf-content-out');
      if (d && ta) { d.style.display = 'block'; ta.value = text; ta.focus(); ta.select(); }
      say({ level: 'warn', title: 'Clipboard blocked', body: 'The text is in the drawer below · select and copy it by hand', tag: 'rf-content-copy', ttl: 6000 });
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), () => fallbackCopy(text, done));
        return;
      }
    } catch (e) { }
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-3000px;top:0;opacity:0;';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove(); done(!!ok);
    } catch (e) { RF.err('06-content:copy', e); done(false); }
  }

  /* ================================= LOOK ================================ */
  RF.css(`
#rf-content{position:fixed;inset:0;z-index:26;display:none;align-items:center;justify-content:center;
  background:radial-gradient(130% 100% at 50% -10%,rgba(14,26,32,.4),rgba(3,8,10,.66));
  backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);}
#rf-content.on{display:flex;}
body.photo #rf-content{display:none!important;}
#rf-content .rf-content-cd{width:min(920px,96vw);max-height:88vh;display:flex;flex-direction:column;
  font-size:calc(13px * var(--rf-ui-scale,1));
  background:var(--glass-sheen),var(--glass-strong);
  backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
  border:1px solid var(--glass-bd);border-radius:1.15em;padding:1.15em 1.25em 0.9em;
  box-shadow:var(--glass-hi),0 30px 80px rgba(0,0,0,.5);animation:rf-content-in .28s cubic-bezier(.2,.8,.2,1);}
@keyframes rf-content-in{from{opacity:0;transform:translateY(14px) scale(.985);}to{opacity:1;transform:none;}}
body.rf-reduced #rf-content .rf-content-cd{animation:none;}
body.rf-reduced #rf-content *{transition:none!important;}
#rf-content .rf-content-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:1em;}
#rf-content .rf-content-eye{font-size:.66em;letter-spacing:.34em;color:var(--teal);text-transform:uppercase;}
#rf-content h2{font-family:"Chakra Petch",sans-serif;font-size:1.75em;color:var(--ink);line-height:1.1;}
#rf-content .rf-content-sub{font-size:.8em;color:var(--faint);margin-top:.15em;}
#rf-content .rf-content-tabs{display:flex;gap:.5em;margin:.85em 0 .55em;}
#rf-content .tabbtn{font-size:.85em;padding:.6em 0;}
#rf-content .rf-content-body{overflow-y:auto;overflow-x:hidden;flex:1;min-height:6em;padding-right:.2em;}
#rf-content .rf-content-body::-webkit-scrollbar{width:8px;}
#rf-content .rf-content-body::-webkit-scrollbar-thumb{background:var(--glass-bd);border-radius:4px;}
#rf-content .rf-content-tools{display:flex;gap:.5em;align-items:center;flex-wrap:wrap;margin-bottom:.6em;}
#rf-content input[type=text]{flex:1 1 11em;min-width:8em;font-family:"IBM Plex Mono",monospace;font-size:.86em;color:var(--ink);
  background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:.62em;padding:.55em .75em;outline:none;}
#rf-content input[type=text]:focus{border-color:rgba(57,215,196,.6);}
#rf-content .rf-content-chip{font-family:"IBM Plex Mono",monospace;font-size:.75em;letter-spacing:.06em;color:var(--muted);cursor:pointer;
  background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:.7em;padding:.45em .7em;
  transition:color .12s,border-color .12s;}
#rf-content .rf-content-chip:hover{color:var(--ink);border-color:var(--glass-bd);}
#rf-content .rf-content-chip.sel{color:var(--teal);border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.25);}
#rf-content .rf-content-day{position:sticky;top:0;z-index:1;display:flex;align-items:baseline;gap:.7em;flex-wrap:wrap;
  margin:.9em 0 .45em;padding:.4em .6em;border-radius:.6em;
  background:rgba(10,20,26,.86);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  border:1px solid var(--glass-bd-soft);}
#rf-content .rf-content-day b{font-family:"Chakra Petch",sans-serif;font-size:.92em;color:var(--ink);letter-spacing:.04em;}
#rf-content .rf-content-day span{font-size:.72em;color:var(--muted);font-variant-numeric:tabular-nums;}
#rf-content .rf-content-day span i{font-style:normal;color:var(--gold);}
#rf-content .rf-content-row{display:flex;align-items:center;gap:.7em;padding:.42em .65em;border-radius:.55em;
  border:1px solid transparent;font-size:.86em;line-height:1.4;}
#rf-content .rf-content-row:nth-child(odd){background:rgba(255,255,255,.035);}
#rf-content .rf-content-row:hover{border-color:var(--glass-bd-soft);background:var(--glass-row);}
#rf-content .rf-content-row .rf-content-tm{color:var(--faint);font-variant-numeric:tabular-nums;font-size:.86em;flex:0 0 auto;}
#rf-content .rf-content-row .rf-content-tx{flex:1;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#rf-content .rf-content-row .rf-content-wd{flex:0 0 auto;font-size:.76em;color:var(--faint);letter-spacing:.04em;}
#rf-content .rf-content-row .pix{flex:0 0 auto;vertical-align:-2px;}
#rf-content .rf-content-more{width:100%;margin:.8em 0 .3em;}
#rf-content .rf-content-mrow{display:flex;align-items:center;gap:.7em;margin-bottom:.4em;font-size:.82em;}
#rf-content .rf-content-mrow .rf-content-mn{flex:0 0 8.5em;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#rf-content .rf-content-bar{flex:1;height:.62em;border-radius:.31em;background:rgba(255,255,255,.07);overflow:hidden;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
#rf-content .rf-content-bar i{display:block;height:100%;border-radius:.31em;background:linear-gradient(90deg,#2cc4b2,var(--teal));}
#rf-content .rf-content-bar.gold i{background:linear-gradient(90deg,#c8963c,var(--gold));}
#rf-content .rf-content-mrow b{flex:0 0 4.6em;text-align:right;font-family:"Chakra Petch",sans-serif;color:var(--ink);
  font-variant-numeric:tabular-nums;font-size:.95em;}
#rf-content .rf-content-grid{display:flex;flex-wrap:wrap;gap:.5em;}
#rf-content .rf-content-sp{flex:0 0 calc(25% - .375em);min-width:9.5em;display:flex;align-items:center;gap:.5em;text-align:left;
  background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:.7em;padding:.5em .6em;cursor:pointer;
  color:var(--ink);font-family:inherit;font-size:.82em;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);
  transition:border-color .12s,transform .08s;}
#rf-content .rf-content-sp:hover{border-color:var(--glass-bd);transform:translateY(-1px);}
#rf-content .rf-content-sp.sel{border-color:rgba(57,215,196,.7);box-shadow:inset 0 0 0 1px rgba(57,215,196,.3);}
#rf-content .rf-content-sp.ghost{opacity:.45;}
#rf-content .rf-content-sp .rf-content-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#rf-content .rf-content-sp .rf-content-ct{font-family:"Chakra Petch",sans-serif;color:var(--teal);font-variant-numeric:tabular-nums;font-size:.94em;}
#rf-content .rf-content-sp.ghost .rf-content-ct{color:var(--faint);}
#rf-content .rf-content-det{background:var(--glass-sheen),var(--glass-row);border:1px solid var(--glass-bd);border-radius:.85em;
  padding:.85em 1em;margin-bottom:.7em;display:flex;gap:1em;flex-wrap:wrap;align-items:flex-start;}
#rf-content .rf-content-det .rf-content-dl{flex:1 1 15em;min-width:13em;}
#rf-content .rf-content-det h3{font-family:"Chakra Petch",sans-serif;font-size:1.15em;color:var(--ink);display:flex;align-items:center;gap:.4em;}
#rf-content .rf-content-det .rf-content-rr{font-size:.68em;letter-spacing:.18em;text-transform:uppercase;}
#rf-content .rf-content-kv{display:flex;justify-content:space-between;gap:.8em;padding:.3em 0;font-size:.8em;color:var(--muted);
  border-top:1px solid var(--glass-bd-soft);}
#rf-content .rf-content-kv b{color:var(--ink);font-weight:600;text-align:right;font-variant-numeric:tabular-nums;}
#rf-content .rf-content-sparkwrap{flex:0 0 auto;text-align:center;}
#rf-content .rf-content-sparkwrap small{display:block;font-size:.66em;letter-spacing:.14em;color:var(--faint);margin-top:.25em;text-transform:uppercase;}
#rf-content canvas.spark{border:1px solid var(--glass-bd-soft);}
#rf-content .rf-content-rec{display:flex;align-items:center;gap:.75em;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
  border-radius:.7em;padding:.55em .8em;margin-bottom:.4em;font-size:.86em;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
#rf-content .rf-content-rec.none{opacity:.45;}
#rf-content .rf-content-rec .rf-content-rl{flex:1;color:var(--ink);}
#rf-content .rf-content-rec .rf-content-rl small{display:block;font-size:.78em;color:var(--faint);}
#rf-content .rf-content-rec .rf-content-rv{font-family:"Chakra Petch",sans-serif;font-weight:700;color:var(--gold);
  font-variant-numeric:tabular-nums;text-align:right;}
#rf-content .rf-content-rec .rf-content-rv small{display:block;font-family:"IBM Plex Mono",monospace;font-weight:400;font-size:.68em;color:var(--faint);}
#rf-content .rf-content-cards{display:flex;flex-wrap:wrap;gap:.5em;margin-bottom:.7em;}
#rf-content .rf-content-fig{flex:1 1 7.5em;background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:.7em;padding:.6em .75em;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
#rf-content .rf-content-fig .rf-content-fk{font-size:.66em;letter-spacing:.2em;color:var(--faint);text-transform:uppercase;}
#rf-content .rf-content-fig .rf-content-fv{font-family:"Chakra Petch",sans-serif;font-size:1.25em;color:var(--ink);font-variant-numeric:tabular-nums;}
#rf-content .rf-content-fig .rf-content-fv.gold{color:var(--gold);}
#rf-content .rf-content-fig .rf-content-fv.teal{color:var(--teal);}
#rf-content .rf-content-pips{display:flex;gap:.35em;flex-wrap:wrap;margin-top:.15em;}
#rf-content .rf-content-pip{display:flex;align-items:center;gap:.25em;font-size:.72em;color:var(--muted);font-variant-numeric:tabular-nums;}
#rf-content .rf-content-pip i{width:.55em;height:.55em;border-radius:50%;box-shadow:0 0 5px currentColor;}
#rf-content .rf-content-ft{display:flex;align-items:center;gap:.5em;flex-wrap:wrap;margin-top:.7em;padding-top:.6em;
  border-top:1px solid var(--glass-bd-soft);}
#rf-content .rf-content-ft .rf-content-note{flex:1;font-size:.7em;color:var(--faint);letter-spacing:.05em;min-width:9em;}
#rf-content .rf-content-ft .btn{padding:.5em .8em;font-size:.8em;}
#rf-content .rf-content-drawer{display:none;margin-top:.6em;}
#rf-content .rf-content-drawer textarea{width:100%;height:7em;font-family:"IBM Plex Mono",monospace;font-size:.7em;color:var(--ink);
  background:rgba(0,0,0,.35);border:1px solid var(--glass-bd-soft);border-radius:.6em;padding:.6em;resize:vertical;user-select:text;}
#rf-content .empty{font-size:.9em;}
@media (max-width:760px){#rf-content .rf-content-sp{flex:0 0 calc(50% - .25em);}}
`, 'rf-content-css');

  /* ================================== UI ================================= */
  const TABS = [['journal', 'JOURNAL'], ['almanac', 'ALMANAC'], ['records', 'RECORDS'], ['recap', 'SESSION']];

  function build() {
    root = RF.el('<div id="rf-content" role="dialog" aria-label="Ship\'s papers"></div>');
    if (!root) return null;
    root.innerHTML =
      '<div class="rf-content-cd">' +
        '<div class="rf-content-hd">' +
          '<div><div class="rf-content-eye">Ship’s papers</div>' +
          '<h2 id="rf-content-title">Journal</h2>' +
          '<div class="rf-content-sub" id="rf-content-sub"></div></div>' +
          '<button class="x" id="rf-content-x" type="button">ESC</button>' +
        '</div>' +
        '<div class="rf-content-tabs" id="rf-content-tabs"></div>' +
        '<div class="rf-content-body" id="rf-content-pane"></div>' +
        '<div class="rf-content-ft">' +
          '<span class="rf-content-note" id="rf-content-note"></span>' +
          '<button class="btn" id="rf-content-csv" type="button">COPY CSV</button>' +
          '<button class="btn" id="rf-content-json" type="button">COPY JSON</button>' +
        '</div>' +
        '<div class="rf-content-drawer" id="rf-content-drawer"><textarea id="rf-content-out" readonly></textarea></div>' +
      '</div>';
    const x = $('rf-content-x'); if (x) x.onclick = close;
    root.addEventListener('click', e => { if (e.target === root) close(); });
    const tb = $('rf-content-tabs');
    if (tb) {
      tb.innerHTML = TABS.map(t => '<button class="tabbtn" type="button" data-rf-tab="' + t[0] + '">' + t[1] + '</button>').join('');
      tb.addEventListener('click', e => {
        const b = e.target.closest ? e.target.closest('[data-rf-tab]') : null; if (!b) return;
        tab = b.getAttribute('data-rf-tab'); page = 1; sfx('tab'); render();
      });
    }
    const pane = $('rf-content-pane');
    if (pane) {
      pane.addEventListener('click', onPaneClick);
      pane.addEventListener('input', e => {
        if (e.target && e.target.id === 'rf-content-q') { q = e.target.value.toLowerCase(); page = 1; reFocus = true; renderLog(); }
      });
    }
    const bc = $('rf-content-csv'), bj = $('rf-content-json');
    if (bc) bc.onclick = () => doExport('csv');
    if (bj) bj.onclick = () => doExport('json');
    return root;
  }

  function doExport(as) {
    try {
      const map = { journal: [expJournal, 'the journal'], almanac: [expAlmanac, 'the almanac'], records: [expRecords, 'the records'], recap: [expRecap, 'the session'] };
      const m = map[tab] || map.journal;
      copyOut(m[0](as), m[1] + ' · ' + as.toUpperCase());
      sfx('click');
    } catch (e) { RF.err('06-content:export', e); }
  }

  function onPaneClick(e) {
    const t = e.target; if (!t || !t.closest) return;
    const f = t.closest('[data-rf-filt]');
    if (f) { filt = f.getAttribute('data-rf-filt'); page = 1; sfx('click'); renderLog(); return; }
    const more = t.closest('[data-rf-more]');
    if (more) { page++; sfx('click'); renderLog(); return; }
    const il = t.closest('[data-rf-isle]');
    if (il) { isle = il.getAttribute('data-rf-isle'); sfx('click'); renderAlmanac(); return; }
    const gh = t.closest('[data-rf-ghost]');
    if (gh) { ghostOnly = !ghostOnly; sfx('click'); renderAlmanac(); return; }
    const sp = t.closest('[data-rf-sp]');
    if (sp) { const n = sp.getAttribute('data-rf-sp'); sel = (sel === n ? '' : n); sfx('click'); renderAlmanac(); return; }
    const wr = t.closest('[data-rf-write]');
    if (wr) {
      const r = recap();
      log('recap', 'Log entry · ' + recapLine(r), { g: 0, r: r });
      flush(true); sfx('click');
      say({ level: 'good', title: 'Written to the journal', body: recapLine(r), tag: 'rf-content-recap', ttl: 4200 });
      return;
    }
  }

  function render() {
    if (!root) return;
    const tb = $('rf-content-tabs');
    if (tb) for (const b of tb.querySelectorAll('[data-rf-tab]')) b.classList.toggle('sel', b.getAttribute('data-rf-tab') === tab);
    const ti = $('rf-content-title'), sb = $('rf-content-sub'), nt = $('rf-content-note');
    const dexN = SPECIES.filter(s => caughtN(s.name) > 0).length;
    if (ti) ti.textContent = tab === 'journal' ? 'Journal' : tab === 'almanac' ? 'Almanac' : tab === 'records' ? 'Records' : 'This session';
    if (sb) sb.textContent = tab === 'journal' ? (fmt(rows.length) + ' entries kept · oldest first to go' + (memOnly ? ' · memory only' : ''))
      : tab === 'almanac' ? (dexN + ' of ' + SPECIES.length + ' species landed')
      : tab === 'records' ? 'Personal bests, with the day they were set'
      : ('Since ' + hhmm(ses.t0) + ' · ' + dur(Math.round(ses.play * 1000)) + ' aboard');
    if (nt) nt.textContent = 'J closes · export copies to the clipboard';
    if (tab === 'journal') renderLog();
    else if (tab === 'almanac') renderAlmanac();
    else if (tab === 'records') renderRecords();
    else renderRecap();
  }

  /* ---- the log: day groups, kind filters, free text, paged rendering ---- */
  function renderLog() {
    const pane = $('rf-content-pane'); if (!pane) return;
    const chips = FILTERS.map(f => '<button class="rf-content-chip' + (filt === f[0] ? ' sel' : '') + '" type="button" data-rf-filt="' + f[0] + '">' + f[1] + '</button>').join('');
    let h = '<div class="rf-content-tools">' +
      '<input type="text" id="rf-content-q" placeholder="search the log…" value="' + esc(q) + '">' + chips + '</div>';
    const set = (FILTERS.find(f => f[0] === filt) || FILTERS[0])[2];
    // one pass builds both the day totals and the filtered view
    const days = Object.create(null), list = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i], dk = dayKey(e.t);
      let d = days[dk]; if (!d) d = days[dk] = { g: 0, f: 0, o: 0 };
      if (e.p && +e.p.g > 0) d.g += +e.p.g;
      if (e.k === 'catch') d.f++;
      if (e.k === 'mined' && e.p) d.o += e.p.n | 0;
      if (set && set.indexOf(e.k) < 0) continue;
      if (q && e.s.toLowerCase().indexOf(q) < 0 && e.k.indexOf(q) < 0) continue;
      list.push(e);
    }
    const shown = Math.min(list.length, page * PAGE);
    if (!list.length) h += '<div class="empty">' + (rows.length ? 'Nothing in the log matches that.' : 'The log is empty. Go and do something worth writing down.') + '</div>';
    let cur = '';
    for (let i = 0; i < shown; i++) {
      const e = list[i], dk = dayKey(e.t);
      if (dk !== cur) {
        cur = dk; const d = days[dk] || { g: 0, f: 0, o: 0 };
        h += '<div class="rf-content-day"><b>' + dayLab(e.t) + '</b><span><i>◈' + fmt(d.g) + '</i> earned · ' +
          fmt(d.f) + ' landed · ' + fmt(d.o) + ' ore</span></div>';
      }
      const km = kmeta(e.k);
      h += '<div class="rf-content-row" title="' + esc(km.lab) + '">' + ico(km.i, 13) +
        '<span class="rf-content-tm">' + hhmm(e.t) + '</span>' +
        '<span class="rf-content-tx" style="color:' + km.c + '">' + esc(e.s) + '</span>' +
        '<span class="rf-content-wd">' + esc(wname(e.w)) + '</span></div>';
    }
    if (shown < list.length) h += '<button class="btn rf-content-more" type="button" data-rf-more="1">Older · ' + fmt(list.length - shown) + ' more entries</button>';
    pane.innerHTML = h;
    const qi = $('rf-content-q');
    if (qi && reFocus) { reFocus = false; qi.focus(); try { qi.setSelectionRange(q.length, q.length); } catch (e) { } }
  }

  /* ---- the almanac: completion, one page per species, weight spread ---- */
  function renderAlmanac() {
    const pane = $('rf-content-pane'); if (!pane) return;
    let h = '';
    for (const k of ISLES) {
      const list = SPECIES.filter(s => s.isles.indexOf(k) >= 0);
      const seen = list.filter(s => caughtN(s.name) > 0).length;
      const pc = list.length ? Math.round(seen / list.length * 100) : 0;
      h += '<div class="rf-content-mrow"><span class="rf-content-mn">' + esc(wname(k)) + '</span>' +
        '<span class="rf-content-bar"><i style="width:' + pc + '%"></i></span><b>' + seen + '/' + list.length + '</b></div>';
    }
    const allSeen = SPECIES.filter(s => caughtN(s.name) > 0).length;
    const apc = SPECIES.length ? Math.round(allSeen / SPECIES.length * 100) : 0;
    h += '<div class="rf-content-mrow"><span class="rf-content-mn" style="color:var(--gold)">Every sea</span>' +
      '<span class="rf-content-bar gold"><i style="width:' + apc + '%"></i></span><b style="color:var(--gold)">' + apc + '%</b></div>';

    if (sel && SPBY[sel]) h += detailHTML(SPBY[sel]);

    h += '<div class="rf-content-tools" style="margin-top:.7em">' +
      '<button class="rf-content-chip' + (isle === 'all' ? ' sel' : '') + '" type="button" data-rf-isle="all">All waters</button>' +
      ISLES.map(k => '<button class="rf-content-chip' + (isle === k ? ' sel' : '') + '" type="button" data-rf-isle="' + k + '">' + esc(wname(k)) + '</button>').join('') +
      '<button class="rf-content-chip' + (ghostOnly ? ' sel' : '') + '" type="button" data-rf-ghost="1">Still missing</button></div>';

    h += '<div class="rf-content-grid">';
    let n = 0;
    for (const sp of SPECIES) {
      if (isle !== 'all' && sp.isles.indexOf(isle) < 0) continue;
      const c = caughtN(sp.name);
      if (ghostOnly && c > 0) continue;
      n++;
      const col = c ? rarCol(sp.rar) : '#3a4a50';
      h += '<button class="rf-content-sp' + (c ? '' : ' ghost') + (sel === sp.name ? ' sel' : '') + '" type="button" data-rf-sp="' + esc(sp.name) + '">' +
        fishIco(col, 15) +
        '<span class="rf-content-nm"' + (c ? '' : ' style="color:var(--faint)"') + '>' + esc(c ? sp.name : mask(sp.name)) + '</span>' +
        (sp.cond ? ico(CONDI[sp.cond] || 'rain', 11) : '') +
        '<span class="rf-content-ct">' + (c ? 'x' + fmt(c) : '—') + '</span></button>';
    }
    h += '</div>';
    if (!n) h += '<div class="empty">Nothing left to find in these waters.</div>';
    pane.innerHTML = h;
    if (sel && SPBY[sel]) drawSpark(SPBY[sel]);
  }
  const mask = n => String(n).replace(/[a-z]/g, '·');

  function detailHTML(sp) {
    const c = caughtN(sp.name), d = dexMine(sp.name) || {}, best = bestKg(sp.name);
    const isles = sp.isles.filter(k => c > 0 || known(k)).map(wname);
    const cond = sp.cond ? (CONDT[sp.cond] || sp.cond) : 'any weather, any hour';
    let h = '<div class="rf-content-det"><div class="rf-content-dl">' +
      '<h3>' + fishIco(c ? rarCol(sp.rar) : '#3a4a50', 18) + esc(c ? sp.name : mask(sp.name)) +
      (c ? '<span class="rf-content-rr" style="color:' + rarCol(sp.rar) + '">' + sp.rar + '</span>' : '<span class="rf-content-rr" style="color:var(--faint)">unrecorded</span>') + '</h3>';
    h += kv('Base value', c ? '◈ ' + fmt(sp.val) : '—');
    h += kv('Waters', isles.length ? isles.join(' · ') : 'unknown waters');
    h += kv('Bites', cond);
    h += kv('Landed', c ? fmt(c) + (c === 1 ? ' time' : ' times') : 'never');
    h += kv('Heaviest', best ? best + ' kg' : '—');
    h += kv('First', d.first ? dateLab(d.first) : (c ? 'before the journal' : '—'));
    h += kv('Latest', d.last ? dateLab(d.last) : (c ? 'before the journal' : '—'));
    h += '</div><div class="rf-content-sparkwrap"><canvas class="spark rf-content-spark" id="rf-content-spark" width="252" height="58"></canvas>' +
      '<small>' + (hasHist(d) ? 'weight spread' : c ? 'no weights logged yet' : 'silhouette only') + '</small></div></div>';
    return h;
  }
  const kv = (k, v) => '<div class="rf-content-kv"><span>' + k + '</span><b>' + esc(v) + '</b></div>';
  const hasHist = d => Array.isArray(d.h) && d.h.some(v => v > 0);

  /* The sparkline is one pooled canvas in the detail card — 70 live canvases in
     a grid would cost more than the whole rest of the panel. */
  function drawSpark(sp) {
    try {
      const cv = $('rf-content-spark'); if (!cv || !cv.getContext) return;
      const c = cv.getContext('2d'); if (!c) return;
      const W = cv.width, H = cv.height;
      c.clearRect(0, 0, W, H);
      const d = dexMine(sp.name) || {}, h = hasHist(d) ? d.h : null;
      const col = h ? rarCol(sp.rar) : '#2c3b42';
      if (!h) {
        c.fillStyle = 'rgba(255,255,255,.06)';
        for (let i = 0; i < 12; i++) c.fillRect(4 + i * (W - 8) / 12, H - 8, (W - 8) / 12 - 3, 6);
        c.fillStyle = '#5c7a76'; c.font = '10px "IBM Plex Mono",monospace'; c.textAlign = 'center';
        c.fillText('no data', W / 2, H / 2);
        return;
      }
      let max = 1; for (const v of h) if (v > max) max = v;
      const bw = (W - 8) / 12;
      for (let i = 0; i < 12; i++) {
        const bh = Math.max(2, Math.round((h[i] / max) * (H - 16)));
        c.fillStyle = h[i] ? col : 'rgba(255,255,255,.07)';
        c.globalAlpha = h[i] ? 0.35 + 0.65 * (h[i] / max) : 1;
        c.fillRect(4 + i * bw, H - 10 - bh, bw - 3, bh);
      }
      c.globalAlpha = 1;
      const lo = sp.val / 9 * 0.5 + 0.2, hi = sp.val / 9 * 1.6 + 0.2;
      c.fillStyle = '#5c7a76'; c.font = '9px "IBM Plex Mono",monospace';
      c.textAlign = 'left'; c.fillText(lo.toFixed(1) + 'kg', 4, H - 1);
      c.textAlign = 'right'; c.fillText(hi.toFixed(1) + 'kg', W - 4, H - 1);
    } catch (e) { RF.err('06-content:spark', e); }
  }

  /* ---- the board ---- */
  function renderRecords() {
    const pane = $('rf-content-pane'); if (!pane) return;
    let h = '<div class="seclab">Personal bests</div>';
    for (const [key, label, icon, show] of RECS) {
      const r = meta.rec[key];
      if (r && +r.v > 0) {
        h += '<div class="rf-content-rec">' + ico(icon, 15) +
          '<span class="rf-content-rl">' + label + (r.n ? '<small>' + esc(r.n) + '</small>' : '') + '</span>' +
          '<span class="rf-content-rv">' + esc(show(r)) + '<small>' + dateLab(r.t) + ' · ' + esc(wname(r.w)) + '</small></span></div>';
      } else {
        h += '<div class="rf-content-rec none">' + ico(icon, 15) +
          '<span class="rf-content-rl">' + label + '</span><span class="rf-content-rv">—<small>not yet set</small></span></div>';
      }
    }
    const legs = SPECIES.filter(s => s.rar === 'legendary');
    h += '<div class="seclab">First of each legend · ' + Object.keys(meta.leg).length + '/' + legs.length + '</div>';
    for (const sp of legs) {
      const t = meta.leg[sp.name], got = caughtN(sp.name) > 0;
      h += '<div class="rf-content-rec' + (t ? '' : ' none') + '">' + fishIco(t ? rarCol('legendary') : '#3a4a50', 15) +
        '<span class="rf-content-rl">' + esc(t || got ? sp.name : mask(sp.name)) + '<small>' + esc(sp.isles.map(wname).join(' · ') || 'unknown waters') + '</small></span>' +
        '<span class="rf-content-rv">' + (t ? '★' : '—') + '<small>' + (t ? dateLab(t) : got ? 'landed before the journal' : 'never landed') + '</small></span></div>';
    }
    const l = meta.life;
    h += '<div class="seclab">Lifetime</div>' +
      '<div class="statrow"><span>Sessions logged</span><b>' + fmt(l.sessions | 0) + '</b></div>' +
      '<div class="statrow"><span>Time aboard</span><b>' + dur((l.ms | 0) + Math.round(ses.play * 1000)) + '</b></div>' +
      '<div class="statrow"><span>Journal entries kept</span><b>' + fmt(rows.length) + ' / ' + CAP + '</b></div>';
    pane.innerHTML = h;
  }

  /* ---- the session card ---- */
  function renderRecap() {
    const pane = $('rf-content-pane'); if (!pane) return;
    const r = recap();
    const fig = (k, v, cls) => '<div class="rf-content-fig"><div class="rf-content-fk">' + k + '</div><div class="rf-content-fv ' + (cls || '') + '">' + v + '</div></div>';
    let h = '<div class="rf-content-cards">' +
      fig('Time aboard', dur(r.ms)) +
      fig('Coins earned', '◈ ' + fmt(r.earned), 'gold') +
      fig('Fish landed', fmt(r.caught), 'teal') +
      fig('Ore mined', fmt(r.ore)) +
      fig('Walked', fmt(r.dist) + ' m') +
      fig('Pearls', fmt(r.pearls), 'teal') +
      '</div>';
    const RO = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
    let pips = '';
    for (const k of RO) pips += '<span class="rf-content-pip" style="color:' + rarCol(k) + '"><i style="background:' + rarCol(k) + '"></i>' + (r.rar[k] | 0) + ' ' + k + '</span>';
    h += '<div class="seclab">By rarity</div><div class="rf-content-pips">' + pips + '</div>';
    h += '<div class="seclab">The details</div>';
    h += '<div class="statrow"><span>Best catch</span><b>' + (r.best ? esc(r.best.name) + ' · ' + r.best.kg + ' kg · ◈' + fmt(r.best.val) : 'nothing yet') + '</b></div>';
    h += '<div class="statrow"><span>Species seen this session</span><b>' + r.species + '</b></div>';
    const ob = Object.keys(r.oreBy).map(k => (RF.ORE_INFO && RF.ORE_INFO[k] ? RF.ORE_INFO[k].name : k) + ' ' + r.oreBy[k]).join(' · ');
    h += '<div class="statrow"><span>Ore &amp; timber</span><b>' + (ob || 'none') + (r.wood ? ' · Wood ' + r.wood : '') + '</b></div>';
    h += '<div class="statrow"><span>The wheel</span><b>' + (r.spins ? r.spins + ' spins · ' + (r.spinNet >= 0 ? '+' : '−') + '◈' + fmt(Math.abs(r.spinNet)) : 'untouched') + '</b></div>';
    h += '<div class="statrow"><span>Sold at the Trader</span><b>◈ ' + fmt(r.sold) + '</b></div>';
    h += '<div class="statrow"><span>Started</span><b>' + dateLab(r.t0) + ' · ' + esc(wname(r.world)) + '</b></div>';
    h += '<button class="btn rf-content-more" type="button" data-rf-write="1">Write this into the journal</button>';
    h += '<div class="rf-content-note" style="margin-top:.5em;font-size:.72em;color:var(--faint)">The log writes itself when you sail · sailing reloads the isle, so that is where a session ends.</div>';
    pane.innerHTML = h;
  }

  /* ------------------------------------------------------------ open/close */
  function open(t) {
    if (!root && !build()) return;
    if (t) tab = t;
    openT = true; page = 1;
    root.classList.add('on'); sfx('open'); render();
  }
  function close() {
    if (!openT) return;
    openT = false;
    if (root) root.classList.remove('on');
    const d = $('rf-content-drawer'); if (d) d.style.display = 'none';
    sfx('close');
  }
  const typing = () => {
    const a = document.activeElement;
    return !!RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  };
  const MOVE = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyE: 1, Space: 1 };

  RF.on('keydown', e => {
    try {
      // core reads WASD straight off the document and preventDefaults them, so a
      // mod input must claim every key while it holds focus or typing walks you
      const tgt = e.target;
      if (openT && root && tgt && tgt.nodeType === 1 && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') && root.contains(tgt)) {
        if (e.code === 'Escape') { tgt.blur(); return true; }
        return true;
      }
      if (typing()) return;
      if (e.code === 'KeyJ' && !RF.panelOpen) { e.preventDefault(); openT ? close() : open(); return true; }
      if (!openT) return;
      if (e.code === 'Escape') { close(); return true; }
      if (MOVE[e.code]) return true;                 // stand still while reading the papers
      if (e.code === 'Tab') {                        // Tab / Shift+Tab cycles the four pages
        e.preventDefault();
        const i = TABS.findIndex(t => t[0] === tab);
        tab = TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length][0];
        page = 1; sfx('tab'); render(); return true;
      }
    } catch (err) { RF.err('06-content:key', err); }
  });

  /* --------------------------------------------------------------- public */
  const API = {
    log: (kind, summary, payload) => log(kind, summary, payload),
    entries: () => rows.slice(),
    recap: () => recap(),
    records: () => JSON.parse(JSON.stringify(meta.rec)),
    almanac: () => SPECIES.map(sp => ({ name: sp.name, rar: sp.rar, val: sp.val, isles: sp.isles.slice(), cond: sp.cond, n: caughtN(sp.name), best: bestKg(sp.name) })),
    open: t => open(t), close: close,
    flush: () => flush(true)
  };
  RF.api = RF.api || {};
  RF.api.journal = API;
  // a later mod that replaces RF.api wholesale would take the journal with it
  RF.on('ready', () => { RF.api = RF.api || {}; if (!RF.api.journal) RF.api.journal = API; });

  /* A fresh save with a dex already full (a returning server account) still
     deserves an almanac, so seed first/last from whatever the engine knows. */
  try {
    const bd = RF.state && RF.state.dex;
    if (bd) for (const n in bd) {
      if (!meta.dex[n] && bd[n]) { meta.dex[n] = { n: bd[n].n | 0, best: +bd[n].best || 0, first: 0, last: 0, h: null }; mDirty = true; }
    }
  } catch (e) { RF.err('06-content:seed', e); }
  flush(true);
});
