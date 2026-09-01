/* ============================================================================
   12-boot — the boot experience: what this browser can actually do, where the
   game is running from, what changed since last time, and — for a first-timer
   — where to look. Nothing here is decoration; every card exists because a
   player walked into the thing it explains with no way to find out.
   1. Capability report · a real battery of checks, each carrying the one
      sentence that says what breaks. Opens itself only when something is wrong.
   2. Origin note · file:// versus a served page, said plainly, exactly once.
   3. First run · a six-step tour that spotlights real elements and gets out of
      the way the instant the player starts walking.
   4. Welcome back · time away, dividends paid, what the market is doing, and
      whether the X on the map is still unclaimed.
   5. What is new · a version constant this mod owns, plus a changelog panel.
   6. The boot guard · core's #err box is a dead end. This bolts three exits
      onto it, and catches the quieter failure where nothing happens at all.
   ========================================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------------------------
   0 · THE RESCUE — deliberately outside RF.mod(). A mod body only ever runs
   from a live RF host, so the failure it most needs to cover — core dying
   before it publishes one — could never reach it from in there. Plain DOM,
   no RF, no THREE, no web fonts: this has to render on a broken page.
   --------------------------------------------------------------------------- */
var RESCUE = null, rescueArmed = false, confirmingClear = false;

function styleOnce(text, id) {
  try {
    if (window.RF && RF.css) return RF.css(text, id);
    var old = document.getElementById(id); if (old) old.remove();
    var s = document.createElement('style'); s.id = id; s.textContent = text;
    document.head.appendChild(s); return s;
  } catch (e) { return null; }
}
function whenBody(fn) {
  if (document.body) { fn(); return; }
  document.addEventListener('DOMContentLoaded', fn, { once: true });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/* Only ever the mod layer's own buckets. RF.SAVE is not ours to delete, and a
   player who clicks "clear" while panicking must not lose a hundred hours. */
function clearModStores() {
  var kill = [], i, k;
  try {
    for (i = 0; i < localStorage.length; i++) { k = localStorage.key(i);
      if (k && k.indexOf('rf-mod-') === 0) kill.push(k); }
    for (i = 0; i < kill.length; i++) localStorage.removeItem(kill[i]);
  } catch (e) { return -1; }
  return kill.length;
}

function miniDiag() {
  var L = [], R = window.RF;
  L.push('Reel Fortune · rescue report');
  L.push('when    ' + new Date().toISOString());
  L.push('page    ' + String(location.href).slice(0, 200));
  L.push('agent   ' + navigator.userAgent);
  L.push('window  ' + window.innerWidth + 'x' + window.innerHeight + ' @' + (window.devicePixelRatio || 1));
  L.push('three   ' + (window.THREE ? ('r' + (window.THREE.REVISION || '?')) : 'NOT LOADED'));
  L.push('RF host ' + (R ? ('v' + R.version + ' · ready=' + !!R.ready) : 'NOT PUBLISHED'));
  if (R && R.order) { L.push('');
    L.push('mods (' + R.order.length + ')');
    for (var i = 0; i < R.order.length; i++) { var m = R.mods[R.order[i]];
      L.push('  ' + (R.order[i] + '           ').slice(0, 12) + (m && m.ok ? 'ok' : 'FAILED · ' +
        ((m && m.error && m.error.message) || '?'))); } }
  if (R && R.errors && R.errors.length) { L.push('');
    var e = R.errors.slice(-25);
    L.push('errors (' + e.length + ' of ' + R.errors.length + ')');
    for (var j = 0; j < e.length; j++) L.push('  ' + (e[j].level || 'error') + ' · ' + e[j].where + ' · ' + e[j].msg);
  }
  return L.join('\n');
}

styleOnce([
'#rf-boot-rescue{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:37;',
'  width:min(520px,92vw);max-height:84vh;overflow-y:auto;padding:17px 19px 15px;border-radius:14px;',
'  font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12.5px;line-height:1.6;',
'  color:var(--ink,#e8f4f2);background:var(--glass-sheen,none),var(--glass-strong,rgba(10,20,26,.92));',
'  backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);',
'  border:1px solid var(--glass-bd,rgba(255,255,255,.14));',
'  box-shadow:var(--glass-hi,inset 0 1px 0 rgba(255,255,255,.16)),0 8px 28px rgba(2,8,10,.35);}',
'#rf-boot-rescue.in-err{top:auto;bottom:20px;transform:translate(-50%,0);background:rgba(10,20,26,.96);}',
'#rf-boot-rescue .rfb-re{font-size:9px;letter-spacing:.34em;text-transform:uppercase;color:var(--rose,#ff5d7a);}',
'#rf-boot-rescue .rfb-rt{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:19px;',
'  color:var(--ink,#e8f4f2);line-height:1.2;margin:3px 0 5px;}',
'#rf-boot-rescue .rfb-rb{color:var(--muted,#8aa6a2);font-size:12px;margin-bottom:11px;}',
'#rf-boot-rescue .rfb-racts{display:flex;gap:7px;flex-wrap:wrap;}',
'#rf-boot-rescue button{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:12px;letter-spacing:.04em;',
'  cursor:pointer;border-radius:10px;padding:9px 14px;color:var(--ink,#e8f4f2);',
'  border:1px solid var(--glass-bd-soft,rgba(255,255,255,.09));background:var(--glass-row,rgba(255,255,255,.055));',
'  box-shadow:0 2px 0 rgba(7,20,24,.85),inset 0 1px 0 rgba(255,255,255,.12);transition:transform .06s,border-color .12s;}',
'#rf-boot-rescue button:hover{border-color:var(--teal,#39d7c4);}',
'#rf-boot-rescue button:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}',
'#rf-boot-rescue button.pri{border-color:var(--teal,#39d7c4);color:var(--teal,#39d7c4);}',
'#rf-boot-rescue button.dgr{border-color:var(--rose,#ff5d7a);color:var(--rose,#ff5d7a);}',
'#rf-boot-rescue pre{display:none;margin-top:11px;padding:10px 11px;border-radius:10px;max-height:220px;overflow:auto;',
'  font-size:10px;line-height:1.5;color:var(--lab,#b5cdc9);white-space:pre-wrap;word-break:break-word;',
'  background:rgba(3,10,12,.5);border:1px solid var(--glass-bd-soft,rgba(255,255,255,.09));}',
'#rf-boot-rescue pre.on{display:block;}',
'#rf-boot-rescue .rfb-rf{margin-top:10px;font-size:9.5px;letter-spacing:.05em;color:var(--faint,#5c7a76);}'
].join('\n'), 'rf-boot-rescue-css');

function showRescue(title, body) {
  if (RESCUE) { if (title) { var t = RESCUE.querySelector('.rfb-rt'); if (t) t.textContent = title; } return RESCUE; }
  whenBody(function () {
    if (RESCUE) return;
    var box = document.createElement('div');
    box.id = 'rf-boot-rescue';
    box.setAttribute('role', 'dialog');
    box.innerHTML =
      '<div class="rfb-re">the isle did not open</div>' +
      '<div class="rfb-rt"></div><div class="rfb-rb"></div>' +
      '<div class="rfb-racts">' +
        '<button type="button" class="pri" data-a="reload">Reload the page</button>' +
        '<button type="button" data-a="diag">Show diagnostics</button>' +
        '<button type="button" class="dgr" data-a="clear">Clear mod data</button>' +
      '</div><pre></pre>' +
      '<div class="rfb-rf">Your save is never touched by anything on this card · only the mod layer’s own settings.</div>';
    box.querySelector('.rfb-rt').textContent = title || 'Something stopped the game.';
    box.querySelector('.rfb-rb').textContent = body || 'These are the only three things that ever help.';
    var pre = box.querySelector('pre');
    box.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      var a = b.getAttribute('data-a');
      if (a === 'reload') { try { location.reload(); } catch (e) {} return; }
      if (a === 'diag') {
        var txt = '';
        try { txt = (window.RF && RF.api && RF.api.diagnostics) ? RF.api.diagnostics() : miniDiag(); }
        catch (e) { txt = miniDiag(); }
        pre.textContent = txt; pre.classList.toggle('on');
        b.textContent = pre.classList.contains('on') ? 'Hide diagnostics' : 'Show diagnostics';
        if (pre.classList.contains('on')) { try { getSelection().selectAllChildren(pre); } catch (e) {} }
        return; }
      if (a === 'clear') {
        var done = function (yes) { if (!yes) { b.textContent = 'Clear mod data'; confirmingClear = false; return; }
          var n = clearModStores();
          b.disabled = true;
          b.textContent = n < 0 ? 'Storage is locked' : (n + ' cleared · reload');
          box.querySelector('.rfb-rb').textContent = n < 0
            ? 'This browser will not let the page touch storage at all.'
            : 'Mod settings are gone. Your save is untouched. Reload to start clean.'; };
        if (window.RF && RF.api && RF.api.confirm) {
          RF.api.confirm({ title: 'Clear the mod layer’s settings?',
            body: 'Panels, tours, quest progress and preferences from mods/ are removed. Your coins, fish and gear are in a different store and are not touched.',
            ok: 'Clear it', danger: true }).then(done);
        } else if (!confirmingClear) { confirmingClear = true; b.textContent = 'Really? click again'; }
        else { confirmingClear = false; done(true); }
      }
    });
    document.body.appendChild(box);
    RESCUE = box;
  });
  return null;
}

