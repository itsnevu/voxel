/* 09-social — the line home. Everything about being connected: whether you are,
   how well, who else is out there, and what to do when it breaks. With no server
   in sight this file draws nothing, times nothing and says nothing.
   1. The Connection Doctor (Y) — address, probe, session, socket, and the retry clock
      net.js keeps to itself, in plain language.
   2. The status pill — offline · connecting · online + round trip, parked to the
      left of the notify pill and gone entirely when no backend was ever seen.
   3. Failure handling — one card when the session dies, one card when the net does.
   4. Presence — who is on this isle, how far, and a tick that points you at them.
   5. Chat comfort — timestamps, a scrollback that outlives the 60-line log, an
      unread badge, a local hide list, ArrowUp history, and a real /help card.
   6. Crew watch — a knock at the gangway finds the captain wherever they are. */
RF.mod('09-social', function (RF) {
  'use strict';

  const F = RF.fn, $ = id => document.getElementById(id);
  const NET = () => window.RFNet || null;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  const reduced = () => document.body.classList.contains('rf-reduced');
  const pix = (n, s) => { try { return F.pixSVG(n, s); } catch (e) { return ''; } };
  const say = o => { try { return (RF.api && RF.api.notify) ? RF.api.notify(o)
    : (F.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : ''), null); }
    catch (e) { RF.warn('09-social:say', e); return null; } };
  const beepy = k => { try { RF.sfx[k](); } catch (e) {} };
  const hhmm = t => { const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const secs = ms => (ms / 1000) < 10 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));

  /* ---- persistence: the hide list and the last tab, nothing else. Chat text
     never touches the disk — it is other people's words, not our save. ------ */
  const KEY = '09-social';
  const db = { v: 1, hide: [], tab: 'link' };
  try { const raw = RF.store.get(KEY);
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.hide)) db.hide = raw.hide.filter(n => typeof n === 'string').slice(0, 120);
      if (raw.tab === 'link' || raw.tab === 'people' || raw.tab === 'chat') db.tab = raw.tab;
    } } catch (e) { RF.warn('09-social:load', e); }
  let saveT = 0;
  const save = () => { if (saveT) return;
    saveT = setTimeout(() => { saveT = 0; RF.store.set(KEY, db); }, 500); };
  const hidden = new Set(db.hide);

  /* ======================================================================
     1. WHAT THE NET IS DOING — one place that reads RFNet, never writes it
     ====================================================================== */
  let seen = false;            // a backend answered, ever · gates every pixel below
  let roomWorld = '';          // the world the SERVER put us in (welcome frame)
  let headTotal = -1;          // anglers online, from health/online
  let rooms = null;            // per-isle head count, from /api/online
  let roomsAt = 0;
  const facts = () => { const N = NET();
    const has = !!N, base = has ? (N.base || '') : '';
    const ws = has ? N.ws : null;
    const rs = ws ? ws.readyState : -1;
    return { has, base, reachable: !!(has && N.reachable), signed: !!(has && N.token),
      user: has ? (N.user || '') : '', wallet: has ? (N.wallet || '') : '',
      online: !!(has && N.online), wsReady: !!(has && N.wsReady), rs,
      wsLabel: rs === 0 ? 'connecting' : rs === 1 ? 'open' : rs === 2 ? 'closing' : ws ? 'closed' : 'not connected',
      last: has ? (N.lastError || '') : '' };
  };

  /* ---- the retry clock. net.js backs off silently; we read the same numbers
     it is about to use so the player sees the wait instead of guessing. ---- */
  const retry = { waiting: false, at: 0, wait: 0, attempt: 0, since: 0 };
  const nextWait = n => Math.min(30000, 1000 * Math.pow(2, n));

  /* ---- latency ring ---- */
  const SAMP = 40, samples = [];
  let pingWay = 'health', pingBusy = false, lastPing = -1, pingT = 0;
  const pushSample = ms => { samples.push(ms); if (samples.length > SAMP) samples.shift();
    if (ms >= 0) lastPing = ms; drawSpark(); };
  const okSamples = () => samples.filter(s => s >= 0);
  const bandOf = ms => ms < 0 ? 'na' : ms < 90 ? 'a' : ms < 220 ? 'b' : ms < 450 ? 'c' : 'd';
  const BANDC = { a: 'var(--teal)', b: 'var(--c-uncommon)', c: 'var(--gold)', d: 'var(--rose)', na: 'var(--faint)' };
  const BANDW = { a: 'excellent', b: 'good', c: 'sluggish', d: 'painful', na: 'unknown' };

  /* One fetch helper. Core already talks to base+/api/derby the same way, so
     this adds no new kind of traffic — only a cheaper endpoint to time. */
  function getJSON(url, ms) {
    return new Promise((resolve, reject) => {
      let ctl = null, timer = 0;
      try { ctl = new AbortController(); timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms || 8000); }
      catch (e) { ctl = null; }
      fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(res => {
        if (timer) clearTimeout(timer);
        if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
        return res.json();
      }).then(resolve).catch(e => { if (timer) clearTimeout(timer); reject(e); });
    });
  }

  /* SPEC §12: /api/health is the endpoint to time — it touches no database.
     RFNet has no method for it, so we step down through what RFNet does expose
     the moment the server answers anything but 200. */
  async function sample() {
    const N = NET();
    if (!N || !N.online || pingBusy) return;          // never sample while offline
    if (document.hidden) return;
    pingBusy = true;
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    try {
      let d = null;
      if (pingWay === 'health') d = await getJSON(N.base + '/api/health', 8000);
      else if (pingWay === 'online') d = await N.online_();
      else d = await N.leaderboard();
      const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      pushSample(Math.max(0, Math.round(t1 - t0)));
      if (d && typeof d.online === 'number') headTotal = d.online;
      else if (d && typeof d.total === 'number') headTotal = d.total;
      seen = true; netOK();
    } catch (e) {
      /* An HTTP answer means the endpoint is wrong, not the line. Step down once
         and try the next cheapest thing rather than reporting a false outage. */
      if (e && e.status && pingWay !== 'board') { pingWay = pingWay === 'health' ? 'online' : 'board'; }
      else { pushSample(-1); netFail(e, 'ping'); }
    } finally { pingBusy = false; }
  }

  async function reprobe() {
    const N = NET(); if (!N || !N.base) return false;
    try { const ok = await N.probe(); if (ok) { seen = true; netOK(); } return ok; }
    catch (e) { RF.warn('09-social:probe', e); return false; }
  }

  /* ======================================================================
     2. PLAIN LANGUAGE — SPEC §12, said the way a person would say it
     ====================================================================== */
  const CODE_SAY = {
    UNAUTHENTICATED: ['Your sign-in expired. Sign in again and your island comes back with you.', 0],
    BAD_CREDENTIALS: ['That username and password did not match.', 0],
    BAD_USERNAME: ['The server would not take that username.', 0],
    BAD_PASSWORD: ['The server would not take that password.', 0],
    USERNAME_TAKEN: ['Someone already sails under that name · pick another.', 0],
    BAD_ADDRESS: ['The wallet gave an address the server could not read · trying again is safe.', 1],
    BAD_SIGNATURE: ['The wallet signature did not verify · trying again is safe.', 1],
    NONCE_EXPIRED: ['The sign-in challenge went stale · ask for a fresh one.', 1],
    GUEST_ALLOC_FAILED: ['The server could not build a guest island · try once more.', 1],
    RATE_LIMIT: ['You are moving faster than the server allows · wait out the cooldown exactly.', 1],
    UNKNOWN_ACTION: ['This page and the server are out of step · a reload is the fix.', 0],
    ACTION_REJECTED: ['The server refused that move on purpose · it will refuse it again.', 0],
    ACTION_FAILED: ['The server tripped on its side · one retry is fair, then play offline.', 1],
    INTERNAL: ['Server-side trouble · one retry is fair, then play offline.', 1],
    SAVE_UNREADABLE: ['Your save was refused, not overwritten · nothing was lost, retry in ~30s.', 1],
    MALFORMED_JSON: ['The client sent something unparseable · that is a bug here, not you.', 0],
    PAYLOAD_TOO_LARGE: ['The client sent more than the server accepts · a bug here, not you.', 0],
    NOT_FOUND: ['Nothing is listening at that address · wrong URL, or an older server.', 0],
    FORBIDDEN: ['This account is not allowed to do that.', 0],
    LEDGER_DISABLED: ['Deed claiming is switched off on this server.', 0],
    BAD_DEED_ID: ['That deed id is not one the server knows.', 0],
    DEED_NOT_MINTED: ['That deed has not been minted yet.', 0],
    CLAIM_FAILED: ['The claim did not go through · try again shortly.', 1],
    LEADERBOARD_UNAVAILABLE: ['A passing server hiccup · it usually clears in a moment.', 1],
    UNAVAILABLE: ['A passing server hiccup · it usually clears in a moment.', 1],
    REPORT_FAILED: ['The report did not reach the server · try again shortly.', 1],
    ADMIT_FAILED: ['That berth could not be granted right now · try again shortly.', 1]
  };
  const CREW_CODES = /^(ALREADY_ABOARD|CREW_FULL|NO_SUCH_CAPTAIN|HOSTING_CREW|CAPTAIN_IS_GUEST|HULL_HAS_NO_BERTHS|ALREADY_WAITING|TOO_MANY_REQUESTS_OUT|GUEST_ELSEWHERE|NOT_WAITING|NOT_ABOARD|OWN_BOAT|CREW_REJECTED)$/;

  /* Returns [sentence, retryIsSafe]. Never matches on English copy — only on the
     stable code, then the status, then the shape of a failure with no answer. */
  function reading(status, code, msg) {
    if (code && CODE_SAY[code]) return CODE_SAY[code];
    if (code && CREW_CODES.test(code)) return [msg || 'The server already explained that one in full.', 0];
    const st = status | 0;
    if (!st) return [/abort/i.test(msg || '') ? 'The request ran out of time before the server answered.'
      : 'Nothing answered at all · the server is down, asleep, or this browser has no route to it.', 1];
    if (st === 401) return CODE_SAY.UNAUTHENTICATED;
    if (st === 429) return CODE_SAY.RATE_LIMIT;
    if (st === 404) return CODE_SAY.NOT_FOUND;
    if (st === 403) return CODE_SAY.FORBIDDEN;
    if (st >= 500) return ['The server hit an error on its side · retry once, then fall back to offline.', 1];
    if (st >= 400) return ['The server rejected that request and will reject it again · do not retry.', 0];
    return ['Answered ' + st + ' · nothing to worry about.', 0];
  }

  const lastErr = { t: 0, where: '', status: 0, code: '', msg: '' };
  const noteErr = (where, status, code, msg) => {
    lastErr.t = Date.now(); lastErr.where = where; lastErr.status = status | 0;
    lastErr.code = code || ''; lastErr.msg = msg || '';
    if (open && db.tab === 'link') paintErr();
  };

  /* ======================================================================
     3. FAILURE HANDLING — exactly two cards, both tagged, both updated
     ====================================================================== */
  let netStreak = 0, netFirst = 0, offCard = null, authCard = 0;
  function netFail(e, where) {
    const st = (e && e.status) | 0;
    const code = (e && e.data && e.data.code) || '';
    noteErr(where, st, code, (e && e.message) || '');
    if (st && st < 500 && st !== 429) return;          // a refusal is not an outage
    const now = Date.now();
    if (!netStreak || now - netFirst > 120000) { netStreak = 0; netFirst = now; }
    netStreak++;
    if (netStreak < 3) return;
    const body = 'The server has missed ' + netStreak + ' calls in a row. The game keeps running on '
      + 'this browser’s own save · fishing, mining and selling still work, but nothing you do now '
      + 'reaches your account until the line comes back.';
    if (offCard) offCard.update({ body: body });
    else offCard = say({ level: 'warn', tag: 'rf-social-net', icon: 'storm', ttl: 0,
      title: 'Fallen back to offline play', body: body, where: 'social:' + where,
      actions: [{ label: 'Connection', key: true, fn: () => showPanel('link') },
        { label: 'Test again', fn: () => { reprobe(); sample(); } }] });
  }
  function netOK() {
    netStreak = 0;
    if (offCard) { try { offCard.close(); } catch (e) {} offCard = null;
      say({ level: 'success', tag: 'rf-social-net', ttl: 5000, title: 'Back online',
        body: 'The server is answering again · the account is in charge from here.' }); }
  }

  RF.on('actionfail', function (ev) {
    try {
      if (!ev) return;
      const st = (ev.status | 0), e = ev.error;
      const code = (e && e.data && e.data.code) || '';
      noteErr('action:' + (ev.action || '?'), st, code, (e && e.message) || '');
      if (st === 401) {
        /* 00-notify already says "session expired". Ours is the way back, and it
           is raised once per expiry, not once per rejected action. */
        if (Date.now() - authCard < 90000) return;
        authCard = Date.now();
        say({ level: 'error', tag: 'rf-social-auth', icon: 'lock', ttl: 0,
          title: 'Signed out by the server',
          body: 'Your session expired, so the server stopped answering for this account. Sign in again '
            + 'and it hands your island straight back · nothing was lost.',
          where: 'action:' + ev.action,
          actions: [{ label: 'Sign in again', key: true, fn: toSignIn },
            { label: 'Connection', fn: () => showPanel('link') }] });
        return;
      }
      netFail(e || { status: st }, 'action:' + (ev.action || '?'));
    } catch (err) { RF.warn('09-social:actionfail', err); }
  });

  /* The way back is core's own sign-in panel: it owns adopting the server state
     and re-arming the socket, and reproducing that here would only fork it. */
  let reopened = false;
  function toSignIn() {
    try {
      const ov = $('start'); if (!ov) { say({ level: 'warn', title: 'Sign-in is on the title screen',
        body: 'Reload the page and sign in from there.' }); return; }
      hidePanel();
      reopened = true;
      ov.classList.add('on');
      const ways = $('acctWays'); if (ways) ways.style.display = 'flex';
      const form = $('acctForm'); if (form) form.style.display = 'flex';
      const st = $('acctStatus');
      if (st) { st.textContent = 'signed out · sign in again to put the server back in charge'; st.className = ''; }
      const u = $('acctUser'); if (u) setTimeout(() => { try { u.focus(); } catch (e) {} }, 80);
    } catch (e) { RF.err('09-social:signin', e); }
  }
  function leaveSignIn() {
    if (!reopened) return;
    reopened = false;
    const ov = $('start'); if (ov && RF.running) ov.classList.remove('on');
  }

  /* ======================================================================
     4. STYLE
     ====================================================================== */
  RF.css(`
  #rf-social-hud{position:fixed;bottom:48px;right:12px;z-index:28;display:none;align-items:center;gap:8px;}
  #rf-social-hud.on{display:flex;}
  body.photo #rf-social-hud,body.photo #rf-social-unread{display:none!important;}
  .rf-social-pill{display:flex;align-items:center;gap:7px;cursor:pointer;
    font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;letter-spacing:.06em;color:var(--ink);
    background:var(--glass-hud);backdrop-filter:blur(12px) saturate(1.5);-webkit-backdrop-filter:blur(12px) saturate(1.5);
    border:1px solid var(--glass-bd-soft);border-radius:9px;padding:6px 11px;
    box-shadow:var(--glass-hi),0 5px 16px rgba(2,8,10,.3);font-variant-numeric:tabular-nums;
    transition:border-color .15s;}
  .rf-social-pill:hover{border-color:var(--rf-social-c,var(--teal));}
  .rf-social-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--rf-social-c,var(--faint));
    box-shadow:0 0 9px var(--rf-social-c,var(--faint));}
  .rf-social-pill.live .dot{animation:rf-social-beat 2.4s ease-in-out infinite;}
  .rf-social-pill .ms{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:10px;color:var(--muted);}
  @keyframes rf-social-beat{0%,100%{opacity:1;}50%{opacity:.35;}}
  body.rf-reduced .rf-social-pill.live .dot{animation:none;}
  .rf-social-track{display:none;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--ink);
    background:var(--glass-hud);backdrop-filter:blur(12px) saturate(1.5);-webkit-backdrop-filter:blur(12px) saturate(1.5);
    border:1px solid rgba(57,215,196,.45);border-radius:9px;padding:5px 10px;
    box-shadow:var(--glass-hi),0 5px 16px rgba(2,8,10,.3);font-variant-numeric:tabular-nums;max-width:44vw;}
  .rf-social-track.on{display:flex;}
  .rf-social-track .arw{width:13px;height:13px;flex:0 0 auto;color:var(--teal);}
  .rf-social-track .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
  .rf-social-track .dd{color:var(--muted);font-size:10px;}

  #rf-social-unread{position:fixed;left:12px;bottom:14px;z-index:28;display:none;align-items:center;gap:7px;
    cursor:pointer;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;letter-spacing:.06em;
    color:var(--teal);background:var(--glass-hud);backdrop-filter:blur(12px) saturate(1.5);
    -webkit-backdrop-filter:blur(12px) saturate(1.5);border:1px solid rgba(57,215,196,.5);
    border-radius:9px;padding:6px 11px;box-shadow:var(--glass-hi),0 5px 16px rgba(2,8,10,.3);}
  #rf-social-unread.on{display:flex;}
  #rf-social-unread .k{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:9px;
    letter-spacing:.2em;color:var(--faint);}
  .rf-social-time{font-style:normal;font-size:9px;color:var(--faint);margin-right:5px;
    font-variant-numeric:tabular-nums;letter-spacing:.04em;}
  .rf-social-helpcard{font-size:10.5px;line-height:1.6;color:var(--muted);background:var(--glass-hud);
    backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(57,215,196,.4);
    border-radius:9px;padding:7px 10px;white-space:pre-line;align-self:flex-start;max-width:100%;
    box-shadow:0 3px 10px rgba(2,8,10,.3);}
  .rf-social-helpcard b{color:var(--teal);font-weight:600;}

  #rf-social{position:fixed;inset:0;z-index:24;display:none;align-items:center;justify-content:center;
    background:rgba(3,10,12,.42);backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);}
  #rf-social.on{display:flex;}
  body.photo #rf-social{display:none!important;}
  .rf-social-card{width:min(700px,95vw);max-height:88vh;display:flex;flex-direction:column;
    font-size:calc(13px * var(--rf-ui-scale,1));
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:18px;padding:17px 19px 14px;
    box-shadow:var(--glass-hi),0 30px 80px rgba(0,0,0,.5);}
  .rf-social-head{display:flex;align-items:flex-start;gap:14px;}
  .rf-social-head .ttl{flex:1;min-width:0;}
  .rf-social-head .eyebrow{font-size:9px;letter-spacing:.34em;color:var(--rf-social-c,var(--teal));text-transform:uppercase;}
  .rf-social-head h2{font-family:"Chakra Petch",sans-serif;font-size:calc(21px * var(--rf-ui-scale,1));
    font-weight:700;color:var(--ink);line-height:1.15;margin:1px 0 0;}
  .rf-social-head .sub{font-size:10.5px;color:var(--muted);margin-top:3px;}
  .rf-social-head .lat{text-align:right;flex:0 0 auto;}
  .rf-social-head .lat .big{font-family:"Chakra Petch",sans-serif;font-weight:700;font-variant-numeric:tabular-nums;
    font-size:calc(24px * var(--rf-ui-scale,1));color:var(--rf-social-c,var(--teal));line-height:1;}
  .rf-social-head .lat .lab{font-size:8.5px;letter-spacing:.24em;color:var(--lab);margin-top:3px;}
  .rf-social-x{font-size:11px;color:var(--muted);background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:8px;padding:6px 10px;cursor:pointer;letter-spacing:.1em;font-family:inherit;align-self:flex-start;}
  .rf-social-x:hover{border-color:var(--rose);color:var(--rose);}
  .rf-social-tabs{display:flex;gap:7px;margin:12px 0 10px;}
  .rf-social-tab{flex:1;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;letter-spacing:.14em;
    color:var(--muted);background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:10px;
    padding:7px 4px;cursor:pointer;transition:color .12s,border-color .12s;}
  .rf-social-tab:hover{color:var(--ink);}
  .rf-social-tab.sel{color:var(--rf-social-c,var(--teal));border-color:var(--rf-social-c,var(--teal));
    background:rgba(57,215,196,.08);}
  .rf-social-body{overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;padding-right:3px;}
  .rf-social-body::-webkit-scrollbar{width:5px;}
  .rf-social-body::-webkit-scrollbar-thumb{background:var(--glass-bd);border-radius:3px;}
  .rf-social-pane{display:none;}
  .rf-social-pane.sel{display:block;}
  .rf-social-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:6px;}
  .rf-social-fact{display:flex;align-items:center;gap:8px;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-radius:10px;padding:7px 10px;min-width:0;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rf-social-fact .d{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 7px currentColor;}
  .rf-social-fact .k{font-size:8.5px;letter-spacing:.2em;color:var(--lab);text-transform:uppercase;}
  .rf-social-fact .v{font-size:11.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font-variant-numeric:tabular-nums;}
  .rf-social-fact .col{min-width:0;flex:1;}
  .rf-social-sec{font-size:9px;letter-spacing:.3em;color:var(--lab);text-transform:uppercase;margin:12px 0 6px;}
  .rf-social-box{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:11px;
    padding:9px 11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rf-social-lat{display:flex;align-items:center;gap:11px;}
  .rf-social-lat canvas{flex:0 0 auto;border-radius:6px;background:rgba(255,255,255,.04);image-rendering:auto;}
  .rf-social-lat .num{flex:1;min-width:0;font-size:11px;color:var(--muted);line-height:1.6;
    font-variant-numeric:tabular-nums;}
  .rf-social-lat .num b{color:var(--ink);font-weight:600;}
  .rf-social-retry{display:none;margin-top:6px;align-items:center;gap:9px;border-color:rgba(255,207,92,.4);}
  .rf-social-retry.on{display:flex;}
  .rf-social-retry .t{flex:1;min-width:0;font-size:11px;color:var(--gold);font-variant-numeric:tabular-nums;}
  .rf-social-btn{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:10.5px;letter-spacing:.1em;
    color:var(--teal);background:rgba(57,215,196,.08);border:1px solid rgba(57,215,196,.45);border-radius:9px;
    padding:6px 11px;cursor:pointer;flex:0 0 auto;transition:transform .08s,border-color .12s;}
  .rf-social-btn:hover:not(:disabled){transform:translateY(-1px);border-color:var(--teal);}
  .rf-social-btn:disabled{opacity:.4;cursor:default;}
  .rf-social-btn.ghost{color:var(--muted);background:var(--glass-row);border-color:var(--glass-bd-soft);}
  .rf-social-btn.ghost:hover{color:var(--ink);}
  .rf-social-err{font-size:11px;color:var(--muted);line-height:1.6;}
  .rf-social-err b{color:var(--ink);font-weight:600;}
  .rf-social-err .cd{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--rose);letter-spacing:.06em;}
  .rf-social-err .ok{color:var(--c-uncommon);}
  .rf-social-adv{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
  .rf-social-adv input{flex:1;min-width:150px;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink);
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:9px;padding:7px 10px;outline:none;}
  .rf-social-adv input:focus{border-color:rgba(57,215,196,.6);}
  .rf-social-note{font-size:9.5px;color:#6f8f8a;line-height:1.55;margin-top:6px;}
  .rf-social-row{display:flex;align-items:center;gap:10px;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-radius:11px;padding:8px 11px;margin-bottom:5px;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.07);cursor:pointer;}
  .rf-social-row:hover{border-color:rgba(57,215,196,.5);}
  .rf-social-row.trk{border-color:var(--teal);box-shadow:inset 0 0 0 1px rgba(57,215,196,.3),0 0 14px rgba(57,215,196,.14);}
  .rf-social-row .who{flex:1;min-width:0;}
  .rf-social-row .who .n{font-size:12.5px;font-weight:600;color:var(--ink);overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;}
  .rf-social-row .who .t{font-size:9.5px;color:var(--teal);letter-spacing:.06em;}
  .rf-social-row .far{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;color:var(--gold);
    font-variant-numeric:tabular-nums;flex:0 0 auto;}
  .rf-social-row .act{font-size:9px;letter-spacing:.16em;color:var(--faint);flex:0 0 auto;text-transform:uppercase;}
  .rf-social-chips{display:flex;flex-wrap:wrap;gap:5px;}
  .rf-social-chip{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:8px;padding:4px 9px;
    font-variant-numeric:tabular-nums;}
  .rf-social-chip b{color:var(--ink);font-weight:600;}
  .rf-social-chip button{font:inherit;color:var(--faint);background:none;border:0;cursor:pointer;padding:0 0 0 2px;}
  .rf-social-chip button:hover{color:var(--rose);}
  .rf-social-empty{font-size:11px;color:var(--faint);text-align:center;padding:16px 8px;line-height:1.7;}
  .rf-social-log{max-height:34vh;overflow-y:auto;display:flex;flex-direction:column;gap:3px;}
  .rf-social-log::-webkit-scrollbar{width:5px;}
  .rf-social-log::-webkit-scrollbar-thumb{background:var(--glass-bd);border-radius:3px;}
  .rf-social-line{font-size:11px;line-height:1.5;color:var(--ink);word-break:break-word;}
  .rf-social-line .tm{font-size:9px;color:var(--faint);margin-right:6px;font-variant-numeric:tabular-nums;}
  .rf-social-line .nm{color:var(--teal);font-weight:600;cursor:pointer;}
  .rf-social-line .nm:hover{color:var(--rose);}
  .rf-social-line.sys{color:var(--muted);font-style:italic;}
  .rf-social-line.hid{opacity:.4;text-decoration:line-through;}
  .rf-social-cmd{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:11px;color:var(--muted);
    line-height:1.6;align-items:baseline;}
  .rf-social-cmd code{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--teal);white-space:nowrap;}
  `, 'rf-social-css');

  /* ======================================================================
     5. THE HUD — a pill, a track chip, an unread badge
     ====================================================================== */
  const hud = RF.el(`<div id="rf-social-hud">
    <div class="rf-social-track" id="rf-social-track" title="stop pointing at them">
      <svg class="arw" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 L13 12 L8 9.4 L3 12 Z" fill="currentColor"/></svg>
      <span class="nm" id="rf-social-tname">—</span><span class="dd" id="rf-social-tdist"></span>
    </div>
    <div class="rf-social-pill" id="rf-social-pill" title="connection · Y">
      <span class="dot"></span><span id="rf-social-plabel">OFFLINE</span><span class="ms" id="rf-social-pms"></span>
    </div>
  </div>`);
  const unreadEl = RF.el('<div id="rf-social-unread"><span id="rf-social-uc">1 new</span><span class="k">CHAT</span></div>');
  const pillEl = $('rf-social-pill'), pLabel = $('rf-social-plabel'), pMs = $('rf-social-pms');
  const trackEl = $('rf-social-track'), tNameEl = $('rf-social-tname'), tDistEl = $('rf-social-tdist');
  const trackArw = trackEl ? trackEl.querySelector('.arw') : null;

  /* The notify pill owns the bottom-right corner; measure it and sit to its left
     rather than guessing a gap that a wording change would break. */
  function layoutHud() {
    if (!hud) return;
    let right = 12;
    try { const np = $('rf-notify-pill');
      if (np && np.offsetParent !== null) { const w = np.offsetWidth; if (w > 0) right = 12 + w + 8; }
    } catch (e) {}
    if (hud._r !== right) { hud._r = right; hud.style.right = right + 'px'; }
  }

  function pillState() {
    const f = facts();
    if (!f.online) return f.signed ? ['CONNECTING', 'c', false] : ['OFFLINE', 'na', false];
    if (f.wsReady) return ['ONLINE', bandOf(lastPing), true];
    if (retry.waiting || f.rs === 0) return ['CONNECTING', 'c', true];
    return ['ONLINE', bandOf(lastPing), true];
  }
  function syncHud() {
    if (!hud) return;
    const show = seen && RF.running && !RF.panelOpen && !open && !(function () {
      const ov = $('start'); return !!(ov && ov.classList.contains('on')); })();
    hud.classList.toggle('on', !!show);
    if (!show) { if (unreadEl) unreadEl.classList.remove('on'); return; }
    const st = pillState();
    if (pLabel && pLabel.textContent !== st[0]) pLabel.textContent = st[0];
    const ms = (st[0] === 'ONLINE' && lastPing >= 0) ? lastPing + ' ms' : '';
    if (pMs && pMs.textContent !== ms) pMs.textContent = ms;
    if (pillEl) { pillEl.style.setProperty('--rf-social-c', BANDC[st[1]] || BANDC.na);
      pillEl.classList.toggle('live', !!st[2]); }
    layoutHud();
    /* the badge only ever appears while the chat itself has faded out, so the two
       can never sit on top of each other in the corner */
    const cb = $('chat');
    const faded = !(cb && cb.classList.contains('show'));
    if (unreadEl) { const on = unread > 0 && faded && !RF.chatOpen;
      unreadEl.classList.toggle('on', on);
      if (on) { const t = unread + ' new'; const u = $('rf-social-uc');
        if (u && u.textContent !== t) u.textContent = t; } }
  }
  if (pillEl) pillEl.onclick = () => showPanel('link');
  if (unreadEl) unreadEl.onclick = () => { showPanel('chat'); };

  /* ======================================================================
     6. THE PANEL
     ====================================================================== */
  const root = RF.el(`<div id="rf-social">
    <div class="rf-social-card">
      <div class="rf-social-head">
        <div class="ttl">
          <div class="eyebrow">CONNECTION · Y</div>
          <h2>The Line Home</h2>
          <div class="sub" id="rf-social-sub">offline</div>
        </div>
        <div class="lat"><div class="big" id="rf-social-big">—</div><div class="lab">ROUND TRIP</div></div>
        <button class="rf-social-x" id="rf-social-x" type="button">ESC</button>
      </div>
      <div class="rf-social-tabs">
        <button class="rf-social-tab" data-rf-social-tab="link" type="button">LINK</button>
        <button class="rf-social-tab" data-rf-social-tab="people" type="button">PEOPLE</button>
        <button class="rf-social-tab" data-rf-social-tab="chat" type="button">CHAT</button>
      </div>
      <div class="rf-social-body">
        <div class="rf-social-pane" data-rf-social-pane="link">
          <div class="rf-social-grid" id="rf-social-facts"></div>
          <div class="rf-social-sec">round trip</div>
          <div class="rf-social-box rf-social-lat">
            <canvas id="rf-social-spark" width="132" height="34"></canvas>
            <div class="num" id="rf-social-latnum">no samples yet</div>
          </div>
          <div class="rf-social-box rf-social-retry" id="rf-social-retryrow">
            <span class="t" id="rf-social-retryt">reconnecting…</span>
            <button class="rf-social-btn" id="rf-social-recon" type="button">RECONNECT NOW</button>
          </div>
          <div class="rf-social-sec">last trouble</div>
          <div class="rf-social-box rf-social-err" id="rf-social-errbox">Nothing has gone wrong yet.</div>
          <div class="rf-social-sec">server address</div>
          <div class="rf-social-box">
            <div class="rf-social-adv">
              <input id="rf-social-base" type="text" spellcheck="false" placeholder="https://your-server:8080" maxlength="200">
              <button class="rf-social-btn" id="rf-social-usebase" type="button">USE</button>
              <button class="rf-social-btn ghost" id="rf-social-probe" type="button">TEST</button>
              <button class="rf-social-btn ghost" id="rf-social-tosign" type="button">SIGN IN</button>
            </div>
            <div class="rf-social-note">Opened from a file, the game has no address to guess · point it at your own
              server and it will hand the economy over. Changing this reloads the page so the server can deal the
              first hand.</div>
          </div>
        </div>
        <div class="rf-social-pane" data-rf-social-pane="people">
          <div class="rf-social-box" style="margin-bottom:9px">
            <div class="rf-social-fact" style="background:none;border:0;padding:0;box-shadow:none">
              <span class="d" id="rf-social-hdot" style="color:var(--teal);background:currentColor"></span>
              <div class="col"><div class="k">anglers online</div><div class="v" id="rf-social-head">—</div></div>
            </div>
            <div class="rf-social-chips" id="rf-social-rooms" style="margin-top:8px"></div>
          </div>
          <div class="rf-social-sec">on this isle</div>
          <div id="rf-social-peers"></div>
        </div>
        <div class="rf-social-pane" data-rf-social-pane="chat">
          <div class="rf-social-sec">scrollback</div>
          <div class="rf-social-box rf-social-log" id="rf-social-scroll"></div>
          <div class="rf-social-sec">hidden here</div>
          <div class="rf-social-box"><div class="rf-social-chips" id="rf-social-hidden"></div>
            <div class="rf-social-note" id="rf-social-mutenote"></div></div>
          <div class="rf-social-sec">chat commands</div>
          <div class="rf-social-box rf-social-cmd" id="rf-social-cmds"></div>
        </div>
      </div>
    </div>
  </div>`);

  let open = false;
  const paneOf = k => root ? root.querySelector('[data-rf-social-pane="' + k + '"]') : null;
  function setTab(k) {
    db.tab = k; save();
    if (!root) return;
    root.querySelectorAll('.rf-social-tab').forEach(b =>
      b.classList.toggle('sel', b.getAttribute('data-rf-social-tab') === k));
    root.querySelectorAll('.rf-social-pane').forEach(p =>
      p.classList.toggle('sel', p.getAttribute('data-rf-social-pane') === k));
    if (k === 'people') { fetchRooms(); renderPeers(true); }
    if (k === 'chat') { renderScroll(); renderHidden(); markRead(); }
    if (k === 'link') { paintFacts(); paintLat(); paintErr(); drawSpark(); }
  }
  function showPanel(tab) {
    if (open) { if (tab) setTab(tab); return; }
    open = true; root.classList.add('on'); beepy('open');
    setTab(tab || db.tab || 'link');
    paintHead(); syncHud();
    const bi = $('rf-social-base'); const N = NET();
    if (bi && N && document.activeElement !== bi) bi.value = N.base || '';
    if (facts().online) sample();
  }
  function hidePanel() { if (!open) return; open = false; root.classList.remove('on'); beepy('close'); syncHud(); }
  { const x = $('rf-social-x'); if (x) x.onclick = hidePanel; }
  if (root) root.addEventListener('click', e => { if (e.target === root) hidePanel(); });
  if (root) root.querySelectorAll('.rf-social-tab').forEach(b => {
    b.onclick = () => { beepy('tab'); setTab(b.getAttribute('data-rf-social-tab')); }; });

  /* ---- head ---- */
  function paintHead() {
    const f = facts(), sub = $('rf-social-sub'), big = $('rf-social-big');
    if (sub) sub.textContent = !f.has ? 'net.js never loaded · offline for good'
      : !f.base ? 'no server address · playing from this browser alone'
      : !f.reachable ? 'no answer from ' + f.base
      : !f.signed ? 'a server is there · not signed in'
      : f.wsReady ? 'signed in as ' + f.user + ' · socket open'
      : 'signed in as ' + f.user + ' · socket ' + f.wsLabel;
    if (big) { const on = f.online && lastPing >= 0;
      big.textContent = on ? String(lastPing) : '—';
      big.style.color = on ? BANDC[bandOf(lastPing)] : 'var(--faint)'; }
    if (root) root.style.setProperty('--rf-social-c',
      f.online ? (lastPing >= 0 ? BANDC[bandOf(lastPing)] : 'var(--teal)') : 'var(--faint)');
  }

  /* ---- LINK: the facts grid ---- */
  const fact = (k, v, col) => '<div class="rf-social-fact"><span class="d" style="color:' + col
    + ';background:currentColor"></span><div class="col"><div class="k">' + esc(k)
    + '</div><div class="v" title="' + esc(v) + '">' + esc(v) + '</div></div></div>';
  function paintFacts() {
    const box = $('rf-social-facts'); if (!box) return;
    const f = facts();
    const G = 'var(--c-uncommon)', Y = 'var(--gold)', R = 'var(--rose)', M = 'var(--faint)';
    let h = '';
    h += fact('server', f.base || '(none)', f.base ? (f.reachable ? G : R) : M);
    h += fact('probe', !f.base ? 'nothing to probe' : f.reachable ? 'answered' : 'silent', f.reachable ? G : f.base ? R : M);
    h += fact('signed in', f.signed ? (f.wallet ? f.wallet.slice(0, 6) + '…' + f.wallet.slice(-4) : f.user || 'yes') : 'no',
      f.signed ? G : M);
    h += fact('websocket', f.wsLabel, f.wsReady ? G : f.rs === 0 ? Y : f.signed ? R : M);
    h += fact('isle', (RF.WORLD && RF.WORLD.name) || RF.worldKey || '?',
      roomWorld && roomWorld !== RF.worldKey ? Y : M);
    h += fact('anglers online', headTotal >= 0 ? String(headTotal) : 'unknown', headTotal > 0 ? G : M);
    h += fact('nearby', String(RF.peers ? RF.peers.size : 0), (RF.peers && RF.peers.size) ? G : M);
    h += fact('economy', f.online ? 'the server decides' : 'this browser decides', f.online ? G : Y);
    box.innerHTML = h;
    if (roomWorld && roomWorld !== RF.worldKey) box.insertAdjacentHTML('beforeend',
      fact('room mismatch', 'server put you on ' + roomWorld, Y));
  }

  /* ---- LINK: the sparkline ---- */
  const spark = $('rf-social-spark');
  const sctx = (function () { try { return spark ? spark.getContext('2d') : null; } catch (e) { return null; } })();
  function drawSpark() {
    if (!sctx || !spark) return;
    const w = spark.width, h = spark.height;
    sctx.clearRect(0, 0, w, h);
    const ok = okSamples();
    if (!ok.length) return;
    const hi = Math.max(60, Math.max.apply(null, ok));
    const n = samples.length, step = n > 1 ? (w - 2) / (n - 1) : 0;
    sctx.lineWidth = 1.5; sctx.lineJoin = 'round';
    sctx.strokeStyle = BANDC[bandOf(lastPing)] || BANDC.na;
    sctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      const x = 1 + i * step;
      if (v < 0) { started = false;                        // a miss breaks the line
        sctx.stroke(); sctx.beginPath();
        sctx.fillStyle = 'rgba(255,93,122,.75)'; sctx.fillRect(x - 1, h - 4, 2, 4); continue; }
      const y = h - 2 - (v / hi) * (h - 5);
      if (!started) { sctx.moveTo(x, y); started = true; } else sctx.lineTo(x, y);
    }
    sctx.stroke();
    sctx.fillStyle = 'rgba(255,255,255,.10)';
    sctx.fillRect(0, h - 1, w, 1);
  }
  function paintLat() {
    const el = $('rf-social-latnum'); if (!el) return;
    const ok = okSamples(), miss = samples.length - ok.length;
    if (!ok.length) { el.innerHTML = facts().online
      ? 'sampling ' + esc(pingWay === 'health' ? '/api/health' : pingWay === 'online' ? '/api/online' : '/api/leaderboard')
        + ' every 20s…'
      : 'not sampling · nothing to sample while offline'; return; }
    let lo = 1e9, hi = 0, sum = 0;
    for (const v of ok) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    const avg = Math.round(sum / ok.length);
    el.innerHTML = '<b>' + lastPing + ' ms</b> now · ' + BANDW[bandOf(lastPing)]
      + '<br>' + lo + ' low · ' + avg + ' avg · ' + hi + ' high, over ' + ok.length + ' sample'
      + (ok.length === 1 ? '' : 's') + (miss ? ' · <span style="color:var(--rose)">' + miss + ' missed</span>' : '');
  }
  function paintErr() {
    const el = $('rf-social-errbox'); if (!el) return;
    const N = NET();
    if (!lastErr.t) { el.innerHTML = (N && N.lastError)
      ? '<b>' + esc(N.lastError) + '</b><br>' + esc(reading(0, '', N.lastError)[0])
      : 'Nothing has gone wrong yet.'; return; }
    const r = reading(lastErr.status, lastErr.code, lastErr.msg);
    el.innerHTML = '<b>' + esc(lastErr.msg || 'no message') + '</b>'
      + ' <span class="cd">' + esc(lastErr.code || (lastErr.status ? 'HTTP ' + lastErr.status : 'no answer')) + '</span>'
      + '<br>' + esc(r[0])
      + '<br><span class="' + (r[1] ? 'ok' : 'cd') + '">' + (r[1] ? 'retrying is safe' : 'retrying will not help')
      + '</span> · ' + esc(lastErr.where) + ' · ' + hhmm(lastErr.t);
  }

  /* ---- LINK: the retry clock ---- */
  function paintRetry() {
    const row = $('rf-social-retryrow'), t = $('rf-social-retryt'), b = $('rf-social-recon');
    if (!row) return;
    const f = facts();
    const show = f.signed && !f.wsReady;
    row.classList.toggle('on', show);
    if (!show || !t) return;
    if (retry.waiting && retry.at) {
      const left = Math.max(0, retry.at - Date.now());
      t.textContent = left > 250
        ? 'reconnecting in ' + secs(left) + 's · attempt ' + retry.attempt
        : 'reconnecting now · attempt ' + retry.attempt;
    } else if (f.rs === 0) t.textContent = 'opening the socket…';
    else if (!f.online) t.textContent = 'not retrying · the server is not answering, so there is nothing to hold open';
    else t.textContent = 'socket closed · press reconnect to open it again';
    if (b) b.disabled = !f.online;
  }
  { const b = $('rf-social-recon');
    if (b) b.onclick = () => { const N = NET(); if (!N || !N.online) return;
      try {
        const world = (typeof N._world === 'string' && N._world) || roomWorld || RF.worldKey;
        const meta = { title: RF.state.titleId || '', wardrobe: RF.state.wardrobe || {} };
        retry.waiting = false;
        N.connectWS(world, meta);
        beepy('click'); paintRetry();
      } catch (e) { RF.err('09-social:reconnect', e); } }; }

  /* ---- LINK: the address row ---- */
  { const use = $('rf-social-usebase'), test = $('rf-social-probe'), sign = $('rf-social-tosign');
    if (use) use.onclick = async () => {
      const N = NET(), inp = $('rf-social-base'); if (!N || !inp) return;
      const v = (inp.value || '').trim();
      if (v && !/^https?:\/\//i.test(v)) { say({ level: 'warn', title: 'That is not an address',
        body: 'It has to start with http:// or https://' }); return; }
      try { N.setBase(v); } catch (e) { RF.err('09-social:setbase', e); return; }
      paintFacts();
      if (!v) { say({ level: 'info', title: 'Server address cleared', body: 'Offline play only, from now on.' }); return; }
      const ok = await reprobe();
      paintFacts(); paintHead();
      say(ok ? { level: 'success', title: 'Server found', ttl: 0,
          body: 'A backend answered at ' + v + ' · reload to sign in and let it take the economy.',
          actions: [{ label: 'Reload', key: true, fn: () => location.reload() }] }
        : { level: 'warn', title: 'Nothing answered', body: 'No backend at ' + v + ' · check the port and that it is running.' });
    };
    if (test) test.onclick = async () => { const ok = await reprobe(); paintFacts(); paintHead(); paintErr();
      say(ok ? { level: 'success', ttl: 4000, title: 'Server answered' }
        : { level: 'warn', ttl: 6000, title: 'No answer', body: 'The probe came back empty · you are on your own save.' }); };
    if (sign) sign.onclick = toSignIn;
  }

  /* ======================================================================
     7. PRESENCE
     ====================================================================== */
  const meta = new Map();          // peer id -> {title}
  let tracked = null;
  const distTo = q => Math.hypot(q.x - RF.pWorld.x, q.z - RF.pWorld.z);
  const worldName = k => (RF.WORLDS && RF.WORLDS[k] && RF.WORLDS[k].name) || k || '?';
  function peerList() {
    const out = [];
    if (!RF.peers) return out;
    RF.peers.forEach((q, id) => { const m = meta.get(id);
      out.push({ id: id, name: q.name || 'angler', title: (m && m.title) || '',
        world: roomWorld || RF.worldKey, worldName: worldName(roomWorld || RF.worldKey),
        dist: distTo(q), act: q.act || '', x: q.x, y: q.y, z: q.z }); });
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }
  function setTrack(id) {
    tracked = (id != null && RF.peers && RF.peers.has(id)) ? id : null;
    if (trackEl) trackEl.classList.toggle('on', tracked != null);
    if (tracked != null) { const q = RF.peers.get(tracked);
      if (tNameEl) tNameEl.textContent = (q && q.name) || 'angler'; }
    if (open && db.tab === 'people') renderPeers(true);
    return tracked != null;
  }
  if (trackEl) trackEl.onclick = () => { setTrack(null); beepy('click'); };

  const rowPool = [];
  function takeRow() { const r = rowPool.pop();
    return r || RF.el('<div class="rf-social-row"><span class="ic"></span>'
      + '<span class="who"><span class="n"></span><span class="t"></span></span>'
      + '<span class="act"></span><span class="far"></span></div>', null); }
  let lastSig = '';
  function renderPeers(force) {
    const box = $('rf-social-peers'); if (!box) return;
    const list = peerList();
    const sig = list.map(p => p.id).join(',') + '|' + (tracked == null ? '' : tracked);
    if (sig !== lastSig || force) {
      lastSig = sig;
      while (box.firstChild) { const c = box.firstChild; box.removeChild(c);
        if (c.className === 'rf-social-row' && rowPool.length < 24) rowPool.push(c); }
      if (!list.length) { box.innerHTML = '<div class="rf-social-empty">'
        + (facts().wsReady ? 'You have the isle to yourself right now.'
          : 'Nobody to see from here · the socket is not open.') + '</div>'; return; }
      for (const p of list) {
        const r = takeRow();
        r.querySelector('.ic').innerHTML = pix('crew', 15);
        r.querySelector('.n').textContent = p.name;
        r.querySelector('.t').textContent = (p.title ? p.title + ' · ' : '') + p.worldName;
        r.querySelector('.act').textContent = p.act || '';
        r.querySelector('.far').textContent = Math.round(p.dist) + ' m';
        r.classList.toggle('trk', tracked === p.id);
        r.title = tracked === p.id ? 'stop pointing at them' : 'point the compass at ' + p.name;
        r._id = p.id;
        r.onclick = () => { setTrack(tracked === r._id ? null : r._id); beepy('click'); };
        box.appendChild(r);
      }
    } else {
      let i = 0;
      for (const c of box.children) { const p = list[i++]; if (!p) break;
        const far = c.querySelector && c.querySelector('.far');
        if (far) { const t = Math.round(p.dist) + ' m'; if (far.textContent !== t) far.textContent = t; }
        const act = c.querySelector && c.querySelector('.act');
        if (act && act.textContent !== (p.act || '')) act.textContent = p.act || ''; }
    }
  }
  async function fetchRooms() {
    const N = NET();
    if (!N || !N.online || Date.now() - roomsAt < 30000) { paintRooms(); return; }
    roomsAt = Date.now();
    try { const d = await N.online_();
      if (d && typeof d.total === 'number') headTotal = d.total;
      rooms = (d && d.rooms) || null; netOK(); }
    catch (e) { netFail(e, 'online'); }
    paintRooms();
  }
  function paintRooms() {
    const h = $('rf-social-head'), rb = $('rf-social-rooms');
    if (h) h.textContent = headTotal >= 0 ? headTotal + (headTotal === 1 ? ' angler' : ' anglers')
      : facts().online ? 'asking…' : 'unknown while offline';
    if (!rb) return;
    if (!rooms) { rb.innerHTML = ''; return; }
    let s = '';
    for (const k in rooms) s += '<span class="rf-social-chip">' + esc(worldName(k))
      + ' <b>' + (rooms[k] | 0) + '</b></span>';
    rb.innerHTML = s;
  }

  /* the tick: where they are, from where the camera is standing */
  const _v = RF.THREE ? new RF.THREE.Vector3() : null;
  let trkAcc = 0;
  function trackTick(dt) {
    if (tracked == null || !trackEl) return;
    trkAcc += dt; if (trkAcc < 0.1) return; trkAcc = 0;
    const q = RF.peers && RF.peers.get(tracked);
    if (!q) { setTrack(null); return; }
    const d = distTo(q);
    if (tDistEl) { const t = Math.round(d) + ' m'; if (tDistEl.textContent !== t) tDistEl.textContent = t; }
    if (_v && trackArw && RF.camera) {
      _v.set(q.x, q.y + 1, q.z).project(RF.camera);
      const a = Math.atan2(-_v.y, _v.x) + Math.PI / 2;    // the glyph points up at 0
      trackArw.style.transform = 'rotate(' + a.toFixed(3) + 'rad)';
    }
  }

  RF.api = RF.api || {};
  RF.api.social = {
    peers: () => { try { return peerList(); } catch (e) { RF.warn('09-social:peers', e); return []; } },
    track: id => { try { return setTrack(id); } catch (e) { RF.warn('09-social:track', e); return false; } },
    tracked: () => { try { if (tracked == null) return null;
      return peerList().find(p => p.id === tracked) || null; } catch (e) { return null; } },
    latency: () => lastPing,
    status: () => { const f = facts(); return f.online ? (f.wsReady ? 'online' : 'connecting') : 'offline'; }
  };

  /* ======================================================================
     8. CHAT COMFORT — core owns the DOM and the T key; we decorate around it
     ====================================================================== */
  const SCROLL = 400, back = [];
  let unread = 0;
  const chatLogEl = $('chatLog'), chatInEl = $('chatIn');

  function markRead() { if (unread) { unread = 0; syncHud(); } }
  function isHidden(n) { return !!n && hidden.has(n.toLowerCase()); }

  RF.on('chat', function (m) {
    try {
      if (!m) return;
      const rec = { t: Date.now(), name: m.name || '', msg: m.msg || '', cls: m.cls || '' };
      back.push(rec); if (back.length > SCROLL) back.shift();
      const el = m.el;
      if (el && el.insertBefore) {
        const tm = document.createElement('i');
        tm.className = 'rf-social-time'; tm.textContent = hhmm(rec.t);
        el.insertBefore(tm, el.firstChild);
        if (isHidden(rec.name)) el.style.display = 'none';
      }
      if (rec.name && !isHidden(rec.name) && !RF.chatOpen && !(open && db.tab === 'chat')) { unread++; syncHud(); }
      if (open && db.tab === 'chat') { appendScroll(rec); markRead(); }
    } catch (e) { RF.warn('09-social:chat', e); }
  });

  function lineHTML(r) {
    const hid = isHidden(r.name);
    return '<div class="rf-social-line' + (r.cls === 'sys' ? ' sys' : '') + (hid ? ' hid' : '') + '">'
      + '<span class="tm">' + hhmm(r.t) + '</span>'
      + (r.name ? '<span class="nm" data-rf-social-n="' + esc(r.name) + '">' + esc(r.name) + ':</span> ' : '')
      + esc(r.msg) + '</div>';
  }
  function renderScroll() {
    const box = $('rf-social-scroll'); if (!box) return;
    if (!back.length) { box.innerHTML = '<div class="rf-social-empty">Nothing said yet.<br>'
      + 'Everything anyone says on this isle is kept here, even after the chat itself trims itself back.</div>'; return; }
    let h = ''; for (const r of back) h += lineHTML(r);
    box.innerHTML = h; box.scrollTop = box.scrollHeight;
  }
  function appendScroll(r) {
    const box = $('rf-social-scroll'); if (!box) return;
    if (box.children.length && box.children[0].className === 'rf-social-empty') box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', lineHTML(r));
    while (box.children.length > SCROLL) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  { const box = $('rf-social-scroll');
    if (box) box.addEventListener('click', e => {
      const n = e.target && e.target.getAttribute && e.target.getAttribute('data-rf-social-n');
      if (n) toggleHide(n); }); }

  /* Hiding is ours and reversible; core's /mute is core's and never renders at
     all. Both are shown so nobody is left wondering why a name went quiet. */
  function applyHide(name, on) {
    if (!chatLogEl) return;
    const low = name.toLowerCase();
    for (const c of chatLogEl.children) {
      const b = c.querySelector && c.querySelector('b');
      if (!b) continue;
      const who = b.textContent.replace(/:\s*$/, '').toLowerCase();
      if (who === low) c.style.display = on ? 'none' : '';
    }
  }
  function toggleHide(name) {
    if (!name) return;
    const low = String(name).toLowerCase();
    if (hidden.has(low)) { hidden.delete(low); applyHide(low, false); }
    else { if (hidden.size >= 120) return; hidden.add(low); applyHide(low, true); }
    db.hide = Array.from(hidden); save();
    if (open && db.tab === 'chat') { renderScroll(); renderHidden(); }
    F.chatPush('', '· ' + (hidden.has(low) ? 'hiding ' : 'showing ') + name + ' here ·', 'sys');
  }
  function renderHidden() {
    const box = $('rf-social-hidden'); if (!box) return;
    if (!hidden.size) box.innerHTML = '<span class="rf-social-chip">nobody</span>';
    else { let h = '';
      hidden.forEach(n => { h += '<span class="rf-social-chip"><b>' + esc(n)
        + '</b><button type="button" data-rf-social-un="' + esc(n) + '" title="show them again">x</button></span>'; });
      box.innerHTML = h; }
    const note = $('rf-social-mutenote');
    if (note) { let core = [];
      try { const s = F.mutedNames && F.mutedNames(); if (s && s.forEach) s.forEach(n => core.push(n)); } catch (e) {}
      note.textContent = 'Hidden names are dimmed out of the log on this browser only · nobody is silenced for anyone else. '
        + (core.length ? 'Core /mute also holds: ' + core.slice(0, 8).join(', ')
          + (core.length > 8 ? ' +' + (core.length - 8) : '') + ' · undo those with /unmute NAME.'
          : 'Core /mute is holding nobody.');
    }
  }
  { const box = $('rf-social-hidden');
    if (box) box.addEventListener('click', e => {
      const n = e.target && e.target.getAttribute && e.target.getAttribute('data-rf-social-un');
      if (n) toggleHide(n); }); }

  /* ---- ArrowUp history. Core's own listener sits on the input and stops the
     bubble, so we take the event a phase earlier and never fight it. ---- */
  const hist = []; let histIx = -1;
  if (chatInEl) document.addEventListener('keydown', function (e) {
    try {
      if (e.target !== chatInEl) return;
      if (e.code === 'Enter') {
        const v = (chatInEl.value || '').trim();
        if (v) { if (hist[hist.length - 1] !== v) hist.push(v); if (hist.length > 40) hist.shift(); }
        histIx = -1; return;
      }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        if (!hist.length) return;
        e.preventDefault();
        if (histIx < 0) histIx = hist.length;
        histIx += e.code === 'ArrowUp' ? -1 : 1;
        histIx = clamp(histIx, 0, hist.length);
        chatInEl.value = histIx >= hist.length ? '' : hist[histIx];
        const n = chatInEl.value.length;
        try { chatInEl.setSelectionRange(n, n); } catch (err) {}
      }
    } catch (err) { RF.warn('09-social:hist', err); }
  }, true);

  /* ---- commands ---- */
  const CMDS = [
    ['/help', 'this card'],
    ['/mute NAME', 'core · you stop receiving them entirely, and the server is told for this session'],
    ['/unmute NAME', 'core · undo that'],
    ['/report NAME why', 'core · send a report to the server'],
    ['/hide NAME', 'here · dim their lines in the log, kept across reloads, undone in one click'],
    ['/unhide NAME', 'here · show them again'],
    ['/hidden', 'here · who you are hiding'],
    ['/who', 'here · everyone on this isle and how far off they are'],
    ['/ping', 'here · the round trip to the server right now'],
    ['/link', 'here · open the connection panel (same as Y)']
  ];
  function renderCmds() {
    const box = $('rf-social-cmds'); if (!box) return;
    let h = '';
    for (const c of CMDS) h += '<code>' + esc(c[0]) + '</code><span>' + esc(c[1]) + '</span>';
    box.innerHTML = h;
  }
  function helpCard() {
    if (!chatLogEl) { showPanel('chat'); return; }
    try {
      const card = document.createElement('div');
      card.className = 'rf-social-helpcard';
      let t = 'chat commands\n';
      for (const c of CMDS) t += c[0] + '  ·  ' + c[1] + '\n';
      card.textContent = t.trim();
      chatLogEl.appendChild(card);
    } catch (e) { RF.warn('09-social:help', e); }
    F.chatPush('', '· Y opens the connection panel, where this list also lives ·', 'sys');
  }

  RF.on('chatcmd', function (c, rest) {
    try {
      const who = (rest && rest[0]) || '';
      if (c === 'help') { helpCard(); return true; }
      if (c === 'hide' && who) { const low = who.toLowerCase();
        if (!hidden.has(low)) toggleHide(who); else F.chatPush('', '· already hiding ' + who + ' ·', 'sys'); return true; }
      if (c === 'unhide' && who) { const low = who.toLowerCase();
        if (hidden.has(low)) toggleHide(who); else F.chatPush('', '· ' + who + ' was not hidden ·', 'sys'); return true; }
      if (c === 'hidden') { F.chatPush('', hidden.size ? '· hiding: ' + Array.from(hidden).join(', ') + ' ·'
        : '· hiding nobody ·', 'sys'); return true; }
      if (c === 'who') { const l = peerList();
        F.chatPush('', l.length ? '· ' + l.slice(0, 8).map(p => p.name + ' ' + Math.round(p.dist) + 'm').join(' · ')
          + (l.length > 8 ? ' · +' + (l.length - 8) + ' more' : '') + ' ·'
          : '· nobody else on this isle ·', 'sys'); return true; }
      if (c === 'ping') { const f = facts();
        F.chatPush('', f.online ? (lastPing >= 0 ? '· ' + lastPing + ' ms to the server · ' + BANDW[bandOf(lastPing)] + ' ·'
          : '· no sample yet · ask again in a moment ·') : '· offline · nothing to ping ·', 'sys');
        if (f.online) sample(); return true; }
      if (c === 'link') { showPanel('link'); return true; }
    } catch (e) { RF.warn('09-social:chatcmd', e); }
  });

  /* ======================================================================
     9. CREW WATCH — a knock at the gangway, wherever the captain is standing
     ====================================================================== */
  const crew = { at: 0, gap: 30000, fails: 0, off: false, sig: '', card: null };
  async function crewPoll() {
    const N = NET();
    if (crew.off || !N || !N.online) return;
    if (!RF.running || document.hidden || RF.harborOpen) return;   // core polls while the Harbor is open
    const now = Date.now();
    if (now - crew.at < crew.gap) return;
    crew.at = now;
    try {
      const d = await N.crew();
      crew.fails = 0; crew.gap = 30000; netOK();
      const you = (d && d.you) || null;
      const reqs = (d && d.requests) || [];
      if (!you || !you.hosting || !reqs.length) {
        crew.sig = '';
        if (crew.card) { try { crew.card.close(); } catch (e) {} crew.card = null; }
        return;
      }
      const names = reqs.map(r => r.username).filter(Boolean);
      const sig = names.slice().sort().join(',');
      if (sig === crew.sig) return;                       // same knock, already announced
      crew.sig = sig;
      const body = names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) + ' more' : '')
        + ' · ' + (you.slots - you.aboard) + ' of ' + you.slots + ' berths free on your '
        + ((you.boat && you.boat.name) || 'boat') + '.';
      const o = { level: 'info', tag: 'rf-social-crew', icon: 'crew', ttl: 0,
        title: names.length === 1 ? names[0] + ' is waiting at the gangway'
          : names.length + ' anglers are waiting at the gangway',
        body: body, actions: [{ label: 'Open Harbor', key: true, fn: () => { try { F.openHarbor(); }
          catch (e) { RF.err('09-social:harbor', e); } } }] };
      if (crew.card) crew.card.update(o); else crew.card = say(o);
    } catch (e) {
      crew.fails++;
      /* Back off to nothing: a captain who cannot be polled is not a captain to
         be pestered about. A 401 or a refusal stops the watch outright. */
      const st = (e && e.status) | 0;
      if ((st >= 400 && st < 500 && st !== 429) || crew.fails >= 4) { crew.off = true; return; }
      crew.gap = Math.min(600000, crew.gap * 2);
      noteErr('crew', st, (e && e.data && e.data.code) || '', (e && e.message) || '');
    }
  }

  /* ======================================================================
     10. WIRING
     ====================================================================== */
  const N0 = NET();
  if (N0) {
    seen = !!(N0.reachable || N0.online);
    /* net.js retries silently. These two handlers are additive — RFNet.on only
       appends, so core's realtime wiring is untouched. */
    N0.on('open', () => { try {
        retry.waiting = false; retry.at = 0; retry.attempt = 0; seen = true;
        netOK(); syncHud(); if (open) { paintHead(); paintFacts(); paintRetry(); }
      } catch (e) { RF.warn('09-social:wsopen', e); } });
    N0.on('close', () => { try {
        const N = NET(); if (!N) return;
        meta.clear(); roomWorld = ''; setTrack(null);
        if (!N.online) { retry.waiting = false; syncHud(); if (open) { paintHead(); paintRetry(); } return; }
        const n = (typeof N._retry === 'number' && isFinite(N._retry)) ? N._retry : retry.attempt;
        retry.wait = nextWait(n); retry.attempt = n + 1;
        retry.at = Date.now() + retry.wait; retry.waiting = true; retry.since = Date.now();
        syncHud(); if (open) { paintHead(); paintRetry(); }
      } catch (e) { RF.warn('09-social:wsclose', e); } });
    N0.on('welcome', d => { try {
        if (d && typeof d.world === 'string') roomWorld = d.world;
        meta.clear();
        for (const p of (d && d.peers) || []) if (p && p.id != null) meta.set(p.id, { title: p.title || '' });
        if (open && db.tab === 'people') renderPeers(true);
      } catch (e) { RF.warn('09-social:welcome', e); } });
    N0.on('join', d => { try { const p = d && d.p; if (p && p.id != null) meta.set(p.id, { title: p.title || '' });
      if (open && db.tab === 'people') renderPeers(true); } catch (e) {} });
    N0.on('leave', d => { try { if (d && d.id != null) { meta.delete(d.id); if (tracked === d.id) setTrack(null); }
      if (open && db.tab === 'people') renderPeers(true); } catch (e) {} });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pingT = 18; syncHud(); } });

  /* one cheap tick a second, one quarter-second refresh only while open */
  RF.every(1, function () {
    try {
      const N = NET();
      if (N && (N.reachable || N.online)) seen = true;
      if (reopened && N && N.online) { leaveSignIn();
        say({ level: 'success', ttl: 5000, title: 'Signed back in', body: 'The server has your island again.' }); }
      syncHud();
      if (open) { paintHead(); if (db.tab === 'link') { paintFacts(); paintLat(); paintRetry(); }
        else if (db.tab === 'people') { renderPeers(false); paintRooms(); } }
      crewPoll();
    } catch (e) { RF.warn('09-social:tick', e); }
  });
  RF.every(0.25, function () { try { if (open && db.tab === 'link') paintRetry(); } catch (e) {} });

  /* the sampler: every 20s online, faster while the doctor is watching */
  RF.on('frame', function (dt) {
    try {
      trackTick(dt);
      pingT += dt;
      const gap = open ? 6 : 20;
      if (pingT >= gap) { pingT = 0; sample(); }
    } catch (e) { RF.warn('09-social:frame', e); }
  });

  const typing = () => { const a = document.activeElement;
    return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };
  RF.on('keydown', function (e) {
    if (typing()) return;
    if (e.code === 'Escape') {
      if (open) { hidePanel(); return true; }
      if (reopened && RF.running) { leaveSignIn(); return true; }
      return;
    }
    if (e.code === 'KeyY' && !e.ctrlKey && !e.metaKey && !e.altKey && !RF.panelOpen) {
      e.preventDefault(); open ? hidePanel() : showPanel(); return true;
    }
  });
  RF.on('panel', () => { if (open) hidePanel(); syncHud(); });
  RF.on('start', () => { syncHud(); leaveSignIn(); });

  /* First contact: if a backend is already there, take one reading so the pill
     has something true to say the moment the player looks at it. */
  RF.on('ready', function () {
    try {
      renderCmds(); renderHidden(); paintFacts(); paintErr(); paintLat(); paintHead(); syncHud();
      const N = NET();
      if (N && N.base) setTimeout(() => { try { if (NET().online) sample(); else reprobe().then(syncHud); }
        catch (e) {} }, 1500);
    } catch (e) { RF.err('09-social:ready', e); }
  });
});
