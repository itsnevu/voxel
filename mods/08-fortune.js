/* 08-fortune — the Spinning Eel & the Isle Exchange, given a memory and a conscience.
   1. The Eel's Ring — a live 15-pocket map of the wheel; the pockets your bet covers light up.
   2. The Bet Slip — at risk, what it pays, true odds, house edge and expected value, before you commit.
   3. The Board — the last 200 pockets, hot/cold bars, running streaks, and the truth about streaks.
   4. Tonight's Ledger — session and lifetime P/L that never rounds in the house's favour.
   5. The Cool-Off — an opt-in stop for the night that asks once, plainly, then does what you told it.
   6. The Eel's Card — free side calls (pocket · neighbours · colour run) paying chips and rank, never coins.
   7. The Pot — the progressive jackpot with a meter, a record, your own contribution, and a claim moment.
   8. Ticker Cards — real candlesticks, ranges, a moving average, and what actually moves each ticker.
   9. The Book — a portfolio value line, cost basis against the bid, and the spread you must climb.
  10. The Dividend Ledger — every payout logged, the next quarter projected, and a countdown to it.
  11. Watchlist & Alerts — star a ticker, set a price, get told when the clock walks it there.
  12. The Exchange Board — a G-toggled rail: five tickers, the HOT/SURPLUS rotation, your live mark. */
