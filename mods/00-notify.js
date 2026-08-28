/* ============================================================================
   00-notify — the notification and error centre.

   The game used to fail silently: a dead WebGL context froze the world with no
   message, a rejected server action produced a four-word toast, a mod that threw
   while loading vanished without trace, and a full localStorage quietly stopped
   saving progress. Everything the browser is able to tell us now lands here as a
   card the player can read, expand, copy and — where it makes sense — retry.

   This slot loads first on purpose, so it catches every other mod.
   ========================================================================== */
/* game.js aborts before the mod host exists when three.js is missing; its own
   #err box owns the screen in that case, so there is nothing for us to say. */
if (window.RF && RF.mod) RF.mod('00-notify', function (RF) {
  'use strict';

  /* ---- levels, ordered by how loudly they interrupt. ttl 0 = stays put ---- */
  const RANK = { info: 0, success: 1, warn: 2, error: 3, fatal: 4 };
  const TTL  = { info: 5000, success: 5000, warn: 9000, error: 0, fatal: 0 };
  const LNAME = { info: 'INFO', success: 'OK', warn: 'WARN', error: 'ERROR', fatal: 'FATAL' };
  const MAXCARDS = 4, MAXQUEUE = 30, LOGCAP = 400, DEDUP_MS = 20000, SFX_GAP = 700;

  /* ======================================================================
     1. LOOK — one style block, keyed so a reload replaces it
     ====================================================================== */
  RF.css(`
  /* below coins/pearls/bait/derby on the right rail. Newest sits on top, so a
     storm pushes the OLD cards off the bottom of the screen, never the new one. */
  #rf-notify-stack{position:fixed;top:186px;right:12px;z-index:35;width:min(330px,44vw);
    display:flex;flex-direction:column;gap:8px;pointer-events:none;
    font-size:calc(12px*var(--rf-ui-scale,1));}
  .rf-notify-card{pointer-events:auto;position:relative;overflow:hidden;--rf-c:var(--teal);
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-left:2px solid var(--rf-c);border-radius:14px;
    padding:9px 11px 8px;box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);
    animation:rf-notify-in .3s cubic-bezier(.16,1,.3,1);}
  .rf-notify-card.lv-info{--rf-c:var(--c-rare);}
  .rf-notify-card.lv-success{--rf-c:var(--c-uncommon);}
  .rf-notify-card.lv-warn{--rf-c:var(--gold);}
  .rf-notify-card.lv-error,.rf-notify-card.lv-fatal{--rf-c:var(--rose);}
  .rf-notify-card.lv-fatal{border-color:rgba(255,93,122,.5);
    box-shadow:var(--glass-hi),0 0 24px rgba(255,93,122,.24),0 8px 28px rgba(2,8,10,.4);}
  .rf-notify-card.go{opacity:0;transform:translateX(20px);transition:opacity .2s,transform .2s;}
  @keyframes rf-notify-in{from{opacity:0;transform:translateX(26px) scale(.97);}to{opacity:1;transform:none;}}
  .rf-notify-top{display:flex;align-items:baseline;gap:7px;}
  .rf-notify-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--rf-c);
    box-shadow:0 0 8px var(--rf-c);align-self:center;}
  .rf-notify-ico{flex:0 0 auto;display:flex;align-items:center;align-self:center;}
  .rf-notify-title{flex:1;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:1.09em;
    color:var(--ink);line-height:1.25;overflow:hidden;text-overflow:ellipsis;}
  .rf-notify-mult{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:.86em;color:var(--rf-c);
    font-variant-numeric:tabular-nums;display:none;}
  .rf-notify-mult.on{display:inline;}
  .rf-notify-time{font-size:.78em;color:var(--faint);font-variant-numeric:tabular-nums;letter-spacing:.04em;}
  .rf-notify-x{background:none;border:none;color:var(--faint);cursor:pointer;font:inherit;font-size:.92em;
    padding:0 1px;line-height:1;transition:color .12s;}
  .rf-notify-x:hover{color:var(--rose);}
  /* three lines is the most a card may ever be: the rest lives in Details */
  .rf-notify-body{font-size:.94em;line-height:1.45;color:var(--muted);margin:3px 0 0;word-break:break-word;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
  .rf-notify-body:empty{display:none;}
  .rf-notify-where{font-size:.76em;color:var(--faint);letter-spacing:.06em;margin-top:2px;}
  .rf-notify-where:empty{display:none;}
  .rf-notify-acts{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;}
  .rf-notify-b{font-family:"IBM Plex Mono",monospace;font-size:.8em;letter-spacing:.08em;cursor:pointer;
    color:var(--muted);background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:7px;padding:4px 9px;transition:color .12s,border-color .12s;}
  .rf-notify-b:hover{color:var(--ink);border-color:var(--glass-bd);}
  .rf-notify-b.key{color:var(--rf-c);border-color:var(--rf-c);}
  .rf-notify-pre{display:none;margin-top:7px;padding:7px 8px;max-height:132px;overflow:auto;
    background:rgba(2,8,10,.42);border:1px solid var(--glass-bd-soft);border-radius:8px;
    font-family:"IBM Plex Mono",monospace;font-size:.76em;line-height:1.5;color:var(--lab);
    white-space:pre-wrap;word-break:break-word;}
  .rf-notify-card.open .rf-notify-pre{display:block;}
  .rf-notify-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--rf-c);opacity:.5;
    transform-origin:left center;transform:scaleX(1);}
  #rf-notify-more{pointer-events:auto;align-self:flex-end;order:-1;cursor:pointer;font-family:"Chakra Petch",sans-serif;
    font-weight:700;font-size:.85em;letter-spacing:.1em;color:var(--gold);background:var(--glass-hud);
    backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    border:1px solid rgba(255,207,92,.45);border-radius:9px;padding:5px 11px;display:none;
    font-variant-numeric:tabular-nums;}
  #rf-notify-more.on{display:block;}

  #rf-notify-pill{position:fixed;right:12px;bottom:48px;z-index:30;display:none;align-items:center;gap:7px;
    cursor:pointer;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;letter-spacing:.06em;
    color:var(--ink);background:var(--glass-hud);backdrop-filter:blur(12px) saturate(1.5);
    -webkit-backdrop-filter:blur(12px) saturate(1.5);border:1px solid var(--glass-bd-soft);
    border-radius:9px;padding:6px 11px;box-shadow:var(--glass-hi),0 5px 16px rgba(2,8,10,.3);
    font-variant-numeric:tabular-nums;transition:border-color .15s;}
  #rf-notify-pill.on{display:flex;}
  #rf-notify-pill:hover{border-color:var(--rf-c,var(--teal));}
  #rf-notify-pill .pd{width:8px;height:8px;border-radius:50%;background:var(--rf-c,var(--teal));
    box-shadow:0 0 9px var(--rf-c,var(--teal));animation:rf-notify-pulse 2.2s ease-in-out infinite;}
  #rf-notify-pill .pk{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:9px;color:var(--faint);letter-spacing:.2em;}
  @keyframes rf-notify-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}

  #rf-notify-scrim{position:fixed;inset:0;z-index:25;display:none;background:rgba(3,10,12,.4);
    backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}
  #rf-notify-scrim.on{display:block;}
  #rf-notify-drawer{position:fixed;top:0;right:0;bottom:0;z-index:26;width:min(430px,94vw);
    display:flex;flex-direction:column;transform:translateX(102%);transition:transform .3s cubic-bezier(.16,1,.3,1);
    font-size:calc(12px*var(--rf-ui-scale,1));
    background:var(--glass-sheen),var(--glass-strong);backdrop-filter:blur(18px) saturate(1.6);
    -webkit-backdrop-filter:blur(18px) saturate(1.6);border-left:1px solid var(--glass-bd);
    box-shadow:-18px 0 48px rgba(2,8,10,.5);}
  #rf-notify-drawer.on{transform:none;}
  .rf-notify-dhead{display:flex;align-items:center;gap:9px;padding:14px 15px 10px;}
  .rf-notify-dhead h3{flex:1;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:1.45em;color:var(--ink);
    display:flex;align-items:center;gap:8px;}
  .rf-notify-dhead h3 small{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:.5em;
    letter-spacing:.26em;color:var(--faint);}
  .rf-notify-dcounts{display:flex;flex-wrap:wrap;gap:5px;padding:0 15px 9px;}
  .rf-notify-chip{font-size:.76em;letter-spacing:.1em;color:var(--muted);background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-radius:7px;padding:3px 8px;cursor:pointer;
    font-variant-numeric:tabular-nums;transition:color .12s,border-color .12s;}
  .rf-notify-chip:hover{color:var(--ink);}
  .rf-notify-chip.sel{color:var(--ink);border-color:var(--teal);box-shadow:inset 0 0 0 1px rgba(57,215,196,.28);}
  .rf-notify-chip b{font-family:"Chakra Petch",sans-serif;font-weight:700;color:var(--cc,var(--ink));}
  .rf-notify-dtools{padding:0 15px 10px;}
  #rf-notify-search{width:100%;font-family:"IBM Plex Mono",monospace;font-size:1em;color:var(--ink);
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:9px;
    padding:7px 10px;outline:none;}
  #rf-notify-search:focus{border-color:rgba(57,215,196,.6);}
  .rf-notify-dlist{flex:1;overflow-y:auto;padding:0 15px 12px;}
  .rf-notify-dday{font-size:.74em;letter-spacing:.24em;text-transform:uppercase;color:var(--faint);
    margin:12px 0 6px;position:sticky;top:0;background:var(--glass-hud);
    padding:4px 0;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
  .rf-notify-drow{display:flex;align-items:flex-start;gap:8px;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-left:2px solid var(--rf-c,var(--teal));border-radius:10px;
    padding:7px 10px;margin-bottom:5px;cursor:pointer;transition:border-color .12s,background .12s;}
  .rf-notify-drow:hover{background:rgba(255,255,255,.08);}
  .rf-notify-drow.lv-info{--rf-c:var(--c-rare);}.rf-notify-drow.lv-success{--rf-c:var(--c-uncommon);}
  .rf-notify-drow.lv-warn{--rf-c:var(--gold);}.rf-notify-drow.lv-error,.rf-notify-drow.lv-fatal{--rf-c:var(--rose);}
  .rf-notify-drow .rt{font-size:.74em;color:var(--faint);font-variant-numeric:tabular-nums;
    letter-spacing:.02em;flex:0 0 auto;padding-top:2px;}
  .rf-notify-drow .rm{flex:1;min-width:0;display:block;}
  .rf-notify-drow .rh{display:block;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:1em;color:var(--ink);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .rf-notify-drow.open .rh{white-space:normal;}
  .rf-notify-drow .rb{display:block;font-size:.86em;color:var(--muted);line-height:1.45;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;}
  .rf-notify-drow.open .rb{white-space:normal;word-break:break-word;}
  .rf-notify-drow .rx{display:none;margin-top:5px;padding:6px 7px;background:rgba(2,8,10,.42);
    border-radius:7px;font-size:.76em;line-height:1.5;color:var(--lab);white-space:pre-wrap;
    word-break:break-word;max-height:200px;overflow:auto;}
  .rf-notify-drow.open .rx{display:block;}
  .rf-notify-drow .rn{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:.8em;color:var(--rf-c);
    flex:0 0 auto;font-variant-numeric:tabular-nums;}
  .rf-notify-dempty{color:var(--faint);font-size:.95em;text-align:center;padding:26px 10px;line-height:1.7;}
  .rf-notify-dfoot{display:flex;gap:7px;padding:10px 15px 14px;border-top:1px solid var(--glass-bd-soft);}
  .rf-notify-dfoot .rf-notify-b{flex:1;text-align:center;padding:8px 6px;}

  #rf-notify-modal{position:fixed;inset:0;z-index:36;display:none;align-items:center;justify-content:center;
    background:radial-gradient(130% 100% at 50% -10%,rgba(14,26,32,.42),rgba(3,8,10,.68));
    backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);
    font-size:calc(13px*var(--rf-ui-scale,1));}
  #rf-notify-modal.on{display:flex;}
  .rf-notify-mbox{width:min(420px,92vw);background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:18px;padding:20px 22px 17px;
    box-shadow:var(--glass-hi),0 30px 80px rgba(0,0,0,.5);animation:rf-notify-pop .26s cubic-bezier(.16,1,.3,1);}
  @keyframes rf-notify-pop{from{opacity:0;transform:translateY(14px) scale(.97);}to{opacity:1;transform:none;}}
  .rf-notify-mt{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:1.5em;color:var(--ink);line-height:1.2;}
  .rf-notify-mb{font-size:1em;line-height:1.6;color:var(--muted);margin-top:7px;word-break:break-word;}
  .rf-notify-mb:empty{display:none;}
  .rf-notify-mr{display:flex;gap:9px;justify-content:flex-end;margin-top:17px;}
  .rf-notify-mr button{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:1em;letter-spacing:.04em;
    cursor:pointer;border-radius:10px;padding:9px 17px;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--ink);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 2px 6px rgba(2,6,7,.3);transition:border-color .12s,box-shadow .12s;}
  .rf-notify-mr button:hover{border-color:rgba(57,215,196,.6);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px rgba(57,215,196,.2);}
  .rf-notify-mr .ok{border-color:var(--teal);color:var(--teal);}
  .rf-notify-mr .ok.danger{border-color:var(--rose);color:var(--rose);}
  .rf-notify-mr .ok.danger:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px rgba(255,93,122,.28);}

  /* the drawer says everything the stack does, and says it better — stand aside */
  body.rf-notify-open #rf-notify-stack{display:none;}
  /* photo mode is for screenshots — only a real failure is allowed to survive it */
  body.photo #rf-notify-pill,body.capcam #rf-notify-pill{display:none!important;}
  body.photo #rf-notify-more{display:none!important;}
  body.photo #rf-notify-stack .rf-notify-card:not(.lv-error):not(.lv-fatal){display:none!important;}
  body.rf-reduced .rf-notify-card,body.rf-reduced .rf-notify-mbox{animation:none;}
  body.rf-reduced #rf-notify-drawer{transition:none;}
  body.rf-reduced #rf-notify-pill .pd{animation:none;}
  `, 'rf-notify-css');

  /* ======================================================================
     2. DOM
     ====================================================================== */
  const esc = s => String(s).replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const pix = (n, s) => { try { return (RF.PIX && RF.PIX[n] && RF.fn.pixSVG) ? RF.fn.pixSVG(n, s) : ''; } catch (e) { return ''; } };

  const stack = RF.el('<div id="rf-notify-stack" role="status" aria-live="polite"></div>');
  const moreChip = RF.el('<button id="rf-notify-more" type="button"></button>', stack);
  const pill = RF.el('<div id="rf-notify-pill" role="button" tabindex="0" title="Notices · N">' +
    '<span class="pd"></span><span class="pn">0</span><span class="pk">N</span></div>');
  const scrim = RF.el('<div id="rf-notify-scrim"></div>');
  const drawer = RF.el(
    '<div id="rf-notify-drawer" aria-hidden="true">' +
      '<div class="rf-notify-dhead"><h3>' + pix('storm', 17) + 'Notices <small>N</small></h3>' +
        '<button class="rf-notify-b rf-notify-dclose" type="button">CLOSE</button></div>' +
      '<div class="rf-notify-dcounts"></div>' +
      '<div class="rf-notify-dtools"><input id="rf-notify-search" type="text" placeholder="search notices…" maxlength="60" spellcheck="false"></div>' +
      '<div class="rf-notify-dlist"></div>' +
      '<div class="rf-notify-dfoot">' +
        '<button class="rf-notify-b rf-notify-ddiag" type="button">COPY DIAGNOSTICS</button>' +
        '<button class="rf-notify-b rf-notify-dclear" type="button">CLEAR</button></div>' +
    '</div>');
  const modal = RF.el('<div id="rf-notify-modal" aria-hidden="true"><div class="rf-notify-mbox" role="dialog" aria-modal="true">' +
    '<div class="rf-notify-mt"></div><div class="rf-notify-mb"></div>' +
    '<div class="rf-notify-mr"><button type="button" class="cancel"></button><button type="button" class="ok"></button></div>' +
    '</div></div>');

  if (!stack || !moreChip || !pill || !drawer || !modal) return;   // nothing to hang off
  const dCounts = drawer.querySelector('.rf-notify-dcounts'), dList = drawer.querySelector('.rf-notify-dlist');
  const searchEl = drawer.querySelector('#rf-notify-search');
  const pillN = pill.querySelector('.pn');
  const mTitle = modal.querySelector('.rf-notify-mt'), mBody = modal.querySelector('.rf-notify-mb');
  const mOk = modal.querySelector('.ok'), mCancel = modal.querySelector('.cancel');

  /* ======================================================================
     3. STATE
     ====================================================================== */
  const log = [];                       // history, newest last
  const live = [];                      // cards on screen
  const queue = [];                     // waiting for a slot
  const byTag = Object.create(null);    // tag -> card, so a card can be replaced
  const pool = [];                      // recycled card elements
  const COL = { info: 'var(--c-rare)', success: 'var(--c-uncommon)', warn: 'var(--gold)',
    error: 'var(--rose)', fatal: 'var(--rose)' };
  let seq = 0, unread = 0, unreadTop = 'info', drawerOpen = false, filter = 'all', lastSfx = 0;
  let recDepth = 0, softDepth = 0, replaying = false;   // funnel re-entry guards
  const prefs = RF.store.get('00-notify', null) || {};
  if (prefs.filter && (prefs.filter === 'all' || RANK[prefs.filter] !== undefined)) filter = prefs.filter;

  /* RF.err re-enters this mod through the 'error' hook; a failure raised while we
     are already reporting one must never loop back in. */
  function soft(where, e) { if (softDepth) return; softDepth++;
    try { RF.err(where, e, 'warn'); } catch (_) {} finally { softDepth--; } }

  const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000) | 0;
    if (s < 5) return 'now'; if (s < 60) return s + 's';
    const m = (s / 60) | 0; if (m < 60) return m + 'm';
    const h = (m / 60) | 0; if (h < 24) return h + 'h'; return ((h / 24) | 0) + 'd'; };
  const hhmm = t => { const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0'); };
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function dayLabel(t) { const now = new Date(), d = new Date(t);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(now, d)) return 'Today';
    const y = new Date(now.getTime() - 864e5); if (same(y, d)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

  /* ======================================================================
     4. SOUND — one voice per level, never more than one per SFX_GAP
     ====================================================================== */
  function blip(level) {
    if (replaying || RF.muted || RANK[level] === undefined || level === 'info') return;
    const now = Date.now(); if (now - lastSfx < SFX_GAP) return; lastSfx = now;
    const f = RF.fn; if (!f || !f.beep) return;
    try {
      if (level === 'success') { f.beep(620, .09, 'sine', .045); setTimeout(() => f.beep(930, .11, 'sine', .038), 78); }
      else if (level === 'warn') { f.beep(300, .09, 'triangle', .05); setTimeout(() => f.beep(300, .1, 'triangle', .045), 132); }
      else { f.beep(138, .26, 'sawtooth', .05); if (f.nz) f.nz(.18, 380, .028, { q: .8, to: 160 });
        if (level === 'fatal') setTimeout(() => f.beep(104, .34, 'sawtooth', .05), 230); }
    } catch (e) { soft('notify:sfx', e); }
  }

  /* ======================================================================
     5. CARDS
     ====================================================================== */
  function buildCard() {
    const el = document.createElement('div');
    el.className = 'rf-notify-card';
    el.innerHTML = '<div class="rf-notify-top"><span class="rf-notify-dot"></span><span class="rf-notify-ico"></span>' +
      '<span class="rf-notify-title"></span><span class="rf-notify-mult"></span><span class="rf-notify-time"></span>' +
      '<button class="rf-notify-x" type="button" title="Dismiss" aria-label="Dismiss">✕</button></div>' +
      '<div class="rf-notify-body"></div><div class="rf-notify-where"></div>' +
      '<div class="rf-notify-acts"></div><pre class="rf-notify-pre"></pre><div class="rf-notify-bar"></div>';
    el._n = { dot: el.querySelector('.rf-notify-dot'), ico: el.querySelector('.rf-notify-ico'),
      title: el.querySelector('.rf-notify-title'), mult: el.querySelector('.rf-notify-mult'),
      time: el.querySelector('.rf-notify-time'), body: el.querySelector('.rf-notify-body'),
      where: el.querySelector('.rf-notify-where'), acts: el.querySelector('.rf-notify-acts'),
      pre: el.querySelector('.rf-notify-pre'), bar: el.querySelector('.rf-notify-bar'), x: el.querySelector('.rf-notify-x') };
    return el;
  }
  const takeCard = () => pool.pop() || buildCard();
  function freeCard(el) {
    el.className = 'rf-notify-card'; el.style.display = '';
    el._n.acts.innerHTML = ''; el._n.pre.textContent = ''; el._n.ico.innerHTML = '';
    el._n.mult.className = 'rf-notify-mult'; el._n.bar.style.transform = 'scaleX(1)';
    el.onmouseenter = el.onmouseleave = null; el._n.x.onclick = null;
    if (pool.length < 6) pool.push(el);
  }

  function normalize(o) {
    if (typeof o === 'string') o = { title: o };
    o = (o && typeof o === 'object') ? o : {};
    const lv = RANK[o.level] !== undefined ? o.level : 'info';
    let acts = [];
    if (Array.isArray(o.actions)) acts = o.actions.slice(0, 3)
      .filter(a => a && typeof a.fn === 'function').map(a => ({ label: clip(a.label || 'Do it', 22), fn: a.fn, key: !!a.key }));
    return { level: lv, title: clip(o.title != null ? o.title : 'Notice', 88),
      body: clip(o.body, 260), where: clip(o.where, 90),
      details: String(o.details == null ? '' : o.details).slice(0, 4000),
      tag: o.tag ? String(o.tag).slice(0, 40) : '',
      ttl: (typeof o.ttl === 'number' && isFinite(o.ttl)) ? Math.max(0, o.ttl | 0) : TTL[lv],
      icon: (o.icon && RF.PIX && RF.PIX[o.icon]) ? o.icon : '',
      retry: typeof o.retry === 'function' ? o.retry : null, actions: acts };
  }

  function paint(c) {
    const n = c.el._n;
    c.el.className = 'rf-notify-card lv-' + c.level + (c.open ? ' open' : '');
    n.title.textContent = c.title;
    n.body.textContent = c.body;
    n.where.textContent = c.where;
    n.mult.textContent = '×' + c.count;
    n.mult.className = 'rf-notify-mult' + (c.count > 1 ? ' on' : '');
    n.time.textContent = ago(c.t);
    n.ico.innerHTML = c.icon ? pix(c.icon, 15) : '';
    n.pre.textContent = detailText(c);
    n.bar.style.display = c.ttl ? '' : 'none';   // a sticky card has nothing to count down
    n.acts.innerHTML = '';
    const btn = (label, key, fn) => { const b = document.createElement('button');
      b.type = 'button'; b.className = 'rf-notify-b' + (key ? ' key' : ''); b.textContent = label;
      b.onclick = ev => { ev.stopPropagation(); try { fn(); } catch (e) { soft('notify:action', e); } };
      n.acts.appendChild(b); return b; };
    for (const a of c.actions) btn(a.label, a.key, () => { a.fn(c.handle); });
    if (c.retry) btn('Retry', true, () => doRetry(c));
    btn('Copy', false, () => copyCard(c));
    if (n.pre.textContent) btn(c.open ? 'Hide' : 'Details', false, () => { c.open = !c.open; paint(c); });
  }

  function detailText(c) {
    const bits = [];
    if (c.where) bits.push('where  ' + c.where);
    bits.push('when   ' + hhmm(c.t) + (c.count > 1 ? '  (×' + c.count + ')' : ''));
    if (c.details) bits.push('', c.details);
    return c.details || c.where ? bits.join('\n') : '';
  }

  function mount(c) {
    c.el = takeCard();
    c.el._n.x.onclick = () => close(c);
    c.el.onmouseenter = () => { c.hover = true; };
    c.el.onmouseleave = () => { c.hover = false; };
    paint(c);
    stack.insertBefore(c.el, moreChip.nextSibling);   // the chip keeps the top slot
    live.push(c);
    trimStack();
  }

  /* Four cards need roughly 460px of rail; a 640px-tall window has 454 below the
     HUD, so it shows three. Anything that does not fit waits behind the chip. */
  const capNow = () => innerHeight < 700 ? 3 : MAXCARDS;

  /* Never let a storm push the game off screen: extra cards wait behind the chip. */
  function trimStack() {
    let guard = MAXCARDS + 2;
    while (live.length > capNow() && guard-- > 0) { close(live.find(x => RANK[x.level] < 3) || live[0], true); }
    moreChip.textContent = '+' + queue.length + ' more';
    moreChip.classList.toggle('on', queue.length > 0);
  }
  /* the rail grows and shrinks with the window; cards follow it either way */
  addEventListener('resize', () => { try { trimStack(); pump(); } catch (e) {} });

  function close(c, silent) {
    if (c.dead) return; c.dead = true;
    const i = live.indexOf(c); if (i >= 0) live.splice(i, 1);
    if (c.tag && byTag[c.tag] === c) delete byTag[c.tag];
    const el = c.el; c.el = null;
    if (el) { el.classList.add('go');
      setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el); freeCard(el); } catch (e) {} }, 210); }
    if (!silent) pump();
    else trimStack();
  }

  /* Promote whatever has been waiting the longest. */
  function pump() {
    while (live.length < capNow() && queue.length) { const c = queue.shift(); if (!c.dead) mount(c); }
    trimStack();
  }

  function bump(c) {                       // a repeat of something already on screen
    c.count++; c.t = Date.now(); c.life = c.ttl;
    if (c.rec) { c.rec.count = c.count; c.rec.t = c.t; }
    if (c.el) paint(c);
    if (drawerOpen) renderList();
  }

  function notify(opts) {
    const o = normalize(opts);
    const now = Date.now();

    if (o.tag && byTag[o.tag]) {           // tagged notices replace, they never stack
      const c = byTag[o.tag];
      c.count = (c.title === o.title && c.body === o.body) ? c.count + 1 : 1;
      if (c.rec) c.rec.count = c.count;
      c.level = o.level; c.title = o.title; c.body = o.body; c.where = o.where;
      c.details = o.details; c.icon = o.icon; c.ttl = o.ttl; c.life = o.ttl;
      c.retry = o.retry; c.actions = o.actions; c.t = now;
      if (c.rec) { c.rec.level = o.level; c.rec.title = o.title; c.rec.body = o.body;
        c.rec.details = o.details; c.rec.t = now; }
      if (c.el) paint(c);
      markUnread(o.level); if (drawerOpen) renderList();
      return c.handle;
    }
    for (const c of live) {                // identical inside 20s = one card, ×N
      if (c.level === o.level && c.title === o.title && c.body === o.body && now - c.t < DEDUP_MS) { bump(c); return c.handle; }
    }
    for (const c of queue) {
      if (c.level === o.level && c.title === o.title && c.body === o.body && now - c.t < DEDUP_MS) { bump(c); return c.handle; }
    }

    const c = { id: ++seq, t: now, level: o.level, title: o.title, body: o.body, where: o.where,
      details: o.details, icon: o.icon, tag: o.tag, ttl: o.ttl, life: o.ttl, count: 1,
      retry: o.retry, actions: o.actions, el: null, hover: false, open: false, dead: false };
    c.rec = { id: c.id, t: now, level: c.level, title: c.title, body: c.body, where: c.where,
      details: c.details, count: 1 };
    log.push(c.rec); if (log.length > LOGCAP) log.shift();
    if (c.tag) byTag[c.tag] = c;           // addressable even while it waits in the queue

    c.handle = { id: c.id,
      update(patch) { try { if (c.dead) return c.handle;
          const p = normalize(Object.assign({ level: c.level, title: c.title, body: c.body,
            where: c.where, details: c.details, ttl: c.ttl, icon: c.icon }, patch || {}));
          c.level = p.level; c.title = p.title; c.body = p.body; c.where = p.where;
          c.details = p.details; c.icon = p.icon; c.ttl = p.ttl; c.life = p.ttl;
          if (patch && 'retry' in patch) c.retry = p.retry;
          if (patch && 'actions' in patch) c.actions = p.actions;
          Object.assign(c.rec, { level: c.level, title: c.title, body: c.body, where: c.where, details: c.details });
          if (c.el) paint(c); if (drawerOpen) renderList();
        } catch (e) { soft('notify:update', e); } return c.handle; },
      close() { try { close(c); } catch (e) { soft('notify:close', e); } } };

    if (live.length < capNow()) mount(c);
    else {
      /* A real failure never waits behind chatter: the dullest card that was
         going to dismiss itself anyway gives up its slot. Only chatter is
         evicted — an error or fatal on screen keeps its place. */
      let victim = null;
      for (const l of live) if (l.ttl && RANK[l.level] < RANK[c.level] &&
        (!victim || RANK[l.level] < RANK[victim.level] || (RANK[l.level] === RANK[victim.level] && l.t < victim.t))) victim = l;
      if (victim) { close(victim, true); mount(c); }
      else { queue.push(c); if (queue.length > MAXQUEUE) queue.shift(); trimStack(); }
    }
    markUnread(o.level);
    blip(o.level);
    if (drawerOpen) renderList();
    return c.handle;
  }

  function markUnread(level) {
    if (drawerOpen) { renderCounts(); return; }
    unread++;
    if (RANK[level] > RANK[unreadTop]) unreadTop = level;
    pillN.textContent = unread > 99 ? '99+' : String(unread);
    pill.style.setProperty('--rf-c', COL[unreadTop]);
    pill.classList.add('on');
  }
  function clearUnread() { unread = 0; unreadTop = 'info'; pill.classList.remove('on'); }

  /* ---- the 250 ms heartbeat. Deliberately NOT on the frame hook: when the
     render loop is the thing that died, these cards still have to behave. ---- */
  setInterval(function () {
    try {
      for (let i = live.length - 1; i >= 0; i--) {
        const c = live[i];
        if (c.el) c.el._n.time.textContent = ago(c.t);
        if (!c.ttl || c.hover || c.dead) continue;   // hovering freezes the bar where it stands
        c.life -= 250;
        if (c.el) c.el._n.bar.style.transform = 'scaleX(' + Math.max(0, c.life / c.ttl).toFixed(3) + ')';
        if (c.life <= 0) close(c);
      }
    } catch (e) { soft('notify:tick', e); }
  }, 250);

  /* ======================================================================
     6. COPY — clipboard with a file:// fallback
     ====================================================================== */
  const copied = (ok, okMsg) => flash(ok ? okMsg : 'Copy blocked · open Details and select it by hand',
    ok ? 'success' : 'warn');
  function copyText(text, okMsg) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => copied(true, okMsg),
          () => copied(legacyCopy(text), okMsg));
        return; } } catch (e) {}
    copied(legacyCopy(text), okMsg);       // file:// usually refuses the async API outright
  }
  function legacyCopy(text) {              // file:// often refuses the async API
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-2000px;top:0;opacity:0;';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }
  function flash(msg, level) { notify({ level: level || 'success', title: msg, ttl: 2600, tag: 'rf-copy' }); }

  function copyCard(c) {
    const lines = ['Reel Fortune 3D · ' + LNAME[c.level],
      c.title + (c.body ? ' · ' + c.body : ''),
      'when   ' + new Date(c.t).toISOString() + (c.count > 1 ? '  (×' + c.count + ')' : '')];
    if (c.where) lines.push('where  ' + c.where);
    lines.push('build  RF v' + RF.version + ' · world ' + safeWorld() + ' · ' + (RF.online ? 'online' : 'offline'));
    if (c.details) lines.push('', c.details);
    copyText(lines.join('\n'), 'Report copied');
  }

  const safeWorld = () => { try { return RF.worldKey + (RF.WORLD ? ' (' + RF.WORLD.name + ')' : ''); } catch (e) { return '?'; } };

  function glRenderer() {
    try {
      const r = RF.renderer; if (!r || !r.getContext) return 'unknown';
      const gl = r.getContext(); if (!gl) return 'no context';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return String(gl.getParameter(gl.VERSION) || 'masked');
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'masked');
    } catch (e) { return 'unavailable'; }
  }

  function diagnostics() {
    const L = [];
    L.push('Reel Fortune 3D · diagnostics report');
    L.push('generated  ' + new Date().toISOString());
    L.push('build      RF host v' + RF.version + ' · three ' + ((RF.THREE && RF.THREE.REVISION) ? 'r' + RF.THREE.REVISION : '?'));
    L.push('world      ' + safeWorld() + ' · weather ' + RF.weather + ' · day ' + RF.dayCount);
    L.push('session    ' + (RF.running ? 'playing' : 'title screen') + ' · ' + (RF.online ? 'ONLINE' : 'offline') +
      (window.RFNet && RFNet.user ? ' as ' + RFNet.user : '') + ' · net ' + (navigator.onLine === false ? 'down' : 'up'));
    L.push('page       ' + location.href.slice(0, 200));
    L.push('agent      ' + navigator.userAgent);
    L.push('screen     ' + screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) +
      ' · window ' + innerWidth + 'x' + innerHeight);
    L.push('webgl      ' + glRenderer());
    L.push('storage    ' + (storageOK ? 'ok' : 'UNAVAILABLE · progress is not being saved'));
    L.push('quality    ' + (document.body.dataset.rfQuality || 'high') +
      (document.body.classList.contains('rf-reduced') ? ' · reduced motion' : ''));
    L.push('');
    const names = RF.order || [];
    L.push('mods (' + names.length + ')');
    for (const nm of names) { const m = RF.mods[nm];
      L.push('  ' + (nm + '            ').slice(0, 13) + (m && m.ok ? 'ok' : 'FAILED · ' + errMsg(m && m.error))); }
    L.push('');
    const errs = (RF.errors || []).slice(-50);
    L.push('errors (' + errs.length + ' of ' + (RF.errors ? RF.errors.length : 0) + ')');
    if (!errs.length) L.push('  none');
    for (const r of errs) {
      L.push('  [' + hhmm(r.t) + '] ' + (r.level || 'error') + ' · ' + r.where + ' · ' + r.msg);
      if (r.stack) L.push('      ' + String(r.stack).split('\n').slice(0, 4).join('\n      '));
    }
    L.push('');
    L.push('notices (' + log.length + ')');
    for (const r of log.slice(-40)) L.push('  [' + hhmm(r.t) + '] ' + r.level + ' · ' + r.title + (r.body ? ' · ' + r.body : '') + (r.count > 1 ? ' ×' + r.count : ''));
    return L.join('\n');
  }
  const errMsg = e => e ? String((e && e.message) || e).slice(0, 160) : 'unknown';

  /* ======================================================================
     7. DRAWER
     ====================================================================== */
  function renderCounts() {
    const n = { all: log.length, info: 0, success: 0, warn: 0, error: 0, fatal: 0 };
    for (const r of log) n[r.level] = (n[r.level] || 0) + 1;
    let h = '';
    for (const k of ['all', 'error', 'fatal', 'warn', 'success', 'info']) {
      if (k !== 'all' && !n[k]) continue;
      h += '<button type="button" class="rf-notify-chip' + (filter === k ? ' sel' : '') + '" data-f="' + k +
        '" style="--cc:' + (k === 'all' ? 'var(--ink)' : COL[k]) + '">' +
        (k === 'all' ? 'ALL' : LNAME[k]) + ' <b>' + n[k] + '</b></button>';
    }
    dCounts.innerHTML = h;
  }

  function renderList() {
    renderCounts();
    const q = searchEl.value.trim().toLowerCase();
    const rows = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const r = log[i];
      if (filter !== 'all' && r.level !== filter) continue;
      if (q && (r.title + ' ' + r.body + ' ' + (r.where || '') + ' ' + (r.details || '')).toLowerCase().indexOf(q) < 0) continue;
      rows.push(r);
    }
    if (!rows.length) {
      dList.innerHTML = '<div class="rf-notify-dempty">' + (log.length ? 'Nothing matches that filter.' :
        'Nothing has gone wrong yet.<br><span style="color:var(--faint);font-size:.9em">Errors, failed loads and rejected server actions will collect here.</span>') + '</div>';
      return;
    }
    let h = '', day = '';
    for (const r of rows) {
      const k = dayKey(r.t);
      if (k !== day) { day = k; h += '<div class="rf-notify-dday">' + esc(dayLabel(r.t)) + '</div>'; }
      const detail = [r.where ? 'where  ' + r.where : '', r.details || ''].filter(Boolean).join('\n');
      h += '<div class="rf-notify-drow lv-' + r.level + '" data-id="' + r.id + '">' +
        '<span class="rt">' + hhmm(r.t) + '</span><span class="rm">' +
        '<span class="rh">' + esc(r.title) + '</span>' +
        (r.body ? '<span class="rb">' + esc(r.body) + '</span>' : '') +
        (detail ? '<div class="rx">' + esc(detail) + '</div>' : '') +
        '</span>' + (r.count > 1 ? '<span class="rn">×' + r.count + '</span>' : '') + '</div>';
    }
    dList.innerHTML = h;
  }

  function openDrawer() {
    if (drawerOpen) return; drawerOpen = true;
    drawer.classList.add('on'); drawer.setAttribute('aria-hidden', 'false');
    scrim.classList.add('on'); document.body.classList.add('rf-notify-open');
    clearUnread(); renderList();
  }
  function closeDrawer() {
    if (!drawerOpen) return; drawerOpen = false;
    drawer.classList.remove('on'); drawer.setAttribute('aria-hidden', 'true');
    scrim.classList.remove('on'); document.body.classList.remove('rf-notify-open');
    try { searchEl.blur(); } catch (e) {}
  }
  const toggleDrawer = () => drawerOpen ? closeDrawer() : openDrawer();

  pill.onclick = openDrawer;
  pill.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(); } };
  moreChip.onclick = openDrawer;
  scrim.onclick = closeDrawer;
  drawer.querySelector('.rf-notify-dclose').onclick = closeDrawer;
  dCounts.onclick = e => { const b = e.target.closest('.rf-notify-chip'); if (!b) return;
    filter = b.getAttribute('data-f'); prefs.filter = filter; saveP(); renderList(); };
  dList.onclick = e => { const row = e.target.closest('.rf-notify-drow'); if (row) row.classList.toggle('open'); };
  searchEl.oninput = () => { try { renderList(); } catch (err) { soft('notify:search', err); } };
  drawer.querySelector('.rf-notify-ddiag').onclick = () => copyText(diagnostics(), 'Diagnostics copied · paste it when asking for help');
  drawer.querySelector('.rf-notify-dclear').onclick = () => {
    confirmBox({ title: 'Clear the notice history?', body: 'The ' + log.length + ' entries listed here are removed. Nothing else changes.',
      ok: 'Clear', danger: true }).then(yes => { if (!yes) return;
        log.length = 0; renderList(); notify({ level: 'info', title: 'History cleared', ttl: 2600 }); });
  };

  /* ======================================================================
     8. CONFIRM — the only in-game modal; window.confirm is forbidden
     ====================================================================== */
  const mQueue = []; let mCur = null, mPrevFocus = null;

  function confirmBox(opts) {
    return new Promise(resolve => {
      const o = (opts && typeof opts === 'object') ? opts : {};
      mQueue.push({ title: clip(o.title || 'Are you sure?', 90), body: clip(o.body, 260),
        ok: clip(o.ok || 'Confirm', 20), cancel: clip(o.cancel || 'Cancel', 20),
        danger: !!o.danger, resolve: resolve });
      if (!mCur) nextModal();
    });
  }
  function nextModal() {
    mCur = mQueue.shift(); if (!mCur) { modal.classList.remove('on'); modal.setAttribute('aria-hidden', 'true'); return; }
    mTitle.textContent = mCur.title; mBody.textContent = mCur.body;
    mOk.textContent = mCur.ok; mCancel.textContent = mCur.cancel;
    mOk.className = 'ok' + (mCur.danger ? ' danger' : '');
    modal.classList.add('on'); modal.setAttribute('aria-hidden', 'false');
    mPrevFocus = document.activeElement;
    try { mOk.focus(); } catch (e) {}
  }
  function settle(v) {
    if (!mCur) return;
    const cur = mCur; mCur = null;
    try { cur.resolve(!!v); } catch (e) { soft('notify:confirm', e); }
    modal.classList.remove('on'); modal.setAttribute('aria-hidden', 'true');
    try { if (mPrevFocus && mPrevFocus.focus && document.contains(mPrevFocus)) mPrevFocus.focus(); } catch (e) {}
    mPrevFocus = null;
    if (mQueue.length) setTimeout(nextModal, 60);
  }
  mOk.onclick = () => settle(true);
  mCancel.onclick = () => settle(false);
  modal.onmousedown = e => { if (e.target === modal) settle(false); };

  /* ======================================================================
     9. KEYS — N opens the history; the modal owns the keyboard while it is up
     ====================================================================== */
  RF.on('keydown', e => {
    if (mCur) {                            // focus trap: nothing behind the modal may act
      if (e.code === 'Escape') { e.preventDefault(); settle(false); }
      else if (e.code === 'Enter') { e.preventDefault(); settle(true); }
      else if (e.code === 'Tab') { e.preventDefault();
        try { (document.activeElement === mOk ? mCancel : mOk).focus(); } catch (err) {} }
      return true;
    }
    const a = document.activeElement;
    if (a === searchEl) {                  // core preventDefaults WASD — typing has to win
      if (e.code === 'Escape') { e.preventDefault(); searchEl.blur(); }
      return true;
    }
    if (RF.chatOpen || (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable))) return;
    if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !e.altKey && (!RF.panelOpen || drawerOpen)) {
      e.preventDefault(); toggleDrawer(); return true; }
    if (e.code === 'Escape' && drawerOpen) { e.preventDefault(); closeDrawer(); return true; }
  }, -50);

  /* ======================================================================
     10. CAPTURE — every channel the browser gives us
     ====================================================================== */
  const shortURL = u => { u = String(u || ''); const q = u.indexOf('?'); if (q > 0) u = u.slice(0, q);
    if (u.length < 60) return u;
    const parts = u.split('/'); return parts.slice(-2).join('/') || u.slice(-58); };

  /* Resource failures arrive as an error event on the ELEMENT, with no .error and
     a target that is a tag — they only reach us with capture:true. A missing script
     is by far the most common way this game breaks for a player. */
  addEventListener('error', function (ev) {
    try {
      const t = ev && ev.target;
      if (t && t !== window && t.tagName) {
        const tag = t.tagName.toLowerCase();
        const url = t.src || t.href || '';
        const font = /fonts\.(googleapis|gstatic)\.com/.test(url);
        if (font) { notify({ level: 'warn', title: 'Web fonts unavailable', tag: 'rf-font',
          body: 'No connection to the font host · the game falls back to system type.',
          where: 'load:' + tag, details: url, ttl: 7000 }); return; }
        notify({ level: tag === 'script' ? 'fatal' : 'error',
          title: 'Failed to load ' + shortURL(url),
          body: tag === 'script' ? 'A script the game needs did not arrive. Reload, and check the folder still contains it.'
              : 'A ' + tag + ' the page asked for did not arrive.',
          where: 'load:' + tag, details: url,
          actions: [{ label: 'Reload', key: true, fn: () => location.reload() }] });
        return;
      }
      const err = ev && ev.error;
      notify({ level: 'error', title: 'Unexpected error',
        body: clip((err && err.message) || (ev && ev.message) || 'unknown', 220),
        where: shortURL(ev && ev.filename) + ((ev && ev.lineno) ? ':' + ev.lineno : ''),
        details: (err && err.stack) || '' });
    } catch (e) {}
  }, true);

  addEventListener('unhandledrejection', function (ev) {
    try {
      const r = ev && ev.reason;
      notify({ level: 'error', title: 'Unfinished background task',
        body: clip((r && r.message) || (typeof r === 'string' ? r : '') || 'a promise was rejected with no handler', 220),
        where: 'promise', details: (r && r.stack) || '' });
    } catch (e) {}
  });

  /* ---- the core funnel. RF.err calls us directly, so we must never throw ---- */
  const WHERE_TITLE = { frame: 'Render loop error', boot: 'Startup failure', save: 'Save failed',
    'notify:tick': 'Notice centre error' };
  let lastFail = { name: '', t: 0 };

  function onErrRec(rec, replay) {
    if (recDepth) return; recDepth++;
    try {
      if (!rec) return;
      const w = String(rec.where || '?');
      /* SRV.act fires 'actionfail' first and RF.err straight after — one rejection,
         one card. The richer actionfail card already covered this. */
      if (w.indexOf('action:') === 0 && lastFail.name === w.slice(7) && Date.now() - lastFail.t < 3000) return;
      const lv = rec.level === 'warn' ? 'warn' : rec.level === 'fatal' ? 'fatal' : 'error';
      const title = WHERE_TITLE[w] || (lv === 'warn' ? 'Warning · ' + w : 'Error · ' + w);
      const o = { level: lv, title: title, body: rec.msg, where: w, details: rec.stack || '' };
      if (replay) { o.ttl = lv === 'warn' ? 9000 : 0; }
      if (w === 'frame') { o.body = rec.msg; o.tag = 'rf-frame';
        o.actions = [{ label: 'Reload', key: true, fn: () => location.reload() }]; }
      const h = notify(o);
      if (replay && h && h.id) { /* replayed history keeps its original timestamp */
        const r = log[log.length - 1]; if (r && r.id === h.id) { r.t = rec.t; }
      }
    } catch (e) {} finally { recDepth--; }
  }
  RF.on('error', onErrRec);

  /* Anything the funnel caught before this file parsed is still in the ring buffer. */
  try { replaying = true; const pre = (RF.errors || []).slice();
    for (let i = 0; i < pre.length; i++) onErrRec(pre[i], true); } catch (e) {} finally { replaying = false; }

  /* ---- WebGL: a lost context is a frozen game with no message today ---- */
  try {
    const cv = RF.renderer && RF.renderer.domElement;
    if (cv && cv.addEventListener) {
      cv.addEventListener('webglcontextlost', function (ev) {
        try { ev.preventDefault();          // without this the context can never come back
          notify({ level: 'fatal', tag: 'rf-webgl', title: 'Graphics context lost',
            body: 'The GPU dropped this page. The world is frozen until it comes back · close other heavy tabs, or reload.',
            where: 'webgl', ttl: 0,
            actions: [{ label: 'Reload', key: true, fn: () => location.reload() }] });
        } catch (e) {}
      }, false);
      cv.addEventListener('webglcontextrestored', function () {
        try { notify({ level: 'success', tag: 'rf-webgl', title: 'Graphics restored',
          body: 'The GPU handed the page back · if the world still looks wrong, reload.', ttl: 6000 });
        } catch (e) {}
      }, false);
    }
  } catch (e) { soft('notify:webgl', e); }

  /* ---- rejected server actions ---- */
  const HTTP = {
    0:   ['Server unreachable', 'No answer from the server · you are playing offline until it returns.', true, 'warn'],
    401: ['Session expired', 'The server no longer recognises this sign-in · reload and sign in again.', false, 'error'],
    403: ['Action refused', 'The server would not allow that · it may have changed while you were away.', false, 'error'],
    404: ['Unknown action', 'The server does not know that action · this client may be out of date.', false, 'error'],
    409: ['Out of step', 'The server had a different idea of your state · it has been resynced.', true, 'warn'],
    413: ['Too much at once', 'That request was larger than the server accepts.', false, 'error'],
    429: ['Too fast', 'The server is rate-limiting you · wait a beat and try again.', true, 'warn'],
    500: ['Server trouble', 'The server hit an error on its side · it usually clears in a moment.', true, 'error'],
    502: ['Server unavailable', 'The gateway in front of the server is not answering.', true, 'error'],
    503: ['Server busy', 'The server is temporarily unavailable · try again shortly.', true, 'error'],
    504: ['Server timed out', 'The server took too long to answer.', true, 'error']
  };
  function httpInfo(status) {
    if (HTTP[status]) return HTTP[status];
    if (status >= 500) return HTTP[500];
    if (status >= 400) return ['Request refused', 'The server rejected that action (HTTP ' + status + ').', false, 'error'];
    return HTTP[0];
  }

  RF.on('actionfail', function (ev) {
    try {
      if (!ev) return;
      ev.handled = true;                   // core's plain toast is not needed any more
      const st = (ev.status | 0) || 0;
      const info = httpInfo(st);
      lastFail = { name: String(ev.action || ''), t: Date.now() };
      const msg = (ev.error && ev.error.message) || '';
      const o = { level: info[3], title: info[0], tag: 'rf-act-' + ev.action,
        body: info[1], where: 'action:' + ev.action + (st ? ' · HTTP ' + st : ' · no reply'),
        details: 'action  ' + ev.action + '\nstatus  ' + (st || 'network') + '\nserver  ' + (msg || '(none)') +
          '\nbody    ' + safeJSON(ev.body),
        ttl: info[3] === 'warn' ? 9000 : 0 };
      if (info[2] && RF.SRV) o.retry = () => RF.SRV.act(ev.action, ev.body);
      notify(o);
    } catch (e) {}
  });

  function safeJSON(v) { try { return clip(JSON.stringify(v), 180) || '{}'; } catch (e) { return '(unserialisable)'; } }

  function doRetry(c) {
    if (!c.retry) return;
    const fn = c.retry; c.retry = null;
    c.handle.update({ body: 'Retrying…' });
    let p; try { p = fn(); } catch (e) { c.handle.update({ level: 'error', body: 'Retry could not start · ' + errMsg(e) }); return; }
    if (!p || typeof p.then !== 'function') { close(c); return; }
    p.then(r => {
      if (c.dead) return;
      if (r === null || r === undefined) c.handle.update({ level: 'warn', body: 'The retry did not go through · the game is still offline or busy.', ttl: 8000 });
      else c.handle.update({ level: 'success', title: 'Retry succeeded', body: 'The server accepted it the second time.', ttl: 4500 });
    }, e => { if (!c.dead) c.handle.update({ level: 'error', body: 'Retry failed · ' + errMsg(e) }); });
  }

  /* ---- storage: if this is broken the player is playing for nothing ---- */
  let storageOK = true, storageCard = null;
  function probeStore() {                  // RF.store swallows failures, so prove it round-trips
    const t = Date.now() + ':' + Math.random();
    prefs.probe = t; RF.store.set('00-notify', prefs);
    const back = RF.store.get('00-notify', null);
    return !!(back && back.probe === t);
  }
  const saveP = () => { try { prefs.probe = 0; RF.store.set('00-notify', prefs); } catch (e) {} };

  function storageCheck(first) {
    let ok; try { ok = probeStore(); } catch (e) { ok = false; }
    if (ok === storageOK && !first) return;
    storageOK = ok;
    if (!ok) {
      storageCard = notify({ level: 'error', tag: 'rf-storage', title: 'Progress is not being saved',
        body: RF.online ? 'This browser is refusing local storage · your account is safe on the server, but settings will not stick.'
                        : 'This browser is refusing local storage · nothing you do this session will survive a reload.',
        where: 'localStorage', ttl: 0,
        details: 'Private browsing, a full disk quota or a blocked-cookies setting all cause this.\n' +
                 'Try a normal window, allow site data for this page, or free some space.' });
    } else if (!first && storageCard) { storageCard.close(); storageCard = null;
      notify({ level: 'success', title: 'Saving again', body: 'Local storage came back · progress is being written.', ttl: 4500 }); }
  }

  /* The canary above proves storage accepts a tiny write; a quota that is merely
     FULL still fails on the real save, so check the game's own key landed too. */
  let saveWarned = false;
  function saveCheck() {
    if (RF.online || !RF.running || !storageOK || saveWarned) return;
    const s = RF.state && RF.state.stats;
    if (!s || (s.caught + s.mined + s.wood) <= 0) return;
    let present = false;
    try { present = !!localStorage.getItem(RF.SAVE); } catch (e) { present = false; }
    if (present) return;
    saveWarned = true;
    notify({ level: 'error', tag: 'rf-save', title: 'Your save is not landing', ttl: 0,
      body: 'You have been working the isle this session, but nothing has reached the disk.',
      where: 'save', details: 'key     ' + RF.SAVE + '\nreason  storage is most likely full.\n' +
        'Free some browser storage for this page, or sign in so the server keeps your island.' });
  }

  /* ---- the network came and went ---- */
  addEventListener('offline', () => { try {
    notify({ level: 'warn', tag: 'rf-net', title: 'Connection lost',
      body: RF.online ? 'The server cannot be reached · the island keeps playing, actions will not save until it returns.'
                      : 'You are offline · the island plays exactly the same.', ttl: 9000, where: 'network' });
  } catch (e) {} });
  addEventListener('online', () => { try {
    notify({ level: 'success', tag: 'rf-net', title: 'Back online',
      body: 'The connection returned.', ttl: 4500, where: 'network' });
  } catch (e) {} });

  /* ---- a mod that threw while loading is invisible today ---- */
  let scanned = false;
  function scanMods() {
    if (scanned) return; scanned = true;
    try {
      const names = RF.order || [];
      for (const nm of names) {
        const m = RF.mods[nm];
        if (!m || m.ok || !m.error) continue;
        notify({ level: 'error', title: 'Mod "' + nm + '" failed to load', ttl: 0,
          body: errMsg(m.error) + ' · everything it adds is missing, the rest of the game is fine.',
          where: 'mod:' + nm, details: (m.error && m.error.stack) || String(m.error) });
      }
      storageCheck(true);
    } catch (e) { soft('notify:scan', e); }
  }
  RF.on('ready', scanMods);
  /* Core emits 'ready' from RF._boot(), which runs at the END of game.js — before
     any mod <script> has parsed. Nothing would ever hear it, so self-arm as well. */
  setTimeout(scanMods, 0);

  /* ---- the good news, quietly ---- */
  RF.on('ach', (id, name, reward) => { try {
    notify({ level: 'success', title: name, icon: 'trophy', ttl: 5200,
      body: 'Achievement unlocked · ' + (RF.fn.fmt ? '+◈' + RF.fn.fmt(reward) : '+' + reward),
      where: 'ach:' + id });
  } catch (e) {} });

  /* ---- housekeeping: two cheap probes, well off the frame's critical path ---- */
  RF.every(20, () => { try { storageCheck(false); saveCheck(); } catch (e) { soft('notify:health', e); } });

  /* ======================================================================
     11. THE PUBLISHED API — ten other slots call these, so nothing throws out
     ====================================================================== */
  const DEAD = { id: 0, update() { return DEAD; }, close() {} };
  RF.api = RF.api || {};
  RF.api.notify = function (opts) { try { return notify(opts); } catch (e) { soft('notify:api', e); return DEAD; } };
  RF.api.notifyClear = function (tag) { try { const c = byTag[String(tag)]; if (c) close(c); } catch (e) { soft('notify:clear', e); } };
  RF.api.confirm = function (opts) { try { return confirmBox(opts); } catch (e) { soft('notify:confirmapi', e); return Promise.resolve(false); } };
  RF.api.notifyOpen = function () { try { openDrawer(); } catch (e) { soft('notify:open', e); } };
  RF.api.diagnostics = function () { try { return diagnostics(); } catch (e) { return 'diagnostics unavailable'; } };
});
