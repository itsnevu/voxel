/* 01-angler — the craft of fishing: place the bait, read the water, feel the fish, land it.
   1. Charged cast — hold E to load the rod, A/D to swing the aim, release to place the bobber.
   2. Sweet-spot release — a rod-wide green band on the power meter; hit it for a clean, quiet cast.
   3. Aim ring — a live target on the water that tells you what is under it before you commit.
   4. Hot water — a fixed map of ledges, weed beds and wrecks per isle, found by casting into them.
   5. The shoal — a visible school that wanders the bay, boils at the surface, and pays to chase.
   6. Bite tells — nibbles before the take, and a rod that reads the weight of what is down there.
   7. Perfect hookset — a shrinking ring at the bite; set it early and the fish starts tired.
   8. A fish that runs and tires — stamina, named runs, give-line-to-win, a spent fish that comes easy.
   9. The drag dial (Q) — light / medium / heavy, and how much you can safely carry is what your rod buys.
  10. Rhythm and the fight report — a run of clean fights, and a one-line account of every fight you finish.

   HOW IT LAYERS: core's updateFishing() is left running exactly as written — it still
   owns the states, the bait spend, the bucket cap, the streak, the server catch and the
   hero's animation. This file rides on top of `RF.fishing` from the `tick` hook (which
   fires AFTER updateFishing every frame), pinning f.cast during the charge, retargeting
   f.tx/f.tz before the line lands, and adding to f.tens / f.reel during the fight. Every
   threshold that decides anything — the snap at tens>=1, the landing at reel>=1 — is
   still core's, so nothing in here can invent a fish or a coin. */