RF.mod('08-fortune', function (RF) {

  const F = RF.fn, S = RF.state, fmt = F.fmt, pix = F.pixSVG, sfx = RF.sfx;
  const TAU = Math.PI * 2;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  const pct = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%';

  /* ---- the wheel, restated ------------------------------------------------
     Core keeps betWins() private, so the slip reproduces it. That is fine: the
     wheel is authoritative server-side and everything below is arithmetic ON a
     settled pocket, never a claim about the next one. ---------------------- */
  const SEG = (RF.SEG && RF.SEG.length) ? RF.SEG
    : (function () { const a = ['green']; for (let i = 1; i < 15; i++) a.push(i % 2 ? 'red' : 'black'); return a; })();
  const NSEG = SEG.length, SEGA = TAU / NSEG;
  const betWins = (bet, i) => { const c = SEG[i];
    if (bet === 'red' || bet === 'black' || bet === 'green') return c === bet;
    if (i === 0) return false;                       // the zero eats every outside bet
    if (bet === 'odd') return i % 2 === 1;
    if (bet === 'even') return i % 2 === 0;
    if (bet === 'high') return i >= 8;
    return false; };
  const betPay = bet => bet === 'green' ? 14 : 2;
  const coverMemo = {};
  const coverOf = bet => { if (coverMemo[bet]) return coverMemo[bet];
    const a = []; for (let i = 0; i < NSEG; i++) if (betWins(bet, i)) a.push(i);
    return (coverMemo[bet] = a); };
  const pkDist = (a, b) => { const d = ((a - b) % NSEG + NSEG) % NSEG; return Math.min(d, NSEG - d); };
  const JACK_CUT = 0.04;                              // core skims this off coin stakes into the pot
  const PKC = { red: '#c0392b', black: '#242a30', green: '#2fae5e' };
  const PKI = { red: '#ff6a6a', black: '#e4ecea', green: '#63e58a' };
  const BETLBL = { red: 'RED', black: 'BLACK', green: 'GREEN', odd: 'ODD', even: 'EVEN', high: 'HIGH 8-14' };

  /* ---- exchange constants the engine keeps to itself ---- */
  const MKT_MS = RF.MKT_MS || 180000, DIV_MS = MKT_MS * 20, STOCK_CAP = 100;
  const SKEYS = (RF.STOCK_KEYS || []).slice();
  const STOCKS = RF.STOCKS || {};
  const eNow = () => F.mktEpochNow();

  /* ---- persistence: mine, never RF.state ---- */
  const KEY = '08-fortune';
  const db = { v: 1, hist: [], chips: 0, potRec: 0, limit: 0, tab: 'board', xtab: '',
    rail: null, div: [], rot: [], watch: {},
    life: { spins: 0, staked: 0, ret: 0, fishRisk: 0, fishLost: 0, fishGain: 0, best: 0, worst: 0, pot: 0, fed: 0 },
    call: { n: 0, hit: 0, nb: 0, run: 0, best: 0, streak: 0 } };
  try {
    const raw = RF.store.get(KEY);
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.hist)) db.hist = raw.hist.filter(n => n >= 0 && n < NSEG).slice(0, 200);
      for (const k of ['chips', 'potRec', 'limit']) if (isFinite(raw[k])) db[k] = Math.max(0, raw[k] | 0);
      if (typeof raw.tab === 'string') db.tab = raw.tab;
      if (typeof raw.xtab === 'string') db.xtab = raw.xtab;
      if (raw.rail === 0 || raw.rail === 1) db.rail = raw.rail;
      if (Array.isArray(raw.div)) db.div = raw.div.slice(0, 60);
      if (Array.isArray(raw.rot)) db.rot = raw.rot.slice(0, 24);
      if (raw.watch && typeof raw.watch === 'object') for (const k in raw.watch)
        if (STOCKS[k]) db.watch[k] = { above: +raw.watch[k].above || 0, below: +raw.watch[k].below || 0 };
      if (raw.life) for (const k in db.life) if (isFinite(raw.life[k])) db.life[k] = raw.life[k] | 0;
      if (raw.call) for (const k in db.call) if (isFinite(raw.call[k])) db.call[k] = raw.call[k] | 0;
    }
  } catch (e) { RF.warn('08-fortune/load', e); }
  let saveT = 0;
  const save = () => { if (saveT) return;                   // one write per burst; localStorage is not free
    saveT = setTimeout(() => { saveT = 0; RF.store.set(KEY, db); }, 500); };

  /* Tonight is this session. Lifetime is everything. Both are shown, always,
     and neither is allowed to quietly forget the losing half. */
  const sess = { spins: 0, staked: 0, ret: 0, fishRisk: 0, fishLost: 0, fishGain: 0,
    best: 0, worst: 0, pot: 0, fed: 0, t0: Date.now() };
  const netOf = t => t.ret + t.pot - t.staked;

  const RANKS = [[0, 'Tourist'], [60, 'Regular'], [200, 'Sharp'], [600, 'Card Counter'], [1500, "The House's Problem"]];
  const rankOf = c => { let r = RANKS[0]; for (const x of RANKS) if (c >= x[0]) r = x; return r[1]; };
  const nextRank = c => { for (const x of RANKS) if (c < x[0]) return x; return null; };

  /* ======================================================================
     STYLE — every rule prefixed .ef so nothing here can reach another mod
     ====================================================================== */
  RF.css(`
  .ef-ring{display:flex;gap:9px;align-items:center;margin:0 0 7px;}
  .ef-wheel{width:92px;height:92px;flex:0 0 auto;overflow:visible;}
  .ef-wheel .efpk{stroke:rgba(0,0,0,.45);stroke-width:.5;cursor:pointer;opacity:.34;transition:opacity .14s,filter .14s;}
  .ef-wheel .efpk.cov{opacity:1;}
  .ef-wheel .efpk.call{stroke:var(--teal);stroke-width:1.4;opacity:1;}
  .ef-wheel .efpk.hit{stroke:var(--gold);stroke-width:1.6;opacity:1;filter:drop-shadow(0 0 3px rgba(255,207,92,.9));}
  .ef-wheel .efhub{fill:rgba(8,16,20,.82);stroke:var(--glass-bd);stroke-width:.6;}
  .ef-wheel .eftx{font:600 5.4px "IBM Plex Mono",monospace;fill:rgba(255,255,255,.82);text-anchor:middle;pointer-events:none;}
  .ef-wheel .efnum{font:700 13px "Chakra Petch",sans-serif;text-anchor:middle;}
  .ef-wheel .efsub{font:400 4.6px "IBM Plex Mono",monospace;fill:var(--faint);text-anchor:middle;letter-spacing:.1em;}
  .ef-rside{flex:1;min-width:0;font-size:11px;line-height:1.55;color:var(--muted);}
  .ef-rside b{color:var(--ink);font-weight:600;}
  .ef-run{display:flex;gap:2px;flex-wrap:wrap;margin-top:4px;}
  .ef-run i{width:8px;height:11px;border-radius:2px;display:block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.4);}
  .ef-slip{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:11px;
    padding:8px 11px;margin-bottom:6px;font-size:11px;color:var(--muted);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .ef-slip .r{display:flex;justify-content:space-between;gap:8px;padding:2px 0;font-variant-numeric:tabular-nums;}
  .ef-slip .r b{color:var(--ink);font-family:"Chakra Petch",sans-serif;font-weight:700;}
  .ef-slip .hd{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;color:var(--ink);
    letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:3px;}
  .ef-slip .ed{color:var(--rose);}.ef-slip .eg{color:var(--teal);}
  .ef-slip .note{font-size:10px;color:#6f8f8a;line-height:1.55;margin-top:5px;letter-spacing:.01em;}
  .ef-mini{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:10px;letter-spacing:.08em;
    padding:4px 8px;border-radius:8px;cursor:pointer;color:var(--muted);
    border:1px solid var(--glass-bd-soft);background:var(--glass-row);}
  .ef-mini:hover:not(:disabled){color:var(--ink);border-color:rgba(57,215,196,.5);}
  .ef-mini:disabled{opacity:.35;cursor:default;}
  .ef-mini.on{color:var(--teal);border-color:rgba(57,215,196,.55);}
  .ef-stop{display:none;border:1px solid var(--rose);border-radius:12px;padding:11px 13px;margin-bottom:7px;
    background:rgba(255,93,122,.08);font-size:11.5px;line-height:1.55;color:var(--ink);}
  .ef-stop.on{display:block;}
  .ef-stop h4{font-family:"Chakra Petch",sans-serif;font-size:13px;color:var(--rose);letter-spacing:.06em;margin-bottom:4px;}
  .ef-stop .row{display:flex;gap:6px;margin-top:8px;}
  .ef-pot{margin-top:6px;border:1px solid rgba(255,207,92,.28);border-radius:11px;padding:8px 11px;
    background:rgba(255,210,79,.06);font-size:10.5px;color:var(--muted);}
  .ef-pot .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;}
  .ef-pot .amt{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:17px;color:var(--gold);
    font-variant-numeric:tabular-nums;}
  .ef-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin:6px 0 4px;}
  .ef-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#ffcf5c,#ff9d5c);}
  .ef-tabs{display:flex;gap:6px;margin:9px 0 7px;}
  .ef-tabs button{flex:1;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:10px;letter-spacing:.13em;
    padding:7px 0;border-radius:9px;cursor:pointer;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--muted);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .ef-tabs button.sel{color:var(--teal);border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.28);}
  .ef-pane{font-size:11px;color:var(--muted);line-height:1.55;}
  .ef-pane .lab{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:8px 0 5px;}
  .ef-tape{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:6px;}
  .ef-tape i{width:13px;height:15px;border-radius:3px;display:flex;align-items:center;justify-content:center;
    font-style:normal;font-size:8px;font-weight:700;color:rgba(255,255,255,.85);box-shadow:inset 0 0 0 1px rgba(0,0,0,.4);}
  .ef-tape i.last{outline:1.5px solid var(--gold);outline-offset:1px;}
  .ef-freq{display:flex;align-items:flex-end;gap:2px;height:44px;margin-bottom:3px;}
  .ef-freq .fb{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;}
  .ef-freq .fb u{display:block;width:100%;border-radius:2px 2px 0 0;text-decoration:none;min-height:1px;}
  .ef-freq .fb s{font-size:7px;color:var(--faint);text-decoration:none;margin-top:2px;}
  .ef-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;
    border-top:1px solid var(--glass-bd-soft);font-variant-numeric:tabular-nums;}
  .ef-row:first-child{border-top:0;}
  .ef-row b{color:var(--ink);font-family:"Chakra Petch",sans-serif;font-weight:700;}
  .ef-good{color:var(--teal);}.ef-bad{color:var(--rose);}.ef-gold{color:var(--gold);}
  .ef-note{font-size:9.5px;color:var(--faint);line-height:1.55;margin-top:7px;}
  .ef-in{width:74px;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink);
    background:rgba(0,0,0,.28);border:1px solid var(--glass-bd-soft);border-radius:7px;padding:4px 7px;}
  .ef-in:focus{outline:none;border-color:var(--teal);}
  /* ---------- market side ---------- */
  .ef-rotstrip{margin-top:7px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:10px;
    padding:8px 12px;font-size:11px;color:var(--muted);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}
  .ef-x{margin-top:4px;}
  .ef-xtabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;}
  .ef-xtabs button{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;letter-spacing:.08em;
    padding:7px 11px;border-radius:9px;cursor:pointer;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--muted);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .ef-xtabs button.sel{color:var(--teal);border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.28);}
  .ef-xtabs button.up{color:#74e08a;}.ef-xtabs button.dn{color:var(--rose);}
  .ef-xtabs button.sel.up,.ef-xtabs button.sel.dn{color:var(--teal);}
  .ef-card{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:12px;padding:13px 15px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .ef-chd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;}
  .ef-chd .t{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:19px;color:var(--ink);letter-spacing:.04em;}
  .ef-chd .n{font-size:11px;color:var(--muted);}
  .ef-chd .p{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:22px;color:var(--gold);
    font-variant-numeric:tabular-nums;text-align:right;line-height:1.1;}
  .ef-cv{width:100%;display:block;margin:10px 0 4px;border-radius:9px;background:rgba(0,0,0,.2);}
  .ef-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:5px;margin-top:7px;}
  .ef-cell{background:rgba(255,255,255,.04);border:1px solid var(--glass-bd-soft);border-radius:8px;padding:6px 9px;}
  .ef-cell .k{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);}
  .ef-cell .v{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:13px;color:var(--ink);
    font-variant-numeric:tabular-nums;}
  .ef-why{font-size:11px;color:var(--muted);line-height:1.6;margin-top:9px;
    border-left:2px solid rgba(57,215,196,.4);padding-left:10px;}
  .ef-why b{color:var(--teal);font-weight:600;}
  .ef-alert{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px;font-size:10.5px;color:var(--faint);}
  .ef-star{cursor:pointer;font-size:14px;line-height:1;color:var(--faint);background:none;border:0;padding:0 2px;}
  .ef-star.on{color:var(--gold);}
  /* ---------- the rail ---------- */
  .ef-rail{position:fixed;top:196px;right:12px;z-index:5;width:184px;padding:8px 10px 7px;
    background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:11px;box-shadow:var(--glass-hi),0 8px 24px rgba(2,8,10,.35);
    font-size:10.5px;color:var(--muted);display:none;}
  .ef-rail.on{display:block;}
  .ef-rail .hd{display:flex;justify-content:space-between;align-items:center;font-family:"Chakra Petch",sans-serif;
    font-weight:700;font-size:9.5px;letter-spacing:.16em;color:var(--faint);margin-bottom:5px;}
  .ef-rail .hd u{text-decoration:none;border:1px solid var(--glass-bd-soft);border-radius:5px;padding:0 4px;font-size:9px;}
  .ef-rr{display:flex;align-items:center;gap:6px;padding:2.5px 0;font-variant-numeric:tabular-nums;}
  .ef-rr .tk{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;color:var(--ink);width:38px;}
  .ef-rr .pr{flex:1;text-align:right;color:var(--ink);}
  .ef-rr .dl{width:50px;text-align:right;font-size:9.5px;}
  .ef-rr .ow{width:22px;text-align:right;font-size:9px;color:var(--teal);}
  .ef-rr.flash{animation:efflash .9s ease-out;}
  .ef-rail .ft{margin-top:5px;padding-top:5px;border-top:1px solid var(--glass-bd-soft);font-size:9.5px;line-height:1.5;}
  @keyframes efflash{0%{background:rgba(57,215,196,.28);}100%{background:transparent;}}
  body.capcam .ef-rail{opacity:0;pointer-events:none;}
  body:has(#start.on) .ef-rail{opacity:0;pointer-events:none;}
  @media (prefers-reduced-motion:no-preference){
    .ef-pot.hot .amt{animation:efpulse 2.4s ease-in-out infinite;}
    @keyframes efpulse{0%,100%{text-shadow:0 0 0 rgba(255,207,92,0);}50%{text-shadow:0 0 14px rgba(255,207,92,.75);}}
  }
  @media (prefers-reduced-motion:reduce){ .ef-rr.flash{animation:none;} }
  `, 'ef-08-fortune-css');

  /* ======================================================================
     1 · THE EEL'S RING — the wheel as a map you can read and click
     ====================================================================== */
  const arc = (i, r0, r1) => { const a0 = i * SEGA - Math.PI / 2, a1 = a0 + SEGA;
    const pt = (a, r) => (40 + Math.cos(a) * r).toFixed(2) + ',' + (40 + Math.sin(a) * r).toFixed(2);
    return 'M' + pt(a0, r1) + ' A' + r1 + ',' + r1 + ' 0 0 1 ' + pt(a1, r1) +
           ' L' + pt(a1, r0) + ' A' + r0 + ',' + r0 + ' 0 0 0 ' + pt(a0, r0) + ' Z'; };
  const ringSVG = (function () {
    let p = '', t = '';
    for (let i = 0; i < NSEG; i++) {
      p += `<path class="efpk" data-pk="${i}" d="${arc(i, 20, 34)}" fill="${PKC[SEG[i]]}"></path>`;
      const a = i * SEGA + SEGA / 2 - Math.PI / 2;
      t += `<text class="eftx" x="${(40 + Math.cos(a) * 27).toFixed(1)}" y="${(40 + Math.sin(a) * 27 + 2).toFixed(1)}">${i}</text>`;
    }
    return `<svg class="ef-wheel" viewBox="0 0 80 80" role="img" aria-label="the fifteen pockets">${p}
      <circle class="efhub" cx="40" cy="40" r="19.2"></circle>
      <text class="efnum" id="efHubN" x="40" y="41">·</text>
      <text class="efsub" x="40" y="49">LAST</text>${t}</svg>`;
  })();

  /* ======================================================================
     casino DOM — everything is inserted around the core nodes, never inside
     one core re-renders, so renderStakes()/renderJackpot() can never eat it
     ====================================================================== */
  const casEl = $('casino'), casCard = casEl ? casEl.querySelector('.card-c') : null;
  const spinBtn = $('spinBtn'), jackBar = $('jackpotBar');
  let ringEl = null, slipEl = null, stopEl = null, potEl = null, tabsEl = null, paneEl = null;

  if (casCard && spinBtn) {
    ringEl = RF.el(`<div class="ef-ring">${ringSVG}<div class="ef-rside" id="efRside"></div></div>`, null);
    slipEl = RF.el('<div class="ef-slip" id="efSlip"></div>', null);
    stopEl = RF.el(`<div class="ef-stop" id="efStop"><h4>you set a stop</h4>
      <div id="efStopBody"></div>
      <div class="row"><button class="ef-mini" data-ef="stop-quit">CALL IT A NIGHT</button>
      <button class="ef-mini" data-ef="stop-lift">LIFT THE STOP</button></div></div>`, null);
    casCard.insertBefore(ringEl, spinBtn);
    casCard.insertBefore(slipEl, spinBtn);
    casCard.insertBefore(stopEl, spinBtn);

    potEl = RF.el('<div class="ef-pot" id="efPot"></div>', null);
    tabsEl = RF.el(`<div class="ef-tabs">
      <button data-eftab="board">BOARD</button><button data-eftab="ledger">LEDGER</button>
      <button data-eftab="card">THE CARD</button></div>`, null);
    paneEl = RF.el('<div class="ef-pane" id="efPane"></div>', null);
    const after = jackBar && jackBar.parentNode === casCard ? jackBar.nextSibling : spinBtn.nextSibling;
    casCard.insertBefore(potEl, after);
    casCard.insertBefore(tabsEl, after);
    casCard.insertBefore(paneEl, after);
  }

  /* current selection is read back off the core DOM — core owns the state,
     this mod only ever describes it */
  const readSel = () => {
    if (!casEl) return { bet: null, coins: 0, fish: null, fishIdx: -1 };
    const b = casEl.querySelector('.betbtn[data-bet].sel');
    const c = casEl.querySelector('[data-cstake].sel');
    const f = casEl.querySelector('.stake.sel');
    const fi = f ? +f.getAttribute('data-stake') : -1;
    return { bet: b ? b.getAttribute('data-bet') : null,
      coins: c ? +c.getAttribute('data-cstake') : 0,
      fish: (fi >= 0 && S.bucket && S.bucket[fi]) ? S.bucket[fi] : null, fishIdx: fi };
  };

  /* the honest arithmetic of a single wager, including the pot when the pot
     is real (offline only — the server pays straight odds and keeps no pot) */
  const potLive = () => RF.online ? 0 : Math.max(0, S.jackpot | 0);
  function slipMath(sel) {
    const bet = sel.bet; if (!bet) return null;
    const n = coverOf(bet).length, p = n / NSEG, pay = betPay(bet);
    const stake = sel.fish ? (sel.fish.val | 0) : (sel.coins | 0);
    const potNow = (bet === 'green' && !sel.fish) ? potLive() + Math.round(stake * JACK_CUT) : 0;
    const ev = stake ? p * ((pay - 1) * stake + potNow) - (1 - p) * stake : 0;
    return { bet, n, p, pay, stake, pot: potNow, ev, isFish: !!sel.fish,
      edge: stake ? ev / stake * 100 : -100 / NSEG };
  }

  let lastPocket = db.hist.length ? db.hist[0] : -1;
  let freeCall = null;      // {mode:'pocket'|'nb', pk}
  let runCall = null;       // {col, got}

  function paintRing() {
    if (!ringEl) return;
    const sel = readSel(), cov = sel.bet ? coverOf(sel.bet) : null;
    const paths = ringEl.querySelectorAll('.efpk');
    for (let i = 0; i < paths.length; i++) {
      const on = !cov || cov.indexOf(i) >= 0;
      const called = !!freeCall && pkDist(freeCall.pk, i) <= (freeCall.mode === 'pocket' ? 0 : 1);
      paths[i].setAttribute('class', 'efpk' + (on ? ' cov' : '') + (called ? ' call' : '') + (i === lastPocket ? ' hit' : ''));
    }
    const hub = ringEl.querySelector('#efHubN');
    if (hub) { hub.textContent = lastPocket >= 0 ? String(lastPocket) : '·';
      hub.setAttribute('fill', lastPocket >= 0 ? PKI[SEG[lastPocket]] : '#5c7a76'); }
    const side = ringEl.querySelector('#efRside');
    if (side) {
      const run = [];
      for (let i = 0; i < Math.min(12, db.hist.length); i++) run.push(db.hist[i]);
      const chips = run.map(i => `<i style="background:${PKC[SEG[i]]}" title="pocket ${i}"></i>`).join('');
      const cf = freeCall ? (freeCall.mode === 'pocket' ? 'calling <b>' + freeCall.pk + '</b> straight'
        : 'calling <b>' + freeCall.pk + '</b> ± 1') : 'click a pocket to call it — free';
      const rc = runCall ? `<br><span style="color:${PKI[runCall.col]}">run: ${runCall.col} ${runCall.got}/3</span>` : '';
      side.innerHTML = `<b>${sel.bet ? BETLBL[sel.bet] : 'no bet yet'}</b>${sel.bet ? ' covers ' + coverOf(sel.bet).length + '/' + NSEG : ''}
        <br><span style="color:#6f8f8a">${cf}</span>${rc}
        <div class="ef-run">${chips || '<span style="color:var(--faint);font-size:9.5px">no spins on the board yet</span>'}</div>`;
    }
  }

  /* ======================================================================
     2 · THE BET SLIP — what you are risking, what it pays, what it costs
     ====================================================================== */
  function paintSlip() {
    if (!slipEl) return;
    const sel = readSel(), m = slipMath(sel);
    const netS = netOf(sess);
    if (!m || !m.stake) {
      slipEl.innerHTML = `<div class="hd"><span>THE SLIP</span>
        <button class="ef-mini" data-ef="rebet" ${lastBet ? '' : 'disabled'}>REBET</button></div>
        <div class="r"><span>pick a stake and a bet</span><b>—</b></div>
        <div class="note">every outside bet covers 7 of 15 pockets and pays ×2 — the eel keeps the difference. ODD is RED in a different hat: the same seven pockets, the same price.</div>`;
      return;
    }
    const edgeCls = m.edge >= 0 ? 'eg' : 'ed';
    const potLine = m.pot ? `<div class="r"><span>plus the pot on GREEN</span><b class="ef-gold">◈ ${fmt(m.pot)}</b></div>` : '';
    const gross = m.stake * m.pay;
    slipEl.innerHTML = `<div class="hd"><span>${BETLBL[m.bet]} · ${m.isFish ? 'FISH' : 'COIN'}</span>
      <button class="ef-mini" data-ef="rebet" ${lastBet ? '' : 'disabled'}>REBET</button></div>
      <div class="r"><span>at risk</span><b>${m.isFish ? esc(sel.fish.name) + ' · ' : ''}◈ ${fmt(m.stake)}</b></div>
      <div class="r"><span>${m.isFish ? 'fish becomes' : 'pays back'}</span><b class="ef-gold">◈ ${fmt(gross)}</b></div>
      <div class="r"><span>true odds</span><b>${m.n} in ${NSEG} · ${(m.p * 100).toFixed(1)}%</b></div>
      ${potLine}
      <div class="r"><span>expected on this spin</span><b class="${edgeCls}">${m.ev >= 0 ? '+' : '−'}◈ ${fmt(Math.abs(m.ev))} · ${pct(m.edge)}</b></div>
      <div class="r"><span>tonight so far</span><b class="${netS >= 0 ? 'eg' : 'ed'}">${netS >= 0 ? '+' : '−'}◈ ${fmt(Math.abs(netS))}</b></div>
      <div class="note">${m.bet === 'green' && !RF.online
        ? 'green is a donation until the pot clears your chip — at ◈' + fmt(m.stake) + ' staked it turns even at a pot of ◈' + fmt(m.stake) + '.'
        : m.isFish ? 'a lost fish is gone from the bucket, not sold. the eel does not pay scrap.'
        : 'the house keeps ◈1 of every ◈15 wagered. that is the whole trick; there is no second one.'}</div>`;
  }

  /* ======================================================================
     5 · THE COOL-OFF — opt-in, asks once, then obeys
     ====================================================================== */
  let stopArmed = false, ackNet = null;
  /* Re-arms only after you fall another whole limit past the point you waved it
     through, so it speaks once per hole rather than nagging every single spin. */
  const tripped = () => db.limit > 0 && netOf(sess) <= -db.limit
    && (ackNet === null || netOf(sess) <= ackNet - db.limit);
  function showStop() {
    if (!stopEl) return;
    const body = stopEl.querySelector('#efStopBody');
    if (body) body.innerHTML = `you told the table to stop you at <b>◈${fmt(db.limit)}</b> down for the night.
      you are <b class="ef-bad">◈${fmt(Math.abs(netOf(sess)))}</b> down across ${sess.spins} spin${sess.spins === 1 ? '' : 's'}.
      the wheel does not owe you the difference back.`;
    stopEl.classList.add('on'); stopArmed = true;
    if (sfx && sfx.deny) sfx.deny();
  }
  const hideStop = () => { if (stopEl) stopEl.classList.remove('on'); stopArmed = false; };

  /* ======================================================================
     7 · THE POT — the progressive jackpot, given drama and an honest label
     ====================================================================== */
  let potSeen = potLive(), potPeak = Math.max(1000, db.potRec);
  function paintPot() {
    if (!potEl) return;
    if (RF.online) {
      potEl.className = 'ef-pot';
      potEl.innerHTML = `<div class="top"><span>THE POT</span><b class="amt">—</b></div>
        <div class="ef-note">online the server pays straight odds and keeps no pot: green is a flat ×14.
        the progressive is an offline house rule.</div>`;
      return;
    }
    const p = potLive(); if (p > potPeak) potPeak = p;
    if (p > db.potRec) { db.potRec = p; save(); }
    const w = clamp(p / Math.max(1, potPeak) * 100, 2, 100);
    potEl.className = 'ef-pot' + (p >= 2000 ? ' hot' : '');
    potEl.innerHTML = `<div class="top"><span>THE POT · paid out on GREEN</span><b class="amt">◈ ${fmt(p)}</b></div>
      <div class="ef-bar"><i style="width:${w.toFixed(1)}%"></i></div>
      <div style="display:flex;justify-content:space-between;gap:8px">
        <span>you have fed it <b style="color:var(--ink)">◈${fmt(db.life.fed)}</b></span>
        <span>record <b style="color:var(--ink)">◈${fmt(db.potRec)}</b></span></div>
      <div class="ef-note">4% of every coin stake goes in here. green pays it all back — which is the only
      moment at this table where the arithmetic is on your side.</div>`;
  }

  /* ======================================================================
     3 · THE BOARD · 4 · THE LEDGER · 6 · THE CARD
     ====================================================================== */
  function paneBoard() {
    const h = db.hist;
    if (!h.length) return `<div class="ef-note">nothing on the board yet. spin once and it starts remembering —
      that is all a board ever does.</div>`;
    const counts = new Array(NSEG).fill(0);
    for (const i of h) counts[i]++;
    let mx = 1, hot = 0, cold = 0;
    for (let i = 0; i < NSEG; i++) { if (counts[i] > mx) mx = counts[i];
      if (counts[i] > counts[hot]) hot = i; if (counts[i] < counts[cold]) cold = i; }
    let bars = '';
    for (let i = 0; i < NSEG; i++) {
      const hgt = Math.round(counts[i] / mx * 34) + 1;
      bars += `<div class="fb" title="pocket ${i} · ${counts[i]}"><u style="height:${hgt}px;background:${PKC[SEG[i]]}"></u><s>${i}</s></div>`;
    }
    let run = 1; for (let i = 1; i < h.length; i++) { if (SEG[h[i]] === SEG[h[0]]) run++; else break; }
    const cols = { red: 0, black: 0, green: 0 }; for (const i of h) cols[SEG[i]]++;
    const tape = h.slice(0, 30).map((i, j) =>
      `<i class="${j === 0 ? 'last' : ''}" style="background:${PKC[SEG[i]]}">${i}</i>`).join('');
    return `<div class="lab">last ${Math.min(30, h.length)} pockets · newest first</div>
      <div class="ef-tape">${tape}</div>
      <div class="lab">where the ball has been · ${h.length} spins remembered</div>
      <div class="ef-freq">${bars}</div>
      <div class="ef-row"><span>hottest / coldest pocket</span><b>${hot} (${counts[hot]}) · ${cold} (${counts[cold]})</b></div>
      <div class="ef-row"><span>red / black / green</span><b>${cols.red} · ${cols.black} · ${cols.green}</b></div>
      <div class="ef-row"><span>running now</span><b style="color:${PKI[SEG[h[0]]]}">${run} × ${SEG[h[0]]}</b></div>
      <div class="ef-note">the wheel has no memory. this board is yours, not its — a hot pocket is a hot pocket
      that already happened. read it for the story, not for the next spin.</div>`;
  }

  function paneLedger() {
    const nS = netOf(sess), nL = netOf(db.life);
    const mins = Math.max(1, Math.round((Date.now() - sess.t0) / 60000));
    const row = (k, v, cls) => `<div class="ef-row"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`;
    /* extrapolating an hourly rate from ninety seconds is exactly the kind of
       number this panel exists to not print — five minutes minimum. */
    const perHr = mins >= 5 ? Math.round(nS / mins * 60) : 0;
    return `<div class="lab">tonight · ${mins} min at the table</div>
      ${row('spins', sess.spins)}
      ${row('coins staked', '◈ ' + fmt(sess.staked))}
      ${row('coins returned', '◈ ' + fmt(sess.ret + sess.pot))}
      ${row('net', (nS >= 0 ? '+' : '−') + '◈ ' + fmt(Math.abs(nS)), nS >= 0 ? 'ef-good' : 'ef-bad')}
      ${mins >= 5 && sess.spins ? row('at this rate', (perHr >= 0 ? '+' : '−') + '◈ ' + fmt(Math.abs(perHr)) + ' / hr', perHr >= 0 ? 'ef-good' : 'ef-bad') : ''}
      ${sess.fishRisk ? row('fish staked / eaten', fmt(sess.fishRisk) + ' / ' + fmt(sess.fishLost)) : ''}
      <div class="lab">all time</div>
      ${row('spins', fmt(db.life.spins))}
      ${row('staked / returned', '◈ ' + fmt(db.life.staked) + ' / ◈ ' + fmt(db.life.ret + db.life.pot))}
      ${row('net', (nL >= 0 ? '+' : '−') + '◈ ' + fmt(Math.abs(nL)), nL >= 0 ? 'ef-good' : 'ef-bad')}
      ${row('best win / worst hole', '◈ ' + fmt(db.life.best) + ' / ◈ ' + fmt(db.life.worst))}
      ${db.life.fishLost ? row('fish the eel has eaten', fmt(db.life.fishLost)) : ''}
      <div class="lab">a stop for the night</div>
      <div class="ef-row"><span>${db.limit ? 'stop me at ◈' + fmt(db.limit) + ' down' : 'no stop set'}</span>
        <span><input class="ef-in" id="efLimIn" type="number" min="0" step="50" value="${db.limit || ''}" placeholder="◈ down">
        <button class="ef-mini" data-ef="lim-set">SET</button>
        <button class="ef-mini" data-ef="lim-clr" ${db.limit ? '' : 'disabled'}>OFF</button></span></div>
      <div class="ef-note">this counts coins only, tonight only, and it counts the losses too.
      the number above is the real one — if it is red, it is red.</div>`;
  }

  function paneCard() {
    const c = db.call, rate = c.n ? (c.hit + c.nb) / c.n * 100 : 0;
    const nx = nextRank(db.chips);
    return `<div class="lab">the eel's card · side calls, no money</div>
      <div class="ef-row"><span>chips</span><b class="ef-gold">${fmt(db.chips)} ◎</b></div>
      <div class="ef-row"><span>rank</span><b>${esc(rankOf(db.chips))}</b></div>
      ${nx ? `<div class="ef-row"><span>next rank</span><b>${esc(nx[1])} at ${fmt(nx[0])} ◎</b></div>` : ''}
      <div class="ef-row"><span>calls made / landed</span><b>${fmt(c.n)} / ${fmt(c.hit + c.nb)} · ${rate.toFixed(0)}%</b></div>
      <div class="ef-row"><span>straight calls landed</span><b>${fmt(c.hit)}</b></div>
      <div class="ef-row"><span>colour runs called</span><b>${fmt(c.run)}</b></div>
      <div class="lab">place a call</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="ef-mini${callMode === 'pocket' ? ' on' : ''}" data-ef="cm-pocket">STRAIGHT · 30 ◎</button>
        <button class="ef-mini${callMode === 'nb' ? ' on' : ''}" data-ef="cm-nb">NEIGHBOURS · 8 ◎</button>
        <button class="ef-mini" data-ef="cm-clear" ${freeCall ? '' : 'disabled'}>CLEAR</button></div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px">
        <button class="ef-mini${runCall && runCall.col === 'red' ? ' on' : ''}" data-ef="run-red">RUN OF RED · 25 ◎</button>
        <button class="ef-mini${runCall && runCall.col === 'black' ? ' on' : ''}" data-ef="run-black">RUN OF BLACK · 25 ◎</button></div>
      <div class="ef-note">pick a mode, then click a pocket on the ring. calls cost nothing and pay nothing —
      chips buy no coins, no fish and no favours. the eel does not make change; it only keeps score.</div>`;
  }

  let callMode = 'pocket';
  function paintPane() {
    if (!paneEl || !tabsEl) return;
    const bs = tabsEl.querySelectorAll('button');
    for (let i = 0; i < bs.length; i++) bs[i].classList.toggle('sel', bs[i].getAttribute('data-eftab') === db.tab);
    paneEl.innerHTML = db.tab === 'ledger' ? paneLedger() : db.tab === 'card' ? paneCard() : paneBoard();
  }

  let lastBet = null;   // {bet, coins, fishIdx} — what REBET replays
  const paintCasino = () => { paintRing(); paintSlip(); paintPot(); paintPane(); };

  /* ---- casino interaction: one delegated listener, bubble phase, so core's
     own handlers have already finished and the DOM tells the truth ---- */
  if (casCard) casCard.addEventListener('click', e => {
    const t = e.target;
    if (t && t.tagName === 'INPUT') return;        // clicking into the limit field must not re-render it away
    const pk = t && t.getAttribute ? t.getAttribute('data-pk') : null;
    if (pk != null) {
      const i = +pk;
      if (freeCall && freeCall.pk === i && freeCall.mode === callMode) freeCall = null;
      else freeCall = { mode: callMode, pk: i };
      if (sfx && sfx.tab) sfx.tab();
      paintCasino(); return;
    }
    const tab = t && t.closest ? t.closest('[data-eftab]') : null;
    if (tab) { db.tab = tab.getAttribute('data-eftab'); save(); if (sfx && sfx.tab) sfx.tab(); paintPane(); return; }
    const act = t && t.closest ? t.closest('[data-ef]') : null;
    if (!act) { paintCasino(); return; }               // a core click (bet / stake) changed the slip
    const a = act.getAttribute('data-ef');
    if (a === 'rebet' && lastBet) {
      const bb = casEl.querySelector('.betbtn[data-bet="' + lastBet.bet + '"]');
      if (lastBet.coins) { const cb = casEl.querySelector('[data-cstake="' + lastBet.coins + '"]'); if (cb) cb.click(); }
      else if (lastBet.fishIdx >= 0) { const fb = casEl.querySelector('.stake[data-stake="' + lastBet.fishIdx + '"]'); if (fb) fb.click(); }
      if (bb) bb.click();
    }
    else if (a === 'cm-pocket') { callMode = 'pocket'; if (freeCall) freeCall.mode = 'pocket'; }
    else if (a === 'cm-nb') { callMode = 'nb'; if (freeCall) freeCall.mode = 'nb'; }
    else if (a === 'cm-clear') freeCall = null;
    else if (a === 'run-red' || a === 'run-black') {
      const col = a === 'run-red' ? 'red' : 'black';
      runCall = (runCall && runCall.col === col) ? null : { col: col, got: 0 };
    }
    else if (a === 'lim-set') {
      const inp = $('efLimIn'), v = inp ? Math.max(0, Math.round(+inp.value || 0)) : 0;
      db.limit = v; ackNet = null; save(); hideStop();
      F.toast(v ? 'stop set · ◈' + fmt(v) + ' down and the table asks you once' : 'stop cleared', v ? 'good' : '');
    }
    else if (a === 'lim-clr') { db.limit = 0; ackNet = null; save(); hideStop(); F.toast('stop cleared', ''); }
    else if (a === 'stop-lift') { db.limit = 0; ackNet = null; save(); hideStop();
      F.toast('stop lifted · it was yours to lift', ''); }
    else if (a === 'stop-quit') { hideStop(); if (F.closeCasino) F.closeCasino(); return; }
    if (sfx && sfx.click) sfx.click();
    paintCasino();
  });

  /* ---- the spin gate: capture phase runs BEFORE core's onclick, which is the
     only moment the purse and the pot are still pre-stake ---- */
  let potAtClick = 0, slipAtClick = null, callAtClick = null;
  if (spinBtn) spinBtn.addEventListener('click', e => {
    if (spinBtn.disabled) return;
    if (tripped() && !stopArmed) { e.preventDefault(); e.stopImmediatePropagation(); showStop(); return; }
    if (stopArmed) ackNet = netOf(sess);           // you looked at the number and chose to keep going
    const sel = readSel();
    potAtClick = potLive();
    slipAtClick = { bet: sel.bet, coins: sel.coins | 0, fishIdx: sel.fishIdx,
      fishVal: sel.fish ? (sel.fish.val | 0) : 0, isFish: !!sel.fish };
    lastBet = { bet: sel.bet, coins: sel.coins | 0, fishIdx: sel.fishIdx };
    callAtClick = freeCall;                            // freeze the call: the ring is live again after
    hideStop();
  }, true);

  /* ---- settlement: pure bookkeeping over an outcome someone else decided ---- */
  RF.on('spin', ev => {
    if (!ev) return;
    const idx = ev.pocket | 0, col = SEG[idx] || ev.color;
    lastPocket = idx;
    db.hist.unshift(idx); if (db.hist.length > 200) db.hist.length = 200;

    const sl = slipAtClick || { bet: ev.bet, coins: ev.coins | 0, isFish: !!ev.fish,
      fishVal: ev.fish ? (ev.fish.val | 0) : 0, fishIdx: -1 };
    const mult = betPay(ev.bet);
    const stake = sl.isFish ? 0 : (sl.coins || ev.coins || 0);
    let ret = 0, pot = 0;
    if (ev.won && !sl.isFish) ret = (ev.payout != null && !ev.fish) ? ev.payout : stake * mult;
    /* offline GREEN also empties the progressive; core zeroed it before this fired,
       so reconstruct it from the pre-click reading plus the cut this stake added */
    if (ev.won && ev.bet === 'green' && !RF.online && potAtClick > 0 && (S.jackpot | 0) === 0)
      pot = potAtClick + Math.round(stake * JACK_CUT);
    const fed = (!RF.online && stake) ? Math.round(stake * JACK_CUT) : 0;

    for (const t of [sess, db.life]) {
      t.spins++; t.staked += stake; t.ret += ret; t.pot += pot; t.fed += fed;
      if (sl.isFish) { t.fishRisk++; if (!ev.won) t.fishLost++; else t.fishGain++; }
      const swing = ret + pot - stake;
      if (swing > t.best) t.best = swing;
      if (-swing > t.worst) t.worst = -swing;
    }

    /* the free card settles on the same pocket, in chips nobody can spend */
    if (callAtClick) {
      db.call.n++;
      const d = pkDist(callAtClick.pk, idx);
      if (callAtClick.mode === 'pocket' && d === 0) { db.call.hit++; db.chips += 30; awardChips(30, 'straight call on ' + idx); }
      else if (callAtClick.mode === 'nb' && d <= 1) { db.call.nb++; db.chips += 8; awardChips(8, 'neighbours of ' + callAtClick.pk); }
      callAtClick = null; freeCall = null;
    }
    if (runCall) {
      if (col === runCall.col) { runCall.got++;
        if (runCall.got >= 3) { db.call.run++; db.chips += 25; awardChips(25, 'a run of three ' + runCall.col); runCall = null; } }
      else runCall = null;
    }
    if (pot) { F.toast(pix('trophy', 13) + ' the pot came home · ◈' + fmt(pot), 'gold'); if (F.addFreeze) F.addFreeze(0.18); }
    slipAtClick = null; potAtClick = 0;
    save();
    if (RF.casinoOpen) paintCasino(); else paintPot();
  });

  let rankSeen = rankOf(db.chips);
  function awardChips(n, why) {
    F.toast(pix('wheel', 13) + ' +' + n + ' ◎ · ' + why, 'good');
    if (sfx && sfx.pearl) sfx.pearl();
    const r = rankOf(db.chips);
    if (r !== rankSeen) { rankSeen = r;
      F.toast(pix('trophy', 13) + ' the card reads <b>' + esc(r) + '</b> now', 'gold');
      if (sfx && sfx.ach) sfx.ach(); }
  }

  /* ======================================================================
     8-11 · THE EXCHANGE — candles, the book, dividends, alerts
     ====================================================================== */
  const WHY = {
    DIGG: 'a pick-and-shovel outfit: it rides <b>coal, iron, gold and diamond</b> demand, so any ore going HOT lifts it ~8% and a SURPLUS ore knocks ~6% off. Middling volatility, a thin dividend.',
    REEL: 'the cannery. It tracks <b>fish</b> and nothing else, so it moves exactly when your bucket does — HOT fish is a good day for both of you.',
    LUMB: 'timber. Follows <b>wood</b> alone, drifts the least of the five, and pays the second-fattest dividend. Dull on purpose.',
    EEL: 'the casino itself. Tracks <b>no commodity at all</b> and pays <b>no dividend</b> — it is pure mood, swinging nearly twice as hard as anything else. Green pockets mint its shares, which tells you who is really long this stock.',
    HARB: 'a shipping line. Tracks <b>nothing</b>, barely moves, and pays the best dividend on the board. You buy it to be bored and paid.'
  };
  const mktEl = $('market'), mktCard = mktEl ? mktEl.querySelector('.card') : null;
  const stockList = $('stockList'), mktBanner = $('mktBanner');
  let rotEl = null, xEl = null, xTabs = null, xBody = null;
  if (mktCard && mktBanner && mktBanner.parentNode) {
    rotEl = RF.el('<div class="ef-rotstrip" id="efRot"></div>', null);
    mktBanner.parentNode.insertBefore(rotEl, mktBanner.nextSibling);
  }
  if (mktCard && stockList && stockList.parentNode) {
    xEl = RF.el('<div class="ef-x"><div class="ef-xtabs" id="efXT"></div><div id="efXB"></div></div>', null);
    stockList.parentNode.insertBefore(xEl, stockList.nextSibling);
    xTabs = xEl.querySelector('#efXT'); xBody = xEl.querySelector('#efXB');
  }
  if (!db.xtab || (db.xtab !== 'book' && !STOCKS[db.xtab])) db.xtab = SKEYS[0] || 'book';

  /* candles: 26 candles of 5 epochs. Every epoch queried is <= now — the price
     function is a pure function of the clock and would happily tell you the
     future, which is exactly why nothing here ever asks it. */
  const CN = 26, CPER = 5;
  function drawCandles(cv, k) {
    const g = cv.getContext ? cv.getContext('2d') : null; if (!g) return;
    const w = Math.max(240, Math.round(cv.clientWidth || 640)), h = 172;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const e = eNow(), cs = []; let lo = Infinity, hi = 0;
    for (let j = 0; j < CN; j++) {
      const end = e - (CN - 1 - j) * CPER;
      let o = 0, c = 0, mn = Infinity, mx = 0;
      for (let s = 0; s < CPER; s++) { const v = F.stockPrice(k, end - (CPER - 1) + s);
        if (s === 0) o = v; c = v; if (v < mn) mn = v; if (v > mx) mx = v; }
      cs.push([o, c, mn, mx]); if (mn < lo) lo = mn; if (mx > hi) hi = mx;
    }
    const pad = Math.max(1, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const L = 42, R = w - 8, T = 10, B = h - 16, Y = v => B - (v - lo) / Math.max(1e-6, hi - lo) * (B - T);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    g.fillStyle = '#5c7a76'; g.font = '9px "IBM Plex Mono",monospace'; g.textAlign = 'right';
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
      g.fillText('◈' + Math.round(v), L - 5, y + 3); }
    const bw = (R - L) / CN;
    for (let j = 0; j < CN; j++) {
      const c = cs[j], up = c[1] >= c[0], x = L + bw * j + bw / 2;
      g.strokeStyle = up ? '#74e08a' : '#ff5d7a'; g.fillStyle = g.strokeStyle; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, Y(c[3])); g.lineTo(Math.round(x) + 0.5, Y(c[2])); g.stroke();
      const y0 = Y(Math.max(c[0], c[1])), y1 = Y(Math.min(c[0], c[1]));
      g.fillRect(Math.round(x - bw * 0.32), Math.round(y0), Math.max(2, Math.round(bw * 0.64)), Math.max(1.5, y1 - y0));
    }
    g.strokeStyle = 'rgba(57,215,196,.75)'; g.lineWidth = 1.4; g.beginPath();
    for (let j = 0; j < CN; j++) {
      let s = 0, n = 0; for (let q = Math.max(0, j - 7); q <= j; q++) { s += cs[q][1]; n++; }
      const x = L + bw * j + bw / 2, y = Y(s / n); j ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const own = (S.stocks && S.stocks.own[k]) | 0, bas = S.stocks && S.stocks.basis[k];
    if (own && bas && bas >= lo && bas <= hi) {
      g.strokeStyle = 'rgba(255,207,92,.65)'; g.lineWidth = 1; g.setLineDash([4, 4]);
      const y = Math.round(Y(bas)) + 0.5; g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#ffcf5c'; g.textAlign = 'left'; g.fillText('your basis', L + 4, y - 4);
    }
    g.fillStyle = '#5c7a76'; g.textAlign = 'left'; g.font = '9px "IBM Plex Mono",monospace';
    g.fillText('6 h · one candle = 15 min · teal line = 2 h average', L, h - 4);
  }

  const holdVal = e => { let v = 0; for (const k of SKEYS) { const n = (S.stocks && S.stocks.own[k]) | 0;
    if (n) v += n * F.stockPrice(k, e); } return v; };
  function drawValueLine(cv) {
    const g = cv.getContext ? cv.getContext('2d') : null; if (!g) return;
    const w = Math.max(240, Math.round(cv.clientWidth || 640)), h = 150;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const e = eNow(), N = 120, pts = []; let lo = Infinity, hi = 0;
    for (let i = N - 1; i >= 0; i--) { const v = holdVal(e - i); pts.push(v); if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi <= 0) { g.fillStyle = '#5c7a76'; g.font = '11px "IBM Plex Mono",monospace'; g.textAlign = 'center';
      g.fillText('no shares yet — the line starts when you own something', w / 2, h / 2); return; }
    const pad = Math.max(1, (hi - lo) * 0.14); lo = Math.max(0, lo - pad); hi += pad;
    const L = 46, R = w - 8, T = 10, B = h - 16, Y = v => B - (v - lo) / Math.max(1e-6, hi - lo) * (B - T);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.fillStyle = '#5c7a76';
    g.font = '9px "IBM Plex Mono",monospace'; g.textAlign = 'right';
    for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3, y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.fillText('◈' + Math.round(v), L - 5, y + 3); }
    const grd = g.createLinearGradient(0, T, 0, B);
    grd.addColorStop(0, 'rgba(57,215,196,.28)'); grd.addColorStop(1, 'rgba(57,215,196,0)');
    g.beginPath(); pts.forEach((v, i) => { const x = L + i / (N - 1) * (R - L), y = Y(v); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.lineTo(R, B); g.lineTo(L, B); g.closePath(); g.fillStyle = grd; g.fill();
    g.beginPath(); pts.forEach((v, i) => { const x = L + i / (N - 1) * (R - L), y = Y(v); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = '#39d7c4'; g.lineWidth = 1.6; g.stroke();
    g.fillStyle = '#5c7a76'; g.textAlign = 'left'; g.font = '9px "IBM Plex Mono",monospace';
    g.fillText('6 h · TODAY’S holdings priced at past marks — not what you actually held', L, h - 4);
  }

  function tickerCard(k) {
    const e = eNow(), s = STOCKS[k], p = F.stockPrice(k, e), prev = F.stockPrice(k, e - 1);
    const ask = F.stockAsk(k, e), bid = F.stockBid(k, e), dl = (p - prev) / Math.max(1, prev) * 100;
    let hi1 = 0, lo1 = Infinity, hi24 = 0, lo24 = Infinity;
    for (let i = 0; i < 480; i++) { const v = F.stockPrice(k, e - i);
      if (v > hi24) hi24 = v; if (v < lo24) lo24 = v;
      if (i < 20) { if (v > hi1) hi1 = v; if (v < lo1) lo1 = v; } }
    const own = (S.stocks && S.stocks.own[k]) | 0, bas = Math.round((S.stocks && S.stocks.basis[k]) || 0);
    const paid = own ? Math.ceil(bas * 1.05) + 2 : 0;              // basis is the MID; you paid the ask
    const evenAt = own ? Math.ceil((paid + 2) / 0.95) : 0;         // bid must reach what you paid
    const away = own && p ? (evenAt - p) / p * 100 : 0;
    const w = db.watch[k] || {};
    const m = F.mktMods(), regime = s.cats && s.cats.indexOf(m.hot) >= 0 ? 'HOT ×1.08'
      : s.cats && s.cats.indexOf(m.cold) >= 0 ? 'SURPLUS ×0.94' : 'neutral';
    return `<div class="ef-card">
      <div class="ef-chd">
        <div><div class="t">${k} <button class="ef-star${db.watch[k] ? ' on' : ''}" data-efw="${k}" title="watchlist">${db.watch[k] ? '★' : '☆'}</button></div>
          <div class="n">${esc(s.name)}</div></div>
        <div><div class="p">◈ ${fmt(p)}</div>
          <div class="n" style="text-align:right;color:${dl >= 0 ? 'var(--teal)' : 'var(--rose)'}">${dl >= 0 ? '▲' : '▼'} ${Math.abs(dl).toFixed(1)}% this epoch</div></div>
      </div>
      <canvas class="ef-cv" data-efcv="${k}" height="172"></canvas>
      <div class="ef-grid">
        <div class="ef-cell"><div class="k">buy / sell</div><div class="v">◈${fmt(ask)} <span style="color:var(--faint)">/</span> ◈${fmt(bid)}</div></div>
        <div class="ef-cell"><div class="k">round trip cost</div><div class="v ef-bad">◈${fmt(ask - bid)} · ${((ask - bid) / Math.max(1, p) * 100).toFixed(0)}%</div></div>
        <div class="ef-cell"><div class="k">last hour</div><div class="v">◈${fmt(lo1)}–${fmt(hi1)}</div></div>
        <div class="ef-cell"><div class="k">last 24 h</div><div class="v">◈${fmt(lo24)}–${fmt(hi24)}</div></div>
        <div class="ef-cell"><div class="k">dividend</div><div class="v">${s.yield ? (s.yield * 100).toFixed(1) + '% / hr' : 'none'}</div></div>
        <div class="ef-cell"><div class="k">regime now</div><div class="v">${regime}</div></div>
        ${own ? `<div class="ef-cell"><div class="k">you hold</div><div class="v">${own} / ${STOCK_CAP}</div></div>
        <div class="ef-cell"><div class="k">break even at</div><div class="v ${away <= 0 ? 'ef-good' : ''}">◈${fmt(evenAt)} · ${away <= 0 ? 'clear' : '+' + away.toFixed(0) + '%'}</div></div>` : ''}
      </div>
      <div class="ef-why">${WHY[k] || 'no notes on this one.'}</div>
      <div class="ef-alert">alert me when it goes
        <input class="ef-in" type="number" min="0" step="1" data-efab="${k}" value="${w.above || ''}" placeholder="above ◈"> or
        <input class="ef-in" type="number" min="0" step="1" data-efbe="${k}" value="${w.below || ''}" placeholder="below ◈">
        <button class="ef-mini" data-ef="alert:${k}">SET</button>
        ${w.above || w.below ? `<span class="ef-good">armed: ${w.above ? '▲◈' + fmt(w.above) : ''}${w.above && w.below ? ' · ' : ''}${w.below ? '▼◈' + fmt(w.below) : ''}</span>` : ''}
      </div>
      <div class="ef-note">price is a function of the wall clock — a slow drift, a mid swing and a per-epoch
      jitter, scaled by this ticker's volatility. Nobody is on the other side of your trade. The spread is
      the only real opponent: ${((ask - bid) / Math.max(1, p) * 100).toFixed(0)}% and ◈4 of fees, every round trip.</div>
    </div>`;
  }

  function bookCard() {
    const e = eNow(); let cost = 0, mark = 0, rows = '';
    for (const k of SKEYS) {
      const n = (S.stocks && S.stocks.own[k]) | 0; if (!n) continue;
      const bas = Math.round((S.stocks && S.stocks.basis[k]) || F.stockPrice(k, e));
      const paid = (Math.ceil(bas * 1.05) + 2) * n, bidv = F.stockBid(k, e) * n;
      cost += paid; mark += bidv;
      const d = bidv - paid;
      rows += `<div class="ef-row"><span><b>${k}</b> × ${n} <span style="color:var(--faint)">· paid ≈◈${fmt(paid)}</span></span>
        <b class="${d >= 0 ? 'ef-good' : 'ef-bad'}">◈${fmt(bidv)} · ${d >= 0 ? '+' : '−'}◈${fmt(Math.abs(d))}</b></div>`;
    }
    if (!rows) rows = '<div class="ef-note">no shares. they drop from diamonds, gold, deep water and green pockets — or you buy them above.</div>';
    const net = mark - cost;
    let proj = 0;
    for (const k of SKEYS) { const n = (S.stocks && S.stocks.own[k]) | 0, s = STOCKS[k];
      if (n && s.yield) proj += n * Math.ceil(F.stockPrice(k, e) * s.yield); }
    const left = DIV_MS - (Date.now() % DIV_MS), mm = Math.floor(left / 60000), ss = Math.floor(left / 1000) % 60;
    const divTot = db.div.reduce((a, d) => a + (d.a | 0), 0);
    const dl = db.div.slice(0, 8).map(d => {
      const ago = Math.max(0, Math.round((Date.now() - d.t) / 60000));
      return `<div class="ef-row"><span>${ago < 60 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago'}</span><b class="ef-gold">+◈${fmt(d.a)}</b></div>`;
    }).join('') || '<div class="ef-note">no dividend has landed while this browser was watching.</div>';
    return `<div class="ef-card">
      <div class="ef-chd"><div><div class="t">THE BOOK</div><div class="n">what the isle owes you, at the bid</div></div>
        <div><div class="p" style="color:${net >= 0 ? 'var(--teal)' : 'var(--rose)'}">${net >= 0 ? '+' : '−'}◈ ${fmt(Math.abs(net))}</div>
          <div class="n" style="text-align:right">unrealised, after the spread</div></div></div>
      <canvas class="ef-cv" data-efcv="__book" height="150"></canvas>
      <div style="margin-top:6px">${rows}</div>
      <div class="ef-grid">
        <div class="ef-cell"><div class="k">what you paid</div><div class="v">◈${fmt(cost)}</div></div>
        <div class="ef-cell"><div class="k">what it fetches</div><div class="v">◈${fmt(mark)}</div></div>
        <div class="ef-cell"><div class="k">next quarter</div><div class="v">${mm}:${String(ss).padStart(2, '0')}</div></div>
        <div class="ef-cell"><div class="k">dividends logged</div><div class="v ef-gold">◈${fmt(divTot)}</div></div>
      </div>
      <div class="ef-note">projected next payout ≈ <b style="color:var(--gold)">◈${fmt(Math.round(proj * 0.75))}</b> if prices hold —
      the board keeps its earnings one quarter in four, so that is the expectation, not a promise.
      The market's own “avg ◈” is the mid price; the figures above use what you actually handed over.</div>
      <div class="lab" style="font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:10px 0 4px">dividend ledger</div>
      ${dl}
    </div>`;
  }

  function paintExchange() {
    if (!xTabs || !xBody) return;
    const e = eNow();
    let th = '';
    for (const k of SKEYS) { const p = F.stockPrice(k, e), pr = F.stockPrice(k, e - 1);
      const up = p >= pr, own = (S.stocks && S.stocks.own[k]) | 0;
      th += `<button data-efx="${k}" class="${db.xtab === k ? 'sel ' : ''}${up ? 'up' : 'dn'}">${k}${own ? ' ·' + own : ''}</button>`; }
    th += `<button data-efx="book" class="${db.xtab === 'book' ? 'sel' : ''}">THE BOOK</button>`;
    xTabs.innerHTML = th;
    xBody.innerHTML = db.xtab === 'book' ? bookCard() : tickerCard(db.xtab);
    const cv = xBody.querySelector('canvas[data-efcv]');
    if (cv) { const k = cv.getAttribute('data-efcv');
      if (k === '__book') drawValueLine(cv); else drawCandles(cv, k); }
  }

  /* ---- 12b · the rotation strip: what HOT means for the stuff you are holding ---- */
  function paintRot() {
    if (!rotEl) return;
    const m = F.mktMods(), left = MKT_MS - (Date.now() % MKT_MS);
    const mm = Math.floor(left / 60000), ss = Math.floor(left / 1000) % 60;
    let bv = 0; for (const f of (S.bucket || [])) bv += f.val | 0;
    const rows = [];
    if (bv) rows.push(['fish', 'bucket · ' + (S.bucket || []).length, bv]);
    for (const k of ['wood', 'coal', 'iron', 'gold', 'diamond']) {
      const n = (S.ores && S.ores[k]) | 0; if (!n || !RF.ORE_INFO[k]) continue;
      rows.push([k, F.catLabel(k) + ' × ' + n, n * RF.ORE_INFO[k].price]);
    }
    let total = 0, atOne = 0, body = '';
    for (const r of rows) { const mult = F.priceMult(r[0]); total += r[2] * mult; atOne += r[2];
      const tag = r[0] === m.hot ? '<span class="ef-good">HOT</span>' : r[0] === m.cold ? '<span class="ef-bad">SURPLUS</span>' : '';
      body += `<div class="ef-row"><span>${esc(r[1])} ${tag}</span><b class="${mult > 1 ? 'ef-good' : mult < 1 ? 'ef-bad' : ''}">◈${fmt(r[2] * mult)}</b></div>`; }
    const swing = Math.round(total - atOne);
    const past = db.rot.slice(0, 5).map(r => `${F.catLabel(r.hot)}▲ ${F.catLabel(r.cold)}▼`).join(' · ');
    rotEl.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
      <span><b class="ef-gold">▲ ${esc(F.catLabel(m.hot))}</b> ×1.6 · <b style="color:#7fb3c9">▼ ${esc(F.catLabel(m.cold))}</b> ×0.75</span>
      <span style="color:var(--faint)">turns in ${mm}:${String(ss).padStart(2, '0')}</span></div>
      ${rows.length ? body + `<div class="ef-row"><span>your stock, right now</span>
        <b class="${swing >= 0 ? 'ef-good' : 'ef-bad'}">◈${fmt(total)} · ${swing >= 0 ? '+' : '−'}◈${fmt(Math.abs(swing))} vs flat</b></div>`
      : '<div class="ef-note">nothing in the bucket or the ore sacks — the rotation costs you nothing today.</div>'}
      ${past ? `<div class="ef-note">last rotations seen: ${esc(past)}</div>` : ''}`;
  }

  /* ---- market clicks (bubble: core's delegated handler has already run) ---- */
  if (xEl) xEl.addEventListener('click', e => {
    const t = e.target;
    const x = t && t.closest ? t.closest('[data-efx]') : null;
    if (x) { db.xtab = x.getAttribute('data-efx'); save(); if (sfx && sfx.tab) sfx.tab(); paintExchange(); return; }
    const w = t && t.closest ? t.closest('[data-efw]') : null;
    if (w) { const k = w.getAttribute('data-efw');
      if (db.watch[k]) delete db.watch[k]; else db.watch[k] = { above: 0, below: 0 };
      save(); if (sfx && sfx.click) sfx.click(); paintExchange(); paintRail(); return; }
    const a = t && t.closest ? t.closest('[data-ef]') : null;
    if (a && a.getAttribute('data-ef').indexOf('alert:') === 0) {
      const k = a.getAttribute('data-ef').slice(6);
      const ab = xBody.querySelector('[data-efab="' + k + '"]'), be = xBody.querySelector('[data-efbe="' + k + '"]');
      const above = ab ? Math.max(0, Math.round(+ab.value || 0)) : 0;
      const below = be ? Math.max(0, Math.round(+be.value || 0)) : 0;
      if (!above && !below) delete db.watch[k]; else db.watch[k] = { above: above, below: below };
      for (const s in fired) if (s.indexOf(k) === 0) fired[s] = 0;
      save(); if (sfx && sfx.click) sfx.click();
      F.toast(above || below ? pix('chart', 13) + ' watching ' + k : 'alerts cleared on ' + k, 'good');
      paintExchange(); paintRail();
    }
  });

  /* ======================================================================
     12 · THE RAIL — the exchange board, toggled with G
     ====================================================================== */
  const ownsAny = () => { for (const k of SKEYS) if ((S.stocks && S.stocks.own[k]) | 0) return true; return false; };
  if (db.rail == null) db.rail = ownsAny() ? 1 : 0;
  const rail = RF.el(`<div class="ef-rail" id="efRail">
    <div class="hd"><span>ISLE EXCHANGE</span><u>G</u></div>
    <div id="efRailRows"></div><div class="ft" id="efRailFt"></div></div>`);
  const railRows = rail ? rail.querySelector('#efRailRows') : null;
  const railFt = rail ? rail.querySelector('#efRailFt') : null;
  const railPrev = {};
  function paintRail() {
    if (!rail) return;
    rail.classList.toggle('on', !!db.rail);
    if (!db.rail) return;
    const e = eNow(); let h = '';
    for (const k of SKEYS) {
      const p = F.stockPrice(k, e), pr = F.stockPrice(k, e - 1), d = (p - pr) / Math.max(1, pr) * 100;
      const own = (S.stocks && S.stocks.own[k]) | 0;
      const fl = railPrev[k] != null && railPrev[k] !== p ? ' flash' : ''; railPrev[k] = p;
      h += `<div class="ef-rr${fl}"><span class="tk">${db.watch[k] ? '<span style="color:var(--gold)">★</span>' : ''}${k}</span>
        <span class="pr">◈${fmt(p)}</span>
        <span class="dl" style="color:${d >= 0 ? 'var(--teal)' : 'var(--rose)'}">${d >= 0 ? '▲' : '▼'}${Math.abs(d).toFixed(1)}%</span>
        <span class="ow">${own || ''}</span></div>`;
    }
    if (railRows) railRows.innerHTML = h;
    if (railFt) {
      const m = F.mktMods(), left = MKT_MS - (Date.now() % MKT_MS);
      const mm = Math.floor(left / 60000), ss = Math.floor(left / 1000) % 60;
      let mark = 0, cost = 0;
      for (const k of SKEYS) { const n = (S.stocks && S.stocks.own[k]) | 0; if (!n) continue;
        mark += F.stockBid(k, e) * n;
        cost += (Math.ceil(Math.round((S.stocks.basis[k] || F.stockPrice(k, e))) * 1.05) + 2) * n; }
      const net = mark - cost;
      railFt.innerHTML = `<span class="ef-gold">▲${esc(F.catLabel(m.hot))}</span> <span style="color:#7fb3c9">▼${esc(F.catLabel(m.cold))}</span>
        <span style="color:var(--faint)">· ${mm}:${String(ss).padStart(2, '0')}</span>
        ${mark ? `<br>book ◈${fmt(mark)} <span class="${net >= 0 ? 'ef-good' : 'ef-bad'}">${net >= 0 ? '+' : '−'}◈${fmt(Math.abs(net))}</span>` : ''}`;
    }
  }

  RF.on('keydown', e => {
    if (e.code !== 'KeyG' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (RF.chatOpen || RF.panelOpen) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    db.rail = db.rail ? 0 : 1; save(); paintRail();
    if (sfx && sfx.tab) sfx.tab();
    F.toast(db.rail ? pix('chart', 13) + ' exchange board on' : 'exchange board off', db.rail ? 'good' : '');
    return true;                                  // claimed — G is ours only when nothing else has focus
  });

  /* ======================================================================
     clocks: epoch rotation, alerts, dividend logging, live repaints
     ====================================================================== */
  const fired = {};
  function checkAlerts(e) {
    for (const k in db.watch) {
      const w = db.watch[k]; if (!w || !STOCKS[k]) continue;
      const p = F.stockPrice(k, e);
      if (w.above && p >= w.above) { if (!fired[k + 'a']) { fired[k + 'a'] = 1;
        F.toast(pix('chart', 13) + ' ' + k + ' ◈' + fmt(p) + ' · above your ◈' + fmt(w.above), 'gold');
        if (sfx && sfx.pearl) sfx.pearl(); } } else fired[k + 'a'] = 0;
      if (w.below && p <= w.below) { if (!fired[k + 'b']) { fired[k + 'b'] = 1;
        F.toast(pix('chart', 13) + ' ' + k + ' ◈' + fmt(p) + ' · under your ◈' + fmt(w.below), 'bad');
        if (sfx && sfx.pearl) sfx.pearl(); } } else fired[k + 'b'] = 0;
    }
  }
  let epochSeen = eNow(), divSeen = (S.stats && S.stats.divEarned) | 0;
  { const m0 = F.mktMods(); if (!db.rot.length || db.rot[0].e !== epochSeen)
      db.rot.unshift({ e: epochSeen, hot: m0.hot, cold: m0.cold }); }
  const typing = () => !!(xBody && document.activeElement && xBody.contains(document.activeElement));
  RF.every(2, () => {
    const e = eNow();
    if (e !== epochSeen) {
      epochSeen = e;
      const m = F.mktMods();
      db.rot.unshift({ e: e, hot: m.hot, cold: m.cold }); if (db.rot.length > 24) db.rot.length = 24;
      checkAlerts(e); save();
      if (RF.marketOpen) { paintRot(); if (!typing()) paintExchange(); }
    }
    const d = (S.stats && S.stats.divEarned) | 0;
    if (d > divSeen) { db.div.unshift({ t: Date.now(), a: d - divSeen });
      if (db.div.length > 60) db.div.length = 60; divSeen = d; save();
      if (RF.marketOpen && db.xtab === 'book' && !typing()) paintExchange(); }
    else if (d < divSeen) divSeen = d;             // a server adopt can reset the counter
    if (db.rail && !RF.panelOpen) paintRail();
    if (RF.marketOpen) paintRot();
    const p = potLive();
    if (p !== potSeen) { potSeen = p; if (RF.casinoOpen) paintPot(); }
  });
  /* while a panel is open the numbers must stay live without touching the frame */
  RF.every(0.5, () => { if (RF.casinoOpen) { paintSlip(); paintRing(); } });

  RF.on('panel', (name, open) => {
    if (name === 'casino') {
      if (open) { hideStop(); paintCasino(); }
      else { freeCall = null; save(); }
    } else if (name === 'market' && open) { paintRot(); paintExchange(); }
  });
  let railHinted = false;
  RF.on('share', ev => {
    if (!ev) return;
    if (!db.rail && !railHinted && ownsAny()) { railHinted = true;
      F.toast(pix('chart', 13) + ' press <b>G</b> for the exchange board', 'good'); }
    if (RF.marketOpen) paintExchange();
    paintRail();
  });
  RF.on('ready', () => { paintRail(); paintRot(); });

  /* first paint — the panels are closed, so this is cheap and keeps the DOM honest */
  paintCasino(); paintRail(); paintRot();
  if (xTabs) paintExchange();
});
