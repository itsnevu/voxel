/* ============================================================================
   05-progress — the reason to come back tomorrow.
   Renown (the mod-side currency this slot mints on behalf of every other mod),
   seeded daily/weekly quests, a 44-rung permanent ladder, and the Board on Q.
   Nothing here touches the economy: the server owns coins, ores and pearls, so
   every number this file writes lives in RF.store('05-progress') and every
   number it reads out of RF.state is read-only.
   ========================================================================== */
RF.mod('05-progress', function (RF) {
  'use strict';

  const F = RF.fn, S = RF.state, fmt = F.fmt, TH = RF.THREE;
  const DAY = 864e5, KEY = '05-progress';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = () => document.body.classList.contains('rf-reduced');
  const say = o => { try {
      if (RF.api && RF.api.notify) RF.api.notify(o);
      else F.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : (o.tone || ''));
    } catch (e) { RF.err('05-progress:say', e, 'warn'); } };

  /* --------------------------------------------------------------------------
     STYLE — glassmorphism from index.html's tokens. The accent is a variable so
     a bought board theme is a one-attribute swap and never a re-render.
     ------------------------------------------------------------------------ */
  RF.css(`
  #rf-progress{position:fixed;inset:0;z-index:26;display:none;align-items:center;justify-content:center;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    background:radial-gradient(130% 100% at 50% -10%,rgba(14,26,32,.38),rgba(3,8,10,.66));
    backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);
    --rfp-a:var(--teal);--rfp-soft:rgba(57,215,196,.45);--rfp-glow:rgba(57,215,196,.2);}
  #rf-progress.on{display:flex;}
  #rf-progress[data-rfp-theme="brass"]{--rfp-a:var(--gold);--rfp-soft:rgba(255,207,92,.45);--rfp-glow:rgba(255,207,92,.2);}
  #rf-progress[data-rfp-theme="coral"]{--rfp-a:var(--rose);--rfp-soft:rgba(255,93,122,.45);--rfp-glow:rgba(255,93,122,.2);}
  #rf-progress[data-rfp-theme="aurora"]{--rfp-a:#c07bff;--rfp-soft:rgba(192,123,255,.45);--rfp-glow:rgba(192,123,255,.22);}
  body.photo #rf-progress{display:none!important;}
  .rf-prog-card{width:min(772px,95vw);max-height:88vh;display:flex;flex-direction:column;
    font-size:calc(13px * var(--rf-ui-scale,1));
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:20px;padding:19px 21px 15px;
    box-shadow:var(--glass-hi),0 30px 80px rgba(0,0,0,.5),0 0 34px var(--rfp-glow);}
  .rf-prog-head{display:flex;align-items:flex-start;gap:14px;}
  .rf-prog-head .ttl{flex:1;min-width:0;}
  .rf-prog-head .eyebrow{font-size:9px;letter-spacing:.34em;color:var(--rfp-a);text-transform:uppercase;}
  .rf-prog-head h2{font-family:"Chakra Petch",sans-serif;font-size:calc(23px * var(--rf-ui-scale,1));
    font-weight:700;color:var(--ink);line-height:1.15;margin:1px 0 0;}
  .rf-prog-head .rk{font-size:11px;color:var(--muted);margin-top:2px;}
  .rf-prog-head .rk b{color:var(--rfp-a);font-weight:600;}
  .rf-prog-bank{text-align:right;flex:0 0 auto;}
  .rf-prog-bank .big{font-family:"Chakra Petch",sans-serif;font-weight:700;font-variant-numeric:tabular-nums;
    font-size:calc(25px * var(--rf-ui-scale,1));color:var(--rfp-a);text-shadow:0 0 18px var(--rfp-glow);line-height:1;}
  .rf-prog-bank .lab{font-size:8.5px;letter-spacing:.26em;color:var(--lab);margin-top:3px;}
  .rf-prog-x{font-size:11px;color:var(--muted);background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:8px;padding:6px 10px;cursor:pointer;letter-spacing:.1em;font-family:inherit;align-self:flex-start;}
  .rf-prog-x:hover{border-color:var(--rose);color:var(--rose);}
  .rf-prog-rankbar{height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin:10px 0 2px;}
  .rf-prog-rankbar i{display:block;height:100%;border-radius:3px;background:var(--rfp-a);box-shadow:0 0 10px var(--rfp-glow);}
  .rf-prog-tabs{display:flex;gap:7px;margin:11px 0 9px;}
  .rf-prog-tab{flex:1;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;letter-spacing:.14em;
    padding:8px 0;border-radius:10px;cursor:pointer;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--muted);box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rf-prog-tab:hover{color:var(--ink);border-color:var(--glass-bd);}
  .rf-prog-tab.sel{color:var(--rfp-a);border-color:var(--rfp-soft);
    box-shadow:inset 0 0 0 1px var(--rfp-soft),0 0 12px var(--rfp-glow);}
  .rf-prog-tab .pip{display:inline-block;min-width:15px;padding:0 3px;margin-left:5px;border-radius:7px;
    background:var(--gold);color:#0a1418;font-size:9.5px;line-height:14px;vertical-align:1px;}
  .rf-prog-body{overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;padding-right:3px;}
  .rf-prog-body::-webkit-scrollbar{width:6px;}
  .rf-prog-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px;}
  .rf-prog-sec{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);
    margin:13px 0 7px;display:flex;justify-content:space-between;align-items:baseline;gap:10px;}
  .rf-prog-sec span{letter-spacing:.06em;text-transform:none;color:var(--muted);font-variant-numeric:tabular-nums;}
  .rf-prog-sec:first-child{margin-top:2px;}
  .rf-prog-q{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:12px;
    padding:10px 13px;margin-bottom:7px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .rf-prog-q.done{border-color:var(--rfp-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 14px var(--rfp-glow);}
  .rf-prog-q.claimed{opacity:.44;}
  .rf-prog-qtop{display:flex;align-items:center;gap:9px;}
  .rf-prog-qtop .nm{flex:1;font-size:12.5px;font-weight:600;color:var(--ink);min-width:0;}
  .rf-prog-qtop .nm small{display:block;font-size:9.5px;font-weight:400;color:var(--faint);letter-spacing:.05em;margin-top:1px;}
  .rf-prog-qtop .val{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;color:var(--rfp-a);
    font-variant-numeric:tabular-nums;white-space:nowrap;}
  .rf-prog-bar{height:6px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:8px;}
  .rf-prog-bar i{display:block;height:100%;border-radius:3px;background:var(--rfp-a);
    box-shadow:0 0 8px var(--rfp-glow);transition:width .35s ease;}
  body.rf-reduced .rf-prog-bar i{transition:none;}
  .rf-prog-qfoot{display:flex;align-items:center;gap:9px;margin-top:7px;}
  .rf-prog-qfoot .ct{flex:1;font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums;}
  .rf-prog-btn{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:11.5px;letter-spacing:.05em;
    cursor:pointer;border-radius:9px;padding:6px 13px;border:1px solid var(--glass-bd-soft);
    background:var(--glass-row);color:var(--ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.1);}
  .rf-prog-btn:hover:not(:disabled){border-color:var(--rfp-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px var(--rfp-glow);}
  .rf-prog-btn:active:not(:disabled){transform:translateY(1px);}
  .rf-prog-btn:disabled{opacity:.38;cursor:default;}
  .rf-prog-btn.hot{border-color:var(--rfp-a);color:var(--rfp-a);box-shadow:0 0 14px var(--rfp-glow);}
  .rf-prog-m{display:flex;align-items:center;gap:10px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:11px;padding:8px 12px;margin-bottom:5px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06);}
  .rf-prog-m.got{border-color:var(--rfp-soft);background:rgba(255,255,255,.075);}
  .rf-prog-m .tr{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;color:var(--faint);
    min-width:26px;text-align:center;letter-spacing:.04em;}
  .rf-prog-m.got .tr{color:var(--rfp-a);}
  .rf-prog-m .mid{flex:1;min-width:0;}
  .rf-prog-m .mn{font-size:12.5px;font-weight:600;color:var(--ink);}
  .rf-prog-m .mf{font-size:10px;color:var(--faint);margin-top:1px;line-height:1.4;}
  .rf-prog-m .mp{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;min-width:84px;}
  .rf-prog-m .mr{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11.5px;color:var(--rfp-a);
    font-variant-numeric:tabular-nums;min-width:44px;text-align:right;}
  .rf-prog-rank{display:flex;align-items:center;gap:11px;padding:6px 12px;border-radius:10px;margin-bottom:4px;
    border:1px solid transparent;font-variant-numeric:tabular-nums;}
  .rf-prog-rank.on{border-color:var(--rfp-soft);background:var(--glass-row);box-shadow:0 0 14px var(--rfp-glow);}
  .rf-prog-rank.past{opacity:.5;}
  .rf-prog-rank .i{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;color:var(--faint);min-width:22px;}
  .rf-prog-rank .n{flex:1;font-size:12.5px;color:var(--ink);}
  .rf-prog-rank.on .n{color:var(--rfp-a);font-weight:600;}
  .rf-prog-rank .a{font-size:11px;color:var(--muted);}
  .rf-prog-h{display:flex;gap:10px;font-size:10.5px;color:var(--muted);padding:4px 2px;
    border-top:1px solid var(--glass-bd-soft);font-variant-numeric:tabular-nums;}
  .rf-prog-h .w{flex:1;color:var(--lab);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .rf-prog-h .v{color:var(--rfp-a);font-weight:600;}
  .rf-prog-h .v.neg{color:var(--rose);}
  .rf-prog-note{font-size:10.5px;color:var(--faint);line-height:1.6;background:var(--glass-row);
    border:1px solid var(--glass-bd-soft);border-radius:11px;padding:9px 12px;margin-bottom:9px;}
  .rf-prog-note b{color:var(--rfp-a);font-weight:600;}
  .rf-prog-shop{display:flex;align-items:center;gap:10px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:11px;padding:9px 12px;margin-bottom:5px;}
  .rf-prog-shop .mid{flex:1;min-width:0;}
  .rf-prog-shop .sn{font-size:12.5px;font-weight:600;color:var(--ink);}
  .rf-prog-shop .sd{font-size:10px;color:var(--faint);margin-top:1px;line-height:1.4;}
  .rf-prog-shop .sc{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;color:var(--rfp-a);
    font-variant-numeric:tabular-nums;white-space:nowrap;}
  .rf-prog-log{background:linear-gradient(160deg,rgba(255,238,200,.09),rgba(255,238,200,.02));
    border:1px solid rgba(255,207,92,.24);border-radius:12px;padding:11px 14px;margin-bottom:9px;position:relative;}
  .rf-prog-log::before{content:'';position:absolute;inset:4px;border:1px dashed rgba(255,207,92,.18);
    border-radius:9px;pointer-events:none;}
  .rf-prog-log .lh{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:11px;letter-spacing:.18em;
    color:var(--gold);text-transform:uppercase;margin-bottom:5px;}
  .rf-prog-log .ll{font-size:11px;color:var(--lab);line-height:1.65;font-style:italic;}
  .rf-prog-log .ll b{color:var(--gold);font-style:normal;font-weight:600;font-variant-numeric:tabular-nums;}
  .rf-prog-empty{color:var(--faint);font-size:12px;padding:16px;text-align:center;}
  .rf-prog-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px;
    padding-top:8px;border-top:1px solid var(--glass-bd-soft);font-size:9.5px;letter-spacing:.16em;color:var(--faint);}
  .rf-prog-foot b{color:var(--rfp-a);font-weight:600;letter-spacing:.06em;}
  @media (max-height:660px){ .rf-prog-card{max-height:94vh;padding:14px 16px 11px;} .rf-prog-head h2{font-size:19px;} }
  `, 'rf-progress-css');

  /* --------------------------------------------------------------------------
     THE RANK LADDER — twelve rungs, driven by LIFETIME renown so that spending
     in the shop can never demote anybody.
     ------------------------------------------------------------------------ */
  const RANKS = [
    ['Deckhand', 0], ['Netmender', 150], ['Baitwright', 400], ['Tidewatcher', 900],
    ['Reefpilot', 1800], ['Quartermaster', 3200], ['Sternmaster', 5400], ['Wavebreaker', 8600],
    ['Isle Ranger', 13000], ['Reef Marshal', 19000], ['Fleet Admiral', 27000], ['Harbormaster', 40000]];

  /* --------------------------------------------------------------------------
     PERSISTENCE. One bucket, written lazily: a claim is instant, the disk write
     rides the next 2 s tick so nothing ever lands inside a frame.
     ------------------------------------------------------------------------ */
  const DEF = { v: 1, ren: 0, life: 0, hist: [], drip: {},
    day: -1, week: -1, dq: [], wq: [], streak: 0, lastClaim: -1,
    ms: {}, own: {}, theme: 'deep', badge: 1, log: 1, boot: 0, expWarn: -1 };
  let data;
  try { const raw = RF.store.get(KEY, null);
    data = Object.assign({}, DEF, raw && typeof raw === 'object' ? raw : null);
  } catch (e) { data = Object.assign({}, DEF); RF.err('05-progress:load', e, 'warn'); }
  for (const k of ['hist', 'dq', 'wq']) if (!Array.isArray(data[k])) data[k] = [];
  for (const k of ['drip', 'ms', 'own']) if (!data[k] || typeof data[k] !== 'object') data[k] = {};
  data.ren = Math.max(0, data.ren | 0); data.life = Math.max(data.ren, data.life | 0);

  let dirty = false;
  const touch = () => { dirty = true; };
  const flush = () => { if (!dirty) return; dirty = false;
    try { RF.store.set(KEY, data); } catch (e) { RF.err('05-progress:save', e, 'warn'); } };

  /* --------------------------------------------------------------------------
     RENOWN. Published first thing so a mod that loads after us and calls into it
     during its own init finds a working object rather than a hole.
     ------------------------------------------------------------------------ */
  const listeners = [];
  const rankOf = life => { let i = 0;
    for (let k = RANKS.length - 1; k >= 0; k--) if (life >= RANKS[k][1]) { i = k; break; }
    const nx = RANKS[i + 1] || null, base = RANKS[i][1];
    return { i: i, name: RANKS[i][0], next: nx ? { name: nx[0], at: nx[1] } : null,
      progress: nx ? Math.max(0, Math.min(1, (life - base) / (nx[1] - base))) : 1 }; };

  function note(n, why) {
    const w = String(why == null ? 'play' : why).slice(0, 48);
    const last = data.hist[0];
    // a trickle from ordinary play would bury the ledger; fold repeats of the
    // same source within five minutes into one line instead of thirty.
    if (last && last.w === w && Date.now() - last.t < 300000) { last.n += n; last.t = Date.now(); }
    else data.hist.unshift({ t: Date.now(), n: n, w: w });
    if (data.hist.length > 60) data.hist.length = 60;
  }

  function fire(n, why) { for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](data.ren, n, why); } catch (e) { RF.err('05-progress:listener', e, 'warn'); } } }

  function rankUp(before, after) {
    const a = rankOf(before), b = rankOf(after);
    if (b.i <= a.i) return;
    say({ level: 'good', tone: 'gold', title: 'Rank ' + (b.i + 1) + ' · ' + b.name,
      body: 'Lifetime Renown ' + fmt(after) + (b.next ? ' · next: ' + b.next.name + ' at ' + fmt(b.next.at) : ' · the top of the ladder'),
      tag: 'rf-progress-rank', ttl: 8000 });
    try { RF.sfx.ach(); } catch (e) {}
    if (!reduced()) { try {
      F.addShake(0.42);
      const p = RF.pWorld;
      F.fxBurst(p.x, p.y + 1.5, p.z, { n: 34, cols: [0x39d7c4, 0xffcf5c, 0xffffff], speed: 4.2, up: 5.2, size: 1.2, grav: 7 });
    } catch (e) { RF.err('05-progress:rankfx', e, 'warn'); } }
    buildBadge();
  }

  const renown = {
    get: () => data.ren | 0,
    lifetime: () => data.life | 0,
    add(n, why) {
      n = Math.floor(+n || 0); if (!(n > 0)) return data.ren | 0;
      const before = data.life;
      data.ren += n; data.life += n; note(n, why); touch();
      fire(n, why); rankUp(before, data.life);
      if (open) render();
      return data.ren; },
    spend(n, why) {
      n = Math.floor(+n || 0); if (!(n > 0) || data.ren < n) return false;
      data.ren -= n; note(-n, why || 'spent'); touch();
      fire(-n, why); if (open) render();
      return true; },
    rank: () => rankOf(data.life),
    ranks: () => RANKS.map(r => ({ name: r[0], at: r[1] })),
    on(fn) { if (typeof fn !== 'function') return () => {};
      listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    history: () => data.hist.slice(0, 40).map(h => ({ t: h.t, n: h.n, why: h.w }))
  };
  RF.api = RF.api || {};
  RF.api.renown = renown;

  /* Fractional drip: three ore is one Renown, so the remainder has to survive a
     reload or a slow miner never scores at all. */
  function drip(key, amount, per, why) {
    const acc = (data.drip[key] || 0) + amount;
    const whole = Math.floor(acc / per);
    data.drip[key] = acc - whole * per; touch();
    if (whole > 0) renown.add(whole, why);
  }

  /* --------------------------------------------------------------------------
     THE LADDER — 44 permanent milestones, every one of them computed from
     RF.state so a save with three weeks on it opens at its real position.
     ------------------------------------------------------------------------ */
  const MS_TIER = ['I', 'II', 'III', 'IV'], MS_RW = [20, 55, 150, 400];
  const st = () => (S.stats || {});
  const nOre = () => Math.max(0, (st().mined | 0) - (st().wood | 0));
  const nWood = () => st().wood | 0;
  const nShares = () => { const o = (S.stocks && S.stocks.own) || {}; let t = 0; for (const k in o) t += o[k] | 0; return t; };
  const nLegend = () => { let t = 0; for (const nm in (S.dex || {})) {
      const e = RF.ALL_FISH.find(x => x[0].name === nm); if (e && e[0].rar === 'legendary') t++; } return t; };

  const LADDER = [];
  function rung(cat, icon, cur, rows) {
    rows.forEach((r, i) => LADDER.push({ id: cat + (i + 1), cat: cat, icon: icon, tier: i,
      name: r[0], need: r[1], flav: r[2], cur: cur, rw: MS_RW[i] })); }

  rung('Fishing', 'fish', () => st().caught | 0, [
    ['Wet Line', 10, 'Ten fish and the rod stops feeling borrowed.'],
    ['Working Angler', 100, 'The bucket has a smell now. That is the job.'],
    ['Reelwright', 750, 'You read the water before you read the bobber.'],
    ['Tide Sovereign', 3000, 'Three thousand. Somebody should write that down.']]);
  rung('The Dex', 'trophy', () => Object.keys(S.dex || {}).length, [
    ['First Sightings', 5, 'Five names in the book · a book, technically.'],
    ['Field Naturalist', 15, 'You start noticing what is missing, not what is there.'],
    ['Deep Cataloguer', 30, 'The gaps are all night, storm and other people\'s isles.'],
    ['Completionist', RF.ALL_FISH.length, 'Every species that swims these waters. Every one.']]);
  rung('Mining', 'pick', nOre, [
    ['First Swing', 25, 'The pick rings differently once it knows the rock.'],
    ['Quarry Hand', 250, 'Coal under the nails, permanently.'],
    ['Vein Reader', 1500, 'You take the long way round to pass the good stone.'],
    ['Deep Digg Legend', 6000, 'They named a shift pattern after you. Probably.']]);
  rung('Timber', 'wood', nWood, [
    ['Kindling', 20, 'Enough for a fire and a very small boat.'],
    ['Woodcutter', 200, 'The isle is measurably quieter.'],
    ['Sawyer', 1200, 'You can hear which trees are hollow.'],
    ['Lumberline Baron', 5000, 'LUMB is up on the news of you alone.']]);
  rung('Trade', 'chart', () => st().earned | 0, [
    ['First Grand', 1000, 'A thousand coins and nothing to spend it on yet.'],
    ['Steady Hand', 25000, 'You sell into the HOT window now, not the panic.'],
    ['Market Maker', 250000, 'The trader restocks around your schedule.'],
    ['Isle Magnate', 1000000, 'A million through the stall. The stall is unchanged.']]);
  rung('The Exchange', 'chart', nShares, [
    ['First Certificate', 1, 'A share of something fictional. Congratulations.'],
    ['Small Portfolio', 12, 'Twelve certificates and one strong opinion.'],
    ['Blockholder', 50, 'Dividends arrive whether you log in or not.'],
    ['Board Seat', 100, 'A hundred shares. Nobody can outvote a fish.']]);
  rung('The Wheel', 'wheel', () => st().spins | 0, [
    ['A Flutter', 5, 'The eel remembers your face now.'],
    ['Regular', 50, 'The stool has your shape in it.'],
    ['Wheelwatcher', 300, 'You know the pockets by feel. It changes nothing.'],
    ['House Guest', 1200, 'The house is grateful. Genuinely.']]);
  rung('Fortune', 'gem', () => st().bestWin | 0, [
    ['Lucky Pull', 250, 'A single win worth two hundred and fifty.'],
    ['High Roller', 1500, 'The table went quiet for a second there.'],
    ['Eel Tamer', 6000, 'Six thousand on one pocket. Walk away. You will not.'],
    ['Legend of the Green', 20000, 'They still argue about which pocket it was.']]);
  rung('Charts', 'island', () => (S.worlds || []).length, [
    ['Second Isle', 2, 'The horizon turned out to have things on it.'],
    ['Third Charter', 3, 'Ash in the rigging, and worth it.'],
    ['Full Archipelago', 4, 'Every isle on the chart is yours to sail to.'],
    ['Nowhere Left', 4, 'Four isles claimed · the map has no more blanks.']]);
  rung('The Fleet', 'boat', () => S.boatLvl | 0, [
    ['A Real Hull', 1, 'The raft goes in the rafters, not the water.'],
    ['Under Sail', 2, 'Painted hull, single sail, no excuses.'],
    ['Iron-Clad', 3, 'The Trawler does not care what the sky is doing.'],
    ['Gilded Galleon', 4, 'Pride of the archipelago. Docked, mostly.']]);
  rung('Pearls', 'gem', () => S.pearlsLife | 0, [
    ['First Handful', 100, 'Pearls track effort, never luck. These are earned.'],
    ['Diver', 1000, 'The Kiosk starts opening before you knock.'],
    ['Pearl Hoard', 5000, 'A thousand small good decisions in a jar.'],
    ['Kiosk Patron', 20000, 'The Kiosk has a chair with your name scratched in it.']]);

  const toolSum = () => (S.rodLvl | 0) + (S.pickLvl | 0) + (S.axeLvl | 0);
  rung('The Forge', 'axe', toolSum, [
    ['Better Tools', 6, 'Three tools, all of them upgraded once.'],
    ['Craftsman', 12, 'Nothing in your hands came off a beach any more.'],
    ['Master Smith', 21, 'The trader stopped quoting you the list price.'],
    ['Full Set', 3 * RF.MAXLVL, 'Poseidon, Titan and Dragon, all at once.']]);
  rung('Legends', 'fish', nLegend, [
    ['First Legend', 1, 'One legendary on the line and the arm remembers it.'],
    ['Legend Hunter', 3, 'Three. The siren chum is paying for itself.'],
    ['Myth Collector', 6, 'Six legends logged. The dex page glows.'],
    ['Deep Sovereign', 9, 'Nine legends. The deep has run out of secrets.']]);

  const msDone = m => m.cur() >= m.need;

  function scanLadder(silent) {
    let gained = 0, count = 0, last = null;
    for (const m of LADDER) {
      if (data.ms[m.id]) continue;
      let ok = false; try { ok = msDone(m); } catch (e) { RF.err('05-progress:ladder:' + m.id, e, 'warn'); }
      if (!ok) continue;
      data.ms[m.id] = Date.now(); gained += m.rw; count++; last = m;
      if (!silent) renown.add(m.rw, m.name);
    }
    if (!count) return 0;
    touch();
    if (silent) { // one reconciliation line beats forty toasts on a veteran save
      data.ren += gained; data.life += gained; note(gained, 'ledger reconciled'); fire(gained, 'ledger');
      say({ level: 'info', tone: 'gold', title: 'Ledger reconciled',
        body: count + ' milestone' + (count > 1 ? 's' : '') + ' already earned · +' + fmt(gained) + ' Renown',
        tag: 'rf-progress-boot', ttl: 8000 });
    } else if (count === 1 && last) {
      say({ level: 'good', tone: 'gold', title: 'Milestone · ' + last.name,
        body: last.cat + ' ' + MS_TIER[last.tier] + ' · +' + fmt(last.rw) + ' Renown', tag: 'rf-progress-ms', ttl: 6000 });
    }
    return gained;
  }

  /* --------------------------------------------------------------------------
     QUESTS. The pair of indices below is what makes a refresh useless: the
     objectives are a pure function of the day (or week) number, exactly the
     trick the market rotation uses on the clock epoch.
     ------------------------------------------------------------------------ */
  const tzOff = () => new Date().getTimezoneOffset() * 60000;
  const dayIdx = () => Math.floor((Date.now() - tzOff()) / DAY);
  const weekIdx = () => Math.floor((dayIdx() - 4) / 7);          // epoch day 4 is a Monday
  const dayEnds = () => (dayIdx() + 1) * DAY + tzOff() - Date.now();
  const weekEnds = () => ((weekIdx() + 1) * 7 + 4) * DAY + tzOff() - Date.now();
  const dur = ms => { ms = Math.max(0, ms); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60;
    return h >= 1 ? h + 'h ' + m + 'm' : m + 'm ' + (Math.floor(ms / 1000) % 60) + 's'; };

  const R5 = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const CONDW = { night: 'at night', rain: 'in the rain', storm: 'in a storm' };
  const ri = r => RF.RORDER[r] || 0;
  const pickOf = (r, a) => a[Math.min(a.length - 1, Math.floor(r() * a.length))];
  const span = (r, lo, hi, step) => lo + Math.floor(r() * (Math.floor((hi - lo) / step) + 1)) * step;
  const nrm = n => String(n || '').replace('✨ ', '').replace('✦ ', '');

  /* Which species can this save actually meet? Only the isles it has bought,
     and never an epic or a legend on a daily. */
  function speciesPool(topRar) {
    const out = [], seen = Object.create(null), owned = S.worlds || ['isle'];
    for (const wk of owned) { const w = RF.WORLDS[wk]; if (!w || !w.fish) continue;
      for (const e of w.fish) { const f = e[0];
        if (ri(f.rar) > ri(topRar) || seen[f.name]) continue;
        seen[f.name] = 1; out.push({ n: f.name, r: f.rar, c: e[2] || '', w: w.name }); } }
    out.sort((a, b) => a.n < b.n ? -1 : a.n > b.n ? 1 : 0);   // stable order or the seed means nothing
    return out;
  }

  const KIND = {
    catchAny: { d: 1, ic: 'fish', gen: (r, w) => ({ n: w ? span(r, 90, 210, 30) : span(r, 12, 28, 4) }),
      lab: q => 'Land ' + fmt(q.n) + ' fish' },
    catchRar: { d: 2, ic: 'fish',
      gen: (r, w) => { const a = pickOf(r, ['uncommon', 'rare', 'epic']);
        const b = { uncommon: 6, rare: 3, epic: 1 }[a]; return { a: a, n: b * (w ? 6 : 1) + Math.floor(r() * b * (w ? 3 : 1)) }; },
      lab: q => 'Land ' + fmt(q.n) + ' ' + q.a + '-or-better fish',
      match: (q, arg) => ri(arg) >= ri(q.a) },
    catchSpecies: { d: 2, ic: 'fish',
      gen: (r, w) => { const p = speciesPool(w ? 'epic' : 'rare'); if (!p.length) return null;
        const s = p[Math.floor(r() * p.length) % p.length];
        return { a: s.n, n: w ? 3 : 1, x: (s.c ? CONDW[s.c] : '') || '', y: s.w }; },
      lab: q => 'Land ' + (q.n > 1 ? fmt(q.n) + ' × ' : 'a ') + q.a + (q.x ? ' ' + q.x : ''),
      sub: q => q.y ? q.y + (q.x ? ' · ' + q.x : '') : '',
      match: (q, arg) => arg === q.a },
    catchRain: { d: 2, ic: 'rain', gen: (r, w) => ({ n: w ? span(r, 15, 30, 5) : span(r, 3, 7, 1) }),
      lab: q => 'Land ' + fmt(q.n) + ' fish while it rains', sub: () => 'rain or storm both count' },
    catchNight: { d: 2, ic: 'moon', gen: (r, w) => ({ n: w ? span(r, 20, 40, 5) : span(r, 4, 9, 1) }),
      lab: q => 'Land ' + fmt(q.n) + ' fish after dark' },
    mineOre: { d: 1, ic: 'pick', gen: (r, w) => ({ n: w ? span(r, 120, 300, 30) : span(r, 15, 35, 5) }),
      lab: q => 'Mine ' + fmt(q.n) + ' ore' },
    geode: { d: 3, ic: 'gem', gen: (r, w) => ({ n: w ? span(r, 4, 8, 1) : span(r, 1, 2, 1) }),
      lab: q => 'Crack ' + (q.n > 1 ? fmt(q.n) + ' geodes' : 'a geode'),
      sub: () => 'the fat crystal-crusted boulders' },
    chop: { d: 1, ic: 'axe', gen: (r, w) => ({ n: w ? span(r, 100, 240, 20) : span(r, 12, 28, 4) }),
      lab: q => 'Fell ' + fmt(q.n) + ' wood' },
    earn: { d: 2, ic: 'chart', gen: (r, w) => ({ n: w ? span(r, 12000, 40000, 4000) : span(r, 1200, 4000, 400) }),
      lab: q => 'Earn ◈' + fmt(q.n) + ' coins', sub: () => 'sales, treasure and dividends all count' },
    sellHot: { d: 2, ic: 'chart',
      gen: r => ({ a: pickOf(r, RF.MKT_CATS), n: 1 }),
      lab: q => 'Sell while ' + F.catLabel(q.a) + ' is HOT',
      sub: q => 'HOT now: ' + F.catLabel(F.mktMods().hot),
      match: (q, arg) => arg === q.a },
    spin: { d: 1, ic: 'wheel', gen: (r, w) => ({ n: w ? span(r, 20, 50, 5) : span(r, 3, 8, 1) }),
      lab: q => 'Take ' + fmt(q.n) + ' spin' + (q.n > 1 ? 's' : '') + ' at the wheel' },
    spinWin: { d: 3, ic: 'wheel', gen: (r, w) => ({ n: w ? span(r, 6, 14, 2) : span(r, 1, 3, 1) }),
      lab: q => 'Win ' + fmt(q.n) + ' spin' + (q.n > 1 ? 's' : '') },
    travel: { d: 2, ic: 'boat', gen: (r, w) => ({ n: w ? 3 : 1 }),
      lab: q => q.n > 1 ? 'Sail between isles ' + q.n + ' times' : 'Sail to another isle',
      sub: () => 'the Harbor, at the end of the dock' },
    dig: { d: 3, ic: 'map', gen: (r, w) => ({ n: w ? 2 : 1 }),
      lab: q => q.n > 1 ? 'Dig up ' + q.n + ' buried treasures' : 'Dig up a buried treasure',
      sub: () => 'a bottle turns up on the line eventually' },
    craft: { d: 3, ic: 'rod', gen: (r, w) => ({ n: w ? 3 : 1 }),
      lab: q => 'Forge ' + (q.n > 1 ? q.n + ' tool tiers' : 'a tool tier') },
    share: { d: 3, ic: 'chart', gen: (r, w) => ({ n: w ? span(r, 3, 6, 1) : 1 }),
      lab: q => 'Take ' + (q.n > 1 ? q.n + ' share certificates' : 'a share certificate'),
      sub: () => 'they drop off gold, diamond and epic catches' },
    pearls: { d: 1, ic: 'gem', gen: (r, w) => ({ n: w ? span(r, 350, 900, 50) : span(r, 40, 110, 10) }),
      lab: q => 'Earn ' + fmt(q.n) + ' pearls' },
    dexNew: { d: 3, ic: 'trophy', gen: (r, w) => ({ n: w ? span(r, 4, 8, 1) : span(r, 1, 2, 1) }),
      lab: q => 'Log ' + (q.n > 1 ? q.n + ' new species' : 'a new species') }
  };

  const DAILY_POOL = ['catchAny', 'catchRar', 'catchSpecies', 'catchRain', 'catchNight', 'mineOre',
    'geode', 'chop', 'earn', 'sellHot', 'spin', 'spinWin', 'travel', 'dig', 'craft', 'share', 'pearls', 'dexNew'];
  const WEEK_POOL = ['catchAny', 'catchRar', 'catchSpecies', 'mineOre', 'chop', 'earn',
    'spin', 'spinWin', 'pearls', 'dexNew', 'geode', 'craft'];

  /* An objective nobody can start is worse than a boring one. */
  function usable(k) {
    if (k === 'travel') return (S.worlds || []).length >= 2;
    if (k === 'craft') return (S.rodLvl | 0) < RF.MAXLVL || (S.pickLvl | 0) < RF.MAXLVL || (S.axeLvl | 0) < RF.MAXLVL;
    if (k === 'geode') return RF.oreNodes.some(n => n.geode);
    return true;
  }

  const qRw = (q, w) => Math.round((w ? 110 : 30) * (KIND[q.k] ? KIND[q.k].d : 1));
  const qLab = q => { const K = KIND[q.k]; return K ? K.lab(q) : 'Objective'; };
  const qSub = q => { const K = KIND[q.k]; return K && K.sub ? K.sub(q) : ''; };

  function makeQuests(seed, count, pool, weekly) {
    const r = F.mulberry32((seed * 2654435761 ^ 0x9e3779b9) | 0);
    const bag = pool.filter(usable), out = [];
    for (let guard = 0; out.length < count && guard < 64; guard++) {
      if (!bag.length) break;
      const k = bag.splice(Math.floor(r() * bag.length) % bag.length, 1)[0];
      let p = null; try { p = KIND[k].gen(r, weekly); } catch (e) { RF.err('05-progress:gen:' + k, e, 'warn'); }
      if (!p || !(p.n > 0)) continue;
      out.push({ k: k, a: p.a || '', n: p.n, x: p.x || '', y: p.y || '', p: 0, cl: 0, h1: 0, h2: 0 });
    }
    return out;
  }

  function rollover(quiet) {
    const d = dayIdx(), w = weekIdx();
    let fresh = false;
    if (data.day !== d || !data.dq.length) {
      const lost = data.dq.filter(q => q.p >= q.n && !q.cl).length;
      data.dq = makeQuests(d, 3, DAILY_POOL, false); data.day = d; data.expWarn = -1; fresh = true;
      if (!quiet) say({ level: 'info', title: 'New dailies posted',
        body: lost ? lost + ' finished job' + (lost > 1 ? 's' : '') + ' expired unclaimed · press Q' : 'Three fresh objectives on the board · press Q',
        tag: 'rf-progress-daily', ttl: 6000 });
      // a missed day breaks the chain the moment the board turns over
      if (data.lastClaim >= 0 && data.lastClaim < d - 1 && data.streak > 0) data.streak = 0;
    }
    if (data.week !== w || !data.wq.length) {
      data.wq = makeQuests(w * 7919 + 13, 2, WEEK_POOL, true); data.week = w; fresh = true;
      if (!quiet) say({ level: 'info', title: 'New weekly charter', body: 'Two long jobs, seven days · press Q',
        tag: 'rf-progress-weekly', ttl: 6000 });
    }
    if (fresh) { touch(); if (open) render(); }
  }

  const streakMult = () => 1 + Math.min(0.75, 0.05 * Math.max(0, data.streak - 1));

  function claim(list, i) {
    const q = list[i]; if (!q || q.cl || q.p < q.n) return false;
    const weekly = list === data.wq;
    q.cl = 1;
    if (!weekly) { const d = dayIdx();
      if (data.lastClaim !== d) { data.streak = data.lastClaim === d - 1 ? (data.streak | 0) + 1 : 1; data.lastClaim = d; } }
    const base = qRw(q, weekly), mult = weekly ? 1 : streakMult();
    const pay = Math.max(1, Math.round(base * mult));
    touch();
    try { RF.sfx.pearl(); } catch (e) {}
    if (!reduced()) { try { F.addShake(0.14);
      F.fxBurst(RF.pWorld.x, RF.pWorld.y + 1.3, RF.pWorld.z, { n: 14, cols: [0x39d7c4, 0xffcf5c], speed: 3, up: 4, size: .9 });
    } catch (e) {} }
    renown.add(pay, qLab(q));
    say({ level: 'good', tone: 'gold', title: (weekly ? 'Weekly claimed' : 'Daily claimed'),
      body: qLab(q) + ' · +' + fmt(pay) + ' Renown' + (mult > 1 ? ' (streak ×' + mult.toFixed(2) + ')' : ''),
      tag: 'rf-progress-claim', ttl: 5000 });
    render();
    return true;
  }

  /* --------------------------------------------------------------------------
     PROGRESS. Half of these arrive as RF events; the other half only exist as
     numbers on RF.state.stats, because the server routes for mine/chop/dig/sell
     return before core reaches its emit. Deltas off `hud` cover both.
     ------------------------------------------------------------------------ */
  function each(fn) { for (const q of data.dq) fn(q, data.dq); for (const q of data.wq) fn(q, data.wq); }

  function bump(kind, amt, arg) {
    if (!(amt > 0)) return;
    let changed = false;
    each(q => {
      if (q.k !== kind || q.cl || q.p >= q.n) return;
      const K = KIND[kind]; if (K && K.match && !K.match(q, arg)) return;
      q.p = Math.min(q.n, q.p + amt); changed = true;
      const pct = q.p / q.n;
      if (!q.h2 && pct >= 1) { q.h2 = 1;
        say({ level: 'good', title: 'Objective complete', body: qLab(q) + ' · claim it on the Board (Q)',
          tag: 'rf-progress-done', ttl: 6000 }); }
      else if (!q.h1 && pct >= 0.5) { q.h1 = 1;
        say({ level: 'info', title: 'Halfway', body: qLab(q) + ' · ' + fmt(q.p) + '/' + fmt(q.n),
          tag: 'rf-progress-half', ttl: 4000 }); }
    });
    if (changed) { touch(); if (open) render(); }
  }

  /* ---- event-shaped signals ---- */
  RF.on('catch', (fish, info) => { try {
    if (!fish) return;
    const name = nrm(fish.name), rar = fish.rar || 'common';
    bump('catchAny', 1); bump('catchRar', 1, rar); bump('catchSpecies', 1, name);
    const wx = RF.weather; if (wx === 'rain' || wx === 'storm') bump('catchRain', 1);
    if (F.isNight()) bump('catchNight', 1);
    if (info && info.isNew) bump('dexNew', 1);
    const val = { common: 1, uncommon: 1, rare: 2, epic: 4, legendary: 8 }[rar] || 1;
    renown.add(val + (info && info.isNew ? 4 : 0), info && info.isNew ? 'new species' : 'a good cast');
  } catch (e) { RF.err('05-progress:catch', e, 'warn'); } });

  RF.on('spin', ev => { try {
    bump('spin', 1); if (ev && ev.won) { bump('spinWin', 1); renown.add(2, 'the wheel'); }
  } catch (e) { RF.err('05-progress:spin', e, 'warn'); } });

  RF.on('travel', () => { try { bump('travel', 1); renown.add(3, 'open water'); flush(); }
    catch (e) { RF.err('05-progress:travel', e, 'warn'); } });

  RF.on('unlock', ev => { try { renown.add(40, 'charter · ' + ((RF.WORLDS[ev && ev.world] || {}).name || 'new isle')); flush(); }
    catch (e) { RF.err('05-progress:unlock', e, 'warn'); } });

  RF.on('sold', ev => { try {
    if (!ev) return; bump('sellHot', 1, F.mktMods().hot);
  } catch (e) { RF.err('05-progress:sold', e, 'warn'); } });

  /* ---- state-delta signals: the only thing that works both online and off ---- */
  const snap = { caught: 0, ore: 0, wood: 0, earned: 0, pearls: 0, shares: 0, tools: 0, worlds: 0, treasure: 0, boot: false };
  const SANE = { caught: 400, ore: 8000, wood: 8000, earned: 400000, pearls: 20000, shares: 200, tools: 30 };
  let geodeSeen = null;

  function reseed() {
    snap.caught = st().caught | 0; snap.ore = nOre(); snap.wood = nWood();
    snap.earned = st().earned | 0; snap.pearls = S.pearlsLife | 0; snap.shares = nShares();
    snap.tools = toolSum(); snap.worlds = (S.worlds || []).length; snap.treasure = S.treasure ? 1 : 0;
    snap.boot = true;
  }

  function geodeWatch(oreDelta) {
    if (!geodeSeen) { geodeSeen = RF.oreNodes.filter(n => n.geode); }
    let cracked = 0;
    for (const n of geodeSeen) {
      const was = n._rfpAlive === undefined ? true : n._rfpAlive;
      if (was && !n.alive) cracked++;
      n._rfpAlive = !!n.alive;
    }
    // only trust it on a tick that actually paid ore out: a refused server swing
    // puts the node straight back and must not count as a crack
    return oreDelta > 0 ? cracked : 0;
  }

  function readState() {
    try {
      if (!snap.boot) { reseed(); geodeWatch(0); return; }
      const cur = { caught: st().caught | 0, ore: nOre(), wood: nWood(), earned: st().earned | 0,
        pearls: S.pearlsLife | 0, shares: nShares(), tools: toolSum() };
      const d = {};
      for (const k in cur) { const v = cur[k] - snap[k];
        // a sign-in swaps the whole save under us; a jump that big is a new
        // ledger, not a day's work, so re-baseline instead of paying it out
        d[k] = (v > 0 && v <= SANE[k]) ? v : 0; snap[k] = cur[k]; }

      const g = geodeWatch(d.ore);
      if (g) bump('geode', g);
      if (d.ore) { bump('mineOre', d.ore); drip('ore', d.ore, 3, 'the quarry'); }
      if (d.wood) { bump('chop', d.wood); drip('wood', d.wood, 5, 'the treeline'); }
      if (d.earned) { bump('earn', d.earned); drip('coin', d.earned, 600, 'trade'); }
      if (d.pearls) bump('pearls', d.pearls);
      if (d.shares) { bump('share', d.shares); renown.add(3 * d.shares, 'the exchange'); }
      if (d.tools) { bump('craft', d.tools); renown.add(6 * d.tools, 'the forge'); }

      const tNow = S.treasure ? 1 : 0;
      if (snap.treasure && !tNow) { bump('dig', 1); renown.add(5, 'buried treasure'); }
      snap.treasure = tNow;
      const wNow = (S.worlds || []).length; snap.worlds = wNow;
    } catch (e) { RF.err('05-progress:delta', e, 'warn'); }
  }
  RF.on('hud', readState);

  /* --------------------------------------------------------------------------
     THE SHOP — cosmetic only, and the copy says so. Nothing sold here can move
     luck, yield or price: it would be a lie the moment two people compared.
     ------------------------------------------------------------------------ */
  const SHOP = [
    { id: 'badge', cost: 250, n: 'Rank Pennant', d: 'A floating rank badge over the hero, in your board colour.' },
    { id: 'th_brass', cost: 350, n: 'Board Theme · Brass', d: 'Gold-lit board. The trader\'s own filing cabinet.' },
    { id: 'th_coral', cost: 350, n: 'Board Theme · Coral', d: 'Rose-lit board. Loud, and it knows.' },
    { id: 'th_aurora', cost: 900, n: 'Board Theme · Aurora', d: 'Violet-lit board, from a Frostbite night sky.' },
    { id: 'log', cost: 600, n: 'Expedition Log', d: 'A ship\'s-log strip on Today, written from your ledger.' }];
  const THEME_OF = { th_brass: 'brass', th_coral: 'coral', th_aurora: 'aurora' };
  const ACCENT = { deep: '#39d7c4', brass: '#ffcf5c', coral: '#ff5d7a', aurora: '#c07bff' };

  function buy(id) {
    const it = SHOP.find(x => x.id === id); if (!it || data.own[id]) return;
    if (!renown.spend(it.cost, it.n)) { try { RF.sfx.deny(); } catch (e) {} return; }
    data.own[id] = 1; touch();
    if (THEME_OF[id]) data.theme = THEME_OF[id];
    if (id === 'badge') { data.badge = 1; buildBadge(); }
    try { RF.sfx.craft(); } catch (e) {}
    say({ level: 'good', title: 'Unlocked · ' + it.n, body: '−' + fmt(it.cost) + ' Renown', tag: 'rf-progress-buy', ttl: 4500 });
    applyTheme(); render();
  }

  /* --------------------------------------------------------------------------
     THE BADGE — a makeLabel sprite parented to the hero. Parented, not scene-
     placed, so it can never outlive the player; the frame hook only undoes the
     lean the hero picks up while walking, so it does not swing over his head.
     ------------------------------------------------------------------------ */
  let badge = null, badgeRank = -1, badgeTheme = '';
  const _v = new TH.Vector3(), _q = new TH.Quaternion();

  function dropBadge() {
    if (!badge) return;
    try { if (badge.material.map) badge.material.map.dispose(); badge.material.dispose(); } catch (e) {}
    if (badge.parent) badge.parent.remove(badge);
    badge = null;
  }
  function buildBadge() {
    try {
      const want = data.own.badge && data.badge;
      const rk = rankOf(data.life);
      if (!want) { dropBadge(); return; }
      if (badge && badgeRank === rk.i && badgeTheme === data.theme) return;
      dropBadge();
      badge = F.makeLabel(rk.name.toUpperCase(), ACCENT[data.theme] || ACCENT.deep, false);
      badge.scale.set(2.05, 0.52, 1);
      badge.renderOrder = 3;
      badge.position.set(0, 3.55, 0);
      RF.player.add(badge);
      badgeRank = rk.i; badgeTheme = data.theme;
    } catch (e) { RF.err('05-progress:badge', e, 'warn'); badge = null; }
  }
  RF.on('frame', () => {
    if (!badge) return;
    badge.visible = !RF.capCam;
    if (!badge.visible) return;
    const p = RF.player, s = p.scale;
    _q.copy(p.quaternion).invert();
    _v.set(0, 3.55, 0).applyQuaternion(_q);
    badge.position.set(_v.x / (s.x || 1), _v.y / (s.y || 1), _v.z / (s.z || 1));
  });

  function applyTheme() {
    if (!root) return;
    root.setAttribute('data-rfp-theme', data.theme || 'deep');
    buildBadge();
  }

  /* --------------------------------------------------------------------------
     THE BOARD
     ------------------------------------------------------------------------ */
  const root = RF.el('<div id="rf-progress" role="dialog" aria-label="The Board">' +
    '<div class="rf-prog-card">' +
      '<div class="rf-prog-head">' +
        '<div class="ttl"><div class="eyebrow">The Board</div><h2 id="rf-prog-rank">Deckhand</h2>' +
          '<div class="rk" id="rf-prog-sub"></div></div>' +
        '<div class="rf-prog-bank"><div class="big" id="rf-prog-ren">0</div><div class="lab">RENOWN</div></div>' +
        '<button class="rf-prog-x" id="rf-prog-x" type="button">ESC</button>' +
      '</div>' +
      '<div class="rf-prog-rankbar"><i id="rf-prog-rankbar" style="width:0%"></i></div>' +
      '<div class="rf-prog-tabs" id="rf-prog-tabs"></div>' +
      '<div class="rf-prog-body" id="rf-prog-pane"></div>' +
      '<div class="rf-prog-foot"><span>RENOWN IS NOT COINS</span>' +
        '<span id="rf-prog-foot2">it never converts, and nothing it buys touches <b>luck</b>, <b>yield</b> or <b>price</b></span></div>' +
    '</div></div>');

  const $ = id => document.getElementById(id);
  const TABS = [['today', 'TODAY'], ['week', 'THIS WEEK'], ['ladder', 'LADDER'], ['renown', 'RENOWN']];
  let tab = 'today', open = false;

  const bar = pct => '<div class="rf-prog-bar"><i style="width:' + Math.max(0, Math.min(100, pct * 100)).toFixed(1) + '%"></i></div>';
  const ico = (n, s) => { try { return F.pixSVG(n, s || 15); } catch (e) { return ''; } };

  function questHTML(q, list, i, weekly) {
    const done = q.p >= q.n, pay = Math.max(1, Math.round(qRw(q, weekly) * (weekly ? 1 : streakMult())));
    const sub = qSub(q), K = KIND[q.k] || {};
    return '<div class="rf-prog-q' + (q.cl ? ' claimed' : done ? ' done' : '') + '">' +
      '<div class="rf-prog-qtop">' + ico(K.ic || 'trophy', 16) +
        '<span class="nm">' + esc(qLab(q)) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
        '<span class="val">+' + fmt(pay) + '</span></div>' +
      bar(q.n ? q.p / q.n : 0) +
      '<div class="rf-prog-qfoot"><span class="ct">' + fmt(q.p) + ' / ' + fmt(q.n) + '</span>' +
        (q.cl ? '<span class="ct" style="flex:0 0 auto;color:var(--rfp-a)">CLAIMED</span>'
              : '<button class="rf-prog-btn' + (done ? ' hot' : '') + '" type="button" data-rfp-claim="' +
                (weekly ? 'w' : 'd') + ':' + i + '"' + (done ? '' : ' disabled') + '>' + (done ? 'CLAIM' : 'IN PROGRESS') + '</button>') +
      '</div></div>';
  }

  function logHTML() {
    if (!data.own.log) return '';
    const lines = data.hist.slice(0, 4).map(h => {
      const d = new Date(h.t), hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm + ' · ' + esc(h.w) + ' <b>' + (h.n < 0 ? '−' : '+') + fmt(Math.abs(h.n)) + '</b>';
    });
    const rk = rankOf(data.life);
    return '<div class="rf-prog-log"><div class="lh">Expedition Log</div><div class="ll">' +
      'Day ' + fmt(RF.dayCount + 1) + ' aboard · rated <b>' + esc(rk.name) + '</b> · ' +
      (RF.WORLD.name) + ', ' + (RF.weather === 'clear' ? 'clear' : RF.weather) + (F.isNight() ? ', after dark' : '') + '.<br>' +
      (lines.length ? lines.join('<br>') : 'Nothing entered yet today.') + '</div></div>';
  }

  function paneToday() {
    let h = logHTML();
    h += '<div class="rf-prog-sec">Daily objectives<span>resets in ' + dur(dayEnds()) + '</span></div>';
    h += data.dq.length ? data.dq.map((q, i) => questHTML(q, data.dq, i, false)).join('')
      : '<div class="rf-prog-empty">No dailies posted. They arrive at local midnight.</div>';
    const s = data.streak | 0, m = streakMult();
    h += '<div class="rf-prog-sec">Streak</div>';
    h += '<div class="rf-prog-note">' + (s > 0
      ? '<b>' + s + ' day' + (s > 1 ? 's' : '') + ' running</b> · every daily you claim pays <b>×' + m.toFixed(2) + '</b>. ' +
        'Claim one tomorrow and the chain holds; skip a day and it starts again at one.'
      : 'No streak yet. Claim a daily today and the multiplier starts climbing · +5% a day, up to ×1.75.') + '</div>';
    return h;
  }

  function paneWeek() {
    let h = '<div class="rf-prog-sec">Weekly charter<span>resets in ' + dur(weekEnds()) + '</span></div>';
    h += data.wq.length ? data.wq.map((q, i) => questHTML(q, data.wq, i, true)).join('')
      : '<div class="rf-prog-empty">No charter posted. A new one is drawn every Monday.</div>';
    h += '<div class="rf-prog-note">Weeklies are drawn from the week number, not from luck · ' +
      'a refresh, a reload or a sail to another isle will not reroll them.</div>';
    return h;
  }

  function paneLadder() {
    const cats = [];
    for (const m of LADDER) if (cats.indexOf(m.cat) < 0) cats.push(m.cat);
    let h = '', total = 0, got = 0;
    for (const m of LADDER) { total++; if (data.ms[m.id]) got++; }
    h += '<div class="rf-prog-note"><b>' + got + ' of ' + total + '</b> milestones earned. ' +
      'These are permanent and read straight off your save · progress you made before the Board opened already counts.</div>';
    for (const c of cats) {
      const rows = LADDER.filter(m => m.cat === c);
      const mine = rows.filter(m => data.ms[m.id]).length;
      h += '<div class="rf-prog-sec">' + esc(c) + '<span>' + mine + '/' + rows.length + '</span></div>';
      for (const m of rows) {
        let cur = 0; try { cur = m.cur() | 0; } catch (e) { cur = 0; }
        const done = !!data.ms[m.id], pct = m.need ? Math.min(1, cur / m.need) : 0;
        h += '<div class="rf-prog-m' + (done ? ' got' : '') + '">' + ico(m.icon, 15) +
          '<span class="tr">' + MS_TIER[m.tier] + '</span>' +
          '<span class="mid"><span class="mn">' + esc(m.name) + '</span>' +
            '<span class="mf">' + esc(m.flav) + '</span>' + bar(pct) + '</span>' +
          '<span class="mp">' + fmt(Math.min(cur, m.need)) + ' / ' + fmt(m.need) + '</span>' +
          '<span class="mr">' + (done ? '✓ ' : '+') + fmt(m.rw) + '</span></div>';
      }
    }
    return h;
  }

  function paneRenown() {
    const rk = rankOf(data.life);
    let h = '<div class="rf-prog-note">Renown is the Board\'s own score. It is <b>not coins</b>, it never converts to coins, ' +
      'and every mod in the game pays into it. Your rank is set by <b>lifetime</b> Renown, so spending never demotes you.</div>';
    h += '<div class="rf-prog-sec">Rank ladder<span>lifetime ' + fmt(data.life) + '</span></div>';
    RANKS.forEach((r, i) => {
      h += '<div class="rf-prog-rank' + (i === rk.i ? ' on' : i < rk.i ? ' past' : '') + '">' +
        '<span class="i">' + (i + 1) + '</span><span class="n">' + esc(r[0]) + '</span>' +
        '<span class="a">' + (i <= rk.i ? 'earned' : fmt(r[1])) + '</span></div>';
    });
    h += '<div class="rf-prog-sec">Spend<span>' + fmt(data.ren) + ' available</span></div>';
    for (const it of SHOP) {
      const owned = !!data.own[it.id], isTheme = !!THEME_OF[it.id];
      const active = isTheme ? data.theme === THEME_OF[it.id] : (it.id === 'badge' ? !!data.badge : true);
      let btn;
      if (!owned) btn = '<button class="rf-prog-btn" type="button" data-rfp-buy="' + it.id + '"' +
        (data.ren < it.cost ? ' disabled' : '') + '>UNLOCK</button>';
      else if (isTheme) btn = '<button class="rf-prog-btn' + (active ? ' hot' : '') + '" type="button" data-rfp-theme="' +
        THEME_OF[it.id] + '">' + (active ? 'IN USE' : 'USE') + '</button>';
      else if (it.id === 'badge') btn = '<button class="rf-prog-btn' + (active ? ' hot' : '') + '" type="button" data-rfp-badge="1">' +
        (active ? 'SHOWN' : 'HIDDEN') + '</button>';
      else btn = '<button class="rf-prog-btn hot" type="button" disabled>OWNED</button>';
      h += '<div class="rf-prog-shop"><span class="mid"><span class="sn">' + esc(it.n) + '</span>' +
        '<span class="sd">' + esc(it.d) + '</span></span>' +
        (owned ? '' : '<span class="sc">' + fmt(it.cost) + '</span>') + btn + '</div>';
    }
    if (!data.own.th_brass && !data.own.th_coral && !data.own.th_aurora && data.theme !== 'deep') data.theme = 'deep';
    h += '<div class="rf-prog-sec">Recent ledger</div>';
    if (!data.hist.length) h += '<div class="rf-prog-empty">Nothing on the ledger yet.</div>';
    else for (const e of data.hist.slice(0, 14)) {
      const d = new Date(e.t);
      h += '<div class="rf-prog-h"><span>' + String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + '</span><span class="w">' + esc(e.w) + '</span>' +
        '<span class="v' + (e.n < 0 ? ' neg' : '') + '">' + (e.n < 0 ? '−' : '+') + fmt(Math.abs(e.n)) + '</span></div>';
    }
    return h;
  }

  function render() {
    if (!root) return;
    try {
      const rk = rankOf(data.life);
      const el = $('rf-prog-rank'); if (el) el.textContent = rk.name;
      const sub = $('rf-prog-sub');
      if (sub) sub.innerHTML = rk.next
        ? 'Rank ' + (rk.i + 1) + ' of ' + RANKS.length + ' · <b>' + fmt(rk.next.at - data.life) + '</b> to ' + esc(rk.next.name)
        : 'Rank ' + RANKS.length + ' of ' + RANKS.length + ' · <b>the top of the ladder</b>';
      const rn = $('rf-prog-ren'); if (rn) rn.textContent = fmt(data.ren);
      const rb = $('rf-prog-rankbar'); if (rb) rb.style.width = (rk.progress * 100).toFixed(1) + '%';

      const nClaim = renownClaimable().length;
      const tb = $('rf-prog-tabs');
      if (tb) tb.innerHTML = TABS.map(t => {
        let pip = '';
        if (t[0] === 'today') { const n = data.dq.filter(q => q.p >= q.n && !q.cl).length; if (n) pip = '<span class="pip">' + n + '</span>'; }
        if (t[0] === 'week') { const n = data.wq.filter(q => q.p >= q.n && !q.cl).length; if (n) pip = '<span class="pip">' + n + '</span>'; }
        if (t[0] === 'renown' && !nClaim && 0) pip = '';
        return '<button class="rf-prog-tab' + (tab === t[0] ? ' sel' : '') + '" type="button" data-rfp-tab="' + t[0] + '">' +
          t[1] + pip + '</button>';
      }).join('');

      const pane = $('rf-prog-pane');
      if (pane) pane.innerHTML = tab === 'today' ? paneToday()
        : tab === 'week' ? paneWeek() : tab === 'ladder' ? paneLadder() : paneRenown();
    } catch (e) { RF.err('05-progress:render', e); }
  }

  const renownClaimable = () => data.dq.concat(data.wq).filter(q => q.p >= q.n && !q.cl);

  root.addEventListener('click', e => { try {
    const t = e.target.closest ? e.target : null; if (!t) return;
    const tb = t.closest('[data-rfp-tab]');
    if (tb) { tab = tb.getAttribute('data-rfp-tab'); try { RF.sfx.tab(); } catch (_) {} render(); return; }
    const cl = t.closest('[data-rfp-claim]');
    if (cl) { const v = cl.getAttribute('data-rfp-claim').split(':');
      claim(v[0] === 'w' ? data.wq : data.dq, +v[1]); return; }
    const by = t.closest('[data-rfp-buy]');
    if (by) { buy(by.getAttribute('data-rfp-buy')); return; }
    const th = t.closest('[data-rfp-theme]');
    if (th) { data.theme = th.getAttribute('data-rfp-theme'); touch(); try { RF.sfx.click(); } catch (_) {}
      applyTheme(); render(); return; }
    const bd = t.closest('[data-rfp-badge]');
    if (bd) { data.badge = data.badge ? 0 : 1; touch(); try { RF.sfx.click(); } catch (_) {}
      buildBadge(); render(); return; }
    if (t === root) close();
  } catch (err) { RF.err('05-progress:click', err); } });

  function show() { if (open) return; open = true; rollover(true); applyTheme(); render();
    root.classList.add('on'); try { RF.sfx.open(); } catch (e) {} }
  function close() { if (!open) return; open = false; root.classList.remove('on');
    try { RF.sfx.close(); } catch (e) {} flush(); }
  const btnX = $('rf-prog-x'); if (btnX) btnX.onclick = close;

  const typing = () => { const a = document.activeElement;
    return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };

  RF.on('keydown', e => {
    if (typing()) return;
    if (e.code === 'Escape' && open) { close(); return true; }
    if (e.code === 'KeyQ' && !RF.panelOpen && RF.running) { e.preventDefault(); open ? close() : show(); return true; }
  });
  RF.on('panel', () => { if (open) close(); });   // a core overlay always wins the screen

  /* --------------------------------------------------------------------------
     PUBLISHED SIGNALS — 02-hud reads these to draw its tracker pill.
     ------------------------------------------------------------------------ */
  const asPub = (q, weekly) => ({ id: (weekly ? 'w' : 'd') + ':' + q.k + ':' + q.a, kind: weekly ? 'weekly' : 'daily',
    title: qLab(q), p: q.p, n: q.n, pct: q.n ? Math.min(1, q.p / q.n) : 0,
    done: q.p >= q.n, claimed: !!q.cl, renown: Math.max(1, Math.round(qRw(q, weekly) * (weekly ? 1 : streakMult()))) });

  RF.api.quests = {
    active: () => data.dq.filter(q => !q.cl).map(q => asPub(q, false))
      .concat(data.wq.filter(q => !q.cl).map(q => asPub(q, true))),
    claimable: () => data.dq.filter(q => q.p >= q.n && !q.cl).map(q => asPub(q, false))
      .concat(data.wq.filter(q => q.p >= q.n && !q.cl).map(q => asPub(q, true))),
    all: () => data.dq.map(q => asPub(q, false)).concat(data.wq.map(q => asPub(q, true))),
    resets: () => ({ daily: dayEnds(), weekly: weekEnds() }),
    streak: () => ({ days: data.streak | 0, mult: streakMult() }),
    open: show
  };

  /* --------------------------------------------------------------------------
     TICKERS. Everything below runs at 1 s or slower — the frame hook above is
     three vector writes and nothing else.
     ------------------------------------------------------------------------ */
  RF.every(1.0, () => { if (open && (tab === 'today' || tab === 'week')) {
    // only the countdown moves every second; re-rendering the whole pane would
    // throw away a mid-scroll position, so patch the two labels in place
    try { const secs = root.querySelectorAll('.rf-prog-sec span');
      if (secs.length) secs[0].textContent = 'resets in ' + dur(tab === 'today' ? dayEnds() : weekEnds());
    } catch (e) {} } });

  RF.every(3.0, () => { try {
    readState(); scanLadder(false); rollover(false);
    const d = dayIdx(), left = dayEnds();
    if (left < 1800000 && data.expWarn !== d) {
      const n = data.dq.filter(q => q.p >= q.n && !q.cl).length;
      if (n) { data.expWarn = d; touch();
        say({ level: 'warn', title: 'Claim before midnight',
          body: n + ' finished daily' + (n > 1 ? 'ies' : '') + ' expires in ' + dur(left) + ' · press Q',
          tag: 'rf-progress-expiry', ttl: 9000 }); }
    }
  } catch (e) { RF.err('05-progress:tick', e, 'warn'); } });

  RF.every(2.0, flush);
  addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  addEventListener('pagehide', flush);
  addEventListener('beforeunload', flush);

  /* --------------------------------------------------------------------------
     BOOT
     ------------------------------------------------------------------------ */
  RF.on('ready', () => { try {
    reseed(); geodeWatch(0);
    rollover(true);
    if (!data.boot) { data.boot = Date.now(); scanLadder(true); }
    else scanLadder(false);
    applyTheme(); buildBadge(); flush();
  } catch (e) { RF.err('05-progress:boot', e); } });

  RF.on('start', () => { try {
    geodeSeen = null; geodeWatch(0); reseed(); buildBadge();
    const c = renownClaimable().length;
    const rk = rankOf(data.life);
    say({ level: 'info', title: 'The Board · ' + rk.name,
      body: c ? c + ' objective' + (c > 1 ? 's' : '') + ' ready to claim · press Q'
              : fmt(data.dq.length) + ' dailies and ' + fmt(data.wq.length) + ' weeklies posted · press Q',
      tag: 'rf-progress-hello', ttl: 7000 });
  } catch (e) { RF.err('05-progress:start', e, 'warn'); } });
});