RF.mod('01-angler', function (RF) {

  const F = RF.fn, T = RF.THREE, S = RF.state;
  const clamp = F.clamp, lerp = F.lerp, rand = F.rand;
  const RORD = RF.RORDER, WT = RF.WATER_TOP, N = RF.N, HALF = RF.HALF;
  const HM = RF.heightMap, FISH = RF.fishing, K = RF.keys, BOB = RF.bobber;
  const sin = Math.sin, cos = Math.cos, atan2 = Math.atan2, hyp = Math.hypot, PI = Math.PI;
  const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const MAXLVL = RF.MAXLVL || 10;

  /* ================= persistence — mine only, never RF.state ================= */
  const KEY = '01-angler';
  const raw = RF.store.get(KEY, null) || {};
  const LOG = {
    landed: Math.max(0, raw.landed | 0), snaps: Math.max(0, raw.snaps | 0),
    perfect: Math.max(0, raw.perfect | 0), missed: Math.max(0, raw.missed | 0),
    bestR: Math.max(0, raw.bestR | 0), drag: clamp(raw.drag | 0, 0, 2),
    found: (raw.found && typeof raw.found === 'object') ? raw.found : {} };
  let logDirty = false;
  const mark = () => { logDirty = true; };
  const flush = () => { if (logDirty) { logDirty = false; RF.store.set(KEY, LOG); } };
  RF.every(8, flush);
  window.addEventListener('beforeunload', flush);

  /* ================= look ================= */
  RF.css([
'#agRod{position:fixed;left:50%;bottom:126px;z-index:5;width:min(346px,84vw);pointer-events:none;',
'  transform:translateX(-50%) translateY(7px);opacity:0;transition:opacity .16s ease,transform .16s ease;',
'  background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);',
'  border:1px solid var(--glass-bd);border-radius:11px;padding:9px 12px 10px;',
'  box-shadow:var(--glass-hi),0 8px 24px rgba(2,8,10,.35);}',
'#agRod.on{opacity:1;transform:translateX(-50%) translateY(0);}',
'#agRod .ag-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:7px;}',
'#agRod .ag-ttl{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;letter-spacing:.22em;',
'  color:var(--teal);text-transform:uppercase;white-space:nowrap;}',
'#agRod .ag-note{flex:1;text-align:right;font-size:10.5px;color:var(--muted);',
'  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
'#agRod .ag-row{display:flex;align-items:center;gap:8px;margin-top:5px;}',
'#agRod .ag-row.off{display:none;}',
'#agRod .ag-lab{flex:0 0 44px;font-size:9px;letter-spacing:.2em;color:var(--lab);text-transform:uppercase;}',
'#agRod .ag-bar{position:relative;flex:1;height:8px;border-radius:5px;overflow:hidden;',
'  background:rgba(255,255,255,.08);border:1px solid var(--glass-bd-soft);}',
'#agRod .ag-bar>i{position:absolute;left:0;top:0;bottom:0;right:0;transform-origin:left center;',
'  transform:scaleX(0);background:var(--teal);transition:background .16s linear;}',
'#agRod .ag-bar>b{position:absolute;top:0;bottom:0;left:0;width:0;display:none;',
'  background:rgba(116,224,138,.30);box-shadow:inset 0 0 0 1px rgba(116,224,138,.8);}',
'#agRod .ag-bar.band>b{display:block;}',
'#agRod .ag-val{flex:0 0 52px;text-align:right;font-family:"Chakra Petch",sans-serif;font-weight:700;',
'  font-size:11.5px;color:var(--ink);font-variant-numeric:tabular-nums;}',
'#agRod .ag-ft{margin-top:8px;font-size:10.5px;color:var(--faint);',
'  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
'#agRod .ag-ft b{color:var(--gold);font-weight:600;}',
'#agRod.hot{border-color:rgba(255,207,92,.5);}',
'#agRod.danger{border-color:rgba(255,93,122,.6);box-shadow:var(--glass-hi),0 8px 24px rgba(255,93,122,.22);}',
'#agRep{position:fixed;left:50%;bottom:126px;z-index:6;transform:translateX(-50%) translateY(8px);',
'  opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;',
'  font-size:11.5px;color:var(--ink);white-space:nowrap;max-width:92vw;overflow:hidden;text-overflow:ellipsis;',
'  background:var(--glass-strong);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);',
'  border:1px solid var(--glass-bd);border-radius:10px;padding:7px 13px;',
'  box-shadow:var(--glass-hi),0 6px 18px rgba(2,8,10,.35);}',
'#agRep.on{opacity:1;transform:translateX(-50%) translateY(0);}',
'#agRep.bad{border-color:var(--rose);} #agRep.good{border-color:var(--teal);}',
'#agRep .k{font-family:"Chakra Petch",sans-serif;font-weight:700;color:var(--gold);}',
'#agRep .d{color:var(--faint);}',
'#agRhy{position:fixed;left:12px;top:300px;z-index:5;display:none;align-items:center;gap:8px;',
'  background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);',
'  border:1px solid var(--glass-bd);border-radius:11px;padding:7px 11px;',
'  box-shadow:var(--glass-hi),0 8px 24px rgba(2,8,10,.35);}',
'#agRhy.on{display:flex;}',
'#agRhy .lab{font-size:9px;letter-spacing:.24em;color:var(--lab);}',
'#agRhy .n{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:14px;color:var(--gold);',
'  font-variant-numeric:tabular-nums;}',
'#agRhy .t{font-size:10px;color:var(--teal);letter-spacing:.06em;}',
'@media (prefers-reduced-motion: reduce){#agRod,#agRep{transition:opacity .16s ease;}}'
  ].join('\n'), '01-angler-css');

  const panel = RF.el('<div id="agRod">'
    + '<div class="ag-hd"><span class="ag-ttl font-d">CAST</span><span class="ag-note"></span></div>'
    + '<div class="ag-row"><span class="ag-lab">power</span><div class="ag-bar"><i></i><b></b></div><span class="ag-val">-</span></div>'
    + '<div class="ag-row"><span class="ag-lab">line</span><div class="ag-bar"><i></i><b></b></div><span class="ag-val">-</span></div>'
    + '<div class="ag-row"><span class="ag-lab">fish</span><div class="ag-bar"><i></i><b></b></div><span class="ag-val">-</span></div>'
    + '<div class="ag-ft"></div></div>');
  const repEl = RF.el('<div id="agRep"></div>');
  const rhyEl = RF.el('<div id="agRhy">' + F.pixSVG('fish', 13)
    + '<span class="lab">RHYTHM</span><span class="n">0</span><span class="t"></span></div>');
  const ttlEl = panel.querySelector('.ag-ttl'), noteEl = panel.querySelector('.ag-note'),
        ftEl = panel.querySelector('.ag-ft');
  const rhyN = rhyEl.querySelector('.n'), rhyT = rhyEl.querySelector('.t');

  /* Three meter rows, recycled between phases rather than rebuilt: the fight runs
     this 60x a second and an innerHTML rewrite there costs more than every other
     line in this file combined. Nothing is written unless the value actually moved. */
  const rows = [];
  { const list = panel.querySelectorAll('.ag-row');
    for (let i = 0; i < list.length; i++) rows.push({
      el: list[i], lab: list[i].querySelector('.ag-lab'), bar: list[i].querySelector('.ag-bar'),
      fill: list[i].querySelector('i'), band: list[i].querySelector('b'), val: list[i].querySelector('.ag-val'),
      v: -9, c: '', l: '', t: '', bs: '' }); }

  function setRow(i, label, v, col, text, bandCss) {
    const r = rows[i];
    if (r.l !== label) { r.l = label; r.lab.textContent = label; }
    if (Math.abs(v - r.v) > 0.006) { r.v = v; r.fill.style.transform = 'scaleX(' + clamp(v, 0, 1).toFixed(3) + ')'; }
    if (r.c !== col) { r.c = col; r.fill.style.background = col; }
    if (r.t !== text) { r.t = text; r.val.textContent = text; }
    const bc = bandCss || '';
    if (r.bs !== bc) { r.bs = bc;
      if (bc) { const p = bc.split(',');
        r.band.style.left = p[0]; r.band.style.width = p[1]; r.bar.classList.add('band'); }
      else r.bar.classList.remove('band'); }
    if (r.el.className !== 'ag-row') r.el.className = 'ag-row';
  }
  function hideRow(i) { const r = rows[i]; if (r.el.className !== 'ag-row off') r.el.className = 'ag-row off'; }

  let ttlCur = '', noteCur = '', ftCur = '', clsCur = '-', shown = false;
  function head(title, note, foot, cls) {
    if (ttlCur !== title) { ttlCur = title; ttlEl.textContent = title; }
    if (noteCur !== note) { noteCur = note; noteEl.innerHTML = note; }
    if (ftCur !== foot) { ftCur = foot; ftEl.innerHTML = foot; }
    const c = cls || '';
    if (clsCur !== c) { clsCur = c; panel.className = c ? c + ' on' : 'on'; }
  }
  function showPanel(on) {
    if (on === shown) return; shown = on;
    if (on) { clsCur = '-'; panel.className = 'on'; } else panel.className = '';
  }

  let repT = 0;
  function report(html, kind) {
    repEl.className = (kind || '') + ' on'; repEl.innerHTML = html; repT = 3.6;
  }

  /* ================= 3D furniture: rings, ripples, the shoal ================= */
  const ringGeo = new T.RingGeometry(0.62, 0.80, 22);
  const flat = m => { m.rotation.x = -PI / 2; m.renderOrder = 6; return m; };
  const ringMat = (col, op) => new T.MeshBasicMaterial({ color: col, transparent: true,
    opacity: op, depthWrite: false, side: T.DoubleSide });

  const aimRing = flat(new T.Mesh(ringGeo, ringMat(0x39d7c4, 0)));
  const aimDot = flat(new T.Mesh(new T.RingGeometry(0.05, 0.17, 12), ringMat(0x39d7c4, 0)));
  const setRing = flat(new T.Mesh(ringGeo, ringMat(0xffcf5c, 0)));   // the hookset timing ring
  const setMark = flat(new T.Mesh(new T.RingGeometry(0.40, 0.50, 20), ringMat(0x74e08a, 0)));
  aimRing.visible = aimDot.visible = setRing.visible = setMark.visible = false;
  RF.scene.add(aimRing); RF.scene.add(aimDot); RF.scene.add(setRing); RF.scene.add(setMark);

  /* every tap, run and landing puts a real ring on the water — pooled, never allocated in-frame */
  const rips = []; let ripI = 0;
  for (let i = 0; i < 12; i++) {
    const m = flat(new T.Mesh(ringGeo, ringMat(0x9fe9ff, 0)));
    m.visible = false; RF.scene.add(m);
    rips.push({ m: m, t: 0, d: 1, r0: 0.18, r1: 1.2, o: 0.5 });
  }
  function ripple(x, z, r1, col, op, dur) {
    if (REDUCE && r1 < 1.4) return;          // keep only the loud ones when motion is dialled down
    const p = rips[ripI]; ripI = (ripI + 1) % rips.length;
    p.t = 0; p.d = dur || 0.9; p.r0 = 0.18; p.r1 = r1 || 1.2; p.o = (op == null) ? 0.5 : op;
    p.m.material.color.setHex(col == null ? 0x9fe9ff : col);
    p.m.position.set(x, WT + 0.055, z); p.m.scale.setScalar(p.r0); p.m.visible = true;
  }
  function ripTick(dt) {
    for (let i = 0; i < rips.length; i++) { const p = rips[i]; if (!p.m.visible) continue;
      p.t += dt; const k = p.t / p.d;
      if (k >= 1) { p.m.visible = false; p.m.material.opacity = 0; continue; }
      p.m.scale.setScalar(lerp(p.r0, p.r1, k * (2 - k)));       // fast out, then coast
      p.m.material.opacity = p.o * (1 - k) * (1 - k); }
  }

  /* ================= reading the water: the isle's hot spots ================= */
  /* Deterministic from the world seed, so the ledge you found last night is in
     exactly the same place tonight. That permanence is what makes it a spot and
     not a random buff — you learn a bay, and the knowledge keeps. */
  const SPOTKIND = [
    { k: 'ledge', col: 0x39d7c4, bite: 0.56, lift: 0.30, say: 'a ledge - the bottom falls away right here' },
    { k: 'weed',  col: 0x74e08a, bite: 0.64, lift: 0.22, say: 'a weed bed - the small stuff hides, the big stuff hunts' },
    { k: 'wreck', col: 0xffcf5c, bite: 0.72, lift: 0.40, say: 'a wreck - something sank here a long time ago' }];
  const spots = [], cand = [];
  try {
    for (let i = 3; i < N - 3; i += 2) for (let j = 3; j < N - 3; j += 2) {
      if (HM[i][j] > 2) continue;
      // castable water only: it has to be within a rod's length of somewhere you can stand
      if (HM[i + 3][j] > 2 || HM[i - 3][j] > 2 || HM[i][j + 3] > 2 || HM[i][j - 3] > 2) cand.push([i, j]);
    }
    const rng = F.mulberry32((((RF.WORLD && RF.WORLD.seed) | 0) * 2654435761 + 0x51ed2701) | 0);
    let guard = 0;
    while (spots.length < 8 && cand.length && guard++ < 500) {
      const c = cand[(rng() * cand.length) | 0], x = c[0] - HALF, z = c[1] - HALF;
      let near = false;
      for (let s = 0; s < spots.length; s++) if (hyp(spots[s].x - x, spots[s].z - z) < 11) { near = true; break; }
      if (near) continue;
      const kind = SPOTKIND[(rng() * SPOTKIND.length) | 0];
      spots.push({ x: x, z: z, r: 1.7 + rng() * 0.9, id: RF.worldKey + ':' + spots.length,
        k: kind.k, col: kind.col, bite: kind.bite, lift: kind.lift, say: kind.say, mesh: null });
    }
    for (let s = 0; s < spots.length; s++) {
      const sp = spots[s], m = flat(new T.Mesh(ringGeo, ringMat(sp.col, 0.2)));
      m.position.set(sp.x, WT + 0.045, sp.z); m.scale.setScalar(sp.r);
      m.visible = false; RF.scene.add(m); sp.mesh = m;
    }
  } catch (e) { RF.warn('01-angler:spots', e); }
  function spotAt(x, z) {
    for (let i = 0; i < spots.length; i++) { const s = spots[i];
      if (hyp(s.x - x, s.z - z) <= s.r) return s; }
    return null;
  }

  /* ================= the shoal ================= */
  const shoalGrp = new T.Group(); shoalGrp.visible = false; RF.scene.add(shoalGrp);
  const shoalFish = [];
  try {
    const bodyG = new T.BoxGeometry(0.62, 0.13, 0.24), finG = new T.BoxGeometry(0.1, 0.2, 0.14);
    const mBody = new T.MeshLambertMaterial({ color: 0x2b5f6b }),
          mFin = new T.MeshLambertMaterial({ color: 0x3f8593 });
    for (let i = 0; i < 9; i++) {
      const g = new T.Group(), b = new T.Mesh(bodyG, mBody), fn = new T.Mesh(finG, mFin);
      fn.position.set(-0.1, 0.13, 0); g.add(b); g.add(fn);
      g.position.set(rand(-1.3, 1.3), 0, rand(-1.3, 1.3));
      g.userData.p = Math.random() * 6.283;
      shoalGrp.add(g); shoalFish.push(g);
    }
  } catch (e) { RF.warn('01-angler:shoal', e); }
  const shoal = { x: 0, z: 0, ax: 0, az: 0, hold: 0, fade: 0, boil: 0, said: -99, live: false };
  function compass(x, z) {
    const dx = x - RF.pWorld.x, dz = z - RF.pWorld.z;
    const ns = dz < -1.5 ? 'north' : dz > 1.5 ? 'south' : '', ew = dx < -1.5 ? 'west' : dx > 1.5 ? 'east' : '';
    return (ns + ew) || 'near';
  }
  function moveShoal(first) {
    if (!cand.length) return;
    const c = cand[(Math.random() * cand.length) | 0];
    shoal.ax = c[0] - HALF; shoal.az = c[1] - HALF;
    shoal.hold = rand(48, 88); shoal.fade = first ? 1 : 0; shoal.live = true;
    if (!first && RF.running) {
      const d = hyp(shoal.ax - RF.pWorld.x, shoal.az - RF.pWorld.z);
      // one shout, and only when it settles somewhere you could actually walk to
      if (d < 17 && RF.clock - shoal.said > 45) { shoal.said = RF.clock;
        F.toast(F.pixSVG('fish', 13) + ' a shoal is working the water to the <b>'
          + compass(shoal.ax, shoal.az) + '</b>', 'good'); }
    }
  }
  moveShoal(true);
  const inShoal = (x, z) => shoal.live && shoal.fade > 0.5 && hyp(shoal.x - x, shoal.z - z) < 2.3;

  /* ================= tuning ================= */
  const FIGHTV = { common: 0.52, uncommon: 0.66, rare: 0.86, epic: 1.06, legendary: 1.32 }; // mirrors core FIGHT
  /* r = extra reel/s while hauling · t = extra line load/s (scaled by the fish) ·
     s = extra fish-stamina burned in the working band. A better rod is exactly what
     makes the heavy setting survivable — that is the whole rod ladder, felt in the hand. */
  const DRAG = [
    { n: 'light',  r: -0.20, t: -0.26, s: -0.09, c: 'var(--teal)',
      say: 'slow and safe - the line will not break, but nothing comes in fast either' },
    { n: 'medium', r: 0.00,  t: 0.00,  s: 0.00,  c: 'var(--gold)', say: 'the honest setting' },
    { n: 'heavy',  r: 0.32,  t: 0.44,  s: 0.15,  c: 'var(--rose)',
      say: 'it comes in fast or it comes off - mind the runs' }];
  const RUNS = ['it dives for the bottom', 'it runs for the rocks', 'a head-shake, hard',
    'it sounds - straight down', 'it turns and runs wide', 'it bores deep and sulks'];
  const READS = [
    'the line lies flat · nothing has found it yet',
    'a tick, then nothing · something is nosing the bait',
    'quick little taps · small mouths, shy ones',
    'a steady nibble · a decent mouth on it',
    'the tip nods twice, then loads · that one has some back to it',
    'slow, heavy knocks · shoulders down there',
    'the rod bows before it has even taken · this is a big one'];
  const TIERS = [[0, ''], [3, 'steady'], [6, 'dialled in'], [10, 'on the fish'], [16, 'hot hands']];
  function tierOf(r) { let t = ''; for (let i = 0; i < TIERS.length; i++) if (r >= TIERS[i][0]) t = TIERS[i][1]; return t; }

  /* ================= live state (all mine — core keeps its own) ================= */
  let ph = 'idle', prev = 'idle', wasAct = false;
  let power = 0, powDir = 1, bandC = 0.7, bandW = 0.06, windup = 0, chargeT = 0;
  let aimBase = 0, aimOff = 0, aimTgt = null, aimSpot = null, aimShoal = false;
  let castQ = 1, expectBite = false, cleanCast = false, castDist = 0;
  let preview = null, weight = 0, spotLift = 0;
  let tellNext = 0, tellN = 0, dip = 0, readIx = 0;
  let hookQ = '', stam = 1, spent = false, inRun = false, runName = '', runDir = 1, runT = 0;
  let fightT = 0, peakT = 0, runN = 0, lastTens = 0;
  let rhythm = 0, drag = LOG.drag;
  let anchorX = 0, anchorZ = 0, anchored = false, landAt = -99;

  function rodOf() {
    const armR = RF.player && RF.player.userData && RF.player.userData.armR;
    if (!armR) return null;
    for (let i = 0; i < armR.children.length; i++) {
      const c = armR.children[i]; if (c.userData && c.userData.tip) return c; }
    return null;
  }
  let rodMesh = rodOf();
  const vTip = new T.Vector3();
  const lineKg = () => (4 + clamp(S.rodLvl, 1, MAXLVL) * 2.6).toFixed(0);
  function baitLine() {
    const b = RF.BAITS[S.baitId];
    return (b && S.bait[S.baitId] > 0) ? b.name + ' x' + S.bait[S.baitId] : 'a bare hook';
  }

  /* Where a cast of this length in this direction actually lands: step back from the
     far end until we find open water, so a long throw over a sandbar simply drops
     short instead of hanging the bobber on the beach. */
  function aimAt(ang, dist) {
    const px = RF.pWorld.x, pz = RF.pWorld.z, sx = sin(ang), sz = cos(ang);
    for (let d = dist; d >= 0.85; d -= 0.32) {
      const x = px + sx * d, z = pz + sz * d;
      if (Math.abs(x) > HALF - 1.5 || Math.abs(z) > HALF - 1.5) continue;
      const i = clamp(Math.round(x + HALF), 0, N - 1), j = clamp(Math.round(z + HALF), 0, N - 1);
      if (HM[i][j] <= 2) return { x: i - HALF, z: j - HALF, d: d };
    }
    return null;
  }

  function resetFish() {
    ph = 'idle'; preview = null; expectBite = false; anchored = false; inRun = false;
    stam = 1; spent = false; runN = 0; peakT = 0; fightT = 0; tellN = 0; dip = 0; readIx = 0;
    aimRing.visible = aimDot.visible = setRing.visible = setMark.visible = false;
    showPanel(false);
    if (rodMesh) rodMesh.rotation.z = 0;
  }

  function paintRhythm() {
    const t = tierOf(rhythm), on = rhythm >= 2;
    if (rhyEl.classList.contains('on') !== on) rhyEl.classList.toggle('on', on);
    const n = String(rhythm);
    if (rhyN.textContent !== n) rhyN.textContent = n;
    if (rhyT.textContent !== t) rhyT.textContent = t;
  }
  paintRhythm();

  /* ================= 1/2: the charged cast ================= */
  function beginCharge() {
    ph = 'charge'; power = 0.06; powDir = 1; windup = 0; chargeT = 0;
    // the band drifts every cast and widens with the rod: a Poseidon Rod forgives, an Old Rod does not
    bandC = rand(0.40, 0.90); bandW = 0.040 + 0.0125 * clamp(S.rodLvl, 1, MAXLVL);
    const dx = FISH.tx - RF.pWorld.x, dz = FISH.tz - RF.pWorld.z;
    aimBase = (dx * dx + dz * dz) > 0.02 ? atan2(dx, dz) : RF.pWorld.face;
    aimOff = 0; aimTgt = null; aimSpot = null; aimShoal = false;
  }

  const reach = () => 1.5 + power * (3.5 + (clamp(S.rodLvl, 1, MAXLVL) - 1) * 0.55);

  function releaseCast() {
    const t = aimTgt || aimAt(aimBase + aimOff, reach());
    if (t) { FISH.tx = t.x; FISH.tz = t.z; castDist = t.d; }
    else castDist = hyp(FISH.tx - RF.pWorld.x, FISH.tz - RF.pWorld.z);
    cleanCast = Math.abs(power - bandC) <= bandW;
    const sp = spotAt(FISH.tx, FISH.tz), sh = inShoal(FISH.tx, FISH.tz);
    castQ = 1; spotLift = 0;
    if (cleanCast) castQ *= 0.62;
    else if (power > 0.88) castQ *= 1.22;         // a slapped cast lands hard and puts the water down
    if (sp) { castQ *= sp.bite; spotLift += sp.lift;
      if (!LOG.found[sp.id]) { LOG.found[sp.id] = 1; mark(); flush();
        F.toast(F.pixSVG('map', 13) + ' ' + sp.say, 'gold'); } }
    if (sh) { castQ *= 0.34; spotLift += 0.34; }
    expectBite = true; ph = 'fly';
    // the whip: pitch rides the power, so you hear how far you just threw it
    F.sweep(260 + power * 200, 900 + power * 500, 0.16, 'sine', 0.035);
    if (cleanCast) { F.beep(1320, 0.06, 'triangle', 0.03); F.addShake(0.02); }
    aimRing.visible = aimDot.visible = false;
  }

  /* ================= 6: the wait, and what the rod is telling you ================= */
  function onSettled() {
    ph = 'wait'; tellN = 0; readIx = 0; dip = 0;
    tellNext = FISH.biteAt * rand(0.30, 0.46);
    /* Roll the fish NOW, offline, with the very rollFish() core would call a few
       seconds later — so the tells are honest about what is under the bobber
       instead of decorating a coin flip. Online the server owns the roll, and the
       tells read the FIGHT instead, which is exactly what they end up predicting. */
    preview = null;
    if (!RF.online) {
      try {
        preview = F.rollFish();
        // good water stirs better fish: the same best-of-two trick core uses for weather
        if (preview && spotLift > 0 && Math.random() < spotLift) {
          const g = F.rollFish();
          if (g && RORD[g.rar] > RORD[preview.rar]) preview = g; }
      } catch (e) { RF.warn('01-angler:roll', e); preview = null; }
    }
    weight = preview
      ? clamp(RORD[preview.rar] / 4 * 0.72 + clamp(preview.kg / 24, 0, 1) * 0.28, 0, 1)
      : clamp(Math.pow(Math.random(), 1.7) * 0.9 + spotLift * 0.45, 0, 1);
    ripple(FISH.tx, FISH.tz, 1.5, 0xd9f6ff, 0.45, 1.0);
  }

  function tell() {
    tellN++; dip = 0.26;
    const heavy = weight > 0.6;
    ripple(BOB.position.x, BOB.position.z, heavy ? 0.95 : 0.6, 0x9fe9ff, heavy ? 0.5 : 0.34, heavy ? 0.9 : 0.6);
    F.beep(heavy ? 190 : 340, heavy ? 0.07 : 0.04, 'sine', 0.022);
    readIx = tellN === 1 ? 1 : clamp(2 + Math.round(weight * 4), 2, 6);
    tellNext = rand(0.42, 0.86) * (heavy ? 1.25 : 0.8);
  }

  /* ================= 7: the hookset ================= */
  function onHook() {
    const rt = FISH.t;               // core never resets t at the hookset — that IS the reaction time
    hookQ = rt <= 0.20 ? 'perfect' : rt <= 0.42 ? 'clean' : 'late';
    if (!RF.online && preview) { FISH.hooked = preview; FISH.fight = FIGHTV[preview.rar] || 0.7; }
    stam = 1; spent = false; inRun = false; runN = 0; runT = 0; fightT = 0; peakT = 0;
    runDir = Math.random() < 0.5 ? -1 : 1; runName = ''; anchored = false;
    if (hookQ === 'perfect') {
      stam = 0.70; FISH.reel = Math.max(FISH.reel, 0.14);
      LOG.perfect++; mark(); F.addShake(0.06);
      ripple(BOB.position.x, BOB.position.z, 2.0, 0x74e08a, 0.6, 0.75);
      F.beep(1046, 0.07, 'triangle', 0.045); F.beep(1568, 0.09, 'sine', 0.028);
    } else if (hookQ === 'late') {
      FISH.tens = Math.max(FISH.tens, 0.30);          // a slow hand starts the fight already loaded
    }
    ph = 'fight'; setRing.visible = setMark.visible = false;
  }

  /* ================= 8/9: the fight ================= */
  function fight(dt) {
    const f = FISH, hold = !!K.act, D = DRAG[drag];
    fightT += dt; if (f.tens > peakT) peakT = f.tens;

    if (f.surge && !inRun) {
      inRun = true; runT = 0; runN++;
      runDir = Math.random() < 0.5 ? -1 : 1;
      runName = RUNS[(Math.random() * RUNS.length) | 0];
      if (!REDUCE) F.addShake(0.05);
      ripple(BOB.position.x, BOB.position.z, 1.7, 0x57b7ff, 0.45, 0.8);
    } else if (!f.surge && inRun) { inRun = false; runName = ''; }
    if (inRun) runT += dt;

    /* THE FIGHT, in four sentences: work it inside the band and the fish burns down;
       horse it through a run and the line loads hard for ground you immediately lose;
       give line while it runs and the drag does the tiring for you; a spent fish stops
       fighting and the last stretch comes in easy. Every one of these only ever ADDS
       to core's own tug-of-war, so core's snap and core's landing still decide. */
    const tired = 0.72 + weight * 1.15;               // a big fish simply has more to give
    if (hold) {
      f.reel = clamp(f.reel + dt * D.r, 0, 1);
      f.tens = clamp(f.tens + dt * D.t * f.fight * (1 - (clamp(S.rodLvl, 1, MAXLVL) - 1) * 0.09), 0, 1);
      if (f.surge) {
        f.tens = clamp(f.tens + dt * 0.52, 0, 1);
        f.reel = clamp(f.reel - dt * 0.24, 0, 1);
      } else if (f.tens > 0.34 && f.tens < 0.78) {
        stam -= dt * (0.34 + D.s) / tired;
        f.reel = clamp(f.reel + dt * 0.15, 0, 1);
      }
    } else if (f.surge) {
      stam -= dt * 0.30 / tired;                      // give line: it wears itself out against the drag
    }

    if (stam <= 0 && !spent) {
      spent = true; stam = 0;
      f.surge = 0; f.surgeT = 99;                     // nothing left in it to run with
      F.beep(392, 0.1, 'triangle', 0.04); F.beep(523, 0.14, 'triangle', 0.035);
      ripple(BOB.position.x, BOB.position.z, 2.4, 0xffcf5c, 0.5, 1.0);
    }
    if (spent) { f.tens = clamp(f.tens - dt * 0.55, 0, 1); f.reel = clamp(f.reel + dt * 0.48, 0, 1); }
    stam = clamp(stam, 0, 1);
  }

  /* ================= 10: how it ended ================= */
  function finish(kind) {
    const t = fightT.toFixed(1) + 's', pk = Math.round(peakT * 100) + '%';
    const hk = hookQ === 'perfect' ? '<span class="k">perfect hookset</span>'
      : hookQ === 'late' ? '<span class="d">a slow hookset</span>' : 'clean hookset';
    const rn = runN === 0 ? 'no runs' : runN === 1 ? '1 run' : runN + ' runs';
    if (kind === 'land') {
      LOG.landed++; rhythm++; if (rhythm > LOG.bestR) LOG.bestR = rhythm;
      mark(); paintRhythm(); landAt = RF.clock;
      const nm = (!RF.online && preview)
        ? '<b style="color:' + (RF.RAR[preview.rar] || 'var(--ink)') + '">' + preview.name + '</b> · ' : '';
      report(nm + 'landed in <span class="k">' + t + '</span> · ' + rn + ' · ' + hk
        + ' · line peaked ' + pk + (spent ? ' · <span class="d">played out</span>' : '')
        + ' <span class="d">· ' + LOG.landed + ' landed / ' + LOG.snaps + ' lost</span>', 'good');
      ripple(BOB.position.x, BOB.position.z, 3.0, 0xd9f6ff, 0.5, 1.2);
    } else if (kind === 'snap') {
      LOG.snaps++; mark();
      if (rhythm >= 3) F.toast('the run ends at ' + rhythm + ' · rhythm gone', 'bad');
      rhythm = 0; paintRhythm();
      report('the line let go at <span class="k">' + t + '</span> · ' + rn + ' · you carried it at '
        + pk + ' · <span class="d">' + DRAG[drag].n + ' drag</span>', 'bad');
    } else if (kind === 'miss') {
      LOG.missed++; mark(); rhythm = 0; paintRhythm();
      report('too slow off the take · <span class="d">the hook never found anything</span>', 'bad');
    }
    resetFish();
  }

  /* ================= the drag dial ================= */
  RF.on('keydown', e => {
    if (!e || e.code !== 'KeyQ') return false;
    if (!RF.running || RF.panelOpen || RF.chatOpen) return false;
    drag = (drag + 1) % 3; LOG.drag = drag; mark(); flush();
    F.beep(520 + drag * 160, 0.05, 'square', 0.032);
    F.toast(F.pixSVG('rod', 13) + ' drag <b style="color:' + DRAG[drag].c + '">' + DRAG[drag].n
      + '</b> · ' + DRAG[drag].say, drag === 2 ? 'bad' : drag === 0 ? '' : 'good');
    return true;
  });

  /* ================= pipelines ================= */
  /* Consumed exactly once, and only for the cast we just made — the planted rig
     calls biteTime() too and must never inherit the ledge you found. */
  RF.modify('biteTime', v => {
    if (!expectBite || FISH.state !== 'wait') return v;
    expectBite = false; return v * castQ;
  });

  RF.modify('hint', h => {
    if (ph === 'idle' || RF.panelOpen) return h;
    if (ph === 'charge') return '<span class="key">E</span> hold to load · <span class="key">A</span>'
      + '<span class="key">D</span> swing the aim · let go to cast';
    if (ph === 'fly') return 'the line arcs out...';
    if (ph === 'wait') return READS[readIx] + ' · <span class="key">ESC</span> reel in';
    if (ph === 'bite') return '<b style="color:var(--rose)">!</b> <b>SET THE HOOK</b> - <span class="key">E</span>';
    if (ph === 'fight') return inRun
      ? '<b style="color:var(--rose)">' + runName + '</b> · give it line'
      : 'hold <span class="key">E</span> to work it · <span class="key">Q</span> drag · let go when it runs';
    return h;
  });

  /* An offline-only reward for a clean run, riding on top of core's own streak.
     Online the server owns every coin, so this must not fire — and does not. */
  RF.on('catch', (fish, info) => {
    if (!fish || !info || info.auto) return;
    if (ph !== 'fight' && RF.clock - landAt > 2.2) return;   // a treasure-chest fish is not ours
    if (RF.online) return;
    let m = 1 + Math.min(0.18, rhythm * 0.02);
    if (hookQ === 'perfect') m += 0.06;
    if (m > 1.001) fish.val = Math.max(1, Math.round(fish.val * m));
  });

  /* ================= the frame ================= */
  RF.on('frame', dt => { ripTick(dt); });

  // distance culling for world furniture — twice a second is plenty for a fade
  RF.every(0.45, () => {
    const on = RF.running, px = RF.pWorld.x, pz = RF.pWorld.z;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i], d = hyp(s.x - px, s.z - pz), vis = on && d < 16;
      if (s.mesh.visible !== vis) s.mesh.visible = vis;
      // an unfound spot is only a faint shimmer; cast into it once and it stays lit
      if (vis) s.mesh.material.opacity = 0.20 * clamp((16 - d) / 5, 0, 1) * (LOG.found[s.id] ? 1 : 0.45);
    }
    const sd = hyp(shoal.ax - px, shoal.az - pz);
    shoalGrp.visible = on && shoal.live && sd < 28;
  });

  const vPerp = { x: 0, z: 0 };

  RF.on('tick', dt => {
    const f = FISH, s = f.state;

    /* ---- the shoal keeps swimming whatever else you are doing ---- */
    if (shoal.live) {
      shoal.hold -= dt;
      shoal.fade = clamp(shoal.fade + dt * (shoal.hold < 2.2 ? -0.9 : 0.9), 0, 1);
      if (shoal.hold <= 0) moveShoal(false);
      const a = RF.clock * 0.28;
      let sx = shoal.ax + cos(a) * 1.15, sz = shoal.az + sin(a * 0.83) * 1.15;
      const i = clamp(Math.round(sx + HALF), 0, N - 1), j = clamp(Math.round(sz + HALF), 0, N - 1);
      if (HM[i][j] > 2) { sx = shoal.ax; sz = shoal.az; }     // never let the school swim up the beach
      shoal.x = sx; shoal.z = sz;
      if (shoalGrp.visible) {
        shoalGrp.position.set(sx, WT - 0.12, sz);
        shoalGrp.scale.setScalar(0.25 + shoal.fade * 0.75);
        shoalGrp.rotation.y = a * 1.6;
        for (let k = 0; k < shoalFish.length; k++) {
          const g = shoalFish[k];
          g.position.y = sin(RF.clock * 2.2 + g.userData.p) * 0.07;
          g.rotation.y = sin(RF.clock * 1.4 + g.userData.p) * 0.4;
        }
        shoal.boil -= dt;
        if (shoal.boil <= 0) { shoal.boil = rand(3.2, 7.5);
          if (shoal.fade > 0.6) ripple(sx + rand(-1, 1), sz + rand(-1, 1), 1.1, 0xd9f6ff, 0.3, 1.0); }
      }
    }

    if (!RF.running) { if (ph !== 'idle') resetFish(); prev = s; return; }
    if (repT > 0 && (repT -= dt) <= 0) repEl.className = '';

    /* ---- phase edges, read straight off core's own state machine ---- */
    if (s !== prev) {
      if (s === 'cast' && prev === 'idle') beginCharge();
      else if (s === 'wait' && prev === 'cast') onSettled();
      else if (s === 'bite' && prev === 'wait') {
        ph = 'bite'; ripple(BOB.position.x, BOB.position.z, 1.3, 0xff5d7a, 0.55, 0.7); }
      else if (s === 'reel' && prev === 'bite') onHook();
      /* how core left the fight: reel full = landed, tension pinned = snapped,
         anything else = you pressed ESC and walked away */
      else if (s === 'idle' && prev === 'reel') finish(f.reel >= 0.999 ? 'land' : lastTens >= 0.995 ? 'snap' : 'off');
      else if (s === 'idle' && prev === 'bite') finish('miss');
      else if (s === 'idle') resetFish();
      prev = s;
    }
    lastTens = f.tens;

    if (ph === 'idle') { wasAct = !!K.act; return; }

    /* a panel over the top freezes the rod exactly where it was — no cast is lost
       because the inventory happened to be open mid-charge */
    if (RF.panelOpen) { if (ph === 'charge') f.cast = Math.min(f.cast, windup); wasAct = !!K.act; return; }

    showPanel(true);
    const px = RF.pWorld.x, pz = RF.pWorld.z;

    /* ---------- 1/2/3: the charge, the band, the aim ring ---------- */
    if (ph === 'charge') {
      chargeT += dt;
      windup = Math.min(0.235, windup + dt * 0.9);   // let core's whip play its wind-up, then hold the pose
      f.cast = Math.min(f.cast, windup);
      power += powDir * dt * 0.82;
      if (power >= 1) { power = 1; powDir = -1; }
      if (power <= 0.06) { power = 0.06; powDir = 1; }
      if (K.left) aimOff -= dt * 0.95;
      if (K.right) aimOff += dt * 0.95;
      aimOff = clamp(aimOff, -1.0, 1.0);

      aimTgt = aimAt(aimBase + aimOff, reach());
      aimSpot = aimTgt ? spotAt(aimTgt.x, aimTgt.z) : null;
      aimShoal = aimTgt ? inShoal(aimTgt.x, aimTgt.z) : false;
      if (aimTgt) {
        const col = aimShoal ? 0xffcf5c : aimSpot ? aimSpot.col : 0x39d7c4;
        aimRing.position.set(aimTgt.x, WT + 0.07, aimTgt.z);
        aimDot.position.copy(aimRing.position);
        aimRing.material.color.setHex(col); aimDot.material.color.setHex(col);
        aimRing.material.opacity = 0.5 + ((aimSpot || aimShoal) ? 0.28 : 0);
        aimDot.material.opacity = 0.75;
        aimRing.scale.setScalar(0.85 + sin(RF.clock * 5) * (REDUCE ? 0 : 0.07));
        aimRing.visible = aimDot.visible = true;
      } else { aimRing.visible = aimDot.visible = false; }

      // the bobber hangs off the rod tip while it is loaded, not halfway to the water
      if (!rodMesh) rodMesh = rodOf();
      if (rodMesh) { vTip.copy(rodMesh.userData.tip); rodMesh.localToWorld(vTip); BOB.position.copy(vTip); }

      const inBand = Math.abs(power - bandC) <= bandW;
      head('CAST',
        aimShoal ? '<span style="color:var(--gold)">into the shoal</span>'
          : aimSpot ? '<span style="color:var(--teal)">' + aimSpot.k + '</span>'
          : aimTgt ? 'open water' : '<span style="color:var(--rose)">no water that way</span>',
        'Lv.' + S.rodLvl + ' rod · line rated <b>' + lineKg() + ' kg</b> · ' + baitLine(),
        inBand ? 'hot' : '');
      setRow(0, 'power', power, inBand ? 'var(--c-uncommon)' : 'var(--teal)',
        aimTgt ? aimTgt.d.toFixed(1) + ' m' : '-',
        (Math.max(0, bandC - bandW) * 100).toFixed(1) + '%,' + (bandW * 200).toFixed(1) + '%');
      hideRow(1); hideRow(2);

      if ((wasAct && !K.act) || chargeT > 6.5) releaseCast();  // your arm gets tired eventually
      wasAct = !!K.act; return;
    }

    if (ph === 'fly') {
      head('CAST', castDist.toFixed(1) + ' m',
        cleanCast ? '<b>a clean cast</b> · it lands soft and the water never knows'
          : 'it lands where it lands', cleanCast ? 'hot' : '');
      setRow(0, 'flight', f.cast, 'var(--teal)', '-', '');
      hideRow(1); hideRow(2); wasAct = !!K.act; return;
    }

    /* ---------- 6: the wait ---------- */
    if (ph === 'wait') {
      tellNext -= dt;
      if (tellNext <= 0 && f.t < f.biteAt - 0.12) tell();
      if (dip > 0) { dip = Math.max(0, dip - dt * 1.5);
        BOB.position.y = WT + 0.1 - dip * (0.42 + weight * 0.5); }
      const heavy = weight > 0.6;
      head('THE WAIT', tellN ? tellN + (tellN === 1 ? ' tell' : ' tells') : 'still',
        (spotLift > 0.2 ? '<b>good water</b> · ' : '') + READS[readIx], '');
      setRow(0, 'tells', clamp(tellN / 4, 0, 1), heavy ? 'var(--gold)' : 'var(--teal)',
        tellN ? (heavy ? 'heavy' : 'light') : '-', '');
      hideRow(1); hideRow(2); wasAct = !!K.act; return;
    }

    /* ---------- 7: the hookset window ---------- */
    if (ph === 'bite') {
      const k = clamp(f.t / 0.85, 0, 1), good = f.t <= 0.20;
      setRing.position.set(BOB.position.x, WT + 0.08, BOB.position.z);
      setMark.position.copy(setRing.position);
      setRing.scale.setScalar(lerp(2.6, 0.42, k));
      setRing.material.opacity = 0.75 * (1 - k * 0.4);
      setRing.material.color.setHex(good ? 0x74e08a : 0xffcf5c);
      setMark.material.opacity = 0.55;
      setMark.visible = setRing.visible = true;
      head('SET THE HOOK', good ? '<span style="color:var(--c-uncommon)">now</span>' : 'it is spitting it',
        'press <span class="key">E</span> · early sets the hook clean and the fish starts tired', 'danger');
      setRow(0, 'window', 1 - k, good ? 'var(--c-uncommon)' : 'var(--rose)',
        Math.max(0, 0.85 - f.t).toFixed(2) + 's', '76.5%,23.5%');
      hideRow(1); hideRow(2); wasAct = !!K.act; return;
    }

    /* ---------- 8/9: the fight, and the fight made visible ---------- */
    if (ph === 'fight') {
      fight(dt);
      if (!anchored) { anchorX = BOB.position.x; anchorZ = BOB.position.z; anchored = true; }
      // the bobber comes in as you gain on it, and cuts sideways every time it runs
      const dx = anchorX - px, dz = anchorZ - pz, dl = Math.max(0.001, hyp(dx, dz));
      vPerp.x = -dz / dl; vPerp.z = dx / dl;
      const sw = sin(RF.clock * (inRun ? 4.2 : 1.7)) * runDir * (inRun ? 0.62 : 0.13) * (1 - f.reel * 0.45);
      BOB.position.x = lerp(anchorX, px, f.reel * 0.58) + vPerp.x * sw;
      BOB.position.z = lerp(anchorZ, pz, f.reel * 0.58) + vPerp.z * sw;
      if (inRun) {
        BOB.position.y -= Math.min(0.26, runT * 0.7);         // it sounds, and the bobber goes under
        if (!REDUCE && Math.random() < 0.22)
          ripple(BOB.position.x, BOB.position.z, 0.75, 0x9fe9ff, 0.28, 0.55);
      }
      if (!rodMesh) rodMesh = rodOf();
      // core sets rotation.x fresh every frame, so this is a delta, not a fight over it
      if (rodMesh) { rodMesh.rotation.x -= f.tens * 0.55; rodMesh.rotation.z = runDir * f.tens * 0.30; }

      const tc = f.tens > 0.80 ? 'var(--rose)' : f.tens > 0.55 ? 'var(--gold)' : 'var(--teal)';
      const band = K.act && !f.surge && f.tens > 0.34 && f.tens < 0.78;
      head(inRun ? 'IT RUNS' : spent ? 'PLAYED OUT' : 'THE FIGHT',
        '<span style="color:' + DRAG[drag].c + '">' + DRAG[drag].n + ' drag</span>'
          + (band ? ' · <span style="color:var(--c-uncommon)">working it</span>' : ''),
        inRun ? '<b>' + runName + '</b> - let go and let the drag do it'
          : spent ? 'it has nothing left · bring it in'
          : 'hold <span class="key">E</span> in the middle of the line and it burns down',
        (f.tens > 0.85 || inRun) ? 'danger' : spent ? 'hot' : '');
      setRow(0, 'line', f.tens, tc, Math.round(f.tens * 100) + '%', '34%,44%');
      setRow(1, 'fish', f.reel, 'var(--c-rare)', Math.round(f.reel * 100) + '%', '');
      setRow(2, 'fight', stam, spent ? 'var(--faint)' : 'var(--c-epic)',
        spent ? 'spent' : Math.round(stam * 100) + '%', '');
      wasAct = !!K.act; return;
    }
    wasAct = !!K.act;
  });

  // the rod readout is world furniture, not menu furniture
  RF.on('panel', () => { if (RF.panelOpen) showPanel(false); });
});
