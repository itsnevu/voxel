/* ============================================================================
   01-angler — depth for the core loop.

   Press E, wait, press E, hold E was the whole loop. Ten things are added here.
   Five make the loop READABLE:

     ·  1 the tell      — a shadow slides in under the water before the bite
     ·  2 the gauge     — the tug-of-war drawn properly instead of as ASCII bars
     ·  3 shoals        — gulls mark water that is genuinely worth casting into
     ·  4 water reading — depth, biome, and every species that can bite RIGHT NOW
     ·  5 bait command  — swap what is on the hook without walking to the Market

   Five make it a SKILL, so that the water the card describes is water you can
   actually choose, and the fight the gauge draws is a fight you can win badly:

     ·  6 the charged cast  — hold E to load the rod, A/D to swing the aim,
                              release to place the bobber where you want it
     ·  7 the clean cast    — a sweet-spot band on the power meter, as wide as
                              your rod is good; hit it and the line lands soft
     ·  8 the aim ring      — a live target on the water reading depth, bottom
                              and whether you are dropping it under the gulls
     ·  9 the hookset       — a shrinking ring at the take; set it early and the
                              fish starts tired, set it late and you start loaded
     · 10 stamina, runs
          and the drag     — a fish with a fight left in it that you burn down by
                              working it or by giving line, and three drag settings
                              (Q, taken only while the rod is out, so 05-progress
                              keeps it everywhere else) whose safe ceiling IS the
                              rod ladder: heavy pops an Old Rod and suits a Poseidon

   Nothing here rolls a fish or grants a coin. 6-10 ride on top of core's own
   `updateFishing()` from the frame hook, which runs after it every frame: the
   charge pins `f.cast`, the aim rewrites `f.tx/f.tz` before the line lands, and
   the fight only ever ADDS to `f.tens`/`f.reel`. Core still owns the snap at
   tens>=1 and the landing at reel>=1, so core still decides everything.
   ========================================================================== */
