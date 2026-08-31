/* 02-hud — the read-at-a-glance layer: numbers that move, effects you can see,
   messages that queue instead of flood, and a nudge that knows what you need.
   1.  Living counters — coins & pearls roll to their new value, every change flies a ±chip.
   2.  Bucket meter — a fill bar under the count that ambers at three-quarters and burns at full.
   3.  Status rail — one pill per live effect (chum, hot market, weather, vein, rig, dark) with real timers.
   4.  Toast director — one managed stack: repeats fold into ×N, gold jumps the queue, never more than four.
   5.  Messages — nothing is lost; L (or the chip) replays the backlog with an unread count.
   6.  World floats — +ore over the rock you broke, ◈ over the bobber, ◉ over your own head.
   7.  Waypoint ring — edge chevrons to trader, casino, harbor, portal and the X, with distance.
   8.  Bite forecast — what the clock and the weather are actually putting in the water tonight.
   9.  Action bars — the hint line's ▰▱ blocks become real progress bars.
   10. Richer minimap — hillshaded base, live ore, peers, a facing wedge and a pulsing X.
   Every strip is individually switchable through RF.api.hud, so a settings panel
   can drive them without knowing anything about how they are built. */
RF.mod('02-hud', function (RF) {
  const S = RF.state, F = RF.fn, fmt = F.fmt, pix = F.pixSVG, TAU = RF.TAU || Math.PI * 2;
  const clamp = F.clamp, byId = function (id) { return document.getElementById(id); };
  /* Continuous motion is the only thing reduced-motion actually objects to; a
     number settling once is information, so those stay either way. */
  let calm = false;
  try { calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
  /* one beat shared by everything that is running out: it knocks faster the
     closer you stand, and holds still when the player asked for stillness. */
  const urg = function (d) { return clamp(1 - d / 40, 0.15, 1); };
  const beat = function (u) {
    if (calm || document.body.classList.contains('rf-reduced')) return 1;   // 10-comfort may flip this mid-session
    return 0.55 + 0.45 * Math.sin(RF.clock * (2 + u * 6)); };

  const mmss = function (sec) { sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const ago = function (ms) { const s = Math.round((Date.now() - ms) / 1000);
    return s < 5 ? 'now' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };
  const dist = function (p) { return p ? Math.round(Math.hypot(p.x - RF.pWorld.x, p.z - RF.pWorld.z)) : 0; };
  /* MINE_POS, CRATER_POS and meteors landed on the reference table after this
     mod shipped, so every read is a fresh guarded one and an older game.js
     simply draws one marker fewer. */
  const nearMeteor = function () {
    const m = RF.meteors;
    if (!m || !m.length) return null;
    let best = null, bd = 1e9;
    for (let i = 0; i < m.length; i++) { const q = m[i];
      if (!q || !isFinite(q.x) || !isFinite(q.z)) continue;
      const d = Math.hypot(q.x - RF.pWorld.x, q.z - RF.pWorld.z);
      if (d < bd) { bd = d; best = q; } }
    return best; };
  const METEOR_LIFE = 95;     // mirrors the life the strike is born with in game.js §13c
  /* One broken strip must never take the other nine with it. */
  const guard = function (name, fn) { try { fn(); } catch (e) { RF.warn('02-hud/' + name, e); } };

  /* ---- persisted switches + the nudge snooze, one record ---- */
  const STORE = '02-hud';
  const SECTIONS = [
    { id: 'counters',  label: 'rolling counters & gain chips' },
    { id: 'rail',      label: 'status effect rail' },
    { id: 'toasts',    label: 'managed toast stack' },
    { id: 'floats',    label: 'floating world numbers' },
    { id: 'waypoints', label: 'waypoint chevrons' },
    { id: 'forecast',  label: 'bite forecast' },
    { id: 'nudge',     label: 'what-next nudge' },
    { id: 'hintbars',  label: 'hint progress bars' },
    { id: 'minimap',   label: 'enhanced minimap' }
  ];
  const DEF = { counters: 1, rail: 1, toasts: 1, floats: 1, waypoints: 1, forecast: 1, nudge: 1, hintbars: 1, minimap: 1 };
  const cfg = {}; for (const k in DEF) cfg[k] = DEF[k];
  let snoozeUntil = 0;
  guard('load', function () {
    const s = RF.store.get(STORE, null); if (!s) return;
    if (s.cfg) for (const k in DEF) if (s.cfg[k] === 0 || s.cfg[k] === 1) cfg[k] = s.cfg[k];
    snoozeUntil = +s.snooze || 0;
  });
  const persist = function () { RF.store.set(STORE, { cfg: cfg, snooze: snoozeUntil }); };

  /* ---------------------------------------------------------------- styling */
  RF.css(`
  .hd-l{position:fixed;pointer-events:none;}
  .hd-glass{background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);
    -webkit-backdrop-filter:blur(14px) saturate(1.6);border:1px solid var(--glass-bd);
    border-radius:11px;box-shadow:var(--glass-hi),0 8px 24px rgba(2,8,10,.35);}
  .hd-off{display:none!important;}

  /* 1 · counters ---------------------------------------------------------- */
  .hd-delta{position:fixed;z-index:21;pointer-events:none;font-family:"Chakra Petch",sans-serif;
    font-weight:700;font-size:13px;letter-spacing:.02em;white-space:nowrap;
    text-shadow:0 2px 8px rgba(2,8,10,.85);animation:hd-fall .95s cubic-bezier(.2,.7,.3,1) forwards;}
  .hd-delta.up{color:var(--teal);} .hd-delta.dn{color:var(--rose);} .hd-delta.gold{color:var(--gold);}
  @keyframes hd-fall{0%{opacity:0;transform:translate(-50%,-6px) scale(.82);}
    18%{opacity:1;transform:translate(-50%,2px) scale(1.06);}
    100%{opacity:0;transform:translate(-50%,20px) scale(.96);}}
  .hd-pop{animation:hd-pop .32s ease;}
  @keyframes hd-pop{0%{transform:scale(1);}42%{transform:scale(1.09);}100%{transform:scale(1);}}

  /* 2 · bucket meter ------------------------------------------------------ */
  #hud-bucket{position:fixed;overflow:hidden;}
  .hd-fill{position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--teal);
    box-shadow:0 0 8px currentColor;color:var(--teal);transition:width .35s ease,background .35s,color .35s;}
  .hd-fill.warn{background:var(--gold);color:var(--gold);}
  .hd-fill.hot{background:var(--rose);color:var(--rose);}

  /* 3 + 8 · status rail and forecast --------------------------------------
     one left column, clear of the minimap and the auto-rig chip above it; the
     rail stacks urgency-first and the forecast card rides underneath it */
  .hd-col{left:12px;top:300px;width:196px;z-index:5;display:flex;flex-direction:column;gap:8px;}
  .hd-rail{display:flex;flex-direction:column;gap:6px;}
  .hd-fx{display:flex;gap:7px;align-items:center;padding:5px 8px 6px;position:relative;overflow:hidden;
    font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--ink);
    animation:hd-in .28s cubic-bezier(.2,.8,.2,1);}
  @keyframes hd-in{from{opacity:0;transform:translateX(-10px);}to{opacity:1;transform:none;}}
  .hd-fx .hd-fi{display:flex;align-items:center;flex:0 0 auto;opacity:.95;}
  .hd-fx .hd-ft{flex:1;min-width:0;line-height:1.25;}
  .hd-fx .hd-ft b{display:block;font-family:"Chakra Petch",sans-serif;font-size:10.5px;letter-spacing:.09em;
    text-transform:uppercase;color:inherit;}
  .hd-fx .hd-ft i{display:block;font-style:normal;font-size:9px;color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .hd-fx .hd-fc{font-family:"Chakra Petch",sans-serif;font-size:10px;font-variant-numeric:tabular-nums;
    color:var(--muted);flex:0 0 auto;}
  .hd-fx .hd-fb{position:absolute;left:0;bottom:0;height:2px;background:currentColor;opacity:.75;
    transition:width .5s linear;}
  .hd-fx.t{color:var(--teal);border-color:rgba(57,215,196,.42);}
  .hd-fx.g{color:var(--gold);border-color:rgba(255,207,92,.42);}
  .hd-fx.r{color:var(--rose);border-color:rgba(255,93,122,.42);}
  .hd-fx.b{color:#57b7ff;border-color:rgba(87,183,255,.42);}
  .hd-fx.p{color:#c490ff;border-color:rgba(196,144,255,.42);}
  .hd-cast{padding:8px 11px 9px;}
  .hd-cast .hd-c1{display:flex;align-items:center;gap:6px;font-family:"Chakra Petch",sans-serif;
    font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;}
  .hd-cast .hd-c1 em{margin-left:auto;font-style:normal;font-family:"IBM Plex Mono",monospace;
    font-size:10px;letter-spacing:.04em;color:var(--muted);font-variant-numeric:tabular-nums;}
  .hd-cast .hd-c2{font-size:10px;line-height:1.4;color:var(--muted);margin-top:3px;}
  .hd-cast .hd-c2 b{color:var(--ink);font-weight:600;}
  .hd-cast .hd-c3{font-size:9.5px;line-height:1.4;margin-top:4px;padding-top:4px;
    border-top:1px solid var(--glass-bd-soft);color:var(--faint);}
  .hd-cast .hd-c3 b{font-weight:600;}

  /* 4 · toast stack ------------------------------------------------------- */
  .hd-toasts{left:50%;bottom:134px;transform:translateX(-50%);z-index:20;display:flex;
    flex-direction:column;gap:6px;align-items:center;}
  /* the stack is deliberately NOT .hud: core's #toasts still speaks over the
     title screen, so ours must too — it only bows out of the camera modes */
  body.photo .hd-toasts,body.capcam .hd-toasts,
  body.photo .hd-delta,body.capcam .hd-delta{opacity:0!important;pointer-events:none!important;}
  .hd-t{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;padding:7px 14px;
    border-radius:10px;background:var(--glass-strong);backdrop-filter:blur(14px) saturate(1.6);
    -webkit-backdrop-filter:blur(14px) saturate(1.6);border:1px solid var(--glass-bd);
    box-shadow:var(--glass-hi),0 6px 18px rgba(2,8,10,.35);color:var(--ink);white-space:nowrap;
    max-width:min(78vw,560px);overflow:hidden;animation:hd-tin .26s cubic-bezier(.2,.8,.2,1);}
  .hd-t .hd-tm{overflow:hidden;text-overflow:ellipsis;}
  .hd-t.out{animation:hd-tout .3s ease forwards;}
  @keyframes hd-tin{from{opacity:0;transform:translateY(10px) scale(.96);}to{opacity:1;transform:none;}}
  @keyframes hd-tout{to{opacity:0;transform:translateY(-9px) scale(.98);}}
  .hd-t.good{border-color:var(--teal);color:var(--teal);}
  .hd-t.gold{border-color:var(--gold);color:var(--gold);box-shadow:var(--glass-hi),0 0 22px rgba(255,207,92,.2),0 6px 18px rgba(2,8,10,.35);}
  .hd-t.bad{border-color:var(--rose);color:var(--rose);}
  .hd-t .hd-tn{font-family:"Chakra Petch",sans-serif;font-size:11px;font-weight:700;
    background:rgba(255,255,255,.12);border-radius:6px;padding:1px 6px;flex:0 0 auto;
    font-variant-numeric:tabular-nums;}

  /* 5 · messages ---------------------------------------------------------- */
  .hd-logbtn{position:fixed;right:12px;bottom:48px;z-index:21;pointer-events:auto;cursor:pointer;
    display:flex;gap:7px;align-items:center;font-family:"IBM Plex Mono",monospace;font-size:10px;
    letter-spacing:.12em;color:var(--muted);background:var(--glass);border:1px solid var(--glass-bd-soft);
    backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:9px;padding:6px 10px;}
  .hd-logbtn:hover{border-color:var(--teal);color:var(--ink);}
  .hd-logbtn b{color:var(--teal);font-weight:700;}
  .hd-logbtn .hd-badge{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:10px;color:var(--teal-ink);
    background:var(--teal);border-radius:5px;padding:0 5px;letter-spacing:0;display:none;}
  .hd-logbtn.unread .hd-badge{display:inline-block;}
  .hd-log{right:12px;bottom:86px;z-index:22;width:min(340px,44vw);max-height:46vh;display:none;
    flex-direction:column;pointer-events:auto;overflow:hidden;}
  .hd-log.on{display:flex;}
  .hd-log .hd-lh{display:flex;justify-content:space-between;align-items:center;padding:9px 12px 7px;
    font-family:"Chakra Petch",sans-serif;font-size:11px;letter-spacing:.18em;text-transform:uppercase;
    color:var(--teal);border-bottom:1px solid var(--glass-bd-soft);}
  .hd-log .hd-lh span{font-family:"IBM Plex Mono",monospace;font-size:9px;letter-spacing:.1em;color:var(--faint);}
  .hd-log .hd-lb{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px;}
  .hd-log .hd-lb::-webkit-scrollbar{width:4px;}
  .hd-log .hd-lb::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px;}
  .hd-le{display:flex;gap:8px;align-items:baseline;font-size:11px;line-height:1.4;color:var(--ink);
    padding:4px 8px;border-left:2px solid var(--glass-bd-soft);border-radius:0 7px 7px 0;
    background:var(--glass-row);}
  .hd-le.good{border-left-color:var(--teal);} .hd-le.gold{border-left-color:var(--gold);}
  .hd-le.bad{border-left-color:var(--rose);}
  .hd-le .hd-lt{font-size:9px;color:var(--faint);flex:0 0 26px;text-align:right;font-variant-numeric:tabular-nums;}
  .hd-le .hd-lm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
  .hd-le .hd-lm .pix{vertical-align:-2px;}
  .hd-le .hd-ln{font-family:"Chakra Petch",sans-serif;font-size:10px;color:var(--muted);}
  .hd-log .hd-lf{padding:6px 12px 8px;font-size:9px;letter-spacing:.08em;color:var(--faint);
    border-top:1px solid var(--glass-bd-soft);text-align:center;}

  /* 6 · world-space floats ------------------------------------------------ */
  .hd-floats{inset:0;z-index:6;overflow:hidden;}
  .hd-f{position:absolute;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:14px;
    white-space:nowrap;text-shadow:0 2px 9px rgba(2,8,10,.9),0 0 14px rgba(2,8,10,.6);
    will-change:transform,opacity;}
  .hd-f .pix{vertical-align:-2px;margin-right:1px;}

  /* 7 · waypoints --------------------------------------------------------- */
  .hd-wp{inset:0;z-index:5;}
  .hd-w{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:center;gap:1px;
    opacity:0;transition:opacity .3s ease;will-change:transform;}
  .hd-w.on{opacity:.92;}
  .hd-w.near{opacity:.45;}
  .hd-w .hd-wi{width:26px;height:26px;border-radius:9px;display:flex;align-items:center;justify-content:center;
    background:var(--glass-hud);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border:1px solid currentColor;box-shadow:0 0 12px currentColor,0 4px 12px rgba(2,8,10,.4);position:relative;}
  .hd-w .hd-wc{position:absolute;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
    border-bottom:7px solid currentColor;top:-9px;left:50%;transform-origin:50% 22px;}
  .hd-w .hd-wd{font-family:"Chakra Petch",sans-serif;font-size:9.5px;font-weight:700;color:inherit;
    background:rgba(4,12,15,.62);border-radius:5px;padding:0 4px;font-variant-numeric:tabular-nums;
    text-shadow:0 1px 4px rgba(0,0,0,.8);}

  /* 9 · hint action bars -------------------------------------------------- */
  .hd-bar{display:inline-block;vertical-align:0;width:88px;height:7px;border-radius:4px;margin:0 3px;
    background:rgba(255,255,255,.11);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);
    position:relative;overflow:hidden;}
  .hd-bar::after{content:'';position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);border-radius:4px;
    background:linear-gradient(90deg,var(--teal),#8ef7c9);box-shadow:0 0 9px rgba(57,215,196,.55);}
  .hd-bar.hot::after{background:linear-gradient(90deg,var(--gold),#ffe9a8);box-shadow:0 0 9px rgba(255,207,92,.55);}
  .hd-bar.max::after{background:linear-gradient(90deg,var(--rose),#ff9db0);box-shadow:0 0 10px rgba(255,93,122,.6);}

  /* 10 · nudge ------------------------------------------------------------ */
  .hd-nudge{right:12px;bottom:86px;z-index:19;width:min(300px,42vw);padding:9px 12px;
    pointer-events:auto;cursor:pointer;opacity:0;transform:translateY(8px);
    transition:opacity .4s ease,transform .4s cubic-bezier(.2,.8,.2,1);}
  .hd-nudge.on{opacity:1;transform:none;}
  .hd-nudge .hd-nk{font-family:"IBM Plex Mono",monospace;font-size:8.5px;letter-spacing:.3em;
    color:var(--teal);margin-bottom:3px;}
  .hd-nudge .hd-nt{font-size:11.5px;line-height:1.45;color:var(--ink);}
  .hd-nudge .hd-nt b{color:var(--gold);font-weight:600;}
  .hd-nudge:hover{border-color:rgba(57,215,196,.55);}

  @media (prefers-reduced-motion: reduce){
    .hd-fx,.hd-t,.hd-delta{animation-duration:.01ms!important;}
    .hd-nudge,.hd-w{transition:none;}
  }
  `, 'hd-css-02-hud');

  /* ======================================================================
     1 + 2 — LIVING COUNTERS, GAIN CHIPS, BUCKET METER
     The two headline numbers are re-written from the frame hook while a tween
     runs, which always lands AFTER core's updateHUD() in the same frame, so we
     win the number without ever removing core's nodes.
     ====================================================================== */
  const counters = [];
  let bucketFill = null, bucketP = -1;
  guard('counters', function () {
    const mk = function (id, anchorId, read, render, gold) {
      const el = byId(id), anchor = byId(anchorId);
      if (!el || !anchor) return;
      const v = read();
      counters.push({ el: el, anchor: anchor, read: read, render: render, gold: gold, shown: v, target: v });
    };
    mk('coinVal', 'hud-coins', function () { return S.coins || 0; }, function (v) { return fmt(v); }, true);
    mk('pearlVal', 'hud-pearls', function () { return S.pearls || 0; }, function (v) { return '◉ ' + fmt(v); }, false);
    const bk = byId('hud-bucket');
    if (bk) bucketFill = RF.el('<i class="hd-fill"></i>', bk);
  });

  const chip = function (anchor, text, cls) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const r = anchor.getBoundingClientRect();
    if (!r.width) return;
    const d = RF.el('<div class="hd-delta ' + cls + '">' + text + '</div>');
    d.style.left = (r.left + r.width / 2) + 'px';
    d.style.top = (r.bottom + 2) + 'px';
    setTimeout(function () { d.remove(); }, 1000);
  };

  /* the ore row is five identical grey pills — without a flash you can never
     tell which one just moved */
  const oreRow = [];
  guard('orerow', function () {
    const ids = { wood: 'oreW', coal: 'oreC', iron: 'oreI', gold: 'oreG', diamond: 'oreD' };
    for (const k in ids) { const el = byId(ids[k]);
      if (el) oreRow.push({ k: k, el: el, chipEl: el.parentNode || el, last: S.ores[k] | 0 }); }
  });

  const tickCounters = function (dt) {
    for (let i = 0; i < counters.length; i++) {
      const c = counters[i], v = c.read();
      if (v !== c.target) {
        const d = v - c.target;
        chip(c.anchor, (d > 0 ? '+' : '−') + fmt(Math.abs(d)), d < 0 ? 'dn' : (c.gold ? 'gold' : 'up'));
        c.target = v;
      }
      if (Math.abs(c.shown - c.target) > 0.5) {
        c.shown += (c.target - c.shown) * (1 - Math.exp(-9 * dt));
        if (Math.abs(c.shown - c.target) < 0.6) c.shown = c.target;
        c.el.textContent = c.render(Math.round(c.shown));
      } else if (c.shown !== c.target) { c.shown = c.target; c.el.textContent = c.render(c.target); }
    }
    for (let i = 0; i < oreRow.length; i++) {
      const o = oreRow[i], v = S.ores[o.k] | 0;
      if (v !== o.last) {
        chip(o.chipEl, (v > o.last ? '+' : '−') + fmt(Math.abs(v - o.last)), v < o.last ? 'dn' : 'up');
        o.chipEl.classList.remove('hd-pop'); void o.chipEl.offsetWidth; o.chipEl.classList.add('hd-pop');
        o.last = v;
      }
    }
    if (bucketFill) {
      const cap = F.cap(), n = S.bucket.length, p = cap > 0 ? clamp(n / cap, 0, 1) : 0;
      if (p !== bucketP) { bucketP = p;
        bucketFill.style.width = (p * 100) + '%';
        bucketFill.className = 'hd-fill' + (p >= 1 ? ' hot' : p >= 0.75 ? ' warn' : ''); }
    }
  };

  /* ======================================================================
     3 — STATUS RAIL
     Every timed thing the game currently keeps to itself: the chum you paid
     eighty pearls for, the market window about to close, the vein that goes
     cold in four seconds. One pill each, sorted by urgency.
     ====================================================================== */
  const colEl = RF.el('<div class="hd-l hd-col hud"></div>');
  const railEl = RF.el('<div class="hd-rail"></div>', colEl);
  const rows = Object.create(null);
  let railKey = '';
  let combo = 0, comboT = 0;
  const COMBO_WINDOW = 6.5;   // mirrors oreComboT in game.js §13
  const CHUM_MS = 600000;     // Chum Jar duration, from the kiosk purchase

  RF.on('mined', function (m) { if (m && m.combo) { combo = m.combo; comboT = COMBO_WINDOW; } });

  const activeBait = function () {
    const b = RF.BAITS ? RF.BAITS[S.baitId] : null;
    return (b && (S.bait[S.baitId] | 0) > 0) ? b : null;
  };

  const effects = function () {
    const out = [], now = Date.now();
    const chum = (S.boosts && S.boosts.chumUntil ? S.boosts.chumUntil : 0) - now;
    if (chum > 0) out.push({ id: 'chum', tone: 't', ic: pix('fish', 13), name: 'chum', sub: 'bites twice as fast',
      time: mmss(chum / 1000), pct: chum / CHUM_MS, u: chum / 1000 });
    if (comboT > 0) out.push({ id: 'vein', tone: 'g', ic: pix('pick', 13), name: 'vein ×' + combo,
      sub: 'chain it, it pays', time: comboT.toFixed(1) + 's', pct: comboT / COMBO_WINDOW, u: comboT });
    const met = nearMeteor();
    if (met) out.push({ id: 'meteor', tone: 'r', ic: pix('ore', 13), name: 'meteorite',
      sub: met.landed ? dist(met) + 'm off · hold E on it' : 'still falling',
      time: met.life > 0 ? mmss(met.life) : '', pct: clamp((met.life || 0) / METEOR_LIFE, 0, 1), u: 1000 });
    guard('rail-mkt', function () {
      const m = F.mktMods(), left = RF.MKT_MS - (now % RF.MKT_MS);
      const held = m.hot === 'fish' ? S.bucket.length : (S.ores[m.hot] | 0);
      out.push({ id: 'hot', tone: 'g', ic: pix('chart', 13), name: F.catLabel(m.hot) + ' 1.6×',
        sub: held > 0 ? 'you hold ' + fmt(held) : F.catLabel(m.cold) + ' is a surplus',
        time: mmss(left / 1000), pct: left / RF.MKT_MS, u: 900 });
    });
    const w = RF.weather;
    if (w && w !== 'clear') {
      const wm = { rain: ['b', 'rain', 'bites 35% faster'], storm: ['r', 'storm', 'rare fish stir'],
        snow: ['b', 'snow', 'the ice fish rise'], ash: ['r', 'rain', 'the vents are venting'] }[w] || ['b', 'rain', ''];
      out.push({ id: 'wx', tone: wm[0], ic: pix(w === 'storm' ? 'storm' : 'rain', 13), name: wm[1], sub: wm[2], time: '', pct: 0, u: 800 });
    }
    if (RF.autoFish && RF.autoFish.on) out.push({ id: 'rig', tone: 't', ic: pix('rod', 13), name: 'auto-rig',
      sub: 'cheap fish · F stops', time: '', pct: 0, u: 700 });
    const b = activeBait();
    if (b) out.push({ id: 'bait', tone: 'p', ic: pix('gem', 13), name: b.name,
      sub: b.min ? b.min + '+ only' : 'no floor, just luck', time: '×' + (S.bait[S.baitId] | 0), pct: 0, u: 600 });
    if (F.isNight() && !RF.WORLD.cave) out.push({ id: 'night', tone: 'b', ic: pix('moon', 13), name: 'dark water',
      sub: 'night species are up', time: '', pct: 0, u: 500 });
    guard('rail-derby', function () {
      const d = byId('derby');
      if (d && d.classList.contains('on') && d.classList.contains('live'))
        out.push({ id: 'derby', tone: 'g', ic: pix('trophy', 13), name: 'derby live', sub: 'heaviest fish takes it', time: '', pct: 0, u: 950 });
    });
    out.sort(function (a, b2) { return b2.u - a.u; });
    return out.slice(0, 6);
  };

  const paintRail = function () {
    if (!RF.running || !cfg.rail) { railEl.classList.add('hd-off'); return; }
    railEl.classList.remove('hd-off');
    const fx = effects();
    let key = ''; for (let i = 0; i < fx.length; i++) key += fx[i].id + '|';
    if (key !== railKey) {
      railKey = key;
      let h = '';
      for (let i = 0; i < fx.length; i++) { const e = fx[i];
        h += '<div class="hd-fx hd-glass ' + e.tone + '" data-fx="' + e.id + '">'
          + '<span class="hd-fi">' + e.ic + '</span>'
          + '<span class="hd-ft"><b>' + e.name + '</b><i>' + e.sub + '</i></span>'
          + '<span class="hd-fc"></span><i class="hd-fb"></i></div>'; }
      railEl.innerHTML = h;
      for (const k in rows) delete rows[k];
      const nodes = railEl.children;
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i];
        rows[n.getAttribute('data-fx')] = { c: n.querySelector('.hd-fc'), b: n.querySelector('.hd-fb'),
          n: n.querySelector('.hd-ft b'), s: n.querySelector('.hd-ft i') }; }
    }
    for (let i = 0; i < fx.length; i++) { const e = fx[i], r = rows[e.id];
      if (!r) continue;
      if (r.c.textContent !== e.time) r.c.textContent = e.time;
      r.b.style.width = (clamp(e.pct, 0, 1) * 100) + '%';
      if (r.n.textContent !== e.name) r.n.textContent = e.name;
      if (r.s.textContent !== e.sub) r.s.textContent = e.sub; }
  };

  /* ======================================================================
     4 + 5 — TOAST DIRECTOR AND MESSAGES
     Core builds the toast and emits it; we adopt the payload, drop core's node
     and render our own, so we own dwell, order and grouping. Every other
     'toast' listener still sees the original event exactly once, first — and
     if the strip is switched off, core's own stack simply keeps working.
     ====================================================================== */
  const toastEl = RF.el('<div class="hd-l hd-toasts"></div>');
  const MAXLIVE = 4;
  const queue = [], liveT = [];
  const PRI = { gold: 3, bad: 2, good: 1, '': 0 };
  const logbook = [];
  let unread = 0, logOpen = false;

  const logbtn = RF.el('<button class="hd-logbtn hud" type="button"><b>L</b> MESSAGES <span class="hd-badge">0</span></button>');
  const logEl = RF.el('<div class="hd-l hd-log hd-glass hud">'
    + '<div class="hd-lh">Messages <span></span></div><div class="hd-lb"></div>'
    + '<div class="hd-lf">everything the isle told you, newest first</div></div>');
  const logBody = logEl.querySelector('.hd-lb'), logCount = logEl.querySelector('.hd-lh span');
  const badge = logbtn.querySelector('.hd-badge');

  const paintBadge = function () {
    logbtn.classList.toggle('unread', unread > 0);
    badge.textContent = unread > 99 ? '99+' : String(unread);
  };
  const paintLog = function () {
    let h = '';
    for (let i = logbook.length - 1, seen = 0; i >= 0 && seen < 70; i--, seen++) { const e = logbook[i];
      h += '<div class="hd-le ' + (e.k || '') + '"><span class="hd-lt">' + ago(e.t) + '</span>'
        + '<span class="hd-lm">' + e.m + '</span>'
        + (e.n > 1 ? '<span class="hd-ln">×' + e.n + '</span>' : '') + '</div>'; }
    logBody.innerHTML = h || '<div class="hd-le"><span class="hd-lm" style="color:var(--faint)">nothing yet · go make some noise</span></div>';
    logCount.textContent = logbook.length + ' entries';
  };
  const setLog = function (on) {
    logOpen = !!on; logEl.classList.toggle('on', logOpen);
    if (logOpen) { unread = 0; paintBadge(); paintLog(); nudgeEl.classList.remove('on'); nudgeHideAt = 0; }
  };
  logbtn.addEventListener('click', function () { try { F.beep(720, .035, 'square', .03); } catch (e) {} setLog(!logOpen); });
  logEl.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.hd-lb')) return;
    setLog(false); });

  const remember = function (m, k) {
    const last = logbook[logbook.length - 1];
    if (last && last.m === m && Date.now() - last.t < 4000) { last.n++; last.t = Date.now(); }
    else { logbook.push({ t: Date.now(), m: m, k: k || '', n: 1 }); if (logbook.length > 140) logbook.shift();
      if (!logOpen) unread++; }
    paintBadge();
    if (logOpen) paintLog();
  };

  const spawnToast = function (item) {
    const d = RF.el('<div class="hd-t ' + (item.k || '') + '"><span class="hd-tm">' + item.m + '</span>'
      + '<b class="hd-tn" style="display:none">×1</b></div>', toastEl);
    item.el = d; item.nEl = d.querySelector('.hd-tn');
    item.until = RF.clock + item.dwell;
    if (item.n > 1 && item.nEl) { item.nEl.style.display = ''; item.nEl.textContent = '×' + item.n; }
    liveT.push(item);
  };
  const bump = function (item) {
    item.n++; item.until = Math.min(item.until + 0.45, RF.clock + 5.5);
    if (item.nEl) { item.nEl.style.display = ''; item.nEl.textContent = '×' + item.n; }
  };
  const ingest = function (m, k) {
    const kind = k || '';
    for (let i = 0; i < liveT.length; i++) if (liveT[i].m === m && !liveT[i].dead) { bump(liveT[i]); remember(m, kind); return; }
    for (let i = 0; i < queue.length; i++) if (queue[i].m === m) { queue[i].n++; remember(m, kind); return; }
    const item = { m: m, k: kind, n: 1, pri: PRI[kind] || 0, dwell: kind === 'gold' ? 3.4 : 2.4, el: null, nEl: null, dead: false };
    remember(m, kind);
    if (liveT.length < MAXLIVE) spawnToast(item);
    else { queue.push(item); queue.sort(function (a, b) { return b.pri - a.pri; }); if (queue.length > 24) queue.length = 24; }
  };
  /* prio 80: run late, so any mod that wants the raw toast (or wants to claim
     it outright) has already had its turn on the untouched element. */
  RF.on('toast', function (m, k, el) {
    if (!cfg.toasts || !el || !el.parentNode) return;
    const html = el.innerHTML; el.remove();
    guard('toast', function () { ingest(html, k); });
  }, 80);

  const tickToasts = function () {
    const now = RF.clock;
    for (let i = liveT.length - 1; i >= 0; i--) { const t = liveT[i];
      if (!t.dead && now >= t.until) { t.dead = true; if (t.el) t.el.classList.add('out');
        const el = t.el; setTimeout(function () { if (el) el.remove(); }, 320); }
      if (t.dead && now >= t.until + 0.34) liveT.splice(i, 1); }
    let free = MAXLIVE - liveT.length;
    while (free-- > 0 && queue.length) spawnToast(queue.shift());
  };

  /* achievements deserve a line even when the toast that carried them was one
     of a hundred that minute */
  RF.on('ach', function (id, name, rw) { remember(pix('trophy', 13) + ' ' + name + ' · +◈' + fmt(rw || 0), 'gold'); });

  /* ======================================================================
     6 — WORLD-SPACE FLOATS
     Numbers belong over the thing that made them. Pooled divs, one hoisted
     vector, projection in the frame hook, nothing allocated per frame.
     ====================================================================== */
  const floatsEl = RF.el('<div class="hd-l hd-floats hud"></div>');
  const POOLN = 22, pool = [], _v = new RF.THREE.Vector3();
  for (let i = 0; i < POOLN; i++) {
    const el = RF.el('<div class="hd-f"></div>', floatsEl);
    el.style.display = 'none';
    pool.push({ el: el, live: false, t: 0, life: 1.5, x: 0, y: 0, z: 0, rise: 0 });
  }
  let poolAt = 0;
  const floatAt = function (x, y, z, html, col, big) {
    if (!cfg.floats) return;
    let f = null;
    for (let i = 0; i < POOLN; i++) { const c = pool[(poolAt + i) % POOLN]; if (!c.live) { f = c; poolAt = (poolAt + i + 1) % POOLN; break; } }
    if (!f) { f = pool[poolAt]; poolAt = (poolAt + 1) % POOLN; }   // steal the oldest slot rather than drop the news
    f.live = true; f.t = 0; f.life = big ? 1.9 : 1.45; f.x = x; f.y = y; f.z = z;
    f.rise = big ? 62 : 44;
    f.el.innerHTML = html; f.el.style.color = col; f.el.style.fontSize = big ? '17px' : '14px';
    f.el.style.display = '';
  };
  const bobberPos = function () {
    const b = RF.bobber;
    if (b && b.visible) return b.position;
    return RF.player ? RF.player.position : RF.pWorld;
  };
  RF.on('catch', function (f) { if (!f) return;
    const p = bobberPos();
    floatAt(p.x, (p.y || 0) + 0.6, p.z, '◈ ' + fmt(f.val || 0), f.shiny ? '#ffd24f' : (RF.RAR[f.rar] || '#b9c6c4'), RF.RORDER[f.rar] >= 2 || !!f.shiny); });
  RF.on('mined', function (m) { if (!m || !m.node) return;
    const o = RF.ORE_INFO[m.type] || { name: m.type, dot: '#cfd8d6' };
    floatAt(m.node.x, (m.node.y || 0) + 1.0, m.node.z, '+' + m.got + ' ' + o.name, o.dot, !!m.geode); });
  RF.on('chopped', function (c) { if (!c || !c.tree) return;
    floatAt(c.tree.x, (c.tree.y || 0) + 2.2, c.tree.z, '+' + c.got + ' Wood', '#9a6b3a', false); });
  RF.on('pearls', function (n) { if (!(n > 0)) return;
    const p = RF.pWorld; floatAt(p.x, p.y + 2.6, p.z, '+' + n + ' ◉', '#39d7c4', n >= 8); });
  RF.on('dug', function () { const p = RF.pWorld; floatAt(p.x, p.y + 1.6, p.z, pix('map', 13) + ' dug', '#ffcf5c', true); });
  /* Online, mining resolves on the server and never fires 'mined' — the "+3 Iron"
     toast is the only signal there, so read that instead. */
  const ORE_TOAST = /^\+(\d+)\s+(Wood|Coal|Iron|Gold|Diamond)\b/;
  RF.on('toast', function (m, k, el) {
    if (!el || !RF.online) return;
    const txt = String(m).replace(/<[^>]*>/g, '').trim(), r = ORE_TOAST.exec(txt);
    if (!r) return;
    const key = r[2].toLowerCase(), o = RF.ORE_INFO[key];
    const p = RF.pWorld; floatAt(p.x, p.y + 2.1, p.z, '+' + r[1] + ' ' + r[2], o ? o.dot : '#cfd8d6', false);
  }, 79);

  const tickFloats = function (dt) {
    const W = window.innerWidth, H = window.innerHeight, cam = RF.camera;
    for (let i = 0; i < POOLN; i++) { const f = pool[i];
      if (!f.live) continue;
      f.t += dt;
      if (f.t >= f.life) { f.live = false; f.el.style.display = 'none'; continue; }
      const u = f.t / f.life;
      _v.set(f.x, f.y, f.z); _v.project(cam);
      const sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H - u * f.rise;
      if (sx < -140 || sx > W + 140 || sy < -80 || sy > H + 80) { f.el.style.opacity = '0'; continue; }
      f.el.style.opacity = String(u < 0.12 ? u / 0.12 : u > 0.72 ? (1 - u) / 0.28 : 1);
      f.el.style.transform = 'translate(' + (sx | 0) + 'px,' + (sy | 0) + 'px) translate(-50%,-100%) scale('
        + (u < 0.14 ? 0.7 + u / 0.14 * 0.3 : 1).toFixed(3) + ')'; }
  };

  /* ======================================================================
     7 — WAYPOINT RING
     An isometric camera never turns, so a compass ribbon would be a static
     picture. Edge chevrons are the honest version: direction plus distance,
     clamped inside a rectangle that keeps clear of every other HUD corner.
     ====================================================================== */
  const wpEl = RF.el('<div class="hd-l hd-wp hud"></div>');
  const WPS = [];
  guard('waypoints', function () {
    const add = function (pos, icon, col, label) { if (!pos) return;
      const el = RF.el('<div class="hd-w" style="color:' + col + '">'
        + '<span class="hd-wi"><i class="hd-wc"></i>' + pix(icon, 14) + '</span>'
        + '<span class="hd-wd">0m</span></div>', wpEl);
      WPS.push({ pos: pos, el: el, chev: el.querySelector('.hd-wc'), d: el.querySelector('.hd-wd'),
        label: label, shownD: -1, cls: '' }); };
    add(RF.TRADER_POS, 'chart', '#ffcf5c', 'trader');
    add(RF.CASINO_POS, 'wheel', '#ff5d7a', 'the eel');
    add(RF.HARBOR_POS, 'boat', '#39d7c4', 'harbor');
    add(RF.PORTAL_POS, 'island', '#c490ff', 'portal');
    /* the mine mouth and the lava crater are per-world and may be absent, so
       they hold a slot and resolve it every frame instead of at load */
    const live = function (key, icon, col, label, extra) {
      const el = RF.el('<div class="hd-w" style="color:' + col + '">'
        + '<span class="hd-wi"><i class="hd-wc"></i>' + pix(icon, 14) + '</span>'
        + '<span class="hd-wd">0m</span></div>', wpEl);
      const w = { pos: null, key: key, el: el, chev: el.querySelector('.hd-wc'), d: el.querySelector('.hd-wd'),
        label: label, shownD: -1, cls: '' };
      /* the beat is written per frame, so the fade this class carries has to go */
      if (extra && extra.meteor) el.style.transition = 'none';
      if (extra) for (const k in extra) w[k] = extra[k];
      WPS.push(w); };
    live('MINE_POS', 'pick', '#e8f4ff', 'the shaft');
    live('CRATER_POS', 'sun', '#ff7a1a', 'the crater');
    live(null, 'ore', '#ff8a3a', 'meteorite', { meteor: true });
    /* the X moves with the save, so it gets a slot filled per frame */
    const el = RF.el('<div class="hd-w" style="color:#ffd24f">'
      + '<span class="hd-wi"><i class="hd-wc"></i>' + pix('map', 14) + '</span>'
      + '<span class="hd-wd">0m</span></div>', wpEl);
    WPS.push({ pos: null, treasure: true, el: el, chev: el.querySelector('.hd-wc'),
      d: el.querySelector('.hd-wd'), label: 'the X', shownD: -1, cls: '' });
  });
  const _tp = { x: 0, y: 0, z: 0 };
  let wpTextT = 0;

  const tickWaypoints = function (dt) {
    if (!RF.running || RF.panelOpen || !cfg.waypoints) { if (!wpEl.classList.contains('hd-off')) wpEl.classList.add('hd-off'); return; }
    wpEl.classList.remove('hd-off');
    const W = window.innerWidth, H = window.innerHeight, cam = RF.camera;
    const L = 238, R = W - 152, T = 100, B = H - 152;
    const cx = (L + R) / 2, cy = (T + B) / 2;
    wpTextT -= dt; const doText = wpTextT <= 0; if (doText) wpTextT = 0.25;
    for (let i = 0; i < WPS.length; i++) { const w = WPS[i];
      let p = w.pos;
      if (w.key) {
        const q = RF[w.key];
        if (!q || !isFinite(q.x) || !isFinite(q.z)) { if (w.cls !== 'off') { w.cls = 'off'; w.el.className = 'hd-w'; } continue; }
        _tp.x = q.x; _tp.z = q.z;
        _tp.y = isFinite(q.y) ? q.y + 1.2 : F.heightAt(q.x, q.z) + 1.2; p = _tp;
      } else if (w.meteor) {
        const m = nearMeteor();
        if (!m) { if (w.cls !== 'off') { w.cls = 'off'; w.el.className = 'hd-w'; w.el.style.opacity = ''; } continue; }
        _tp.x = m.x; _tp.z = m.z;
        _tp.y = (isFinite(m.gy) ? m.gy : F.heightAt(m.x, m.z)) + 1.4; p = _tp;
      }
      if (w.treasure) {
        const tr = S.treasure;
        if (!tr || tr.w !== RF.worldKey) { if (w.cls !== 'off') { w.cls = 'off'; w.el.className = 'hd-w'; } continue; }
        _tp.x = tr.i - RF.HALF; _tp.z = tr.j - RF.HALF;
        _tp.y = F.heightAt(_tp.x, _tp.z) + 1.2; p = _tp;
      }
      if (!p) continue;
      const d = Math.hypot(p.x - RF.pWorld.x, p.z - RF.pWorld.z);
      _v.set(p.x, p.y, p.z); _v.project(cam);
      let sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
      const inside = sx >= L && sx <= R && sy >= T && sy <= B;
      let ang = 0;
      if (!inside) {
        const dx = sx - cx, dy = sy - cy;
        const tx = dx ? ((dx > 0 ? R : L) - cx) / dx : 1e9, ty = dy ? ((dy > 0 ? B : T) - cy) / dy : 1e9;
        const t = Math.max(0, Math.min(tx, ty));
        sx = cx + dx * t; sy = cy + dy * t;
        ang = Math.atan2(dy, dx) + Math.PI / 2;
      }
      const cls = d < 5.5 ? 'hd-w near' : 'hd-w on';
      if (cls !== w.cls) { w.cls = cls; w.el.className = cls; }
      w.el.style.transform = 'translate(' + (sx | 0) + 'px,' + (sy | 0) + 'px) translate(-50%,-50%)';
      w.chev.style.opacity = inside ? '0' : '1';
      if (!inside) w.chev.style.transform = 'translateX(-50%) rotate(' + ang.toFixed(2) + 'rad)';
      /* ninety-five seconds and gone: the strike is the only marker that
         insists, so it borrows the X's beat */
      if (w.meteor) w.el.style.opacity = (0.35 + beat(urg(d)) * 0.65).toFixed(3);
      if (doText) { const dd = Math.round(d);
        if (dd !== w.shownD) { w.shownD = dd; w.d.textContent = dd + 'm'; } } }
  };

  /* ======================================================================
     8 — BITE FORECAST
     The core dial already counts down to dusk. What it cannot say is what the
     dark is worth, so this names the species the flip actually brings.
     ====================================================================== */
  const castEl = RF.el('<div class="hd-cast hd-glass"></div>', colEl);
  /* DAY_LEN is not on the mod surface, so measure it: the dayT rate settles in
     a few seconds and survives any future retuning of the day length. */
  let dayLen = 420, lastDayT = RF.dayT, dAcc = 0, tAcc = 0;
  const measureDay = function (dt) {
    if (RF.WORLD.cave) return;
    const d = RF.dayT - lastDayT; lastDayT = RF.dayT;
    if (d > 0 && d < 0.02) { dAcc += d; tAcc += dt;
      if (tAcc > 4) { const est = tAcc / dAcc; if (est > 60 && est < 3000) dayLen = dayLen * 0.6 + est * 0.4; tAcc = 0; dAcc = 0; } }
  };
  const gated = function (cond) {
    const t = RF.WORLD.fish || [], out = [];
    for (let i = 0; i < t.length; i++) if (t[i][2] === cond) out.push(t[i][0]);
    out.sort(function (a, b) { return b.val - a.val; });
    return out;
  };
  const names = function (list, n) {
    const o = [];
    for (let i = 0; i < list.length && i < n; i++) o.push(list[i].name);
    return o.join(' · ');
  };
  const nightList = gated('night'), rainList = gated('rain'), stormList = gated('storm');

  const paintCast = function () {
    if (!RF.running || !cfg.forecast) { castEl.classList.add('hd-off'); return; }
    castEl.classList.remove('hd-off');
    if (RF.WORLD.cave) {
      castEl.innerHTML = '<div class="hd-c1" style="color:#57b7ff">' + pix('moon', 13) + ' endless dark</div>'
        + '<div class="hd-c2">no dawn reaches down here — every glow species is <b>always up</b>.</div>';
      return;
    }
    const night = F.isNight(), dayT = RF.dayT;
    const toNight = ((0.76 - dayT) + 1) % 1, toDay = ((0.12 - dayT) + 1) % 1;
    const left = (night ? toDay : toNight) * dayLen;
    const soon = left < 45;
    const head = night ? pix('moon', 13) + ' night water'
      : (dayT > 0.6 || dayT < 0.2 ? pix('dusk', 13) + ' low sun' : pix('sun', 13) + ' daylight');
    let body;
    if (night) body = nightList.length
      ? '<b>' + nightList.length + '</b> species only surface now — ' + names(nightList, 2) + '.'
      : 'nothing here waits for the dark.';
    else body = nightList.length
      ? (soon ? 'the light goes in under a minute: ' : 'after dusk ') + '<b>' + names(nightList, 2) + '</b> come up.'
      : 'this isle fishes the same by moonlight.';
    let wx = '';
    const w = RF.weather;
    if (w === 'rain' || w === 'storm') {
      const list = w === 'storm' ? stormList.concat(rainList) : rainList;
      wx = '<b style="color:' + (w === 'storm' ? 'var(--rose)' : '#57b7ff') + '">' + w + '</b> · bites 35% faster'
        + (list.length ? ' · ' + names(list, 2) + ' are in' : '');
    } else if (w === 'snow') wx = '<b style="color:#dff0ff">snow</b> · the ice fish rise';
    else if (w === 'ash') wx = '<b style="color:#c9a08a">ashfall</b> · the vents are paying';
    castEl.innerHTML = '<div class="hd-c1" style="color:' + (night ? '#57b7ff' : 'var(--gold)') + '">' + head
      + '<em>' + mmss(left) + '</em></div><div class="hd-c2">' + body + '</div>'
      + (wx ? '<div class="hd-c3">' + wx + '</div>' : '');
  };

  /* ======================================================================
     9 — ACTION BARS IN THE HINT LINE
     Core writes progress as ▰▰▰▱▱▱▱▱. That reads as noise at a glance; the
     same eight characters become one bar you can judge without counting.
     ====================================================================== */
  const BLOCKS = /[▰▱]{3,}/g;
  RF.modify('hint', function (h) {
    if (!cfg.hintbars || typeof h !== 'string') return h;
    if (h.indexOf('▰') < 0 && h.indexOf('▱') < 0) return h;
    return h.replace(BLOCKS, function (run) {
      let done = 0;
      for (let i = 0; i < run.length; i++) if (run[i] === '▰') done++;
      const p = Math.round(done / run.length * 100);
      const cls = p >= 100 ? ' max' : p >= 62 ? ' hot' : '';
      return '<i class="hd-bar' + cls + '" style="--p:' + p + '%"></i>';
    });
  }, 60);

  /* ======================================================================
     10 — THE NUDGE
     One line, bottom right, answering "what now" from the state you are
     actually in. Eleven seconds on, eighteen off, never the same suggestion
     twice running, and a click buys five minutes of quiet.
     ====================================================================== */
  const nudgeEl = RF.el('<div class="hd-l hd-nudge hd-glass hud">'
    + '<div class="hd-nk">NEXT</div><div class="hd-nt"></div></div>');
  const nudgeTx = nudgeEl.querySelector('.hd-nt');
  let lastNudge = '', nudgeHideAt = 0, nudgeNextAt = 0;
  nudgeEl.addEventListener('click', function () {
    snoozeUntil = Date.now() + 300000; persist();
    nudgeEl.classList.remove('on'); nudgeHideAt = 0;
    try { F.toast('quiet for five minutes'); } catch (e) {}
  });
  /* mirrors ROD_BASE/upCost in game.js §9 — informational only, so drift here
     costs nothing worse than a slightly early suggestion */
  const rodCost = function () { return Math.round(250 * Math.pow(1.75, S.rodLvl - 1)); };

  const nudges = function () {
    const out = [], cap = F.cap(), n = S.bucket.length, now = Date.now();
    if (n >= cap) out.push({ id: 'full', p: 9, t: 'the bucket is brimming — the fishmonger is <b>' + dist(RF.TRADER_POS) + 'm</b> off' });
    else if (cap - n <= 2) out.push({ id: 'near', p: 4, t: (cap - n) + ' slot' + (cap - n === 1 ? '' : 's') + ' left before the bucket stops taking fish' });
    guard('nudge-mkt', function () {
      const m = F.mktMods(), held = m.hot === 'fish' ? n : (S.ores[m.hot] | 0);
      if (held >= 8) out.push({ id: 'hot', p: 8, t: F.catLabel(m.hot) + ' pays <b>1.6×</b> for ' + mmss((RF.MKT_MS - (now % RF.MKT_MS)) / 1000) + ' and you are holding ' + fmt(held) });
    });
    const chum = (S.boosts && S.boosts.chumUntil ? S.boosts.chumUntil : 0) - now;
    if (chum > 0) out.push({ id: 'chum', p: 7, t: 'chum works for <b>' + mmss(chum / 1000) + '</b> more — that time belongs in the water' });
    else if (S.pearls >= 80) out.push({ id: 'buychum', p: 3, t: '<b>80 ◉</b> at the kiosk buys ten minutes of double bites' });
    if (S.treasure && S.treasure.w === RF.worldKey)
      out.push({ id: 'x', p: 6, t: 'the X is <b>' + Math.round(Math.hypot(S.treasure.i - RF.HALF - RF.pWorld.x, S.treasure.j - RF.HALF - RF.pWorld.z)) + 'm</b> away · stand on it and hold E' });
    if (RF.weather === 'storm') out.push({ id: 'storm', p: 6, t: 'a storm loosens the rock and stirs the big ones — swing or cast, either pays' });
    if (!activeBait() && S.rodLvl >= 3) out.push({ id: 'bait', p: 4, t: 'bare hook · bait puts a floor under what will bite' });
    if (S.rodLvl < RF.MAXLVL && S.coins >= rodCost())
      out.push({ id: 'rod', p: 5, t: '◈' + fmt(rodCost()) + ' in hand — the rod goes to <b>Lv' + (S.rodLvl + 1) + '</b>' });
    out.sort(function (a, b) { return b.p - a.p; });
    return out;
  };

  const tickNudge = function () {
    if (!RF.running || RF.panelOpen || logOpen || !cfg.nudge || Date.now() < snoozeUntil) { nudgeEl.classList.remove('on'); return; }
    const now = RF.clock;
    if (nudgeHideAt > 0) { if (now >= nudgeHideAt) { nudgeEl.classList.remove('on'); nudgeHideAt = 0; nudgeNextAt = now + 18; } return; }
    if (now < nudgeNextAt) return;
    const list = nudges();
    if (!list.length) { nudgeNextAt = now + 8; return; }
    let pick = list[0];
    for (let i = 0; i < list.length; i++) if (list[i].id !== lastNudge) { pick = list[i]; break; }
    lastNudge = pick.id; nudgeTx.innerHTML = pick.t;
    nudgeEl.classList.add('on'); nudgeHideAt = now + 11;
  };

  /* ======================================================================
     11 — MINIMAP
     Core draws a flat four-colour blob with six dots. This rebuilds the base
     with a cheap hillshade (so the isle reads as terrain) and then adds what
     you actually navigate by: live ore, the other anglers, a facing wedge and
     an X that beats faster the closer you get.
     ====================================================================== */
  let mmBase = null, mmDead = false, mmLX = 1e9, mmLZ = 1e9, mmNext = 0;
  const buildBase = function () {
    const N = RF.N, W = RF.WORLD, c = F.px(N), g = c.getContext('2d');
    const waterHex = '#' + W.water.toString(16).padStart(6, '0');
    const hm = RF.heightMap;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const h = hm[i][j], t = F.cellType(h);
      let col = t === 'seabed' ? waterHex : t === 'sand' ? W.sand[0] : t === 'grass' ? W.grass[0] : W.stone[0];
      if (RF.pathSet.has(F.keyOf(i, j)) && (t === 'grass' || t === 'sand')) col = '#cba86f';
      // hillshade against a north-west sun: two neighbour reads, no noise, real relief
      if (t !== 'seabed') { const dh = h - hm[i > 0 ? i - 1 : 0][j > 0 ? j - 1 : 0];
        col = F.shade(col, clamp(1 + dh * 0.11, 0.68, 1.32)); }
      else { col = F.shade(col, 1 - clamp((2 - h) * 0.09, 0, 0.3)); }
      g.fillStyle = col; g.fillRect(i, j, 1, 1);
    }
    return c;
  };

  RF.override.minimap = function (x, canvas) {
    if (mmDead || !cfg.minimap) return false;
    try {
      if (!mmBase) mmBase = buildBase();
      const W = canvas.width, N = RF.N, HALF = RF.HALF, p = RF.pWorld;
      if (Math.hypot(p.x - mmLX, p.z - mmLZ) < 0.1 && RF.clock < mmNext) return true;
      mmLX = p.x; mmLZ = p.z; mmNext = RF.clock + 0.2;
      const M = function (v) { return (v + HALF) / N * W; };
      x.clearRect(0, 0, W, W);
      x.save();
      x.beginPath(); x.arc(W / 2, W / 2, W / 2 - 2, 0, TAU); x.clip();
      x.translate(W / 2, W / 2); x.rotate(Math.PI / 4); x.scale(0.74, 0.74); x.translate(-W / 2, -W / 2);
      x.imageSmoothingEnabled = false;
      x.drawImage(mmBase, 0, 0, W, W);
      // night cools the whole plate so the lit markers read at a glance
      if (RF.WORLD.cave) { x.fillStyle = 'rgba(6,10,16,.36)'; x.fillRect(-W, -W, W * 3, W * 3); }
      else if (F.isNight()) { x.fillStyle = 'rgba(16,28,56,.42)'; x.fillRect(-W, -W, W * 3, W * 3); }
      // live ore: the quarry draws itself, and a worked-out patch visibly empties
      const nodes = RF.oreNodes;
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i];
        if (!n.alive) continue;
        const info = RF.ORE_INFO[n.type];
        x.fillStyle = info ? info.dot : '#cfd8d6';
        const s = n.geode ? 3.2 : 2.2;
        x.fillRect(M(n.x) - s / 2, M(n.z) - s / 2, s, s); }
      const dot = function (px3, py3, col, r, ring) {
        x.fillStyle = col; x.beginPath(); x.arc(px3, py3, r, 0, TAU); x.fill();
        if (ring) { x.strokeStyle = 'rgba(6,16,20,.85)'; x.lineWidth = 1.4; x.stroke(); } };
      const poi = function (pos, col, r) { if (pos) dot(M(pos.x), M(pos.z), col, r, true); };
      poi(RF.TRADER_POS, '#ffcf5c', 4);
      poi(RF.CASINO_POS, '#ff5d7a', 4);
      poi(RF.PORTAL_POS, '#c490ff', 4);
      poi(RF.HARBOR_POS, '#39d7c4', 4);
      poi(RF.MINE_POS, '#e8f4ff', 4);
      poi(RF.CRATER_POS, '#ff7a1a', 4);
      // other anglers, so a crowded isle looks crowded
      if (RF.peers && RF.peers.size) RF.peers.forEach(function (q) {
        if (q && isFinite(q.x) && isFinite(q.z)) dot(M(q.x), M(q.z), '#7fdcff', 3, true); });
      const tr = S.treasure;
      if (tr && tr.w === RF.worldKey) {
        const tx = tr.i / N * W, ty = tr.j / N * W;
        const d = Math.hypot(tr.i - HALF - p.x, tr.j - HALF - p.z);
        const urgency = urg(d);                                  // it beats faster as you close in
        const pulse = beat(urgency);
        x.strokeStyle = '#ffd24f'; x.lineWidth = 2.4 + urgency;
        x.globalAlpha = 0.45 + pulse * 0.55;
        const a = 4.5 + urgency * 2;
        x.beginPath(); x.moveTo(tx - a, ty - a); x.lineTo(tx + a, ty + a);
        x.moveTo(tx + a, ty - a); x.lineTo(tx - a, ty + a); x.stroke();
        x.globalAlpha = 1;
      }
      // the richest one-shot on the isle lasts ninety-five seconds and used to
      // announce itself with a single toast: it gets the X's beat
      const mets = RF.meteors;
      if (mets && mets.length) for (let i = 0; i < mets.length; i++) { const m = mets[i];
        if (!m || !isFinite(m.x) || !isFinite(m.z)) continue;
        const md = Math.hypot(m.x - p.x, m.z - p.z), mu = urg(md), mp = beat(mu);
        const mx = M(m.x), my = M(m.z);
        x.globalAlpha = m.landed === false ? 0.5 : 0.45 + mp * 0.55;
        x.strokeStyle = '#ff8a3a'; x.lineWidth = 1.6 + mu;
        x.beginPath(); x.arc(mx, my, 4 + mu * 2 + mp * 2, 0, TAU); x.stroke();
        x.globalAlpha = 1;
        dot(mx, my, m.landed === false ? '#ffd24f' : '#ff6a2a', 2.6, true); }
      // the hero: a dot with the wedge core never drew — which way you are facing
      const px2 = M(p.x), py2 = M(p.z), fa = p.face || 0;
      const dx = Math.sin(fa), dz = Math.cos(fa);
      x.fillStyle = 'rgba(255,255,255,.30)';
      x.beginPath(); x.moveTo(px2, py2);
      x.lineTo(px2 + (dx * 0.94 - dz * 0.34) * 13, py2 + (dz * 0.94 + dx * 0.34) * 13);
      x.lineTo(px2 + (dx * 0.94 + dz * 0.34) * 13, py2 + (dz * 0.94 - dx * 0.34) * 13);
      x.closePath(); x.fill();
      dot(px2, py2, '#ffffff', 3.6, true);
      x.restore();
      // rim: a hairline ring and a north tick, unrotated so north stays put
      x.strokeStyle = 'rgba(255,255,255,.10)'; x.lineWidth = 1;
      x.beginPath(); x.arc(W / 2, W / 2, W / 2 - 3, 0, TAU); x.stroke();
      x.fillStyle = 'rgba(232,244,242,.55)';
      x.beginPath(); x.moveTo(W / 2, 4); x.lineTo(W / 2 - 3.4, 10.5); x.lineTo(W / 2 + 3.4, 10.5); x.closePath(); x.fill();
      return true;
    } catch (e) { mmDead = true; RF.warn('02-hud/minimap', e); return false; }
  };

  /* ======================================================================
     KEYS — L replays the messages. Claimed only when we really handled it.
     ====================================================================== */
  RF.on('keydown', function (e) {
    if (e.code !== 'KeyL' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (RF.chatOpen || RF.panelOpen) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault(); setLog(!logOpen);
    return true;
  });

  /* ======================================================================
     VISIBILITY + API — a settings panel drives these. Anything switched off
     falls back to core behaviour rather than leaving a hole.
     ====================================================================== */
  const applyVis = function () {
    colEl.classList.toggle('hd-off', !cfg.rail && !cfg.forecast);
    railEl.classList.toggle('hd-off', !cfg.rail);
    castEl.classList.toggle('hd-off', !cfg.forecast);
    wpEl.classList.toggle('hd-off', !cfg.waypoints);
    floatsEl.classList.toggle('hd-off', !cfg.floats);
    logbtn.classList.toggle('hd-off', !cfg.toasts);
    if (!cfg.toasts) { setLog(false); logEl.classList.add('hd-off'); } else logEl.classList.remove('hd-off');
    if (!cfg.nudge) nudgeEl.classList.remove('on');
    if (bucketFill) bucketFill.classList.toggle('hd-off', !cfg.counters);
    mmLX = 1e9;                                  // force the map to repaint under the new setting
  };
  applyVis();

  RF.api = RF.api || {};
  RF.api.hud = {
    list: function () { const out = [];
      for (let i = 0; i < SECTIONS.length; i++) out.push({ id: SECTIONS[i].id, label: SECTIONS[i].label, on: !!cfg[SECTIONS[i].id] });
      return out; },
    get: function (id) { return !!cfg[id]; },
    set: function (id, on) {
      if (!Object.prototype.hasOwnProperty.call(DEF, id)) return false;
      cfg[id] = on ? 1 : 0; persist(); applyVis(); return !!cfg[id]; },
    toggle: function (id) { return this.set(id, !cfg[id]); },
    reset: function () { for (const k in DEF) cfg[k] = DEF[k]; persist(); applyVis(); },
    openMessages: function () { setLog(true); },
    log: function () { return logbook.slice(); }
  };

  /* 10-comfort owns the settings surface and loads after us, so the rows are
     handed over once everything is up — and only if that mod actually shipped. */
  const HINTS = {
    counters:  'coins and pearls roll to their new value and fly a ±chip',
    rail:      'one pill per live effect, with the timer core keeps to itself',
    toasts:    'repeats fold into ×N and gold jumps the queue',
    floats:    'the number appears over the rock, the bobber, your head',
    waypoints: 'edge chevrons to every landmark, with distance',
    forecast:  'what the clock and the sky are putting in the water',
    nudge:     'one line, bottom right, answering what now',
    hintbars:  'the hint line\'s ▰▱ runs become real bars',
    minimap:   'hillshade, live ore, other anglers, a facing wedge'
  };
  let wired = false;
  const wireSettings = function () {
    guard('settings', function () {
      const st = RF.api && RF.api.settings;
      if (wired || !st || typeof st.register !== 'function') return;
      wired = true;
      const rows = [];
      const mkRow = function (id, label) {
        return { type: 'sw', label: label, hint: HINTS[id] || '',
          get: function () { return !!cfg[id]; },
          set: function (v) { RF.api.hud.set(id, v); } }; };
      for (let i = 0; i < SECTIONS.length; i++) rows.push(mkRow(SECTIONS[i].id, SECTIONS[i].label));
      rows.push({ type: 'btn', label: 'Every strip back on', label2: 'RESET',
        hint: 'and the nudge stops being snoozed',
        get: function () { return false; },
        set: function () { snoozeUntil = 0; RF.api.hud.reset(); } });
      st.register({ mod: '02-hud', title: 'heads-up display', rows: rows });
      /* L is ours and nothing taught it before now */
      if (typeof st.key === 'function') st.key('KeyL', 'replay every message');
    });
  };
  RF.on('ready', wireSettings);

  /* ======================================================================
     DRIVE — one frame hook, everything else on a throttle.
     ====================================================================== */
  RF.on('frame', function (dt) {
    if (dt > 0.25) dt = 0.25;                 // a backgrounded tab must not teleport a tween
    if (comboT > 0 && (comboT -= dt) <= 0) combo = 0;
    if (cfg.counters) guard('f-count', function () { tickCounters(dt); });
    if (cfg.toasts) guard('f-toast', function () { tickToasts(); });
    if (cfg.floats) guard('f-float', function () { tickFloats(dt); });
    guard('f-wp', function () { tickWaypoints(dt); });
    if (cfg.forecast) guard('f-day', function () { measureDay(dt); });
  });
  /* a switched-off strip costs nothing: applyVis() already parked it hidden */
  RF.every(0.25, function () { if (cfg.rail) guard('t-rail', paintRail); });
  RF.every(1.0, function () { if (cfg.forecast) guard('t-cast', paintCast); guard('t-nudge', tickNudge); });
  RF.every(5.0, function () { if (logOpen) guard('t-log', paintLog); });

  /* first paint so nothing sits blank for a quarter second */
  guard('boot', function () { paintRail(); paintCast(); paintBadge(); });
  RF.on('start', function () {
    guard('start', function () {
      wireSettings();                         // in case 'ready' never reached us
      paintRail(); paintCast();
      nudgeNextAt = RF.clock + 12;            // let the player get their bearings first
      F.toast(pix('map', 13) + ' <b>L</b> replays every message · chevrons point the way', 'good');
    });
  });
});