/* No RF at all: game.js never got past its own first lines. */
if (!window.RF || typeof RF.mod !== 'function') {
  whenBody(function () { showRescue('The game engine never loaded.',
    'lib/three.min.js or game.js failed before it could publish anything · check the folder is complete.'); });
  return;
}

/* RF exists but never booted: something threw between the host and _boot(), so
   no mod body — including this one — will ever run. Only a timer can catch it. */
var bootWatch = setTimeout(function () {
  if (RF.ready) return;
  showRescue('The isle never finished loading.',
    'game.js stopped partway and never handed over to the mod layer.');
}, 6000);

RF.mod('12-boot', function (RF) {
  clearTimeout(bootWatch);

  const S = RF.state, F = RF.fn, byId = id => document.getElementById(id);
  const KEY = '12-boot', CANARY = '12-boot-canary';
  const VER = '2.0.0';                      // this mod owns the player-facing version
  const PROTO = location.protocol, FILEY = PROTO === 'file:';

  let mine = RF.store.get(KEY, null);
  if (!mine || typeof mine !== 'object') mine = {};
  const persist = () => { try { RF.store.set(KEY, mine); } catch (e) { RF.err('boot:store', e, 'warn'); } };

  const say = o => { try {
      return (RF.api && RF.api.notify) ? RF.api.notify(o)
        : F.toast(o.title + (o.body ? ' · ' + o.body : ''), (o.level === 'error' || o.level === 'fatal') ? 'bad' : '');
    } catch (e) { RF.err('boot:say', e, 'warn'); return null; } };
  const pix = (n, s) => { try { return (RF.PIX && RF.PIX[n]) ? F.pixSVG(n, s) : ''; } catch (e) { return ''; } };
  const calm = () => { try { return document.body.classList.contains('rf-reduced'); } catch (e) { return false; } };

  /* Fresh means genuinely fresh: no save key of core's AND nothing done. On the
     very first boot core has not written the key yet (payDividends saves after
     the mods load), so this is only ever true once — plus the grace case of a
     player who reloaded the title screen without ever pressing Set sail. */
  const hadSave = (function () { try { return !!localStorage.getItem(RF.SAVE); } catch (e) { return false; } })();
  const st0 = S.stats || {};
  const zeroStats = !(st0.caught | 0) && !(st0.mined | 0) && !(st0.earned | 0) &&
                    !(st0.spins | 0) && !(S.coins | 0) && !(S.pearlsLife | 0);
  const fresh = zeroStats && !mine.tourSeen && (!hadSave || !mine.everStarted);

  /* game.js emits 'ready' from _boot(), which runs BEFORE any mod script tag —
     so a handler registered here would never fire. One frame is the honest
     "everything is up" signal, and its absence is itself a failure worth
     catching, so the fallback timer below doubles as a render-loop watchdog. */
  let settled = false, frameSeen = false;
  const settleQ = [];
  const whenSettled = fn => { if (settled) { try { fn(); } catch (e) { RF.err('boot:settle', e); } } else settleQ.push(fn); };
  function settle() { if (settled) return; settled = true;
    for (const fn of settleQ) { try { fn(); } catch (e) { RF.err('boot:settle', e); } } settleQ.length = 0; }

  /* ==========================================================================
     1 · LOOK — one glass shell, three views (report, changelog, tour card).
     ========================================================================== */
  RF.css(`
  #rf-boot-scrim{position:fixed;inset:0;z-index:26;display:none;align-items:center;justify-content:center;
    padding:16px;background:rgba(3,10,12,.44);backdrop-filter:blur(6px) saturate(1.15);
    -webkit-backdrop-filter:blur(6px) saturate(1.15);}
  #rf-boot-scrim.on{display:flex;}
  #rf-boot-panel{width:min(calc(560px * var(--rf-ui-scale,1)),95vw);max-height:86vh;overflow-y:auto;
    padding:18px 20px 16px;border-radius:14px;
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);
    scrollbar-width:thin;scrollbar-color:rgba(138,166,162,.35) transparent;}
  #rf-boot-panel::-webkit-scrollbar{width:9px;}
  #rf-boot-panel::-webkit-scrollbar-thumb{background:rgba(138,166,162,.3);border:3px solid transparent;
    background-clip:padding-box;border-radius:8px;}
  .rfb-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:12px;}
  .rfb-eye{font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:var(--teal);}
  .rfb-h2{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:21px;color:var(--ink);line-height:1.15;}
  .rfb-x{font-size:11px;color:var(--muted);background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:8px;padding:6px 11px;cursor:pointer;letter-spacing:.1em;font-family:inherit;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 2px 0 rgba(4,12,14,.5);}
  .rfb-x:hover{border-color:rgba(255,93,122,.55);color:var(--rose);}
  .rfb-lead{font-size:11.5px;line-height:1.6;color:var(--muted);margin:-6px 0 12px;}
  .rfb-sec{display:flex;align-items:center;gap:9px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;
    color:var(--lab);margin:14px 0 8px;}
  .rfb-sec::before{content:"";flex:0 0 3px;width:3px;height:11px;border-radius:2px;background:rgba(57,215,196,.9);
    box-shadow:0 0 8px rgba(57,215,196,.6);}
  .rfb-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(138,166,162,.25),transparent 85%);}

  .rfb-row{display:grid;grid-template-columns:9px 1fr auto;gap:3px 11px;align-items:center;
    padding:8px 12px;margin-bottom:5px;border-radius:10px;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rfb-row.ok{color:var(--teal);} .rfb-row.warn{color:var(--gold);} .rfb-row.bad{color:var(--rose);}
  .rfb-row.warn{border-color:rgba(255,207,92,.3);} .rfb-row.bad{border-color:rgba(255,93,122,.4);}
  .rfb-dot{width:9px;height:9px;border-radius:50%;background:currentColor;box-shadow:0 0 7px currentColor;}
  .rfb-k{font-size:12px;font-weight:600;color:var(--ink);}
  .rfb-v{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;
    font-variant-numeric:tabular-nums;text-align:right;color:currentColor;}
  .rfb-why{grid-column:2 / 4;font-size:10.5px;line-height:1.5;color:var(--muted);}

  .rfb-nrow{display:flex;gap:10px;align-items:flex-start;padding:8px 12px;margin-bottom:5px;border-radius:10px;
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rfb-nrow .rfb-ni{flex:0 0 auto;display:flex;align-items:center;opacity:.95;padding-top:1px;}
  .rfb-nrow b{display:block;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;
    letter-spacing:.11em;text-transform:uppercase;color:var(--teal);}
  .rfb-nrow span{display:block;font-size:11.5px;line-height:1.5;color:var(--ink);}
  .rfb-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;
    margin-top:13px;padding-top:11px;border-top:1px solid var(--glass-bd-soft);}
  .rfb-note{font-size:9.5px;letter-spacing:.05em;color:var(--faint);flex:1;min-width:120px;}
  .rfb-btn{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:12px;letter-spacing:.04em;cursor:pointer;
    border-radius:10px;padding:8px 14px;color:var(--ink);border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);box-shadow:0 2px 0 rgba(7,20,24,.85),inset 0 1px 0 rgba(255,255,255,.12);
    transition:transform .06s,border-color .12s;}
  .rfb-btn:hover{border-color:rgba(57,215,196,.6);}
  .rfb-btn:active{transform:translateY(2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}
  .rfb-btn.pri{border-color:var(--teal);color:var(--teal);}
  #rf-boot-copy{display:none;margin-top:9px;width:100%;font-family:"IBM Plex Mono",monospace;font-size:10px;
    line-height:1.5;color:var(--lab);background:rgba(3,10,12,.5);border:1px solid var(--glass-bd-soft);
    border-radius:10px;padding:9px 10px;resize:vertical;min-height:120px;}
  #rf-boot-copy.on{display:block;}


  /* the tour: one dim layer with a hole punched by an enormous ring shadow */
  #rf-boot-tour{position:fixed;inset:0;z-index:33;display:none;pointer-events:none;}
  #rf-boot-tour.on{display:block;}
  #rf-boot-hole{position:absolute;border-radius:14px;pointer-events:none;
    box-shadow:0 0 0 9999px rgba(3,10,12,.6),inset 0 0 0 2px rgba(57,215,196,.9),0 0 26px rgba(57,215,196,.4);
    transition:left .32s cubic-bezier(.2,.8,.2,1),top .32s cubic-bezier(.2,.8,.2,1),
      width .32s cubic-bezier(.2,.8,.2,1),height .32s cubic-bezier(.2,.8,.2,1);
    display:flex;align-items:center;justify-content:center;}
  #rf-boot-hole .rfb-chev{font-family:"Chakra Petch",sans-serif;font-size:26px;line-height:1;color:var(--teal);
    text-shadow:0 0 14px rgba(57,215,196,.8);display:none;}
  #rf-boot-hole.far .rfb-chev{display:block;animation:rfb-nudge 1.5s ease-in-out infinite;}
  @keyframes rfb-nudge{0%,100%{transform:translateY(-2px);opacity:.75;}50%{transform:translateY(3px);opacity:1;}}
  #rf-boot-card{position:absolute;pointer-events:auto;width:min(calc(320px * var(--rf-ui-scale,1)),84vw);
    padding:14px 16px 12px;border-radius:14px;
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);
    animation:rfb-in .3s cubic-bezier(.2,.8,.2,1);}
  @keyframes rfb-in{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
  #rf-boot-card .rfb-step{font-size:9px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold);}
  #rf-boot-card h3{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:16px;color:var(--ink);
    margin:3px 0 5px;line-height:1.2;}
  #rf-boot-card p{font-size:11.5px;line-height:1.6;color:var(--muted);}
  #rf-boot-card .rfb-acts{display:flex;gap:7px;align-items:center;margin-top:11px;}
  #rf-boot-card .rfb-acts .rfb-btn{padding:7px 12px;font-size:11.5px;}
  #rf-boot-card .rfb-keep{flex:1;font-size:9.5px;color:var(--faint);background:none;border:none;cursor:pointer;
    font-family:inherit;text-align:left;padding:0;line-height:1.3;}
  #rf-boot-card .rfb-keep:hover{color:var(--muted);}

  /* welcome back: eight seconds, then gone */
  #rf-boot-hello{position:fixed;left:50%;top:24%;z-index:29;width:min(calc(430px * var(--rf-ui-scale,1)),88vw);
    padding:14px 17px 13px;border-radius:14px;opacity:0;pointer-events:none;
    transform:translateX(-50%) translateY(-10px);transition:opacity .45s ease,transform .45s cubic-bezier(.2,.8,.2,1);
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
  #rf-boot-hello.on{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto;cursor:pointer;}
  #rf-boot-hello .rfb-he{font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:var(--teal);}
  #rf-boot-hello h3{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:18px;color:var(--ink);
    margin:2px 0 7px;line-height:1.2;}
  #rf-boot-hello .rfb-hl{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.55;
    color:var(--ink);margin-bottom:4px;}
  #rf-boot-hello .rfb-hl b{font-family:"Chakra Petch",sans-serif;color:var(--gold);font-weight:700;
    font-variant-numeric:tabular-nums;}
  #rf-boot-hello .rfb-hf{margin-top:7px;font-size:9px;letter-spacing:.14em;color:var(--faint);text-transform:uppercase;}

  body.photo #rf-boot-hello,body.photo #rf-boot-tour{display:none!important;}
  body.rf-reduced #rf-boot-hole{transition:none;}
  body.rf-reduced #rf-boot-card,body.rf-reduced #rf-boot-hello{animation:none;transition:none;}
  body.rf-reduced #rf-boot-hole.far .rfb-chev{animation:none;}
  `, 'rf-boot-css');

  const scrim = RF.el('<div id="rf-boot-scrim"><div id="rf-boot-panel" role="dialog" aria-modal="true"></div></div>');
  const panel = scrim ? scrim.firstElementChild : null;
  let panelView = '';

  function closePanel() { if (!scrim) return; scrim.classList.remove('on'); panelView = ''; }
  function openPanel(view, eyebrow, title, lead, body, footer) {
    if (!scrim || !panel) return;
    panelView = view;
    panel.innerHTML =
      '<div class="rfb-head"><div><div class="rfb-eye">' + esc(eyebrow) + '</div>' +
      '<div class="rfb-h2">' + esc(title) + '</div></div>' +
      '<button class="rfb-x" type="button" data-a="close">CLOSE · ESC</button></div>' +
      (lead ? '<div class="rfb-lead">' + lead + '</div>' : '') + body +
      '<div class="rfb-foot">' + footer + '</div>' +
      '<textarea id="rf-boot-copy" readonly spellcheck="false"></textarea>';
    scrim.classList.add('on');
    panel.scrollTop = 0;
  }
  if (scrim) {
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) closePanel(); });
    scrim.addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const a = b.getAttribute('data-a');
      if (a === 'close') { closePanel(); return; }
      if (a === 'dismissnews') { mine.ver = VER; persist(); closePanel(); return; }
      if (a === 'shownews') { openNews(); return; }
      if (a === 'showreport') { openReport(); return; }
      if (a === 'tour') { if (panelView === 'news') { mine.ver = VER; persist(); } closePanel(); startTour(true); return; }
      if (a === 'copy') { copyOut(b); return; }
    });
  }

  /* Clipboard is absent on most file:// pages, so the fallback is not optional:
     drop the text into a real textarea, select it, and let the player press
     the two keys they already know. */
  function copyOut(btn) {
    const box = byId('rf-boot-copy'); if (!box) return;
    let txt = '';
    try { txt = (RF.api && RF.api.diagnostics) ? RF.api.diagnostics() : miniDiag(); } catch (e) { txt = miniDiag(); }
    txt = reportText() + '\n\n' + txt;
    box.value = txt; box.classList.add('on');
    const done = ok => { btn.textContent = ok ? 'Copied' : 'Select & copy'; if (!ok) { try { box.focus(); box.select(); } catch (e) {} } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(() => done(true), () => done(false));
      else done(false);
    } catch (e) { done(false); }
  }

  /* ==========================================================================
     2 · THE BATTERY — only checks whose failure changes what the player sees.
     Each carries the one consequence sentence, in plain words.
     ========================================================================== */
  const SOFT = /swiftshader|llvmpipe|softpipe|software|mesa offscreen|microsoft basic|generic renderer|angle \(software/i;
  let CHECKS = [], originRow = null;

  function battery() {
    const L = [];
    const add = (id, label, value, status, why, loud) =>
      L.push({ id: id, label: label, value: String(value), status: status || 'ok', why: why || '', loud: !!loud });

    /* Ask the renderer for its live context. A second probe context costs GPU
       memory and some drivers only ever hand out a handful. */
    let gl = null, lost = false;
    try { if (RF.renderer && typeof RF.renderer.getContext === 'function') gl = RF.renderer.getContext(); }
    catch (e) { RF.err('boot:gl', e, 'warn'); }
    if (gl) { try { lost = !!(gl.isContextLost && gl.isContextLost()); } catch (e) {} }
    const two = !!(gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);

    if (!gl) add('webgl', 'WebGL', 'missing', 'fail',
      'The 3D world cannot be drawn at all · nothing below this matters until it works.', true);
    else if (lost) add('webgl', 'WebGL', (two ? '2.0' : '1.0') + ' · lost', 'fail',
      'The GPU dropped the world mid-flight · a reload usually brings it straight back.', true);
    else add('webgl', 'WebGL', two ? '2.0' : '1.0', 'ok',
      two ? '' : 'WebGL 1 · a few effects fall back to a cheaper path. Nothing is missing.');

    let rend = '';
    if (gl && !lost) {
      try { const ex = gl.getExtension('WEBGL_debug_renderer_info');
        if (ex) rend = String(gl.getParameter(ex.UNMASKED_RENDERER_WEBGL) || ''); } catch (e) {}
      if (!rend) { try { rend = String(gl.getParameter(gl.RENDERER) || ''); } catch (e) {} }
    }
    const soft = !!rend && SOFT.test(rend);
    if (rend) add('gpu', 'Graphics', clip(rend, 54), soft ? 'warn' : 'ok',
      soft ? 'This browser is drawing the isle on the CPU, not the graphics card · expect a low frame rate. Turn Quality down in Settings.' : '', soft);
    else add('gpu', 'Graphics', gl ? 'name hidden' : 'unknown', 'ok',
      gl ? 'Your browser masks the card name for privacy · that is fine.' : '');

    const AC = !!(window.AudioContext || window.webkitAudioContext);
    add('audio', 'Audio engine', AC ? (RF.audio && RF.audio.ready
        ? (RF.audio.suspended ? 'ready · asleep' : 'running') : 'wakes on first click') : 'missing',
      AC ? 'ok' : 'warn',
      AC ? '' : 'No sound of any kind · everything else plays exactly as it should.');

    /* Write, read back, remove. Private windows throw on the write; a full quota
       throws too, and both mean the same thing to the player. */
    let stOK = false, stWhy = '';
    try { RF.store.set(CANARY, 1); stOK = RF.store.get(CANARY, null) === 1; RF.store.del(CANARY); } catch (e) { stOK = false; }
    if (!stOK) { try { if (!window.localStorage) stWhy = 'not available'; else { localStorage.length; stWhy = 'writes refused'; } }
      catch (e) { stWhy = (e && e.name) ? e.name : 'blocked'; } }
    add('store', 'Saved progress', stOK ? 'working' : stWhy, stOK ? 'ok' : 'fail',
      stOK ? '' : 'Nothing can be saved · every coin and fish is lost when this tab closes. Private-browsing windows do this.', true);

    add('raf', 'Animation clock', typeof requestAnimationFrame === 'function' ? 'present' : 'missing',
      typeof requestAnimationFrame === 'function' ? 'ok' : 'fail',
      typeof requestAnimationFrame === 'function' ? '' : 'Nothing can move · the isle will render one frame and stop.', true);

    const ws = typeof WebSocket === 'function';
    add('ws', 'WebSocket', ws ? 'present' : 'missing', ws ? 'ok' : 'warn',
      ws ? '' : 'No live multiplayer · other anglers will never appear, and chat stays local.');

    const cb = !!(navigator.clipboard && navigator.clipboard.writeText);
    add('clip', 'Clipboard', cb ? 'granted' : 'unavailable', cb ? 'ok' : 'warn',
      cb ? '' : 'Copy buttons fall back to a select-and-copy box' + (FILEY ? ' · normal for a page opened from a folder.' : '.'));

    const pe = ('PointerEvent' in window);
    add('ptr', 'Pointer events', pe ? 'present' : 'missing', pe ? 'ok' : 'warn',
      pe ? '' : 'Touch and stylus input may misbehave · a mouse still works.');

    const dpr = window.devicePixelRatio || 1;
    add('dpr', 'Pixel ratio', dpr.toFixed(2) + '×', 'ok',
      dpr > 2 ? 'The renderer caps its buffer at 2×, so a sharper screen costs you nothing.' : '');

    const w = window.innerWidth, h = window.innerHeight, small = w < 900 || h < 560;
    add('size', 'Window', w + ' × ' + h, small ? 'warn' : 'ok',
      small ? 'Below 900 × 560 the panels crowd the HUD · a larger window reads much better.' : '');

    return L;
  }

  const worst = list => list.reduce((a, c) => c.status === 'fail' ? 'fail' : (c.status === 'warn' && a === 'ok') ? 'warn' : a, 'ok');

  function reportText() {
    const L = ['Reel Fortune · capability report', 'when   ' + new Date().toISOString(),
      'origin ' + PROTO + '//' + (location.host || '(local folder)')];
    const all = originRow ? CHECKS.concat([originRow]) : CHECKS;
    for (const c of all) L.push(('  ' + c.label + '                 ').slice(0, 20) +
      (c.status === 'ok' ? ' ok   ' : c.status === 'warn' ? ' warn ' : ' FAIL ') + c.value + (c.why ? '  · ' + c.why : ''));
    return L.join('\n');
  }

  function rowHTML(c) {
    const cls = c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : 'ok';
    return '<div class="rfb-row ' + cls + '"><i class="rfb-dot"></i>' +
      '<span class="rfb-k">' + esc(c.label) + '</span><span class="rfb-v">' + esc(c.value) + '</span>' +
      (c.why ? '<span class="rfb-why">' + esc(c.why) + '</span>' : '') + '</div>';
  }

  function openReport() {
    const all = originRow ? [originRow].concat(CHECKS) : CHECKS;
    const bad = all.filter(c => c.status !== 'ok');
    const lead = bad.length
      ? '<b style="color:var(--gold)">' + bad.length + (bad.length === 1 ? ' thing needs' : ' things need') +
        ' your attention.</b> Everything else on this machine is ready.'
      : 'Everything this game needs is present and working. Kept here in case a frame ever stutters and you want to check.';
    openPanel('report', 'system check', 'WHAT THIS BROWSER CAN DO', lead,
      all.map(rowHTML).join(''),
      '<span class="rfb-note">Nothing here is sent anywhere · it is read straight off your browser.</span>' +
      '<button class="rfb-btn" type="button" data-a="copy">Copy report</button>' +
      '<button class="rfb-btn pri" type="button" data-a="close">Done</button>');
  }

  /* ==========================================================================
     3 · THE ORIGIN NOTE — the single most common source of confusion in a game
     that ships as a double-clickable folder.
     ========================================================================== */
  const hostOf = u => { try { return new URL(u).host || u; } catch (e) { return String(u || '').slice(0, 48); } };

  function setOrigin(value, why, status, sig) {
    originRow = { id: 'origin', label: 'Where this is running', value: value, status: status || 'ok', why: why || '', loud: false };
    if (panelView === 'report') openReport();
    if (sig && mine.origin !== sig) {                 // said once per outcome, never every session
      mine.origin = sig; persist();
      say({ level: status === 'warn' ? 'warn' : 'info', tag: 'rf-boot-origin', icon: 'island',
        title: value, body: why, ttl: 9000,
        actions: [{ label: 'System check', fn: openReport }] });
    }
  }

  function readOrigin() {
    if (FILEY) {
      setOrigin('Opened from a folder', 'No server is involved, so there is no multiplayer, no leaderboard and no cloud save · your progress lives in this browser only, on this machine.',
        'ok', 'file');
      return;
    }
    const net = window.RFNet;
    if (!net || !net.base) {
      setOrigin('Served, no server configured', 'The page is on a web server but no game backend is set · offline play, saved in this browser.', 'ok', 'nobase');
      return;
    }
    let n = 0;
    const t = setInterval(() => {
      n++;
      try {
        if (net.reachable) { clearInterval(t);
          setOrigin('A server answered at ' + hostOf(net.base),
            net.online ? 'Signed in as ' + (net.user || 'you') + ' · the server owns your coins and your save from here on.'
                       : 'Sign in on the title screen for multiplayer and the leaderboard · Set sail alone still works.',
            'ok', 'up:' + (net.online ? 'in' : 'out'));
          return; }
        if (net.lastError || n > 24) { clearInterval(t);
          setOrigin('No server answered at ' + hostOf(net.base),
            'No multiplayer and no leaderboard this session · progress is saved in this browser instead.', 'warn', 'down');
        }
      } catch (e) { clearInterval(t); RF.err('boot:origin', e, 'warn'); }
    }, 600);
  }

  /* ==========================================================================
     4 · WHAT IS NEW
     ========================================================================== */
  const NEWS = [{
    v: '2.0.0', name: 'The isle grows a memory',
    lines: [
      ['island', 'The boot layer', 'This: a system check, a first-run tour, and a word when you come back.'],
      ['chart', 'Notification centre', 'Every warning, error and server hiccup lands in one drawer · N opens it.'],
      ['rod', 'Fishing has depth', 'Line tension, a fish that fights back, and rigs that keep fishing while you walk.'],
      ['bucket', 'A HUD that reads', 'Rolling counters, a bucket meter, live effect pills and edge waypoints.'],
      ['gem', 'Tooltips and the codex', 'Hold Alt to inspect anything on screen · H for help, / to search it all.'],
      ['map', 'The atlas', 'M opens a real chart of the isle · veins, shoals, landmarks and your X.'],
      ['trophy', 'Quests and renown', 'Q · a running log of what the isle wants from you next, and credit for it.'],
      ['wood', 'The journal', 'J · an almanac, your records, and notes the isle writes as you go.'],
      ['wheel', 'Casino and market depth', 'G · odds you can actually read, a live ticker, and portfolio history.'],
      ['crew', 'Presence and chat', 'Y · see who else is on the isle and say something to them.'],
      ['pick', 'Settings and access', 'O · motion, quality, contrast and save safety, all in one panel.'],
      ['boat', 'Touch controls', 'A thumbstick and an action ring appear on small screens · no keyboard needed.'],
      ['moon', 'A living soundscape', 'Surf, weather, gulls and a music bed that follows the clock.'],
      ['fish', 'The islanders', 'R · people with names, routines, and something to say about the tide.']
    ]
  }];

  function openNews() {
    const e = NEWS[0];
    openPanel('news', 'version ' + e.v, e.name.toUpperCase(),
      'Fourteen new systems landed on the isle at once. Here is the whole of it, one line each.',
      e.lines.map(l => '<div class="rfb-nrow"><span class="rfb-ni">' + pix(l[0], 15) + '</span>' +
        '<span><b>' + esc(l[1]) + '</b><span>' + esc(l[2]) + '</span></span></div>').join(''),
      '<span class="rfb-note">Reel Fortune · v' + esc(VER) + '</span>' +
      '<button class="rfb-btn" type="button" data-a="tour">Show me around</button>' +
      '<button class="rfb-btn" type="button" data-a="showreport">System check</button>' +
      '<button class="rfb-btn pri" type="button" data-a="dismissnews">Ready</button>');
  }

  /* ==========================================================================
     5 · THE TOUR — six steps, real elements, and it folds the moment the
     player would rather just walk.
     ========================================================================== */
  const STEPS = [
    { id: 'sail', title: true, el: () => byId('startBtn'),
      h: 'New to the isle?', p: 'Six things worth knowing, each pointed at where it actually lives. It takes about twenty seconds and you can stop any time.',
      next: 'Show me' },
    { id: 'bucket', el: () => byId('hud-bucket'),
      h: 'Your bucket', p: 'Twelve fish fit in it. When it is full the line stops paying out, so walk them to the Trader and sell · the bucket is the whole loop in one chip.' },
    { id: 'hotbar', el: () => byId('hotbar'),
      h: 'Rod, pick, axe', p: 'Press 1 to 5 to swap, or just walk up to water, a vein or a tree and press E · the isle already knows what you are standing next to.' },
    { id: 'minimap', el: () => byId('minimap'),
      h: 'The isle from above', p: 'Ore veins, the harbor, the wheel, and a pulsing X the day a bottled map turns up in your line.' },
    { id: 'mute', el: () => byId('mute'),
      h: 'Sound lives here', p: 'The isle has weather, gulls, a tide and a music bed that follows the clock. It is worth hearing at least once.' },
    { id: 'trader', world: () => RF.TRADER_POS,
      h: 'The Trader', p: 'Everything you catch or dig turns into coins here · upgrades, bait and the Exchange are on the same counter. Follow the lanterns.' }
  ];

  let tour = null, tourEl = null, holeEl = null, cardEl = null, chevEl = null, keepOff = false, tAcc = 0;

  function buildTour() {
    if (tourEl) return;
    tourEl = RF.el('<div id="rf-boot-tour"><div id="rf-boot-hole"><span class="rfb-chev">▲</span></div>' +
      '<div id="rf-boot-card"></div></div>');
    if (!tourEl) return;
    holeEl = tourEl.querySelector('#rf-boot-hole');
    cardEl = tourEl.querySelector('#rf-boot-card');
    chevEl = tourEl.querySelector('.rfb-chev');
    cardEl.addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const a = b.getAttribute('data-a');
      if (a === 'next') step(tour ? tour.i + 1 : 0);
      else if (a === 'skip') endTour(true);
      else if (a === 'keep') { keepOff = !keepOff; paintCard(); }
    });
  }

  const scratch = new RF.THREE.Vector3();
  function rectOf(s) {
    if (s.world) {
      let v; try { v = s.world(); } catch (e) { v = null; }
      if (!v) return null;
      scratch.copy(v); scratch.project(RF.camera);
      const x = (scratch.x * 0.5 + 0.5) * window.innerWidth, y = (-scratch.y * 0.5 + 0.5) * window.innerHeight;
      const m = 96, cx = Math.max(m, Math.min(window.innerWidth - m, x)), cy = Math.max(m, Math.min(window.innerHeight - m, y));
      const off = Math.abs(cx - x) > 1 || Math.abs(cy - y) > 1;
      return { left: cx - 48, top: cy - 48, width: 96, height: 96, right: cx + 48, bottom: cy + 48,
        far: off, ang: off ? Math.atan2(y - cy, x - cx) : 0 };
    }
    let el; try { el = s.el(); } catch (e) { el = null; }
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const p = 8;
    return { left: r.left - p, top: r.top - p, width: r.width + p * 2, height: r.height + p * 2,
      right: r.right + p, bottom: r.bottom + p, far: false, ang: 0 };
  }

  function place(r) {
    if (!holeEl || !cardEl) return;
    holeEl.style.left = Math.round(r.left) + 'px'; holeEl.style.top = Math.round(r.top) + 'px';
    holeEl.style.width = Math.round(r.width) + 'px'; holeEl.style.height = Math.round(r.height) + 'px';
    holeEl.classList.toggle('far', !!r.far);
    if (chevEl && r.far) chevEl.style.transform = 'rotate(' + (r.ang * 180 / Math.PI + 90).toFixed(1) + 'deg)';
    const cw = cardEl.offsetWidth || 300, ch = cardEl.offsetHeight || 150, m = 14;
    let top = r.bottom + m;
    if (top + ch > window.innerHeight - m) top = r.top - ch - m;
    if (top < m) top = Math.max(m, Math.min(window.innerHeight - ch - m, r.top));
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(m, Math.min(window.innerWidth - cw - m, left));
    cardEl.style.left = Math.round(left) + 'px'; cardEl.style.top = Math.round(top) + 'px';
  }

  function paintCard() {
    if (!tour || !cardEl) return;
    const s = tour.list[tour.i], last = tour.i === tour.list.length - 1;
    cardEl.innerHTML =
      '<div class="rfb-step">step ' + (tour.i + 1) + ' of ' + tour.list.length + '</div>' +
      '<h3>' + esc(s.h) + '</h3><p>' + esc(s.p) + '</p>' +
      '<div class="rfb-acts">' +
      '<button class="rfb-keep" type="button" data-a="keep">' + (keepOff ? '✓' : '·') + ' don’t show this again</button>' +
      '<button class="rfb-btn" type="button" data-a="skip">' + (last ? 'Close' : 'Skip') + '</button>' +
      (last ? '' : '<button class="rfb-btn pri" type="button" data-a="next">' + esc(s.next || 'Next ›') + '</button>') +
      '</div>';
  }

  function step(i) {
    if (!tour) return;
    if (i >= tour.list.length) { endTour(true); return; }
    /* Step one lives on the title screen; the rest need a world to point at, so
       the tour parks itself until Set sail is pressed. */
    if (tour.list[i].title === undefined && !RF.running) { tour.i = i; tour.parked = true; hideTour(); return; }
    tour.parked = false;
    if (tour.list[i].title && RF.running) { step(i + 1); return; }
    tour.i = i;
    const r = rectOf(tour.list[i]);
    if (!r) { step(i + 1); return; }            // an element another mod removed is not an error
    tourEl.classList.add('on');
    paintCard(); place(r);
  }
  function hideTour() { if (tourEl) tourEl.classList.remove('on'); }

  function startTour(manual) {
    try {
      buildTour(); if (!tourEl) return;
      keepOff = true;
      tour = { i: 0, list: STEPS.slice(), parked: false, manual: !!manual };
      step(RF.running ? 1 : 0);
    } catch (e) { RF.err('boot:tour', e); }
  }
  function endTour(store) {
    if (!tour) return;
    tour = null; hideTour();
    if (store && keepOff) { mine.tourSeen = 1; persist(); }
  }

  /* One frame hook for the whole mod: it is the settle signal, the tour's
     abort watch, and the tour's reposition timer, and it costs a boolean when
     nothing is running. */
  RF.on('frame', dt => {
    if (!frameSeen) { frameSeen = true; settle(); }
    if (!tour || tour.parked) return;
    try {
      if (F.isMoving() || RF.panelOpen || RF.chatOpen) { endTour(true); return; }
      tAcc += dt; if (tAcc < 0.12) return; tAcc = 0;
      const r = rectOf(tour.list[tour.i]);
      if (r) place(r); else step(tour.i + 1);
    } catch (e) { RF.err('boot:tour:frame', e); tour = null; hideTour(); }
  });

  /* ==========================================================================
     6 · WELCOME BACK
     ========================================================================== */
  const hello = RF.el('<div id="rf-boot-hello"></div>');
  let helloT = 0;

  const away = ms => {
    const s = Math.round(ms / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + (Math.round(s / 60) === 1 ? ' minute' : ' minutes');
    if (s < 172800) { const h = Math.round(s / 3600); return h + (h === 1 ? ' hour' : ' hours'); }
    const d = Math.round(s / 86400); return d + (d === 1 ? ' day' : ' days');
  };
  const worldName = k => { try { return (RF.WORLDS[k] || {}).name || k; } catch (e) { return k; } };

  function showHello() {
    if (!hello) return;
    const gone = Date.now() - (mine.last || 0);
    if (!mine.last || gone < 90000 || fresh) return;

    const lines = [];
    const paid = Math.max(0, (S.stats.divEarned | 0) - (mine.div == null ? (S.stats.divEarned | 0) : (mine.div | 0)));
    let holds = false;
    try { holds = RF.STOCK_KEYS.some(k => (S.stocks.own[k] | 0) > 0); } catch (e) {}
    if (paid > 0) lines.push(pix('chart', 13) + ' The Exchange paid <b>◈ ' + F.fmt(paid) + '</b> in dividends while you were gone.');
    else if (holds) lines.push(pix('chart', 13) + ' Your shares are still on the books · the board kept this quarter’s earnings.');

    try { const m = F.mktMods();
      lines.push(pix('gem', 13) + ' <b>' + esc(F.catLabel(m.hot)) + '</b> is running hot right now · ' +
        esc(F.catLabel(m.cold)) + ' is cold. Sell accordingly.'); } catch (e) {}

    if (S.treasure) {
      const w = S.treasure.w;
      lines.push(pix('map', 13) + ' Your X is still unclaimed' +
        (w && w !== RF.worldKey ? ' · it is waiting on ' + esc(worldName(w)) + '.' : ' · dig it up before the tide does.'));
    } else if (lines.length < 3) {
      lines.push(pix('island', 13) + ' The tide turned over while you were out · the water is holding a fresh table.');
    }

    hello.innerHTML = '<div class="rfb-he">welcome back</div>' +
      '<h3>You were away ' + esc(away(gone)) + '</h3>' +
      lines.slice(0, 3).map(l => '<div class="rfb-hl">' + l + '</div>').join('') +
      '<div class="rfb-hf">click to dismiss</div>';
    hello.classList.add('on');
    helloT = 8;
    hello.onclick = () => { hello.classList.remove('on'); helloT = 0; };
  }

  RF.every(0.5, () => {
    if (helloT > 0) { helloT -= 0.5; if (helloT <= 0 && hello) hello.classList.remove('on'); }
  });

  /* ==========================================================================
     7 · THE BOOT GUARD — a render loop that never starts, mods that failed,
     and the #err box, which says what broke and then leaves you there.
     ========================================================================== */
  const errBox = byId('err');
  /* #err is position:fixed, so offsetParent is null even when it is filling the
     screen · the computed display is the only honest test. */
  function errVisible() { try { return !!errBox && getComputedStyle(errBox).display !== 'none'; }
    catch (e) { return false; } }

  function armRescue(title, body) {
    if (rescueArmed) return;
    rescueArmed = true;
    showRescue(title, body);
    setTimeout(() => {
      if (!RESCUE) return;
      if (errVisible() && errBox && !errBox.contains(RESCUE)) { errBox.appendChild(RESCUE); RESCUE.classList.add('in-err'); }
    }, 30);
  }

  /* fail() rewrites #err.innerHTML wholesale, so the rescue has to re-seat
     itself every time core decides to shout again. */
  if (errBox && window.MutationObserver) {
    try {
      new MutationObserver(() => {
        if (!errVisible()) return;
        if (!rescueArmed) armRescue('The game stopped with an error.',
          'The message above is what core knows. These are the three things that ever help.');
        else if (RESCUE && !errBox.contains(RESCUE)) { errBox.appendChild(RESCUE); RESCUE.classList.add('in-err'); }
      }).observe(errBox, { childList: true, attributes: true, attributeFilter: ['style'] });
    } catch (e) { RF.err('boot:errwatch', e, 'warn'); }
  }
  if (errVisible()) armRescue('The game stopped with an error.',
    'The message above is what core knows. These are the three things that ever help.');

  /* No frame within seven seconds means the render loop never started — the
     quiet failure, the one with no red box and no explanation. */
  setTimeout(() => {
    if (frameSeen) return;
    settle();                                   // the rest of the boot work still deserves to run
    armRescue('The isle loaded, but nothing is drawing.',
      'The render loop never produced a frame. The graphics driver or a mod is holding it.');
  }, 7000);

  function guardMods() {
    const names = RF.order || [];
    const bad = names.filter(n => { const m = RF.mods[n]; return m && !m.ok; });
    const fatal = (RF.errors || []).some(r => r.level === 'fatal' && r.where === 'boot');
    if (!bad.length && !fatal) return;
    if (bad.length >= 2 || fatal) {
      armRescue(bad.length ? bad.length + ' parts of the game failed to load.' : 'Something failed hard during boot.',
        'The isle is playable but pieces are missing. Diagnostics will name them.');
      return;
    }
    say({ level: 'error', tag: 'rf-boot-mod', icon: 'lock',
      title: bad[0] + ' failed to load',
      body: 'That one feature is missing · everything else is fine. A reload often fixes it.',
      details: String((RF.mods[bad[0]].error && RF.mods[bad[0]].error.stack) || RF.mods[bad[0]].error || ''),
      ttl: 0,
      actions: [{ label: 'Reload', fn: () => { try { location.reload(); } catch (e) {} } },
                { label: 'System check', fn: openReport }] });
  }

  /* ==========================================================================
     8 · THE WAYS IN — the start screen stays bare, so the three panels this
     mod owns hang off the settings pane, which is one key away from anywhere,
     plus one card handed over exactly once: the tour on a first boot, the
     changelog on the first boot after a version bump.
     ========================================================================== */
  let wired = false;
  function wireSettings() {
    /* 10-comfort owns that pane and may be missing or dead, so this is asked
       at call time and the answer is allowed to be no. */
    const st = RF.api && RF.api.settings;
    if (wired || !st || typeof st.register !== 'function') return;
    wired = true;
    /* our scrim shares 10-comfort's z band, and the tour would open behind its
       overlay, so the pane closes before anything of ours is put on screen */
    const act = (label, tag, hint, fn) => ({ type: 'btn', label: label, label2: tag, hint: hint,
      get: () => false, set: () => { try { st.close(); } catch (e) {} fn(); } });
    st.register({ mod: '12-boot', title: 'boot & diagnostics', rows: [
      act('System check', 'OPEN', 'what this browser can do, and what breaks where it cannot', openReport),
      act('What is new', 'v' + VER, 'every system that landed on the isle in this version', openNews),
      act('Show me around', 'TOUR', 'the six-step tour again, from wherever you are standing',
          () => startTour(true))
    ] });
  }

  /* Said once per version and never again — nagging a player who has already
     decided is the thing this mod refuses to do everywhere else. The card is
     sticky rather than timed, so it waits to be answered instead of expiring
     behind the title screen. */
  function offerNews() {
    mine.ver = VER; persist();
    const close = h => { if (h && h.close) h.close(); };
    say({ level: 'info', tag: 'rf-boot-news', icon: 'island', ttl: 0,
      title: 'Version ' + VER + ' · ' + NEWS[0].name,
      body: NEWS[0].lines.length + ' new systems have landed since you were last on the isle.',
      actions: [{ label: 'What is new', key: true, fn: h => { close(h); openNews(); } },
                { label: 'Show me around', fn: h => { close(h); startTour(true); } }] });
  }

  /* ==========================================================================
     9 · KEYS — this slot owns no key of its own; Escape is claimed only while
     something of ours is genuinely on screen.
     ========================================================================== */
  RF.on('keydown', e => {
    if (e.code !== 'Escape') return;
    if (scrim && scrim.classList.contains('on')) { e.preventDefault(); closePanel(); return true; }
    if (tour && !tour.parked) { e.preventDefault(); endTour(true); return true; }
  }, -40);

  /* ==========================================================================
     10 · LIFECYCLE
     ========================================================================== */
  RF.on('start', () => {
    mine.everStarted = 1; mine.last = Date.now(); persist();
    if (tour && tour.parked) { setTimeout(() => { if (tour) step(tour.i); }, 900); return; }
    setTimeout(showHello, 700);
  });

  /* The away-clock and the dividend baseline are only as good as the last time
     they were written down, so write them down often and on the way out. */
  RF.every(30, () => { if (!RF.running) return; mine.last = Date.now(); mine.div = S.stats.divEarned | 0; persist(); });
  const bye = () => { mine.last = Date.now(); mine.div = S.stats.divEarned | 0; persist(); };
  addEventListener('pagehide', bye);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') bye(); });

  RF.on('save', ok => {
    const c = CHECKS.filter(x => x.id === 'store')[0]; if (!c) return;
    c.status = ok ? 'ok' : 'fail';
    c.value = ok ? 'working' : 'writes refused';
    c.why = ok ? '' : 'Nothing can be saved · every coin and fish is lost when this tab closes.';
    if (panelView === 'report') openReport();
  });

  addEventListener('resize', () => {
    const c = CHECKS.filter(x => x.id === 'size')[0]; if (!c) return;
    const w = window.innerWidth, h = window.innerHeight, small = w < 900 || h < 560;
    c.value = w + ' × ' + h; c.status = small ? 'warn' : 'ok';
    c.why = small ? 'Below 900 × 560 the panels crowd the HUD · a larger window reads much better.' : '';
    if (tour && !tour.parked) { const r = rectOf(tour.list[tour.i]); if (r) place(r); }
  });

  /* ---- the actual boot sequence, once the page has drawn a frame ---------- */
  whenSettled(function boot() {
    try {
      CHECKS = battery();
      readOrigin();
      wireSettings();
      guardMods();

      /* One notification per failing check, loudest first, capped so a genuinely
         broken machine gets a readable list instead of a wall. */
      const bad = CHECKS.filter(c => c.status === 'fail').concat(CHECKS.filter(c => c.status === 'warn' && c.loud));
      for (let i = 0; i < Math.min(3, bad.length); i++) {
        const c = bad[i];
        say({ level: c.status === 'fail' ? 'error' : 'warn', tag: 'rf-boot-' + c.id, icon: 'lock',
          title: c.label + ' · ' + c.value, body: c.why, ttl: c.status === 'fail' ? 0 : 9000,
          actions: [{ label: 'System check', fn: openReport }] });
      }
      if (bad.length > 3) say({ level: 'warn', tag: 'rf-boot-more', icon: 'lock',
        title: (bad.length - 3) + ' more checks need attention', body: 'Open the system check for the full list.',
        ttl: 9000, actions: [{ label: 'System check', fn: openReport }] });

      /* Auto-open only for a real problem, and only once per distinct problem:
         nagging every session about a browser the player cannot change is worse
         than the problem. The notification still fires every time. */
      const sig = bad.map(c => c.id).join(',');
      const shownReport = !!sig && mine.capSig !== sig;
      if (shownReport) { mine.capSig = sig; persist(); setTimeout(openReport, 500); }
      else if (!sig && mine.capSig) { delete mine.capSig; persist(); }

      if (fresh) {
        mine.ver = VER; persist();            // a first-timer is not owed a changelog
        /* The tour's own first step is the invitation: it points at PLAY, it
           carries Skip, and it defaults to never asking again. Nothing else on
           the title screen would have told a newcomer it exists. */
        setTimeout(() => {
          if (tour || mine.tourSeen) return;
          if (scrim && scrim.classList.contains('on')) return;   // the report got there first
          startTour(false);
        }, 900);
      } else {
        if (!mine.last) { mine.last = Date.now(); persist(); }
        if (mine.ver !== VER) offerNews();
      }
    } catch (e) { RF.err('boot:sequence', e); }
  });

  /* Frames may already be running by the time this file executes; do not wait
     on one that is a whole second away when the work is cheap either way. */
  setTimeout(settle, 1200);

  RF.api = RF.api || {};
  RF.api.boot = {
    version: VER,
    checks: () => CHECKS.slice(),
    report: openReport,
    news: openNews,
    tour: () => startTour(true),
    rescue: (t, b) => armRescue(t || 'Manual rescue', b || 'Opened on request.'),
    origin: () => originRow ? { value: originRow.value, why: originRow.why, status: originRow.status } : null
  };
});
})();
