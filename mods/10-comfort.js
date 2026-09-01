/* ============================================================================
   10-COMFORT — the settings, accessibility, save-safety and performance layer.

   1. The Options overlay (O) — six glass tabs, every control live, all of it
      restored from RF.store before the first frame the player sees.
   2. Quality presets — potato…ultra driving render scale, shadows and shadow
      resolution, plus the shared rfQuality signal every other mod reads.
   3. The frame-budget watchdog — drops a tier when the budget is blown for
      three seconds straight, climbs back when the headroom returns, says so.
   4. The perf readout (F3) — fps sparkline, p95 frame time, draw calls,
      triangles, heap, render scale, and which mods actually loaded.
   5. Rebindable controls with a real conflict check — the displaced key stops
      working, the new one drives core's own edge detection.
   6. A true pause (`) — the render loop itself is held, not just the player.
   7. Colour-blind rarity palettes — rewrites the CSS tokens AND the live RAR
      table, so reveal cards, sprites and inventory borders all follow.
   8. Motion, shake and flash reduction — one master that publishes rf-reduced
      and zeroes the shake/freeze pipes for every mod at once.
   9. HUD scale, HUD opacity, interface size and a larger-text floor.
  10. Camera comfort — zoom range, step, invert, and a zoom it remembers.
  11. Save safety — rotating backups, storage health, export to file, restore.
  12. The control card — a live keyboard card, shown once on the first sail.
   ========================================================================== */