RF.mod('01-angler', function (RF) {
  'use strict';

  const TH = RF.THREE, fn = RF.fn;
  const clamp = fn.clamp, lerp = fn.lerp, fmt = fn.fmt;
  const RARC = RF.RAR || {}, RORD = RF.RORDER || {};
  const RAR_DOWN = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
  const TAU = RF.TAU || Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;');

  /* Two game.js constants RF does not hand out: the rarity luck curve and the
     rod's luck slope. They are used for ONE thing — the "est." percentages in
     the card. Everything about which species are listed comes from the live
     fishPool(), so a drift here dulls the odds column and nothing else. */
  const LUCK_W = { common: -0.55, uncommon: -0.15, rare: 0.9, epic: 1.7, legendary: 2.6 };
  const luckWeight = (rar, luck) => luck > 0 ? Math.max(0.05, 1 + luck * (LUCK_W[rar] || 0)) : 1;
  const rodLuckOf = lvl => 0.18 * (clamp((lvl | 0) || 1, 1, RF.MAXLVL || 10) - 1);

  /* Mirrors core's condOK() using only published getters, so the card can name
     WHY a species is greyed out rather than just hiding it. */
  const condOK = c => !c ? true
    : c === 'night' ? fn.isNight()
    : c === 'rain' ? (RF.weather === 'rain' || RF.weather === 'storm')
    : c === 'storm' ? RF.weather === 'storm' : true;
  const CONDLAB = { night: 'at night', rain: 'in rain', storm: 'in a storm' };

  /* the bait actually on the hook — an equipped bait you ran out of is none */
  function liveBait() {
    try {
      const id = RF.state.baitId, B = RF.BAITS[id];
      return (B && RF.state.bait && RF.state.bait[id] > 0) ? { id: id, b: B, n: RF.state.bait[id] } : null;
    } catch (e) { return null; }
  }
  const say = o => (RF.api && RF.api.notify) ? RF.api.notify(o)
    : fn.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : '');
  const typing = () => { const a = document.activeElement;
    return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };

  /* comfort signals are read on a slow timer, never per frame */
  let reduced = false, quality = 'high';
  const gullBudget = () => quality === 'low' ? 0 : quality === 'med' ? 3 : quality === 'ultra' ? 6 : 5;
  const decorOn = () => quality !== 'low';

  /* ---------------------------------------------------------------------- */
  /* 1. STYLE                                                               */
  /* ---------------------------------------------------------------------- */
  RF.css(`
  #rf-angler-card,#rf-angler-gauge,#rf-angler-bait,#rf-angler-tip{
    --s:var(--rf-ui-scale,1);font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--ink);
    font-variant-numeric:tabular-nums;}
  body.photo #rf-angler-card,body.photo #rf-angler-gauge,body.photo #rf-angler-bait,
  body.photo #rf-angler-flash,body.photo #rf-angler-tip{display:none!important;}

  /* ---- the fight gauge, riding just above the hint bar ---- */
  #rf-angler-gauge{position:fixed;left:50%;bottom:calc(126px * var(--s));transform:translateX(-50%);z-index:28;
    width:min(calc(372px * var(--s)),74vw);display:none;pointer-events:none;
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:14px;padding:calc(9px * var(--s)) calc(13px * var(--s));
    box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
  #rf-angler-gauge.on{display:block;}
  #rf-angler-gauge .gh{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
    font-size:calc(9px * var(--s));letter-spacing:.24em;color:var(--lab);text-transform:uppercase;margin-bottom:5px;}
  #rf-angler-gauge .gh b{font-family:"Chakra Petch",sans-serif;font-size:calc(12px * var(--s));letter-spacing:.04em;color:var(--teal);}
  #rf-angler-gauge .gb{position:relative;height:calc(15px * var(--s));border-radius:7px;overflow:hidden;
    background:rgba(3,10,12,.55);border:1px solid var(--glass-bd-soft);box-shadow:inset 0 1px 3px rgba(0,0,0,.5);}
  #rf-angler-gauge .zone{position:absolute;top:0;bottom:0;}
  #rf-angler-gauge .z1{left:0;width:50%;background:linear-gradient(180deg,rgba(57,215,196,.20),rgba(57,215,196,.08));}
  #rf-angler-gauge .z2{left:50%;width:28%;background:linear-gradient(180deg,rgba(255,207,92,.22),rgba(255,207,92,.08));}
  #rf-angler-gauge .z3{left:78%;right:0;background:linear-gradient(180deg,rgba(255,93,122,.30),rgba(255,93,122,.12));}
  #rf-angler-gauge .tick{position:absolute;top:0;bottom:0;width:1px;background:var(--glass-bd);}
  #rf-angler-gauge .fill{position:absolute;left:0;top:0;bottom:0;width:100%;transform-origin:left center;
    transform:scaleX(0);background:linear-gradient(180deg,#5fe8d6,var(--teal));box-shadow:0 0 12px rgba(57,215,196,.5);}
  #rf-angler-gauge.warn .fill{background:linear-gradient(180deg,#ffe08f,var(--gold));box-shadow:0 0 12px rgba(255,207,92,.5);}
  #rf-angler-gauge.danger .fill{background:linear-gradient(180deg,#ff92a7,var(--rose));box-shadow:0 0 16px rgba(255,93,122,.7);}
  #rf-angler-gauge .pull{position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.85);
    box-shadow:0 0 8px rgba(255,255,255,.7);transform:translateX(-1px);}
  #rf-angler-gauge .drag{position:absolute;top:calc(50% - 1px);height:2px;border-radius:2px;
    background:repeating-linear-gradient(90deg,rgba(255,255,255,.85) 0 3px,rgba(255,255,255,0) 3px 6px);}
  #rf-angler-gauge .gr{display:flex;align-items:center;gap:calc(8px * var(--s));margin-top:6px;
    font-size:calc(9px * var(--s));letter-spacing:.2em;color:var(--lab);text-transform:uppercase;}
  #rf-angler-gauge .rb{position:relative;flex:1;height:calc(6px * var(--s));border-radius:4px;overflow:hidden;
    background:rgba(3,10,12,.55);border:1px solid var(--glass-bd-soft);}
  #rf-angler-gauge .rf{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);
    background:linear-gradient(90deg,rgba(255,207,92,.55),var(--gold));}
  #rf-angler-gauge .fp{display:inline-flex;gap:2px;vertical-align:-1px;}
  #rf-angler-gauge .fp i{width:calc(4px * var(--s));height:calc(9px * var(--s));border-radius:1px;background:rgba(255,255,255,.14);}
  #rf-angler-gauge .fp i.on{background:var(--rose);box-shadow:0 0 6px rgba(255,93,122,.6);}
  #rf-angler-gauge.danger{border-color:rgba(255,93,122,.75);animation:rf-angler-alarm .34s ease-in-out infinite;}
  #rf-angler-gauge.surge{border-color:rgba(255,93,122,.9);}
  #rf-angler-gauge.surge .gh b{color:var(--rose);}
  @keyframes rf-angler-alarm{0%,100%{box-shadow:var(--glass-hi),0 0 0 rgba(255,93,122,0),0 8px 28px rgba(2,8,10,.35);}
    50%{box-shadow:var(--glass-hi),0 0 22px rgba(255,93,122,.45),0 8px 28px rgba(2,8,10,.35);}}
  #rf-angler-flash{position:fixed;inset:0;z-index:24;pointer-events:none;opacity:0;
    background:radial-gradient(120% 96% at 50% 100%,rgba(255,93,122,0) 46%,rgba(255,93,122,.16) 82%,rgba(255,93,122,.32) 100%);
    transition:opacity .12s linear;}
  #rf-angler-flash.on{opacity:1;}
  body.rf-reduced #rf-angler-gauge.danger{animation:none;box-shadow:var(--glass-hi),0 0 18px rgba(255,93,122,.4);}
  body.rf-reduced #rf-angler-flash{display:none;}

  /* ---- the water-reading card ---- */
  #rf-angler-card{position:fixed;right:12px;top:calc(188px * var(--s));z-index:24;
    width:calc(238px * var(--s));display:none;flex-direction:column;
    max-height:calc(100vh - 250px * var(--s));
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:14px;
    box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);overflow:hidden;}
  #rf-angler-card.on{display:flex;}
  #rf-angler-card .hd{display:flex;align-items:center;gap:7px;padding:calc(9px * var(--s)) calc(11px * var(--s)) 7px;
    cursor:pointer;border-bottom:1px solid var(--glass-bd-soft);}
  #rf-angler-card .hd .ey{flex:1;font-size:calc(8.5px * var(--s));letter-spacing:.30em;color:var(--teal);text-transform:uppercase;}
  #rf-angler-card .hd .cv{font-size:calc(10px * var(--s));color:var(--faint);transition:transform .16s;}
  #rf-angler-card.shut .hd{border-bottom:none;}
  #rf-angler-card.shut .cv{transform:rotate(-90deg);}
  #rf-angler-card.shut .bd{display:none;}
  #rf-angler-card .bd{display:flex;flex-direction:column;min-height:0;}
  #rf-angler-card .rd{display:flex;gap:6px;padding:calc(8px * var(--s)) calc(11px * var(--s)) 0;}
  #rf-angler-card .rd div{flex:1;background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:9px;
    padding:calc(5px * var(--s)) calc(7px * var(--s));text-align:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  #rf-angler-card .rd s{display:block;text-decoration:none;font-size:calc(8px * var(--s));letter-spacing:.2em;color:var(--faint);text-transform:uppercase;}
  #rf-angler-card .rd b{font-family:"Chakra Petch",sans-serif;font-size:calc(13px * var(--s));color:var(--ink);}
  #rf-angler-card .sh{margin:calc(7px * var(--s)) calc(11px * var(--s)) 0;padding:calc(6px * var(--s)) calc(9px * var(--s));
    border-radius:9px;font-size:calc(10px * var(--s));line-height:1.5;
    background:rgba(57,215,196,.09);border:1px solid rgba(57,215,196,.34);color:var(--teal);display:none;}
  #rf-angler-card .sh.on{display:block;}
  #rf-angler-card .sh b{color:var(--ink);font-weight:600;}
  #rf-angler-card .sh .q{display:inline-block;width:calc(12px * var(--s));height:calc(12px * var(--s));line-height:calc(11px * var(--s));
    text-align:center;border-radius:50%;border:1px solid currentColor;font-size:calc(8px * var(--s));
    margin-left:4px;cursor:help;opacity:.75;vertical-align:1px;}
  #rf-angler-card .sec{font-size:calc(8.5px * var(--s));letter-spacing:.22em;text-transform:uppercase;color:var(--faint);
    padding:calc(9px * var(--s)) calc(11px * var(--s)) calc(4px * var(--s));display:flex;justify-content:space-between;gap:6px;}
  #rf-angler-card .lst{overflow-y:auto;overflow-x:hidden;padding:0 calc(7px * var(--s)) calc(4px * var(--s)) calc(11px * var(--s));
    min-height:0;scrollbar-width:thin;scrollbar-color:var(--border) transparent;}
  #rf-angler-card .lst::-webkit-scrollbar{width:5px;}
  #rf-angler-card .lst::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px;}
  #rf-angler-card .gl{font-size:calc(8px * var(--s));letter-spacing:.18em;text-transform:uppercase;
    margin:calc(6px * var(--s)) 0 3px;opacity:.85;}
  #rf-angler-card .fr{display:flex;align-items:center;gap:6px;font-size:calc(10.5px * var(--s));line-height:1.5;padding:1px 0;}
  #rf-angler-card .fr .dt{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor;}
  #rf-angler-card .fr .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);}
  #rf-angler-card .fr .od{color:var(--muted);font-size:calc(9.5px * var(--s));min-width:calc(38px * var(--s));text-align:right;}
  #rf-angler-card .fr .nw{font-size:calc(7.5px * var(--s));letter-spacing:.1em;color:var(--gold);border:1px solid rgba(255,207,92,.5);
    border-radius:4px;padding:0 3px;}
  #rf-angler-card .fr.off{opacity:.42;}
  #rf-angler-card .fr.off .od{color:var(--faint);font-style:italic;}
  #rf-angler-card .ft{border-top:1px solid var(--glass-bd-soft);padding:calc(7px * var(--s)) calc(11px * var(--s));
    display:flex;flex-wrap:wrap;gap:2px 10px;font-size:calc(9.5px * var(--s));color:var(--muted);}
  #rf-angler-card .ft span b{color:var(--ink);font-family:"Chakra Petch",sans-serif;}
  #rf-angler-card .ft .bs{flex:1 0 100%;color:var(--faint);font-size:calc(9px * var(--s));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #rf-angler-card .ft .bs b{color:var(--gold);}

  /* ---- bait command ---- */
  #rf-angler-bait{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);z-index:26;
    width:min(calc(340px * var(--s)),92vw);display:none;opacity:0;transition:opacity .16s,transform .16s cubic-bezier(.2,.8,.2,1);
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:18px;padding:calc(16px * var(--s));
    box-shadow:var(--glass-hi),0 24px 60px rgba(0,0,0,.5);}
  #rf-angler-bait.on{display:block;opacity:1;transform:translate(-50%,-50%) scale(1);}
  #rf-angler-bait .bh{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:calc(10px * var(--s));}
  #rf-angler-bait .bh h3{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:calc(18px * var(--s));color:var(--ink);}
  #rf-angler-bait .bh s{text-decoration:none;font-size:calc(9px * var(--s));letter-spacing:.24em;color:var(--teal);text-transform:uppercase;}
  #rf-angler-bait .bo{display:flex;align-items:center;gap:calc(10px * var(--s));width:100%;text-align:left;
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:11px;
    padding:calc(8px * var(--s)) calc(11px * var(--s));margin-bottom:5px;cursor:pointer;color:var(--ink);
    font:inherit;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);transition:border-color .12s,background .12s;}
  #rf-angler-bait .bo:hover:not(:disabled){border-color:rgba(57,215,196,.6);background:rgba(255,255,255,.08);}
  #rf-angler-bait .bo:disabled{opacity:.38;cursor:default;}
  #rf-angler-bait .bo.sel{border-color:var(--teal);box-shadow:inset 0 0 0 1px rgba(57,215,196,.35),0 0 14px rgba(57,215,196,.2);}
  #rf-angler-bait .bo .pip{width:calc(11px * var(--s));height:calc(11px * var(--s));border-radius:50%;flex:0 0 auto;box-shadow:0 0 8px currentColor;}
  #rf-angler-bait .bo .tx{flex:1;min-width:0;}
  #rf-angler-bait .bo .tx b{display:block;font-size:calc(12.5px * var(--s));font-weight:600;}
  #rf-angler-bait .bo .tx s{display:block;text-decoration:none;font-size:calc(9.5px * var(--s));color:var(--muted);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #rf-angler-bait .bo .lk{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:calc(11px * var(--s));color:var(--gold);text-align:right;}
  #rf-angler-bait .bo .lk s{display:block;text-decoration:none;font-size:calc(9px * var(--s));color:var(--faint);font-family:"IBM Plex Mono",monospace;font-weight:400;}
  #rf-angler-bait .bf{margin-top:calc(9px * var(--s));font-size:calc(9.5px * var(--s));color:var(--faint);line-height:1.6;text-align:center;}
  #rf-angler-bait .bf b{color:var(--teal);}

  #rf-angler-tip{position:fixed;z-index:33;max-width:250px;display:none;pointer-events:none;
    font-size:11px;line-height:1.55;color:var(--ink);
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:10px;padding:8px 11px;
    box-shadow:var(--glass-hi),0 10px 30px rgba(2,8,10,.5);}
  #rf-angler-tip.on{display:block;}
  #rf-angler-tip b{color:var(--teal);font-weight:600;}
  `, 'rf-angler-css');

  /* ---------------------------------------------------------------------- */
  /* 2. DOM                                                                 */
  /* ---------------------------------------------------------------------- */
  const gauge = RF.el(`<div id="rf-angler-gauge">
    <div class="gh"><span class="lb">Line tension</span><b class="st">HOLD</b><span class="pc">0%</span></div>
    <div class="gb">
      <i class="zone z1"></i><i class="zone z2"></i><i class="zone z3"></i>
      <i class="tick" style="left:50%"></i><i class="tick" style="left:78%"></i>
      <b class="fill"></b><u class="drag"></u><u class="pull"></u>
    </div>
    <div class="gr"><span>Fish in</span><div class="rb"><i class="rf"></i></div>
      <span>Pull <i class="fp"><i></i><i></i><i></i><i></i><i></i></i></span></div>
  </div>`);
  const flash = RF.el('<div id="rf-angler-flash"></div>');
  const card = RF.el(`<div id="rf-angler-card">
    <div class="hd"><span class="ey">Water reading</span><span class="cv">&#9660;</span></div>
    <div class="bd">
      <div class="rd">
        <div><s>Depth</s><b class="dp">—</b></div>
        <div><s>Bottom</s><b class="bi">—</b></div>
      </div>
      <div class="sh"></div>
      <div class="sec"><span>What can bite</span><span class="cnt"></span></div>
      <div class="lst"></div>
      <div class="ft"></div>
    </div>
  </div>`);
  const baitBox = RF.el(`<div id="rf-angler-bait" role="dialog" aria-label="Bait command">
    <div class="bh"><h3>Bait command</h3><s>B to close</s></div>
    <div class="bl"></div>
    <div class="bf"></div>
  </div>`);
  const tip = RF.el('<div id="rf-angler-tip"></div>');

  const G = {
    st: gauge.querySelector('.st'), pc: gauge.querySelector('.pc'),
    fill: gauge.querySelector('.fill'), pull: gauge.querySelector('.pull'),
    drag: gauge.querySelector('.drag'), rf: gauge.querySelector('.rf'),
    fp: gauge.querySelectorAll('.fp i')
  };
  const C = {
    hd: card.querySelector('.hd'), dp: card.querySelector('.dp'), bi: card.querySelector('.bi'),
    sh: card.querySelector('.sh'), cnt: card.querySelector('.cnt'),
    lst: card.querySelector('.lst'), ft: card.querySelector('.ft')
  };
  const B = { list: baitBox.querySelector('.bl'), foot: baitBox.querySelector('.bf') };

  /* the card scrolls; without this the wheel falls through to the camera zoom */
  C.lst.addEventListener('wheel', e => { e.stopPropagation(); }, { passive: true });

  /* one tooltip driver for every [data-rft] inside the mod's own DOM */
  function bindTips(root) {
    root.addEventListener('mouseover', e => {
      const t = e.target.closest ? e.target.closest('[data-rft]') : null;
      if (!t) return;
      tip.innerHTML = t.getAttribute('data-rft');
      tip.classList.add('on');
      const r = t.getBoundingClientRect(), tr = tip.getBoundingClientRect();
      tip.style.left = clamp(r.left + r.width / 2 - tr.width / 2, 8, innerWidth - tr.width - 8) + 'px';
      tip.style.top = Math.max(8, r.top - tr.height - 8) + 'px';
    });
    root.addEventListener('mouseout', e => {
      if (e.target.closest && e.target.closest('[data-rft]')) tip.classList.remove('on');
    });
  }
  bindTips(card); bindTips(baitBox);

  /* ---------------------------------------------------------------------- */
  /* 3. PERSISTENCE + TELEMETRY                                             */
  /* ---------------------------------------------------------------------- */
  const SAVED = RF.store.get('01-angler', null) || {};
  const life = Object.assign({ casts: 0, hookups: 0, landed: 0, snapped: 0, longest: 0, best: null }, SAVED.life || {});
  const sess = { casts: 0, hookups: 0, landed: 0, snapped: 0, missed: 0, gaveUp: 0, longest: 0, best: null };
  let cardShut = !!SAVED.shut, storeDirty = false;
  /* `drag` is set in §14 — declared here so the one store write owns every
     persisted field and the two halves of this file cannot clobber each other */
  let dragIx = clamp(SAVED.drag | 0, 0, 2);
  const flush = () => { if (!storeDirty) return; storeDirty = false;
    RF.store.set('01-angler', { life: life, shut: cardShut, drag: dragIx }); };
  RF.every(12, () => { try { flush(); } catch (e) { RF.err('angler:store', e, 'warn'); } });
  addEventListener('beforeunload', () => { try { flush(); } catch (e) {} });

  function noteBest(f) {
    if (!f) return;
    const rec = { name: f.name, rar: f.rar, val: f.val | 0, kg: f.kg };
    if (!sess.best || rec.val > sess.best.val) sess.best = rec;
    if (!life.best || rec.val > (life.best.val | 0)) { life.best = rec; storeDirty = true; }
  }
  RF.on('catch', (f, info) => { try { if (info && info.auto) return; noteBest(f); } catch (e) { RF.err('angler:catch', e, 'warn'); } });

  /* ---------------------------------------------------------------------- */
  /* 4. 3D: the tell (shadow + rings) and the shoal (shimmer + gulls)        */
  /* ---------------------------------------------------------------------- */
  const WT = RF.WATER_TOP;
  const shadowMat = new TH.MeshBasicMaterial({ color: 0x04161c, transparent: true, opacity: 0, depthWrite: false, side: TH.DoubleSide });
  const shadow = new TH.Group(), shadowIn = new TH.Group();
  {
    /* three flat quads read as a chunky voxel silhouette from the iso camera;
       renderOrder -1 puts them under the (depthWrite:false) water plane */
    const part = (w, h, x) => { const m = new TH.Mesh(new TH.PlaneGeometry(w, h), shadowMat);
      m.position.x = x; m.renderOrder = -1; return m; };
    shadowIn.add(part(1.02, 0.46, 0), part(0.34, 0.30, 0.62), part(0.40, 0.56, -0.62));
    shadowIn.rotation.x = -Math.PI / 2;
    shadow.add(shadowIn); shadow.visible = false; shadow.position.y = WT - 0.07;
    RF.scene.add(shadow);
  }
  const ripples = [];
  for (let i = 0; i < 4; i++) {
    const m = new TH.Mesh(new TH.RingGeometry(0.84, 1, 24),
      new TH.MeshBasicMaterial({ color: 0xd9f6ff, transparent: true, opacity: 0, depthWrite: false, side: TH.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 2; m.visible = false;
    RF.scene.add(m); ripples.push({ m: m, t: 0, life: 1, s1: 1 });
  }
  function ripple(x, z, life, s1) {
    for (let i = 0; i < ripples.length; i++) { const r = ripples[i];
      if (r.m.visible) continue;
      r.t = 0; r.life = life; r.s1 = s1; r.m.visible = true;
      r.m.position.set(x, WT + 0.02, z); r.m.scale.set(0.25, 0.25, 0.25);
      return; }
  }

  const shoalGrp = new TH.Group();
  {
    const ring = new TH.Mesh(new TH.RingGeometry(0.74, 1, 44),
      new TH.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.15, depthWrite: false, side: TH.DoubleSide }));
    const disc = new TH.Mesh(new TH.CircleGeometry(1, 34),
      new TH.MeshBasicMaterial({ color: 0x7fe4ff, transparent: true, opacity: 0.06, depthWrite: false, side: TH.DoubleSide }));
    ring.rotation.x = disc.rotation.x = -Math.PI / 2;
    ring.renderOrder = disc.renderOrder = 2;
    shoalGrp.add(disc, ring); shoalGrp.userData.ring = ring; shoalGrp.userData.disc = disc;
    shoalGrp.visible = false; shoalGrp.position.y = WT + 0.03; RF.scene.add(shoalGrp);
  }
  const gulls = [];
  {
    const gBody = new TH.BoxGeometry(0.34, 0.15, 0.18), gWing = new TH.BoxGeometry(0.2, 0.05, 0.52);
    const mBody = new TH.MeshLambertMaterial({ color: 0xf3f8f7 }), mWing = new TH.MeshLambertMaterial({ color: 0xc6d6da });
    for (let i = 0; i < 6; i++) {
      const g = new TH.Group();
      const wl = new TH.Mesh(gWing, mWing), wr = new TH.Mesh(gWing, mWing);
      wl.position.z = -0.3; wr.position.z = 0.3;
      g.add(new TH.Mesh(gBody, mBody), wl, wr);
      g.visible = false; RF.scene.add(g);
      gulls.push({ g: g, wl: wl, wr: wr, ph: i * 1.31 });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 5. SHOALS                                                              */
  /* ---------------------------------------------------------------------- */
  /* Named flavours so the card can say what the gulls found. `luck` feeds the
     fishLuck pipe and `bite` the biteTime pipe — both of which core only
     consults for the OFFLINE roll (signed in, the server decides). */
  const SHOAL_KIND = [
    { name: 'Baitball', sub: 'a tight ball of fry, everything below it feeding', luck: 1.0, bite: 0.62, r: 4.2 },
    { name: 'Feeding line', sub: 'a long slick of scraps drifting on the current', luck: 0.6, bite: 0.48, r: 5.4 },
    { name: 'Deep churn', sub: 'something big is pushing the water from below', luck: 1.5, bite: 0.82, r: 3.4 }
  ];
  let cand = null, shoal = null, nextShoalAt = 0, announced = false;

  function candidates() {
    if (cand) return cand;
    cand = [];
    try {
      const hm = RF.heightMap, N = RF.N;
      for (let i = 5; i < N - 5; i++) for (let j = 5; j < N - 5; j++) {
        if (hm[i][j] > 2) continue;
        /* want open water that a shore cast can still reach: land within four
           cells, but not a shelf right against the rocks */
        if (hm[i + 1][j] > 2 || hm[i - 1][j] > 2 || hm[i][j + 1] > 2 || hm[i][j - 1] > 2) continue;
        let near = false;
        for (let k = 2; k <= 4 && !near; k++)
          if (hm[i + k][j] > 2 || hm[i - k][j] > 2 || hm[i][j + k] > 2 || hm[i][j - k] > 2) near = true;
        if (near) cand.push(i * N + j);
      }
    } catch (e) { RF.err('angler:cells', e, 'warn'); }
    return cand;
  }
  function spawnShoal() {
    const list = candidates(); if (!list.length) return;
    const c = list[(Math.random() * list.length) | 0], N = RF.N, H = RF.HALF;
    const k = SHOAL_KIND[(Math.random() * SHOAL_KIND.length) | 0], a = Math.random() * TAU;
    shoal = { x: ((c / N) | 0) - H, z: (c % N) - H, r: k.r, kind: k,
      born: RF.clock, life: rnd(110, 190), vx: Math.cos(a) * 0.09, vz: Math.sin(a) * 0.09, ph: Math.random() * TAU };
    announced = false;
  }
  function shoalDist() {
    if (!shoal) return 1e9;
    return Math.hypot(shoal.x - RF.pWorld.x, shoal.z - RF.pWorld.z);
  }
  const inShoal = () => !!shoal && shoalDist() <= shoal.r + 1.2;

  function shoalTick(dt) {
    const t = RF.clock;
    if (!shoal) { if (t >= nextShoalAt) { nextShoalAt = t + rnd(150, 260); if (RF.running) spawnShoal(); } }
    else {
      const age = t - shoal.born;
      if (age > shoal.life) { shoal = null; shoalGrp.visible = false;
        for (let i = 0; i < gulls.length; i++) gulls[i].g.visible = false;
        nextShoalAt = t + rnd(150, 260); return; }
      /* drift, bouncing off anything that is not water so it never beaches */
      const nx = shoal.x + shoal.vx * dt, nz = shoal.z + shoal.vz * dt;
      if (fn.isWaterAt(nx, shoal.z) && Math.abs(nx) < RF.HALF - 3) shoal.x = nx; else shoal.vx = -shoal.vx;
      if (fn.isWaterAt(shoal.x, nz) && Math.abs(nz) < RF.HALF - 3) shoal.z = nz; else shoal.vz = -shoal.vz;

      if (!announced && RF.running && shoalDist() < 34) { announced = true;
        say({ level: 'info', title: 'Gulls are working the water', tag: 'angler-shoal', ttl: 5200,
          body: shoal.kind.name + ' · ' + Math.round(shoalDist()) + ' paces out' }); }

      const fade = clamp(Math.min(age, shoal.life - age) / 8, 0, 1);
      if (decorOn()) {
        shoalGrp.visible = true;
        shoalGrp.position.set(shoal.x, WT + 0.03, shoal.z);
        shoalGrp.scale.set(shoal.r, 1, shoal.r);
        const puls = reduced ? 1 : 1 + Math.sin(t * 1.6 + shoal.ph) * 0.28;
        shoalGrp.userData.ring.material.opacity = 0.16 * fade * puls;
        shoalGrp.userData.disc.material.opacity = 0.06 * fade;
      } else shoalGrp.visible = false;

      const nb = decorOn() ? gullBudget() : 0;
      for (let i = 0; i < gulls.length; i++) {
        const gu = gulls[i];
        if (i >= nb) { if (gu.g.visible) gu.g.visible = false; continue; }
        gu.g.visible = true;
        const a = (reduced ? gu.ph : t * 0.42 + gu.ph) + i * 0.4;
        const rr = shoal.r * (0.55 + (i % 3) * 0.22);
        gu.g.position.set(shoal.x + Math.cos(a) * rr, WT + 2.3 + Math.sin(t * 1.1 + gu.ph) * 0.45 + (i % 3) * 0.5,
          shoal.z + Math.sin(a) * rr);
        gu.g.rotation.y = -a - Math.PI / 2;   // nose along the tangent, not at the centre
        if (!reduced) { const fl = Math.sin(t * 6.5 + gu.ph) * 0.55; gu.wl.rotation.x = fl; gu.wr.rotation.x = -fl; }
      }
    }
  }

  /* Shoals bend the offline roll only. Core pipes both of these before it
     rolls, and both are no-ops the moment the server owns the catch. */
  RF.modify('fishLuck', v => inShoal() ? v + shoal.kind.luck : undefined);
  RF.modify('biteTime', v => inShoal() ? v * shoal.kind.bite : undefined);

  /* ---------------------------------------------------------------------- */
  /* 6. THE TELL                                                            */
  /* ---------------------------------------------------------------------- */
  /* An honest tease: it is built from what the player brought (rod, bait),
     what the sky is doing and what world they are on — never from the roll,
     which has not happened yet. A fat shadow means the odds are good, not
     that a legendary is on its way. */
  function teaseWeight() {
    let luck = 0;
    try {
      luck = rodLuckOf(RF.state.rodLvl);
      const lb = liveBait(); if (lb) luck += lb.b.luck;
    } catch (e) { luck = 0; }
    let k = luck / 3.9 * 0.6;
    if (fn.isNight()) k += 0.12;
    const w = RF.weather;
    if (w === 'rain') k += 0.1; else if (w === 'storm') k += 0.2;
    try { k += ((RF.WORLD.fishMul || 1) - 1) * 0.05; } catch (e) {}
    if (inShoal()) k += 0.18;
    return clamp(k, 0, 1);
  }
  const tell = { on: false, sx: 0, sz: 0, k: 0, ripT: 0, size: 1 };
  function beginTell(bx, bz) {
    tell.on = true; tell.ripT = 0; tell.k = teaseWeight();
    tell.size = lerp(0.62, 1.85, tell.k);
    let sx = bx + 4, sz = bz + 4;
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * TAU, d = rnd(5.5, 9);
      const x = bx + Math.cos(a) * d, z = bz + Math.sin(a) * d;
      if (Math.abs(x) < RF.HALF - 2 && Math.abs(z) < RF.HALF - 2 && fn.isWaterAt(x, z)) { sx = x; sz = z; break; }
    }
    tell.sx = sx; tell.sz = sz;
    shadow.visible = decorOn();
  }
  function endTell() { tell.on = false; shadow.visible = false; shadowMat.opacity = 0; }

  function tellTick(dt, f) {
    if (!tell.on) return;
    const bx = RF.bobber.position.x, bz = RF.bobber.position.z;
    let p, fade;
    if (f.state === 'wait') {
      const left = Math.max(0, f.biteAt - f.t), lead = tell.lead || 1;
      p = clamp(1 - left / lead, 0, 1); fade = Math.min(1, p * 4);
    } else { /* 'bite': the shape holds under the bobber for a beat, then goes */
      p = 1; tell.out = (tell.out || 0) + dt; fade = clamp(1 - tell.out / 0.5, 0, 1);
      if (fade <= 0) { endTell(); return; }
    }
    const ease = p * p * (3 - 2 * p);
    const weave = Math.sin(p * 7.2) * (1 - p) * 1.1;
    const dx = bx - tell.sx, dz = bz - tell.sz, ln = Math.hypot(dx, dz) || 1;
    const x = tell.sx + dx * ease - dz / ln * weave;
    const z = tell.sz + dz * ease + dx / ln * weave;
    shadow.position.set(x, WT - 0.07, z);
    const vx = bx - x, vz = bz - z;
    shadowIn.rotation.z = Math.atan2(-vz, vx);
    const s = tell.size * (0.72 + 0.28 * ease);
    shadow.scale.set(s, 1, s);
    shadowMat.opacity = (0.20 + 0.26 * tell.k) * fade;

    if (!reduced && decorOn()) {
      tell.ripT -= dt;
      if (tell.ripT <= 0) { tell.ripT = lerp(0.55, 0.24, ease);
        ripple(bx, bz, lerp(1.5, 0.95, ease), lerp(1.1, 2.3, tell.k) * (0.7 + ease)); }
    }
  }

  function ripplesTick(dt) {
    for (let i = 0; i < ripples.length; i++) {
      const r = ripples[i]; if (!r.m.visible) continue;
      r.t += dt; const k = r.t / r.life;
      if (k >= 1) { r.m.visible = false; r.m.material.opacity = 0; continue; }
      const s = lerp(0.25, r.s1, k * (2 - k));
      r.m.scale.set(s, s, s);
      r.m.material.opacity = 0.42 * (1 - k) * (1 - k);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 7. THE GAUGE                                                           */
  /* ---------------------------------------------------------------------- */
  let gOn = false, gWarn = '', gPct = -1, gPull = -1, gSurge = false, tickAcc = 0, dragEMA = 0, gLastTens = 0;
  function showGauge(on) {
    if (on === gOn) return; gOn = on;
    gauge.classList.toggle('on', on);
    if (!on) { gauge.classList.remove('danger', 'warn', 'surge'); flash.classList.remove('on');
      gWarn = ''; gPct = -1; gPull = -1; gSurge = false; dragEMA = 0; gLastTens = 0; tickAcc = 0; }
  }
  function gaugeTick(dt, f) {
    const tens = f.tens || 0, reel = f.reel || 0;

    /* the fish's counter-force is MEASURED, not recomputed: the rate tension
       climbs while you hold is exactly how hard it is pulling right now */
    if (RF.keys.act && dt > 0) dragEMA = dragEMA * 0.82 + Math.min(Math.max(0, (tens - gLastTens) / dt), 4) * 0.18;
    else dragEMA *= 0.9;
    gLastTens = tens;

    const pct = Math.round(tens * 100);
    if (pct !== gPct) { gPct = pct; G.pc.textContent = pct + '%';
      G.fill.style.transform = 'scaleX(' + (tens || 0).toFixed(3) + ')'; }
    G.rf.style.transform = 'scaleX(' + (reel || 0).toFixed(3) + ')';
    G.pull.style.left = (tens * 100).toFixed(1) + '%';
    const dl = clamp(dragEMA * 9, 1.5, 26);
    G.drag.style.left = (tens * 100).toFixed(1) + '%';
    G.drag.style.width = dl.toFixed(1) + '%';

    const band = tens >= 0.78 ? 'danger' : tens >= 0.5 ? 'warn' : '';
    if (band !== gWarn) {
      gauge.classList.toggle('warn', band === 'warn');
      gauge.classList.toggle('danger', band === 'danger');
      flash.classList.toggle('on', band === 'danger' && !RF.panelOpen);
      gWarn = band;
    }
    const surge = !!f.surge;
    if (surge !== gSurge) { gSurge = surge; gauge.classList.toggle('surge', surge);
      G.st.textContent = surge ? 'IT RUNS' : band === 'danger' ? 'EASE OFF' : 'HOLD'; }
    else if (band === 'danger' && !surge && G.st.textContent !== 'EASE OFF') G.st.textContent = 'EASE OFF';
    else if (band !== 'danger' && !surge && G.st.textContent !== 'HOLD') G.st.textContent = 'HOLD';

    /* fight strength, straight off the hooked fish (a flat 0.7 online, where
       core has not been told what is on the line yet) */
    const pips = clamp(Math.round(((f.fight || 0.7) - 0.38) / 0.2), 1, 5);
    if (pips !== gPull) { gPull = pips;
      for (let i = 0; i < G.fp.length; i++) G.fp[i].classList.toggle('on', i < pips); }

    /* a rising tick in the red — a different voice from core's line groan */
    if (tens >= 0.78) {
      tickAcc -= dt;
      if (tickAcc <= 0) { const k = clamp((tens - 0.78) / 0.22, 0, 1);
        tickAcc = lerp(0.26, 0.075, k);
        try { fn.beep(860 + k * 900, 0.035, 'square', 0.02); } catch (e) {} }
    } else tickAcc = 0;
  }

  /* Core paints the same numbers as ▰▱ bars in the hint. With a real gauge on
     screen that is noise, so the hint goes back to being just the instruction. */
  RF.modify('hint', h => {
    if (!gOn || typeof h !== 'string' || h.indexOf('▰') < 0) return;
    return RF.fishing.surge
      ? '<b style="color:var(--rose)">IT RUNS!</b> release <span class="key">E</span> and give it line'
      : 'hold <span class="key">E</span> to gain line · release to bleed tension';
  });

  /* ---------------------------------------------------------------------- */
  /* 8. WATER READING                                                       */
  /* ---------------------------------------------------------------------- */
  /* cellType() calls every cell at h<=2 'seabed', which spans a 0.35 m margin
     and a 2.35 m hole alike — so the label reads the depth, not just the type,
     or the card sits there calling ankle-deep water "deep". */
  const BIOME = { seabed: 'Deep water', sand: 'Sandflat', grass: 'Weed bed', stone: 'Rock shelf' };
  const bottomAt = (x, z) => {
    const h = fn.heightAt(x, z), t = fn.cellType(h);
    if (t !== 'seabed') return BIOME[t] || 'Water';
    const d = WT - h;
    return d < 0.8 ? 'Shallows' : d < 1.7 ? 'Drop-off' : 'Deep water';
  };
  let cardOn = false, poolSig = '', lastDp = '', lastBi = '', lastShoalSig = '';

  function readPoint() {
    const f = RF.fishing;
    if (f.state !== 'idle' && RF.bobber.visible) return { x: RF.bobber.position.x, z: RF.bobber.position.z, cast: true };
    let w = null; try { w = fn.nearestWater(); } catch (e) { w = null; }
    return w ? { x: w.x, z: w.z, dist: w.dist, cast: false } : null;
  }

  function paintPool() {
    const lb = liveBait(), luck = rodLuckOf(RF.state.rodLvl) + (lb ? lb.b.luck : 0);
    let table = null, pool = null;
    try { table = (RF.WORLD && RF.WORLD.fish) || RF.TABLE; pool = fn.fishPool(lb ? lb.b.min : null); }
    catch (e) { RF.err('angler:pool', e, 'warn'); return; }
    if (!table || !pool) return;

    const live = new Set(pool);
    let tot = 0;
    for (let i = 0; i < pool.length; i++) tot += pool[i][1] * luckWeight(pool[i][0].rar, luck);
    if (tot <= 0) tot = 1;

    const byRar = {}, dex = RF.state.dex || {};
    for (let i = 0; i < table.length; i++) {
      const e = table[i], sp = e[0], on = live.has(e);
      const rows = byRar[sp.rar] || (byRar[sp.rar] = []);
      let why = '';
      if (!on) why = !condOK(e[2]) ? (CONDLAB[e[2]] || 'gated') : 'bait floor';
      rows.push({ sp: sp, on: on, why: why,
        pct: on ? (e[1] * luckWeight(sp.rar, luck) / tot * 100) : 0,
        isNew: !dex[sp.name] });
    }

    let html = '';
    for (let r = 0; r < RAR_DOWN.length; r++) {
      const key = RAR_DOWN[r], rows = byRar[key];
      if (!rows || !rows.length) continue;
      rows.sort((a, b) => (b.on - a.on) || (b.pct - a.pct) || (b.sp.val - a.sp.val));
      html += '<div class="gl" style="color:' + (RARC[key] || 'var(--muted)') + '">' + key + '</div>';
      for (let i = 0; i < rows.length; i++) {
        const w = rows[i], col = RARC[w.sp.rar] || 'var(--muted)';
        html += '<div class="fr' + (w.on ? '' : ' off') + '">'
          + '<i class="dt" style="background:' + col + ';color:' + col + '"></i>'
          + '<span class="nm">' + esc(w.sp.name) + '</span>'
          + (w.isNew ? '<span class="nw">NEW</span>' : '')
          + '<span class="od">' + (w.on ? w.pct.toFixed(w.pct < 1 ? 2 : 1) + '%' : w.why) + '</span></div>';
      }
    }
    C.lst.innerHTML = html;
    C.cnt.innerHTML = '<span data-rft="Odds are estimated from the live pool: the same species list core draws from, weighted by your rod and bait. The roll itself is never touched.">'
      + live.size + ' of ' + table.length + ' · est.</span>';
  }

  function paintFoot() {
    const b = sess.best || life.best;
    C.ft.innerHTML =
      '<span>casts <b>' + sess.casts + '</b></span>'
      + '<span>hooked <b>' + sess.hookups + '</b></span>'
      + '<span>landed <b>' + sess.landed + '</b></span>'
      + '<span>snapped <b>' + sess.snapped + '</b></span>'
      + '<span>longest <b>' + sess.longest.toFixed(1) + 's</b></span>'
      + (b ? '<span class="bs">best ' + (sess.best ? '' : 'ever ') + esc(b.name) + ' · <b>◈ ' + fmt(b.val) + '</b></span>' : '');
  }

  function paintCard() {
    let want = false, pt = null;
    if (RF.running && !RF.panelOpen) {
      pt = readPoint();
      want = !!pt && (pt.cast || (pt.dist !== undefined && pt.dist <= 3.4));
    }
    if (want !== cardOn) { cardOn = want; card.classList.toggle('on', want); }
    if (!want || cardShut) return;

    const depth = Math.max(0, WT - fn.heightAt(pt.x, pt.z));
    const dp = depth.toFixed(1) + ' m';
    if (dp !== lastDp) { lastDp = dp; C.dp.textContent = dp; }
    const bi = bottomAt(pt.x, pt.z);
    if (bi !== lastBi) { lastBi = bi; C.bi.textContent = bi; }

    const near = inShoal();
    const sig = shoal ? (shoal.kind.name + '|' + (near ? 1 : 0) + '|' + Math.round(shoalDist()) + '|' + (RF.online ? 1 : 0)) : '';
    if (sig !== lastShoalSig) {
      lastShoalSig = sig;
      if (!shoal) C.sh.classList.remove('on');
      else {
        const d = Math.round(shoalDist());
        const note = RF.online
          ? 'Signed in, the server rolls every fish. A shoal is a place to look at, not a bonus · the gulls are honest about where the bait is, nothing more.'
          : 'Standing inside the ring adds <b>+' + shoal.kind.luck.toFixed(1) + ' luck</b> and cuts the wait to <b>'
            + Math.round(shoal.kind.bite * 100) + '%</b>. It bends the offline roll only.';
        C.sh.innerHTML = fn.pixSVG('fish', 12) + ' <b>' + esc(shoal.kind.name) + '</b>'
          + (near ? ' · <b>you are in it</b>' : ' · ' + d + ' paces')
          + (RF.online ? ' · cosmetic' : '')
          + '<span class="q" data-rft="' + note.replace(/"/g, '&quot;') + '">?</span>'
          + '<br><span style="color:var(--muted)">' + esc(shoal.kind.sub) + '</span>';
        C.sh.classList.add('on');
      }
    }

    const lb = liveBait();
    const ps = RF.worldKey + '|' + (fn.isNight() ? 1 : 0) + '|' + RF.weather + '|' + (lb ? lb.id : '-') + '|' + RF.state.rodLvl;
    if (ps !== poolSig) { poolSig = ps; paintPool(); }
    paintFoot();
  }
  C.hd.addEventListener('click', () => {
    cardShut = !cardShut; storeDirty = true;
    card.classList.toggle('shut', cardShut);
    if (!cardShut) { poolSig = ''; lastShoalSig = ''; paintCard(); }
    try { RF.sfx.tab(); } catch (e) {}
  });
  card.classList.toggle('shut', cardShut);
  RF.every(0.4, () => { try { paintCard(); } catch (e) { RF.err('angler:card', e, 'warn'); } });
  RF.on('weather', () => { poolSig = ''; });
  RF.on('hud', () => { poolSig = ''; });

  /* ---------------------------------------------------------------------- */
  /* 9. BAIT COMMAND (B)                                                    */
  /* ---------------------------------------------------------------------- */
  let baitOpen = false;
  function renderBait() {
    const order = RF.BAIT_ORDER || [], have = RF.state.bait || {}, cur = RF.state.baitId;
    let html = '<button class="bo' + (cur ? '' : ' sel') + '" data-bait="">'
      + '<i class="pip" style="background:var(--faint);color:var(--faint)"></i>'
      + '<span class="tx"><b>Bare hook</b><s>no luck, no rarity floor, nothing spent</s></span>'
      + '<span class="lk">+0.0<s>luck</s></span></button>';
    for (let i = 0; i < order.length; i++) {
      const id = order[i], b = RF.BAITS[id], n = have[id] | 0;
      html += '<button class="bo' + (cur === id ? ' sel' : '') + '"' + (n > 0 ? '' : ' disabled')
        + ' data-bait="' + id + '">'
        + '<i class="pip" style="background:' + b.tint + ';color:' + b.tint + '"></i>'
        + '<span class="tx"><b>' + esc(b.name) + (cur === id ? ' · on the hook' : '') + '</b>'
        + '<s>' + esc(n > 0 ? b.sub : 'none left · buy at the Market') + (b.min ? ' · ' + b.min + '+ only' : '') + '</s></span>'
        + '<span class="lk">+' + b.luck.toFixed(1) + '<s>×' + n + '</s></span></button>';
    }
    B.list.innerHTML = html;
    B.foot.innerHTML = 'One bait is spent per fish <b>landed</b> · a snapped line costs nothing.'
      + '<br>Press <b>B</b> to close · clicking the hooked bait takes it back off.';
  }
  function openBait() {
    if (baitOpen) return; baitOpen = true;
    renderBait(); baitBox.classList.add('on');
    try { RF.sfx.open(); } catch (e) {}
  }
  function closeBait() {
    if (!baitOpen) return; baitOpen = false;
    baitBox.classList.remove('on'); tip.classList.remove('on');
    try { RF.sfx.close(); } catch (e) {}
  }
  B.list.addEventListener('click', e => {
    const t = e.target.closest ? e.target.closest('[data-bait]') : null;
    if (!t || t.disabled) return;
    const id = t.getAttribute('data-bait');
    try {
      if (RF.SRV && RF.SRV.on) {
        /* server/src/game/actions.js: bait { op:'equip', id } — same toggle
           semantics as the Market, and the reply overwrites local state */
        RF.SRV.act('bait', { op: 'equip', id: id }).then(r => {
          if (!r) return;
          fn.toast(r.baitId ? RF.BAITS[r.baitId].name + ' on the hook' : 'Bare hook', 'good');
          renderBait(); poolSig = '';
        });
        return;
      }
      if (id && !(RF.state.bait[id] > 0)) return;
      RF.state.baitId = RF.state.baitId === id ? '' : id;   /* a preference, not economy */
      fn.toast(RF.state.baitId ? RF.BAITS[RF.state.baitId].name + ' on the hook' : 'Bare hook', 'good');
      fn.updateHUD(); fn.save();
      renderBait(); poolSig = '';
    } catch (err) { RF.err('angler:bait', err); }
  });
  RF.on('keydown', e => {
    try {
      if (typing()) return;
      if (e.code === 'KeyB' && !e.shiftKey) {      /* Shift+B is the drag dial, §14 */
        if (RF.panelOpen && !baitOpen) return;
        e.preventDefault();
        if (baitOpen) closeBait(); else openBait();
        return true;
      }
      if (e.code === 'Escape' && baitOpen) { closeBait(); return true; }
    } catch (err) { RF.err('angler:key', err, 'warn'); }
  });
  RF.on('panel', () => { if (baitOpen) closeBait(); });

  /* ---------------------------------------------------------------------- */
  /* 10. THE FRAME                                                          */
  /* ---------------------------------------------------------------------- */
  let prevSt = 'idle', prevTens = 0;
  RF.every(0.9, () => {
    try {
      reduced = document.body.classList.contains('rf-reduced');
      quality = document.body.dataset.rfQuality || 'high';
      if (!decorOn()) { endTell(); shoalGrp.visible = false;
        for (let i = 0; i < gulls.length; i++) gulls[i].g.visible = false; }
    } catch (e) { RF.err('angler:comfort', e, 'warn'); }
  });

  RF.on('frame', dt => {
    try {
      if (dt > 0.25) dt = 0.25;                   /* a tabbed-out frame must not teleport anything */
      const f = RF.fishing; if (!f) return;
      const st = f.state;

      /* ---- telemetry: watch the transitions core makes ---- */
      if (st !== prevSt) {
        if (st === 'cast') { sess.casts++; life.casts++; storeDirty = true; }
        else if (st === 'reel' && prevSt === 'bite') { sess.hookups++; life.hookups++; storeDirty = true; }
        if (prevSt === 'reel' && st !== 'reel') {
          if (f.reelT > sess.longest) sess.longest = f.reelT;
          if (f.reelT > life.longest) life.longest = f.reelT;
          /* core zeroes tension on a snap, so the previous frame's reading is
             the only witness; a full spool means it came in */
          if (f.reel >= 0.999) { sess.landed++; life.landed++; }
          else if (prevTens >= 0.85) { sess.snapped++; life.snapped++; }
          else sess.gaveUp++;
          storeDirty = true;
        }
        if (prevSt === 'bite' && st === 'idle') sess.missed++;

        /* ---- the tell rides the tail of the wait ---- */
        if (st === 'wait' && prevSt === 'cast' && decorOn()) {
          tell.lead = Math.min(1.7, Math.max(0.5, f.biteAt * 0.55));
          tell.pending = true; tell.out = 0;
        }
        if (st !== 'wait' && st !== 'bite') { tell.pending = false; if (tell.on) endTell(); }
        if (st === 'idle' || st === 'cast') { poolSig = ''; }
        prevSt = st;
      }
      prevTens = f.tens || 0;

      if (tell.pending && st === 'wait' && (f.biteAt - f.t) <= (tell.lead || 1) && !tell.on) {
        tell.pending = false; beginTell(RF.bobber.position.x, RF.bobber.position.z);
      }
      if (tell.on && st !== 'wait' && st !== 'bite') endTell();
      tellTick(dt, f);
      ripplesTick(dt);

      /* ---- the gauge only exists during the fight ---- */
      showGauge(st === 'reel' && !RF.panelOpen);
      if (gOn) gaugeTick(dt, f);

      shoalTick(dt);
    } catch (e) { RF.err('angler:frame', e); }
  });

  /* ====================================================================== */
  /* 12. THE ROD IN YOUR HANDS — cast, hookset, fight                       */
  /*                                                                        */
  /* Everything below layers onto core's own state machine from the frame    */
  /* hook, which runs AFTER updateFishing() every frame. That ordering is    */
  /* the whole trick: core advances the cast, we hold it back; core loads    */
  /* the line, we load it a little more. Core still owns both endings.       */
  /* ====================================================================== */
  RF.css(`
  #rf-angler-cast,#rf-angler-rep{--s:var(--rf-ui-scale,1);position:fixed;left:50%;transform:translateX(-50%);
    font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--ink);font-variant-numeric:tabular-nums;
    pointer-events:none;background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
  body.photo #rf-angler-cast,body.photo #rf-angler-rep{display:none!important;}

  #rf-angler-cast{bottom:calc(126px * var(--s));z-index:27;width:min(calc(372px * var(--s)),74vw);
    display:none;border-radius:14px;padding:calc(9px * var(--s)) calc(13px * var(--s));}
  #rf-angler-cast.on{display:block;}
  #rf-angler-cast.up{bottom:calc(200px * var(--s));}   /* step over the fight gauge */
  #rf-angler-cast .ch{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
    font-size:calc(9px * var(--s));letter-spacing:.24em;color:var(--lab);text-transform:uppercase;margin-bottom:5px;}
  #rf-angler-cast .ch b{font-family:"Chakra Petch",sans-serif;font-size:calc(12px * var(--s));
    letter-spacing:.04em;color:var(--teal);}
  #rf-angler-cast .ch .cn{color:var(--muted);letter-spacing:.06em;text-transform:none;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #rf-angler-cast .cb{position:relative;height:calc(15px * var(--s));border-radius:7px;overflow:hidden;
    background:rgba(3,10,12,.55);border:1px solid var(--glass-bd-soft);box-shadow:inset 0 1px 3px rgba(0,0,0,.5);}
  #rf-angler-cast .cf{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);
    background:linear-gradient(180deg,#5fe8d6,var(--teal));box-shadow:0 0 12px rgba(57,215,196,.45);}
  #rf-angler-cast.good .cf{background:linear-gradient(180deg,#a5f0b6,var(--c-uncommon));box-shadow:0 0 14px rgba(116,224,138,.55);}
  #rf-angler-cast.warn .cf{background:linear-gradient(180deg,#ffe08f,var(--gold));box-shadow:0 0 12px rgba(255,207,92,.45);}
  #rf-angler-cast.spent .cf{background:linear-gradient(180deg,#8aa6a2,var(--faint));box-shadow:none;}
  #rf-angler-cast .cz{position:absolute;top:0;bottom:0;left:0;width:0;display:none;
    background:rgba(116,224,138,.30);box-shadow:inset 0 0 0 1px rgba(116,224,138,.85);}
  #rf-angler-cast.band .cz{display:block;}
  #rf-angler-cast .cft{margin-top:calc(6px * var(--s));font-size:calc(9.5px * var(--s));color:var(--faint);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  #rf-angler-cast .cft b{color:var(--gold);font-weight:600;}
  #rf-angler-cast.good{border-color:rgba(116,224,138,.55);}
  #rf-angler-cast.danger{border-color:rgba(255,93,122,.7);}

  #rf-angler-rep{bottom:calc(200px * var(--s));z-index:27;border-radius:11px;
    padding:calc(7px * var(--s)) calc(13px * var(--s));font-size:calc(11px * var(--s));
    max-width:92vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    opacity:0;transition:opacity .2s ease;display:none;}
  #rf-angler-rep.on{display:block;opacity:1;}
  #rf-angler-rep.bad{border-color:rgba(255,93,122,.7);}
  #rf-angler-rep.good{border-color:rgba(57,215,196,.65);}
  #rf-angler-rep .k{font-family:"Chakra Petch",sans-serif;font-weight:700;color:var(--gold);}
  #rf-angler-rep .d{color:var(--faint);}
  body.rf-reduced #rf-angler-rep{transition:none;}
  `, 'rf-angler-cast-css');

  const castBox = RF.el(`<div id="rf-angler-cast">
    <div class="ch"><b class="ct">CAST</b><span class="cn"></span></div>
    <div class="cb"><i class="cf"></i><u class="cz"></u></div>
    <div class="cft"></div>
  </div>`);
  const repBox = RF.el('<div id="rf-angler-rep"></div>');
  const X = { ct: castBox.querySelector('.ct'), cn: castBox.querySelector('.cn'),
    cf: castBox.querySelector('.cf'), cz: castBox.querySelector('.cz'), cft: castBox.querySelector('.cft') };

  /* one write per changed value — this paints 60x a second during a fight */
  let xOn = false, xUp = null, xCls = '-', xTtl = '', xNote = '', xFoot = '', xV = -9, xBand = '';
  function castShow(on, up) {
    if (on !== xOn) { xOn = on; castBox.classList.toggle('on', on); if (!on) { xCls = '-'; xBand = '-'; } }
    if (on && up !== xUp) { xUp = up; castBox.classList.toggle('up', !!up); }
  }
  function castPaint(cls, title, note, v, foot, band) {
    const b = band || '';
    /* the class list and the zone marker are written together: rebuilding
       className for a colour change used to drop `.band`, which killed the
       sweet-spot marker at the exact moment the release turned green */
    if (xCls !== cls || xBand !== b) {
      xCls = cls;
      castBox.className = 'on' + (xUp ? ' up' : '') + (cls ? ' ' + cls : '') + (b ? ' band' : '');
      if (b && b !== xBand) { const p = b.split(','); X.cz.style.left = p[0]; X.cz.style.width = p[1]; }
      xBand = b;
    }
    if (xTtl !== title) { xTtl = title; X.ct.textContent = title; }
    if (xNote !== note) { xNote = note; X.cn.innerHTML = note; }
    if (xFoot !== foot) { xFoot = foot; X.cft.innerHTML = foot; }
    if (Math.abs(v - xV) > 0.005) { xV = v; X.cf.style.transform = 'scaleX(' + clamp(v, 0, 1).toFixed(3) + ')'; }
  }
  let repT = 0;
  function report(html, kind) {
    repBox.className = (kind || '') + ' on'; repBox.innerHTML = html; repT = 4.0;
  }

  /* ---- 3D: the aim ring, and the ring that shrinks at the take ---- */
  const aimGeo = new TH.RingGeometry(0.60, 0.78, 24);
  const mkRing = (geo, col, op) => { const m = new TH.Mesh(geo,
      new TH.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, side: TH.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 3; m.visible = false; RF.scene.add(m); return m; };
  const aimRing = mkRing(aimGeo, 0x39d7c4, 0);
  const aimDot = mkRing(new TH.RingGeometry(0.05, 0.18, 12), 0x39d7c4, 0);
  const setRing = mkRing(aimGeo, 0xffcf5c, 0);
  const setMark = mkRing(new TH.RingGeometry(0.40, 0.50, 22), 0x74e08a, 0);

  /* ---------------------------------------------------------------------- */
  /* 13. TUNING                                                             */
  /* ---------------------------------------------------------------------- */
  /* r = extra line gained per second while hauling · t = extra load per second
     (scaled by how hard the fish pulls) · s = extra stamina burned in the
     working band. The rod divisor on `t` is the point of the whole dial: at
     Lv.1 heavy drag will pop the line on anything with shoulders, and by the
     Poseidon Rod it is simply the fast way to fish. */
  const DRAGS = [
    { n: 'light', r: -0.20, t: -0.26, s: -0.09, c: 'var(--teal)',
      sub: 'nothing breaks, and nothing comes in fast either' },
    { n: 'medium', r: 0.00, t: 0.00, s: 0.00, c: 'var(--gold)', sub: 'the honest setting' },
    { n: 'heavy', r: 0.32, t: 0.44, s: 0.15, c: 'var(--rose)',
      sub: 'it comes in fast or it comes off — mind the runs' }
  ];
  const RUN_NAMES = ['it dives for the bottom', 'it runs for the rocks', 'a head-shake, hard',
    'it sounds — straight down', 'it turns and runs wide', 'it bores deep and sulks'];

  /* ---------------------------------------------------------------------- */
  /* 14. THE CAST, THE HOOKSET, THE FIGHT                                   */
  /* ---------------------------------------------------------------------- */
  let ph = 'idle';                       // idle · charge · fly · soak · take · fight
  let power = 0, powDir = 1, bandC = 0.7, bandW = 0.06, windup = 0, chargeT = 0, heldAct = false;
  let aimA = 0, aimOff = 0, aimTgt = null, aimSpot = '', aimGull = false;
  let castClean = false, castReach = 0, castGull = false, castQ = 1, expectBite = false;
  let hookGrade = '', stam = 1, spentFish = false, wasSurge = false, fightTired = 1;
  let runName = '', runSide = 1, runAge = 0, runCount = 0, fightAge = 0, peakLoad = 0;
  let escAt = -99, lastReport = null;
  let anchored = false, anchorX = 0, anchorZ = 0;
  /* the rod tip, so the float can hang off it while the cast is loaded rather
     than floating a quarter of the way to the water with nothing holding it */
  const vTip = new TH.Vector3();
  let rodMesh = null;
  function rodOf() {
    if (rodMesh) return rodMesh;
    try {
      const armR = RF.player && RF.player.userData && RF.player.userData.armR;
      if (!armR) return null;
      for (let i = 0; i < armR.children.length; i++) {
        const c = armR.children[i];
        if (c.userData && c.userData.tip) { rodMesh = c; return c; }
      }
    } catch (e) {}
    return null;
  }

  const rodTierLuck = () => clamp(RF.state.rodLvl, 1, RF.MAXLVL || 10);
  const lineRating = () => (4 + rodTierLuck() * 2.6).toFixed(0);

  /* Where a cast of this length in this direction actually lands. We walk back
     from the far end until we find open water, so a long throw over a sandbar
     drops short instead of hanging the bobber on the beach. */
  function aimAt(ang, dist) {
    const px = RF.pWorld.x, pz = RF.pWorld.z, sx = Math.sin(ang), sz = Math.cos(ang);
    const hm = RF.heightMap, N = RF.N, H = RF.HALF;
    for (let d = dist; d >= 0.85; d -= 0.3) {
      const x = px + sx * d, z = pz + sz * d;
      if (Math.abs(x) > H - 1.5 || Math.abs(z) > H - 1.5) continue;
      const i = clamp(Math.round(x + H), 0, N - 1), j = clamp(Math.round(z + H), 0, N - 1);
      if (hm[i][j] <= 2) return { x: i - H, z: j - H, d: d };
    }
    return null;
  }
  const reachNow = () => 1.5 + power * (3.5 + (rodTierLuck() - 1) * 0.55);
  const gullAt = (x, z) => !!shoal && Math.hypot(shoal.x - x, shoal.z - z) <= shoal.r;

  function resetRod() {
    ph = 'idle'; expectBite = false;
    aimRing.visible = aimDot.visible = setRing.visible = setMark.visible = false;
    castShow(false, false);
  }

  function beginCharge() {
    ph = 'charge'; power = 0.06; powDir = 1; windup = 0; chargeT = 0;
    /* the band drifts every cast and widens with the rod — a Poseidon Rod
       forgives a sloppy release, an Old Rod does not */
    bandC = rnd(0.40, 0.90); bandW = 0.040 + 0.0125 * rodTierLuck();
    const f = RF.fishing, dx = f.tx - RF.pWorld.x, dz = f.tz - RF.pWorld.z;
    aimA = (dx * dx + dz * dz) > 0.02 ? Math.atan2(dx, dz) : RF.pWorld.face;
    aimOff = 0; aimTgt = null; aimSpot = ''; aimGull = false;
    repT = 0; repBox.className = '';
    /* the press that STARTED this cast is the one we wait to see end — seeding
       this true is what lets a quick tap fire a short flick cast next frame
       instead of hanging on the charge until the six-second timeout */
    heldAct = true;
  }

  function releaseCast() {
    const f = RF.fishing, t = aimTgt || aimAt(aimA + aimOff, reachNow());
    if (t) { f.tx = t.x; f.tz = t.z; castReach = t.d; }
    else castReach = Math.hypot(f.tx - RF.pWorld.x, f.tz - RF.pWorld.z);
    castClean = Math.abs(power - bandC) <= bandW;
    castGull = gullAt(f.tx, f.tz);
    castQ = 1;
    if (castClean) castQ *= 0.62;              // it lands soft; the water never knows
    else if (power > 0.88) castQ *= 1.22;      // a slapped cast puts the whole bay down
    expectBite = true; ph = 'fly';
    try {
      fn.sweep(260 + power * 200, 900 + power * 500, 0.16, 'sine', 0.035);
      if (castClean) { fn.beep(1320, 0.06, 'triangle', 0.03); fn.addShake(0.02); }
    } catch (e) {}
    aimRing.visible = aimDot.visible = false;
  }

  /* Consumed exactly once, for the cast we just made. The planted auto-rig
     calls biteTime() too and must never inherit your clean release. */
  RF.modify('biteTime', v => {
    if (!expectBite || RF.fishing.state !== 'wait') return;
    expectBite = false; return v * castQ;
  });

  function onHookset(f) {
    const react = f.t;                  // core never resets t at the take — that IS the reaction time
    hookGrade = react <= 0.20 ? 'perfect' : react <= 0.42 ? 'clean' : 'late';
    /* A fish that pulls harder simply has more to give. Offline core has already
       put the real species on the line, so `fight` is the honest weight; signed
       in it is a flat 0.7 and every fight is the same middling one, which is
       exactly as much as the client is allowed to know. */
    const wt = clamp((f.fight - 0.5) / 0.85, 0, 1);
    stam = 1; spentFish = false; wasSurge = false;
    runCount = 0; runAge = 0; runName = ''; runSide = Math.random() < 0.5 ? -1 : 1;
    fightAge = 0; peakLoad = 0;
    fightTired = 0.72 + wt * 1.15;
    if (hookGrade === 'perfect') {
      stam = 0.70; f.reel = Math.max(f.reel, 0.14);
      try { fn.addShake(0.06); fn.beep(1046, 0.07, 'triangle', 0.045); fn.beep(1568, 0.09, 'sine', 0.028); } catch (e) {}
      if (decorOn()) ripple(RF.bobber.position.x, RF.bobber.position.z, 0.75, 2.0);
    } else if (hookGrade === 'late') {
      f.tens = Math.max(f.tens, 0.30);  // a slow hand starts the fight already loaded
    }
    /* THE GULLS, MADE HONEST. core's rollFish() is the only thing that decides a
       species, and it already ran — so the shoal pays the same way core's own
       weather and hull bonuses do: one more draw from the very same table, kept
       only if it beats the first. Offline only; signed in the server rolled it
       and nothing here may touch the result. */
    if (!RF.online && f.hooked && shoal && gullAt(RF.bobber.position.x, RF.bobber.position.z)) {
      try {
        if (Math.random() < clamp(shoal.kind.luck * 0.28, 0, 0.5)) {
          const g = fn.rollFish();
          if (g && (RORD[g.rar] | 0) > (RORD[f.hooked.rar] | 0)) {
            f.hooked = g; f.fight = ({ common: 0.52, uncommon: 0.66, rare: 0.86, epic: 1.06, legendary: 1.32 })[g.rar] || 0.7;
          }
        }
      } catch (e) { RF.err('angler:gullroll', e, 'warn'); }
    }
    ph = 'fight'; setRing.visible = setMark.visible = false;
  }

  function fightTick(dt, f) {
    const hold = !!RF.keys.act, D = DRAGS[dragIx];
    fightAge += dt; if (f.tens > peakLoad) peakLoad = f.tens;

    const surge = !!f.surge;
    if (surge && !wasSurge) {
      runCount++; runAge = 0; runSide = Math.random() < 0.5 ? -1 : 1;
      runName = RUN_NAMES[(Math.random() * RUN_NAMES.length) | 0];
      if (decorOn()) ripple(RF.bobber.position.x, RF.bobber.position.z, 0.8, 1.9);
    } else if (!surge && wasSurge) runName = '';
    wasSurge = surge;
    if (surge) runAge += dt;

    /* THE FIGHT IN FOUR SENTENCES. Work it inside the band and the fish burns
       down. Horse it through a run and the line loads hard for ground you lose
       anyway. Give line while it runs and the drag does the tiring for you.
       A spent fish stops fighting and the last stretch comes in easy.
       All four only ever nudge core's own tug-of-war, and every one that raises
       tension does so ONLY while you are holding — so a snap is always yours. */
    if (hold) {
      f.reel = clamp(f.reel + dt * D.r, 0, 1);
      f.tens = clamp(f.tens + dt * D.t * f.fight * (1 - (rodTierLuck() - 1) * 0.09), 0, 1);
      if (surge) {
        f.tens = clamp(f.tens + dt * 0.52, 0, 1);
        f.reel = clamp(f.reel - dt * 0.24, 0, 1);
      } else if (f.tens > 0.34 && f.tens < 0.78) {
        stam -= dt * (0.34 + D.s) / fightTired;
        f.reel = clamp(f.reel + dt * 0.15, 0, 1);
      }
    } else if (surge) {
      stam -= dt * 0.30 / fightTired;
    }

    if (stam <= 0 && !spentFish) {
      spentFish = true; stam = 0;
      f.surge = 0; f.surgeT = 99;                 // nothing left in it to run with
      try { fn.beep(392, 0.1, 'triangle', 0.04); fn.beep(523, 0.14, 'triangle', 0.035); } catch (e) {}
      if (decorOn()) ripple(RF.bobber.position.x, RF.bobber.position.z, 1.0, 2.4);
    }
    if (spentFish) { f.tens = clamp(f.tens - dt * 0.55, 0, 1); f.reel = clamp(f.reel + dt * 0.48, 0, 1); }
    stam = clamp(stam, 0, 1);

    /* the bobber comes in as you gain on it, and cuts sideways on every run */
    const bob = RF.bobber, px = RF.pWorld.x, pz = RF.pWorld.z;
    if (!anchored) { anchored = true; anchorX = bob.position.x; anchorZ = bob.position.z; }
    const dx = anchorX - px, dz = anchorZ - pz, dl = Math.max(0.001, Math.hypot(dx, dz));
    const sw = Math.sin(RF.clock * (surge ? 4.2 : 1.7)) * runSide * (surge ? 0.62 : 0.13) * (1 - f.reel * 0.45);
    bob.position.x = lerp(anchorX, px, f.reel * 0.58) + (-dz / dl) * sw;
    bob.position.z = lerp(anchorZ, pz, f.reel * 0.58) + (dx / dl) * sw;
    if (surge) bob.position.y -= Math.min(0.26, runAge * 0.7);   // it sounds, and the float goes under
  }

  function fightReport(kind, f) {
    const t = fightAge.toFixed(1) + 's', pk = Math.round(peakLoad * 100) + '%';
    const hk = hookGrade === 'perfect' ? '<span class="k">perfect hookset</span>'
      : hookGrade === 'late' ? '<span class="d">a slow hookset</span>' : 'clean hookset';
    const rn = runCount === 0 ? 'no runs' : runCount === 1 ? '1 run' : runCount + ' runs';
    lastReport = { kind: kind, seconds: +fightAge.toFixed(2), runs: runCount, peak: +peakLoad.toFixed(3),
      hookset: hookGrade, playedOut: spentFish, drag: DRAGS[dragIx].n };
    if (kind === 'land')
      report('landed in <span class="k">' + t + '</span> · ' + rn + ' · ' + hk + ' · line peaked ' + pk
        + (spentFish ? ' · <span class="d">played out</span>' : '')
        + ' <span class="d">· ' + DRAGS[dragIx].n + ' drag</span>', 'good');
    else if (kind === 'snap')
      report('the line let go at <span class="k">' + t + '</span> · ' + rn + ' · you carried it at ' + pk
        + ' <span class="d">· ' + DRAGS[dragIx].n + ' drag</span>', 'bad');
    else if (kind === 'miss')
      report('too slow off the take · <span class="d">the hook never found anything</span>', 'bad');
  }

  /* ---- the drag dial, and the one thing only the key can tell us ---- */
  RF.on('keydown', e => {
    try {
      if (!e) return;
      /* core's cancelFish() looks identical whether the line SNAPPED or you just
         walked away, and by the time a frame hook sees it the tension has been
         zeroed. Watching ESC go past is the only honest way to separate the two;
         we never claim it, so core cancels exactly as it always did. */
      if (e.code === 'Escape') { escAt = RF.clock; return; }
      /* Shift+B, never KeyQ. SPEC §4 gives KeyQ to 05-progress and says a second
         binding rides a modifier on a key you already own; taking Q "only while
         the rod is out" is still taking it, and this slot claims keys first, so
         the quest log would go dead for the whole fishing loop. §9's bait panel
         ignores shifted B precisely so this dial can have it. */
      if (e.code !== 'KeyB' || !e.shiftKey || typing()) return;
      if (!RF.running || RF.panelOpen || ph === 'idle') return;
      e.preventDefault();
      dragIx = (dragIx + 1) % 3; storeDirty = true;
      const D = DRAGS[dragIx];
      try { fn.beep(520 + dragIx * 160, 0.05, 'square', 0.032); } catch (err) {}
      say({ level: dragIx === 2 ? 'warn' : 'info', tag: 'angler-drag', ttl: 3000,
        title: 'Drag: ' + D.n, body: D.sub });
      return true;
    } catch (err) { RF.err('angler:drag', err, 'warn'); }
  });

  /* Core's own hint still narrates the bite and the wait; these three phases are
     ours, so they get the instruction that actually applies. */
  RF.modify('hint', h => {
    if (ph === 'charge') return '<span class="key">E</span> hold to load · <span class="key">A</span>'
      + '<span class="key">D</span> swing the aim · let go to cast';
    if (ph === 'fly') return 'the line arcs out…';
    if (ph === 'take') return '<b style="color:var(--rose)">!</b> <b>SET THE HOOK</b> — <span class="key">E</span>';
    if (ph === 'fight' && !RF.fishing.surge)
      return 'hold <span class="key">E</span> to work it · <span class="key">Shift</span>+<span class="key">B</span>'
        + ' drag · let go when it runs';
    return;
  }, 10);   // after §7's gauge rewrite, so the fight line is the one that lands

  /* ---------------------------------------------------------------------- */
  /* 15. THE ROD FRAME                                                      */
  /* ---------------------------------------------------------------------- */
  let rodPrev = 'idle';
  RF.on('frame', dt => {
    try {
      if (dt > 0.25) dt = 0.25;
      if (repT > 0 && (repT -= dt) <= 0) repBox.className = '';
      const f = RF.fishing; if (!f) return;
      const st = f.state;

      if (st !== rodPrev) {
        if (st === 'cast' && rodPrev === 'idle') beginCharge();
        else if (st === 'wait' && rodPrev === 'cast') ph = 'soak';
        else if (st === 'bite' && rodPrev === 'wait') ph = 'take';
        else if (st === 'reel' && rodPrev === 'bite') { anchored = false; onHookset(f); }
        else if (st === 'idle' && rodPrev === 'reel') {
          /* full spool = landed · ESC in the last beat = you walked away ·
             anything else = the line went */
          /* one ESC is worth exactly one ending — consume it, or a missed take a
             beat later gets misread as another walk-away */
          const bailedR = RF.clock - escAt < 0.25; escAt = -99;
          fightReport(f.reel >= 0.999 ? 'land' : bailedR ? 'off' : 'snap', f);
          resetRod();
        } else if (st === 'idle' && rodPrev === 'bite') {
          const bailedB = RF.clock - escAt < 0.25; escAt = -99;
          if (!bailedB) fightReport('miss', f);
          resetRod();
        } else if (st === 'idle') resetRod();
        rodPrev = st;
      }

      if (ph === 'idle' || !RF.running) { if (ph !== 'idle') resetRod(); return; }
      /* a panel over the top freezes the rod exactly where it was: no cast is
         lost because the inventory happened to open mid-charge */
      if (RF.panelOpen) { if (ph === 'charge') f.cast = Math.min(f.cast, windup); castShow(false, false); return; }

      castShow(ph !== 'soak', ph === 'fight');
      const px = RF.pWorld.x, pz = RF.pWorld.z;

      /* ---- 6/7/8: load it, band it, show where it will land ---- */
      if (ph === 'charge') {
        chargeT += dt;
        windup = Math.min(0.235, windup + dt * 0.9);   // let core's whip play its wind-up, then hold the pose
        f.cast = Math.min(f.cast, windup);
        power += powDir * dt * 0.82;
        if (power >= 1) { power = 1; powDir = -1; }
        if (power <= 0.06) { power = 0.06; powDir = 1; }
        if (RF.keys.left) aimOff -= dt * 0.95;
        if (RF.keys.right) aimOff += dt * 0.95;
        aimOff = clamp(aimOff, -1, 1);

        aimTgt = aimAt(aimA + aimOff, reachNow());
        aimGull = !!aimTgt && gullAt(aimTgt.x, aimTgt.z);
        aimSpot = aimTgt ? bottomAt(aimTgt.x, aimTgt.z) : '';
        if (aimTgt) {
          const col = aimGull ? 0xffcf5c : 0x39d7c4;
          aimRing.position.set(aimTgt.x, WT + 0.07, aimTgt.z);
          aimDot.position.copy(aimRing.position);
          aimRing.material.color.setHex(col); aimDot.material.color.setHex(col);
          aimRing.material.opacity = aimGull ? 0.8 : 0.55;
          aimDot.material.opacity = 0.75;
          aimRing.scale.setScalar(0.9 + (reduced ? 0 : Math.sin(RF.clock * 5) * 0.07));
          aimRing.visible = aimDot.visible = true;
        } else aimRing.visible = aimDot.visible = false;

        const rm = rodOf();
        if (rm) { vTip.copy(rm.userData.tip); rm.localToWorld(vTip); RF.bobber.position.copy(vTip); }

        const inBand = Math.abs(power - bandC) <= bandW;
        const depth = aimTgt ? Math.max(0, WT - fn.heightAt(aimTgt.x, aimTgt.z)) : 0;
        castPaint(inBand ? 'good' : '', 'CAST',
          aimTgt ? (aimGull ? '<span style="color:var(--gold)">under the gulls</span> · '
              : '<span style="color:var(--teal)">' + aimSpot + '</span> · ')
              + aimTgt.d.toFixed(1) + ' m · ' + depth.toFixed(1) + ' m down'
            : '<span style="color:var(--rose)">no water that way</span>',
          power,
          'Lv.' + RF.state.rodLvl + ' rod · line rated <b>' + lineRating() + ' kg</b> · '
            + DRAGS[dragIx].n + ' drag <span class="key">Shift</span>+<span class="key">B</span>',
          (Math.max(0, bandC - bandW) * 100).toFixed(1) + '%,' + (bandW * 200).toFixed(1) + '%');

        if ((heldAct && !RF.keys.act) || chargeT > 6.5) releaseCast();  // your arm gets tired eventually
        heldAct = !!RF.keys.act;
        return;
      }

      if (ph === 'fly') {
        castPaint(castClean ? 'good' : '', 'CAST', castReach.toFixed(1) + ' m', f.cast,
          castClean ? '<b>a clean cast</b> · it lands soft and the water never knows'
            : 'it lands where it lands', '');
        return;
      }

      /* ---- 9: the take ---- */
      if (ph === 'take') {
        const k = clamp(f.t / 0.85, 0, 1), early = f.t <= 0.20;
        const bx = RF.bobber.position.x, bz = RF.bobber.position.z;
        setRing.position.set(bx, WT + 0.08, bz); setMark.position.set(bx, WT + 0.08, bz);
        setRing.scale.setScalar(lerp(2.6, 0.42, k));
        setRing.material.opacity = 0.78 * (1 - k * 0.4);
        setRing.material.color.setHex(early ? 0x74e08a : 0xffcf5c);
        setMark.material.opacity = 0.55;
        setRing.visible = setMark.visible = decorOn();
        castPaint(early ? 'good' : 'danger', 'SET THE HOOK',
          early ? '<span style="color:var(--c-uncommon)">now</span>' : 'it is spitting it out',
          1 - k,
          'early sets it clean and the fish starts tired · late and you start already loaded',
          '76.5%,23.5%');
        return;
      }

      /* ---- 10: the fight ---- */
      if (ph === 'fight') {
        fightTick(dt, f);
        castPaint(spentFish ? 'spent' : f.surge ? 'danger' : stam < 0.35 ? 'warn' : '',
          f.surge ? 'IT RUNS' : spentFish ? 'PLAYED OUT' : 'FIGHT LEFT',
          '<span style="color:' + DRAGS[dragIx].c + '">' + DRAGS[dragIx].n + ' drag</span>'
            + (runCount ? ' · ' + runCount + (runCount === 1 ? ' run' : ' runs') : ''),
          stam,
          f.surge ? '<b>' + runName + '</b> — let go and let the drag do the tiring'
            : spentFish ? 'it has nothing left · bring it in'
            : 'hold <span class="key">E</span> in the middle of the line and it burns down',
          '34%,44%');
      }
    } catch (e) { RF.err('angler:rod', e); }
  });

  /* ---------------------------------------------------------------------- */
  /* 11. PUBLISHED SURFACE                                                  */
  /* ---------------------------------------------------------------------- */
  RF.api = RF.api || {};
  RF.api.angler = {
    /* copies, never the live objects — the journal reads, it does not steer */
    stats() {
      return {
        session: { casts: sess.casts, hookups: sess.hookups, landed: sess.landed, snapped: sess.snapped,
          missed: sess.missed, gaveUp: sess.gaveUp, longest: +sess.longest.toFixed(2),
          best: sess.best ? Object.assign({}, sess.best) : null },
        life: { casts: life.casts, hookups: life.hookups, landed: life.landed, snapped: life.snapped,
          longest: +life.longest.toFixed(2), best: life.best ? Object.assign({}, life.best) : null }
      };
    },
    shoal() {
      if (!shoal) return null;
      return { name: shoal.kind.name, sub: shoal.kind.sub, x: shoal.x, z: shoal.z, r: shoal.r,
        dist: +shoalDist().toFixed(2), inside: inShoal(),
        luck: shoal.kind.luck, biteMult: shoal.kind.bite,
        secondsLeft: Math.max(0, Math.round(shoal.life - (RF.clock - shoal.born))),
        cosmetic: RF.online };
    },
    /* the rod itself: what the player is doing with it right now, and how the
       last fight went. Read-only copies — the journal reports, it does not steer */
    rod() {
      return { phase: ph, drag: DRAGS[dragIx].n, dragIndex: dragIx,
        lineRating: +lineRating(), reach: +reachNow().toFixed(2),
        cleanCast: castClean, underGulls: castGull,
        hookset: hookGrade || null,
        fight: ph === 'fight'
          ? { left: +stam.toFixed(3), runs: runCount, seconds: +fightAge.toFixed(2),
              peak: +peakLoad.toFixed(3), playedOut: spentFish }
          : null,
        last: lastReport ? Object.assign({}, lastReport) : null };
    }
  };

  RF.on('start', () => {
    try { candidates(); nextShoalAt = RF.clock + rnd(45, 90); }
    catch (e) { RF.err('angler:start', e, 'warn'); }
  });

  /* ---------------------------------------------------------------------- */
  /* 16. THE HELM — the dock boat, taken out                                */
  /*                                                                        */
  /* Five hulls stand at the pier and until now every one was furniture:    */
  /* bought, admired, never boarded. This section puts the player at the    */
  /* wheel — short sails inside home waters, fishing off the deck — while   */
  /* touching nothing the server owns: position is not terrain-checked      */
  /* server-side, and boat luck is computed from state.boatLvl on both      */
  /* ends, so being aboard changes WHERE you cast from, never what the      */
  /* water gives you. The moored prop itself is sailed (found by its        */
  /* sail/lantern userData — core does not export dockBoat), so core's own  */
  /* bobbing, roll and sail flutter keep animating the hull for free while  */
  /* only x/z/yaw are ours.                                                 */
  /*                                                                        */
  /* Movement piggybacks on core's water rule instead of fighting it:       */
  /* tryMove() rejects every step onto water, so with the hero on a water   */
  /* cell core movement is naturally inert and the helm below is the only   */
  /* thing that answers the keys — same keys, opposite element. pWorld.step */
  /* is zeroed every tick so the stride counter never crosses pi: no        */
  /* footfall sfx and no leg-pumping while standing at a wheel.             */
  /* ---------------------------------------------------------------------- */
  let hAboard = false, hBoat = null, hHome = null, hShore = null, hHead = 0,
      hWakeAcc = 0, hLeashSaid = -99, hBtn = null;
  /* top-of-deck height per hull, boat-local: raft logs, dinghy sole, sloop
     deck plank, trawler deck, galleon main deck — read off makeBoat() */
  const HDECK = [0.2, 0.3, 0.66, 0.8, 0.94];
  const HFWD = new RF.THREE.Vector3(-1, 0, -1).normalize();
  const HRIGHT = new RF.THREE.Vector3().crossVectors(HFWD, new RF.THREE.Vector3(0, 1, 0)).normalize();
  const hDir = new RF.THREE.Vector3();
  const hLvl = () => clamp(RF.state.boatLvl | 0, 0, 4);
  /* the leash: "mid-sea but not far out" is the whole brief. A finer hull
     ranges further — a reason to build one that is not luck or seats. */
  const hLeash = () => 9 + hLvl() * 3;

  /* the realtime side (reelfortune3d wire): one message on board and one on
     ashore, never per frame. The server reads the LEVEL from its own save --
     this only says whether the captain is at the wheel. Offline, it is a
     no-op; a disconnect while at sea is the server's to notice. */
  function hWire(on) {
    try { if (window.RFNet && RFNet.online && typeof RFNet.send === 'function') RFNet.send({ t: 'boat', on: !!on }); }
    catch (e) { RF.err('angler:helm:wire', e, 'warn'); }
  }

  /* the one top-level group in the scene with rigging: dockBoat, wherever
     core moored it (the harbor preview hull lives in its own dockScene) */
  function hFind() {
    try {
      const ch = RF.scene.children;
      for (let i = 0; i < ch.length; i++) {
        const o = ch[i];
        if (o && o.userData && Array.isArray(o.userData.sails) && Array.isArray(o.userData.lanterns)) return o;
      }
    } catch (e) { RF.err('angler:helm:find', e, 'warn'); }
    return null;
  }

  function hBoard() {
    if (hAboard) return;
    const b = hFind();
    if (!b) { fn.toast('No hull at the pier', 'bad'); return; }
    hBoat = b;
    hHome = { x: b.position.x, z: b.position.z, yaw: b.rotation.y };   // the mooring pose, owed back
    hShore = { x: RF.pWorld.x, z: RF.pWorld.z };                       // where the boots left land
    hHead = b.rotation.y;
    hAboard = true;
    RF.pWorld.x = b.position.x; RF.pWorld.z = b.position.z; RF.pWorld.face = hHead;
    hWire(true);
    try { RF.sfx.sail(); } catch (e) {}
    fn.toast(fn.pixSVG('boat', 13) + ' You take the helm · sail with <span class="key">WASD</span>', 'good');
    hSyncBtn();
  }

  function hAshore() {
    if (!hAboard) return;
    hAboard = false;
    if (hBoat && hHome) { hBoat.position.x = hHome.x; hBoat.position.z = hHome.z; hBoat.rotation.y = hHome.yaw; }
    hWire(false);
    if (hShore) { RF.pWorld.x = hShore.x; RF.pWorld.z = hShore.z; }
    RF.pWorld.y = fn.heightAt(RF.pWorld.x, RF.pWorld.z);   // land the y-ease on ground, not mid-air off the deck
    try { RF.sfx.step('sand'); } catch (e) {}
    fn.toast('Back on solid ground', 'good');
    hSyncBtn();
  }

  /* -- the way aboard: one row in the harbor panel, where the boat already
        lives in the player's head. No new key, and no fight over the pier's
        E — core's harbor prompt and a shore-side board prompt would want
        the same press at the same spot. -- */
  function hSyncBtn() {
    if (!hBtn) return;
    hBtn.textContent = hAboard ? 'RETURN TO THE PIER' : 'SET SAIL';
    hBtn.className = 'btn ' + (hAboard ? 'rose' : 'gold');
  }
  function hMount() {
    const cur = document.getElementById('boatCur');
    if (!cur || document.getElementById('rf-angler-helm')) return;
    const row = document.createElement('div');
    row.id = 'rf-angler-helm'; row.className = 'fishrow';
    row.innerHTML = '<span class="nm">' + fn.pixSVG('boat', 15) + ' Take the wheel '
      + '<span style="color:var(--faint);font-size:11px">sail the home waters · fish from the deck · range <span id="rf-angler-helm-r"></span>m</span></span>';
    hBtn = document.createElement('button'); hBtn.type = 'button';
    hBtn.onclick = () => { try { if (hAboard) hAshore(); else { fn.closeHarbor(); hBoard(); } } catch (e) { RF.err('angler:helm:btn', e); } };
    row.appendChild(hBtn);
    cur.parentNode.insertBefore(row, cur.nextSibling);   // sibling of #boatCur: renderHarbor()'s innerHTML never clears it
    hSyncBtn();
  }
  RF.on('panel', (name, open) => {
    try {
      if (name !== 'harbor') return;
      if (open) {
        hMount(); hSyncBtn();
        const r = document.getElementById('rf-angler-helm-r'); if (r) r.textContent = String(hLeash());
      } else if (hAboard) {
        /* BUILD swaps the moored group for a fresh hull at the dock pose; if
           that happened from the deck, adopt the new hull out here */
        const b = hFind();
        if (b && b !== hBoat) {
          hHome = { x: b.position.x, z: b.position.z, yaw: b.rotation.y };
          b.position.x = RF.pWorld.x; b.position.z = RF.pWorld.z; b.rotation.y = hHead;
          hBoat = b;
        }
      }
    } catch (e) { RF.err('angler:helm:panel', e, 'warn'); }
  });

  /* aboard near the pier, E means ashore — everywhere else at sea the claim
     passes, and core's cast prompt plus this mod's charged cast rule as if
     the deck were any other bank */
  RF.on('interact', () => {
    try {
      if (!hAboard) return;
      if (RF.fishing.state !== 'idle' || ph !== 'idle') return;
      const hp = RF.HARBOR_POS;
      if (hp && Math.hypot(RF.pWorld.x - hp.x, RF.pWorld.z - hp.z) < 3.4) {
        fn.hint('<span class="key">E</span> Step ashore');
        if (RF.actEdge) hAshore();
        return true;
      }
    } catch (e) { RF.err('angler:helm:int', e, 'warn'); }
  });

  RF.on('tick', dt => {
    try {
      if (!hAboard) return;
      if (dt > 0.25) dt = 0.25;
      const P = RF.pWorld, lvl = hLvl();
      const deckY = (hBoat ? hBoat.position.y : WT + 0.03) + HDECK[lvl];
      /* core eased y toward the seabed and set player.position before this
         hook fires; both writes below land before the render pass, so the
         hero stands on the deck riding the same bob the hull does */
      P.y = deckY; P.step = 0;
      if (RF.player) { RF.player.position.x = P.x; RF.player.position.y = deckY; RF.player.position.z = P.z; }
      const busy = RF.panelOpen || RF.chatOpen || RF.fishing.state !== 'idle' || ph !== 'idle';
      if (!busy) {
        const ix = (RF.keys.right ? 1 : 0) - (RF.keys.left ? 1 : 0),
              iy = (RF.keys.up ? 1 : 0) - (RF.keys.down ? 1 : 0);
        if (ix || iy) {
          hDir.set(0, 0, 0).addScaledVector(HFWD, iy).addScaledVector(HRIGHT, ix);
          if (hDir.lengthSq() > 1e-4) {
            hDir.normalize();
            const sp = 3.6 + lvl * 0.9;                    // a raft wallows, a galleon strides
            const nx = P.x + hDir.x * sp * dt, nz = P.z + hDir.z * sp * dt;
            const hp = RF.HARBOR_POS, R = hLeash();
            let ok = fn.isWaterAt(nx, nz) && Math.abs(nx) < RF.HALF - 1.5 && Math.abs(nz) < RF.HALF - 1.5;
            if (ok && hp) {
              const dNew = Math.hypot(nx - hp.x, nz - hp.z);
              if (dNew > R && dNew > Math.hypot(P.x - hp.x, P.z - hp.z)) {
                ok = false;
                if (RF.clock - hLeashSaid > 4) { hLeashSaid = RF.clock;
                  fn.toast('Open sea ahead · your ' + esc(RF.BOATS[lvl].name) + ' keeps to home waters', ''); }
              }
            }
            if (ok) {
              P.x = nx; P.z = nz; P.face = Math.atan2(hDir.x, hDir.z); hHead = P.face;
              if (!reduced && (hWakeAcc += dt) > 0.22) { hWakeAcc = 0;
                try { fn.fxBurst(P.x - hDir.x * 1.2, WT + 0.12, P.z - hDir.z * 1.2,
                  { n: 3, cols: [0x7fdcff, 0xffffff], speed: 1.1, up: 1.2, size: 0.6, grav: 5 }); } catch (e) {}
              }
            }
          }
        }
      }
      /* the hull follows the helm a beat behind; y, roll, pitch and the
         sails stay core's to animate */
      if (hBoat) {
        const k = Math.min(1, dt * 8);
        hBoat.position.x = lerp(hBoat.position.x, P.x, k);
        hBoat.position.z = lerp(hBoat.position.z, P.z, k);
        hBoat.rotation.y = fn.lerpAngle(hBoat.rotation.y, hHead, Math.min(1, dt * 5));
      }
    } catch (e) { RF.err('angler:helm', e); }
  });

  /* read-only, like the rest of RF.api.angler: the aboard-state another mod
     or the presence payload can carry to other players */
  if (RF.api && RF.api.angler) RF.api.angler.helm =
    () => ({ aboard: hAboard, lvl: hLvl(), yaw: +hHead.toFixed(2), range: hLeash() });
});
