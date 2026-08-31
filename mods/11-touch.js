/* 11-touch — the isle in your hands: everything a phone or tablet needs and a
   desktop never sees. Nothing here exists until a real finger touches glass.
   1.  Honest detection — a coarse pointer AND a real touchstart; a physical key
       or a genuine mouse move stands the whole layer back down (hybrid laptops).
   2.  The thumb stick — a floating ring that jumps to your thumb, dead zone,
       eight-way, written straight into RF.keys, and released on EVERY exit path.
   3.  The action button — press-and-hold on RF.keys.act via a real KeyboardEvent
       so core's actEdge fires exactly once, with a ring that shows the live job.
   4.  The rail & tray — bag, auto-rig, captain cam up the right edge; photo,
       atlas, quests, journal, settings, chat and sound behind one "more".
   5.  Pinch & orbit — two fingers scale RF.camSize, one finger orbits in photo
       mode, and nothing anywhere scrolls the page.
   6.  The small-screen sheet — core's overlays go full-bleed with a sticky head,
       the hotbar scrolls, the HUD restacks, every edge respects the notch.
   7.  Gesture hygiene — no double-tap zoom, no rubber-band, no long-press
       callout on the world; every scroller, core or mod, still scrolls.
   8.  Haptics — a tick on a bite, a thump on a break, a cadence on a rare fish.
   9.  One landscape hint, once, dismissible, never again. */
