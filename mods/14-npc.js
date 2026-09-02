/* ============================================================================
   14-npc — the people of the isle. The stall had nobody behind it and the wheel
   had nobody turning it; now five voxel characters stand somewhere, do something,
   and have something true to say.

   1. THE CAST — Fishmonger, Croupier, Shipwright, Quarry Hand, and a Peddler who
      actually walks the BFS-carved path cells between the posts. Each is core's
      own humanoid() rig with its own palette, silhouette and one prop, placed
      BESIDE its station so core's distance-based E prompt is never touched.
   2. LIFE — breathing, weight shifts, a head that tracks you inside nine units,
      a trade fidget on a long timer. One 25 Hz budget; anything off-camera,
      asleep or behind a panel costs nothing at all.
   3. VOICE — pooled DOM speech bubbles projected off the head. Idle barks on a
      long randomised timer, reactive lines fired from RF events on a cooldown,
      and the day's rumour, offered unprompted the first time you walk up.
   4. RUMOURS THAT DO NOT LIE — a rumour that lies is worse than no rumour, so
      every one is computed from the same function the game decides with
      (mktMods, stockPrice, WORLD.fish, oreNodes) at the moment it is spoken.
      The market lookahead refuses to speak at all if its local copy of
      mktModsAt ever disagrees with core's mktMods() on the current epoch.
   5. TALK (R) — pixel-art portrait, four topics of real information about their
      domain, and a familiarity counter that unlocks two more.
   6. SCHEDULE — posts by day. At dusk the stall shutters and Meg walks off, the
      Shipwright turns in, the Peddler makes camp with a fire, and the house
      never sleeps. Everyone fades rather than pops.

   They trade nothing, grant nothing, and never touch an economy field.
   ========================================================================== */
