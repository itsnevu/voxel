/* 03-panels — the Market and the Inventory, turned into things you can actually read.
   1.  Sticky section rail in the Market: jump chips that track where you are in the card.
   2.  Bucket toolbar: sort by value/weight/rarity/name/newest, rarity filter, ★ and record toggles, live search.
   3.  Haul readout: bucket total at today's prices, ◈/kg, weight, rarity spread, HOT/SURPLUS with a flip countdown.
   4.  Record & star badges stamped on every fish row and bag card, so "keep the records" is legible.
   5.  Smart sell: SELL FILTERED / SELL JUNK, keeping ★ and records — queued through the game's own buttons, so it works signed in.
   6.  Craft planner under the upgrades: exact shortfall per tool, ETA at your measured rate, and the whole road to Lv.10.
   7.  Fishdex rebuilt: completion by rarity, missing/caught filters, and condition + isle hints on every locked ???.
   8.  Explainer tooltips: hover a stat, a bait, a share, an ore pile, a kiosk line — it tells you what the number does.
   9.  Stats page worth reading: session vs lifetime, live rates, heaviest fish ever, completion bars, time on the isle.
   10. Keyboard navigation: / searches, ↑↓ walk the rows, Enter acts, [ ] cycle the tabs, ESC clears the filter first.
   11. Panel memory: the tab you left on and the scroll position you left at, per panel, across sessions. */