RF.mod('11-touch', function (RF) {
  'use strict';

  const F = RF.fn, clamp = F.clamp, pix = F.pixSVG;
  const byId = id => document.getElementById(id);
  const body = document.body, root3 = document.documentElement;

  /* ── persisted preferences ─────────────────────────────────────────────
     mode: 'auto' follows detection, 'on' forces the layer up on any device,
     'off' stands it down (a restore handle survives so a touch-only player is
     never locked out of their own controls). */
  const DEF = { mode: 'auto', haptics: true, hintSeen: false, photoTip: false };
  let P = DEF;
  try { P = Object.assign({}, DEF, RF.store.get('11-touch', null) || {}); }
  catch (e) { RF.err('touch:prefs', e, 'warn'); }
  const savePrefs = () => { try { RF.store.set('11-touch', P); } catch (e) {} };

  const reduced = () => { try { return body.classList.contains('rf-reduced'); } catch (e) { return false; } };
  const say = o => { try { return (RF.api && RF.api.notify) ? RF.api.notify(o)
    : F.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : ''); } catch (e) {} };

  /* ══════════════════════════════════════════════════════════════════════
     1. STYLE — the control layer, then the small-screen sheet. Every size
     rides --rf-ui-scale through the JS-set --rf-touch-* vars, so 10-comfort's
     scale slider moves the thumb stick too.
     ══════════════════════════════════════════════════════════════════════ */
  RF.css(`
  .rf-touch-probe{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;
    padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
  #rf-touch{position:fixed;inset:0;z-index:28;pointer-events:none;display:none;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
  body.rf-touch #rf-touch{display:block;}
  body.photo #rf-touch,body.rf-touch-hush #rf-touch{display:none!important;}
  /* the stick lives outside the layer so it can chase a thumb past the safe area,
     so it needs the same three visibility rules spelled out for itself */
  .rf-touch-ring,.rf-touch-knob{display:none;}
  body.rf-touch .rf-touch-ring,body.rf-touch .rf-touch-knob{display:block;}
  body.photo .rf-touch-ring,body.photo .rf-touch-knob,
  body.rf-touch-hush .rf-touch-ring,body.rf-touch-hush .rf-touch-knob{display:none!important;}
  body.rf-touch-hush .rf-touch-restore{display:none!important;}
  .rf-touch-glass{background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
  body[data-rf-quality="low"] .rf-touch-glass{backdrop-filter:none;-webkit-backdrop-filter:none;background:rgba(10,20,26,.9);}

  /* 2 · the stick — fixed to the viewport so it can chase a thumb anywhere */
  .rf-touch-ring,.rf-touch-knob{position:fixed;border-radius:50%;pointer-events:none;
    transition:opacity .18s ease,transform .18s cubic-bezier(.2,.8,.2,1);}
  .rf-touch-ring{width:var(--rf-touch-ring,132px);height:var(--rf-touch-ring,132px);
    margin-left:calc(var(--rf-touch-ring,132px) / -2);margin-top:calc(var(--rf-touch-ring,132px) / -2);
    border:1.5px solid var(--glass-bd);background:var(--glass-sheen),var(--glass);
    backdrop-filter:blur(10px) saturate(1.5);-webkit-backdrop-filter:blur(10px) saturate(1.5);
    box-shadow:var(--glass-hi),0 8px 26px rgba(2,8,10,.4);opacity:.34;}
  .rf-touch-ring::before{content:"";position:absolute;inset:9px;border-radius:50%;
    background:repeating-conic-gradient(from -2deg,rgba(255,255,255,.16) 0 4deg,transparent 4deg 45deg);
    -webkit-mask:radial-gradient(circle,transparent 62%,#000 63%);mask:radial-gradient(circle,transparent 62%,#000 63%);}
  .rf-touch-ring::after{content:"";position:absolute;inset:0;border-radius:50%;
    box-shadow:inset 0 0 22px rgba(57,215,196,0);transition:box-shadow .2s;}
  .rf-touch-ring.on{opacity:.96;}
  .rf-touch-ring.on::after{box-shadow:inset 0 0 22px rgba(57,215,196,.22);}
  .rf-touch-knob{width:var(--rf-touch-knob,58px);height:var(--rf-touch-knob,58px);
    margin-left:calc(var(--rf-touch-knob,58px) / -2);margin-top:calc(var(--rf-touch-knob,58px) / -2);
    background:linear-gradient(180deg,rgba(57,215,196,.46),rgba(57,215,196,.14));
    border:1.5px solid rgba(57,215,196,.72);opacity:.42;
    box-shadow:var(--glass-hi),0 0 20px rgba(57,215,196,.32),0 6px 16px rgba(2,8,10,.45);}
  .rf-touch-knob.on{opacity:1;}
  body.rf-reduced .rf-touch-ring,body.rf-reduced .rf-touch-knob{transition:none;}

  /* 3 · the action button */
  .rf-touch-act{position:absolute;right:var(--rf-touch-pad,20px);bottom:var(--rf-touch-pad,20px);
    width:var(--rf-touch-act,88px);height:var(--rf-touch-act,88px);border-radius:50%;pointer-events:auto;
    display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;
    font-family:"Chakra Petch",sans-serif;font-weight:700;letter-spacing:.09em;color:var(--teal);
    background:radial-gradient(88% 88% at 50% 18%,rgba(57,215,196,.24),rgba(57,215,196,.05) 62%),var(--glass-strong);
    backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);
    border:1.5px solid rgba(57,215,196,.62);
    box-shadow:var(--glass-hi),0 0 26px rgba(57,215,196,.2),0 10px 26px rgba(2,8,10,.45);
    transition:transform .07s ease,box-shadow .16s,border-color .16s;-webkit-tap-highlight-color:transparent;}
  .rf-touch-act.dn{transform:scale(.94);border-color:var(--teal);
    box-shadow:inset 0 2px 10px rgba(2,8,10,.5),0 0 34px rgba(57,215,196,.4);}
  .rf-touch-act .rf-touch-verb{position:relative;z-index:2;font-size:calc(var(--rf-touch-act,88px) * .17);
    text-shadow:0 1px 6px rgba(2,8,10,.8);}
  .rf-touch-act svg.rf-touch-hold{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);
    pointer-events:none;overflow:visible;}
  .rf-touch-act svg.rf-touch-hold circle{fill:none;stroke-width:3;stroke-linecap:round;
    stroke-dasharray:263.9;stroke-dashoffset:263.9;transition:stroke .25s;}
  body.rf-reduced .rf-touch-act{transition:none;}

  /* 4 · the rail + tray */
  .rf-touch-rail{position:absolute;right:calc(var(--rf-touch-pad,20px) + (var(--rf-touch-act,88px) - var(--rf-touch-btn,54px)) / 2);
    bottom:calc(var(--rf-touch-pad,20px) + var(--rf-touch-act,88px) + 12px);
    display:flex;flex-direction:column-reverse;gap:9px;pointer-events:none;}
  .rf-touch-btn{width:var(--rf-touch-btn,54px);height:var(--rf-touch-btn,54px);border-radius:16px;
    pointer-events:auto;cursor:pointer;padding:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:1px;color:var(--lab);font-family:"IBM Plex Mono",monospace;
    background:var(--glass-sheen),var(--glass-hud);border:1px solid var(--glass-bd);
    backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    box-shadow:var(--glass-hi),0 6px 18px rgba(2,8,10,.4);
    transition:transform .07s ease,border-color .14s,color .14s;-webkit-tap-highlight-color:transparent;}
  .rf-touch-btn .rf-touch-lbl{font-size:8px;letter-spacing:.14em;text-transform:uppercase;opacity:.9;}
  .rf-touch-btn .rf-touch-gl{font-size:17px;line-height:1;color:var(--ink);}
  .rf-touch-btn.dn{transform:scale(.92);border-color:var(--teal);}
  .rf-touch-btn.lit{color:var(--teal);border-color:rgba(57,215,196,.8);
    box-shadow:var(--glass-hi),0 0 16px rgba(57,215,196,.3),0 6px 18px rgba(2,8,10,.4);}
  .rf-touch-btn.lit .rf-touch-gl{color:var(--teal);}
  body[data-rf-quality="low"] .rf-touch-btn{backdrop-filter:none;-webkit-backdrop-filter:none;background:rgba(11,21,27,.92);}

  .rf-touch-scrim{position:fixed;inset:0;z-index:1;display:none;background:rgba(3,9,11,.42);
    -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);pointer-events:auto;}
  .rf-touch-scrim.on{display:block;}
  .rf-touch-tray{position:absolute;left:10px;right:10px;bottom:calc(var(--rf-touch-pad,20px));z-index:2;
    display:none;border-radius:20px;padding:13px 13px 14px;pointer-events:auto;
    max-height:min(64vh,520px);overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
  .rf-touch-tray.on{display:block;animation:rf-touch-up .22s cubic-bezier(.2,.8,.2,1);}
  body.rf-reduced .rf-touch-tray.on{animation:none;}
  @keyframes rf-touch-up{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:none;}}
  .rf-touch-tray h4{font-family:"Chakra Petch",sans-serif;font-size:10px;font-weight:700;letter-spacing:.26em;
    text-transform:uppercase;color:var(--teal);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;}
  .rf-touch-tray h4 span{font-family:"IBM Plex Mono",monospace;font-size:9px;letter-spacing:.1em;color:var(--faint);}
  .rf-touch-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;}
  .rf-touch-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
    min-height:66px;border-radius:14px;cursor:pointer;padding:8px 4px;
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);color:var(--ink);
    font-family:"IBM Plex Mono",monospace;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);
    transition:transform .07s ease,border-color .14s,color .14s;-webkit-tap-highlight-color:transparent;}
  .rf-touch-cell .rf-touch-gl{font-size:19px;line-height:1;}
  .rf-touch-cell .rf-touch-lbl{font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);}
  .rf-touch-cell .rf-touch-val{font-family:"Chakra Petch",sans-serif;font-size:9px;font-weight:700;
    letter-spacing:.1em;color:var(--teal);font-variant-numeric:tabular-nums;}
  .rf-touch-cell.dn{transform:scale(.94);}
  .rf-touch-cell.off{opacity:.44;}
  .rf-touch-cell.off .rf-touch-val{color:var(--faint);}

  /* the way back when the player has switched the layer off */
  .rf-touch-restore{position:fixed;right:calc(env(safe-area-inset-right) + 10px);
    bottom:calc(env(safe-area-inset-bottom) + 10px);z-index:29;display:none;
    width:46px;height:46px;border-radius:14px;align-items:center;justify-content:center;
    font-size:17px;color:var(--faint);cursor:pointer;padding:0;
    background:var(--glass);border:1px solid var(--glass-bd-soft);
    backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);opacity:.55;}
  body.rf-touch-restore .rf-touch-restore{display:flex;}
  body.photo .rf-touch-restore{display:none!important;}

  /* 9 · the landscape hint */
  .rf-touch-tip{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 16px);transform:translateX(-50%);
    z-index:31;display:none;width:min(320px,calc(100vw - 32px));border-radius:16px;padding:13px 15px;
    text-align:center;pointer-events:auto;}
  .rf-touch-tip.on{display:block;animation:rf-touch-dn .3s cubic-bezier(.2,.8,.2,1);}
  body.photo .rf-touch-tip{display:none!important;}
  body.rf-reduced .rf-touch-tip.on{animation:none;}
  @keyframes rf-touch-dn{from{opacity:0;transform:translateX(-50%) translateY(-14px);}to{opacity:1;transform:translateX(-50%);}}
  .rf-touch-tip b{display:block;font-family:"Chakra Petch",sans-serif;font-size:13px;letter-spacing:.06em;
    color:var(--ink);margin-bottom:3px;}
  .rf-touch-tip i{display:block;font-style:normal;font-size:10.5px;line-height:1.5;color:var(--muted);margin-bottom:10px;}
  .rf-touch-tip button{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;letter-spacing:.16em;
    color:var(--teal-ink);background:var(--teal);border:none;border-radius:9px;padding:9px 22px;cursor:pointer;
    box-shadow:0 2px 0 #1c9c8c;}

  /* ══ 6 · THE SMALL-SCREEN SHEET ══════════════════════════════════════ */
  body.rf-touch{overscroll-behavior:none;-webkit-touch-callout:none;}
  body.rf-touch #scene,body.rf-touch #vig,body.rf-touch #rf-touch{touch-action:none;}
  body.rf-touch #scene canvas{touch-action:none;-webkit-user-select:none;user-select:none;}
  /* …but everything that is meant to scroll still scrolls, and text still selects */
  body.rf-touch .card,body.rf-touch #casino .card-c,body.rf-touch .stake-list,body.rf-touch #chatLog,
  body.rf-touch .rf-touch-tray,body.rf-touch #capcard .capc{touch-action:pan-y;overscroll-behavior:contain;
    -webkit-overflow-scrolling:touch;}
  /* the shared opt-in: any mod's scroll box wears one of these two and is
     treated exactly like a core scroller, here and in the gesture code */
  body.rf-touch [data-rf-touch-scroll],body.rf-touch .rf-touch-scroll{overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
  body.rf-touch #hotbar{touch-action:pan-x;}
  body.rf-touch button,body.rf-touch .btn,body.rf-touch .x,body.rf-touch .tabbtn,body.rf-touch .stake,
  body.rf-touch .betbtn,body.rf-touch .slot,body.rf-touch .wthumb{touch-action:manipulation;-webkit-tap-highlight-color:transparent;}
  body.rf-touch input,body.rf-touch textarea{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;}
  /* 16px is the floor iOS will not zoom into on focus */
  body.rf-touch #chatIn,body.rf-touch #acctForm input{font-size:16px;}

  @media (max-width:820px){
    body.rf-touch #hud-bucket{top:calc(env(safe-area-inset-top) + 8px);left:calc(env(safe-area-inset-left) + 8px);
      font-size:12px;padding:6px 10px;gap:6px;border-radius:9px;}
    body.rf-touch #hud-ores{top:calc(env(safe-area-inset-top) + 44px);left:calc(env(safe-area-inset-left) + 8px);
      flex-wrap:wrap;gap:4px;max-width:min(62vw,300px);}
    body.rf-touch .orechip{font-size:11px;padding:4px 7px;gap:4px;border-radius:8px;}
    body.rf-touch #skyDial{width:60px;height:19px;}
    body.rf-touch #minimap{top:calc(env(safe-area-inset-top) + 92px);left:calc(env(safe-area-inset-left) + 8px);
      width:96px;height:96px;border-radius:12px;}
    body.rf-touch #hud-coins{top:calc(env(safe-area-inset-top) + 8px);right:calc(env(safe-area-inset-right) + 8px);
      font-size:16px;padding:6px 11px;gap:6px;border-radius:10px;}
    body.rf-touch #hud-pearls{top:calc(env(safe-area-inset-top) + 48px);right:calc(env(safe-area-inset-right) + 8px);
      font-size:13px;padding:5px 10px;gap:6px;border-radius:9px;}
    body.rf-touch #hud-bait{top:calc(env(safe-area-inset-top) + 84px);right:calc(env(safe-area-inset-right) + 8px);
      font-size:11px;padding:4px 9px;}
    body.rf-touch #derby{top:calc(env(safe-area-inset-top) + 118px);right:calc(env(safe-area-inset-right) + 8px);font-size:10px;padding:5px 9px;}
    body.rf-touch #hud-auto{top:auto;bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px) + 58px);
      left:calc(env(safe-area-inset-left) + 8px);font-size:10px;}
    body.rf-touch #area{top:calc(env(safe-area-inset-top) + 124px);font-size:12px;letter-spacing:.1em;padding:5px 13px 6px;}
    body.rf-touch #mute{display:none;}

    body.rf-touch #hotbar{left:0;right:0;transform:none;justify-content:flex-start;align-items:center;gap:6px;
      bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px));
      padding:2px calc(env(safe-area-inset-right) + 10px) 2px calc(env(safe-area-inset-left) + 10px);
      overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}
    body.rf-touch #hotbar::-webkit-scrollbar{height:0;}
    body.rf-touch #hotbar .slot{width:48px;height:48px;flex:0 0 auto;border-radius:12px;}
    body.rf-touch #hotbar .slot .sic{height:24px;}
    body.rf-touch #hotbar .slot .sb{font-size:9px;}
    body.rf-touch #hotbar .invkey{flex:0 0 auto;font-size:9px;padding:5px 8px;}
    body.rf-touch #hint{bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px) + 58px);
      font-size:11.5px;padding:7px 11px;max-width:calc(100vw - 24px);text-align:center;line-height:1.5;}
    body.rf-touch #toasts{bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px) + 172px);max-width:96vw;}
    body.rf-touch .toast{white-space:normal;max-width:92vw;text-align:center;font-size:12px;}
    body.rf-touch #chat{left:calc(env(safe-area-inset-left) + 8px);
      width:calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 16px);
      bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px) + 104px);}
    body.rf-touch #chatLog{max-height:22vh;}
    body.rf-touch .cmsg{font-size:11px;}

    /* overlays become sheets: full bleed, one sticky head, momentum below it */
    body.rf-touch .overlay:not(.overlay-start){align-items:stretch;justify-content:stretch;padding:0;}
    body.rf-touch .overlay:not(.overlay-start) .card,body.rf-touch #casino .card-c{
      width:100%;max-width:none;height:100%;max-height:100vh;max-height:100dvh;border-radius:0;border:none;
      padding:0 calc(env(safe-area-inset-right) + 13px) calc(env(safe-area-inset-bottom) + 34px) calc(env(safe-area-inset-left) + 13px);}
    body.rf-touch #casino .card-c{position:absolute;inset:0;right:0;top:0;transform:none;animation:none;}
    body.rf-touch .overlay:not(.overlay-start) .card-head,body.rf-touch #casino .card-head{
      position:sticky;top:0;z-index:4;align-items:center;gap:10px;
      margin:0 calc(-1 * (env(safe-area-inset-right) + 13px)) 10px calc(-1 * (env(safe-area-inset-left) + 13px));
      padding:calc(env(safe-area-inset-top) + 12px) calc(env(safe-area-inset-right) + 13px) 10px calc(env(safe-area-inset-left) + 13px);
      background:linear-gradient(180deg,rgba(10,20,26,.94),rgba(10,20,26,.74));
      backdrop-filter:blur(16px) saturate(1.5);-webkit-backdrop-filter:blur(16px) saturate(1.5);
      border-bottom:1px solid var(--glass-bd-soft);}
    body.rf-touch .card-head h2{font-size:19px;}
    body.rf-touch .card-head .sub{font-size:9.5px;letter-spacing:.18em;}
    body.rf-touch .x{padding:10px 13px;font-size:11px;min-height:40px;flex:0 0 auto;}
    body.rf-touch .btn{padding:11px 15px;min-height:42px;}
    body.rf-touch .tabs{overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none;gap:6px;}
    body.rf-touch .tabs::-webkit-scrollbar{height:0;}
    body.rf-touch .tabbtn{flex:0 0 auto;padding:10px 15px;font-size:11px;}
    body.rf-touch .invcard,body.rf-touch .deed{flex:1 1 100%;min-width:0;}
    body.rf-touch .fishrow{flex-wrap:wrap;gap:9px;}
    body.rf-touch .fishrow .nm{flex:1 1 60%;font-size:13px;}
    body.rf-touch .fishrow .btns{flex:1 1 100%;justify-content:flex-end;}
    body.rf-touch .fishrow .btns .btn{padding:9px 14px;font-size:11.5px;}
    body.rf-touch .swatchrow .sw{width:28px;height:28px;}
    body.rf-touch .stake-list{max-height:34vh;}
    body.rf-touch .stake{padding:10px 11px;}
    body.rf-touch .betbtn{padding:13px 0;}
    body.rf-touch #dockView canvas{width:100%;height:auto;}
    body.rf-touch #capcard{left:0;right:0;top:auto;bottom:0;width:100%;transform:translateY(16px);}
    body.rf-touch.capcam #capcard{transform:none;}
    body.rf-touch #capcard .capc{border-radius:18px 18px 0 0;max-height:46vh;
      padding:14px calc(env(safe-area-inset-right) + 15px) calc(env(safe-area-inset-bottom) + 14px) calc(env(safe-area-inset-left) + 15px);}
    body.rf-touch #emotebar{left:0;right:0;width:100%;transform:none;flex-wrap:wrap;justify-content:center;
      padding:0 10px;bottom:calc(env(safe-area-inset-bottom) + 12px);}
    body.rf-touch.capcam #emotebar{transform:none;}
    body.rf-touch #emotebar .eslot{width:52px;height:52px;border-radius:12px;}
    body.rf-touch #emotebar .ee{font-size:18px;}
    body.rf-touch #emotebar .en{font-size:7px;}
    /* the title screen has to fit a 380px phone before anything else can */
    body.rf-touch .start-box{padding:calc(env(safe-area-inset-top) + 22px) 16px calc(env(safe-area-inset-bottom) + 14px);}
    body.rf-touch .start-box h1{white-space:normal;font-size:clamp(2.1rem,11vw,3.6rem);line-height:1;}
    body.rf-touch .start-box .eye{font-size:9px;letter-spacing:.3em;}
    body.rf-touch .start-box .eye::before,body.rf-touch .start-box .eye::after{flex-basis:34px;}
    body.rf-touch .start-box .tag{font-size:12px;padding:5px 12px;}
    body.rf-touch .dock{width:min(560px,calc(100vw - 24px));padding:12px 14px 12px;}
    body.rf-touch .cta{padding:15px 34px;font-size:16px;width:100%;}
    body.rf-touch #acctForm input{width:100%;flex:1 1 130px;min-width:0;}
    body.rf-touch #acctWays .btn{font-size:10px;padding:9px 12px;}
    body.rf-touch .controls{gap:8px;font-size:9px;}
    body.rf-touch #worldRow{gap:9px;flex-wrap:wrap;}
  }
  @media (max-width:520px){ body.rf-touch #minimap{display:none;} }
  @media (max-height:520px){
    body.rf-touch #hud-ores{max-width:44vw;}
    body.rf-touch #minimap{display:none;}
    body.rf-touch #chatLog{max-height:15vh;}
    body.rf-touch #toasts{bottom:calc(env(safe-area-inset-bottom) + var(--rf-touch-lift,168px) + 116px);}
  }
  `, 'rf-touch-css');

  /* ══════════════════════════════════════════════════════════════════════
     2. DOM
     ══════════════════════════════════════════════════════════════════════ */
  const probe = RF.el('<div class="rf-touch-probe"></div>');
  const ring = RF.el('<div class="rf-touch-ring"></div>');
  const knob = RF.el('<div class="rf-touch-knob"></div>');
  const root = RF.el('<div id="rf-touch"></div>');
  if (!root || !ring || !knob) { RF.err('touch:dom', new Error('layer did not build')); return; }

  root.innerHTML =
    '<div class="rf-touch-scrim"></div>' +
    '<button class="rf-touch-act" type="button" aria-label="Action">' +
      '<svg class="rf-touch-hold" viewBox="0 0 92 92"><circle cx="46" cy="46" r="42" stroke="var(--teal)"></circle></svg>' +
      '<span class="rf-touch-verb">E</span></button>' +
    '<div class="rf-touch-rail"></div>' +
    '<div class="rf-touch-tray rf-touch-glass"><h4>Isle controls<span>tap outside to close</span></h4>' +
      '<div class="rf-touch-grid"></div></div>';

  const scrim = root.querySelector('.rf-touch-scrim'),
        actBtn = root.querySelector('.rf-touch-act'),
        verb = root.querySelector('.rf-touch-verb'),
        holdArc = root.querySelector('.rf-touch-hold circle'),
        rail = root.querySelector('.rf-touch-rail'),
        tray = root.querySelector('.rf-touch-tray'),
        grid = root.querySelector('.rf-touch-grid');
  const restore = RF.el('<button class="rf-touch-restore" type="button" title="Touch controls">⌖</button>');
  const tip = RF.el('<div class="rf-touch-tip rf-touch-glass"><b></b><i></i>' +
    '<button type="button">GOT IT</button></div>');
  const tipT = tip.querySelector('b'), tipB = tip.querySelector('i'), tipOk = tip.querySelector('button');
  let tipDone = null;
  function showTip(title, text, label, done) {
    tipT.textContent = title; tipB.textContent = text;
    tipOk.textContent = label || 'GOT IT'; tipDone = done || null;
    tip.classList.add('on');
  }
  function hideTip() { const d = tipDone; tipDone = null; tip.classList.remove('on');
    if (d) { try { d(); } catch (e) { RF.err('touch:tip', e); } } }

  const ARC = 263.9;   // 2πr for the r=42 hold ring
  const setArc = p => { if (holdArc) holdArc.style.strokeDashoffset = String(ARC * (1 - clamp(p, 0, 1))); };
  setArc(0);

  /* ══════════════════════════════════════════════════════════════════════
     3. DETECTION — coarse pointer AND a real finger; a physical key or a
     genuine mouse move puts it away again, so a hybrid laptop behaves.
     ══════════════════════════════════════════════════════════════════════ */
  let coarse = false, touched = false, active = false, lastTouchT = 0;
  const mq = q => { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; } };
  const readCoarse = () => { coarse = mq('(pointer: coarse)') || mq('(any-pointer: coarse)'); };
  readCoarse();
  try { const m = window.matchMedia && window.matchMedia('(pointer: coarse)');
    if (m && m.addEventListener) m.addEventListener('change', () => { readCoarse(); apply(); });
    else if (m && m.addListener) m.addListener(() => { readCoarse(); apply(); }); } catch (e) {}

  const want = () => P.mode === 'on' ? true : P.mode === 'off' ? false : (coarse && touched);

  /* viewport-fit=cover is what makes env(safe-area-inset-*) non-zero; index.html
     cannot be edited from here, so the tag is widened the moment touch wins. */
  let coverDone = false;
  function coverViewport() {
    if (coverDone) return; coverDone = true;
    try { const m = document.querySelector('meta[name="viewport"]');
      if (m && m.content.indexOf('viewport-fit') < 0) m.content = m.content + ',viewport-fit=cover';
    } catch (e) { RF.err('touch:viewport', e, 'warn'); }
  }

  function apply() {
    const on = want();
    if (on === active) { body.classList.toggle('rf-touch-restore', !on && coarse && touched); return; }
    active = on;
    body.classList.toggle('rf-touch', on);
    body.classList.toggle('rf-touch-restore', !on && coarse && touched);
    if (on) { coverViewport(); metrics(); placeHome(); maybeTip(); }
    else { releaseAll(); closeTray(); tip.classList.remove('on'); tipDone = null;
      body.classList.remove('rf-touch-hush'); lastHush = null; }
  }

  /* Compatibility mouse events ride in behind every tap, so a "real" mouse must
     both be a fine pointer and arrive well clear of the last finger. */
  function standDown(why) {
    if (P.mode === 'on') return;                 // forced on: a stray key changes nothing
    if (!touched) return;
    touched = false; if (why === 'key') lastTouchT = 0;
    apply();
  }
  const softKey = () => { try { const a = document.activeElement;
    return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  } catch (e) { return false; } };
  /* An on-screen keyboard fires perfectly trusted keydowns, so "a physical key
     arrived" has to mean a key that arrived with nothing focused and no finger
     on the glass a moment ago — otherwise typing one chat line kills the pad. */
  addEventListener('keydown', e => {
    if (!e || !e.isTrusted || softKey()) return;
    if (Date.now() - lastTouchT < 1500) return;
    standDown('key');
  }, true);
  let mx = 0, my = 0, mSeen = false;
  function mouseMoved(x, y, kind) {
    if (kind && kind !== 'mouse') return;
    if (Date.now() - lastTouchT < 900) return;   // the tap's own ghost move
    if (!mSeen) { mSeen = true; mx = x; my = y; return; }
    if (Math.abs(x - mx) + Math.abs(y - my) < 8) return;
    mx = x; my = y;
    if (mq('(pointer: fine)')) standDown('mouse');
  }
  if (window.PointerEvent) addEventListener('pointermove', e => mouseMoved(e.clientX, e.clientY, e.pointerType), true);
  else addEventListener('mousemove', e => mouseMoved(e.clientX, e.clientY, 'mouse'), true);

  /* ══════════════════════════════════════════════════════════════════════
     4. METRICS — sizes and safe insets, recomputed only on resize.
     ══════════════════════════════════════════════════════════════════════ */
  let lastVerb = '', lastHold = -1, lastHush = null, lastFish = '';
  let RING = 132, KNOB = 58, ACT = 88, PAD = 20, LIFT = 168;
  let safeL = 0, safeR = 0, safeT = 0, safeB = 0;
  let homeX = 0, homeY = 0;

  function metrics() {
    try {
      const cs = getComputedStyle(probe);
      safeT = parseFloat(cs.paddingTop) || 0; safeR = parseFloat(cs.paddingRight) || 0;
      safeB = parseFloat(cs.paddingBottom) || 0; safeL = parseFloat(cs.paddingLeft) || 0;
    } catch (e) { safeT = safeR = safeB = safeL = 0; }
    let ui = 1;
    try { ui = parseFloat(getComputedStyle(root3).getPropertyValue('--rf-ui-scale')) || 1; } catch (e) {}
    ui = clamp(ui, 0.7, 1.5);
    const w = window.innerWidth, h = window.innerHeight, tight = h <= 520;
    const s = clamp(Math.min(w, h) / 430, 0.78, 1.18) * ui;
    RING = Math.round((tight ? 116 : 132) * s);
    KNOB = Math.round(52 * s);
    ACT = Math.round((tight ? 76 : 88) * s);
    PAD = Math.round(18 * s);
    LIFT = Math.round((tight ? 118 : 158) * s) + 12;
    const st = root3.style;
    st.setProperty('--rf-touch-ring', RING + 'px');
    st.setProperty('--rf-touch-knob', KNOB + 'px');
    st.setProperty('--rf-touch-act', ACT + 'px');
    st.setProperty('--rf-touch-btn', Math.round(52 * s) + 'px');
    st.setProperty('--rf-touch-pad', PAD + 'px');
    st.setProperty('--rf-touch-lift', LIFT + 'px');
    homeX = safeL + PAD + RING / 2;
    homeY = window.innerHeight - safeB - PAD - RING / 2;
  }
  function placeHome() { ring.style.left = homeX + 'px'; ring.style.top = homeY + 'px';
    knob.style.left = homeX + 'px'; knob.style.top = homeY + 'px'; }
  metrics(); placeHome();
  addEventListener('resize', () => { try { metrics(); if (!stick.on) placeHome(); maybeTip(); } catch (e) { RF.err('touch:resize', e); } });
  addEventListener('orientationchange', () => setTimeout(() => { try { metrics(); if (!stick.on) placeHome(); maybeTip(); } catch (e) {} }, 240));

  /* ══════════════════════════════════════════════════════════════════════
     5. KEY BRIDGE — a real KeyboardEvent on <body> so it bubbles to core's
     window listener AND every mod that listens raw; core then owns actEdge,
     which is the only way a mod can produce the keydown transition edge the
     fishing/mining code reads.
     ══════════════════════════════════════════════════════════════════════ */
  const KEYCH = { KeyE: 'e', KeyI: 'i', KeyF: 'f', KeyC: 'c', KeyP: 'p', KeyT: 't',
    KeyM: 'm', KeyQ: 'q', KeyJ: 'j', KeyO: 'o' };
  function kev(type, code) {
    try {
      const e = new KeyboardEvent(type, { code: code, key: KEYCH[code] || '', bubbles: true, cancelable: true, view: window });
      (document.body || window).dispatchEvent(e);
    } catch (e) { RF.err('touch:key:' + code, e, 'warn'); }
  }
  const press = code => kev('keydown', code);
  const lift = code => kev('keyup', code);
  const tapKey = code => { press(code); setTimeout(() => lift(code), 16); };

  /* ══════════════════════════════════════════════════════════════════════
     6. THE STICK — eight-way into RF.keys, re-asserted per frame so a stray
     blur mid-drag cannot leave the hero walking. Release is the failure mode
     everything here is designed against: touchend, touchcancel, blur, hidden
     tab, panel open, mode off — all funnel through releaseAll().
     ══════════════════════════════════════════════════════════════════════ */
  const K = RF.keys;
  const stick = { on: false, id: -1, cx: 0, cy: 0, up: false, down: false, left: false, right: false };
  const DEAD = 0.24;

  function clearMove() {
    stick.up = stick.down = stick.left = stick.right = false;
    try { K.up = K.down = K.left = K.right = false; } catch (e) {}
  }
  function resolve(dx, dy) {
    const r = RING / 2, len = Math.hypot(dx, dy);
    if (len < r * DEAD) { stick.up = stick.down = stick.left = stick.right = false; return; }
    // screen-up is -y; core's FWD already points up the screen, so the angle maps 1:1
    const a = Math.atan2(-dy, dx), s = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    stick.right = s === 7 || s === 0 || s === 1;
    stick.up    = s === 1 || s === 2 || s === 3;
    stick.left  = s === 3 || s === 4 || s === 5;
    stick.down  = s === 5 || s === 6 || s === 7;
  }
  function stickStart(t) {
    stick.on = true; stick.id = t.identifier;
    // the ring jumps to the thumb rather than making the thumb find the ring
    const r = RING / 2;
    stick.cx = clamp(t.clientX, safeL + r + 4, window.innerWidth - safeR - r - 4);
    stick.cy = clamp(t.clientY, window.innerHeight * 0.34, window.innerHeight - safeB - r - 4);
    ring.style.left = stick.cx + 'px'; ring.style.top = stick.cy + 'px';
    ring.classList.add('on'); knob.classList.add('on');
    stickMove(t);
  }
  function stickMove(t) {
    const r = RING / 2;
    let dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
    const len = Math.hypot(dx, dy);
    if (len > r) { const k = r / len; dx *= k; dy *= k; }
    knob.style.left = (stick.cx + dx) + 'px'; knob.style.top = (stick.cy + dy) + 'px';
    resolve(dx, dy);
  }
  function stickEnd() {
    if (!stick.on) return;
    stick.on = false; stick.id = -1; clearMove();
    ring.classList.remove('on'); knob.classList.remove('on');
    placeHome();
  }

  /* ── the action button ── */
  let held = false;
  function actDown() {
    if (held) return; held = true;
    actBtn.classList.add('dn');
    press('KeyE');                     // core sets actEdge on the transition, once
    buzz(9);
    try { RF.audio.resume(); } catch (e) {}
  }
  function actUp() {
    if (!held) return; held = false;
    actBtn.classList.remove('dn');
    lift('KeyE');
    try { K.act = false; } catch (e) {}
    setArc(0); lastHold = -1;
  }
  actBtn.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); actDown(); }, { passive: false });
  actBtn.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); actUp(); }, { passive: false });
  actBtn.addEventListener('touchcancel', () => actUp());
  actBtn.addEventListener('contextmenu', e => e.preventDefault());

  function releaseAll() {
    stickEnd(); actUp(); pinch = null; orbit = null;
    try { K.act = false; } catch (e) {}
  }
  addEventListener('blur', releaseAll);
  addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  /* ══════════════════════════════════════════════════════════════════════
     7. THE RAIL & TRAY
     ══════════════════════════════════════════════════════════════════════ */
  function onTap(el, fn) {
    let t = 0;
    const go = e => { try { fn(e); } catch (err) { RF.err('touch:tap', err); } };
    el.addEventListener('touchstart', e => { t = Date.now(); if (e.cancelable) e.preventDefault();
      el.classList.add('dn'); buzz(7); go(e); }, { passive: false });
    el.addEventListener('touchend', e => { el.classList.remove('dn'); if (e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener('touchcancel', () => el.classList.remove('dn'));
    el.addEventListener('click', e => { if (Date.now() - t < 800) return; go(e); try { el.blur(); } catch (err) {} });
  }
  function mkBtn(cls, inner, label, fn) {
    const b = RF.el('<button class="' + cls + '" type="button" aria-label="' + label + '">' + inner + '</button>', null);
    onTap(b, fn); return b;
  }
  const glyph = (g, l) => '<span class="rf-touch-gl">' + g + '</span><span class="rf-touch-lbl">' + l + '</span>';
  const icon = (n, l) => '<span class="rf-touch-gl">' + (pix(n, 20) || '◆') + '</span><span class="rf-touch-lbl">' + l + '</span>';

  const bagBtn = mkBtn('rf-touch-btn', icon('bucket', 'bag'), 'Inventory', () => tapKey('KeyI'));
  const autoBtn = mkBtn('rf-touch-btn', icon('rod', 'rig'), 'Auto-rig', () => tapKey('KeyF'));
  const camBtn = mkBtn('rf-touch-btn', icon('crew', 'cam'), 'Captain cam', () => tapKey('KeyC'));
  const moreBtn = mkBtn('rf-touch-btn', glyph('⋯', 'more'), 'More controls', () => toggleTray());
  rail.appendChild(moreBtn); rail.appendChild(camBtn); rail.appendChild(autoBtn); rail.appendChild(bagBtn);

  const cells = [];
  function cell(g, label, fn, state) {
    const c = RF.el('<button class="rf-touch-cell" type="button">' + glyph(g, label) +
      '<span class="rf-touch-val"></span></button>', null);
    onTap(c, () => { fn(); renderTray(); });
    c._state = state || null; c._val = c.querySelector('.rf-touch-val');
    grid.appendChild(c); cells.push(c); return c;
  }
  const panelKey = code => () => { closeTray(); tapKey(code); };
  /* Photo mode blanks every control there is, so the first time it is entered
     from a touch the way out is spelled out before the screen goes quiet. */
  cell('▣', 'photo', () => { closeTray();
    if (P.photoTip || RF.photoMode) { tapKey('KeyP'); return; }
    P.photoTip = true; savePrefs();
    showTip('Photo mode', 'Every control disappears · drag to orbit the isle, then tap once to come back.',
      'TAKE THE SHOT', () => tapKey('KeyP')); });
  cell('◈', 'atlas', panelKey('KeyM'));
  cell('⚑', 'quests', panelKey('KeyQ'));
  cell('✎', 'journal', panelKey('KeyJ'));
  cell('⚙', 'settings', panelKey('KeyO'));
  const chatCell = cell('▰', 'chat', () => { closeTray(); tapKey('KeyT'); });
  cell('♪', 'sound', () => { try { RF.audio.setMuted(!RF.audio.muted); } catch (e) { RF.err('touch:mute', e, 'warn'); } },
    () => (RF.audio && RF.audio.muted) ? ['muted', false] : ['on', true]);
  cell('≈', 'haptics', () => { P.haptics = !P.haptics; savePrefs(); if (P.haptics) buzz(18); },
    () => P.haptics ? ['on', true] : ['off', false]);
  cell('⌖', 'controls', () => cycleMode(), () => [P.mode, P.mode !== 'off']);

  function renderTray() {
    for (const c of cells) {
      if (!c._state) continue;
      let v = null; try { v = c._state(); } catch (e) { v = null; }
      if (!v) continue;
      if (c._val) c._val.textContent = v[0];
      c.classList.toggle('off', !v[1]);
    }
    chatCell.classList.toggle('off', !RF.online);
    autoBtn.classList.toggle('lit', !!(RF.autoFish && RF.autoFish.on));
  }
  function toggleTray() { tray.classList.contains('on') ? closeTray() : openTray(); }
  function openTray() { releaseAll(); renderTray(); tray.classList.add('on'); scrim.classList.add('on');
    moreBtn.classList.add('lit'); }
  function closeTray() { tray.classList.remove('on'); scrim.classList.remove('on'); moreBtn.classList.remove('lit'); }
  scrim.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); closeTray(); }, { passive: false });
  scrim.addEventListener('click', () => closeTray());

  /* auto → on → off → auto; only the last one needs asking about */
  function cycleMode() {
    if (P.mode === 'auto') { P.mode = 'on'; savePrefs(); apply(); return; }
    if (P.mode === 'on') {
      const ask = (RF.api && RF.api.confirm) ? RF.api.confirm({
        title: 'Turn touch controls off?', body: 'The isle goes back to keyboard only · a small handle stays in the corner to bring them back.',
        ok: 'Turn off', cancel: 'Keep them', danger: true }) : Promise.resolve(true);
      ask.then(yes => { if (!yes) return; P.mode = 'off'; savePrefs(); closeTray(); apply();
        say({ level: 'info', tag: 'rf-touch-mode', title: 'Touch controls off',
          body: 'The ⌖ handle in the corner brings them back.', ttl: 6000 }); });
      return;
    }
    P.mode = 'auto'; savePrefs(); apply();
  }
  onTap(restore, () => { P.mode = 'on'; savePrefs(); apply(); openTray(); });

  /* ══════════════════════════════════════════════════════════════════════
     7b. WHAT A MOD HANDS US — two things a mod panel needs and core cannot
     give it: a way to say "this box scrolls" and a way to say "I am covering
     the glass". Both are opt-in and both cost nothing when nobody calls them.
     ══════════════════════════════════════════════════════════════════════ */

  /* Every selector core publishes keys off core's own classes, and a mod panel
     is not inside one of them — which is how six mod panels ended up unable to
     scroll below the fold. So: an opt-in attribute/class any mod can wear, the
     selectors a mod registers by hand, and a computed backstop for the ones
     that wear neither. Only the backstop is cached (touchstart clears it),
     because it is the one that reads layout: the selector tests are cheap
     enough to answer fresh on every touchmove. */
  const MODSCROLL = '[data-rf-touch-scroll],.rf-touch-scroll';
  const SCROLLERS = '.card,.card-c,.start-box,.stake-list,#chatLog,.rf-touch-tray,#capcard .capc,' +
    '#hotbar,.tabs,input,textarea,select,' + MODSCROLL;
  const SCROLLY = { auto: 1, scroll: 1, overlay: 1 };
  const modSel = [];
  function inModSel(el) {
    for (let i = 0; i < modSel.length; i++) { try { if (el.closest(modSel[i])) return true; } catch (e) {} }
    return false;
  }
  function walkScrolls(el) {
    for (let n = 0, e = el; e && e.nodeType === 1 && n < 12; e = e.parentElement, n++) {
      if (e === body || e === root3) return false;      // the page itself is the rubber band
      let cs = null; try { cs = getComputedStyle(e); } catch (er) { return false; }
      if (cs && SCROLLY[cs.overflowY] && e.scrollHeight - e.clientHeight > 2) {
        // stamping hands the CSS half of the allow-list the same box the JS half
        // just found — without it the box escapes preventDefault with no scroll
        // chain containment, and overscrolls straight into the document bounce
        try { e.setAttribute('data-rf-touch-scroll', ''); } catch (er) {}
        return true;
      }
    }
    return false;
  }
  let passEl = null, passOK = false;
  function scrollable(el) {
    if (!el || !el.closest) return false;
    if (el.closest(SCROLLERS) || inModSel(el)) return true;
    if (el !== passEl) { passEl = el; passOK = walkScrolls(el); }
    return passOK;
  }
  /* A selector that reaches the page itself makes every touch somebody's
     scroller: mine() goes false everywhere and the stick, the pinch and the
     rubber-band suppressor all die at once. So the page, the body and the glass
     are refused, the list is capped, and a selector that is not one is dropped
     rather than thrown from inside closest() on every touchmove. */
  const MODSEL_MAX = 24;
  function okSel(sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 200) return false;
    try {
      document.querySelector(sel);
      if (root3.matches(sel) || body.matches(sel)) return false;
      const scene = byId('scene');
      return !(scene && scene.matches(sel));
    } catch (e) { return false; }
  }
  /* an element gets stamped so the selector path catches it from then on; a
     string is kept for DOM a mod has not built yet */
  function scroller(what) {
    try {
      if (!what) return false;
      if (typeof what === 'string') {
        if (modSel.indexOf(what) >= 0) return true;
        if (!okSel(what) || modSel.length >= MODSEL_MAX) {
          RF.err('touch:scroller', new Error('refused scroll selector ' + what), 'warn'); return false; }
        modSel.push(what); return true;
      }
      if (what.nodeType === 1) { what.setAttribute('data-rf-touch-scroll', ''); passEl = null; return true; }
      if (typeof what.length === 'number') {
        let n = 0; for (let i = 0; i < what.length; i++) if (scroller(what[i])) n++; return n > 0;
      }
    } catch (e) { RF.err('touch:scroller', e, 'warn'); }
    return false;
  }

  /* RF.panelOpen knows core's four overlays and nothing else, so every panel
     that announces itself on the 'panel' signal is counted here too, and a mod
     with no signal of its own can declare itself through RF.api.touch.panel(). */
  const panels = Object.create(null);
  let panelN = 0;
  function markPanel(name, isOpen, el) {
    const k = 'p:' + (name == null ? 'anon' : name);
    const had = Object.prototype.hasOwnProperty.call(panels, k);
    if (isOpen) { if (!had) panelN++;
      panels[k] = { el: (el && el.nodeType === 1) ? el : null, t: Date.now() }; }
    else if (had) { delete panels[k]; panelN--; }
    if (panelN < 0) panelN = 0;
  }
  /* A mod that throws between its open and its close — or that closes one of
     its surfaces by hand without balancing the signal — would otherwise latch
     the stick off forever, and the 'panel' signal carries no element, so most
     entries have nothing of their own to test. What the census really claims is
     "something is covering the glass", so that is what gets asked: five points
     put to the compositor, and a hit only counts as a cover when it belongs to
     a box owning a real share of the screen — a toast or a HUD pill is not a
     panel, and our own layer never is. An entry that named an element keeps the
     exact check; the rest lapse only after the glass has read clear for a beat,
     which is what keeps a genuinely open panel from being released early. */
  const NOTGLASS = '#scene,#vig,#rf-touch,.rf-touch-tip,.rf-touch-restore';
  const PROBE = [0.5, 0.5, 0.5, 0.22, 0.5, 0.78, 0.24, 0.5, 0.76, 0.5];
  const PLAPSE = 1500;
  let clearAt = 0, probeAt = 0;
  function glassCovered() {
    const w = window.innerWidth, h = window.innerHeight, need = w * h * 0.18;
    for (let i = 0; i < PROBE.length; i += 2) {
      let hit = null;
      try { hit = document.elementFromPoint(w * PROBE[i], h * PROBE[i + 1]); } catch (e) {}
      if (!hit || !hit.closest || hit.closest(NOTGLASS)) continue;
      for (let n = 0, e = hit; e && e.nodeType === 1 && n < 8; e = e.parentElement, n++) {
        if (e === body || e === root3) break;
        let r = null; try { r = e.getBoundingClientRect(); } catch (er) { break; }
        if (r.width * r.height >= need) return true;
      }
    }
    return false;
  }
  function sweepPanels() {
    const now = Date.now();
    let anon = false;
    for (const k in panels) {
      const el = panels[k].el;
      if (!el) { anon = true; continue; }
      let live = false;
      try { live = el.isConnected !== false && !!(el.getClientRects && el.getClientRects().length); } catch (e) { live = false; }
      if (!live) { delete panels[k]; panelN--; }
    }
    // the probe is a layout read, so it is asked a few times a second at most,
    // and only while an entry with nothing to check is actually outstanding
    if (anon && now - probeAt > 380) {
      probeAt = now;
      clearAt = glassCovered() ? 0 : (clearAt || now);
      if (clearAt && now - clearAt >= PLAPSE) {
        for (const k in panels) { const p = panels[k];
          if (!p.el && now - p.t >= PLAPSE) { delete panels[k]; panelN--; } }
      }
    }
    if (panelN < 0) panelN = 0;
  }
  const panelsOpen = () => panelN > 0;

  /* ══════════════════════════════════════════════════════════════════════
     8. GESTURES ON THE WORLD — pinch to zoom, two fingers that scroll
     nothing, and a one-finger orbit that gives photo mode a way out.
     ══════════════════════════════════════════════════════════════════════ */
  let pinch = null, orbit = null;
  const SKIP = '#rf-touch .rf-touch-act,#rf-touch .rf-touch-btn,#rf-touch .rf-touch-cell,' +
    '#rf-touch .rf-touch-tray,#rf-touch .rf-touch-scrim,.rf-touch-tip,.rf-touch-restore,' +
    '#hotbar,#chat,.overlay,#casino,#capcard,#emotebar,#mute,#err,button,input,textarea,a,[role="button"],' +
    MODSCROLL;
  const mine = t => { const el = t && t.target;
    if (!el || !el.closest) return true;
    if (el.closest(SKIP) || inModSel(el)) return false;
    return !scrollable(el); };

  const inStick = (x, y) => x < window.innerWidth * 0.56 &&
    y > window.innerHeight - Math.min(window.innerHeight * 0.52, RING * 2 + 70);

  function gestureStart(e) {
    lastTouchT = Date.now(); passEl = null;
    if (!touched) { touched = true; apply(); }
    if (!active || RF.panelOpen || panelsOpen() || !RF.running) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (!mine(t)) continue;
      if (RF.photoMode) {                                   // photo mode: drag orbits, tap leaves
        if (!orbit) { orbit = { id: t.identifier, x: t.clientX, y: t.clientY, t: Date.now(), moved: 0 };
          if (e.cancelable) e.preventDefault(); }
        continue;
      }
      if (!stick.on && inStick(t.clientX, t.clientY)) { stickStart(t); if (e.cancelable) e.preventDefault(); continue; }
      // A second finger LOW on the glass is a stray hand, not a gesture: the walk
      // survives it. Higher up it is a deliberate spread, and the pinch outranks
      // the stick — one thumb cannot both steer and scale.
      if (stick.on && t.clientY > window.innerHeight * 0.72) continue;
      if (!pinch) {
        const other = stick.on ? findTouch(e.touches, stick.id) : null;
        if (other) { stickEnd(); pinch = { a: other.identifier, b: t.identifier, d: dist(other, t), size: RF.camSize }; }
        else pinch = { a: t.identifier, b: -1, d: 0, size: RF.camSize };
        if (e.cancelable) e.preventDefault();
      } else if (pinch.b < 0) {
        const a = findTouch(e.touches, pinch.a);
        if (a) { pinch.b = t.identifier; pinch.d = dist(a, t); pinch.size = RF.camSize; }
        if (e.cancelable) e.preventDefault();
      }
    }
  }
  function findTouch(list, id) { for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]; return null; }
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  function gestureMove(e) {
    lastTouchT = Date.now();
    if (!active) return;
    if (pinch && pinch.b >= 0) {
      const a = findTouch(e.touches, pinch.a), b = findTouch(e.touches, pinch.b);
      if (a && b) {
        const d = dist(a, b);
        if (pinch.d > 12 && d > 12) {
          // fingers apart zooms IN, so camSize (the half-height in world units) shrinks
          try { RF.camSize = clamp(pinch.size * (pinch.d / d), 7, 17); } catch (err) { RF.err('touch:zoom', err, 'warn'); }
        }
        if (e.cancelable) e.preventDefault();
      }
      return;
    }
    if (orbit) {
      const t = findTouch(e.touches, orbit.id);
      if (t) { const dx = t.clientX - orbit.x, dy = t.clientY - orbit.y;
        orbit.moved += Math.abs(dx) + Math.abs(dy);
        orbit.x = t.clientX; orbit.y = t.clientY;
        // photo mode reads the same four flags for its orbit; hold them for a beat
        orbit.px = dx; orbit.py = dy; orbit.until = Date.now() + 90;
        if (e.cancelable) e.preventDefault(); }
      return;
    }
    if (stick.on) {
      const t = findTouch(e.touches, stick.id);
      if (t) { stickMove(t); if (e.cancelable) e.preventDefault(); }
    }
  }
  function gestureEnd(e) {
    lastTouchT = Date.now();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const id = e.changedTouches[i].identifier;
      if (stick.on && id === stick.id) stickEnd();
      if (pinch && (id === pinch.a || id === pinch.b)) pinch = null;
      if (orbit && id === orbit.id) {
        const quick = Date.now() - orbit.t < 300 && orbit.moved < 14;
        orbit = null; clearMove();
        if (quick && RF.photoMode) tapKey('KeyP');    // a tap is the way out of photo mode
      }
    }
    if (!e.touches.length) { pinch = null; if (stick.on) stickEnd(); }
  }
  document.addEventListener('touchstart', e => { try { gestureStart(e); } catch (err) { RF.err('touch:start', err); } }, { passive: false });
  document.addEventListener('touchmove', e => { try { gestureMove(e); } catch (err) { RF.err('touch:move', err); } }, { passive: false });
  document.addEventListener('touchend', e => { try { gestureEnd(e); } catch (err) { RF.err('touch:end', err); } }, { passive: false });
  document.addEventListener('touchcancel', e => { try { gestureEnd(e); } catch (err) {} releaseAll(); }, { passive: true });

  /* Rubber-band and double-tap zoom die on the world surface only — anything
     that scrolls, core or mod, named or merely computed, is left alone. */
  document.addEventListener('touchmove', e => {
    if (!active) return;
    if (scrollable(e.target)) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', e => { if (active && e.cancelable) e.preventDefault(); });
  document.addEventListener('dblclick', e => { if (active && e.cancelable) e.preventDefault(); });

  /* ══════════════════════════════════════════════════════════════════════
     9. HAPTICS — silent everywhere it does not exist, off under rf-reduced.
     ══════════════════════════════════════════════════════════════════════ */
  const canBuzz = !!(navigator && navigator.vibrate);
  function buzz(p) {
    if (!canBuzz || !P.haptics || !active || reduced()) return;
    try { navigator.vibrate(p); } catch (e) {}
  }
  RF.on('mined', info => { try { buzz(info && info.geode ? [14, 40, 30] : 26); } catch (e) {} });
  RF.on('chopped', () => buzz(22));
  RF.on('dug', () => buzz([10, 30, 24]));
  RF.on('catch', (fish, info) => { try {
    const r = fish && fish.rar;
    if (r === 'legendary') buzz([16, 46, 16, 46, 60]);
    else if (r === 'epic') buzz([14, 44, 40]);
    else if (r === 'rare') buzz([12, 40, 22]);
    else if (!(info && info.auto)) buzz(14);
  } catch (e) {} });
  RF.on('pearls', () => buzz([8, 26, 8]));

  /* ══════════════════════════════════════════════════════════════════════
     10. THE LANDSCAPE HINT — once, ever, and only when it is actually true.
     ══════════════════════════════════════════════════════════════════════ */
  function maybeTip() {
    if (P.hintSeen || !active || tipDone) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (!(h > w && Math.min(w, h) < 540)) { if (!tipDone) tip.classList.remove('on'); return; }
    showTip('Turn your phone sideways',
      'The isle gets a lot more room in landscape · the controls follow.', 'GOT IT',
      () => { P.hintSeen = true; savePrefs(); });
  }
  onTap(tipOk, hideTip);

  /* ══════════════════════════════════════════════════════════════════════
     11. THE FRAME — four boolean writes and, at most, two style writes.
     ══════════════════════════════════════════════════════════════════════ */
  RF.on('frame', () => {
    if (!active) return;
    try {
      /* the controls stand aside for panels, the title screen and the chat
         keyboard — and the stick is released as they do, not left latched */
      const hush = !RF.running || RF.panelOpen || RF.chatOpen || panelsOpen();
      if (hush !== lastHush) { lastHush = hush; body.classList.toggle('rf-touch-hush', hush);
        if (hush) { releaseAll(); closeTray(); } }
      if (hush) return;

      if (stick.on) { K.up = stick.up; K.down = stick.down; K.left = stick.left; K.right = stick.right; }
      else if (orbit) {
        // photo mode's orbit rides the same flags; they lapse a beat after the finger stops
        const live = Date.now() < (orbit.until || 0);
        K.left = live && orbit.px < -1; K.right = live && orbit.px > 1;
        K.up = live && orbit.py < -1; K.down = live && orbit.py > 1;
      }

      if (held) {
        const p = jobProgress();
        if (p.v !== lastHold) { lastHold = p.v; setArc(p.v);
          if (holdArc && p.col) holdArc.setAttribute('stroke', p.col); }
      }
      // a bite is worth a tick even when the thumb is nowhere near the button
      const fs = RF.fishing && RF.fishing.state;
      if (fs !== lastFish) { if (fs === 'bite') buzz(16); lastFish = fs; }
    } catch (e) { RF.err('touch:frame', e); }
  });

  function jobProgress() {
    const f = RF.fishing, m = RF.mining, c = RF.chopping, d = RF.digging;
    if (f && f.state === 'reel') {
      const t = f.tens || 0;
      return { v: Math.round(clamp(f.reel, 0, 1) * 40) / 40,
        col: t > 0.78 ? 'var(--rose)' : t > 0.5 ? 'var(--gold)' : 'var(--teal)' };
    }
    if (m && m.node && m.dur) return { v: Math.round(clamp(m.t / m.dur, 0, 1) * 40) / 40, col: 'var(--teal)' };
    if (c && c.tree && c.dur) return { v: Math.round(clamp(c.t / c.dur, 0, 1) * 40) / 40, col: 'var(--teal)' };
    if (d && d.active && d.dur) return { v: Math.round(clamp(d.t / d.dur, 0, 1) * 40) / 40, col: 'var(--gold)' };
    return { v: 0, col: 'var(--teal)' };
  }

  /* The verb on the button is read off core's own hint line: it is the only
     published surface that already knows what E does where you are standing.
     If the copy ever changes the button quietly falls back to "E". */
  const VERBS = [['BITE', 'HOOK'], ['hold', 'REEL'], ['IT RUNS', 'SLACK'], ['Waiting for a bite', 'WAIT'],
    ['Casting', 'CAST'], ['Cast your line', 'CAST'], ['geode', 'CRACK'], ['meteorite', 'CRACK'],
    ['Mine ', 'MINE'], ['Chop wood', 'CHOP'], ['Dig here', 'DIG'], ['Trade at the Market', 'SHOP'],
    ['Spinning Eel', 'PLAY'], ['The Harbor', 'DOCK'], ['Step through', 'SAIL'],
    ['Descend', 'ENTER'], ['Climb back', 'CLIMB'], ['Bucket full', 'FULL']];
  RF.every(0.22, () => {
    if (!active || !RF.running) return;
    try {
      if (panelN) sweepPanels();
      const h = byId('hint');
      let v = 'E';
      if (h && h.classList.contains('on')) {
        const s = h.textContent || '';
        for (let i = 0; i < VERBS.length; i++) if (s.indexOf(VERBS[i][0]) >= 0) { v = VERBS[i][1]; break; }
      }
      if (v !== lastVerb) { lastVerb = v;
        if (verb) verb.textContent = v;
        // nothing to do here reads as a dimmer button rather than a missing one
        actBtn.style.opacity = (v === 'E' || v === 'WAIT' || v === 'FULL') ? '.66' : '1'; }
      autoBtn.classList.toggle('lit', !!(RF.autoFish && RF.autoFish.on));
      camBtn.classList.toggle('lit', !!RF.capCam);
    } catch (e) { RF.err('touch:verb', e, 'warn'); }
  });

  /* a panel closing must never leave the hero mid-stride, and the same signal
     is the census the stick hushes on */
  RF.on('panel', (name, open) => { markPanel(name, open); releaseAll(); });
  RF.on('travel', () => { for (const k in panels) delete panels[k]; panelN = 0; releaseAll(); });
  RF.on('start', () => { try { metrics(); placeHome(); maybeTip(); renderTray(); } catch (e) {} });
  RF.on('muted', () => { if (tray.classList.contains('on')) renderTray(); });

  /* ESC has no key on a phone; the tray takes it while it is the thing on top */
  RF.on('keydown', e => {
    if (e.code === 'Escape' && tray.classList.contains('on')) { closeTray(); return true; }
  });

  /* ══════════════════════════════════════════════════════════════════════
     12. THE PUBLISHED SURFACE
     ══════════════════════════════════════════════════════════════════════ */
  RF.api = RF.api || {};
  RF.api.touch = {
    active() { return active; },
    show() { P.mode = 'on'; savePrefs(); touched = true; apply(); },
    hide() { P.mode = 'off'; savePrefs(); apply(); },
    auto() { P.mode = 'auto'; savePrefs(); apply(); },
    get mode() { return P.mode; },
    haptics(v) { if (v === undefined) return P.haptics; P.haptics = !!v; savePrefs(); return P.haptics; },
    buzz: buzz,
    key: tapKey,                      // other mods can drive a bound key from their own touch UI
    /* hand over a scroll box — an element, a list of them, or a selector for
       DOM that does not exist yet — and the rubber-band suppressor lets it be */
    scroller: scroller,
    /* declare a mod panel open so the stick goes quiet underneath it; pass the
       panel element as the third argument and we clean up after a mod that
       forgets to close */
    panel(name, open, el) { markPanel(name, open, el); if (open) releaseAll(); return panelN > 0; },
    panelOpen() { return panelN > 0; }
  };

  apply();
  if (want()) { metrics(); placeHome(); }
  renderTray();
});