RF.mod('14-npc', function (RF) {
  'use strict';

  const T = RF.THREE, F = RF.fn, D = document, scene = RF.scene, cam = RF.camera, P = RF.pWorld;
  const clamp = F.clamp, lerp = F.lerp, lerpAngle = F.lerpAngle, TAU = RF.TAU;
  const N = RF.N, HALF = RF.HALF, HM = RF.heightMap, WT = RF.WATER_TOP, CAVE = !!RF.WORLD.cave;
  const fmt = F.fmt, pix = F.pixSVG, hAt = F.heightAt;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');

  /* Persisted: familiarity only. Nothing here is worth anything — it remembers
     conversations, not currency, so a wiped store costs two unlocked lines. */
  let PR = Object.assign({ fam: {}, met: {} }, RF.store.get('14-npc') || {});
  if (!PR.fam || typeof PR.fam !== 'object') PR.fam = {};
  if (!PR.met || typeof PR.met !== 'object') PR.met = {};
  let prT = 0; const savePR = () => { clearTimeout(prT); prT = setTimeout(() => RF.store.set('14-npc', PR), 400); };

  /* ==========================================================================
     A. THE TRUTH ENGINE — everything an NPC claims is derived here, from the
     same functions the game decides with. Nothing in this block invents.
     ========================================================================== */
  /* mktModsAt is core-private, and so is the hash under it, so we keep our own
     copy — and never trust it: mktOK() re-derives the CURRENT epoch and compares
     against core's mktMods() before any lookahead is allowed to open its mouth. */
  const MK = RF.MKT_CATS || ['fish', 'wood', 'coal', 'iron', 'gold', 'diamond'], MKS = RF.MKT_MS || 180000;
  const hsh = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
  function mktAt(e) { const hi = Math.floor(hsh(e, 7) * MK.length) % MK.length;
    let lo = Math.floor(hsh(e, 13) * (MK.length - 1)) % (MK.length - 1); if (lo >= hi) lo++;
    return { hot: MK[hi], cold: MK[lo] }; }
  const mktOK = () => { try { const a = mktAt(F.mktEpochNow()), b = F.mktMods();
    return !!(b && a.hot === b.hot && a.cold === b.cold); } catch (e) { return false; } };
  const epochLeft = () => (MKS - (Date.now() % MKS)) / 1000;
  const catN = c => { try { return F.catLabel(c); } catch (e) { return c; } };
  const pct = x => (x * 100).toFixed(1) + '%';
  const hms = s => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? m + 'm ' + (s % 60) + 's' : s + 's'; };

  /* DAY_LEN is a core constant we are not handed, so we measure it rather than
     guess it: two samples of RF.dayT six seconds apart land inside a percent. */
  let dayLen = 420, dayS = null;
  function calibrateDay(now) {
    if (CAVE || !RF.running) return;
    const d = RF.dayT; if (!dayS) { dayS = { t: now, v: d }; return; }
    const dt = (now - dayS.t) / 1000, dv = d - dayS.v; if (dt < 6) return;
    if (dv > 1e-4 && dv < 0.4) { const est = dt / dv; if (est > 60 && est < 4000) dayLen = lerp(dayLen, est, 0.5); }
    dayS = { t: now, v: d }; }
  function tilNight() {
    if (CAVE) return { night: true, eternal: true, secs: 0 };
    const d = RF.dayT, night = F.isNight(), tgt = night ? 0.13 : 0.72;
    return { night: night, eternal: false, secs: ((((tgt - d) % 1) + 1) % 1) * dayLen }; }

  /* Bearings are quoted the way the player reads them: W walks toward -x,-z and
     the minimap is rotated so that direction is map-up, so map-up is north. */
  const FX = -Math.SQRT1_2, FZ = -Math.SQRT1_2, RX = Math.SQRT1_2, RZ = -Math.SQRT1_2;
  const COMP = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  function bearing(dx, dz) { let a = Math.atan2(dx * RX + dz * RZ, dx * FX + dz * FZ);
    if (a < 0) a += TAU; return COMP[Math.round(a / (TAU / 8)) & 7]; }

  const WFISH = RF.WORLD.fish || RF.TABLE || [];
  const byCond = c => WFISH.filter(e => e[2] === c).map(e => e[0]).sort((a, b) => b.val - a.val);
  const NIGHTF = byCond('night'), STORMF = byCond('storm');
  const rarCol = r => 'var(--c-' + r + ')';
  const fishTag = f => `<b style="color:${rarCol(f.rar)}">${esc(f.name)}</b>`;

  function bucketWorth() { let v = 0; const b = RF.state.bucket || [];
    for (let i = 0; i < b.length; i++) v += b[i].val | 0;
    let m = 1; try { m = F.priceMult('fish'); } catch (e) { m = 1; }
    return { n: b.length, raw: v, now: Math.round(v * m), mult: m }; }
  function biggestCat() { const st = RF.state, v = { fish: bucketWorth().raw };
    for (const k in st.ores) v[k] = (st.ores[k] | 0) * ((RF.ORE_INFO[k] && RF.ORE_INFO[k].price) || 0);
    let bk = 'fish', bv = -1; for (const k in v) if (v[k] > bv) { bv = v[k]; bk = k; }
    return { cat: bk, val: bv }; }
  function nextHot(cat, span) { const e0 = F.mktEpochNow();
    for (let k = 1; k <= (span || 12); k++) if (mktAt(e0 + k).hot === cat) return k; return -1; }
  function stockScan() {
    const e = F.mktEpochNow(), st = RF.state.stocks || { own: {}, basis: {} };
    let held = null, cheap = null, worst = 1e9, low = 1e9;
    for (const k of RF.STOCK_KEYS) {
      const bid = F.stockBid(k, e), ask = F.stockAsk(k, e), p = F.stockPrice(k, e);
      const n = st.own[k] | 0, b = +st.basis[k] || 0;
      if (n > 0 && b > 0) { const gap = (bid - b) / b; if (gap < worst) { worst = gap; held = { k, n, b, bid, gap }; } }
      let sum = 0; for (let i = 1; i <= 24; i++) sum += F.stockPrice(k, e - i);
      const mean = sum / 24, rel = (p - mean) / mean;
      if (rel < low) { low = rel; cheap = { k, p, ask, bid, mean, rel }; } }
    return { held, cheap }; }
  function oreScan() { const c = { coal: 0, iron: 0, gold: 0, diamond: 0 }; let geo = 0, tot = 0;
    for (const n of RF.oreNodes) { if (!n.alive) continue; tot++;
      if (c[n.type] !== undefined) c[n.type]++; if (n.geode) geo++; }
    return { c, geo, tot }; }
  function nearestNode(pred) { let b = null, bd = 1e9;
    for (const n of RF.oreNodes) { if (!n.alive || !pred(n)) continue;
      const d = Math.hypot(n.x - P.x, n.z - P.z); if (d < bd) { bd = d; b = n; } }
    return b ? { n: b, d: bd } : null; }
  /* The wheel's odds, counted off the live segment table rather than quoted from
     memory: if core ever re-cuts the wheel, Ottoline's arithmetic follows it. */
  const WHEEL = (function () { const S = RF.SEG || [], n = S.length || 15;
    let red = 0, black = 0, green = 0, odd = 0, even = 0, high = 0;
    for (let i = 0; i < n; i++) { const c = S[i]; if (c === 'red') red++; else if (c === 'black') black++; else green++; }
    for (let i = 1; i < n; i++) { if (i % 2) odd++; else even++; if (i >= 8) high++; }
    return { n, red, black, green, odd, even, high }; })();

  /* ==========================================================================
     B. PLACEMENT — beside the station, never on it.
     ========================================================================== */
  const walkable = (x, z) => Math.abs(x) < HALF - 1.5 && Math.abs(z) < HALF - 1.5 && !F.isWaterAt(x, z) && hAt(x, z) > WT;
  function post(cx, cz, r, prefer) {
    const offs = [0, .35, -.35, .7, -.7, 1.05, -1.05, 1.5, -1.5, 2, -2, 2.5, -2.5, Math.PI];
    const h0 = hAt(cx, cz);
    for (const rr of [r, r + .6, r - .5, r + 1.2, r + 1.9]) for (const o of offs) {
      const a = (prefer || 0) + o, x = cx + Math.sin(a) * rr, z = cz + Math.cos(a) * rr;
      if (!walkable(x, z) || Math.abs(hAt(x, z) - h0) > 1.2) continue;
      return { x: x, z: z, y: hAt(x, z) }; }
    return { x: cx, z: cz, y: hAt(cx, cz) }; }
  /* The mine door is core-private (mineProps.door), but it is a pure function of
     the height map, reachability and the ore nodes — all of which we are handed.
     This recomputes it exactly as section 6 of game.js builds it. */
  function findMineDoor() {
    const sH = RF.WORLD.stoneH; let mi = -1, mj = -1, bs = -1;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (HM[i][j] < sH || !F.reachable(i, j)) continue;
      let s = 0; for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const ii = i + a, jj = j + b;
        if (ii >= 0 && jj >= 0 && ii < N && jj < N && HM[ii][jj] >= sH) s++; }
      if (s > bs) { bs = s; mi = i; mj = j; } }
    if (mi < 0) return null;
    const oreNear = (i, j, r) => { const x = i - HALF, z = j - HALF;
      for (const n of RF.oreNodes) if (Math.hypot(n.x - x, n.z - z) < r) return true; return false; };
    const stoneOK = (i, j) => i >= 0 && j >= 0 && i < N && j < N && HM[i][j] >= sH;
    let ei = mi, ej = mj;
    if (oreNear(mi, mj, 1.4)) { let bd = 1e9;
      for (let i = mi - 3; i <= mi + 3; i++) for (let j = mj - 3; j <= mj + 3; j++) {
        if (!stoneOK(i, j) || oreNear(i, j, 1.35)) continue;
        const d = Math.hypot(i - mi, j - mj); if (d < bd) { bd = d; ei = i; ej = j; } } }
    return { x: ei - HALF, y: HM[ei][ej], z: ej - HALF }; }
  let MINE = null; try { MINE = findMineDoor(); } catch (e) { RF.err('npc:mine', e, 'warn'); }
  /* The pier runs from HARBOR_POS toward whichever axis has the open channel. */
  function dockSpot() {
    const H = RF.HARBOR_POS; if (!H) return null;
    let dir = null;
    for (const d of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { let ok = true;
      for (let k = 2; k <= 5; k++) if (!F.isWaterAt(H.x + d[0] * k, H.z + d[1] * k)) { ok = false; break; }
      if (ok) { dir = d; break; } }
    if (!dir) return null;
    const px = -dir[1], pz = dir[0];
    return { x: H.x + dir[0] * 1.75 + px * 0.34, y: 3.07, z: H.z + dir[1] * 1.75 + pz * 0.34,
      face: Math.atan2(-dir[0], -dir[1]) }; }   // looking back down the pier at the shore

  /* ==========================================================================
     C. THE CAST — humanoid() + texturedBox(), core's voxel idiom throughout.
     ========================================================================== */
  const mat = c => new T.MeshLambertMaterial({ color: c });
  const glow = (c, i) => new T.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: i });
  function box(w, h, d, m, x, y, z, par) { const b = new T.Mesh(new T.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); b.castShadow = true; if (par) par.add(b); return b; }
  /* humanoid() names only the four limbs in userData; the rest are classified by
     the heights it built them at, which survives a reordering of g.children. The
     neck group exists so head, hat and brim turn together instead of shearing. */
  function rigOf(g) {
    const u = g.userData || {}, r = { legL: u.legL, legR: u.legR, armL: u.armL, armR: u.armR };
    for (const m of g.children.slice()) {
      if (m === r.legL || m === r.legR || m === r.armL || m === r.armR) continue;
      const y = m.position.y;
      if (Math.abs(y - 0.95) < 0.08) r.body = m; else if (Math.abs(y - 1.56) < 0.08) r.head = m;
      else if (Math.abs(y - 1.86) < 0.08) r.hat = m; else if (Math.abs(y - 1.74) < 0.08) r.brim = m; }
    const neck = new T.Group(); neck.position.y = 1.56; g.add(neck);
    for (const k of ['head', 'hat', 'brim']) { const m = r[k]; if (!m) continue; m.position.y -= 1.56; neck.add(m); }
    r.neck = neck; return r; }

  function buildMonger(pal) {                                   // apron, headscarf, gutting knife
    const g = F.humanoid(pal), r = rigOf(g);
    const apron = box(0.76, 0.62, 0.06, mat(0xd9d2c0), 0, -0.02, 0.24, r.body);
    box(0.2, 0.08, 0.03, mat(0x7a4a2a), 0, 0.3, 0.02, apron);
    if (r.hat) { r.hat.scale.set(1, 0.55, 1); r.hat.position.y += 0.03; }
    if (r.brim) r.brim.scale.set(0.86, 0.6, 0.86);
    box(0.16, 0.14, 0.3, mat(pal.hat), 0, 0.2, -0.34, r.neck).rotation.x = 0.4;
    const prop = new T.Group(); prop.position.set(0, -0.42, 0.06); r.armR.add(prop);
    box(0.06, 0.2, 0.06, mat(0x5e4226), 0, 0.08, 0, prop);
    box(0.05, 0.34, 0.12, mat(0xd8dee0), 0, -0.16, 0.02, prop);
    return { g, r, prop }; }
  function buildCroupier(pal) {                                 // waistcoat, green visor, a chip
    const g = F.humanoid(pal), r = rigOf(g);
    box(0.3, 0.56, 0.06, mat(0xf2ede2), 0, 0, 0.23, r.body);
    box(0.2, 0.1, 0.06, mat(0xff5d7a), 0, 0.3, 0.24, r.body);
    box(0.76, 0.1, 0.46, mat(0x161a20), 0, -0.3, 0, r.body);
    if (r.hat) r.hat.visible = false;
    if (r.brim) { r.brim.material = glow(0x2c8f5e, 0.18); r.brim.scale.set(0.9, 0.5, 0.62); r.brim.position.set(0, 0.06, 0.2); }
    box(0.58, 0.12, 0.52, mat(0x1d1a18), 0, 0.22, 0, r.neck);
    const prop = new T.Group(); prop.position.set(0, -0.44, 0.1); r.armR.add(prop);
    const chip = new T.Mesh(new T.CylinderGeometry(0.13, 0.13, 0.04, 10), glow(0xffcf5c, 0.22));
    chip.rotation.x = Math.PI / 2; chip.castShadow = true; prop.add(chip);
    return { g, r, prop, chip }; }
  function buildShipwright(pal) {                               // leather apron, beard, hammer
    const g = F.humanoid(pal), r = rigOf(g);
    box(0.74, 0.5, 0.08, F.mat(RF.TEX.wood), 0, -0.08, 0.24, r.body);
    box(0.2, 0.24, 0.1, mat(0x9aa1a8), -0.22, -0.22, 0.26, r.body);
    box(0.5, 0.16, 0.24, mat(0xcfd8d6), 0, -0.1, 0.24, r.neck);
    if (r.hat) { r.hat.scale.set(0.92, 0.6, 0.92); r.hat.position.y -= 0.05; }
    if (r.brim) { r.brim.scale.set(0.82, 0.7, 0.9); r.brim.position.z = 0.08; }
    const prop = new T.Group(); prop.position.set(0, -0.44, 0.04); r.armR.add(prop);
    box(0.07, 0.44, 0.07, mat(0x8a5a2c), 0, 0.1, 0, prop);
    box(0.16, 0.14, 0.3, mat(0x555b63), 0, -0.14, 0, prop);
    return { g, r, prop }; }
  function buildQuarry(pal) {                                   // helmet lamp, ore pouch, pick
    const g = F.humanoid(pal), r = rigOf(g);
    box(0.78, 0.14, 0.48, mat(0x3a2c1c), 0, 0.16, 0, r.body);
    box(0.28, 0.3, 0.16, mat(0x2e3338), 0.26, -0.18, 0.24, r.body);
    if (r.hat) { r.hat.material = mat(0xffcf5c); r.hat.scale.set(1.02, 0.9, 1.02); }
    if (r.brim) { r.brim.material = mat(0xffcf5c); r.brim.scale.set(0.9, 0.6, 0.95); }
    box(0.14, 0.14, 0.1, glow(0xffd27a, 0.9), 0, 0.32, 0.28, r.neck);
    const prop = new T.Group(); prop.position.set(0, -0.44, 0); r.armR.add(prop);
    box(0.06, 0.52, 0.06, mat(0x8a5a2c), 0, 0.08, 0, prop);
    box(0.42, 0.08, 0.08, mat(0xcfd8d6), 0, -0.18, 0, prop);
    return { g, r, prop }; }
  function buildPeddler(pal) {                                  // pack, bedroll, lantern, staff
    const g = F.humanoid(pal), r = rigOf(g);
    box(0.52, 0.6, 0.26, F.mat(RF.TEX.wood), 0, 0.02, -0.36, r.body);
    box(0.2, 0.2, 0.2, mat(0xd8483f), -0.14, 0.34, -0.36, r.body);
    box(0.72, 0.1, 0.5, mat(0x5e4226), 0, 0.2, 0, r.body);
    if (r.brim) r.brim.scale.set(1.24, 1, 1.24);
    box(0.16, 0.2, 0.16, glow(0xffd27a, 0.85), 0.32, -0.1, -0.3, r.body);
    const prop = new T.Group(); prop.position.set(0, -0.46, 0); r.armR.add(prop);
    box(0.06, 0.9, 0.06, mat(0x6b421f), 0, -0.06, 0, prop);
    box(0.12, 0.12, 0.12, glow(0x39d7c4, 0.5), 0, 0.4, 0, prop);
    return { g, r, prop }; }

  /* portraits: RF.PIX's idiom at 16x16, one shared face the palette re-skins and
     each NPC overpaints with the four or five pixels that make them themselves */
  const POR = [
    '................', '................', '....HHHHHHHH....', '..HHHHHHHHHHHH..',
    '...ssssssssss...', '...sBBssssBBs...', '...sEEssssEEs...', '...ssssMMssss...',
    '...ssssssssss...', '...ssMmmmmMss...', '...ssssssssss...', '....ssssssss....',
    '.....ssssss.....', '..CCCCCCCCCCCC..', '.CCCCCCCCCCCCCC.', '.CCCCCCCCCCCCCC.'];

  const CAST = [
    { id: 'monger', name: 'Brine Meg', role: 'FISHMONGER', ic: 'fish', at: 'trader', fid: 'sort',
      pal: { skin: 0xe8bd8f, shirt: 0x2f7d8c, pants: 0x38484f, hat: 0xd8483f }, build: buildMonger,
      por: { p: { s: '#e8bd8f', B: '#7a4a2a', E: '#2b2320', M: '#c9926a', m: '#8a4a3a', H: '#d8483f', C: '#2f7d8c' },
        over: [[3, 3, 10, 1, '#b93a33'], [2, 4, 1, 3, '#d8483f'], [13, 4, 1, 3, '#d8483f'],
          [4, 8, 1, 1, '#d88a6a'], [11, 8, 1, 1, '#d88a6a'], [6, 13, 4, 2, '#d9d2c0']] } },
    { id: 'croupier', name: 'Ottoline Vance', role: 'CROUPIER', ic: 'wheel', at: 'casino', fid: 'chip',
      pal: { skin: 0xd8ab86, shirt: 0x232830, pants: 0x1b1f26, hat: 0x232830 }, build: buildCroupier,
      por: { p: { s: '#d8ab86', B: '#1d1a18', E: '#141a1e', M: '#bb8f6c', m: '#8a4a3a', H: '#1d1a18', C: '#232830' },
        over: [[2, 4, 12, 1, '#2c8f5e'], [3, 5, 10, 1, '#2c8f5e'], [7, 13, 2, 1, '#ff5d7a'],
          [6, 14, 4, 1, '#f2ede2'], [11, 6, 1, 1, '#ffcf5c']] } },
    { id: 'wright', name: 'Halvard Keel', role: 'SHIPWRIGHT', ic: 'boat', at: 'harbor', fid: 'hammer',
      pal: { skin: 0xd9a778, shirt: 0x8a5a2c, pants: 0x3d4c58, hat: 0x3a3f46 }, build: buildShipwright,
      por: { p: { s: '#d9a778', B: '#9aa1a8', E: '#22282c', M: '#b98a5e', m: '#7a4a3a', H: '#3a3f46', C: '#8a5a2c' },
        over: [[3, 9, 10, 3, '#cfd8d6'], [5, 12, 6, 1, '#cfd8d6'], [2, 3, 12, 1, '#2c3239'],
          [11, 8, 3, 1, '#6b421f'], [13, 7, 1, 2, '#ffcf5c']] } },
    { id: 'quarry', name: 'Corry Slate', role: 'QUARRY HAND', ic: 'pick', at: 'mine', fid: 'tap',
      pal: { skin: 0xc9926a, shirt: 0x6a7078, pants: 0x424850, hat: 0xffcf5c }, build: buildQuarry,
      por: { p: { s: '#c9926a', B: '#4a3c30', E: '#1c2126', M: '#a97a56', m: '#7a4a3a', H: '#ffcf5c', C: '#6a7078' },
        over: [[2, 3, 12, 1, '#d9a92f'], [7, 2, 2, 1, '#fff3c4'], [4, 10, 3, 1, '#8a7a68'],
          [10, 7, 2, 1, '#8a7a68'], [3, 11, 2, 1, '#8a7a68']] } },
    { id: 'peddler', name: 'Wick Tarrow', role: 'PEDDLER', ic: 'map', at: 'road', fid: 'point',
      pal: { skin: 0xf0c090, shirt: 0x7a4a8c, pants: 0x4a3a2c, hat: 0xe8c86a }, build: buildPeddler,
      por: { p: { s: '#f0c090', B: '#5a4632', E: '#2b2320', M: '#d7a97a', m: '#8a4a3a', H: '#e8c86a', C: '#7a4a8c' },
        over: [[0, 3, 16, 1, '#d3b054'], [1, 2, 14, 1, '#e8c86a'], [4, 1, 8, 1, '#d8483f'],
          [9, 9, 1, 1, '#ffcf5c'], [2, 13, 3, 3, '#5e4226']] } }];
  const byId = Object.create(null); for (const c of CAST) byId[c.id] = c;

  /* ==========================================================================
     D. WHAT THEY SAY. barks never repeat back to back; react fires off events.
     ========================================================================== */
  byId.monger.barks = ['Gut them before you sell them? No. The Trader pays by the kilo, not the tidiness.',
    'A bucket is not a boat, captain · it sinks the moment it is full.',
    'Every fish on this counter was somebody\'s bad afternoon.',
    'Twelve in the pail is twelve. Thirteen is a puddle on my floor.',
    'Cheap bait, cheap fish. I have never once seen it work the other way.',
    'You smell of brine and good luck. Only one of those washes out.',
    'Sell in the hot hour, not the tired one. The bell decides, not your legs.'];
  byId.croupier.barks = ['The wheel has ' + WHEEL.n + ' pockets and no memory at all.',
    'Green pays fourteen. Green comes up once in ' + WHEEL.n + '. Do that sum before you stake, not after.',
    'The house keeps four in the hundred and calls it hospitality.',
    'Nobody has ever beaten me. Several have left early, which is close.',
    'Colour is a coin flip with a tax. That is the whole game, stated honestly.',
    'You may stake a fish or a purse. The eel cannot tell the difference.',
    'I once watched a man stake a Star Koi on black. I still think about it.'];
  byId.wright.barks = ['A hull is a promise you make to the water. Keep it caulked.',
    'Every plank on this pier I set myself. Mind the third one.',
    'A finer ship stirs finer fish. That is not superstition, that is the hull.',
    'Wood first, iron second, ambition a distant third.',
    'The sea does not care what you paid for the boat.',
    'Bring me timber and I will bring you somewhere worth going.'];
  byId.quarry.barks = ['Rock does not owe you anything. Swing anyway.',
    'Find the next node fast and the vein stays warm. Dawdle and it goes cold.',
    'A geode looks like a lump right up until it does not.',
    'Storm weather loosens the stone. Best day\'s work I ever did, I did soaked.',
    'Coal, iron, gold, diamond. In that order, and rarely.',
    'The shaft goes down further than the isle goes across.'];
  byId.peddler.barks = ['I have walked this road since before it was a road.',
    'Everything I own is on my back and it is still too much.',
    'I sell nothing. I only know things. Knowing is cheaper to carry.',
    'The stall, the wheel, the pier, the shaft. Four corners and a lot of walking.',
    'Weather comes off the water. So does everything else worth having.',
    'A road tells you where people wanted to go badly enough to wear the grass down.'];

  byId.monger.react = {
    bucketfull: ['That pail is full to the lip · nothing else is going in it.', 'Full bucket, captain. Sell it or start throwing them back.'],
    rare: ['Now THAT is worth carrying home carefully.', 'Well. That does not come up the line every day.'],
    nobait: ['Empty hook, is it? The Trader sells worms for sixty. Go on.', 'No bait on you. You will catch the small and the stupid, and little else.'],
    storm: ['Storm on the water · the fish come up angry and expensive.'] };
  byId.croupier.react = {
    lostfish: ['The eel is not sorry. Neither, professionally, am I.', 'Gone. That is what staking means · say it with me.'],
    won: ['The house congratulates you and quietly recalculates.'],
    geode: ['Cracked one open, did you? The Exchange notices things like that.'],
    storm: ['Rain never once stopped a wheel turning.'] };
  byId.wright.react = {
    storm: ['Get off the water. I mean it · off the water.', 'That is a working storm. Rock loosens. Hulls do not.'],
    rare: ['A fish like that wants a better boat under it.'],
    bucketfull: ['Full hold. Even a raft knows when to turn for shore.'] };
  byId.quarry.react = {
    geode: ['THREE AND A HALF TIMES the ore, that one. Told you they were worth the arm.', 'That is the sound I get out of bed for.'],
    storm: ['Storm overhead · the rock gives up half again as much today. Get swinging.'],
    rare: ['Caught something shiny? Down here we call that Tuesday.'] };
  byId.peddler.react = {
    storm: ['Weather. I will be under that ledge if you want me.'],
    rare: ['I will carry that story to the next isle, if you do not mind.'],
    bucketfull: ['Heavy load. I know the feeling intimately.'],
    nobait: ['No bait, no supper. The stall is that way.'] };

  /* ---- rumours. Each returns HTML, or null when it has nothing TRUE to say —
     the caller falls through to the next candidate on that NPC's list. ---- */
  const RUM = {
    mktNext() { if (!mktOK()) return null;
      const nx = mktAt(F.mktEpochNow() + 1);
      return `The bell turns in <b>${hms(epochLeft())}</b> · after it, <b class="rf-npc-hot">${catN(nx.hot)}</b> runs hot and <b class="rf-npc-cold">${catN(nx.cold)}</b> goes to surplus.`; },
    mktWait() { if (!mktOK()) return null;
      const b = biggestCat(); if (b.val <= 0) return null;
      const k = nextHot(b.cat, 12);
      if (k < 0) return `<b>${catN(b.cat)}</b> is what you are carrying, and it does not go hot inside the next twelve turns. Sell it plain.`;
      return `You are heavy in <b>${catN(b.cat)}</b>. It goes <b class="rf-npc-hot">hot</b> in <b>${k}</b> turn${k > 1 ? 's' : ''} · about <b>${hms(epochLeft() + (k - 1) * MKS / 1000)}</b>. Hold it that long.`; },
    night() { if (!NIGHTF.length) return CAVE ? 'Down here it is night for good and all · every glow species bites around the clock.' : null;
      const t = tilNight(), top = NIGHTF[0], names = NIGHTF.slice(0, 3).map(fishTag).join(', ');
      if (t.night) return `It is dark now, so ${names} are in the water · and only now. ${fishTag(top)} alone is worth ◈${fmt(top.val)} at base.`;
      return `Dusk is <b>${hms(t.secs)}</b> off. After it, and not before, ${names} come up. Best of them pays ◈${fmt(top.val)}.`; },
    diamond() { const d = nearestNode(n => n.type === 'diamond');
      if (!d) { const s = oreScan();
        return s.tot ? `No diamond standing on this isle right now · ${s.c.gold} gold and ${s.c.iron} iron still are.`
          : 'Nothing is standing in the rock at the moment. Give it a minute.'; }
      return `Nearest diamond sits about <b>${Math.round(d.d)}</b> paces <b>${bearing(d.n.x - P.x, d.n.z - P.z)}</b> of you. It is real · I can see it from here.`; },
    geode() { const s = oreScan();
      if (!s.geo) return s.tot ? `Not one geode standing out of ${s.tot} nodes. They come back · they always come back.` : null;
      return `<b>${s.geo}</b> geode${s.geo > 1 ? 's' : ''} still unbroken out of ${s.tot} nodes. Each pays <b>3.5×</b> the ore of a plain swing.`; },
    stock() { const s = stockScan();
      if (s.held) { const g = s.held;
        return g.gap < 0 ? `<b>${g.k}</b> is the sorriest thing in your book · bid ◈${fmt(g.bid)} against ◈${fmt(Math.round(g.b))} paid, <b class="rf-npc-cold">${pct(g.gap)}</b> under. Do not sell it today.`
          : `Every line in your book is above water. <b>${g.k}</b> is the thinnest of them at <b class="rf-npc-hot">+${pct(g.gap)}</b>.`; }
      if (!s.cheap) return null;
      const c = s.cheap;
      return `You hold no paper. <b>${c.k}</b> is trading <b class="rf-npc-cold">${pct(c.rel)}</b> under its own hour-long mean · ask ◈${fmt(c.ask)}, mean ◈${fmt(Math.round(c.mean))}.`; },
    weather() { const w = RF.weather;
      if (w === 'storm') return `Storm on us. Rock gives <b>+50%</b> ore, bites come <b>35% faster</b>, and ${STORMF.length ? STORMF.map(fishTag).join(' and ') + ' only surface in this' : 'the water is ugly'}.`;
      if (w === 'rain' || w === 'snow' || w === 'ash') return `${F.cap(w)} overhead · <b>+20%</b> off every node you break, and bites come <b>35% faster</b> while it lasts.`;
      if (STORMF.length) return `Clear for now. When a storm does break, ${STORMF.map(fishTag).join(' and ')} come up · and nothing else brings them.`;
      return 'Clear sky. Nothing on the water but you.'; },
    hull() { const lvl = RF.state.boatLvl | 0, nx = RF.BOATS[lvl + 1];
      if (!nx) return `You are in the <b>${esc(RF.BOATS[lvl].name)}</b> and there is nothing above it. Nothing I can build, anyway.`;
      const req = F.reqLabel(nx.req), have = F.haveOres(nx.req), coins = RF.state.coins | 0;
      return `Next hull is the <b>${esc(nx.name)}</b> · ◈${fmt(nx.cost)}${req ? ' and ' + esc(req) : ''}. `
        + `You are ${coins >= nx.cost ? 'good for the coin' : '<b class="rf-npc-cold">◈' + fmt(nx.cost - coins) + ' short</b>'}`
        + ` and ${have ? 'the timber is in hand' : 'the materials are not'}. She adds <b>+${Math.round(nx.luck * 100)}%</b> to the odds of a better fish.`; },
    road() { const stops = [];
      if (RF.TRADER_POS) stops.push(['the stall', RF.TRADER_POS]);
      if (RF.CASINO_POS) stops.push(['the wheel', RF.CASINO_POS]);
      if (RF.HARBOR_POS) stops.push(['the pier', RF.HARBOR_POS]);
      if (MINE) stops.push(['the shaft', MINE]);
      if (!stops.length) return null;
      let best = null, bd = 1e9;
      for (const s of stops) { const d = Math.hypot(s[1].x - P.x, s[1].z - P.z); if (d < bd) { bd = d; best = s; } }
      return `Nearest thing worth walking to is <b>${best[0]}</b>, ${Math.round(bd)} paces <b>${bearing(best[1].x - P.x, best[1].z - P.z)}</b>.`
        + (CAVE ? '' : ` The moon is on phase <b>${(RF.dayCount % 8) + 1} of 8</b> tonight.`); } };
  byId.monger.rum = ['mktNext', 'night', 'mktWait'];
  byId.croupier.rum = ['stock', 'mktWait', 'mktNext'];
  byId.wright.rum = ['hull', 'weather', 'road'];
  byId.quarry.rum = ['diamond', 'geode', 'weather'];
  byId.peddler.rum = ['road', 'mktNext', 'night', 'weather'];

  /* Which rumour an NPC carries is seeded off the day index, so it is stable for
     a whole day and different for each of them; the CONTENT is recomputed every
     time it is spoken, so it can go out of date but it can never go false. */
  function rumourOf(c) {
    const idx = CAST.indexOf(c), rr = F.mulberry32(((RF.dayCount * 2654435761) ^ (idx * 9176 + 41)) | 0);
    const list = c.rum, start = Math.floor(rr() * list.length) % list.length;
    for (let k = 0; k < list.length; k++) { let s = null;
      try { s = RUM[list[(start + k) % list.length]](); } catch (e) { RF.err('npc:rumour:' + c.id, e, 'warn'); }
      if (s) return s; }
    return null; }

  /* ==========================================================================
     E. TOPICS — four apiece plus two familiarity unlocks. Every figure is a
     live read; nothing below is a number somebody remembered.
     ========================================================================== */
  function nightTopic() {
    const t = tilNight();
    if (!NIGHTF.length) return CAVE ? 'It never gets darker than this. The glow species are simply the locals.'
      : 'Nothing on this isle waits for dark. Fish whenever you like.';
    const rows = NIGHTF.map(f => `<span>${fishTag(f)} · ${f.rar} · ◈${fmt(f.val)} base</span>`);
    return (t.night ? `It is dark <b>now</b> · ${hms(t.secs)} of it left.` : `Dusk in <b>${hms(t.secs)}</b>.`)
      + ` These are in the water then and at no other hour:<div class="rf-npc-list">${rows.join('')}</div>`; }

  const TOP = {
    monger: [
      { k: 'bell', t: 'The market bell', f: () => {
        if (!mktOK()) return 'The bell is turning on a schedule I have lost track of. Ask me again.';
        const e = F.mktEpochNow(), m = mktAt(e), rows = [];
        for (let k = 1; k <= 4; k++) { const q = mktAt(e + k);
          rows.push(`<span>+${k} turn · <b class="rf-npc-hot">${catN(q.hot)}</b> hot · <b class="rf-npc-cold">${catN(q.cold)}</b> surplus</span>`); }
        return `Right now <b class="rf-npc-hot">${catN(m.hot)}</b> pays <b>1.6×</b> and <b class="rf-npc-cold">${catN(m.cold)}</b> pays <b>0.75×</b>. `
          + `Turns again in <b>${hms(epochLeft())}</b>.<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'haul', t: 'What am I carrying?', f: () => {
        const b = bucketWorth(), c = F.cap();
        if (!b.n) return `Your pail is empty. It holds <b>${c}</b>, so there is no excuse.`;
        let kg = 0; for (const f of RF.state.bucket) kg += (+f.kg || 0);
        return `<b>${b.n}/${c}</b> fish, <b>${kg.toFixed(1)} kg</b>. At today's board that is <b>◈${fmt(b.now)}</b>`
          + (b.mult !== 1 ? ` · the ${b.mult > 1 ? 'hot' : 'surplus'} multiplier is doing <b>${b.mult}×</b> of it` : '')
          + `. Call it <b>◈${fmt(Math.round(b.now / Math.max(0.1, kg)))}</b> the kilo.`; } },
      { k: 'bait', t: 'Bait', f: () => {
        const id = RF.state.baitId, n = (RF.state.bait || {})[id] | 0, b = RF.BAITS[id];
        const rod = +(0.18 * (clamp((RF.state.rodLvl | 0) || 1, 1, RF.MAXLVL) - 1)).toFixed(4);
        const head = b && n > 0
          ? `You have <b>${esc(b.name)}</b> on, <b>${n}</b> left. It adds <b>+${b.luck}</b> luck and refuses anything under <b style="color:${rarCol(b.min || 'common')}">${b.min || 'common'}</b>.`
          : `Nothing on your hook. That is <b>+0</b> luck and no floor at all · the table will hand you sardines all day.`;
        const rows = RF.BAIT_ORDER.map(k => { const x = RF.BAITS[k], have = (RF.state.bait || {})[k] | 0;
          return `<span>${esc(x.name)} · ◈${fmt(x.cost)}/${x.pack} · +${x.luck} luck${have ? ' · <b>' + have + ' held</b>' : ''}</span>`; });
        return head + ` Your rod alone is worth <b>+${rod}</b>.<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'night', t: 'Tonight\'s bite', f: nightTopic },
      { k: 'weather', t: 'Weather and the water', f: RUM.weather, deep: 1 },
      { k: 'me', t: 'You, then', f: () => 'I gutted my first Sturgeon at nine and I have not been dry since. '
        + 'The stall is not mine · I only stand behind it. That is the arrangement and it suits me.', deep: 2 }],
    croupier: [
      { k: 'odds', t: 'The true odds', f: () => {
        const w = WHEEL, ev = (p, m) => pct(p * m);
        const rows = [`<span>Red · <b>${w.red}/${w.n}</b> = ${pct(w.red / w.n)} · pays 2× · return ${ev(w.red / w.n, 2)}</span>`,
          `<span>Black · <b>${w.black}/${w.n}</b> = ${pct(w.black / w.n)} · pays 2× · return ${ev(w.black / w.n, 2)}</span>`,
          `<span>Odd · <b>${w.odd}/${w.n}</b> · pays 2× · the green pocket eats it</span>`,
          `<span>Even · <b>${w.even}/${w.n}</b> · pays 2× · the green pocket eats it</span>`,
          `<span>High, 8 and up · <b>${w.high}/${w.n}</b> · pays 2×</span>`,
          `<span>Green · <b>${w.green}/${w.n}</b> = ${pct(w.green / w.n)} · pays <b>14×</b> · return ${ev(w.green / w.n, 14)}</span>`];
        return `${w.n} pockets: ${w.red} red, ${w.black} black, ${w.green} green. Every bet on this cloth returns the same `
          + `<b>${ev(w.red / w.n, 2)}</b> of what you stake, in the long run. There is no clever side.`
          + `<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'pot', t: 'The progressive pot', f: () =>
        `The house skims <b>4%</b> of every stake into a pot. Green · and only green · empties it into your purse `
        + `on top of the fourteen. It stands at <b style="color:var(--gold)">◈${fmt(RF.state.jackpot | 0)}</b> tonight.` },
      { k: 'ex', t: 'The Isle Exchange', f: () => {
        const s = stockScan(), e = F.mktEpochNow(), rows = [];
        for (const k of RF.STOCK_KEYS) {
          const p = F.stockPrice(k, e), pv = F.stockPrice(k, e - 1), n = (RF.state.stocks.own || {})[k] | 0, d = p - pv;
          rows.push(`<span><b>${k}</b> ◈${fmt(p)} <i style="color:${d > 0 ? 'var(--c-uncommon)' : d < 0 ? 'var(--rose)' : 'var(--faint)'}">`
            + `${d > 0 ? '▲' : d < 0 ? '▼' : '·'}${d ? Math.abs(d) : ''}</i> · bid ◈${fmt(F.stockBid(k, e))} / ask ◈${fmt(F.stockAsk(k, e))}`
            + `${n ? ' · you hold <b>' + n + '</b>' : ''}</span>`); }
        const tip = s.held ? (s.held.gap < 0
          ? `<b>${s.held.k}</b> is your deepest hole at <b class="rf-npc-cold">${pct(s.held.gap)}</b> under basis.`
          : 'Your whole book is green. Rare.')
          : (s.cheap ? `<b>${s.cheap.k}</b> is the one sitting furthest under its own mean · <b class="rf-npc-cold">${pct(s.cheap.rel)}</b>.` : '');
        return tip + `<div class="rf-npc-list">${rows.join('')}</div>`
          + `<i class="rf-npc-fine">Prices are a function of the clock alone. Nobody moves them · not me, not you.</i>`; } },
      { k: 'ledger', t: 'My ledger on you', f: () => {
        const st = RF.state.stats, sp = st.spins | 0, w = st.winsCt | 0, l = st.losses | 0;
        if (!sp) return 'You have never staked at this table. That is the finest record anyone here holds.';
        return `<b>${sp}</b> spins · <b>${w}</b> won, <b>${l}</b> lost · that is <b>${pct(w / Math.max(1, sp))}</b>. `
          + `Best single result: <b style="color:var(--gold)">◈${fmt(st.bestWin | 0)}</b>. `
          + (w / Math.max(1, sp) > WHEEL.red / WHEEL.n ? 'You are running ahead of the wheel. It has not noticed yet.'
            : 'The wheel is running to form. It usually does.'); } },
      { k: 'stake', t: 'Staking a fish', f: () => 'A staked fish is not a bet on its value · it doubles or it leaves your pail entirely. '
        + 'A win multiplies the fish itself, so the same fish can be ridden up and up. Losing it takes it out of the bucket and out of the world.', deep: 1 },
      { k: 'me', t: 'Why you stay', f: () => 'Because the wheel does not sleep and neither, apparently, do I. '
        + 'Dawn, dusk, storm · the pockets are the same fifteen. There is a comfort in that I would not expect you to share.', deep: 2 }],
    wright: [
      { k: 'hull', t: 'The next hull', f: RUM.hull },
      { k: 'fleet', t: 'The whole fleet', f: () => {
        const lvl = RF.state.boatLvl | 0;
        const rows = RF.BOATS.map((b, i) => `<span>${i === lvl ? '▸ ' : ''}<b>${esc(b.name)}</b> · ◈${fmt(b.cost)}`
          + `${b.luck ? ' · +' + Math.round(b.luck * 100) + '% fish luck' : ''} · ${b.seats} seat${b.seats > 1 ? 's' : ''}</span>`);
        return `You are in the <b>${esc(RF.BOATS[lvl].name)}</b>. A hull's luck is a second roll on the table when the first one `
          + `disappoints · that is all it is, and it is a lot.<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'timber', t: 'Timber and iron', f: () => {
        const o = RF.state.ores, rows = [];
        for (const k in o) { let m = 1; try { m = F.priceMult(k); } catch (e) { m = 1; }
          rows.push(`<span>${esc(RF.ORE_INFO[k].name)} · <b>${o[k] | 0}</b> held · ◈${fmt(Math.round(RF.ORE_INFO[k].price * m))} each${m !== 1 ? ` <i>(${m}×)</i>` : ''}</span>`); }
        return `Wood comes off trees, everything else out of the rock. What is in your pack:<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'sail', t: 'Where I can send you', f: () => {
        const owned = RF.state.worlds || [], here = RF.worldKey;
        const rows = RF.WORLD_ORDER.map(k => { const w = RF.WORLDS[k], has = owned.indexOf(k) >= 0;
          /* An Angler-only isle prices itself in more than coins, so the row says so
             rather than showing a number the coins alone can never satisfy. */
          const price = has ? '<b style="color:var(--teal)">unlocked</b>'
            : w.nft ? `◈${fmt(w.cost)} · <b style="color:var(--gold)">Anglers only</b>` : '◈' + fmt(w.cost);
          return `<span>${k === here ? '▸ ' : ''}<b>${esc(w.name)}</b> · ${esc(w.sub)} · ${price}</span>`; });
        return `${RF.WORLD_ORDER.length} isles above the water and one below it. Fish are worth <b>${RF.WORLD.fishMul}×</b> here.<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'weather', t: 'Reading the sky', f: RUM.weather, deep: 1 },
      { k: 'me', t: 'The third plank', f: () => 'I set the third plank wrong in my first year and have left it wrong ever since. '
        + 'A pier that is perfect is a pier nobody remembers. Mind your step and think of me.', deep: 2 }],
    quarry: [
      { k: 'vein', t: 'What is in the rock', f: () => {
        const s = oreScan(), rows = [];
        for (const k of ['coal', 'iron', 'gold', 'diamond']) if (s.c[k] !== undefined)
          rows.push(`<span><span class="rf-npc-dot" style="color:${RF.ORE_INFO[k].dot}">&#9679;</span> ${RF.ORE_INFO[k].name} · <b>${s.c[k]}</b> standing · ◈${fmt(RF.ORE_INFO[k].price)} base</span>`);
        const d = nearestNode(n => n.type === 'diamond'), g = nearestNode(n => n.type === 'gold');
        const tail = d ? ` Nearest diamond: <b>${Math.round(d.d)}</b> paces <b>${bearing(d.n.x - P.x, d.n.z - P.z)}</b>.`
          : g ? ` No diamond up. Nearest gold: <b>${Math.round(g.d)}</b> paces <b>${bearing(g.n.x - P.x, g.n.z - P.z)}</b>.` : '';
        return `<b>${s.tot}</b> nodes standing on this isle, <b>${s.geo}</b> of them geodes.${tail}`
          + `<div class="rf-npc-list">${rows.join('')}</div><i class="rf-npc-fine">Bearings read off your map · north is map-up.</i>`; } },
      { k: 'pick', t: 'Your pick', f: () => {
        const l = clamp(RF.state.pickLvl | 0 || 1, 1, RF.MAXLVL);
        return `Pick <b>Lv ${l}</b>. Every swing carries a <b>${pct(Math.min(0.85, 0.15 + 0.08 * (l - 1)))}</b> chance of a second ore`
          + (l >= 6 ? ` and, past Lv 6, a further <b>20%</b> chance of a third` : ` · a third becomes possible at <b>Lv 6</b>`)
          + `. It also shakes a share certificate loose <b>${pct(0.06 + 0.015 * (l - 1))}</b> of the time. `
          + `This isle multiplies every haul by <b>${RF.WORLD.oreYield || 1}×</b>.`; } },
      { k: 'geode', t: 'Geodes and the vein', f: () =>
        `A geode pays <b>3.5×</b> the ore of a plain node and takes far longer to crack. <b>${oreScan().geo}</b> stand right now. `
        + `Break a second node inside <b>6.5 seconds</b> of the first and the vein multiplier keeps climbing · let it lapse and it resets to one. `
        + `Pearls come off effort, not price: coal and iron pay <b>1</b>, gold <b>2</b>, diamond <b>5</b>.` },
      { k: 'shaft', t: 'The Undermine', f: () => {
        const c = RF.WORLDS.cave;
        if (CAVE) return 'You are standing in it. Forty nodes down here and eternal dark · every glow species bites around the clock. Climb out the way you came.';
        return `The shaft goes down to <b>${esc(c.name)}</b> · ${esc(c.sub)}. `
          + ((RF.state.worlds || []).indexOf('cave') >= 0 ? 'You have already paid to open it, so the descent is free forever.'
            : `Opening it costs <b>◈${fmt(c.cost)}</b> once. After that you walk down whenever you like.`)
          + ` <b>${c.oreN}</b> nodes below, and fish worth <b>${c.fishMul}×</b>.`; } },
      { k: 'weather', t: 'Weather at the face', f: RUM.weather, deep: 1 },
      { k: 'me', t: 'How long down here', f: () => 'Long enough that daylight looks wrong to me. '
        + 'You get used to a ceiling. What you never get used to is a lamp going out.', deep: 2 }],
    peddler: [
      { k: 'road', t: 'The road', f: () => {
        const rows = [], add = (n, p) => { if (!p) return;
          rows.push(`<span>${n} · <b>${Math.round(Math.hypot(p.x - P.x, p.z - P.z))}</b> paces <b>${bearing(p.x - P.x, p.z - P.z)}</b></span>`); };
        add('The stall', RF.TRADER_POS); add('The wheel', RF.CASINO_POS);
        add('The pier', RF.HARBOR_POS); add('The shaft', MINE); add('The portal', RF.PORTAL_POS);
        return `I walk it all day, so I know it to the pace:<div class="rf-npc-list">${rows.join('')}</div>`
          + `<i class="rf-npc-fine">North is map-up · the same up as W.</i>`; } },
      { k: 'hot', t: 'What the bell will do', f: () => {
        if (!mktOK()) return 'The bell and I have fallen out of step. Do not take my word on it today.';
        const e = F.mktEpochNow(), rows = [];
        for (let k = 0; k <= 5; k++) { const q = mktAt(e + k);
          rows.push(`<span>${k ? '+' + k + ' turn' : '<b>now</b>'} · <b class="rf-npc-hot">${catN(q.hot)}</b> hot · <b class="rf-npc-cold">${catN(q.cold)}</b> surplus</span>`); }
        return `Six turns of the bell, which is eighteen minutes of your life:<div class="rf-npc-list">${rows.join('')}</div>`
          + `<i class="rf-npc-fine">Hot pays 1.6× · surplus pays 0.75× · everything else pays flat.</i>`; } },
      { k: 'sky', t: 'The sky', f: () => {
        const t = tilNight();
        if (t.eternal) return 'There is no sky down here. I miss it more than I say.';
        return `${t.night ? `Night, with <b>${hms(t.secs)}</b> of dark left.` : `Daylight · <b>${hms(t.secs)}</b> until dusk.`} `
          + `Moon on phase <b>${(RF.dayCount % 8) + 1} of 8</b>. ` + RUM.weather(); } },
      { k: 'tales', t: 'Tales of the isles', f: () => {
        const rows = RF.WORLD_ORDER.concat(['cave']).map(k => { const w = RF.WORLDS[k];
          return `<span><b>${esc(w.name)}</b> · ${esc(w.sub)} · fish <b>${w.fishMul}×</b> · ${w.oreN} nodes</span>`; });
        return `Five places worth walking to, and I have worn out boots in all of them:<div class="rf-npc-list">${rows.join('')}</div>`; } },
      { k: 'night', t: 'What bites after dark', f: nightTopic, deep: 1 },
      { k: 'me', t: 'What you carry', f: () => 'A bedroll, a lantern, a staff and everything anybody ever told me. '
        + 'The last one weighs the most and I have never once put it down.', deep: 2 }] };

  /* ==========================================================================
     F. THE ACTORS — built, posted, and given a night plan.
     ========================================================================== */
  const ACT = [];
  function spawn(c) {
    let p = null, face = 0;
    if (c.at === 'trader' && RF.TRADER_POS) { p = post(RF.TRADER_POS.x, RF.TRADER_POS.z, 1.85, 1.25); face = 0; }
    else if (c.at === 'casino' && RF.CASINO_POS) { p = post(RF.CASINO_POS.x, RF.CASINO_POS.z, 2.5, 2.35);
      face = Math.atan2(RF.CASINO_POS.x - p.x, RF.CASINO_POS.z - p.z); }
    else if (c.at === 'harbor') { const d = dockSpot();
      if (d) { p = { x: d.x, y: d.y, z: d.z }; face = d.face; }
      else if (RF.HARBOR_POS) { p = post(RF.HARBOR_POS.x, RF.HARBOR_POS.z, 2.2, 0);
        face = Math.atan2(RF.HARBOR_POS.x - p.x, RF.HARBOR_POS.z - p.z); } }
    else if (c.at === 'mine' && MINE) { p = post(MINE.x, MINE.z, 2.6, 2.35); face = Math.atan2(MINE.x - p.x, MINE.z - p.z); }
    else if (c.at === 'road') { const s = RF.spawnCell; p = post(s[0] - HALF, s[1] - HALF, 3.2, 0.7); face = 0.7; }
    if (!p) return;                          // an isle without this POI simply has no such person on it
    const built = c.build(c.pal), g = built.g;
    g.position.set(p.x, p.y, p.z); g.rotation.y = face; scene.add(g);
    /* the nameplate, in the peers' own idiom (game.js addPeer) so a named
       stranger reads the same everywhere — gold, though, because these five
       are the isle's and not somebody's save. Hidden until the game runs and
       faded with the actor, so Meg's name goes home when Meg does. */
    let tag = null, sub = null;
    try {
      tag = F.makeLabel(c.name, '#ffcf5c', false); tag.scale.set(2.0, 0.5, 1);
      tag.visible = false; scene.add(tag);
      sub = F.makeLabel(c.role, '#7fdcff', false); sub.scale.set(1.55, 0.39, 1);
      sub.visible = false; scene.add(sub);
    } catch (e) { RF.err('npc:tag:' + c.id, e, 'warn'); }
    const mats = []; g.traverse(o => { if (o.material && mats.indexOf(o.material) < 0) mats.push(o.material); });
    ACT.push({ c, g, r: built.r, extra: built, mats: mats, tag, sub, home: { x: p.x, y: p.y, z: p.z, face: face },
      ph: Math.random() * TAU, alpha: 1, want: 1, vis: true, onScr: true, near: 9e9,
      fidT: 6 + Math.random() * 10, fidP: -1, barkT: 14 + Math.random() * 30, reactT: 0,
      bub: null, walkP: 0, sat: 0, lastBark: -1, lastR: -1 }); }
  for (const c of CAST) { try { spawn(c); } catch (e) { RF.err('npc:spawn:' + c.id, e); } }
  const actOf = id => { for (const a of ACT) if (a.c.id === id) return a; return null; };
  const peddler = actOf('peddler');

  /* -- the peddler's route: the BFS-carved path cells, walked properly -- */
  const PC = [], PIDX = new Map();
  try { for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
    if (RF.pathSet.has(F.keyOf(i, j)) && HM[i][j] >= 3 && F.reachable(i, j)) { PIDX.set(i * N + j, PC.length); PC.push([i, j]); }
  } catch (e) { RF.err('npc:paths', e, 'warn'); }
  function nearestPathIdx(x, z) { let b = -1, bd = 1e9;
    for (let k = 0; k < PC.length; k++) { const d = Math.hypot(PC[k][0] - HALF - x, PC[k][1] - HALF - z); if (d < bd) { bd = d; b = k; } }
    return b; }
  function routeBetween(a, b) {
    if (a < 0 || b < 0 || a === b) return null;
    const prev = new Int32Array(PC.length).fill(-1); prev[a] = a;
    const q = [a]; let h = 0, found = false;
    while (h < q.length && !found) { const c = q[h++], i = PC[c][0], j = PC[c][1];
      for (let d = 0; d < 4; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const t = PIDX.get(ni * N + nj); if (t === undefined || prev[t] >= 0) continue;
        prev[t] = c; if (t === b) { found = true; break; } q.push(t); } }
    if (!found) return null;
    const out = []; let k = b, guard = 0;
    while (k !== a && guard++ < PC.length) { out.push(PC[k]); k = prev[k]; }
    out.push(PC[a]); out.reverse(); return out; }
  const STOPS = [];
  if (PC.length > 8) { const add = p => { if (!p) return;
      const k = nearestPathIdx(p.x, p.z); if (k >= 0 && STOPS.indexOf(k) < 0) STOPS.push(k); };
    add(RF.TRADER_POS); add(RF.CASINO_POS); add(RF.HARBOR_POS); add(MINE); add(RF.PORTAL_POS);
    add({ x: RF.spawnCell[0] - HALF, z: RF.spawnCell[1] - HALF }); }
  const walk = { path: null, step: 0, at: -1, pause: 3, target: -1 };
  function pickLeg() {
    if (!peddler || STOPS.length < 2) return;
    if (walk.at < 0) walk.at = nearestPathIdx(peddler.g.position.x, peddler.g.position.z);
    for (let tries = 0; tries < 6; tries++) {
      const t = STOPS[(Math.random() * STOPS.length) | 0]; if (t === walk.target) continue;
      const r = routeBetween(walk.at, t);
      if (r && r.length > 1) { walk.path = r; walk.step = 1; walk.target = t; return; } }
    walk.path = null; walk.pause = 5 + Math.random() * 6; }
  /* the camp: a ring of stones, three leaning logs and two emissive flames */
  const camp = peddler ? (function () { const g = new T.Group();
    for (let k = 0; k < 7; k++) { const a = k / 7 * TAU;
      box(0.16, 0.12, 0.16, mat(0x7a8088), Math.cos(a) * 0.42, 0.06, Math.sin(a) * 0.42, g); }
    for (let k = 0; k < 3; k++) box(0.09, 0.42, 0.09, mat(0x5e4226), 0, 0.2, 0, g).rotation.set(0.5, k * 2.1, 0.3);
    const f1 = box(0.26, 0.34, 0.26, glow(0xffa235, 1), 0, 0.28, 0, g);
    const f2 = box(0.16, 0.24, 0.16, glow(0xffd27a, 1), 0.04, 0.46, -0.03, g);
    g.visible = false; scene.add(g); return { g, f1, f2 }; })() : null;

  /* ==========================================================================
     G. LOOK — bubbles and the talk panel share one stylesheet.
     ========================================================================== */
  RF.css(`
  #rf-npc-bubbles{position:fixed;inset:0;z-index:24;pointer-events:none;}
  .rf-npc-bub{position:absolute;transform:translate(-50%,-100%);max-width:calc(250px*var(--rf-ui-scale,1));
    min-width:96px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:calc(11.5px*var(--rf-ui-scale,1));
    line-height:1.5;color:var(--ink);background:var(--glass-sheen),var(--glass-hud);
    backdrop-filter:blur(13px) saturate(1.6);-webkit-backdrop-filter:blur(13px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:12px;padding:7px 11px 8px;
    box-shadow:var(--glass-hi),0 8px 22px rgba(2,8,10,.42);opacity:0;transition:opacity .3s ease;}
  .rf-npc-bub.on{opacity:1;}
  .rf-npc-bub::after{content:"";position:absolute;left:50%;bottom:-5px;width:9px;height:9px;margin-left:-4.5px;
    background:var(--glass-hud);border-right:1px solid var(--glass-bd);border-bottom:1px solid var(--glass-bd);
    transform:rotate(45deg);}
  .rf-npc-bub i{display:block;font-style:normal;font-family:"Chakra Petch",sans-serif;font-weight:600;
    font-size:calc(9px*var(--rf-ui-scale,1));letter-spacing:.2em;color:var(--teal);margin-bottom:3px;}
  .rf-npc-bub.rum{border-color:rgba(255,207,92,.55);
    box-shadow:var(--glass-hi),0 0 20px rgba(255,207,92,.16),0 8px 22px rgba(2,8,10,.42);}
  .rf-npc-bub.rum i{color:var(--gold);}
  .rf-npc-hot{color:var(--gold);} .rf-npc-cold{color:#7fb3c9;}
  #rf-npc-talk{position:fixed;right:16px;top:50%;transform:translateY(-50%) translateX(26px);z-index:26;
    width:min(calc(350px*var(--rf-ui-scale,1)),calc(100vw - 26px));opacity:0;pointer-events:none;
    transition:opacity .28s ease,transform .28s cubic-bezier(.2,.8,.2,1);}
  #rf-npc-talk.on{opacity:1;pointer-events:auto;transform:translateY(-50%) translateX(0);}
  .rf-npc-card{background:var(--glass-sheen),var(--glass-strong);backdrop-filter:blur(18px) saturate(1.6);
    -webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);border-radius:16px;
    padding:15px 16px;box-shadow:var(--glass-hi),0 18px 44px rgba(2,8,10,.5);max-height:82vh;overflow-y:auto;
    font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:calc(12px*var(--rf-ui-scale,1));color:var(--ink);}
  .rf-npc-card::-webkit-scrollbar{width:6px;}
  .rf-npc-card::-webkit-scrollbar-thumb{background:var(--glass-bd-soft);border-radius:3px;}
  .rf-npc-head{display:flex;gap:11px;align-items:flex-start;margin-bottom:10px;}
  .rf-npc-por{flex:0 0 auto;width:74px;height:74px;border-radius:12px;overflow:hidden;
    background:linear-gradient(165deg,rgba(57,215,196,.14),rgba(10,20,26,.7));border:1px solid var(--glass-bd-soft);}
  .rf-npc-por canvas{width:100%;height:100%;display:block;image-rendering:pixelated;}
  .rf-npc-who{flex:1;min-width:0;}
  .rf-npc-role{display:block;font-size:8.5px;letter-spacing:.32em;color:var(--teal);}
  .rf-npc-name{display:block;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:19px;line-height:1.15;color:var(--ink);}
  .rf-npc-fam{margin-top:6px;font-size:9.5px;letter-spacing:.1em;color:var(--faint);}
  .rf-npc-fam b{font-family:"Chakra Petch",sans-serif;color:var(--lab);font-variant-numeric:tabular-nums;}
  .rf-npc-bar{height:4px;border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden;margin-top:4px;}
  .rf-npc-bar i{display:block;height:100%;border-radius:3px;background:var(--teal);transition:width .3s ease;}
  .rf-npc-say{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:12px;padding:10px 12px;
    line-height:1.62;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);min-height:62px;}
  .rf-npc-say.rum{border-color:rgba(255,207,92,.4);}
  .rf-npc-say b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums;}
  .rf-npc-say i{font-style:normal;}
  .rf-npc-tag{display:block;font-size:8.5px;letter-spacing:.3em;color:var(--gold);margin-bottom:5px;}
  .rf-npc-tag .pix{vertical-align:-2px;margin-right:3px;}
  .rf-npc-list{display:flex;flex-direction:column;gap:2px;margin-top:8px;padding-top:7px;
    border-top:1px solid rgba(255,255,255,.07);}
  .rf-npc-list span{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1.5;}
  .rf-npc-list span b{color:var(--lab);}
  .rf-npc-dot{font-size:8px;vertical-align:1px;}
  .rf-npc-fine{display:block;margin-top:7px;font-size:9.5px;color:var(--faint);letter-spacing:.02em;font-style:normal;}
  .rf-npc-topics{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px;}
  .rf-npc-t{flex:1 1 46%;font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:11px;letter-spacing:.04em;
    cursor:pointer;text-align:left;border:1px solid var(--glass-bd-soft);background:var(--glass-row);color:var(--muted);
    border-radius:9px;padding:7px 9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);
    transition:color .12s,border-color .12s;}
  .rf-npc-t:hover:not(:disabled){color:var(--ink);border-color:rgba(57,215,196,.55);}
  .rf-npc-t.on{color:var(--teal);border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.26);}
  .rf-npc-t:disabled{opacity:.42;cursor:default;}
  .rf-npc-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;
    font-size:9.5px;letter-spacing:.06em;color:var(--faint);}
  .rf-npc-x{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px;color:var(--muted);
    background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:8px;padding:5px 10px;
    cursor:pointer;letter-spacing:.12em;}
  .rf-npc-x:hover{border-color:var(--rose);color:var(--rose);}
  body.photo #rf-npc-bubbles,body.photo #rf-npc-talk,
  body.capcam #rf-npc-bubbles,body.capcam #rf-npc-talk{display:none!important;}
  body.rf-reduced .rf-npc-bub,body.rf-reduced #rf-npc-talk{transition:none;}
  @media (max-width:760px){ #rf-npc-talk{right:8px;width:calc(100vw - 16px);} .rf-npc-card{max-height:64vh;} }
  `, 'rf-npc-css');

  /* ==========================================================================
     H. BUBBLES — four pooled nodes, projected off the head. Far more legible
     than a world-space texture and it costs a transform per live bubble.
     ========================================================================== */
  const bubHost = RF.el('<div id="rf-npc-bubbles"></div>');
  const BUBS = [];
  for (let k = 0; k < 4; k++) { const b = RF.el('<div class="rf-npc-bub"><i></i><span></span></div>', bubHost);
    BUBS.push({ el: b, who: b.querySelector('i'), txt: b.querySelector('span'), owner: null, t: 0, ttl: 0 }); }
  const vProj = new T.Vector3();
  let vw = window.innerWidth, vh = window.innerHeight;
  window.addEventListener('resize', () => { vw = window.innerWidth; vh = window.innerHeight; });
  function place(b) {
    const a = b.owner; if (!a) return;
    vProj.set(a.g.position.x, a.g.position.y + 2.5, a.g.position.z).project(cam);
    if (vProj.z > 1 || vProj.x < -1.4 || vProj.x > 1.4 || vProj.y < -1.3 || vProj.y > 1.4) { b.el.style.opacity = '0'; return; }
    b.el.style.opacity = '';
    b.el.style.left = ((vProj.x * 0.5 + 0.5) * vw).toFixed(1) + 'px';
    b.el.style.top = ((-vProj.y * 0.5 + 0.5) * vh - 14).toFixed(1) + 'px'; }
  function drop(b) { b.el.classList.remove('on'); if (b.owner) b.owner.bub = null; b.owner = null; b.ttl = 0; }
  function say(a, html, kind) {
    if (!a || !a.vis || !html) return;
    let b = a.bub;
    if (!b) { b = null;
      for (const x of BUBS) if (!x.owner) { b = x; break; }
      if (!b) { b = BUBS[0]; for (const x of BUBS) if (x.t > b.t) b = x; drop(b); }   // steal the oldest
      b.owner = a; a.bub = b; }
    b.txt.innerHTML = html; b.who.textContent = a.c.name;
    b.el.className = 'rf-npc-bub' + (kind === 'rum' ? ' rum' : '');
    b.t = 0;
    b.ttl = clamp(2.8 + String(html).replace(/<[^>]*>/g, ' ').split(/\s+/).length * 0.24, 3.2, 9);
    place(b); b.el.classList.add('on'); }
  const hushAll = () => { for (const b of BUBS) if (b.owner) drop(b); };

  /* ==========================================================================
     I. THE TALK PANEL (R)
     ========================================================================== */
  const panel = RF.el(`<div id="rf-npc-talk"><div class="rf-npc-card">
    <div class="rf-npc-head">
      <div class="rf-npc-por"><canvas width="16" height="16"></canvas></div>
      <div class="rf-npc-who"><span class="rf-npc-role"></span><span class="rf-npc-name"></span>
        <div class="rf-npc-fam"></div><div class="rf-npc-bar"><i></i></div></div>
    </div>
    <div class="rf-npc-say"></div>
    <div class="rf-npc-topics"></div>
    <div class="rf-npc-foot"><span>R closes · talk on to learn more</span>
      <button type="button" class="rf-npc-x">CLOSE</button></div>
  </div></div>`);
  const $ = s => panel.querySelector(s);
  const elPor = $('canvas'), elRole = $('.rf-npc-role'), elName = $('.rf-npc-name'),
    elFam = $('.rf-npc-fam'), elBar = $('.rf-npc-bar i'), elSay = $('.rf-npc-say'), elTop = $('.rf-npc-topics');
  let talking = null;
  const famOf = id => PR.fam[id] | 0;
  const tierOf = id => Math.min(2, Math.floor(famOf(id) / 4));
  const TIERW = ['a stranger', 'a familiar face', 'known', 'trusted'];

  function drawPortrait(a) {
    try { const g = elPor.getContext('2d'); if (!g) return;
      g.clearRect(0, 0, 16, 16);
      const p = a.c.por.p;
      for (let y = 0; y < 16; y++) { const row = POR[y];
        for (let x = 0; x < 16; x++) { const col = p[row[x]]; if (!col) continue; g.fillStyle = col; g.fillRect(x, y, 1, 1); } }
      for (const o of (a.c.por.over || [])) { g.fillStyle = o[4]; g.fillRect(o[0], o[1], o[2], o[3]); }
    } catch (e) { RF.err('npc:portrait', e, 'warn'); } }
  function renderTopics(a, sel) {
    const tier = tierOf(a.c.id);
    elTop.innerHTML = (TOP[a.c.id] || []).map((t, i) => { const lock = (t.deep || 0) > tier;
      return `<button type="button" class="rf-npc-t${sel === i ? ' on' : ''}" data-i="${i}"${lock ? ' disabled' : ''}>`
        + (lock ? '· locked ·' : esc(t.t)) + '</button>'; }).join(''); }
  function renderFam(a) {
    const f = famOf(a.c.id), tier = tierOf(a.c.id);
    elFam.innerHTML = `FAMILIARITY <b>${f}</b> · ${TIERW[Math.min(3, tier + (f >= 8 ? 1 : 0))]}`
      + (tier < 2 ? ` · ${(tier + 1) * 4 - f} more opens a topic` : '');
    elBar.style.width = clamp(f / 8, 0, 1) * 100 + '%'; }
  function askTopic(a, i) {
    const t = (TOP[a.c.id] || [])[i]; if (!t || (t.deep || 0) > tierOf(a.c.id)) return;
    let html = '';
    try { html = t.f(); } catch (e) { RF.err('npc:topic:' + a.c.id + ':' + t.k, e, 'warn');
      html = 'I had it a moment ago and now I do not. Ask me again.'; }
    elSay.className = 'rf-npc-say';
    elSay.innerHTML = `<span class="rf-npc-tag" style="color:var(--teal)">${esc(t.t.toUpperCase())}</span>` + html;
    PR.fam[a.c.id] = Math.min(99, famOf(a.c.id) + 1); savePR();
    renderFam(a); renderTopics(a, i); }
  function openTalk(a) {
    talking = a; drawPortrait(a);
    elRole.textContent = a.c.role; elName.textContent = a.c.name;
    const rum = rumourOf(a.c);
    elSay.className = 'rf-npc-say rum';
    elSay.innerHTML = `<span class="rf-npc-tag">${pix(a.c.ic, 11)}TODAY'S WORD</span>`
      + (rum || 'Nothing worth passing on today. Ask me something instead.');
    if (!PR.met[a.c.id]) { PR.met[a.c.id] = 1; PR.fam[a.c.id] = Math.max(1, famOf(a.c.id)); savePR(); }
    renderFam(a); renderTopics(a, -1);
    panel.classList.add('on');
    try { F.beep(430, 0.06, 'sine', 0.035); } catch (e) {} }
  const closeTalk = () => { if (!talking) return; talking = null; panel.classList.remove('on'); };
  elTop.addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('.rf-npc-t') : null;
    if (!b || !talking || b.disabled) return;
    b.blur(); askTopic(talking, +b.getAttribute('data-i')); });
  panel.querySelector('.rf-npc-x').addEventListener('click', () => closeTalk());

  function nearestAwake(range) { let best = null, bd = range;
    for (const a of ACT) { if (!a.vis || a.alpha < 0.4) continue;
      const d = Math.hypot(a.g.position.x - P.x, a.g.position.z - P.z);
      if (d < bd) { bd = d; best = a; } }
    return best; }
  function tryTalk() {
    if (talking) { closeTalk(); return; }
    const a = nearestAwake(6.5);
    if (!a) { const any = nearestAwake(1e9);
      F.toast(any ? 'Nobody within earshot · ' + any.c.name + ' is '
        + Math.round(Math.hypot(any.g.position.x - P.x, any.g.position.z - P.z)) + ' paces off'
        : 'Nobody on this isle to talk to');
      return; }
    hushAll(); openTalk(a); }

  /* ==========================================================================
     J. LIFE — one 25 Hz budget, skipped whole whenever it cannot be seen.
     ========================================================================== */
  let acc = 0, slow = 0, reduced = false, lowQ = false, gReact = 0;
  const HZ = 1 / 25, npcVis = new T.Vector3();
  const onScreen = a => { npcVis.set(a.g.position.x, a.g.position.y + 1.2, a.g.position.z).project(cam);
    return npcVis.z < 1 && npcVis.x > -1.45 && npcVis.x < 1.45 && npcVis.y > -1.5 && npcVis.y < 1.5; };

  /* Fidgets speak core's own language: windup, act, recover, all read off one
     0..1 progress so none of them needs a state machine of its own. */
  function fidget(a, u) {
    const r = a.r, s = Math.sin(u * Math.PI);
    switch (a.c.fid) {
      case 'sort':                                        // lifting crates onto the counter and setting them down
        r.armL.rotation.x = -0.5 - s; r.armR.rotation.x = -0.5 - s;
        r.armL.rotation.z = 0.3 * s; r.armR.rotation.z = -0.3 * s;
        a.g.rotation.x = s * 0.14; r.neck.rotation.x = s * 0.22 + Math.sin(u * TAU) * 0.03; break;
      case 'chip':                                        // a chip walked across the knuckles
        r.armR.rotation.x = -1.5 - s * 0.5; r.armR.rotation.z = -0.4 * s;
        if (a.extra.chip) a.extra.chip.rotation.y = u * 26;
        r.neck.rotation.z = s * 0.1; break;
      case 'hammer': {                                    // three strikes, then a look at the work
        const st = (u * 3) % 1, sw = st < 0.42 ? -0.6 - st * 3 : -1.86 + (st - 0.42) * 4.6;
        r.armR.rotation.x = clamp(sw, -2.4, -0.15); r.armL.rotation.x = -0.7;
        a.g.rotation.x = 0.1 + Math.max(0, -sw - 1) * 0.05; r.neck.rotation.x = 0.28; break; }
      case 'tap':                                         // taps the pick twice, then wipes his brow
        if (u < 0.6) { const st = (u / 0.6 * 2) % 1;
          r.armR.rotation.x = -0.9 - (st < 0.5 ? st * 2 : (1 - st) * 2) * 0.7; a.g.rotation.x = 0.08; }
        else { const q = Math.sin((u - 0.6) / 0.4 * Math.PI);
          r.armL.rotation.x = -2.3 * q; r.armL.rotation.z = 0.5 * q; r.neck.rotation.x = -0.12 * q; }
        break;
      default:                                            // the peddler points off down the road
        r.armL.rotation.x = -1.9 * s; r.armL.rotation.z = 0.55 * s;
        r.neck.rotation.y += 0.4 * s; a.g.rotation.z = -0.05 * s; } }

  function poseIdle(a, t, dt) {
    const r = a.r, br = Math.sin(t * 1.15 + a.ph), shift = Math.sin(t * 0.34 + a.ph * 1.7);
    if (r.body) r.body.scale.set(1, 1 + br * 0.022, 1 + br * 0.02);
    a.g.rotation.z = shift * 0.028; a.g.rotation.x = 0;
    a.g.position.y = a.home.y + Math.abs(br) * 0.012;
    r.legL.rotation.x = shift * 0.05; r.legR.rotation.x = -shift * 0.05;
    r.armL.rotation.x = -0.06 + Math.sin(t * 1.15 + a.ph + 0.6) * 0.07 + shift * 0.05;
    r.armR.rotation.x = -0.06 + Math.sin(t * 1.15 + a.ph + 0.6) * 0.07 - shift * 0.05;
    r.armL.rotation.z = 0.04; r.armR.rotation.z = -0.04;
    /* the head tracks you inside nine units and otherwise sweeps the horizon */
    let want = a.near < 9 ? Math.atan2(P.x - a.g.position.x, P.z - a.g.position.z) - a.g.rotation.y
      : Math.sin(t * 0.21 + a.ph) * 0.55;
    while (want > Math.PI) want -= TAU; while (want < -Math.PI) want += TAU;
    r.neck.rotation.y = lerp(r.neck.rotation.y, clamp(want, -1.05, 1.05), 1 - Math.exp(-4.5 * dt));
    r.neck.rotation.x = lerp(r.neck.rotation.x, a.near < 9 ? -0.05 : 0, 0.2);
    r.neck.rotation.z = lerp(r.neck.rotation.z, 0, 0.2); }

  function poseWalk(a) {
    const r = a.r, sw = Math.sin(a.walkP) * 0.42;
    r.legL.rotation.x = sw; r.legR.rotation.x = -sw;
    r.armL.rotation.x = -sw * 0.62; r.armR.rotation.x = sw * 0.62;
    r.armL.rotation.z = 0.05; r.armR.rotation.z = -0.05;
    if (r.body) r.body.scale.set(1, 1, 1);
    a.g.rotation.z = Math.sin(a.walkP * 0.5) * 0.03; a.g.rotation.x = 0.05;
    r.neck.rotation.y = lerp(r.neck.rotation.y, Math.sin(a.walkP * 0.31) * 0.35, 0.1);
    r.neck.rotation.x = lerp(r.neck.rotation.x, 0, 0.15); }

  function poseSit(a, t) {
    const r = a.r;
    a.g.position.y = a.home.y - 0.44;
    r.legL.rotation.x = -1.35; r.legR.rotation.x = -1.35;
    r.armL.rotation.x = -0.55; r.armR.rotation.x = -0.55;
    r.armL.rotation.z = 0.2; r.armR.rotation.z = -0.2;
    a.g.rotation.x = 0.16; a.g.rotation.z = 0;
    if (r.body) r.body.scale.set(1, 1 + Math.sin(t * 0.9 + a.ph) * 0.02, 1);
    r.neck.rotation.y = lerp(r.neck.rotation.y, Math.sin(t * 0.3) * 0.2, 0.08);
    r.neck.rotation.x = lerp(r.neck.rotation.x, 0.1, 0.1); }

  /* Transparency is switched on only while a fade is actually running: an NPC
     standing at full opacity stays on the cheap opaque path all day. */
  function setAlpha(a, v) {
    if (Math.abs(a.alpha - v) < 0.001) return;
    a.alpha = v;
    const solid = v >= 0.999;
    for (const m of a.mats) { m.transparent = !solid; m.opacity = v; m.depthWrite = solid; }
    a.g.visible = v > 0.02;
    if (v <= 0.02 && a.bub) drop(a.bub); }
  /* Dusk shutters the stall and the pier. The house never sleeps, there is no
     daylight in a shaft, and the peddler camps rather than leaves. */
  const scheduleFor = (a, night) => (!night || a.c.id === 'croupier' || a.c.id === 'peddler' || a.c.id === 'quarry') ? 1 : 0;

  RF.on('frame', dt => {
    try {
      acc += dt;
      let live = false; for (const b of BUBS) if (b.owner) { live = true; place(b); }
      if (acc < HZ) return;
      const step = acc; acc = 0;
      const t = RF.clock, night = CAVE ? true : F.isNight(), paused = RF.panelOpen || !RF.running;
      if (live) for (const b of BUBS) { if (!b.owner) continue; b.t += step; if (b.t > b.ttl) drop(b); }

      for (const a of ACT) {
        a.near = Math.hypot(a.g.position.x - P.x, a.g.position.z - P.z);
        a.want = scheduleFor(a, night);
        if (a.alpha !== a.want) { const r = (reduced ? 4 : 0.55) * step;
          setAlpha(a, a.want > a.alpha ? Math.min(a.want, a.alpha + r) : Math.max(a.want, a.alpha - r)); }
        a.vis = a.alpha > 0.35;
        /* the plate lives and dies with the actor: same fade, same schedule,
           gone on the title screen and in photo mode like core's own LABELS */
        if (a.tag) {
          const tOn = a.g.visible && RF.running && !RF.photoMode && a.alpha > 0.05;
          a.tag.visible = tOn; if (a.sub) a.sub.visible = tOn;
          if (tOn) {
            const gx = a.g.position.x, gz = a.g.position.z, gy = a.home.y;
            a.tag.position.set(gx, gy + 2.45, gz);
            a.tag.material.opacity = a.alpha;
            if (a.sub) { a.sub.position.set(gx, gy + 2.82, gz); a.sub.material.opacity = a.alpha * 0.9; }
          }
        }
        if (!a.g.visible) continue;
        a.onScr = a.near < 46 && onScreen(a);
        if (!a.onScr || paused) continue;

        if (a === peddler && walk.path && !night) poseWalk(a);
        else if (a === peddler && night && a.sat) poseSit(a, t);
        else {
          poseIdle(a, t, step);
          if (!lowQ && !reduced) {
            if (a.fidP >= 0) { a.fidP += step / 1.55;
              if (a.fidP >= 1) { a.fidP = -1; a.fidT = 7 + Math.random() * 13; } else fidget(a, a.fidP); }
            else if ((a.fidT -= step) <= 0) a.fidP = 0; } }

        if (!talking && a.near < 15 && a.alpha > 0.9 && (a.barkT -= step) <= 0) {
          a.barkT = 26 + Math.random() * 34;
          const L = a.c.barks; let i = (Math.random() * L.length) | 0;
          if (L.length > 1 && i === a.lastBark) i = (i + 1) % L.length;
          a.lastBark = i; say(a, esc(L[i]));
        } else if (a.near >= 15) a.barkT = Math.min(a.barkT, 12 + Math.random() * 10);
        if (a.reactT > 0) a.reactT -= step;
      }

      if (peddler && peddler.g.visible) {
        const g = peddler.g;
        if (night) {
          if (!peddler.sat) { peddler.sat = 1;
            if (camp) { camp.g.position.set(g.position.x + Math.sin(g.rotation.y) * 0.9,
              hAt(g.position.x, g.position.z), g.position.z + Math.cos(g.rotation.y) * 0.9);
              camp.g.visible = true; } }
          if (camp && camp.g.visible && !lowQ && !reduced) {
            const fl = 0.7 + Math.sin(t * 9.3) * 0.2 + Math.sin(t * 3.1) * 0.12;
            camp.f1.material.emissiveIntensity = fl; camp.f2.material.emissiveIntensity = fl * 1.2;
            camp.f1.scale.set(1, 0.9 + fl * 0.2, 1); }
        } else {
          if (peddler.sat) { peddler.sat = 0; if (camp) camp.g.visible = false;
            peddler.home.y = hAt(g.position.x, g.position.z); }
          if (!paused) {
            if (!walk.path) { if ((walk.pause -= step) <= 0) pickLeg(); }
            else { const c = walk.path[walk.step];
              if (!c) { walk.path = null; walk.pause = 4 + Math.random() * 7; walk.at = walk.target; }
              else { const dx = c[0] - HALF - g.position.x, dz = c[1] - HALF - g.position.z, d = Math.hypot(dx, dz);
                if (d < 0.16) walk.step++;
                else { const f = Math.min(1, 1.15 * step / d);
                  g.position.x += dx * f; g.position.z += dz * f;
                  g.position.y = lerp(g.position.y, hAt(g.position.x, g.position.z), 0.25);
                  peddler.home.y = g.position.y;
                  g.rotation.y = lerpAngle(g.rotation.y, Math.atan2(dx, dz), 0.14);
                  peddler.walkP += step * 3.6; } } } } } }

      if ((slow += step) >= 1) {
        slow = 0;
        reduced = D.body.classList.contains('rf-reduced');
        lowQ = D.body.dataset.rfQuality === 'low';
        calibrateDay(performance.now());
        if (gReact > 0) gReact--;
        if (talking && (RF.panelOpen || talking.near > 9 || !talking.vis)) closeTalk();
        const m = actOf('monger');
        if (m && m.vis && m.near < 5.5 && !talking) {
          const id = RF.state.baitId;
          if (!(id && (RF.state.bait || {})[id] > 0)) react('nobait', 'monger'); } }
    } catch (e) { RF.err('npc:frame', e); } });

  /* ==========================================================================
     K. REACTIONS — routed to whoever has a line for it and is near enough to be
     heard, on a per-actor cooldown so that nobody nags.
     ========================================================================== */
  function react(key, prefer) {
    if (gReact > 0 || talking || RF.panelOpen || !RF.running) return;
    let best = null, bd = 1e9;
    for (const a of ACT) {
      const L = a.c.react && a.c.react[key];
      if (!L || !L.length || !a.vis || a.reactT > 0 || !a.onScr || a.near >= 22) continue;
      const d = a.near - (prefer && a.c.id === prefer ? 12 : 0);   // whose business it is gets first refusal
      if (d < bd) { bd = d; best = a; } }
    if (!best) return;
    const L = best.c.react[key];
    let i = (Math.random() * L.length) | 0;
    if (L.length > 1 && i === best.lastR) i = (i + 1) % L.length;
    best.lastR = i; best.reactT = 16; gReact = 4; best.barkT = Math.max(best.barkT, 20);
    say(best, esc(L[i])); }

  RF.on('catch', fish => { try {
    if (fish && RF.RORDER[fish.rar] >= 2) react('rare', 'monger');
    else if ((RF.state.bucket || []).length >= F.cap()) react('bucketfull', 'monger');
  } catch (e) { RF.err('npc:catch', e, 'warn'); } });
  RF.on('mined', m => { if (m && m.geode) react('geode', 'quarry'); });
  RF.on('spin', s => { if (!s) return;
    if (!s.won && s.fish) react('lostfish', 'croupier'); else if (s.won) react('won', 'croupier'); });
  RF.on('weather', next => { if (next === 'storm') react('storm'); });
  RF.on('panel', () => { hushAll(); closeTalk(); });

  /* The first time you walk up to someone on a given day they volunteer the
     rumour — the one line worth having and the one nobody thinks to ask for. */
  const greeted = Object.create(null);
  RF.every(2.4, () => { try {
    if (talking || RF.panelOpen || !RF.running) return;
    for (const a of ACT) {
      if (!a.vis || !a.onScr || a.near > 6) continue;
      const key = a.c.id + ':' + RF.dayCount; if (greeted[key]) continue;
      greeted[key] = 1;
      const r = rumourOf(a.c);
      if (r) { a.barkT = Math.max(a.barkT, 24); say(a, r, 'rum'); }
      break; }
  } catch (e) { RF.err('npc:greet', e, 'warn'); } });

  /* ==========================================================================
     L. KEYS AND THE PUBLISHED SIGNAL
     ========================================================================== */
  const typing = () => { const el = D.activeElement;
    return RF.chatOpen || !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)); };
  RF.on('keydown', e => {
    if (typing()) return;
    if (e.code === 'Escape' && talking) { closeTalk(); return true; }
    if (e.code === 'KeyR' && !RF.panelOpen && RF.running) { e.preventDefault(); tryTalk(); return true; } });

  RF.api = RF.api || {};
  RF.api.npc = {
    list: () => ACT.map(a => ({ id: a.c.id, name: a.c.name, role: a.c.role, awake: a.vis,
      x: a.g.position.x, z: a.g.position.z, dist: a.near, familiarity: famOf(a.c.id) })),
    nearest: r => { const a = nearestAwake(r === undefined ? 6.5 : r); return a ? a.c.id : null; },
    rumour: id => { const c = byId[id]; if (!c) return null;
      try { return rumourOf(c); } catch (e) { return null; } },
    say: (id, text) => { const a = actOf(id); if (a && text) say(a, esc(String(text))); },
    talk: id => { const a = actOf(id); if (!a || !a.vis) return false; hushAll(); openTalk(a); return true; },
    close: () => closeTalk() };
});