RF.mod('10-comfort', function (RF) {
  'use strict';

  /* classes here are all rfc- (short for rf-comfort), ids all rf-comfort-… */
  const D = document, BODY = document.body;
  const clamp = RF.fn.clamp, F = RF.fn;
  const say = o => (RF.api && RF.api.notify) ? RF.api.notify(o)
    : F.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : o.level === 'warn' ? 'bad' : '');
  const ask = o => (RF.api && RF.api.confirm) ? RF.api.confirm(o) : Promise.resolve(false);

  /* ---------------------------------------------------------------- state */
  const DEF = {
    quality: 'high', autoQ: true, rscale: 1, shadows: 1, shadowRes: 2048, glass: true,
    volMaster: 1, volMusic: 1, volSfx: 1, volAmb: 0.9, mute: false,
    hudScale: 1, hudOpacity: 1, uiScale: 1, bigText: false,
    motion: 'auto', shake: 1, freeze: 1, flash: 1,
    palette: 'default',
    zoomMin: 7, zoomMax: 17, zoomStep: 1.1, zoomInv: false, zoomKeep: true, camSize: 10.5,
    binds: null, pauseBlur: true, pauseAudio: true,
    perf: 0, backups: true, cardSeen: false
  };
  const S = Object.assign({}, DEF, RF.store.get('10-comfort', null) || {});
  /* a save written by an older build can carry keys that no longer exist and
     miss ones that now do; the merge above fixes the second, this the first */
  for (const k in S) if (!(k in DEF)) delete S[k];
  let saveT = 0;
  const persist = () => { S._v = 1; RF.store.set('10-comfort', S); };

  const QUAL = {
    potato: { rscale: 0.5, shadows: 0, shadowRes: 512, tag: 'low', lab: 'potato' },
    low: { rscale: 0.7, shadows: 0, shadowRes: 1024, tag: 'low', lab: 'low' },
    med: { rscale: 0.85, shadows: 1, shadowRes: 1024, tag: 'med', lab: 'medium' },
    high: { rscale: 1, shadows: 1, shadowRes: 2048, tag: 'high', lab: 'high' },
    ultra: { rscale: 1.3, shadows: 1, shadowRes: 4096, tag: 'ultra', lab: 'ultra' },
    /* Opt-in only. Twice the render scale is four times the pixels of high, so
       the watchdog is forbidden from ever choosing it (optIn) — it may only
       leave. dpr is the ceiling this tier asks game.js for; every other tier
       asks for the 2 the engine shipped with. */
    '4k': { rscale: 2, shadows: 1, shadowRes: 4096, tag: '4k', lab: '4K', dpr: 4, optIn: true }
  };
  const QORDER = ['potato', 'low', 'med', 'high', 'ultra', '4k'];
  /* the highest rung the frame-budget watchdog may climb to on its own */
  const AUTO_TOP = QORDER.reduce((m, k, i) => QUAL[k].optIn ? m : i, 0);

  /* The backing-store ceiling, in pixels, for the whole ladder: 3840 x 2160.
     A 4K panel at rscale 2.0 would otherwise ask for 7680 x 4320 — 33 M pixels,
     four times what the mid-range card this ladder is written for (GTX 1650,
     RX 6500, M1, Iris Xe) can shade at 60 fps with the shadow pass on. 8.3 M is
     where that class of GPU still holds the frame, and it is a number the tier
     can be honest about: on a 1080p window 4K really does draw 3840 x 2160 and
     hand the extra to the downsample. The cap is on the ladder, not on its top
     rung — cap only 4k and ultra on a retina panel would quietly allocate more
     than the tier above it. */
  const PIXBUDGET = 3840 * 2160;

  const RARK = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const RAR0 = RARK.map(k => (RF.RAR && RF.RAR[k]) || '#b9c6c4');
  /* Each ramp keeps a lightness staircase as well as a hue split, so the five
     tiers stay separable even for a player who reads no hue at all. */
  const PAL = {
    default: { lab: 'as painted', c: RAR0 },
    deutan: { lab: 'deuteran', c: ['#a8b4b2', '#5ad2e8', '#3f7bff', '#c98bff', '#ffcf5c'] },
    protan: { lab: 'protan', c: ['#a8b4b2', '#59dcc8', '#4aa3ff', '#b98cff', '#ffe07a'] },
    tritan: { lab: 'tritan', c: ['#8f9c9a', '#5fe07f', '#ff8a5c', '#ff4f9d', '#f2f7f0'] },
    contrast: { lab: 'high contrast', c: ['#ffffff', '#00e676', '#26b6ff', '#d072ff', '#ffd600'] }
  };

  /* the ten core actions a player may move; arrows/Space/Tab stay as fixed
     seconds, so a botched rebind can never lock anyone out of the world */
  const DEFB = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', act: 'KeyE', inv: 'KeyI', chat: 'KeyT', auto: 'KeyF', photo: 'KeyP', cam: 'KeyC' };
  const ABASE = [
    ['up', 'Walk up', 'Arrow ↑'], ['down', 'Walk down', 'Arrow ↓'],
    ['left', 'Walk left', 'Arrow ←'], ['right', 'Walk right', 'Arrow →'],
    ['act', 'Cast · interact', 'Space'], ['inv', 'Inventory', 'Tab'],
    ['chat', 'Chat', '—'], ['auto', 'Auto-rig', '—'],
    ['photo', 'Photo mode', '—'], ['cam', 'Captain cam', '—']
  ];
  const MINE = { KeyO: 1, F3: 1, Backquote: 1 };
  if (!S.binds || typeof S.binds !== 'object') S.binds = {};
  for (const a in DEFB) if (typeof S.binds[a] === 'undefined') S.binds[a] = DEFB[a];

  const keyLab = c => !c ? 'unbound'
    : c.indexOf('Key') === 0 ? c.slice(3)
      : c.indexOf('Digit') === 0 ? c.slice(5)
        : c === 'Space' ? 'Space' : c === 'Escape' ? 'Esc' : c === 'Backquote' ? '`'
          : c === 'ArrowUp' ? '↑' : c === 'ArrowDown' ? '↓' : c === 'ArrowLeft' ? '←' : c === 'ArrowRight' ? '→'
            : c.indexOf('Numpad') === 0 ? 'Num ' + c.slice(6) : c;

  /* ------------------------------------------------------------ the styles */
  RF.css(`
  #rf-comfort-gear,#rf-comfort-fps{position:fixed;right:12px;z-index:28;font-family:"IBM Plex Mono",monospace;
    font-size:11px;letter-spacing:.1em;color:var(--muted);background:var(--glass);
    backdrop-filter:blur(12px) saturate(1.5);-webkit-backdrop-filter:blur(12px) saturate(1.5);
    border:1px solid var(--glass-bd-soft);border-radius:9px;padding:6px 10px;cursor:pointer;}
  #rf-comfort-gear{bottom:46px;}
  #rf-comfort-gear:hover{border-color:var(--teal);color:var(--ink);}
  #rf-comfort-gear .rfc-cog{display:inline-block;width:8px;height:8px;margin-right:6px;vertical-align:0;
    border:2px solid currentColor;border-radius:2px;transform:rotate(45deg);}
  /*
     The bottom-right corner is a STACK, 32px to a rung. Three mods had all
     independently picked 46-48px for it and drawn on top of each other, so the
     allocation is written out here and repeated at each site:
        14  #mute (SOUND, index.html)     46  #rf-comfort-gear (OPTIONS)
        78  #rf-social-hud (ONLINE)      110  .hd-logbtn (L, the log)
       142  #rf-comfort-fps / -perf
     Anything new takes the next free rung and adds itself to this list.
  */
  #rf-comfort-fps{bottom:142px;display:none;font-family:"Chakra Petch",sans-serif;font-weight:700;
    font-variant-numeric:tabular-nums;color:var(--teal);cursor:default;}
  #rf-comfort-fps.on{display:block;}
  #rf-comfort-fps.warn{color:var(--gold);}#rf-comfort-fps.bad{color:var(--rose);}
  body.photo #rf-comfort-gear,body.photo #rf-comfort-fps,body.photo #rf-comfort-perf,
  body.capcam #rf-comfort-gear,body.capcam #rf-comfort-fps,body.capcam #rf-comfort-perf{display:none!important;}

  #rf-comfort-perf{position:fixed;right:12px;bottom:142px;z-index:28;display:none;width:236px;
    background:var(--glass-sheen),var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);
    -webkit-backdrop-filter:blur(14px) saturate(1.6);border:1px solid var(--glass-bd);border-radius:12px;
    padding:10px 12px 11px;box-shadow:var(--glass-hi),0 8px 24px rgba(2,8,10,.35);}
  #rf-comfort-perf.on{display:block;}
  #rf-comfort-perf h4{font-family:"Chakra Petch",sans-serif;font-size:11px;letter-spacing:.22em;
    color:var(--faint);font-weight:600;margin-bottom:6px;text-transform:uppercase;}
  #rf-comfort-spark{display:block;width:212px;height:34px;border-radius:6px;background:rgba(255,255,255,.04);margin-bottom:7px;}
  .rfc-pf{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);line-height:1.65;}
  .rfc-pf b{font-family:"Chakra Petch",sans-serif;color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600;}
  .rfc-pf b.ok{color:var(--teal);}.rfc-pf b.warn{color:var(--gold);}.rfc-pf b.bad{color:var(--rose);}

  #rf-comfort-ov,#rf-comfort-card{position:fixed;inset:0;z-index:26;display:none;align-items:center;justify-content:center;
    background:radial-gradient(130% 100% at 50% -10%,rgba(14,26,32,.4),rgba(3,8,10,.66));
    backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);}
  #rf-comfort-ov.on,#rf-comfort-card.on{display:flex;}
  .rfc-card{width:min(720px,95vw);max-height:88vh;display:flex;flex-direction:column;
    background:var(--glass-sheen),var(--glass-strong);backdrop-filter:blur(18px) saturate(1.6);
    -webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);border-radius:20px;
    padding:20px 22px 16px;box-shadow:var(--glass-hi),0 30px 80px rgba(0,0,0,.5);}
  .rfc-tabs{display:flex;gap:6px;margin:12px 0 10px;flex-wrap:wrap;}
  .rfc-tabs button{flex:1 1 90px;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;
    letter-spacing:.12em;padding:8px 0;border-radius:10px;cursor:pointer;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--muted);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);
    transition:color .12s,border-color .12s,box-shadow .12s;}
  .rfc-tabs button:hover{color:var(--ink);border-color:var(--glass-bd);}
  .rfc-tabs button.on{color:var(--teal);border-color:rgba(57,215,196,.55);
    box-shadow:inset 0 0 0 1px rgba(57,215,196,.3),0 0 12px rgba(57,215,196,.15);}
  #rf-comfort-body{overflow-y:auto;flex:1;padding-right:4px;min-height:200px;}
  #rf-comfort-body::-webkit-scrollbar{width:6px;}
  #rf-comfort-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px;}
  .rfc-sec{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin:14px 0 7px;}
  .rfc-sec:first-child{margin-top:2px;}
  .rfc-row{display:flex;align-items:center;gap:12px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:11px;padding:9px 13px;margin-bottom:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rfc-lab{flex:1;min-width:0;}
  .rfc-lab b{display:block;font-size:12.5px;font-weight:600;color:var(--ink);}
  .rfc-lab span{display:block;font-size:10px;color:var(--muted);margin-top:1px;line-height:1.4;}
  .rfc-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px;}
  .rfc-sw{width:40px;height:22px;border-radius:11px;border:1px solid var(--glass-bd);background:rgba(0,0,0,.28);
    cursor:pointer;position:relative;padding:0;transition:background .15s,border-color .15s;}
  .rfc-sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--faint);
    transition:transform .15s cubic-bezier(.2,.8,.2,1),background .15s;}
  .rfc-sw.on{background:rgba(57,215,196,.22);border-color:rgba(57,215,196,.6);}
  .rfc-sw.on i{transform:translateX(18px);background:var(--teal);box-shadow:0 0 8px rgba(57,215,196,.7);}
  .rfc-rg{-webkit-appearance:none;appearance:none;width:126px;height:4px;border-radius:2px;background:rgba(255,255,255,.16);outline:none;}
  .rfc-rg::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--teal);
    cursor:pointer;box-shadow:0 0 8px rgba(57,215,196,.55);}
  .rfc-rg::-moz-range-thumb{width:14px;height:14px;border:none;border-radius:50%;background:var(--teal);cursor:pointer;}
  .rfc-val{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;color:var(--teal);
    font-variant-numeric:tabular-nums;min-width:46px;text-align:right;}
  .rfc-seg{display:flex;border:1px solid var(--glass-bd-soft);border-radius:9px;overflow:hidden;background:rgba(0,0,0,.2);}
  .rfc-seg button{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.05em;padding:6px 9px;
    border:none;background:none;color:var(--muted);cursor:pointer;transition:color .12s,background .12s;}
  .rfc-seg button+button{border-left:1px solid var(--glass-bd-soft);}
  .rfc-seg button:hover{color:var(--ink);background:rgba(255,255,255,.05);}
  .rfc-seg button.on{color:var(--teal-ink);background:var(--teal);font-weight:600;}
  .rfc-note{font-size:10.5px;color:var(--muted);line-height:1.55;padding:2px 3px 6px;}
  .rfc-note b{color:var(--gold);font-weight:600;}
  /* a div, not a span: index.html's restyle hides every span inside .rfc-lab,
     and this one is the only line in a row that has to stay readable */
  .rfc-res{display:block;margin-top:3px;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;
    letter-spacing:.08em;color:var(--teal);font-variant-numeric:tabular-nums;}
  .rfc-note.rfc-4k{border-left:2px solid var(--gold);padding-left:9px;margin:0 0 7px;color:var(--lab);}
  /* six rungs where there were five: on a narrow card the segment drops to its
     own line instead of crushing the label it sits next to */
  .rfc-seg{flex-wrap:wrap;}
  @media (max-width:600px){ .rfc-row{flex-wrap:wrap;} .rfc-ctl{margin-left:auto;} }
  .rfc-warn{border-color:rgba(255,93,122,.5)!important;}
  .rfc-warn .rfc-lab b{color:var(--rose);}
  .rfc-kb{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;letter-spacing:.06em;min-width:72px;
    padding:6px 10px;border-radius:8px;cursor:pointer;border:1px solid var(--glass-bd-soft);
    background:rgba(0,0,0,.22);color:var(--ink);transition:border-color .12s,color .12s;}
  .rfc-kb:hover{border-color:rgba(57,215,196,.6);color:var(--teal);}
  .rfc-kb.cap{border-color:var(--gold);color:var(--gold);animation:rfc-pulse 1s ease-in-out infinite;}
  .rfc-kb.none{color:var(--rose);border-color:rgba(255,93,122,.45);}
  @keyframes rfc-pulse{0%,100%{opacity:1;}50%{opacity:.5;}}
  .rfc-also{font-size:10px;color:var(--faint);min-width:42px;text-align:right;}
  .rfc-pal{display:flex;gap:3px;}
  .rfc-pal i{width:15px;height:15px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);}
  .rfc-foot{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--glass-bd-soft);}
  .rfc-foot .rfc-sp{flex:1;font-size:10px;color:var(--faint);letter-spacing:.06em;}
  .rfc-mods{display:flex;flex-wrap:wrap;gap:5px;}
  .rfc-mods span{font-size:9.5px;letter-spacing:.05em;padding:3px 7px;border-radius:6px;
    border:1px solid var(--glass-bd-soft);color:var(--muted);background:rgba(255,255,255,.04);}
  .rfc-mods span.ok{color:var(--teal);border-color:rgba(57,215,196,.35);}
  .rfc-mods span.bad{color:var(--rose);border-color:rgba(255,93,122,.45);}

  #rf-comfort-pause{position:fixed;inset:0;z-index:27;display:none;align-items:center;justify-content:center;
    background:radial-gradient(120% 100% at 50% 40%,rgba(6,16,20,.55),rgba(2,6,8,.82));
    backdrop-filter:blur(10px) saturate(.8);-webkit-backdrop-filter:blur(10px) saturate(.8);}
  #rf-comfort-pause.on{display:flex;}
  .rfc-pbox{text-align:center;}
  .rfc-pbox h3{font-family:"Chakra Petch",sans-serif;font-size:44px;letter-spacing:.28em;color:var(--ink);
    text-shadow:0 0 30px rgba(57,215,196,.35);}
  .rfc-pbox p{font-size:11.5px;color:var(--muted);letter-spacing:.1em;margin:4px 0 20px;}
  .rfc-pbox .rfc-pb{display:flex;gap:9px;justify-content:center;}

  .rfc-keys{display:grid;grid-template-columns:repeat(auto-fit,minmax(206px,1fr));gap:6px;}
  .rfc-key{display:flex;align-items:center;gap:10px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:10px;padding:7px 11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rfc-key kbd{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;min-width:34px;text-align:center;
    padding:4px 6px;border-radius:6px;background:rgba(0,0,0,.3);border:1px solid var(--glass-bd);
    box-shadow:0 2px 0 rgba(2,8,10,.7);color:var(--teal);}
  .rfc-key span{font-size:11px;color:var(--muted);}

  /* --- glass ------------------------------------------------------------
     A hundred-odd blur declarations sit between the player and a canvas that
     redraws every frame, and every one of them is a compositor readback that
     can never be cached. The bottom tier already halves the resolution and
     drops the shadows; it must not then pay full price for frosting. The
     switch offers the same win to anyone who would rather keep the pixels. */
  body[data-rf-quality="low"],body[data-rf-quality="low"] *,
  body[data-rf-quality="low"] *::before,body[data-rf-quality="low"] *::after,
  body.rfc-flat,body.rfc-flat *,body.rfc-flat *::before,body.rfc-flat *::after{
    backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}

  /* --- touch geometry ----------------------------------------------------
     11-touch dresses ".overlay .card" and this panel is its own card, so the
     one screen that exists to make the game fit the player is the one screen
     touch never reached: 22px switches and 4px slider tracks under a finger. */
  body.rf-touch .rfc-sw{width:60px;height:34px;border-radius:17px;}
  body.rf-touch .rfc-sw i{top:3px;left:3px;width:26px;height:26px;}
  body.rf-touch .rfc-sw.on i{transform:translateX(26px);}
  body.rf-touch .rfc-rg{height:36px;background:none;}
  body.rf-touch .rfc-rg::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:rgba(255,255,255,.16);}
  body.rf-touch .rfc-rg::-webkit-slider-thumb{width:26px;height:26px;margin-top:-10px;}
  body.rf-touch .rfc-rg::-moz-range-track{height:6px;border-radius:3px;background:rgba(255,255,255,.16);}
  body.rf-touch .rfc-rg::-moz-range-thumb{width:26px;height:26px;}
  body.rf-touch .rfc-seg button{padding:12px 15px;min-height:44px;font-size:11.5px;}

  /* --- the shared accessibility signals other mods read off the body ------ */
  body.rf-reduced .mark,body.rf-reduced .mark::before,body.rf-reduced .mark::after,
  body.rf-reduced #reveal.on,body.rf-reduced #spinResult.pop .win{animation:none!important;}
  body.rf-reduced .coinfly{display:none!important;}
  body.rf-reduced .rfc-kb.cap{animation:none!important;opacity:1;}
  /* two perpetual loops nobody guarded: the sail button breathes on the first
     screen a player ever sees, and the wheel's arm pulses for as long as a bet
     is live — the two longest-lived animations in the game */
  body.rf-reduced .cta,body.rf-reduced #spinBtn:not(:disabled){animation:none!important;}
  body.rf-noflash #winFlash{display:none!important;}
  @media (prefers-reduced-motion:reduce){ #rf-comfort-ov,#rf-comfort-card,#rf-comfort-pause{transition:none;}
    /* the class arrives a frame after the system query does, and a player who
       set motion to off has overruled the OS on purpose — leave them alone */
    body:not(.rfc-motion-keep) .cta,
    body:not(.rfc-motion-keep) #spinBtn:not(:disabled){animation:none!important;} }
  `, 'rf-comfort-css');

  /* live sheet — rewritten whenever scale/opacity/text settings change */
  const zoomOK = !!(window.CSS && CSS.supports && CSS.supports('zoom', '1.25'));
  const HUD_L = '#hud-bucket,#hud-ores,#minimap,#hud-auto';
  /* #hud-purse is the positioned card now; the three ids inside it are plain
     rows, so scaling them individually would stretch the contents and leave
     the card where it was. */
  const HUD_R = '#hud-purse,#derby';
  const HUD_C = '#area';
  const HUD_B = '#hotbar,#hint,#toasts';
  const HUD_ALL = HUD_L + ',' + HUD_R + ',' + HUD_C + ',' + HUD_B;

  function applyLook() {
    const hs = +S.hudScale || 1, us = +S.uiScale || 1, op = clamp(+S.hudOpacity || 1, 0.25, 1);
    let css = '';
    if (hs !== 1) {
      /* zoom scales a fixed element AND its inset, so every corner stays put;
         where it is missing we fall back to a transform anchored per corner */
      if (zoomOK) css += `${HUD_ALL}{zoom:${hs};}`;
      else css += `${HUD_L}{transform:scale(${hs});transform-origin:0 0;}`
        + `${HUD_R}{transform:scale(${hs});transform-origin:100% 0;}`
        + `${HUD_C}{transform:translateX(-50%) scale(${hs});transform-origin:50% 0;}`
        + `${HUD_B}{transform:translateX(-50%) scale(${hs});transform-origin:50% 100%;}`;
    }
    if (op !== 1) css += `${HUD_ALL},#mute{opacity:${op};}`;
    if (us !== 1 && zoomOK) css += `.card,.reveal-card,#rf-comfort-ov .rfc-card,#rf-comfort-card .rfc-card{zoom:${us};}`;
    if (S.bigText) css += `.sub,.seclab,.lab,.cmsg,#hud-bait,.fishrow .rr,.statrow,.lbrow .who,.toast,#hint,
      .invcard .inm,.rfc-lab span,.rfc-note,.rfc-key span,.wthumb span,#worldCap{font-size:12.5px!important;letter-spacing:.05em!important;}`;
    RF.css(css, 'rf-comfort-live');
    D.documentElement.style.setProperty('--rf-ui-scale', String(us));
    BODY.classList.toggle('rf-comfort-big', !!S.bigText);
  }

  /* ------------------------------------------------------------- rendering */
  let repaintWanted = false, lastRatio = 0;

  /* game.js publishes its device-pixel-ratio ceiling as RF.maxDPR — a live
     accessor it clamps to 1..4 — so the ladder can raise it for a 4K panel and
     put it back afterwards. Read and write it at call time; on a build that
     does not have it yet, fall back to the 2 that used to be hard-coded here. */
  let dprWarned = false;
  function dprCap() {
    let cap = 2;
    try {
      if ('maxDPR' in RF) {
        RF.maxDPR = (QUAL[S.quality] && QUAL[S.quality].dpr) || 2;
        const c = +RF.maxDPR; if (isFinite(c) && c >= 1) cap = c;
      }
    } catch (e) { /* this runs once a second with the readout open — say it once */
      if (!dprWarned) { dprWarned = true; RF.err('comfort:dpr', e, 'warn'); } }
    return clamp(cap, 1, 4);
  }
  const maxTexSize = () => {
    try { const r = RF.renderer; return (r.capabilities && r.capabilities.maxTextureSize) || 4096; }
    catch (e) { return 4096; }
  };
  function viewCSS() {
    const c = RF.renderer && RF.renderer.domElement;
    return { w: (c && c.clientWidth) || window.innerWidth || 1, h: (c && c.clientHeight) || window.innerHeight || 1 };
  }
  /* what setPixelRatio should actually be handed: what the tier asked for, then
     whatever PIXBUDGET leaves of it. Reports the frame that will really be drawn
     — three floors the buffer the same way, so these are the true dimensions. */
  function frameTarget() {
    const v = viewCSS();
    const want = Math.min(window.devicePixelRatio || 1, dprCap()) * (+S.rscale || 1);
    const fit = Math.sqrt(PIXBUDGET / Math.max(1, v.w * v.h));
    const r = clamp(Math.min(want, fit), 0.35, 4);
    return { r: r, w: Math.floor(v.w * r), h: Math.floor(v.h * r), capped: fit < want - 0.005 };
  }
  const resText = () => { const t = frameTarget(); return t.w + ' x ' + t.h + (t.capped ? ' · held at the budget' : ''); };
  function paintRes() { const el = $('rf-comfort-res'); if (el) el.textContent = resText(); }
  function repaint() {
    /* a paused world never draws again on its own, so any change that resizes
       the drawing buffer has to put a picture back on it by hand */
    try {
      const r = RF.renderer; if (!r) return;
      r.autoClear = false; r.clear();
      if (RF.skyScene && RF.skyCam) r.render(RF.skyScene, RF.skyCam);
      r.clearDepth(); r.render(RF.scene, RF.camera);
    } catch (e) { RF.err('comfort:repaint', e, 'warn'); }
  }
  function applyRender() {
    try {
      const r = RF.renderer; if (!r) return;
      const t = frameTarget();
      r.setPixelRatio(t.r); lastRatio = t.r;
      const on = !!S.shadows;
      if (RF.sun) {
        RF.sun.castShadow = on;
        /* an older iGPU tops out at 2048: asking it for a 4096 map loses the
           whole shadow pass rather than quietly giving you a smaller one */
        const want = Math.min(S.shadowRes | 0, maxTexSize());
        if (on && RF.sun.shadow && RF.sun.shadow.mapSize.x !== want) {
          RF.sun.shadow.mapSize.set(want, want);
          if (RF.sun.shadow.map) { RF.sun.shadow.map.dispose(); RF.sun.shadow.map = null; }
        }
      }
      /* leave shadowMap.enabled alone: flipping it without recompiling every
         material paints black shadows. Killing the light's cast flag changes
         the lights hash instead, which three does recompile for. */
      /* autoUpdate stays off at every tier: core refreshes the map on its own
         cadence and re-arming it here would hand straight back the draw calls
         that throttle exists to save. One needsUpdate pays for this change. */
      r.shadowMap.autoUpdate = false;
      if (on) r.shadowMap.needsUpdate = true;
    } catch (e) { RF.err('comfort:render', e, 'warn'); }
    /* '4k' is a sixth value on a signal that documents five. Every consumer in
       mods/ reads it as a lookup with a default, and the default is the full
       budget — an unknown tag costs nobody anything. */
    BODY.dataset.rfQuality = (QUAL[S.quality] || { tag: !S.shadows ? 'low' : S.rscale >= 1.65 ? '4k' : S.rscale >= 1.15 ? 'ultra' : S.rscale >= 1 ? 'high' : 'med' }).tag;
    paintRes();
    if (paused) repaint(); else repaintWanted = true;
  }
  function setQuality(q, why) {
    const p = QUAL[q]; if (!p) return;
    S.quality = q; S.rscale = p.rscale; S.shadows = p.shadows; S.shadowRes = p.shadowRes;
    applyRender(); persist();
    if (why) say({ level: 'warn', tag: 'rf-comfort-q', ttl: 7000, title: 'Quality → ' + p.lab, body: why });
  }
  const qualityOfCustom = () => S.shadows
    ? (S.rscale >= 1.65 ? '4k' : S.rscale >= 1.15 ? 'ultra' : S.rscale >= 0.95 ? 'high' : 'med')
    : (S.rscale >= 0.65 ? 'low' : 'low');

  /* the budget is a function of the window, so a resize changes the ratio this
     tier is entitled to; core's own handler only ever calls setSize */
  let resizeT = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (Math.abs(frameTarget().r - lastRatio) > 0.01) applyRender(); else paintRes();
    }, 180);
  });

  /* ---------------------------------------------------------------- audio */
  let audioDone = false;
  function applyAudio() {
    if (!RF.audio || !RF.audio.ready) { audioDone = false; return; }
    try {
      RF.audio.master = clamp(+S.volMaster, 0, 1.5);
      RF.audio.music = clamp(+S.volMusic, 0, 1.5);
      RF.audio.sfx = clamp(+S.volSfx, 0, 1.5);
      audioDone = true;
    } catch (e) { RF.err('comfort:audio', e, 'warn'); }
  }

  /* ------------------------------------------------------------ palette/motion */
  function applyPalette() {
    const p = PAL[S.palette] || PAL.default, st = D.documentElement.style;
    for (let i = 0; i < RARK.length; i++) {
      st.setProperty('--c-' + RARK[i], p.c[i]);
      /* RAR is read live at every draw site — reveal cards, pixel fish, the
         inventory borders — so writing it here repaints the whole game */
      try { if (RF.RAR) RF.RAR[RARK[i]] = p.c[i]; } catch (e) { }
    }
  }
  const mqMotion = (window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
  const reduced = () => S.motion === 'on' || (S.motion === 'auto' && !!(mqMotion && mqMotion.matches));
  function applyMotion() {
    BODY.classList.toggle('rf-reduced', reduced());
    BODY.classList.toggle('rf-noflash', reduced() || +S.flash <= 0);
    BODY.classList.toggle('rfc-motion-keep', S.motion === 'off');
  }
  RF.modify('shake', v => reduced() ? 0 : v * clamp(+S.shake, 0, 2));
  RF.modify('freeze', v => reduced() ? 0 : v * clamp(+S.freeze, 0, 2));

  /* ------------------------------------------------------------------ zoom */
  let zoomWheel = null;
  const zoomCustom = () => S.zoomInv || +S.zoomMin !== 7 || +S.zoomMax !== 17 || Math.abs(+S.zoomStep - 1.1) > 0.001;
  function applyZoom() {
    if (zoomCustom() && !zoomWheel) {
      /* capture at window fires ahead of core's own bubble-phase listener, so
         stopping here is the only way to own the wheel without a core edit */
      zoomWheel = e => {
        if (RF.panelOpen || RF.capCam || uiOpen() || paused) return;
        e.stopPropagation();
        const dir = (S.zoomInv ? -1 : 1) * Math.sign(e.deltaY || 0);
        if (!dir) return;
        const next = clamp(RF.camSize + dir * (+S.zoomStep || 1.1), +S.zoomMin, +S.zoomMax);
        RF.camSize = next; S.camSize = next; queuePersist();
      };
      addEventListener('wheel', zoomWheel, { capture: true, passive: true });
    } else if (!zoomCustom() && zoomWheel) {
      removeEventListener('wheel', zoomWheel, { capture: true });
      zoomWheel = null;
    }
    if (RF.camSize < +S.zoomMin || RF.camSize > +S.zoomMax) RF.camSize = clamp(RF.camSize, +S.zoomMin, +S.zoomMax);
  }
  function queuePersist() { const t = Date.now(); if (t - saveT < 900) return; saveT = t; persist(); }

  function applyGlass() { BODY.classList.toggle('rfc-flat', !S.glass); }

  function applyAll() { applyRender(); applyLook(); applyGlass(); applyPalette(); applyMotion(); applyAudio(); applyZoom(); }

  /* ------------------------------------------------------------------- DOM */
  const gear = RF.el('<button id="rf-comfort-gear" type="button" title="Settings · O"><i class="rfc-cog"></i>OPTIONS</button>');
  const fpsPill = RF.el('<div id="rf-comfort-fps">60</div>');
  const perfBox = RF.el(`<div id="rf-comfort-perf">
    <h4>frame budget</h4><canvas id="rf-comfort-spark" width="212" height="34"></canvas>
    <div id="rf-comfort-perfrows"></div></div>`);
  const ov = RF.el(`<div id="rf-comfort-ov"><div class="rfc-card">
    <div class="card-head"><div><div class="sub" style="color:var(--teal)">comfort · make it fit you</div>
    <h2 class="font-d">SETTINGS</h2></div><button class="x" id="rf-comfort-x" type="button">CLOSE · ESC</button></div>
    <div class="rfc-tabs" id="rf-comfort-tabs"></div>
    <div id="rf-comfort-body"></div>
    <div class="rfc-foot"><span class="rfc-sp" id="rf-comfort-foot"></span>
      <button class="btn" type="button" data-t="btn" data-a="card">CONTROL CARD</button>
      <button class="btn rose" type="button" data-t="btn" data-a="reset">RESET ALL</button></div>
  </div></div>`);
  const cardOv = RF.el(`<div id="rf-comfort-card"><div class="rfc-card">
    <div class="card-head"><div><div class="sub" style="color:var(--gold)">pin this to the wheelhouse</div>
    <h2 class="font-d">CONTROLS</h2></div><button class="x" id="rf-comfort-cardx" type="button">CLOSE · ESC</button></div>
    <div id="rf-comfort-cardbody" style="overflow-y:auto;"></div></div></div>`);
  const pauseOv = RF.el(`<div id="rf-comfort-pause"><div class="rfc-pbox">
    <h3 class="font-d">PAUSED</h3><p id="rf-comfort-psub">the tide is holding its breath</p>
    <div class="rfc-pb"><button class="btn" type="button" data-a="resume">RESUME</button>
    <button class="btn" type="button" data-a="opts">SETTINGS</button>
    <button class="btn" type="button" data-a="card">CONTROLS</button></div></div></div>`);
  const fileIn = RF.el('<input id="rf-comfort-file" type="file" accept="application/json,.json" style="display:none">');

  const $ = id => D.getElementById(id);
  const bodyEl = $('rf-comfort-body'), tabsEl = $('rf-comfort-tabs'), footEl = $('rf-comfort-foot');
  const cardBody = $('rf-comfort-cardbody'), perfRows = $('rf-comfort-perfrows');
  const spark = $('rf-comfort-spark');
  let sctx = null; try { sctx = spark && spark.getContext ? spark.getContext('2d') : null; } catch (e) { sctx = null; }

  /* ------------------------------------------------------------ the panel */
  const TABS = [['display', 'DISPLAY'], ['audio', 'AUDIO'], ['controls', 'CONTROLS'],
  ['access', 'ACCESS'], ['world', 'WORLD'], ['save', 'SAVE']];
  let tab = 'display', capturing = null, capKeyFn = null;

  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;');
  const pct = v => Math.round(v * 100) + '%';
  const VTXT = {
    rscale: v => Math.round(v * 100) + '%', volMaster: pct, volMusic: pct, volSfx: pct, volAmb: pct,
    hudScale: pct, hudOpacity: pct, uiScale: pct, shake: pct, freeze: pct,
    zoomMin: v => (+v).toFixed(0) + 'm', zoomMax: v => (+v).toFixed(0) + 'm', zoomStep: v => (+v).toFixed(1)
  };
  const vtxt = k => (VTXT[k] || (v => String(v)))(S[k]);

  const row = (lab, hint, ctl, cls) => `<div class="rfc-row${cls ? ' ' + cls : ''}"><div class="rfc-lab"><b>${lab}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div><div class="rfc-ctl">${ctl}</div></div>`;
  const sw = k => `<button type="button" class="rfc-sw${S[k] ? ' on' : ''}" data-t="sw" data-k="${k}" role="switch" aria-checked="${!!S[k]}"><i></i></button>`;
  const rg = (k, mn, mx, st) => `<input class="rfc-rg" type="range" data-t="rg" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${S[k]}" aria-label="${k}"><span class="rfc-val" data-v="${k}">${vtxt(k)}</span>`;
  const seg = (k, opts) => `<div class="rfc-seg" data-t="seg" data-k="${k}">` + opts.map(o => `<button type="button" data-v="${o[0]}" class="${String(S[k]) === String(o[0]) ? 'on' : ''}">${o[1]}</button>`).join('') + '</div>';
  const bt = (a, lab, cls) => `<button class="btn${cls ? ' ' + cls : ''}" type="button" data-t="btn" data-a="${a}">${lab}</button>`;
  const sec = t => `<div class="rfc-sec">${t}</div>`;

  /* other mods hang their own toggles here; rebuilt on every open so a mod
     that registers late still shows up without anyone emitting an event */
  const extra = [];

  function paneDisplay() {
    const q = QUAL[S.quality] ? S.quality : 'custom';
    const t = frameTarget(), mt = maxTexSize();
    return sec('quality')
      + row('Preset', 'each step trades a little of the island for a lot of frames',
        seg('quality', QORDER.map(k => [k, QUAL[k].lab])) + (q === 'custom' ? '<span class="rfc-val">custom</span>' : ''))
      + (q === '4k' ? `<div class="rfc-note rfc-4k">4K is the top of the ladder and it is not free · it draws the island at
        <b>${t.w} x ${t.h}</b> and lets the screen throw most of that away again. Worth it on a desktop card and a dense panel,
        painful on anything else · the watchdog will never pick this tier for you, and if the frames collapse it drops you to ultra
        and leaves you there.</div>` : '')
      /* the one row that has to stay live while the slider moves, so it is
         built by hand: the label carries the buffer we will actually allocate */
      + `<div class="rfc-row"><div class="rfc-lab"><b>Render scale</b><span>draws the world smaller and stretches it up · the cheapest win there is</span>
        <div class="rfc-res" id="rf-comfort-res">${esc(resText())}</div></div><div class="rfc-ctl">${rg('rscale', 0.4, 2, 0.05)}</div></div>`
      + row('Sun shadows', 'the most expensive light in the game by a wide margin', sw('shadows'))
      + row('Shadow detail', 'only matters while shadows are on' + (mt < 4096 ? ' · this card tops out at ' + mt + 'px' : ''),
        seg('shadowRes', [[512, 'soft'], [1024, 'fair'], [2048, 'sharp'], [4096, 'crisp']]))
      + row('Glass blur', 'every panel frosts the world behind it · the most expensive thing in the interface'
        + (BODY.dataset.rfQuality === 'low' ? ' · already off at this tier' : ''), sw('glass'))
      + row('Adapt automatically', 'drops a tier if the frame budget is blown for three seconds, climbs back when it is not', sw('autoQ'))
      + sec('readout')
      + row('Performance overlay', 'F3 cycles it: off · a bare number · the whole panel', seg('perf', [[0, 'off'], [1, 'fps'], [2, 'full']]))
      + sec('interface')
      + row('HUD size', 'the bucket, the coins, the hotbar — everything at the edges', rg('hudScale', 0.8, 1.6, 0.05))
      + row('HUD opacity', 'turn the glass down when you want the island, not the numbers', rg('hudOpacity', 0.3, 1, 0.05))
      + row('Interface size', 'panels, cards and menus' + (zoomOK ? '' : ' · this browser will not scale them'), rg('uiScale', 0.85, 1.4, 0.05))
      + row('Larger text', 'puts a floor under the smallest labels in the game', sw('bigText'));
  }

  function paneAudio() {
    const ready = !!(RF.audio && RF.audio.ready);
    return sec('mixer')
      + (ready ? '' : `<div class="rfc-note">The sound engine only starts on your first click, so these take hold the moment you press <b>Set sail</b>.</div>`)
      + row('Master', 'everything, all at once', rg('volMaster', 0, 1.2, 0.05))
      + row('Music', 'the bed under the island', rg('volMusic', 0, 1.2, 0.05))
      + row('Effects', 'casts, strikes, coins, the wheel', rg('volSfx', 0, 1.2, 0.05))
      + row('Ambience', 'surf, wind, weather · read by the soundscape when it is loaded', rg('volAmb', 0, 1.2, 0.05))
      + row('Mute', 'the same switch as the chip in the corner, but this one is remembered', sw('mute'))
      + sec('pause')
      + row('Pause when the window loses focus',
        multiplayer() ? 'offline only — at sea the isle carries on without you'
                      : 'walk away mid-cast and nothing eats your bait', sw('pauseBlur'))
      + row('Silence while paused', 'suspends the audio clock outright', sw('pauseAudio'));
  }

  function paneControls() {
    const used = {}; let dup = false, none = false;
    for (const a in DEFB) { const c = S.binds[a]; if (!c) { none = true; continue; } if (used[c]) dup = true; used[c] = a; }
    let h = sec('walking, working, looking');
    h += `<div class="rfc-note">Click a key to change it. <b>Esc</b> cancels, <b>Backspace</b> unbinds. The second column never changes, so you can always get home.</div>`;
    for (const a of ABASE) {
      const c = S.binds[a[0]], bad = !c || (used[c] !== a[0]);
      h += row(a[1], '', `<button class="rfc-kb${!c ? ' none' : ''}" data-t="kb" data-a="${a[0]}">${esc(keyLab(c))}</button><span class="rfc-also">${a[2]}</span>`, bad ? 'rfc-warn' : '');
    }
    if (dup) h += `<div class="rfc-note" style="color:var(--rose)">Two actions want the same key. The one you set last wins.</div>`;
    if (none) h += `<div class="rfc-note" style="color:var(--rose)">Something is unbound. Its second key still works.</div>`;
    h += sec('panels') + `<div class="rfc-keys">${cardKeysHTML(true)}</div>`;
    h += row('Restore every key', 'back to W A S D and the rest', bt('binds', 'DEFAULTS'));
    return h;
  }

  function paneAccess() {
    let h = sec('colour');
    for (const k in PAL) {
      const p = PAL[k];
      h += row(p.lab, k === S.palette ? 'in use — common through legendary' : '',
        `<span class="rfc-pal">${p.c.map(c => `<i style="background:${c}"></i>`).join('')}</span>` + seg('palette', [[k, k === S.palette ? 'ON' : 'USE']]));
    }
    h += `<div class="rfc-note">The palette is not paint on top: it rewrites the rarity table the whole game reads, so reveal cards, pixel fish and inventory borders all follow it.</div>`;
    h += sec('motion')
      + row('Reduce motion', 'auto follows your system setting · publishes rf-reduced for every other mod',
        seg('motion', [['auto', 'auto'], ['on', 'on'], ['off', 'off']]))
      + row('Screen shake', 'a strike, a meteor, a jackpot', rg('shake', 0, 1.5, 0.05))
      + row('Hit-stop', 'the beat the world holds still on impact', rg('freeze', 0, 1.5, 0.05))
      + row('Screen flashes', 'the gold bloom at the edges when the house pays', seg('flash', [[1, 'on'], [0, 'off']]));
    if (reduced()) h += `<div class="rfc-note">Reduced motion is <b>on</b> — shake and hit-stop are held at zero whatever the sliders say.</div>`;
    if (extra.length) {
      h += sec('from other mods');
      for (const g of extra) h += extraHTML(g);
    }
    return h;
  }

  function paneWorld() {
    return sec('camera')
      + row('Closest zoom', 'how far in the wheel will take you', rg('zoomMin', 4, 12, 0.5))
      + row('Furthest zoom', 'how far out', rg('zoomMax', 10, 30, 0.5))
      + row('Zoom step', 'per notch of the wheel', rg('zoomStep', 0.4, 3, 0.1))
      + row('Invert the wheel', 'push away to pull in', sw('zoomInv'))
      + row('Remember my zoom', 'boots at the distance you left it', sw('zoomKeep'))
      + row('Reset the camera', 'back to the shipped framing', bt('cam', 'RESET'))
      + sec('pause')
      + row('Pause the world',
        multiplayer()
          ? 'offline only — signed in, the isle keeps its own time whatever this tab does'
          : 'holds the render loop itself — nothing ages while you are away',
        bt('pause', 'PAUSE · `'));
  }

  function paneSave() {
    const st = storageStats(), bk = backups();
    let h = sec('this browser holds your island');
    h += row('Save size', st.save > 0 ? Math.round(st.save / 102.4) / 10 + ' KB of state' : 'nothing written yet',
      `<span class="rfc-val">${st.save ? Math.round(st.save / 1024) + 'K' : '—'}</span>`);
    h += row('Storage used', 'browsers cut you off somewhere near 5 MB',
      `<span class="rfc-val" style="color:${st.total > 4e6 ? 'var(--rose)' : st.total > 3e6 ? 'var(--gold)' : 'var(--teal)'}">${Math.round(st.total / 1024)}K</span>`);
    h += row('Where the coins live', RF.online ? 'signed in — the server holds the economy, this file is only your look'
      : 'offline — everything you own is in this browser and nowhere else',
      `<span class="rfc-val" style="color:${RF.online ? 'var(--teal)' : 'var(--gold)'}">${RF.online ? 'SERVER' : 'LOCAL'}</span>`);
    h += sec('backups');
    h += row('Keep rolling backups', 'three snapshots, taken every two minutes and before you sail', sw('backups'));
    if (bk.length) for (let i = bk.length - 1; i >= 0; i--) {
      const b = bk[i];
      h += row(ago(b.t) + ' ago', Math.round(b.n / 1024) + ' KB · ' + (b.w || 'routine'),
        RF.online ? '<span class="rfc-val">held</span>' : bt('restore:' + i, 'RESTORE'));
    } else h += `<div class="rfc-note">No snapshot yet. The first one lands two minutes after you sail.</div>`;
    h += sec('take it with you');
    h += row('Export to a file', 'a plain .json you can keep, mail yourself, or move to another machine', bt('export', 'EXPORT'));
    h += row('Import a file', RF.online ? 'not while you are signed in — the server would overwrite it anyway'
      : 'replaces everything in this browser, then reloads', bt('import', 'IMPORT') + '');
    h += sec('loaded');
    h += `<div class="rfc-mods">${RF.order.map(n => { const m = RF.mods[n]; return `<span class="${m.ok ? 'ok' : 'bad'}">${esc(n)}${m.ok ? '' : ' ✕'}</span>`; }).join('')}</div>`;
    return h;
  }

  function extraHTML(g) {
    let h = `<div class="rfc-sec">${esc(g.title || g.mod)}</div>`;
    for (let i = 0; i < g.rows.length; i++) {
      const r = g.rows[i], id = 'x:' + g.i + ':' + i;
      let ctl = '';
      try {
        if (r.type === 'sw') ctl = `<button type="button" class="rfc-sw${r.get() ? ' on' : ''}" data-t="xsw" data-k="${id}"><i></i></button>`;
        else if (r.type === 'rg') ctl = `<input class="rfc-rg" type="range" data-t="xrg" data-k="${id}" min="${r.min}" max="${r.max}" step="${r.step || 0.05}" value="${r.get()}">`;
        else if (r.type === 'seg') ctl = `<div class="rfc-seg" data-t="xseg" data-k="${id}">` + r.opts.map(o => `<button type="button" data-v="${esc(o[0])}" class="${String(r.get()) === String(o[0]) ? 'on' : ''}">${esc(o[1])}</button>`).join('') + '</div>';
        else ctl = `<button class="btn" type="button" data-t="xbtn" data-k="${id}">${esc(r.label2 || 'RUN')}</button>`;
      } catch (e) { ctl = '<span class="rfc-val">—</span>'; }
      h += row(esc(r.label), r.hint || '', ctl);
    }
    return h;
  }

  function buildPane() {
    if (!bodyEl) return;
    let h = '';
    try {
      h = tab === 'display' ? paneDisplay() : tab === 'audio' ? paneAudio() : tab === 'controls' ? paneControls()
        : tab === 'access' ? paneAccess() : tab === 'world' ? paneWorld() : paneSave();
    } catch (e) { RF.err('comfort:pane', e); h = '<div class="rfc-note">That tab could not be drawn. The rest still works.</div>'; }
    bodyEl.innerHTML = h;
    if (tabsEl) tabsEl.innerHTML = TABS.map(t => `<button type="button" data-tab="${t[0]}" class="${tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('');
    if (footEl) footEl.textContent = 'O closes · F3 perf · ` pause';
  }

  function refreshExtras() {
    extra.length = 0;
    for (let i = 0; i < reg.length; i++) { const g = reg[i]; extra.push({ i: i, title: g.title, mod: g.mod, rows: g.rows }); }
  }

  /* --------------------------------------------------------- panel events */
  function onSet(k, v) {
    /* whatever the player picks by hand becomes the tier auto is allowed to
       climb back to — without this, opting into 4k and being stepped down once
       left the ceiling wherever the last boot happened to find it */
    if (k === 'quality') { userTier = v; autoTier = null; slowFor = fastFor = 0; setQuality(v); buildPane(); return; }
    if (k === 'palette') { S.palette = v; applyPalette(); persist(); buildPane(); return; }
    S[k] = v;
    if (k === 'rscale' || k === 'shadows' || k === 'shadowRes') { S.quality = qualityOfCustom(); userTier = S.quality; autoTier = null; applyRender(); }
    else if (k === 'hudScale' || k === 'hudOpacity' || k === 'uiScale' || k === 'bigText') applyLook();
    else if (k === 'glass') applyGlass();
    else if (k === 'motion' || k === 'flash') applyMotion();
    else if (k === 'mute') { try { RF.fn.setMuted(!!v); } catch (e) { } }
    else if (k.indexOf('vol') === 0) applyAudio();
    else if (k === 'perf') applyPerfMode();
    else if (k.indexOf('zoom') === 0) applyZoom();
    persist();
  }

  if (bodyEl) {
    bodyEl.addEventListener('click', e => {
      const t = e.target.closest ? e.target.closest('[data-t]') : null; if (!t) return;
      const kind = t.getAttribute('data-t'), k = t.getAttribute('data-k');
      if (kind === 'sw') { onSet(k, !S[k]); buildPane(); }
      else if (kind === 'seg') { const b = e.target.closest('button'); if (!b) return; let v = b.getAttribute('data-v'); if (v !== null && !isNaN(+v) && v !== '') v = +v; onSet(k, v); buildPane(); }
      else if (kind === 'btn') doAction(t.getAttribute('data-a'));
      else if (kind === 'kb') beginCapture(t.getAttribute('data-a'), t);
      else if (kind === 'xsw' || kind === 'xseg' || kind === 'xbtn') extraSet(kind, k, e);
    });
    bodyEl.addEventListener('input', e => {
      const t = e.target; if (!t || !t.getAttribute) return;
      const kind = t.getAttribute('data-t'), k = t.getAttribute('data-k');
      if (kind === 'rg') { onSet(k, +t.value); const o = bodyEl.querySelector('[data-v="' + k + '"]'); if (o) o.textContent = vtxt(k); }
      else if (kind === 'xrg') extraSet(kind, k, e);
    });
    /* rebuild only when the drag ends — mid-drag rebuilds steal the thumb */
    bodyEl.addEventListener('change', e => {
      const t = e.target; if (t && t.getAttribute && t.getAttribute('data-t') === 'rg' && (t.getAttribute('data-k') === 'rscale' || t.getAttribute('data-k') === 'shadows')) buildPane();
    });
  }
  if (tabsEl) tabsEl.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (b) { tab = b.getAttribute('data-tab'); endCapture(); buildPane(); }
  });
  const foot = ov ? ov.querySelector('.rfc-foot') : null;
  if (foot) foot.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) doAction(b.getAttribute('data-a')); });
  const xBtn = $('rf-comfort-x'); if (xBtn) xBtn.onclick = () => closePanel();
  const cardX = $('rf-comfort-cardx'); if (cardX) cardX.onclick = () => closeCard();
  if (ov) ov.addEventListener('mousedown', e => { if (e.target === ov) closePanel(); });
  if (cardOv) cardOv.addEventListener('mousedown', e => { if (e.target === cardOv) closeCard(); });
  if (gear) gear.onclick = () => { if (uiOpen()) closeAll(); else openPanel(); };
  if (pauseOv) pauseOv.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-a]') : null; if (!b) return;
    const a = b.getAttribute('data-a');
    if (a === 'resume') resume(); else if (a === 'opts') openPanel(); else if (a === 'card') openCard();
  });

  function extraSet(kind, id, e) {
    try {
      const p = id.split(':'), g = reg[+p[1]], r = g && g.rows[+p[2]]; if (!r) return;
      if (kind === 'xsw') { r.set(!r.get()); buildPane(); }
      else if (kind === 'xrg') r.set(+e.target.value);
      else if (kind === 'xseg') { const b = e.target.closest('button'); if (b) { r.set(b.getAttribute('data-v')); buildPane(); } }
      else if (kind === 'xbtn') { r.set(true); }
    } catch (err) { RF.err('comfort:extra', err, 'warn'); }
  }

  function doAction(a) {
    if (!a) return;
    if (a === 'card') { openCard(); return; }
    if (a === 'reset') {
      ask({ title: 'Reset every setting?', body: 'Quality, keys, palette, volumes — all of it back to the way it shipped. Your save is not touched.', ok: 'Reset', danger: true })
        .then(ok => { if (!ok) return; for (const k in DEF) S[k] = DEF[k]; S.binds = Object.assign({}, DEFB); persist(); applyAll(); applyPerfMode(); buildPane(); F.toast('Settings reset'); });
      return;
    }
    if (a === 'binds') { S.binds = Object.assign({}, DEFB); persist(); buildPane(); F.toast('Keys restored'); return; }
    if (a === 'cam') { S.zoomMin = DEF.zoomMin; S.zoomMax = DEF.zoomMax; S.zoomStep = DEF.zoomStep; S.zoomInv = false; RF.camSize = DEF.camSize; S.camSize = DEF.camSize; persist(); applyZoom(); buildPane(); return; }
    if (a === 'pause') { closePanel(); pause(); return; }
    if (a === 'export') { exportSave(); return; }
    if (a === 'import') { if (RF.online) { say({ level: 'warn', title: 'Signed in', body: 'the server holds your economy · sign out first' }); return; } if (fileIn) fileIn.click(); return; }
    if (a.indexOf('restore:') === 0) { restore(+a.slice(8)); return; }
  }

  /* --------------------------------------------------------- key capture */
  function beginCapture(action, btn) {
    endCapture();
    capturing = action; btn.classList.add('cap'); btn.textContent = 'press a key';
    capKeyFn = ev => {
      ev.preventDefault(); ev.stopImmediatePropagation();
      const code = ev.code; endCapture();
      if (code === 'Escape') { buildPane(); return; }
      if (code === 'Backspace' || code === 'Delete') { S.binds[action] = null; }
      else if (MINE[code]) { F.toast('That key opens this panel', 'bad'); buildPane(); return; }
      else if (code.indexOf('Arrow') === 0 || code === 'Space' || code === 'Tab' || code === 'Enter') { F.toast('That one is a permanent second key', 'bad'); buildPane(); return; }
      else {
        for (const a in DEFB) if (a !== action && S.binds[a] === code) S.binds[a] = null;
        S.binds[action] = code;
      }
      persist(); buildPane();
    };
    addEventListener('keydown', capKeyFn, true);
  }
  function endCapture() {
    if (capKeyFn) { removeEventListener('keydown', capKeyFn, true); capKeyFn = null; }
    capturing = null;
  }

  /* ----------------------------------------------------- open/close plumbing */
  const uiOpen = () => !!(ov && ov.classList.contains('on')) || !!(cardOv && cardOv.classList.contains('on'));
  /* Three full-screen surfaces live in this mod and every one of them has to
     announce itself: downstream mods count opens against closes, so one open
     that never closes — the card, or a second open on a surface already up —
     latches their world input off for the rest of the session. Nothing here
     adds or removes .on by hand: these two are the only doors, the class is
     the state, and the signal is emitted only on a real transition, after the
     DOM already says so, so a handler that closes us back is a no-op. */
  const PANEL = 'rf-comfort', CARD = 'rf-comfort-card', PAUSE = 'rf-comfort-pause';
  function show(el, name) {
    if (!el || el.classList.contains('on')) return false;
    el.classList.add('on'); RF.emit('panel', name, true); return true;
  }
  function hide(el, name) {
    if (!el || !el.classList.contains('on')) return false;
    el.classList.remove('on'); RF.emit('panel', name, false); return true;
  }
  function openPanel(t) {
    if (t) tab = t;
    refreshExtras(); buildPane();
    hide(cardOv, CARD);
    show(ov, PANEL);
    stopWalking();
    try { if (RF.audio && RF.audio.resume) RF.audio.resume(); } catch (e) { }
  }
  function closePanel() { endCapture(); hide(ov, PANEL); }
  function openCard() { buildCard(); hide(ov, PANEL); show(cardOv, CARD); stopWalking(); }
  function closeCard() { hide(cardOv, CARD); }
  function closeAll() { closePanel(); closeCard(); }
  function stopWalking() { try { const k = RF.keys; for (const n in k) k[n] = false; } catch (e) { } }

  /* --------------------------------------------------------- control card */
  const MODKEYS = [
    ['00-notify', 'N', 'notifications'], ['01-angler', 'B', 'bait & tackle'],
    ['03-panels', 'H', 'help & inspect'], ['04-world', 'M', 'the atlas'],
    ['05-progress', 'Q', 'quests & renown'], ['06-content', 'J', 'the journal'],
    ['08-fortune', 'G', 'odds & markets'], ['09-social', 'Y', 'who else is out here'],
    ['14-npc', 'R', 'talk to someone']
  ];
  function cardKeysHTML(short) {
    let h = '';
    const mine = [['O', 'these settings'], ['⇧O', 'this control card'], ['F3', 'performance'], ['`', 'pause']];
    for (const m of mine) h += `<div class="rfc-key"><kbd>${m[0]}</kbd><span>${m[1]}</span></div>`;
    for (const m of MODKEYS) { const r = RF.mods[m[0]]; if (r && r.ok) h += `<div class="rfc-key"><kbd>${m[1]}</kbd><span>${m[2]}</span></div>`; }
    for (const k in declared) h += `<div class="rfc-key"><kbd>${esc(keyLab(k))}</kbd><span>${esc(declared[k])}</span></div>`;
    if (short) return h;
    return h;
  }
  function buildCard() {
    if (!cardBody) return;
    let h = `<div class="rfc-note">You cast, you dig, you sell, you gamble it away. In that order, usually.</div>`;
    h += sec('the island') + '<div class="rfc-keys">';
    for (const a of ABASE) h += `<div class="rfc-key"><kbd>${esc(keyLab(S.binds[a[0]]))}</kbd><span>${a[1]}${a[2] !== '—' ? ' · ' + a[2] : ''}</span></div>`;
    h += `<div class="rfc-key"><kbd>1-5</kbd><span>Pick a tool</span></div>`;
    h += `<div class="rfc-key"><kbd>Esc</kbd><span>Back out of anything</span></div>`;
    h += `<div class="rfc-key"><kbd>wheel</kbd><span>Zoom</span></div></div>`;
    h += sec('panels') + '<div class="rfc-keys">' + cardKeysHTML() + '</div>';
    h += sec('first hour') + `<div class="rfc-note">
      1 · Walk to the water and press <b>${esc(keyLab(S.binds.act))}</b> to cast. Press it again the instant the line jerks.<br>
      2 · Fill the bucket, then find the fishmonger's stall and sell the lot.<br>
      3 · Swing the pickaxe at the glittering rock for ore, then upgrade the rod — a better rod finds better fish, and nothing else does.<br>
      4 · The wheel in the casino is a fine way to lose an afternoon's fishing. It is also the fastest way to a boat.</div>`;
    cardBody.innerHTML = h;
  }

  /* ------------------------------------------------------------- the pause */
  let paused = false, heldCb = null, rafPatched = false, origRAF = null, hardPause = true, pauseClock = 0, rafSeen = 0;
  function patchRAF() {
    if (rafPatched) return;
    rafPatched = true;
    origRAF = window.requestAnimationFrame.bind(window);
    /* the only handle a mod has on core's loop is the re-arm it asks for at the
       end of every frame; hold that one callback and the world truly stops.
       Everything else — our own UI, other mods — is forwarded untouched. */
    window.requestAnimationFrame = function (cb) {
      if (paused && cb && cb.name === 'animate') { heldCb = cb; return -1; }
      if (paused) rafSeen++;
      return origRAF(cb);
    };
  }
  /* Pausing is a SINGLE-PLAYER comfort. Signed in, the server keeps its own
     time no matter what this tab does: other anglers walk about, the market
     turns its epoch, dividends accrue, the sun crosses the sky. Holding the
     render loop would stop the picture and nothing else, while the overlay
     promised "nothing ages while you are away" — a promise this client is in
     no position to keep. So online, there is no pause at all. */
  /* RF.online is what the rest of this file already asks (see the import and
     restore guards below), so this asks it too rather than inventing a second
     way to spell "signed in". */
  const multiplayer = () => !!RF.online;

  function pause() {
    if (paused || !RF.running || RF.panelOpen) return;
    if (multiplayer()) {
      say({ level: 'warn', tag: 'rf-comfort-nopause', ttl: 5000,
        title: 'No pausing at sea',
        body: 'You are signed in, and the isle keeps its own time — other anglers, '
          + 'the market and the tide all carry on. Sign out to play offline if you '
          + 'need the world to hold still.' });
      return;
    }
    paused = true; RF.paused = true;   // core reads this to stop the wheel zooming
    hardPause = true; rafSeen = 0; heldCb = null; pauseClock = RF.clock;
    patchRAF(); stopWalking();
    show(pauseOv, PAUSE);
    if (S.pauseAudio) { try { const c = RF.audio && RF.audio.ctx; if (c && c.state === 'running') c.suspend(); } catch (e) { } }
    /* one beat later, check the loop really did stop; if the callback we were
       watching for never came, say so rather than lie about a frozen world */
    setTimeout(() => {
      if (!paused) return;
      const sub = $('rf-comfort-psub'); if (!sub) return;
      hardPause = (RF.clock === pauseClock);
      sub.textContent = hardPause ? 'the tide is holding its breath' : 'the world keeps its own time · you are safe here';
    }, 320);
  }
  function resume() {
    if (!paused) return;
    paused = false; RF.paused = false;
    hide(pauseOv, PAUSE);
    if (S.pauseAudio) { try { const c = RF.audio && RF.audio.ctx; if (c && c.state === 'suspended') c.resume(); } catch (e) { } }
    if (heldCb) { const cb = heldCb; heldCb = null; try { origRAF(cb); } catch (e) { RF.err('comfort:resume', e); try { window.requestAnimationFrame(cb); } catch (_) { } } }
  }
  function togglePause() { if (paused) resume(); else pause(); }
  /* multiplayer() again rather than leaning on pause()'s own guard: alt-tabbing
     is not a request to be told off, so this one stays silent. */
  addEventListener('blur', () => {
    if (S.pauseBlur && RF.running && !paused && !RF.panelOpen && !uiOpen() && !multiplayer()) pause();
  });

  /* ------------------------------------------------------------ perf meter */
  const HIST = 120, hist = new Float32Array(HIST);
  let hi = 0, lastT = performance.now(), acc = 0, accN = 0, avgMs = 16.7, worstMs = 0;
  let slowFor = 0, fastFor = 0, autoTier = null, userTier = S.quality;
  const budget = 25;              // 40 fps — below this the island starts to swim

  RF.on('frame', () => {
    const t = performance.now(), ms = t - lastT; lastT = t;
    if (ms <= 0 || ms > 2000) return;      // a tab that slept is not a slow frame
    hist[hi = (hi + 1) % HIST] = ms;
    acc += ms; accN++;
    if (worstMs < ms) worstMs = ms;
    if (repaintWanted) repaintWanted = false;
  });

  RF.every(1, () => {
    if (accN > 0) { avgMs = acc / accN; acc = 0; accN = 0; }
    if (S.perf) drawPerf();
    if (!S.autoQ || !RF.running || paused) { slowFor = 0; fastFor = 0; return; }
    if (avgMs > budget) { slowFor++; fastFor = 0; } else if (avgMs < 14) { fastFor++; slowFor = 0; } else { slowFor = 0; fastFor = 0; }
    const cur = QORDER.indexOf(QUAL[S.quality] ? S.quality : qualityOfCustom());
    /* auto may walk off any rung, opt-in ones included, but it may only ever
       climb as far as AUTO_TOP: nobody is handed 4K by a watchdog */
    const ceilT = Math.min(QORDER.indexOf(userTier), AUTO_TOP);
    if (slowFor >= 3 && cur > 0) {
      slowFor = 0; autoTier = QORDER[cur - 1];
      setQuality(autoTier, QUAL[QORDER[cur]] && QUAL[QORDER[cur]].optIn
        ? 'this machine could not carry 4K · press O to ask for it again'
        : 'the frame budget was blown for three seconds · press O to set it back');
    } else if (fastFor >= 45 && autoTier && cur < ceilT) {
      fastFor = 0; autoTier = QORDER[cur + 1];
      setQuality(autoTier, 'there is headroom again');
      /* back at the ceiling — which is the player's own tier, or AUTO_TOP when
         the player's tier is the opt-in one — so the watchdog is done */
      if (QORDER.indexOf(autoTier) >= ceilT) autoTier = null;
    }
  });

  function pctl(p) {
    /* a p95 over two seconds of frames says far more about how a game feels
       than an average does — one 90 ms hitch a second is what you notice */
    const a = Array.prototype.slice.call(hist).filter(v => v > 0).sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[clamp(Math.floor(a.length * p), 0, a.length - 1)];
  }
  function drawPerf() {
    const fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
    const cls = fps >= 50 ? '' : fps >= 35 ? 'warn' : 'bad';
    if (fpsPill && S.perf === 1) { fpsPill.textContent = fps + ' FPS'; fpsPill.className = cls ? cls : ''; fpsPill.classList.add('on'); }
    if (S.perf !== 2) return;
    if (sctx) {
      const w = spark.width, h = spark.height;
      sctx.clearRect(0, 0, w, h);
      sctx.strokeStyle = 'rgba(255,255,255,.12)'; sctx.beginPath();
      const y60 = h - (16.7 / 50) * h; sctx.moveTo(0, y60); sctx.lineTo(w, y60); sctx.stroke();
      sctx.beginPath();
      for (let i = 0; i < HIST; i++) {
        const v = hist[(hi + 1 + i) % HIST] || 0, x = (i / (HIST - 1)) * w;
        const y = h - clamp(v / 50, 0, 1) * h;
        if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
      }
      sctx.strokeStyle = fps >= 50 ? '#39d7c4' : fps >= 35 ? '#ffcf5c' : '#ff5d7a';
      sctx.lineWidth = 1.5; sctx.stroke();
    }
    if (!perfRows) return;
    let inf = null, prog = 0;
    try { inf = RF.renderer && RF.renderer.info; prog = (inf && inf.programs) ? inf.programs.length : 0; } catch (e) { }
    const mem = (performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : '—';
    const tb = frameTarget();
    const rows = [
      ['fps', fps + ' · ' + Math.round(avgMs * 10) / 10 + ' ms', cls],
      ['p95 frame', Math.round(pctl(0.95) * 10) / 10 + ' ms', pctl(0.95) > 33 ? 'bad' : pctl(0.95) > 22 ? 'warn' : 'ok'],
      ['draw calls', inf ? inf.render.calls : '—', ''],
      ['triangles', inf ? F.fmt(inf.render.triangles) : '—', ''],
      ['geometries', inf ? inf.memory.geometries + ' · ' + inf.memory.textures + ' tex' : '—', ''],
      ['shaders', prog || '—', ''],
      ['heap', mem, ''],
      ['render scale', Math.round(S.rscale * 100) + '% · ' + (QUAL[S.quality] ? QUAL[S.quality].lab : 'custom'), 'ok'],
      ['buffer', tb.w + ' x ' + tb.h + (tb.capped ? ' · held' : ''), tb.capped ? 'warn' : ''],
      ['shadows', S.shadows ? Math.min(S.shadowRes | 0, maxTexSize()) + 'px' : 'off', S.shadows ? '' : 'warn']
    ];
    perfRows.innerHTML = rows.map(r => `<div class="rfc-pf"><span>${r[0]}</span><b class="${r[2]}">${r[1]}</b></div>`).join('');
  }
  function applyPerfMode() {
    if (fpsPill) fpsPill.classList.toggle('on', S.perf === 1);
    if (perfBox) perfBox.classList.toggle('on', S.perf === 2);
    if (S.perf) drawPerf();
  }
  function cyclePerf() { S.perf = (S.perf + 1) % 3; applyPerfMode(); persist(); if (uiOpen() && tab === 'display') buildPane(); }

  /* ----------------------------------------------------------- save safety */
  const BKEY = '10-comfort-bak';
  const backups = () => { const b = RF.store.get(BKEY, []); return Array.isArray(b) ? b : []; };
  function storageStats() {
    let total = 0, sv = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i), v = localStorage.getItem(k) || '';
        total += k.length + v.length;
        if (k === RF.SAVE) sv = v.length;
      }
    } catch (e) { }
    return { total: total, save: sv };
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h';
  }
  function snapshot(why) {
    if (!S.backups || RF.online) return;
    let raw = null; try { raw = localStorage.getItem(RF.SAVE); } catch (e) { return; }
    if (!raw || raw.length > 120000) return;                 // never let the safety net fill the drive
    const st = storageStats(); if (st.total > 3.5e6) return;
    const b = backups();
    if (b.length && b[b.length - 1].d === raw) return;       // nothing has changed since the last one
    b.push({ t: Date.now(), n: raw.length, w: why || 'routine', d: raw });
    while (b.length > 3) b.shift();
    RF.store.set(BKEY, b);
  }
  function exportSave() {
    try {
      let raw = null; try { raw = localStorage.getItem(RF.SAVE); } catch (e) { }
      const blob = new Blob([JSON.stringify({ game: 'reelfortune3d', v: 1, t: Date.now(), world: localStorage.getItem('reelfortune3d-world') || 'isle', save: raw }, null, 1)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = D.createElement('a');
      const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
      a.href = url; a.download = 'reel-fortune-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
      D.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 5000);
      F.toast('Save exported', 'good');
    } catch (e) { RF.err('comfort:export', e); }
  }
  function writeAndReload(raw, world) {
    try {
      localStorage.setItem(RF.SAVE, raw);
      if (world) localStorage.setItem('reelfortune3d-world', world);
    } catch (e) { RF.err('comfort:restore', e); return; }
    F.toast('Restored · reloading', 'good');
    setTimeout(() => location.reload(), 600);
  }
  function restore(i) {
    if (RF.online) { say({ level: 'warn', title: 'Signed in', body: 'the server holds this account · sign out to restore a local file' }); return; }
    const b = backups(), s = b[i]; if (!s) return;
    ask({ title: 'Roll back ' + ago(s.t) + '?', body: 'Everything since that snapshot is gone for good. The page reloads.', ok: 'Roll back', danger: true })
      .then(ok => { if (ok) writeAndReload(s.d, null); });
  }
  if (fileIn) fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let o = null;
      try { o = JSON.parse(String(rd.result)); } catch (e) { F.toast('That file is not a save', 'bad'); return; }
      if (!o || o.game !== 'reelfortune3d' || typeof o.save !== 'string') { F.toast('That file is not a save', 'bad'); return; }
      ask({ title: 'Replace this island?', body: 'Everything in this browser is overwritten by the file. A backup of what is here now is kept.', ok: 'Replace', danger: true })
        .then(ok => { if (!ok) return; snapshot('before import'); writeAndReload(o.save, o.world); });
    };
    rd.onerror = () => F.toast('That file could not be read', 'bad');
    try { rd.readAsText(f); } catch (e) { RF.err('comfort:import', e); }
    fileIn.value = '';
  });
  RF.on('save', ok => {
    if (ok) { say({ level: 'info', tag: 'rf-comfort-save', title: 'Saving works again', body: 'whatever was blocking the browser has passed' }); return; }
    say({ level: 'error', tag: 'rf-comfort-save', ttl: 0, title: 'This browser will not save', body: 'press O · Save and export a file before you close the tab' });
  });
  RF.on('travel', () => snapshot('before sailing'));
  RF.on('unlock', () => snapshot('before an unlock'));
  RF.every(120, () => { if (RF.running) snapshot('routine'); });

  /* ------------------------------------------------------------- rebinding */
  let synth = false;
  const held = Object.create(null);
  const boundTo = code => { for (const a in DEFB) if (S.binds[a] === code) return a; return null; };
  const isDefaultCode = code => { for (const a in DEFB) if (DEFB[a] === code) return true; return false; };
  const anyRebound = () => { for (const a in DEFB) if (S.binds[a] !== DEFB[a]) return true; return false; };
  function press(code, down) {
    synth = true;
    try { window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: code, key: keyLab(code), bubbles: true, cancelable: true })); }
    catch (e) { RF.err('comfort:rebind', e, 'warn'); }
    finally { synth = false; }
  }
  const typing = () => {
    const a = D.activeElement;
    return !!RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  };

  RF.on('keydown', e => {
    if (synth || capturing) return;
    /* paused first: whatever else is true, the player must be able to get out.
       The pause menu can raise the settings panel and the card over itself, and
       while one of those owns the screen it also owns Esc and O — resuming out
       from under a modal would leave it floating over a running world. */
    if (paused && !uiOpen()) {
      if (e.code === 'Escape' || e.code === 'Backquote' || e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); resume(); return true; }
      if (e.code === 'KeyO') { e.preventDefault(); openPanel(); return true; }
      return true;
    }
    const t = typing();
    if (uiOpen()) {
      if (e.code === 'Escape') { e.preventDefault(); closeAll(); return true; }
      if (t) return;
      if (e.code === 'KeyO') { e.preventDefault(); closeAll(); return true; }
      if (e.code === 'Tab') return;                 // focus navigation stays alive
      if (e.code === 'F3') { e.preventDefault(); cyclePerf(); return true; }
      return true;                                   // nothing reaches the island
    }
    if (t) return;
    if (e.code === 'KeyO') { e.preventDefault(); if (e.shiftKey) openCard(); else openPanel(); return true; }
    if (e.code === 'F3') { e.preventDefault(); cyclePerf(); return true; }
    if (e.code === 'Backquote') { e.preventDefault(); togglePause(); return true; }
    if (!anyRebound()) return;
    const a = boundTo(e.code);
    if (a) {
      if (S.binds[a] === DEFB[a]) return;            // still where it started
      e.preventDefault(); held[e.code] = DEFB[a]; press(DEFB[a], true); return true;
    }
    /* a default key nobody holds any more must stop working, or a rebind is
       only ever an addition and the conflict check means nothing */
    if (isDefaultCode(e.code)) { e.preventDefault(); return true; }
  }, -60);

  RF.on('keyup', e => {
    if (synth) return;
    const t = held[e.code];
    if (t) { delete held[e.code]; press(t, false); }
  });

  /* ------------------------------------------------------------ public API */
  const reg = [], declared = Object.create(null), volCbs = [];
  RF.api = RF.api || {};
  RF.api.settings = {
    /* a mod hands over rows and they appear under Access → from other mods;
       registering late is fine, the pane is rebuilt on every open */
    register(spec) {
      try {
        if (!spec || !Array.isArray(spec.rows)) return false;
        reg.push({ mod: String(spec.mod || 'mod'), title: String(spec.title || spec.mod || 'mod'), rows: spec.rows.slice(0, 24) });
        if (uiOpen()) { refreshExtras(); buildPane(); }
        return true;
      } catch (e) { RF.err('comfort:register', e, 'warn'); return false; }
    },
    /* declare a key so it appears on the control card */
    key(code, label) { try { declared[String(code)] = String(label).slice(0, 40); } catch (e) { } },
    get(k) { return S[k]; },
    set(k, v) { if (k in DEF) { onSet(k, v); if (uiOpen()) buildPane(); } },
    open(t) { openPanel(t); }, close() { closeAll(); },
    onVolume(fn) { if (typeof fn === 'function') { volCbs.push(fn); try { fn(volumes()); } catch (e) { } } }
  };
  const volumes = () => ({ master: +S.volMaster, music: +S.volMusic, sfx: +S.volSfx, ambience: +S.volAmb, muted: !!S.mute });
  RF.api.comfort = {
    quality: () => BODY.dataset.rfQuality || 'high',
    reduced: reduced,
    uiScale: () => +S.uiScale,
    volumes: volumes,
    paused: () => paused,
    pause: pause, resume: resume,
    fps: () => avgMs > 0 ? Math.round(1000 / avgMs) : 0
  };

  /* -------------------------------------------------------------- lifecycle */
  if (mqMotion && mqMotion.addEventListener) mqMotion.addEventListener('change', () => { applyMotion(); if (uiOpen()) buildPane(); });
  RF.on('muted', v => { if (S.mute !== !!v) { S.mute = !!v; persist(); if (uiOpen() && tab === 'audio') buildPane(); } });
  RF.on('start', () => {
    applyAudio();
    if (S.zoomKeep && +S.camSize > 0) RF.camSize = clamp(+S.camSize, +S.zoomMin, +S.zoomMax);
    if (!S.cardSeen) { S.cardSeen = true; persist(); setTimeout(() => { if (!uiOpen() && !paused) openCard(); }, 900); }
  });
  /* the mixer does not exist until the first gesture builds it, so keep
     offering the saved volumes until one of them actually lands */
  RF.every(1.5, () => {
    if (!audioDone) applyAudio();
    if (S.zoomKeep && Math.abs(+S.camSize - RF.camSize) > 0.05 && !uiOpen()) { S.camSize = RF.camSize; queuePersist(); }
    for (let i = 0; i < volCbs.length; i++) { try { volCbs[i](volumes()); } catch (e) { } }
  });

  applyAll();
  applyPerfMode();
  if (S.mute) { try { RF.fn.setMuted(true); } catch (e) { } }
  if (S.zoomKeep && +S.camSize > 0) { try { RF.camSize = clamp(+S.camSize, +S.zoomMin, +S.zoomMax); } catch (e) { } }
  buildPane();
});