RF.mod('03-panels', function (RF) {
  'use strict';

  const D = document, F = RF.fn, fmt = F.fmt, pix = F.pixSVG;
  const RAR = RF.RAR, RORDER = RF.RORDER, ORE = RF.ORE_INFO, MAXLVL = RF.MAXLVL || 10;
  const $ = (s, r) => (r || D).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || D).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  /* every tooltip body is stashed in an attribute, so it gets the attribute treatment */
  const attr = s => esc(s).replace(/'/g, '&#39;');

  /* ---------------------------------------------------------------- prefs.
     One shared filter state drives the Market fish list AND the bag, because
     they are the same bucket seen twice — a sort you set in one place that
     silently disagreed with the other would be worse than no sort at all. */
  const DEF = { sort: 'value', dir: -1, rar: 'all', q: '', star: 0, rec: 0, keep: 1,
                dex: 'all', dexCond: '', dexHere: 0, dexq: '', tab: 'bag', tips: 1, scroll: {} };
  let P = Object.assign({}, DEF, RF.store.get('03-panels') || {});
  if (!P.scroll || typeof P.scroll !== 'object') P.scroll = {};
  let saveT = 0;
  const savePref = () => { clearTimeout(saveT); saveT = setTimeout(() => RF.store.set('03-panels', P), 350); };

  /* ---------------------------------------------------------------- styling */
  RF.css(`
  .p3-tools{margin:2px 0 10px;}
  .p3-haul{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-radius:12px;padding:9px 13px;margin-bottom:7px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);font-size:11.5px;color:var(--muted);}
  .p3-haul b{font-family:"Chakra Petch";color:var(--ink);font-variant-numeric:tabular-nums;font-size:13px;}
  .p3-haul b.g{color:var(--gold);}
  .p3-haul .sp{flex:1 1 auto;}
  .p3-pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;letter-spacing:.08em;font-weight:600;
    border:1px solid var(--glass-bd-soft);border-radius:999px;padding:2px 8px;color:var(--muted);white-space:nowrap;}
  .p3-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;}
  .p3-q{flex:1 1 160px;min-width:110px;font-family:"IBM Plex Mono";font-size:11.5px;color:var(--ink);
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:9px;padding:7px 10px;outline:none;}
  .p3-q::placeholder{color:var(--faint);}
  .p3-q:focus{border-color:rgba(57,215,196,.6);box-shadow:0 0 10px rgba(57,215,196,.18);}
  .p3-chip{font-family:"Chakra Petch";font-weight:600;font-size:11px;letter-spacing:.08em;cursor:pointer;
    border:1px solid var(--glass-bd-soft);background:var(--glass-row);color:var(--muted);border-radius:8px;padding:5px 9px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);transition:color .12s,border-color .12s;}
  .p3-chip:hover{color:var(--ink);border-color:var(--glass-bd);}
  .p3-chip.on{color:var(--teal);border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.28);}
  .p3-chip.sub{font-size:10px;padding:4px 7px;letter-spacing:.04em;}
  .p3-sep{width:1px;height:16px;background:var(--glass-bd-soft);margin:0 2px;}
  .p3-rail{position:sticky;top:0;z-index:4;display:flex;flex-wrap:wrap;gap:5px;align-items:center;
    margin:10px -24px 4px;padding:9px 24px;border-bottom:1px solid var(--glass-bd-soft);
    background:linear-gradient(180deg,rgba(9,18,24,.94),rgba(9,18,24,.74));
    backdrop-filter:blur(10px) saturate(1.4);-webkit-backdrop-filter:blur(10px) saturate(1.4);}
  .p3-badge{font-size:9px;font-weight:700;letter-spacing:.1em;border-radius:5px;padding:1px 5px;margin-left:5px;
    border:1px solid currentColor;vertical-align:1px;white-space:nowrap;}
  .p3-badge.rec{color:var(--teal);}
  .p3-badge.big{color:var(--gold);}
  .p3-hint{display:block;font-size:9.5px;color:var(--faint);letter-spacing:.02em;margin-top:1px;}
  .p3-hint .pix{vertical-align:-2px;}
  .p3-cur{outline:1px solid var(--teal);outline-offset:-1px;box-shadow:0 0 12px rgba(57,215,196,.22)!important;}
  .p3-tip{position:fixed;z-index:40;max-width:290px;pointer-events:none;opacity:0;transform:translateY(4px);
    transition:opacity .12s ease,transform .12s ease;font-size:11.5px;line-height:1.55;color:var(--ink);
    background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:11px;padding:9px 12px;
    box-shadow:var(--glass-hi),0 10px 28px rgba(2,8,10,.45);}
  .p3-tip.on{opacity:1;transform:none;}
  .p3-tip b{color:var(--teal);font-weight:600;}
  .p3-tip i{color:var(--faint);font-style:normal;}
  .p3-tip u{color:var(--gold);text-decoration:none;}
  .p3-blk{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:12px;
    padding:11px 13px;margin-bottom:7px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .p3-blk .h{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin-bottom:8px;}
  .p3-pr{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted);padding:5px 0;
    border-top:1px solid rgba(255,255,255,.05);}
  .p3-pr:first-of-type{border-top:0;}
  .p3-pr .nm{flex:1;color:var(--ink);font-weight:600;font-size:12.5px;}
  .p3-pr .eta{font-family:"Chakra Petch";font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .p3-need{display:inline-flex;align-items:center;gap:3px;margin-right:7px;font-size:11px;}
  .p3-need.ok{color:var(--teal);} .p3-need.no{color:var(--rose);}
  .p3-bar{height:4px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden;margin-top:4px;}
  .p3-bar i{display:block;height:100%;border-radius:3px;background:var(--teal);transition:width .25s ease;}
  .p3-tiles{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:8px;}
  .p3-tile{flex:1 1 calc(25% - 6px);min-width:116px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:12px;padding:9px 11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .p3-tile .k{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);}
  .p3-tile .v{font-family:"Chakra Petch";font-weight:700;font-size:17px;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.25;}
  .p3-tile .s{font-size:10px;color:var(--muted);}
  .p3-cols{display:flex;gap:8px;font-size:11px;color:var(--faint);letter-spacing:.14em;text-transform:uppercase;
    padding:0 13px 4px;}
  .p3-cols span:first-child{flex:1;}
  .p3-cols span{min-width:74px;text-align:right;}
  .p3-cmp{display:flex;align-items:center;gap:8px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:10px;padding:7px 13px;margin-bottom:5px;font-size:12.5px;color:var(--muted);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .p3-cmp .nm{flex:1;color:var(--ink);}
  .p3-cmp b{min-width:74px;text-align:right;font-family:"Chakra Petch";font-variant-numeric:tabular-nums;color:var(--ink);}
  .p3-cmp b.s{color:var(--teal);}
  .p3-dexbars{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
  .p3-dexbar{flex:1 1 88px;min-width:80px;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);}
  .p3-dexbar b{font-family:"Chakra Petch";color:var(--ink);font-size:11px;float:right;}
  .p3-big{font-family:"Chakra Petch";font-weight:700;font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums;}
  .p3-note{font-size:10.5px;color:var(--faint);line-height:1.5;margin-top:6px;}
  .p3-sell{gap:6px;}
  .p3-sell .p3-chip{padding:7px 11px;font-size:11.5px;}
  .p3-sell .p3-chip.go{color:var(--gold);border-color:rgba(255,207,92,.5);}
  .p3-sell .p3-chip:disabled{opacity:.35;cursor:default;}
  @media (prefers-reduced-motion:reduce){
    .p3-tip,.p3-bar i,.p3-chip{transition:none;} }
  `, '03-panels-css');

  /* ---------------------------------------------------------------- tooltips.
     One node, moved around. The text lives in a data attribute on whatever the
     pointer is over, so a re-render by the core simply drops the old tips and
     the next decorate pass writes fresh ones — nothing to keep in sync. */
  const tipEl = RF.el('<div class="p3-tip"></div>');
  let tipNode = null;
  function showTip(node) {
    const t = node.getAttribute('data-p3tip');
    if (!t || !P.tips) return;
    tipNode = node; tipEl.innerHTML = t; tipEl.classList.add('on');
    tipEl.style.left = '0px'; tipEl.style.top = '0px';
    const r = node.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let y = r.top - h - 9; if (y < 8) y = r.bottom + 9;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    tipEl.style.top = Math.max(8, Math.min(innerHeight - h - 8, y)) + 'px';
  }
  const hideTip = () => { tipNode = null; tipEl.classList.remove('on'); };
  D.addEventListener('mouseover', e => {
    const t = e.target && e.target.closest ? e.target.closest('[data-p3tip]') : null;
    if (t === tipNode) return;
    if (t) showTip(t); else hideTip();
  }, true);
  D.addEventListener('mousedown', hideTip, true);
  addEventListener('scroll', hideTip, true);

  /* ---------------------------------------------------------------- data maps */
  const ORE_KEYS = Object.keys(ORE);
  const ORE_BY_NAME = {}; ORE_KEYS.forEach(k => { ORE_BY_NAME[ORE[k].name.toLowerCase()] = k; });
  const oreIco = (k, s) => k === 'wood' ? pix('wood', s || 14) : pix('ore', s || 14, { M: ORE[k].dot });
  const RKEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const RSHORT = { common: 'C', uncommon: 'U', rare: 'R', epic: 'E', legendary: 'L' };
  const condIco = c => c === 'night' ? pix('moon', 10) : c === 'storm' ? pix('storm', 10) : c === 'rain' ? pix('rain', 10) : '';
  const condWord = c => c === 'night' ? 'at night' : c === 'storm' ? 'in a storm' : c === 'rain' ? 'in the rain' : '';
  /* which isles a species swims in — the Fishdex hint everyone asks for out loud */
  const FWORLD = {};
  try {
    for (const k in RF.WORLDS) {
      const wf = RF.WORLDS[k].fish; if (!wf) continue;
      for (let i = 0; i < wf.length; i++) {
        const n = wf[i][0].name; if (!FWORLD[n]) FWORLD[n] = [];
        if (FWORLD[n].indexOf(k) < 0) FWORLD[n].push(k);
      }
    }
  } catch (e) { RF.warn('03-panels/worldmap', e); }
  const worldList = name => (FWORLD[name] || []).map(k => (RF.WORLDS[k] || {}).name || k);
  const dexName = f => f && f.shiny ? String(f.name).replace('✨ ', '').replace('✦ ', '') : (f ? f.name : '');
  /* A fish you just caught is ALWAYS its own dex record — onCatch wrote the
     number the moment it landed — so `kg >= best` alone would stamp REC on the
     whole bucket and mean nothing. It only earns the badge once the species has
     been landed before and this one still beat it. */
  const isRecord = f => { const d = RF.state.dex[dexName(f)]; return !!(d && d.n > 1 && f.kg && f.kg >= d.best); };
  const hhm = s => { s = Math.max(0, Math.round(s)); const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0;
    return h ? h + 'h ' + m + 'm' : m ? m + 'm' : Math.max(1, s) + 's'; };
  const etaTxt = min => !isFinite(min) || min <= 0 ? '—' : min < 1 ? 'under a minute' :
    min < 90 ? Math.round(min) + ' min' : (min / 60).toFixed(1) + ' hr';

  /* ---------------------------------------------------------------- rate meter.
     Sampled off the counters rather than the events, so it reads the same
     whether the roll happened here or on the server. A counter that goes DOWN
     means the server just handed us its own state — re-baseline and move on. */
  const SESS = { t: 0, started: Date.now(), base: null, ore: {}, prev: null };
  function snap() {
    const s = RF.state, o = {};
    ORE_KEYS.forEach(k => { o[k] = s.ores[k] | 0; });
    return { caught: s.stats.caught | 0, mined: s.stats.mined | 0, wood: s.stats.wood | 0,
             earned: s.stats.earned | 0, pearls: s.pearlsLife | 0, ores: o };
  }
  function rebase() { SESS.base = snap(); SESS.prev = snap(); ORE_KEYS.forEach(k => { SESS.ore[k] = 0; }); }
  rebase();
  RF.every(2, () => {
    if (RF.running) SESS.t += 2;
    const now = snap(), b = SESS.base, p = SESS.prev;
    if (now.caught < b.caught || now.earned < b.earned || now.mined < b.mined) { rebase(); return; }
    ORE_KEYS.forEach(k => { const d = now.ores[k] - p.ores[k]; if (d > 0) SESS.ore[k] += d; });
    SESS.prev = now;
  });
  const sessDelta = k => Math.max(0, (snap()[k] | 0) - (SESS.base[k] | 0));
  const perMin = n => SESS.t > 25 ? n / (SESS.t / 60) : 0;

  /* ---------------------------------------------------------------- filtering */
  function passes(f) {
    if (!f) return false;
    if (P.rar !== 'all' && f.rar !== P.rar) return false;
    if (P.star && !(f.wins > 0)) return false;
    if (P.rec && !isRecord(f)) return false;
    const q = (P.q || '').trim().toLowerCase();
    if (q && String(f.name).toLowerCase().indexOf(q) < 0) return false;
    return true;
  }
  const SORTV = { value: f => f.val | 0, kg: f => +f.kg || 0, rar: f => RORDER[f.rar] || 0 };
  function orderIdx(list) {                       // list: [{i,f}] -> sorted copy
    const arr = list.slice();
    if (P.sort === 'new') { arr.reverse(); if (P.dir > 0) arr.reverse(); return arr; }
    if (P.sort === 'name') {
      arr.sort((a, b) => String(a.f.name).localeCompare(String(b.f.name)) * (P.dir > 0 ? 1 : -1));
      return arr;
    }
    const g = SORTV[P.sort] || SORTV.value;
    arr.sort((a, b) => (g(a.f) - g(b.f)) * (P.dir > 0 ? 1 : -1) || (a.i - b.i));
    return arr;
  }

  /* ---------------------------------------------------------------- toolbars.
     Two instances of the same control strip (Market fish, bag fish) sharing one
     state object; every mutation repaints both so they can never disagree. */
  const RARCHIPS = [['all', 'ALL']].concat(RKEYS.map(k => [k, RSHORT[k]]));
  const SORTCHIPS = [['value', '◈'], ['kg', 'KG'], ['rar', 'RARITY'], ['name', 'A-Z'], ['new', 'NEWEST']];

  function buildTools(kind) {
    const root = RF.el('<div class="p3-tools"><div class="p3-haul"></div>' +
      '<div class="p3-row"><input class="p3-q" type="text" spellcheck="false" placeholder="search the bucket…">' +
      '<span class="p3-chips-rar"></span><span class="p3-sep"></span><span class="p3-chips-sort"></span></div>' +
      (kind === 'market' ? '<div class="p3-row p3-sell"></div>' : '') + '</div>', null);
    const haul = $('.p3-haul', root), q = $('.p3-q', root);
    const rarBox = $('.p3-chips-rar', root), sortBox = $('.p3-chips-sort', root), sellBox = $('.p3-sell', root);
    /* the input must swallow its own keys or WASD would walk the hero around behind the panel */
    q.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Escape') { q.blur(); return; }
      if (e.code === 'Enter') { q.blur(); return; }
    });
    q.addEventListener('keyup', e => e.stopPropagation());
    q.addEventListener('input', () => { P.q = q.value; savePref(); paintAll(); });

    let h = '';
    RARCHIPS.forEach(c => {
      const col = c[0] === 'all' ? '' : ';color:' + RAR[c[0]];
      h += `<button class="p3-chip sub" data-rar="${c[0]}" type="button" style="min-width:26px${col}">${c[1]}</button>`;
    });
    h += `<button class="p3-chip sub" data-tog="star" type="button" data-p3tip="${attr('<b>★ only</b><br>fish that survived a spin at the Eel. Every win doubles what the fishmonger pays, so these are the ones worth carrying.')}">★</button>`;
    h += `<button class="p3-chip sub" data-tog="rec" type="button" data-p3tip="${attr('<b>records only</b><br>the heaviest of its species you have ever landed. The Fishdex keeps the number whether you sell it or not — but the fish itself is gone once you do.')}">REC</button>`;
    rarBox.innerHTML = h;
    sortBox.innerHTML = SORTCHIPS.map(c =>
      `<button class="p3-chip sub" data-sort="${c[0]}" type="button">${c[1]}</button>`).join('');

    root.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-rar],[data-sort],[data-tog],[data-sell]') : null;
      if (!t) return;
      if (t.hasAttribute('data-rar')) { P.rar = t.getAttribute('data-rar'); }
      else if (t.hasAttribute('data-tog')) { const k = t.getAttribute('data-tog'); P[k] = P[k] ? 0 : 1; }
      else if (t.hasAttribute('data-sort')) {
        const s = t.getAttribute('data-sort');
        if (P.sort === s) P.dir = -P.dir; else { P.sort = s; P.dir = s === 'name' ? 1 : -1; }
      } else if (t.hasAttribute('data-sell')) { doSell(t.getAttribute('data-sell')); return; }
      if (RF.sfx && RF.sfx.tab) RF.sfx.tab();
      savePref(); paintAll();
    });
    return { root, haul, q, rarBox, sortBox, sellBox };
  }
  const TOOLS = { market: null, inv: null };

  /* ------- the haul readout: what the bucket is actually worth, right now ---- */
  function haulHTML() {
    const b = RF.state.bucket || [], pm = F.priceMult('fish'), m = F.mktMods();
    const capN = F.cap();
    if (!b.length) {
      return `<span class="p3-pill">BUCKET <b style="font-size:11px">0</b>/${capN}</span>
        <span>empty · the sea is right there</span><span class="sp"></span>${flipHTML(m)}`;
    }
    let val = 0, kg = 0, best = null, cnt = {};
    for (let i = 0; i < b.length; i++) {
      const f = b[i], v = Math.round(f.val * pm);
      val += v; kg += +f.kg || 0; cnt[f.rar] = (cnt[f.rar] | 0) + 1;
      if (!best || v > Math.round(best.val * pm)) best = f;
    }
    const dots = RKEYS.filter(k => cnt[k]).map(k =>
      `<span class="p3-pill" style="color:${RAR[k]};border-color:${RAR[k]}55">${RSHORT[k]} ${cnt[k]}</span>`).join(' ');
    const perKg = kg > 0.05 ? Math.round(val / kg) : 0;
    return `<span class="p3-pill"${b.length >= capN ? ' style="color:var(--rose);border-color:var(--rose)"' : ''}>BUCKET <b style="font-size:11px">${b.length}</b>/${capN}</span>
      <span data-p3tip="${attr('Every fish in the bucket sold right now, at this rotation’s prices. Sell before the rotation flips and it is a different number.')}">worth <b class="g">◈ ${fmt(val)}</b></span>
      <span data-p3tip="${attr('Value per kilo. The honest measure of a bucket: a heavy common is dead weight, a light legendary is not.')}"><b>◈ ${fmt(perKg)}</b>/kg</span>
      <span>${kg.toFixed(1)} kg</span>
      ${dots}
      <span class="sp"></span>
      <span data-p3tip="${attr('The fattest single sale in there right now.')}">best <b>${esc(dexName(best))}</b> <b class="g">◈ ${fmt(Math.round(best.val * pm))}</b></span>
      ${flipHTML(m)}`;
  }
  function flipHTML(m) {
    const left = RF.MKT_MS - (Date.now() % RF.MKT_MS), mm = (left / 60000) | 0, ss = ((left / 1000) | 0) % 60;
    const isHot = m.hot === 'fish', isCold = m.cold === 'fish';
    const col = isHot ? 'var(--gold)' : isCold ? 'var(--rose)' : 'var(--muted)';
    const word = isHot ? '▲ fish HOT ×1.6' : isCold ? '▼ fish SURPLUS ×0.75' : 'fish ×1 · HOT is ' + F.catLabel(m.hot);
    return `<span class="p3-pill p3-flip" style="color:${col};border-color:${col}55"
      data-p3tip="${attr('Demand rotates every three minutes: one category pays ×1.6, one pays ×0.75. Your bucket does not rot — waiting for fish to go HOT is a real strategy.')}">${word} · flips ${mm}:${String(ss).padStart(2, '0')}</span>`;
  }

  /* ------- the sell affordances ------------------------------------------- */
  const JUNK = f => (RORDER[f.rar] || 0) <= 1;
  function keepGuard(f) { return P.keep && (f.wins > 0 || isRecord(f)); }
  function sellSet(which) {
    const b = RF.state.bucket || [], out = [];
    for (let i = 0; i < b.length; i++) {
      const f = b[i];
      if (keepGuard(f)) continue;
      if (which === 'junk' ? JUNK(f) : passes(f)) out.push(f);
    }
    return out;
  }
  function sellHTML() {
    if (selling) return `<span class="p3-pill" style="color:var(--teal);border-color:rgba(57,215,196,.5)">selling… ${sellDone} sold</span>`;
    const pm = F.priceMult('fish');
    const mk = (which, label) => {
      const set = sellSet(which); let v = 0; set.forEach(f => { v += Math.round(f.val * pm); });
      return `<button class="p3-chip go" type="button" data-sell="${which}" ${set.length ? '' : 'disabled'}
        data-p3tip="${attr(which === 'junk'
          ? 'Commons and uncommons only. The bucket cap is the real enemy — this clears it without touching anything you meant to keep.'
          : 'Everything the filters above are currently showing. Sold one at a time through the fishmonger’s own buttons, so it works signed in too.')}"
        >${label} ${set.length ? '(' + set.length + ') ◈ ' + fmt(v) : '· nothing'}</button>`;
    };
    return mk('junk', 'SELL JUNK') + mk('filtered', 'SELL FILTERED') +
      `<button class="p3-chip${P.keep ? ' on' : ''}" type="button" data-tog="keep"
        data-p3tip="${attr('While this is on, nothing starred and nothing that is a Fishdex record leaves the bucket, whatever else you press here.')}">KEEP ★ &amp; RECORDS</button>`;
  }
  let selling = false, sellDone = 0;
  /* Sells by pressing the Market's own row buttons, one at a time, waiting for
     the bucket to actually shrink between presses. Offline that is instant;
     signed in it is a server round trip, and SRV only allows one in flight. */
  function doSell(which) {
    if (selling || !RF.marketOpen) return;
    if (!sellSet(which).length) { if (RF.sfx && RF.sfx.deny) RF.sfx.deny(); return; }
    selling = true; sellDone = 0;
    let tries = 0;
    const finish = () => {
      selling = false; paintAll();
      if (sellDone) F.toast(`${sellDone} fish over the counter`, 'gold');
      else F.toast('nothing sold', 'bad');
    };
    const step = () => {
      if (!RF.marketOpen || ++tries > 120) { finish(); return; }
      const b = RF.state.bucket || [];
      let idx = -1;
      for (let i = 0; i < b.length; i++) {
        const f = b[i];
        if (keepGuard(f)) continue;
        if (which === 'junk' ? JUNK(f) : passes(f)) { idx = i; break; }
      }
      if (idx < 0) { finish(); return; }
      const btn = $('#marketList [data-sellone="' + idx + '"]');
      if (!btn) { finish(); return; }
      const before = b.length;
      btn.click();
      let waits = 0;
      const poll = () => {
        if (!RF.marketOpen) { finish(); return; }
        if ((RF.state.bucket || []).length < before) { sellDone++; setTimeout(step, RF.online ? 130 : 0); return; }
        if (++waits > 40) { finish(); return; }     // ~2.4s: the server said no, or never answered
        setTimeout(poll, 60);
      };
      poll();
    };
    step();
  }

  /* ---------------------------------------------------------------- fish rows.
     Core writes the rows; we reorder, hide and stamp them. Everything here is
     idempotent — the next core render wipes it and we simply do it again. */
  function decorateFishRow(row, f, i, pm) {
    if (!f) { row.style.display = 'none'; return; }
    const nm = $('.nm', row) || $('.inm', row);
    const rec = isRecord(f), big = f.wins > 0;
    if (nm && !$('.p3-badge', nm)) {
      if (rec) nm.insertAdjacentHTML('beforeend', '<span class="p3-badge rec">REC</span>');
      if (f.shiny) nm.insertAdjacentHTML('beforeend', '<span class="p3-badge big">SHINY</span>');
    }
    const worlds = worldList(dexName(f));
    row.setAttribute('data-p3tip',
      `<b>${esc(dexName(f))}</b> · <span style="color:${RAR[f.rar]}">${esc(f.rar)}</span><br>` +
      `${f.kg || '?'} kg · base ◈${fmt(f.val)} → <u>◈${fmt(Math.round(f.val * pm))}</u> at today's prices<br>` +
      (big ? `<i>★${f.wins} — survived ${f.wins} spin${f.wins > 1 ? 's' : ''}; the value already includes the ×${Math.pow(2, f.wins)}.</i><br>` : '') +
      (rec ? `<i>your heaviest ${esc(dexName(f))}. Selling it keeps the Fishdex number, not the fish.</i><br>` : '') +
      `<i>swims off ${esc(worlds.join(' · ') || 'these waters')}</i>`);
    row.style.display = passes(f) ? '' : 'none';
  }
  function paintMarketFish() {
    const list = $('#marketList'); if (!list) return;
    const pm = F.priceMult('fish'), b = RF.state.bucket || [];
    const rows = $$('.fishrow', list), pack = [];
    rows.forEach(row => {
      const btn = $('[data-sellone]', row);
      const i = btn ? +btn.getAttribute('data-sellone') : -1;
      const f = b[i];
      decorateFishRow(row, f, i, pm);
      if (f) pack.push({ i, f, row });
    });
    reflow(list, pack);
  }
  /* Re-appending rows that are already in the right order would spam the
     MutationObserver forever, so only touch the DOM when the order really moved. */
  function reflow(box, pack) {
    if (pack.length < 2) return;
    const ord = orderIdx(pack);
    for (let i = 0; i < ord.length; i++) if (ord[i].row !== pack[i].row) {
      ord.forEach(p => box.appendChild(p.row));
      return;
    }
  }
  function paintBagFish() {
    const grid = $('#invFish .invgrid'); if (!grid) return;
    const pm = F.priceMult('fish'), b = RF.state.bucket || [];
    const cards = $$('.invcard', grid), pack = [];
    cards.forEach((c, i) => { const f = b[i]; decorateFishRow(c, f, i, pm); if (f) pack.push({ i, f, row: c }); });
    reflow(grid, pack);
  }

  /* ---------------------------------------------------------------- craft planner.
     The requirement text is read back out of the row the core just rendered —
     the engine never exported UP_REQ, and duplicating the ladder in a mod is
     exactly how a mod goes stale. Parse what the shop says instead. */
  const TOOL_R = { rod: 1.75, pick: 1.75, axe: 1.5 };   // upCost / axeCost growth
  const TOOL_LVL = { rod: 'rodLvl', pick: 'pickLvl', axe: 'axeLvl' };
  const TOOL_ICO = { rod: 'rod', pick: 'pick', axe: 'axe' };
  function parseCraftRows() {
    const list = $('#upgList'); if (!list) return [];
    return $$('.fishrow', list).map(row => {
      const btn = $('[data-buy]', row); if (!btn) return null;
      const kind = btn.getAttribute('data-buy'); if (!TOOL_R[kind]) return null;
      const txt = row.textContent || '';
      const seg = (txt.split('needs ')[1] || '').split('·')[0];
      const need = {}; let m; const re = /(\d[\d,]*)\s*([A-Za-z]+)/g;
      while ((m = re.exec(seg))) {
        const k = ORE_BY_NAME[m[2].toLowerCase()];
        if (k) need[k] = (need[k] | 0) + (parseInt(m[1].replace(/,/g, ''), 10) || 0);
      }
      const vv = $('.vv', row);
      const cost = vv ? (parseInt(String(vv.textContent).replace(/[^\d]/g, ''), 10) || 0) : 0;
      const nameM = txt.match(/→\s*([^·]+?)\s*·\s*needs/);
      return { kind, need, cost, next: nameM ? nameM[1].trim() : '', lvl: RF.state[TOOL_LVL[kind]] | 0 };
    }).filter(Boolean);
  }
  function planHTML() {
    const rows = parseCraftRows();
    if (!rows.length) return '<div class="h">Craft planner</div><div class="p3-note">every tool is at Lv.' + MAXLVL + '. Nothing left to want.</div>';
    const coinRate = perMin(sessDelta('earned'));
    let h = '<div class="h">Craft planner · what you are short of</div>';
    let road = [];
    rows.forEach(r => {
      const short = [];
      let worstMin = 0, ready = RF.state.coins >= r.cost;
      let needH = '';
      for (const k in r.need) {
        const have = RF.state.ores[k] | 0, want = r.need[k], miss = Math.max(0, want - have);
        if (miss) ready = false;
        needH += `<span class="p3-need ${miss ? 'no' : 'ok'}">${oreIco(k, 12)} ${have}/${want}</span>`;
        if (miss) {
          const rate = perMin(SESS.ore[k] | 0);
          short.push(miss + ' ' + ORE[k].name);
          worstMin = Math.max(worstMin, rate > 0 ? miss / rate : Infinity);
        }
      }
      const missCoin = Math.max(0, r.cost - RF.state.coins);
      if (missCoin) worstMin = Math.max(worstMin, coinRate > 0 ? missCoin / coinRate : Infinity);
      const eta = ready ? '<span class="eta" style="color:var(--teal)">READY</span>'
        : `<span class="eta" style="color:${worstMin === Infinity ? 'var(--faint)' : 'var(--gold)'}">${worstMin === Infinity ? 'no rate yet' : '~' + etaTxt(worstMin)}</span>`;
      const shortTxt = short.length ? short.join(' + ') : (missCoin ? '◈ ' + fmt(missCoin) : 'nothing');
      h += `<div class="p3-pr" data-p3tip="${attr((r.kind === 'rod'
          ? 'Rod luck bends the catch table toward the top — it does not make bites come sooner. Bait stacks on top of it.'
          : r.kind === 'pick' ? 'A better pick swings faster and pulls more ore per node. It does not change which ore is in the rock.'
          : 'A better axe fells a tree in fewer swings. Wood is a 6-coin commodity — the axe pays for itself in time, not price.')
        + '<br><i>road to Lv.' + MAXLVL + ' from here: ◈' + fmt(roadCost(r)) + ' in coins alone.</i>')}">
        <span class="nm">${pix(TOOL_ICO[r.kind], 14)} ${esc(r.next || r.kind)} <span style="color:var(--faint);font-size:10.5px">Lv.${r.lvl}→${r.lvl + 1}</span>
          <span class="p3-hint">${needH}<span class="p3-need ${missCoin ? 'no' : 'ok'}">◈ ${fmt(RF.state.coins)}/${fmt(r.cost)}</span>${ready ? '' : ' · short ' + esc(shortTxt)}</span></span>
        ${eta}</div>`;
      road.push(pix(TOOL_ICO[r.kind], 11) + ' ◈' + fmt(roadCost(r)));
    });
    h += `<div class="p3-note">the whole road to Lv.${MAXLVL}, coins only: ${road.join(' · ')}
      — ore on top. ${coinRate > 0 ? 'you are earning ◈' + fmt(Math.round(coinRate * 60)) + '/hr this session.' : 'play a couple of minutes and this learns your rate.'}</div>`;
    return h;
  }
  const roadCost = r => {
    const n = MAXLVL - r.lvl, rr = TOOL_R[r.kind];
    if (n <= 0 || !r.cost) return 0;
    return Math.round(r.cost * (Math.pow(rr, n) - 1) / (rr - 1));
  };

  /* ---------------------------------------------------------------- Fishdex */
  const DEXCHIPS = [['all', 'ALL'], ['missing', 'MISSING'], ['caught', 'CAUGHT']];
  const CONDCHIPS = [['night', 'NIGHT'], ['rain', 'RAIN'], ['storm', 'STORM']];
  let dexHead = null;
  function buildDexHead() {
    const root = RF.el('<div class="p3-tools"><div class="p3-haul p3-dexstat"></div>' +
      '<div class="p3-row"><input class="p3-q" type="text" spellcheck="false" placeholder="search species, condition or isle…">' +
      '<span class="p3-dexchips"></span></div></div>', null);
    const q = $('.p3-q', root);
    q.addEventListener('keydown', e => { e.stopPropagation(); if (e.code === 'Escape' || e.code === 'Enter') q.blur(); });
    q.addEventListener('keyup', e => e.stopPropagation());
    q.addEventListener('input', () => { P.dexq = q.value; savePref(); paintDex(); });
    $('.p3-dexchips', root).innerHTML =
      DEXCHIPS.map(c => `<button class="p3-chip sub" data-dex="${c[0]}" type="button">${c[1]}</button>`).join('') +
      '<span class="p3-sep"></span>' +
      CONDCHIPS.map(c => `<button class="p3-chip sub" data-cond="${c[0]}" type="button">${condIco(c[0])} ${c[1]}</button>`).join('') +
      `<button class="p3-chip sub" data-here="1" type="button" data-p3tip="${attr('Only species that swim in the isle you are standing on. The rest need a boat.')}">${pix('island', 10)} HERE</button>`;
    root.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-dex],[data-cond],[data-here]') : null;
      if (!t) return;
      if (t.hasAttribute('data-dex')) P.dex = t.getAttribute('data-dex');
      else if (t.hasAttribute('data-cond')) { const c = t.getAttribute('data-cond'); P.dexCond = P.dexCond === c ? '' : c; }
      else P.dexHere = P.dexHere ? 0 : 1;
      if (RF.sfx && RF.sfx.tab) RF.sfx.tab();
      savePref(); paintDex();
    });
    return { root, q, stat: $('.p3-dexstat', root) };
  }
  function paintDex() {
    const grid = $('#invDex .invgrid');
    if (dexHead) {
      dexHead.q.value = P.dexq;
      $$('[data-dex]', dexHead.root).forEach(b => b.classList.toggle('on', b.getAttribute('data-dex') === P.dex));
      $$('[data-cond]', dexHead.root).forEach(b => b.classList.toggle('on', b.getAttribute('data-cond') === P.dexCond));
      const hb = $('[data-here]', dexHead.root); if (hb) hb.classList.toggle('on', !!P.dexHere);
    }
    const all = RF.ALL_FISH || [], dex = RF.state.dex || {};
    /* completion, per rarity — the number that tells you what to go hunting */
    const tot = {}, got = {};
    RKEYS.forEach(k => { tot[k] = 0; got[k] = 0; });
    all.forEach(e => { const r = e[0].rar; tot[r] = (tot[r] | 0) + 1; if (dex[e[0].name]) got[r] = (got[r] | 0) + 1; });
    const seen = Object.keys(dex).length, pct = all.length ? Math.round(seen / all.length * 100) : 0;
    if (dexHead) {
      dexHead.stat.innerHTML = `<span class="p3-big">${seen}<span style="color:var(--faint);font-size:13px">/${all.length}</span></span>
        <span class="p3-pill" style="color:var(--teal);border-color:rgba(57,215,196,.45)">${pct}% complete</span>
        <span class="sp"></span>
        <div class="p3-dexbars" style="flex:1 1 100%">` +
        RKEYS.map(k => `<div class="p3-dexbar" style="color:${RAR[k]}">${k}<b>${got[k]}/${tot[k]}</b>
          <div class="p3-bar"><i style="width:${tot[k] ? Math.round(got[k] / tot[k] * 100) : 0}%;background:${RAR[k]}"></i></div></div>`).join('') +
        `</div>`;
    }
    if (!grid) return;
    const q = (P.dexq || '').trim().toLowerCase();
    const cards = $$('.invcard', grid);
    cards.forEach((c, i) => {
      const e = all[i]; if (!e) return;
      const t = e[0], cond = e[2] || '', d = dex[t.name], have = !!d;
      const worlds = worldList(t.name);
      /* the hint is the point of the whole tab: WHERE and WHEN, spelled out */
      const nm = $('.inm', c);
      if (nm && !$('.p3-hint', nm)) {
        const bits = [];
        if (cond) bits.push(condIco(cond) + ' ' + condWord(cond));
        if (FWORLD[t.name] && FWORLD[t.name].indexOf(RF.worldKey) >= 0) bits.push('here');
        else if (worlds.length) bits.push(worlds[0] + (worlds.length > 1 ? ' +' + (worlds.length - 1) : ''));
        if (bits.length) nm.insertAdjacentHTML('beforeend', '<span class="p3-hint">' + bits.join(' · ') + '</span>');
      }
      c.setAttribute('data-p3tip', have
        ? `<b>${esc(t.name)}</b> · <span style="color:${RAR[t.rar]}">${esc(t.rar)}</span><br>caught ${d.n}× · record <u>${d.best} kg</u> · base ◈${fmt(t.val)}<br><i>${cond ? 'only bites ' + condWord(cond) + ' · ' : ''}${esc(worlds.join(' · '))}</i>`
        : `<b>not in the dex yet</b><br>${cond ? 'bites <u>' + condWord(cond) + '</u> only' : 'bites in any weather'}<br><i>${esc(worlds.join(' · ') || 'somewhere out there')}</i>`);
      let show = P.dex === 'all' ? true : P.dex === 'caught' ? have : !have;
      if (show && P.dexCond) show = cond === P.dexCond;
      if (show && P.dexHere) show = !!(FWORLD[t.name] && FWORLD[t.name].indexOf(RF.worldKey) >= 0);
      if (show && q) {
        /* a missing species will not give up its name to a search box — but the
           condition and the isle it lives on are exactly what you are hunting for */
        const hay = (have ? t.name + ' ' : '') + cond + ' ' + worlds.join(' ') + ' ' + t.rar;
        show = hay.toLowerCase().indexOf(q) >= 0;
      }
      c.style.display = show ? '' : 'none';
    });
  }

  /* ---------------------------------------------------------------- stats page */
  const STATTIP = [
    ['Fish caught', 'Every fish you have ever landed — the lazy line counts too.'],
    ['Ores mined', 'Ore blocks broken. Selling in one lump pays a bulk bonus: +5% at 20, +10% at 50, +15% at 100.'],
    ['Coins earned', 'Gross, lifetime. Spending never takes it back down, which is why it is the leaderboard number.'],
    ['Roulette spins', 'W·L is wins and losses at the Eel. The eel eats the profits.'],
    ['Biggest win', 'The largest single payout you have taken off the wheel.'],
    ['Pearls earned', 'Activity points. Never bought, never sold — the Pearl Kiosk is the only door they open.'],
    ['Portfolio value', 'What your shares would fetch at the BID right now, spread and fee already taken off.'],
    ['Unrealized', 'Paper only. Nothing is real until you press Sell.'],
    ['Dividends', 'Paid hourly on shares you hold through the quarter, even while you are away.']
  ];
  let statBlk = null;
  function paintStats() {
    if (!statBlk) return;
    const s = RF.state, st = s.stats, all = RF.ALL_FISH || [];
    const sec = SESS.t, dexN = Object.keys(s.dex || {}).length;
    const achN = (RF.ACH || []).filter(a => s.ach[a[0]]).length, achT = (RF.ACH || []).length;
    const deedN = (RF.DEEDS || []).filter(d => s.deeds[d[0]]).length, deedT = (RF.DEEDS || []).length;
    const fishS = sessDelta('caught'), mineS = sessDelta('mined'), earnS = sessDelta('earned'), prlS = sessDelta('pearls');
    const oreS = ORE_KEYS.reduce((a, k) => a + (SESS.ore[k] | 0), 0);
    /* heaviest thing you ever pulled out of the water, whatever became of it */
    let heavy = null;
    for (const n in s.dex) if (!heavy || s.dex[n].best > heavy.kg) heavy = { name: n, kg: s.dex[n].best };
    const pm = F.priceMult('fish');
    let bucketVal = 0; (s.bucket || []).forEach(f => { bucketVal += Math.round(f.val * pm); });
    const tile = (k, v, sub, tip) =>
      `<div class="p3-tile"${tip ? ' data-p3tip="' + attr(tip) + '"' : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    const bar = (n, t, col) => `<div class="p3-bar" style="margin-top:5px"><i style="width:${t ? Math.round(n / t * 100) : 0}%;background:${col}"></i></div>`;
    const cmp = (name, a, b, tip) =>
      `<div class="p3-cmp"${tip ? ' data-p3tip="' + attr(tip) + '"' : ''}><span class="nm">${name}</span><b class="s">${a}</b><b>${b}</b></div>`;

    statBlk.innerHTML =
      `<div class="p3-tiles">
        ${tile('on the isle', hhm(sec), sec > 60 ? 'this session' : 'just arrived', 'Counts only the time the world was actually running — the title screen is free.')}
        ${tile('coins / hr', sec > 25 ? '◈ ' + fmt(Math.round(perMin(earnS) * 60)) : '—', 'this session’s pace', 'Measured off your own earnings since you set sail, not a design target.')}
        ${tile('fish / min', sec > 25 ? perMin(fishS).toFixed(1) : '—', fishS + ' landed', 'Includes anything the auto-rig brought in while you were elsewhere.')}
        ${tile('bucket', fmt(bucketVal), (s.bucket || []).length + '/' + F.cap() + ' · ◈ at today’s prices', 'What the fishmonger would hand you if you walked in right now.')}
      </div>
      <div class="p3-cols"><span>counter</span><span>session</span><span>lifetime</span></div>
      ${cmp(pix('fish', 13) + ' fish landed', fmt(fishS), fmt(st.caught), 'Session is since you pressed Set sail; lifetime survives the browser.')}
      ${cmp(pix('pick', 13) + ' ore mined', fmt(mineS), fmt(st.mined), 'Ore blocks broken. Wood is counted separately below.')}
      ${cmp(pix('wood', 13) + ' ore &amp; wood gathered', fmt(oreS), fmt((st.mined | 0) + (st.wood | 0)), 'Everything that landed in the pouch, wood included — the number the craft planner divides by.')}
      ${cmp('◈ coins earned', fmt(earnS), fmt(st.earned), 'Gross earnings. This is the leaderboard number.')}
      ${cmp('◉ pearls earned', fmt(prlS), fmt(s.pearlsLife), 'Pearls come from activity only. No coin ever turns into one.')}
      <div class="p3-note" style="margin:9px 0 4px">
        heaviest ever: <b style="color:var(--ink)">${heavy ? esc(heavy.name) + ' · ' + heavy.kg + ' kg' : 'nothing yet'}</b>
        · best single spin: <b style="color:var(--gold)">◈ ${fmt(st.bestWin)}</b>
        · the wheel owes you ${st.spins ? Math.round(st.winsCt / Math.max(1, st.spins) * 100) + '% of ' + fmt(st.spins) + ' spins' : 'nothing — you have never played'}
      </div>
      <div class="p3-tiles">
        ${tile('fishdex', dexN + '/' + all.length, bar(dexN, all.length, 'var(--teal)'), 'Every species across every isle, night and storm species included.')}
        ${tile('achievements', achN + '/' + achT, bar(achN, achT, 'var(--gold)'), 'Each one pays coins once, the moment it trips.')}
        ${tile('deeds', deedN + '/' + deedT, bar(deedN, deedT, 'var(--c-epic)'), 'The Ledger tab. No wallet, no chain, no value — a trophy wall with hash cosplay.')}
        ${tile('tools', (s.rodLvl + s.pickLvl + s.axeLvl) + '/' + (MAXLVL * 3), bar(s.rodLvl + s.pickLvl + s.axeLvl, MAXLVL * 3, 'var(--c-rare)'), 'Rod + pick + axe levels together. The Market has the planner for what is next.')}
      </div>`;

    /* and put a plain-language line on each of the core's own stat rows */
    $$('#invStats .statrow').forEach(row => {
      const txt = row.textContent || '';
      for (let i = 0; i < STATTIP.length; i++) {
        if (txt.indexOf(STATTIP[i][0]) >= 0) { row.setAttribute('data-p3tip', STATTIP[i][1]); return; }
      }
    });
  }

  /* ---------------------------------------------------------------- tips on the
     rest of the Market: the rows the core renders that nobody explains anywhere. */
  function decorateMarket() {
    const S = RF.state;
    $$('#oreList .fishrow').forEach(row => {
      const b = $('[data-sellore]', row); if (!b) return;
      const k = b.getAttribute('data-sellore'), n = S.ores[k] | 0, m = F.mktMods();
      const nxt = n < 20 ? 20 : n < 50 ? 50 : n < 100 ? 100 : 0;
      row.setAttribute('data-p3tip',
        `<b>${esc(ORE[k].name)}</b> · ◈${fmt(ORE[k].price)} a piece before demand<br>` +
        `bulk pays +5% at 20, +10% at 50, +15% at 100. ${nxt ? '<u>' + (nxt - n) + ' more</u> to the next tier.' : 'you are at the top tier.'}<br>` +
        `<i>${m.hot === k ? 'HOT right now — sell it.' : m.cold === k ? 'SURPLUS right now — hold if you can.' : 'ordinary demand this rotation.'}</i>`);
    });
    $$('#baitList .fishrow').forEach(row => {
      const b = $('[data-baitbuy]', row); if (!b) return;
      const id = b.getAttribute('data-baitbuy'), bt = (RF.BAITS || {})[id]; if (!bt) return;
      row.setAttribute('data-p3tip',
        `<b>${esc(bt.name)}</b><br>luck <u>+${bt.luck.toFixed(1)}</u> on top of your rod — it thins the commons out and swells the top of the table.<br>` +
        (bt.min ? `floor: nothing under <b>${esc(bt.min)}</b> can even be drawn.<br>` : 'no rarity floor.<br>') +
        `<i>one spent per fish LANDED — a snapped line costs you nothing.</i>`);
    });
    $$('#stockList .fishrow').forEach(row => {
      const b = $('[data-buystk]', row); if (!b) return;
      const k = b.getAttribute('data-buystk'), s = (RF.STOCKS || {})[k]; if (!s) return;
      const e = F.mktEpochNow(), ask = F.stockAsk(k, e), bid = F.stockBid(k, e);
      row.setAttribute('data-p3tip',
        `<b>${esc(k)}</b> — ${esc(s.name)}<br>you buy at <u>◈${fmt(ask)}</u> and sell at <u>◈${fmt(bid)}</u>: a ${Math.round((1 - bid / ask) * 100)}% round trip before the price moves at all.<br>` +
        (s.yield ? `pays <b>${(s.yield * 100).toFixed(1)}%/hr</b> in dividends on quarters you hold through — and three quarters in four actually pay.<br>` : 'pays no dividend. Pure price.<br>') +
        `<i>the price is a function of the wall clock. Nobody is on the other side of the trade.</i>`);
    });
    $$('#kioskList .fishrow').forEach(row => {
      const b = $('[data-kiosk]', row); if (!b) return;
      const id = b.getAttribute('data-kiosk');
      const T = { wardrobe: 'Bought once, recolored forever. Hat band, scarf and vest, any time.',
        chum: 'Ten minutes of bites arriving twice as fast. It does not change WHAT bites.',
        bucket: '+2 bucket slots, permanent. The single best thing pearls buy if you fish far from the Trader.',
        tip: 'Names the NEXT rotation before it lands, so you can be holding the right thing when it flips.',
        pet: 'Purely cosmetic. It follows you everywhere and asks for nothing.',
        charm: 'One losing spin in five is quietly re-rolled at the Eel. It does not make green likelier.' };
      row.setAttribute('data-p3tip', T[id] ||
        'A title, worn over your head where everyone on the isle can read it. Buy once, equip and unequip freely.');
    });
    $$('#bountyList .fishrow').forEach(row => {
      row.setAttribute('data-p3tip',
        'Three objectives, rerolled every market rotation. Progress counts from the moment the bounty was issued — a lifetime counter you already passed does not pay.');
    });
    const bn = $('#mktBanner');
    if (bn) bn.setAttribute('data-p3tip',
      'One category pays ×1.6 and one pays ×0.75, rotating every three minutes. Fish do not spoil: a full bucket held for one rotation is often worth more than a fast sale.');
  }

  /* ---------------------------------------------------------------- section rail */
  const SECS = [['bountyList', 'BOUNTIES'], ['marketList', 'FISH'], ['oreList', 'ORES'],
                ['upgList', 'CRAFT'], ['baitList', 'BAIT'], ['stockList', 'EXCHANGE'], ['kioskList', 'KIOSK']];
  let rail = null, mktCard = null;
  function buildRail() {
    const r = RF.el('<div class="p3-rail"></div>', null);
    r.innerHTML = SECS.map(s => `<button class="p3-chip sub" type="button" data-sec="${s[0]}">${s[1]}</button>`).join('') +
      '<span class="sp" style="flex:1"></span>' +
      `<button class="p3-chip sub" type="button" data-tips="1" data-p3tip="${attr('Turns these explanations off. They come back with the same button.')}">? TIPS</button>`;
    r.addEventListener('click', e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-sec],[data-tips]') : null;
      if (!t || !mktCard) return;
      if (t.hasAttribute('data-tips')) {
        P.tips = P.tips ? 0 : 1; savePref(); hideTip();
        t.classList.toggle('on', !!P.tips);
        F.toast(P.tips ? 'panel tips on' : 'panel tips off');
        return;
      }
      const id = t.getAttribute('data-sec'), node = $('#' + id);
      if (!node) return;
      const target = node.previousElementSibling && node.previousElementSibling.classList.contains('seclab')
        ? node.previousElementSibling : node;
      mktCard.scrollTop += target.getBoundingClientRect().top - mktCard.getBoundingClientRect().top - r.offsetHeight - 10;
      if (RF.sfx && RF.sfx.tab) RF.sfx.tab();
    });
    return r;
  }
  function railActive() {
    if (!rail || !mktCard) return;
    const top = mktCard.getBoundingClientRect().top + rail.offsetHeight + 14;
    let cur = SECS[0][0];
    for (let i = 0; i < SECS.length; i++) {
      const n = $('#' + SECS[i][0]); if (!n) continue;
      if (n.getBoundingClientRect().top <= top) cur = SECS[i][0]; else break;
    }
    $$('[data-sec]', rail).forEach(b => b.classList.toggle('on', b.getAttribute('data-sec') === cur));
    const tb = $('[data-tips]', rail); if (tb) tb.classList.toggle('on', !!P.tips);
  }

  /* ---------------------------------------------------------------- install */
  function install() {
    mktCard = $('#market .card');
    if (mktCard && !rail) {
      const head = $('.card-head', mktCard);
      rail = buildRail();
      if (head && head.nextSibling) mktCard.insertBefore(rail, head.nextSibling); else mktCard.appendChild(rail);
      let raf = 0;
      mktCard.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; railActive(); });
      }, { passive: true });
    }
    const mList = $('#marketList');
    if (mList && !TOOLS.market) {
      TOOLS.market = buildTools('market');
      mList.parentNode.insertBefore(TOOLS.market.root, mList);
    }
    const iFish = $('#invFish');
    if (iFish && !TOOLS.inv) {
      TOOLS.inv = buildTools('inv');
      iFish.parentNode.insertBefore(TOOLS.inv.root, iFish);
    }
    const iDex = $('#invDex');
    if (iDex && !dexHead) { dexHead = buildDexHead(); iDex.parentNode.insertBefore(dexHead.root, iDex); }
    const iStats = $('#invStats');
    if (iStats && !statBlk) {
      statBlk = RF.el('<div class="p3-statblk"></div>', null);
      iStats.parentNode.insertBefore(statBlk, iStats);
    }
    const uList = $('#upgList');
    if (uList && !planBlk) {
      planBlk = RF.el('<div class="p3-blk p3-plan"></div>', null);
      if (uList.nextSibling) uList.parentNode.insertBefore(planBlk, uList.nextSibling);
      else uList.parentNode.appendChild(planBlk);
    }
  }
  let planBlk = null;
  install();

  /* ---------------------------------------------------------------- paint */
  function syncChips(T) {
    if (!T) return;
    if (D.activeElement !== T.q) T.q.value = P.q;
    $$('[data-rar]', T.root).forEach(b => b.classList.toggle('on', b.getAttribute('data-rar') === P.rar));
    $$('[data-tog]', T.root).forEach(b => b.classList.toggle('on', !!P[b.getAttribute('data-tog')]));
    $$('[data-sort]', T.root).forEach(b => {
      const on = b.getAttribute('data-sort') === P.sort;
      b.classList.toggle('on', on);
      const base = (SORTCHIPS.find(c => c[0] === b.getAttribute('data-sort')) || ['', ''])[1];
      b.innerHTML = on ? base + ' ' + (P.dir > 0 ? '▲' : '▼') : base;
    });
  }
  let painting = false;
  function paintAll() {
    if (painting) return;
    painting = true;
    try {
      if (RF.marketOpen) {
        install();
        if (TOOLS.market) {
          syncChips(TOOLS.market);
          TOOLS.market.haul.innerHTML = haulHTML();
          TOOLS.market.sellBox.innerHTML = sellHTML();
          $$('.p3-chip', TOOLS.market.sellBox).forEach(b => { if (selling) b.disabled = true; });
        }
        paintMarketFish();
        if (planBlk) planBlk.innerHTML = planHTML();
        decorateMarket();
        railActive();
      }
      if (RF.invOpen) {
        install();
        const tab = curTab();
        if (TOOLS.inv) { syncChips(TOOLS.inv); TOOLS.inv.haul.innerHTML = haulHTML(); }
        if (tab === 'bag') paintBagFish();
        if (tab === 'dex') paintDex();
        if (tab === 'stats') paintStats();
      }
      cursorApply();
    } catch (e) { RF.warn('03-panels/paint', e); }
    painting = false;
  }

  /* --- observe the core's own re-renders and redecorate after each one ------ */
  const OURS = '.p3-tools,.p3-blk,.p3-rail,.p3-statblk';
  const isOurs = n => !!(n && n.closest && n.closest(OURS));
  function watch(root) {
    if (!root) return;
    const cfg = { childList: true, subtree: true };
    let queued = false;
    const obs = new MutationObserver(recs => {
      if (queued) return;
      // a repaint of our own blocks is not news; only the core's renders are
      let core = false;
      for (let i = 0; i < recs.length; i++) if (!isOurs(recs[i].target)) { core = true; break; }
      if (!core) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        obs.disconnect();              // our own edits must not feed back in
        paintAll();
        obs.observe(root, cfg);
      });
    });
    obs.observe(root, cfg);
    return obs;
  }
  watch($('#market .card'));
  watch($('#inv .card'));

  /* ---------------------------------------------------------------- memory */
  const curTab = () => { const b = $('#inv .tabbtn.sel'); return b ? b.getAttribute('data-tab') : 'bag'; };
  const cardOf = name => $(name === 'market' ? '#market .card' : '#inv .card');
  const scrollKey = name => name === 'market' ? 'market' : 'inv:' + curTab();
  function saveScroll(name) {
    const c = cardOf(name); if (!c) return;
    P.scroll[scrollKey(name)] = c.scrollTop | 0; savePref();
  }
  function restoreScroll(name) {
    const c = cardOf(name); if (!c) return;
    const v = P.scroll[scrollKey(name)] | 0;
    requestAnimationFrame(() => requestAnimationFrame(() => { try { c.scrollTop = v; railActive(); } catch (e) {} }));
  }
  const tabsBox = $('#inv .tabs');
  if (tabsBox) tabsBox.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('.tabbtn') : null;
    if (!b) return;
    saveScroll('inv');                                   // leaving this tab: remember where we were
    setTimeout(() => {
      P.tab = b.getAttribute('data-tab'); savePref();
      cursor.i = -1; paintAll(); restoreScroll('inv');
    }, 0);
  });

  RF.on('panel', (name, open) => {
    try {
      if (name === 'market' || name === 'inventory') {
        const key = name === 'market' ? 'market' : 'inv';
        if (open) {
          install();
          cursor.i = -1;
          /* the core renders the panel AFTER it fires this event, and openInv()
             always slams the tab back to BAG — so everything we want to say
             about which tab and where the scrollbar was has to wait a turn. */
          setTimeout(() => {
            try {
              if (name === 'inventory' && P.tab && P.tab !== 'bag' && F.setInvTab) F.setInvTab(P.tab);
              paintAll(); restoreScroll(key);
            } catch (e) { RF.warn('03-panels/open', e); }
          }, 0);
        } else {
          saveScroll(key); hideTip(); selling = false;
        }
      } else { hideTip(); }
    } catch (e) { RF.warn('03-panels/panel', e); }
  });

  /* ---------------------------------------------------------------- keyboard */
  const cursor = { i: -1 };
  function activeList() {
    if (RF.marketOpen) return $$('#marketList .fishrow').filter(n => n.style.display !== 'none');
    if (RF.invOpen) {
      const t = curTab();
      if (t === 'bag') return $$('#invFish .invcard').filter(n => n.style.display !== 'none');
      if (t === 'dex') return $$('#invDex .invcard').filter(n => n.style.display !== 'none');
    }
    return [];
  }
  function cursorApply() {
    $$('.p3-cur').forEach(n => n.classList.remove('p3-cur'));
    const L = activeList();
    if (cursor.i < 0 || !L.length) return;
    if (cursor.i >= L.length) cursor.i = L.length - 1;
    L[cursor.i].classList.add('p3-cur');
  }
  function moveCur(d) {
    const L = activeList(); if (!L.length) return;
    cursor.i = cursor.i < 0 ? (d > 0 ? 0 : L.length - 1) : Math.max(0, Math.min(L.length - 1, cursor.i + d));
    cursorApply();
    const n = L[cursor.i];
    if (n) { try { n.scrollIntoView({ block: 'nearest' }); } catch (e) {} showTip(n); }
    if (RF.sfx && RF.sfx.click) RF.sfx.click();
  }
  function focusSearch() {
    const T = RF.marketOpen ? TOOLS.market : (curTab() === 'dex' ? dexHead : TOOLS.inv);
    if (T && T.q) { T.q.focus(); T.q.select(); }
  }
  const TABORDER = ['bag', 'dex', 'stats', 'ledger', 'board'];
  RF.on('keydown', e => {
    try {
      if (RF.chatOpen) return false;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
      if (!(RF.marketOpen || RF.invOpen)) return false;
      const k = e.code;
      if (k === 'Slash' || e.key === '/') { e.preventDefault(); focusSearch(); return true; }
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); moveCur(k === 'ArrowDown' ? 1 : -1); return true; }
      if (k === 'Enter') {
        const L = activeList(), n = cursor.i >= 0 ? L[cursor.i] : null;
        if (!n) return false;
        const btn = n.querySelector('.btn:not([disabled])');
        e.preventDefault();
        if (btn) { btn.click(); } else { showTip(n); }
        return true;
      }
      if ((k === 'BracketLeft' || k === 'BracketRight') && RF.invOpen && F.setInvTab) {
        e.preventDefault();
        const i = TABORDER.indexOf(curTab());
        const nx = TABORDER[(i + (k === 'BracketRight' ? 1 : TABORDER.length - 1) + TABORDER.length) % TABORDER.length];
        saveScroll('inv');
        F.setInvTab(nx); P.tab = nx; savePref();
        if (RF.sfx && RF.sfx.tab) RF.sfx.tab();
        cursor.i = -1; paintAll(); restoreScroll('inv');
        return true;
      }
      /* ESC unwinds one layer at a time: the filter first, the panel second */
      if (k === 'Escape') {
        if (P.q && (RF.marketOpen || (RF.invOpen && curTab() === 'bag'))) {
          P.q = ''; savePref(); paintAll(); F.toast('search cleared'); return true;
        }
        if (P.dexq && RF.invOpen && curTab() === 'dex') {
          P.dexq = ''; savePref(); paintDex(); F.toast('search cleared'); return true;
        }
        if (P.rar !== 'all' || P.star || P.rec) {
          P.rar = 'all'; P.star = 0; P.rec = 0; savePref(); paintAll(); F.toast('filters cleared'); return true;
        }
      }
    } catch (err) { RF.warn('03-panels/key', err); }
    return false;
  });

  /* ---------------------------------------------------------------- clocks.
     Only the countdown and the money change on their own; a full repaint once a
     second would fight the mutation observer for no reason. */
  RF.every(1, () => {
    if (!(RF.marketOpen || RF.invOpen) || selling) return;
    const m = F.mktMods();
    ['market', 'inv'].forEach(k => {
      const T = TOOLS[k]; if (!T) return;
      const f = $('.p3-flip', T.haul);
      if (f) f.outerHTML = flipHTML(m);
    });
  });
  /* the planner's ETA only means anything once the meter has a rate */
  RF.every(10, () => { if (RF.marketOpen && planBlk && !selling) planBlk.innerHTML = planHTML(); });

  RF.on('ready', () => { install(); });
  RF.on('start', () => { rebase(); SESS.t = 0; SESS.started = Date.now(); });
});
