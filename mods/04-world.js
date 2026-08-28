/* ============================================================================
   04-world — the isle itself.

   Four things live in here, and they all read the SAME arrays the renderer
   reads: an atlas you can actually plan a run on, waypoints that stand up in
   the world as light, a small budgeted ecosystem so the island stops feeling
   like an empty diorama, and the air around all of it — god rays, a real dusk,
   fog that breathes, surf on every beach, rain that lands, forked lightning,
   wind you can watch arrive, and the moon laid out on the water.
   Nothing below writes to the world or the economy — the terrain is generated
   once by game.js and is authoritative.
   ========================================================================== */
RF.mod('04-world', function (RF) {
  'use strict';

  const THREE = RF.THREE, TAU = RF.TAU, N = RF.N, HALF = RF.HALF, HM = RF.heightMap;
  const W = RF.WORLD, fn = RF.fn, clamp = fn.clamp, lerp = fn.lerp, rand = fn.rand;
  const KEY = '04-world', WK = RF.worldKey;
  const WATER_Y = RF.WATER_TOP;

  const say = o => (RF.api && RF.api.notify) ? RF.api.notify(o)
    : fn.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : '');
  const reduced = () => document.body.classList.contains('rf-reduced');
  const quality = () => document.body.dataset.rfQuality || 'high';
  const typing = () => { const a = document.activeElement;
    return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };
  const esc = s => String(s).replace(/[&<>"]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
  const hex2rgb = h => { const n = parseInt(String(h).slice(1), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c, f) => 'rgb(' + (clamp(c[0] * f, 0, 255) | 0) + ',' + (clamp(c[1] * f, 0, 255) | 0) + ',' + (clamp(c[2] * f, 0, 255) | 0) + ')';

  /* ---- persistence: waypoints per isle + the map's own view prefs ---------- */
  let DB = RF.store.get(KEY, null);
  if (!DB || typeof DB !== 'object' || Array.isArray(DB)) DB = {};
  if (!DB.wp || typeof DB.wp !== 'object') DB.wp = {};
  if (!Array.isArray(DB.wp[WK])) DB.wp[WK] = [];
  DB.seq = DB.seq | 0; DB.heat = DB.heat | 0; if (DB.heat < 0 || DB.heat > 2) DB.heat = 0;
  const marks = DB.wp[WK];
  for (let i = marks.length - 1; i >= 0; i--) {          // a hand-edited save must not break the first draw
    const m = marks[i];
    if (!m || typeof m.x !== 'number' || typeof m.z !== 'number' || m.x !== m.x || m.z !== m.z) { marks.splice(i, 1); continue; }
    m.name = String(m.name == null ? 'Mark' : m.name).slice(0, 22) || 'Mark';
    m.c = Math.abs(m.c | 0) % 6;
    if (!m.id) m.id = ++DB.seq; else DB.seq = Math.max(DB.seq, m.id | 0);
  }
  marks.length = Math.min(marks.length, 8);
  const saveDB = () => RF.store.set(KEY, DB);
  const WP_COL = ['#ffcf5c', '#39d7c4', '#ff5d7a', '#c490ff', '#74e08a', '#57b7ff'];

  /* ========================================================================
     1. WHAT THE ISLE IS MADE OF — derived once, lazily, from engine arrays.
     ====================================================================== */
  let MINE = null, POIS = null;

  /* The mine mouth is the one landmark game.js keeps to itself. Re-deriving it
     is safe because the search is fully deterministic: same heightmap, same
     ore list, same answer on every client. */
  function findMine() {
    const sH = W.stoneH, reach = fn.reachable;
    let mi = -1, mj = -1, bs = -1;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (HM[i][j] < sH || !reach(i, j)) continue;
      let s = 0;
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
        const ii = i + a, jj = j + b;
        if (ii >= 0 && jj >= 0 && ii < N && jj < N && HM[ii][jj] >= sH) s++;
      }
      if (s > bs) { bs = s; mi = i; mj = j; }
    }
    if (mi < 0) return null;
    const oreNear = (i, j, r) => RF.oreNodes.some(n => Math.hypot(n.x - (i - HALF), n.z - (j - HALF)) < r);
    let ei = mi, ej = mj;
    if (oreNear(mi, mj, 1.4)) {                          // core shoves the mouth off an occupied vein
      let bd = 1e9;
      for (let i = mi - 3; i <= mi + 3; i++) for (let j = mj - 3; j <= mj + 3; j++) {
        if (i < 0 || j < 0 || i >= N || j >= N || HM[i][j] < sH || oreNear(i, j, 1.35)) continue;
        const d = Math.hypot(i - mi, j - mj); if (d < bd) { bd = d; ei = i; ej = j; }
      }
    }
    return { x: ei - HALF, z: ej - HALF };
  }

  function buildPOIs() {
    const L = [], T = RF.TRADER_POS, C = RF.CASINO_POS, P = RF.PORTAL_POS, HB = RF.HARBOR_POS;
    const sx = RF.spawnCell[0] - HALF, sz = RF.spawnCell[1] - HALF;
    if (T) L.push({ n: 'Trader', x: T.x, z: T.z, c: '#ffcf5c', ic: 'chart' });
    if (C) L.push({ n: 'Casino', x: C.x, z: C.z, c: '#ff5d7a', ic: 'wheel' });
    if (HB) L.push({ n: 'Harbor', x: HB.x, z: HB.z, c: '#39d7c4', ic: 'boat' });
    if (P) L.push({ n: 'Portal', x: P.x, z: P.z, c: '#c490ff', ic: 'gem' });
    MINE = findMine();
    if (MINE) L.push({ n: W.cave ? 'Cave exit' : 'Mine shaft', x: MINE.x, z: MINE.z, c: '#9fd7ff', ic: 'pick' });
    let gx = sx, gz = sz;                                 // the arrival gate stands 2.5 cells off spawn, aimed at the trader
    if (T) { const dx = T.x - sx, dz = T.z - sz, d = Math.hypot(dx, dz) || 1; gx = sx + dx / d * 2.5; gz = sz + dz / d * 2.5; }
    L.push({ n: 'Spawn gate', x: gx, z: gz, c: '#7fdcff', ic: 'island' });
    POIS = L;
  }

  /* ---- the static terrain plate: painted once, blitted forever ------------ */
  const TILE = 8;
  let baseCv = null, heatCv = [null, null];
  function buildBase() {
    const cv = document.createElement('canvas'); cv.width = cv.height = N * TILE;
    const g = cv.getContext('2d'); if (!g) return null;
    const wRGB = hex2rgb('#' + (W.water >>> 0).toString(16).padStart(6, '0'));
    const sRGB = hex2rgb(W.sand[0]), gRGB = hex2rgb(W.grass[0]), tRGB = hex2rgb(W.stone[0]), pRGB = [203, 168, 111];
    const deep = mix(wRGB, [4, 12, 20], 0.58), shal = mix(wRGB, [255, 255, 255], 0.24);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const h = HM[i][j]; let col, f = 1;
      if (h <= 2) col = mix(deep, shal, h / 2);
      else {
        col = h === 3 ? sRGB : h < W.stoneH ? gRGB : tRGB;
        if (h < W.stoneH && RF.pathSet.has(fn.keyOf(i, j))) col = pRGB;
        // hillshade from a north-west sun, plus a touch of altitude tint
        const hl = HM[i > 0 ? i - 1 : 0][j], hu = HM[i][j > 0 ? j - 1 : 0];
        const hr = HM[i < N - 1 ? i + 1 : i][j], hd = HM[i][j < N - 1 ? j + 1 : j];
        f = clamp(1 + ((hl + hu) - (hr + hd)) * 0.1, 0.58, 1.42) * (1 + (h - 5) * 0.024);
      }
      g.fillStyle = rgb(col, f);
      g.fillRect(i * TILE, j * TILE, TILE, TILE);
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const h = HM[i][j], X = i * TILE, Y = j * TILE;
      const hr = i < N - 1 ? HM[i + 1][j] : h, hd = j < N - 1 ? HM[i][j + 1] : h;
      // a drop-line on the downhill side of every terrace — that one shadow is
      // what makes a blocky heightmap read as slope instead of noise
      if (h >= 3 && hr >= 3 && hr < h) { g.fillStyle = 'rgba(6,16,20,.34)'; g.fillRect(X + TILE - 2, Y, 2, TILE); }
      if (h >= 3 && hd >= 3 && hd < h) { g.fillStyle = 'rgba(6,16,20,.34)'; g.fillRect(X, Y + TILE - 2, TILE, 2); }
      if (h < 3) continue;
      g.fillStyle = 'rgba(255,255,255,.4)';
      if (i < N - 1 && HM[i + 1][j] <= 2) g.fillRect(X + TILE - 2, Y, 2, TILE);
      if (i > 0 && HM[i - 1][j] <= 2) g.fillRect(X, Y, 2, TILE);
      if (j < N - 1 && HM[i][j + 1] <= 2) g.fillRect(X, Y + TILE - 2, TILE, 2);
      if (j > 0 && HM[i][j - 1] <= 2) g.fillRect(X, Y, TILE, 2);
    }
    return cv;
  }

  function buildHeat(kind) {                              // 1 = ore density, 2 = tree density
    const pts = kind === 1 ? RF.oreNodes : RF.treeData;
    const col = kind === 1 ? [255, 207, 92] : hex2rgb(W.leaf[0]);
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    const g = cv.getContext('2d'); if (!g) return null;
    const grid = new Float32Array(N * N), R = 5;
    for (const p of pts) {
      const ci = Math.round(p.x + HALF), cj = Math.round(p.z + HALF);
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
        const i = ci + a, j = cj + b; if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const d = Math.hypot(a, b); if (d > R) continue;
        grid[i * N + j] += 1 - d / R;
      }
    }
    let mx = 0; for (let k = 0; k < grid.length; k++) if (grid[k] > mx) mx = grid[k];
    const img = g.createImageData(N, N), d = img.data;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const v = mx > 0 ? grid[i * N + j] / mx : 0, k = (j * N + i) * 4;
      d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = Math.pow(v, 0.7) * 200;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  /* ========================================================================
     2. WAYPOINTS — data, the public API, and the light column in the world.
     ====================================================================== */
  const beacons = [];
  function wpAdd(x, z, name, c) {
    if (marks.length >= 8) return null;
    const m = { id: ++DB.seq, x: +x, z: +z, name: String(name || ('Mark ' + (marks.length + 1))).slice(0, 22) || 'Mark',
      c: Math.abs(c | 0) % 6 };
    marks.push(m); saveDB(); syncBeacons(); railBuild();
    return m;
  }
  function wpRemove(id) {
    const i = marks.findIndex(m => m.id === id); if (i < 0) return false;
    marks.splice(i, 1); saveDB(); syncBeacons(); railBuild(); return true;
  }
  function wpNearest() {
    let best = null, bd = 1e9;
    for (const m of marks) { const d = Math.hypot(m.x - RF.pWorld.x, m.z - RF.pWorld.z); if (d < bd) { bd = d; best = m; } }
    return best ? { id: best.id, x: best.x, z: best.z, name: best.name, color: WP_COL[best.c], dist: bd } : null;
  }

  const fadeTex = (function () {
    const c = document.createElement('canvas'); c.width = 4; c.height = 64;
    const g = c.getContext('2d'); if (!g) return null;
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0)');           // canvas top = column top (flipY)
    grd.addColorStop(0.55, 'rgba(255,255,255,.35)');
    grd.addColorStop(1, 'rgba(255,255,255,.95)');
    g.fillStyle = grd; g.fillRect(0, 0, 4, 64);
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    return t;
  })();

  (function buildBeacons() {
    const colG = new THREE.CylinderGeometry(0.3, 0.44, 1, 10, 1, true);
    const ringG = new THREE.RingGeometry(0.62, 0.92, 20);
    ringG.rotateX(-Math.PI / 2);
    for (let k = 0; k < 8; k++) {
      const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, map: fadeTex || undefined, transparent: true,
        opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      const col = new THREE.Mesh(colG, cm); col.frustumCulled = false; col.visible = false; RF.scene.add(col);
      const rm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(ringG, rm); ring.frustumCulled = false; ring.visible = false; RF.scene.add(ring);
      beacons.push({ col: col, ring: ring, cm: cm, rm: rm });
    }
  })();

  function syncBeacons() {
    for (let k = 0; k < beacons.length; k++) {
      const b = beacons[k], m = marks[k];
      if (!m) { b.col.visible = b.ring.visible = false; continue; }
      const y = fn.heightAt(m.x, m.z);
      b.col.position.set(m.x, y + 7, m.z); b.col.scale.set(1, 14, 1);
      b.ring.position.set(m.x, y + 0.06, m.z);
      const c = WP_COL[m.c] || WP_COL[0];
      b.cm.color.set(c); b.rm.color.set(c);
      b.col.visible = b.ring.visible = true;
    }
  }
  syncBeacons();

  function beaconTick(t) {
    const show = RF.running && !RF.photoMode && !RF.capCam;
    const px = RF.pWorld.x, pz = RF.pWorld.z, calm = reduced();
    for (let k = 0; k < beacons.length; k++) {
      const b = beacons[k], m = marks[k];
      if (!m) continue;
      if (!show) { b.col.visible = b.ring.visible = false; continue; }
      b.col.visible = b.ring.visible = true;
      const d = Math.hypot(m.x - px, m.z - pz);
      const near = clamp((d - 2.2) / 4.5, 0, 1);           // standing on it should not blind you
      const pulse = calm ? 0.62 : 0.5 + Math.sin(t * 1.5 + k * 1.3) * 0.16;
      b.cm.opacity = 0.36 * near * pulse * 2;
      b.rm.opacity = 0.5 * near * (calm ? 0.7 : 0.55 + Math.sin(t * 1.5 + k * 1.3) * 0.25);
      const rs = calm ? 1 : 1 + Math.sin(t * 1.5 + k * 1.3) * 0.09;
      b.ring.scale.set(rs, 1, rs);
    }
  }

  RF.api = RF.api || {};
  RF.api.waypoints = {
    list() { return marks.map(m => ({ id: m.id, x: m.x, z: m.z, name: m.name, color: WP_COL[m.c] || WP_COL[0] })); },
    add(x, z, name) { const m = wpAdd(x, z, name, marks.length % 6); return m ? { id: m.id, x: m.x, z: m.z, name: m.name, color: WP_COL[m.c] } : null; },
    remove(id) { return wpRemove(id | 0); },
    nearest: wpNearest
  };

  /* ========================================================================
     3. THE ATLAS — DOM, styling, and the two-layer canvas.
     ====================================================================== */
  RF.css(`
#rf-world-atlas{position:fixed;inset:0;z-index:25;display:none;
  font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:calc(13px * var(--rf-ui-scale,1));color:var(--ink);
  background:radial-gradient(130% 100% at 50% -10%,rgba(14,26,32,.42),rgba(3,8,10,.74));
  backdrop-filter:blur(7px) saturate(1.2);-webkit-backdrop-filter:blur(7px) saturate(1.2);}
#rf-world-atlas.on{display:block;}
body.photo #rf-world-atlas{display:none!important;}
#rf-world-atlas .rf-world-shell{position:absolute;inset:.8em;display:flex;flex-direction:column;gap:.6em;}
#rf-world-atlas .rf-world-bar{display:flex;align-items:center;gap:.8em;flex:0 0 auto;flex-wrap:wrap;
  background:var(--glass-sheen),var(--glass-strong);backdrop-filter:blur(18px) saturate(1.6);
  -webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);border-radius:14px;
  padding:.6em .85em;box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
#rf-world-atlas .rf-world-ttl{display:flex;flex-direction:column;gap:.1em;margin-right:auto;min-width:0;}
#rf-world-atlas .rf-world-eye{font-size:.66em;letter-spacing:.34em;color:var(--teal);}
#rf-world-atlas .rf-world-ttl b{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:1.35em;line-height:1.05;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#rf-world-atlas .rf-world-tools{display:flex;gap:.4em;flex-wrap:wrap;}
#rf-world-atlas .rf-world-btn{font-family:"Chakra Petch",sans-serif;font-weight:600;font-size:.82em;letter-spacing:.1em;
  cursor:pointer;border-radius:9px;padding:.5em .8em;border:1px solid var(--glass-bd-soft);background:var(--glass-row);
  color:var(--ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.1);transition:border-color .12s,color .12s,box-shadow .12s;}
#rf-world-atlas .rf-world-btn:hover{border-color:rgba(57,215,196,.6);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px rgba(57,215,196,.2);}
#rf-world-atlas .rf-world-btn.lit{color:var(--gold);border-color:rgba(255,207,92,.6);}
#rf-world-atlas .rf-world-x:hover{border-color:var(--rose);color:var(--rose);box-shadow:none;}
#rf-world-atlas .rf-world-body{flex:1 1 auto;display:flex;gap:.6em;min-height:0;}
#rf-world-atlas .rf-world-map{position:relative;flex:1 1 auto;min-width:0;border-radius:16px;overflow:hidden;
  border:1px solid var(--glass-bd);background:var(--glass-strong);box-shadow:var(--glass-hi),0 10px 30px rgba(2,8,10,.4);}
#rf-world-cv{position:absolute;inset:0;display:block;cursor:crosshair;touch-action:none;image-rendering:pixelated;}
#rf-world-alm{position:absolute;left:.6em;right:.6em;bottom:.6em;pointer-events:none;
  font-size:.76em;letter-spacing:.05em;color:var(--lab);font-variant-numeric:tabular-nums;
  background:var(--glass-hud);backdrop-filter:blur(12px) saturate(1.5);-webkit-backdrop-filter:blur(12px) saturate(1.5);
  border:1px solid var(--glass-bd-soft);border-radius:10px;padding:.45em .7em;
  display:flex;gap:.55em;flex-wrap:wrap;align-items:center;box-shadow:0 5px 16px rgba(2,8,10,.3);}
#rf-world-alm b{color:var(--ink);font-weight:600;}
#rf-world-alm i{font-style:normal;color:var(--faint);}
#rf-world-alm .g{color:var(--gold);}
#rf-world-alm .t{color:var(--teal);}
#rf-world-atlas .rf-world-rail{flex:0 0 17em;overflow-y:auto;overscroll-behavior:contain;
  background:var(--glass-sheen),var(--glass-strong);backdrop-filter:blur(18px) saturate(1.6);
  -webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);border-radius:16px;
  padding:.7em .75em;box-shadow:var(--glass-hi),0 10px 30px rgba(2,8,10,.4);}
#rf-world-atlas .rf-world-rail::-webkit-scrollbar{width:5px;}
#rf-world-atlas .rf-world-rail::-webkit-scrollbar-thumb{background:var(--glass-bd);border-radius:3px;}
#rf-world-atlas .rf-world-sec{font-size:.68em;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);
  margin:.9em 0 .45em;}
#rf-world-atlas .rf-world-sec:first-child{margin-top:.1em;}
#rf-world-atlas .rf-world-row{display:flex;align-items:center;gap:.5em;background:var(--glass-row);
  border:1px solid var(--glass-bd-soft);border-radius:9px;padding:.4em .55em;margin-bottom:.3em;cursor:pointer;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07);transition:border-color .12s,background .12s;}
#rf-world-atlas .rf-world-row:hover{border-color:rgba(57,215,196,.5);background:rgba(255,255,255,.08);}
#rf-world-atlas .rf-world-row .sw{width:.72em;height:.72em;border-radius:3px;flex:0 0 auto;box-shadow:0 0 6px currentColor;}
#rf-world-atlas .rf-world-row .nm{flex:1 1 auto;font-size:.84em;color:var(--ink);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
#rf-world-atlas .rf-world-row .d{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:.8em;color:var(--gold);
  font-variant-numeric:tabular-nums;flex:0 0 auto;}
#rf-world-atlas .rf-world-row .ed{flex:0 0 auto;font-size:.72em;color:var(--faint);padding:0 .2em;}
#rf-world-atlas .rf-world-row:hover .ed{color:var(--teal);}
#rf-world-atlas .rf-world-note{font-size:.72em;color:var(--faint);line-height:1.5;margin:.15em 0 .3em;}
#rf-world-atlas .rf-world-leg{display:flex;align-items:center;gap:.45em;font-size:.74em;color:var(--muted);margin-bottom:.25em;}
#rf-world-atlas .rf-world-leg i{width:.6em;height:.6em;border-radius:50%;flex:0 0 auto;font-style:normal;}
#rf-world-atlas .rf-world-leg i.ho{background:none!important;border:1.5px solid currentColor;}
#rf-world-pop{position:absolute;display:none;width:14.5em;z-index:3;padding:.65em .7em;border-radius:13px;
  background:var(--glass-sheen),var(--glass-hud);backdrop-filter:blur(18px) saturate(1.6);
  -webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);
  box-shadow:var(--glass-hi),0 14px 34px rgba(2,8,10,.5);}
#rf-world-pop.on{display:block;}
#rf-world-pop .ph{font-size:.66em;letter-spacing:.24em;color:var(--teal);margin-bottom:.4em;}
#rf-world-pop input{width:100%;font-family:"IBM Plex Mono",monospace;font-size:.84em;color:var(--ink);
  background:rgba(0,0,0,.28);border:1px solid var(--glass-bd-soft);border-radius:8px;padding:.45em .55em;outline:none;}
#rf-world-pop input:focus{border-color:rgba(57,215,196,.7);}
#rf-world-pop .cols{display:flex;gap:.3em;margin:.5em 0;}
#rf-world-pop .cols button{flex:1 1 auto;height:1.3em;border-radius:5px;cursor:pointer;border:2px solid transparent;padding:0;}
#rf-world-pop .cols button.sel{border-color:var(--ink);}
#rf-world-pop .acts{display:flex;gap:.35em;}
#rf-world-pop .acts .rf-world-btn{flex:1 1 auto;padding:.45em .3em;text-align:center;}
@media (max-width:880px){
  #rf-world-atlas .rf-world-body{flex-direction:column;}
  #rf-world-atlas .rf-world-rail{flex:0 0 34%;}
}`, 'rf-world-css');

  const root = RF.el('<div id="rf-world-atlas" aria-hidden="true">' +
    '<div class="rf-world-shell">' +
      '<div class="rf-world-bar">' +
        '<div class="rf-world-ttl"><span class="rf-world-eye">ATLAS</span><b id="rf-world-name"></b></div>' +
        '<div class="rf-world-tools">' +
          '<button class="rf-world-btn" id="rf-world-heat">HEAT · OFF</button>' +
          '<button class="rf-world-btn" id="rf-world-zo">&minus;</button>' +
          '<button class="rf-world-btn" id="rf-world-zi">+</button>' +
          '<button class="rf-world-btn" id="rf-world-reset">RESET VIEW</button>' +
          '<button class="rf-world-btn rf-world-x" id="rf-world-close">ESC</button>' +
        '</div>' +
      '</div>' +
      '<div class="rf-world-body">' +
        '<div class="rf-world-map" id="rf-world-map">' +
          '<canvas id="rf-world-cv"></canvas>' +
          '<div id="rf-world-alm"></div>' +
          '<div id="rf-world-pop"></div>' +
        '</div>' +
        '<div class="rf-world-rail" id="rf-world-rail"></div>' +
      '</div>' +
    '</div></div>');

  const $ = id => document.getElementById(id);
  const mapEl = $('rf-world-map'), cvs = $('rf-world-cv'), popEl = $('rf-world-pop'),
        railEl = $('rf-world-rail'), almEl = $('rf-world-alm'), nameEl = $('rf-world-name');
  const ctx = cvs ? cvs.getContext('2d') : null;

  let AO = false, VW = 1, VH = 1, DPR = 1, drawFails = 0;
  const view = { cx: N / 2, cz: N / 2, s: 6 };

  function fitCanvas() {
    if (!cvs || !mapEl) return;
    const r = mapEl.getBoundingClientRect();
    VW = Math.max(80, Math.round(r.width)); VH = Math.max(80, Math.round(r.height));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(VW * DPR), ch = Math.round(VH * DPR);
    if (cvs.width !== cw || cvs.height !== ch) { cvs.width = cw; cvs.height = ch; }
  }
  const fitScale = () => Math.min(VW, VH) / N;
  const minScale = () => fitScale() * 0.7;
  const sx = wx => VW / 2 + (wx + HALF - view.cx) * view.s;
  const sy = wz => VH / 2 + (wz + HALF - view.cz) * view.s;
  const clampView = () => {
    view.s = clamp(view.s, minScale(), 26);
    view.cx = clamp(view.cx, -N * 0.2, N * 1.2);
    view.cz = clamp(view.cz, -N * 0.2, N * 1.2);
  };
  function centreOnPlayer(zoom) {
    view.cx = RF.pWorld.x + HALF; view.cz = RF.pWorld.z + HALF;
    if (zoom) view.s = clamp(fitScale() * 1.7, fitScale(), 13);
    clampView();
  }

  /* ---- the dynamic layer -------------------------------------------------- */
  function dot(x, y, col, r, hollow) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (hollow) { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); }
    else { ctx.fillStyle = col; ctx.fill(); }
  }
  function ring(x, y, r, col, w) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = col; ctx.lineWidth = w || 1.5; ctx.stroke();
  }
  function tag(x, y, text, col) {
    ctx.font = '600 ' + (11 * 1) + 'px "Chakra Petch",sans-serif';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(9,16,20,.78)';
    ctx.fillRect(x - w / 2 - 4, y - 15, w + 8, 13);
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 8.5);
  }

  function drawAtlas() {
    if (!AO || !ctx) return;
    try {
      if (!baseCv) baseCv = buildBase();
      if (!POIS) buildPOIs();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, VW, VH);
      ctx.fillStyle = 'rgba(6,14,18,.9)'; ctx.fillRect(0, 0, VW, VH);
      const s = view.s, ox = sx(-HALF), oy = sy(-HALF), span = N * s;
      if (baseCv) { ctx.imageSmoothingEnabled = false; ctx.drawImage(baseCv, ox, oy, span, span); }
      if (DB.heat) {
        const hv = heatCv[DB.heat - 1] || (heatCv[DB.heat - 1] = buildHeat(DB.heat));
        if (hv) { ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.62; ctx.drawImage(hv, ox, oy, span, span); ctx.globalAlpha = 1; }
      }
      ctx.imageSmoothingEnabled = true;
      const px = RF.pWorld.x, pz = RF.pWorld.z, now = RF.clock, tnow = Date.now();

      // trees: hollow while the stump is on cooldown
      if (s > 1.4) {
        // canopy colours are chosen to sit ON the ground they grow from, so the
        // dots stay legible on Fortune Isle's green and on Frostbite's white
        const leafG = fn.shade(W.leaf[0], 0.52), leafP = '#d15f9c';
        for (const t of RF.treeData) {
          const X = sx(t.x), Y = sy(t.z);
          if (X < -8 || Y < -8 || X > VW + 8 || Y > VH + 8) continue;
          const gone = t.srvUntil ? tnow < t.srvUntil : t.cd > now;
          dot(X, Y, t.pink ? leafP : leafG, Math.max(1.8, s * 0.24), gone);
        }
      }
      // ore veins: coloured by metal, hollow while respawning
      for (const n of RF.oreNodes) {
        const X = sx(n.x), Y = sy(n.z);
        if (X < -8 || Y < -8 || X > VW + 8 || Y > VH + 8) continue;
        const c = (RF.ORE_INFO[n.type] || RF.ORE_INFO.coal).dot;
        dot(X, Y, c, Math.max(2.4, s * 0.3), !n.alive);
        if (n.alive && n.geode) ring(X, Y, Math.max(4.2, s * 0.48), '#ffcf5c', 1);
      }
      // waypoints
      for (const m of marks) {
        const X = sx(m.x), Y = sy(m.z), c = WP_COL[m.c] || WP_COL[0];
        ctx.save(); ctx.translate(X, Y); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = c; ctx.fillRect(-4.2, -4.2, 8.4, 8.4);
        ctx.strokeStyle = 'rgba(6,14,18,.9)'; ctx.lineWidth = 1.4; ctx.strokeRect(-4.2, -4.2, 8.4, 8.4);
        ctx.restore();
        if (s > 2.2) tag(X, Y - 3, m.name, c);
      }
      // the X, only when it is buried on this isle
      const tr = RF.state.treasure;
      if (tr && (!tr.w || tr.w === WK)) {
        const X = sx(tr.i - HALF), Y = sy(tr.j - HALF);
        ctx.strokeStyle = '#ffd24f'; ctx.lineWidth = 2.6; ctx.beginPath();
        ctx.moveTo(X - 6, Y - 6); ctx.lineTo(X + 6, Y + 6); ctx.moveTo(X + 6, Y - 6); ctx.lineTo(X - 6, Y + 6); ctx.stroke();
        if (s > 2.2) tag(X, Y - 5, 'X', '#ffd24f');
      }
      // landmarks
      for (const p of POIS) {
        const X = sx(p.x), Y = sy(p.z);
        dot(X, Y, p.c, 5); ring(X, Y, 5, 'rgba(6,14,18,.9)', 2);
        if (s > 1.9) tag(X, Y - 4, p.n + ' · ' + Math.round(Math.hypot(p.x - px, p.z - pz)) + 'm', p.c);
      }
      // other anglers
      if (RF.peers && RF.peers.size) for (const q of RF.peers.values()) {
        const X = sx(q.x), Y = sy(q.z);
        dot(X, Y, '#bfe8e2', 4); ring(X, Y, 6, '#39d7c4', 1.6);
        if (s > 2.2) tag(X, Y - 5, q.name, '#bfe8e2');
      }
      // the player, as an arrow pointing where the hero faces
      { const X = sx(px), Y = sy(pz), f = RF.pWorld.face, dx = Math.sin(f), dz = Math.cos(f);
        ctx.save(); ctx.translate(X, Y); ctx.rotate(Math.atan2(dz, dx));
        ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 6); ctx.lineTo(-3, 0); ctx.lineTo(-6, -6); ctx.closePath();
        ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.strokeStyle = '#0a1418'; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.restore();
      }
      drawCompass(); drawScale();
      drawFails = 0;
    } catch (e) { if (drawFails++ < 2) RF.err('world:atlas', e); }
  }

  function drawCompass() {
    const cx = VW - 40, cy = 40, r = 17;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
    ctx.fillStyle = 'rgba(9,16,20,.72)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - r + 3); ctx.lineTo(cx - 3.5, cy + 1); ctx.lineTo(cx + 3.5, cy + 1); ctx.closePath();
    ctx.fillStyle = '#ff5d7a'; ctx.fill();
    ctx.font = '600 8px "Chakra Petch",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f4f2'; ctx.fillText('N', cx, cy - r + 9.5);
    // W walks toward -x/-z on this map, so the movement key gets its own tick
    const a = Math.atan2(-1, -1);
    ctx.strokeStyle = '#39d7c4'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
    ctx.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3)); ctx.stroke();
    ctx.fillStyle = '#39d7c4'; ctx.fillText('W', cx + Math.cos(a) * (r + 7), cy + Math.sin(a) * (r + 7));
  }

  function drawScale() {
    const opts = [1, 2, 5, 10, 20, 25, 50];
    let d = opts[opts.length - 1];
    for (const o of opts) if (o * view.s >= 52) { d = o; break; }
    const L = d * view.s, x = 16, y = 30;
    ctx.strokeStyle = 'rgba(232,244,242,.75)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + L, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.moveTo(x + L, y - 4); ctx.lineTo(x + L, y + 4); ctx.stroke();
    ctx.font = '600 10px "Chakra Petch",sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(232,244,242,.8)'; ctx.fillText(d + ' m', x, y - 6);
  }

  /* ---- the rail: bearings, marks, legend ---------------------------------- */
  const distRefs = [];
  function railBuild() {
    if (!railEl) return;
    if (!POIS) buildPOIs();
    distRefs.length = 0;
    const ic = (n, s) => fn.pixSVG(n, s) || '';
    let h = '<div class="rf-world-sec">Bearings</div>';
    POIS.forEach((p, i) => {
      h += '<div class="rf-world-row" data-poi="' + i + '"><span class="sw" style="background:' + p.c + ';color:' + p.c + '"></span>' +
        '<span class="nm">' + ic(p.ic, 13) + ' ' + esc(p.n) + '</span><span class="d">–</span></div>';
    });
    h += '<div class="rf-world-sec">Marks · ' + marks.length + '/8</div>';
    if (!marks.length) h += '<div class="rf-world-note">Click anywhere on the map to plant a mark. Each one raises a beacon you can see from across the isle.</div>';
    marks.forEach(m => {
      h += '<div class="rf-world-row" data-wp="' + m.id + '"><span class="sw" style="background:' + WP_COL[m.c] + ';color:' + WP_COL[m.c] + '"></span>' +
        '<span class="nm">' + esc(m.name) + '</span><span class="d">–</span><span class="ed" data-edit="' + m.id + '">EDIT</span></div>';
    });
    h += '<div class="rf-world-sec">Legend</div>';
    const seen = Object.create(null);
    for (const n of RF.oreNodes) seen[n.type] = 1;
    for (const k in seen) h += '<div class="rf-world-leg" style="color:' + RF.ORE_INFO[k].dot + '"><i style="background:' +
      RF.ORE_INFO[k].dot + '"></i><span style="color:var(--muted)">' + RF.ORE_INFO[k].name + ' vein</span></div>';
    h += '<div class="rf-world-leg" style="color:' + W.leaf[0] + '"><i style="background:' + W.leaf[0] + '"></i><span style="color:var(--muted)">Tree</span></div>';
    h += '<div class="rf-world-leg" style="color:var(--muted)"><i class="ho"></i><span>Hollow · felled or mined out</span></div>';
    h += '<div class="rf-world-leg" style="color:#cba86f"><i style="background:#cba86f"></i><span style="color:var(--muted)">Carved path</span></div>';
    if (RF.online) h += '<div class="rf-world-leg" style="color:#39d7c4"><i style="background:#bfe8e2"></i><span style="color:var(--muted)">Another angler</span></div>';
    h += '<div class="rf-world-note">Drag to pan · wheel to zoom · right-click a mark to rename or clear it.</div>';
    railEl.innerHTML = h;
    railEl.querySelectorAll('.rf-world-row .d').forEach(el => distRefs.push(el));
  }

  function railDist() {
    if (!AO || !distRefs.length) return;
    const px = RF.pWorld.x, pz = RF.pWorld.z; let k = 0;
    for (const p of POIS) { const el = distRefs[k++]; if (el) el.textContent = Math.round(Math.hypot(p.x - px, p.z - pz)) + 'm'; }
    for (const m of marks) { const el = distRefs[k++]; if (el) el.textContent = Math.round(Math.hypot(m.x - px, m.z - pz)) + 'm'; }
  }

  /* ---- the almanac line: the map doubles as a pre-run briefing ------------- */
  const MOON = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const WEA = { clear: 'Clear', rain: 'Rain', storm: 'Storm', snow: 'Snow', ash: 'Ashfall' };
  function almanac() {
    if (!almEl || !AO) return;
    const t = RF.dayT * 24, hh = String(Math.floor(t)).padStart(2, '0'), mm = String(Math.floor((t % 1) * 60)).padStart(2, '0');
    const alive = RF.oreNodes.reduce((a, n) => a + (n.alive ? 1 : 0), 0);
    let mk = '';
    try { const m = fn.mktMods(); mk = '<i>demand</i> <b class="g">' + esc(fn.catLabel(m.hot)) + '</b> hot · <b>' + esc(fn.catLabel(m.cold)) + '</b> cold'; }
    catch (e) { mk = ''; }
    const parts = [
      '<b>Day ' + (RF.dayCount + 1) + '</b>',
      '<b class="t">' + hh + ':' + mm + '</b>',
      W.cave ? '<i>no sky</i>' : MOON[Math.floor(RF.dayCount) % 8],
      '<b>' + (WEA[RF.weather] || RF.weather) + '</b>',
      '<i>fish</i> <b class="g">&times;' + W.fishMul + '</b>',
      '<i>ore</i> <b class="g">&times;' + W.oreYield + '</b>',
      '<i>veins</i> <b>' + alive + '/' + RF.oreNodes.length + '</b>',
      '<i>trees</i> <b>' + RF.treeData.length + '</b>'
    ];
    if (mk) parts.push(mk);
    almEl.innerHTML = parts.join('<span style="color:var(--faint)">·</span>');
  }

  /* ---- open / close ------------------------------------------------------- */
  function open() {
    if (AO || !root) return;
    if (RF.panelOpen || RF.chatOpen) return;
    AO = true; root.classList.add('on'); root.setAttribute('aria-hidden', 'false');
    if (nameEl) nameEl.innerHTML = esc(W.name) + ' <span style="color:var(--faint);font-weight:500;font-size:.62em;letter-spacing:.1em">' + esc(W.sub.toUpperCase()) + '</span>';
    // a full-screen map should not let the hero keep walking off a cliff
    RF.keys.up = RF.keys.down = RF.keys.left = RF.keys.right = RF.keys.act = false;
    fitCanvas(); centreOnPlayer(true); railBuild(); railDist(); almanac(); paintHeatBtn(); drawAtlas();
    RF.sfx.open();
  }
  function close() {
    if (!AO) return;
    AO = false; root.classList.remove('on'); root.setAttribute('aria-hidden', 'true');
    popClose(); RF.sfx.close(); saveDB();
  }
  function paintHeatBtn() {
    const b = $('rf-world-heat'); if (!b) return;
    b.textContent = 'HEAT · ' + (DB.heat === 1 ? 'ORE' : DB.heat === 2 ? 'TREES' : 'OFF');
    b.classList.toggle('lit', DB.heat !== 0);
  }

  /* ---- pointer: pan, zoom, plant ----------------------------------------- */
  const ptrs = new Map();
  let dragging = false, downX = 0, downY = 0, moved = 0, pinch0 = 0, pinchS = 0;
  if (cvs) {
    cvs.addEventListener('pointerdown', e => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.button === 2) return;
      try { cvs.setPointerCapture(e.pointerId); } catch (_) {}
      dragging = true; downX = e.clientX; downY = e.clientY; moved = 0;
      if (ptrs.size === 2) { const p = [...ptrs.values()]; pinch0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); pinchS = view.s; }
    });
    cvs.addEventListener('pointermove', e => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 2 && pinch0 > 0) {
        const q = [...ptrs.values()], d = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y);
        view.s = clamp(pinchS * (d / pinch0), minScale(), 26); clampView(); drawAtlas(); return;
      }
      if (!dragging) return;
      moved += Math.abs(dx) + Math.abs(dy);
      view.cx -= dx / view.s; view.cz -= dy / view.s; clampView(); drawAtlas();
    });
    const up = e => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch0 = 0;
      if (!dragging) return;
      dragging = false;
      try { cvs.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved < 6 && e.button !== 2) onClick(e);
    };
    cvs.addEventListener('pointerup', up);
    cvs.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); dragging = false; pinch0 = 0; });
    cvs.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cvs.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const cellX = view.cx + (mx - VW / 2) / view.s, cellZ = view.cz + (my - VH / 2) / view.s;
      view.s = clamp(view.s * Math.exp(-e.deltaY * 0.0016), minScale(), 26);
      view.cx = cellX - (mx - VW / 2) / view.s; view.cz = cellZ - (my - VH / 2) / view.s;
      clampView(); drawAtlas();
    }, { passive: false });
    cvs.addEventListener('contextmenu', e => {
      e.preventDefault();
      const hit = hitMark(e); if (hit) popEdit(hit, e);
    });
  }
  function localXY(e) { const r = cvs.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hitMark(e) {
    const [mx, my] = localXY(e);
    for (const m of marks) if (Math.hypot(sx(m.x) - mx, sy(m.z) - my) < 11) return m;
    return null;
  }
  function onClick(e) {
    const hit = hitMark(e);
    if (hit) { popEdit(hit, e); return; }
    const [mx, my] = localXY(e);
    const wx = view.cx + (mx - VW / 2) / view.s - HALF, wz = view.cz + (my - VH / 2) / view.s - HALF;
    if (Math.abs(wx) > HALF || Math.abs(wz) > HALF) return;
    if (marks.length >= 8) { say({ level: 'warn', title: 'Chart is full', body: 'Eight marks per isle · clear one first', tag: 'world' }); return; }
    popNew(wx, wz, mx, my);
  }

  /* ---- the mark popover --------------------------------------------------- */
  let popMark = null;
  function popClose() { if (popEl) { popEl.classList.remove('on'); popEl.innerHTML = ''; } popMark = null; }
  function popPlace(mx, my) {
    if (!popEl) return;
    popEl.classList.add('on');
    const w = popEl.offsetWidth || 200, h = popEl.offsetHeight || 140;
    popEl.style.left = clamp(mx - w / 2, 8, Math.max(8, VW - w - 8)) + 'px';
    popEl.style.top = clamp(my + 14, 8, Math.max(8, VH - h - 8)) + 'px';
  }
  function popShell(title, name, ci, extra) {
    let cols = '';
    for (let k = 0; k < WP_COL.length; k++)
      cols += '<button data-c="' + k + '" class="' + (k === ci ? 'sel' : '') + '" style="background:' + WP_COL[k] + '"></button>';
    popEl.innerHTML = '<div class="ph">' + title + '</div>' +
      '<input id="rf-world-nm" maxlength="22" value="' + esc(name) + '">' +
      '<div class="cols">' + cols + '</div>' +
      '<div class="acts">' + extra + '</div>';
  }
  function popNew(wx, wz, mx, my) {
    if (!popEl) return;
    popMark = { x: wx, z: wz, c: marks.length % 6 };
    popShell('PLANT A MARK', 'Mark ' + (marks.length + 1), popMark.c,
      '<button class="rf-world-btn" data-act="ok">PLANT</button><button class="rf-world-btn rf-world-x" data-act="no">CANCEL</button>');
    wirePop(); popPlace(mx, my); focusName();
  }
  function popEdit(m, e) {
    if (!popEl) return;
    popMark = m;
    popShell('MARK', m.name, m.c,
      '<button class="rf-world-btn" data-act="save">SAVE</button><button class="rf-world-btn rf-world-x" data-act="del">CLEAR</button>');
    wirePop();
    const [mx, my] = e ? localXY(e) : [sx(m.x), sy(m.z)];
    popPlace(mx, my); focusName();
  }
  function focusName() { const i = $('rf-world-nm'); if (i) { i.focus(); i.select(); } }
  function wirePop() {
    popEl.querySelectorAll('.cols button').forEach(b => {
      b.onclick = () => {
        if (!popMark) return;
        popMark.c = +b.getAttribute('data-c') || 0;
        popEl.querySelectorAll('.cols button').forEach(o => o.classList.toggle('sel', o === b));
        if (popMark.id) { saveDB(); syncBeacons(); railBuild(); }
        drawAtlas();
      };
    });
    popEl.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => popAct(b.getAttribute('data-act')); });
  }
  function popAct(act) {
    if (!popMark) return;
    const inp = $('rf-world-nm'), nm = inp ? inp.value.trim().slice(0, 22) : '';
    if (act === 'no') { popClose(); return; }
    if (act === 'ok') { wpAdd(popMark.x, popMark.z, nm || 'Mark', popMark.c); popClose(); drawAtlas(); RF.sfx.click(); return; }
    if (act === 'save') { popMark.name = nm || popMark.name; saveDB(); syncBeacons(); railBuild(); popClose(); drawAtlas(); RF.sfx.click(); return; }
    if (act === 'del') askDelete(popMark);
  }
  /* 00-notify owns confirmation dialogs; when it is missing (or answers by
     callback rather than promise) the popover falls back to a two-tap CLEAR. */
  function askDelete(m) {
    let done = false;
    const kill = () => { if (done) return; done = true; wpRemove(m.id); popClose(); drawAtlas(); };
    if (RF.api && typeof RF.api.confirm === 'function') {
      let asked = true, r = null;
      try { r = RF.api.confirm({ title: 'Clear this mark?', body: m.name, confirm: 'Clear', cancel: 'Keep', level: 'warn', danger: true, onConfirm: kill }); }
      catch (e) { asked = false; RF.err('world:confirm', e); }
      // promise-style answers here; callback-style answers through onConfirm
      if (asked) { if (r && typeof r.then === 'function') r.then(ok => { if (ok) kill(); }, () => {}); return; }
    }
    const btn = popEl.querySelector('[data-act="del"]'); if (!btn) { kill(); return; }
    if (btn.dataset.armed) { kill(); return; }
    btn.dataset.armed = '1'; btn.textContent = 'REALLY?';
  }

  /* ---- chrome wiring ------------------------------------------------------ */
  const on = (id, f) => { const el = $(id); if (el) el.onclick = f; };
  on('rf-world-close', close);
  on('rf-world-reset', () => { centreOnPlayer(true); drawAtlas(); });
  on('rf-world-zi', () => { view.s = clamp(view.s * 1.35, minScale(), 26); clampView(); drawAtlas(); });
  on('rf-world-zo', () => { view.s = clamp(view.s / 1.35, minScale(), 26); clampView(); drawAtlas(); });
  on('rf-world-heat', () => { DB.heat = (DB.heat + 1) % 3; saveDB(); paintHeatBtn(); drawAtlas(); RF.sfx.tab(); });
  if (railEl) railEl.addEventListener('click', e => {
    const ed = e.target.closest ? e.target.closest('[data-edit]') : null;
    if (ed) { const m = marks.find(x => x.id === +ed.getAttribute('data-edit')); if (m) popEdit(m, null); return; }
    const row = e.target.closest ? e.target.closest('.rf-world-row') : null;
    if (!row) return;
    const pi = row.getAttribute('data-poi'), wi = row.getAttribute('data-wp');
    let t = null;
    if (pi !== null && POIS) t = POIS[+pi];
    else if (wi !== null) t = marks.find(x => x.id === +wi);
    if (!t) return;
    view.cx = t.x + HALF; view.cz = t.z + HALF; view.s = clamp(Math.max(view.s, 7), minScale(), 26);
    clampView(); drawAtlas(); RF.sfx.click();
  });
  addEventListener('resize', () => { if (!AO) return; fitCanvas(); clampView(); drawAtlas(); });

  /* keys: claim everything while the atlas owns the screen, so a held W does
     not walk the hero into the sea behind the map. */
  RF.on('keydown', e => {                                   // typing in our own field must never reach any other mod
    if (AO && e.target && e.target.id === 'rf-world-nm') {
      if (e.code === 'Escape') { popClose(); return true; }
      if (e.code === 'Enter') { popAct(popMark && popMark.id ? 'save' : 'ok'); return true; }
      return true;
    }
  }, -20);
  RF.on('keydown', e => {
    if (typing()) return;
    if (e.code === 'KeyM' && !RF.panelOpen) { e.preventDefault(); AO ? close() : open(); return true; }
    if (!AO) return;
    if (e.code === 'Escape') { if (popMark) popClose(); else close(); return true; }
    if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD' ||
        e.code === 'Space' || e.code === 'KeyE' || e.code.indexOf('Arrow') === 0) { e.preventDefault(); return true; }
  });
  RF.on('panel', (n, o) => { if (o && AO) close(); });

  /* ========================================================================
     4. AMBIENT LIFE — pooled instanced voxels, recycled forever.
     Everything below is drawn from eight InstancedMeshes; nothing allocates a
     geometry, a material or a mesh after load, and nothing allocates inside
     the update at all.
     ====================================================================== */
  const boxG = new THREE.BoxGeometry(1, 1, 1), D = new THREE.Object3D(), TMPC = new THREE.Color();
  function IM(mat, n) {
    const m = new THREE.InstancedMesh(boxG, mat, Math.max(1, n));
    m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
    for (let k = 0; k < m.count; k++) { D.position.set(0, -900, 0); D.rotation.set(0, 0, 0); D.scale.set(0.001, 0.001, 0.001); D.updateMatrix(); m.setMatrixAt(k, D.matrix); }
    m.instanceMatrix.needsUpdate = true; m.visible = false; RF.scene.add(m); return m;
  }
  function put(im, k, x, y, z, sx2, sy2, sz2, yaw, roll) {
    D.position.set(x, y, z); D.rotation.set(0, yaw || 0, 0); D.scale.set(sx2, sy2, sz2);
    if (roll) D.rotateZ(roll);
    D.updateMatrix(); im.setMatrixAt(k, D.matrix);
  }
  function hide(im, k) { D.position.set(0, -900, 0); D.rotation.set(0, 0, 0); D.scale.set(0.001, 0.001, 0.001); D.updateMatrix(); im.setMatrixAt(k, D.matrix); }
  function col(im, k, hex, f) { TMPC.set(hex); if (f !== undefined) TMPC.multiplyScalar(f); im.setColorAt(k, TMPC); }

  const NG = 8, NC = 6, NB = 10, NF = 14, NM = 5, NJ = 3, NP = 28;
  const mGullB = new THREE.MeshLambertMaterial({ color: 0xf4f8f6 });
  const mGullW = new THREE.MeshLambertMaterial({ color: 0xdbe7e4 });
  const mCrabB = new THREE.MeshLambertMaterial({ color: 0xd4623f });
  const mCrabC = new THREE.MeshLambertMaterial({ color: 0xe8825c });
  const mWing = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mGlow = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false });
  const mMoth = new THREE.MeshLambertMaterial({ color: 0xe6dfc8 });
  const mJump = new THREE.MeshLambertMaterial({ color: 0x9fd4e8 });
  const mMote = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const imGullB = IM(mGullB, NG), imGullW = IM(mGullW, NG * 2);
  const imCrabB = IM(mCrabB, NC), imCrabC = IM(mCrabC, NC * 2);
  const imBfly = IM(mWing, NB * 2), imFfly = IM(mGlow, NF), imMoth = IM(mMoth, NM);
  const imJump = IM(mJump, NJ), imMote = IM(mMote, NP);
  const POOLS = [imGullB, imGullW, imCrabB, imCrabC, imBfly, imFfly, imMoth, imJump, imMote];
  // instanceColor is born as zeros (i.e. black), so every tinted pool is primed white up front
  for (const p of [imBfly, imFfly, imMote]) { for (let k = 0; k < p.count; k++) col(p, k, '#ffffff'); p.instanceColor.needsUpdate = true; }

  const rings = [];
  { const rg = new THREE.RingGeometry(0.55, 0.85, 18); rg.rotateX(-Math.PI / 2);
    for (let k = 0; k < 3; k++) {
      const rm = new THREE.MeshBasicMaterial({ color: 0xe6faff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const me = new THREE.Mesh(rg, rm); me.frustumCulled = false; me.visible = false; RF.scene.add(me);
      rings.push({ m: me, mat: rm, t: 0, on: false, sc: 1 });
    } }

  /* spawn anchors, scanned once: shoreline sand, shallow sea, grass, canopies */
  const SHORE = [], SEA = [], GRASS = [], PINK = [], GREEN = [];
  (function scanIsle() {
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const h = HM[i][j];
      if (h === 3) { if (HM[i + 1][j] <= 2 || HM[i - 1][j] <= 2 || HM[i][j + 1] <= 2 || HM[i][j - 1] <= 2) SHORE.push(i - HALF, j - HALF); }
      else if (h <= 2) { if (HM[i + 1][j] >= 3 || HM[i - 1][j] >= 3 || HM[i][j + 1] >= 3 || HM[i][j - 1] >= 3) SEA.push(i - HALF, j - HALF); }
    }
    for (const c of RF.grassCells) GRASS.push(c[0] - HALF, c[1] - HALF);
    for (const t of RF.treeData) (t.pink ? PINK : GREEN).push(t.x, t.z);
  })();
  const TMP = { x: 0, z: 0 };
  function pick(arr, minD, maxD) {
    const n = arr.length >> 1; if (!n) return false;
    const px = RF.pWorld.x, pz = RF.pWorld.z;
    for (let k = 0; k < 8; k++) {
      const i = ((Math.random() * n) | 0) * 2, x = arr[i], z = arr[i + 1], d = Math.hypot(x - px, z - pz);
      if (d >= minD && d <= maxD) { TMP.x = x; TMP.z = z; return true; }
    }
    return false;
  }

  const gulls = [], crabs = [], bflys = [], fflys = [], moths = [], jumps = [], motes = [];
  for (let k = 0; k < NG; k++) gulls.push({ st: 0, ok: false, x: 0, z: 0, y: 0, ax: 0, az: 0, r: 5, a: 0, sp: 0.5, h: 6, t: 99, next: 0, lx: 0, lz: 0, yaw: 0 });
  for (let k = 0; k < NC; k++) crabs.push({ x: 0, z: 0, a: 0, t: 0, next: 0, run: 0, ok: false });
  for (let k = 0; k < NB; k++) bflys.push({ hx: 0, hz: 0, ph: 0, sp: 1, t: 0, c: '#ffcf5c', ok: false });
  for (let k = 0; k < NF; k++) fflys.push({ hx: 0, hz: 0, ph: 0, t: 0, ok: false });
  for (let k = 0; k < NM; k++) moths.push({ cx: 0, cy: 0, cz: 0, a: 0, r: 0.7, ph: 0, ok: false });
  for (let k = 0; k < NJ; k++) jumps.push({ on: false, t: 0, dur: 1, x: 0, z: 0, y0: 0, h: 1, yaw: 0, wait: rand(1, 8) });
  for (let k = 0; k < NP; k++) motes.push({ on: false, k: '', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, life: 1, s: 0.1, c: '#ffffff', set: 0 });

  const CAS_LAMP = [];
  if (RF.casino) for (const a of [-1, 1]) for (const b of [-1, 1])
    CAS_LAMP.push(RF.casino.position.x + a * 1.85, RF.casino.position.y + 2.95, RF.casino.position.z + b * 1.85);

  function moteKind() {
    if (fn.isAsh()) return 'ash';
    if (fn.isCold()) return 'snow';
    if (PINK.length && Math.random() < 0.65) return 'petal';
    return GREEN.length ? 'leaf' : (PINK.length ? 'petal' : null);
  }

  let poolsOn = false, ambT = 0, frac = 1;
  function setPools(v) { if (poolsOn === v) return; poolsOn = v; for (const p of POOLS) p.visible = v; if (!v) for (const r of rings) { r.on = false; r.m.visible = false; } }

  function ambient(dt) {
    const q = quality();
    if (!RF.running || RF.panelOpen || AO || q === 'low') { setPools(false); return; }
    setPools(true);
    frac = q === 'med' ? 0.5 : 1;
    ambT += dt;
    const t = ambT, px = RF.pWorld.x, pz = RF.pWorld.z;
    const storm = RF.weather === 'storm', night = fn.isNight(), day = !night, calm = !reduced();
    const wx = Math.cos(t * 0.06), wz = Math.sin(t * 0.06);
    const nG = Math.round(NG * frac), nC = Math.round(NC * frac), nB = Math.round(NB * frac),
          nF = Math.round(NF * frac), nM = Math.round(NM * frac), nJ = Math.round(NJ * frac), nP = Math.round(NP * frac);

    /* --- gulls: wheel over the shore, drop in to rest, scatter when walked through --- */
    const gullsUp = day && !storm && SHORE.length > 0;
    imGullB.visible = imGullW.visible = gullsUp;
    if (gullsUp) for (let k = 0; k < NG; k++) {
      const g = gulls[k];
      if (k >= nG) { hide(imGullB, k); hide(imGullW, k * 2); hide(imGullW, k * 2 + 1); continue; }
      g.t += dt;
      if (g.st === 0 && (!g.ok || g.t > g.next || Math.hypot(g.ax - px, g.az - pz) > 34)) {
        if (pick(SHORE, 7, 26)) { g.ax = TMP.x; g.az = TMP.z; g.r = rand(3.5, 7); g.sp = rand(0.35, 0.7) * (Math.random() < 0.5 ? -1 : 1);
          g.h = rand(5, 9); g.a = rand(0, TAU); g.x = g.ax + Math.cos(g.a) * g.r; g.z = g.az + Math.sin(g.a) * g.r;
          g.y = fn.heightAt(g.x, g.z) + g.h; g.ok = true; }
        g.t = 0; g.next = rand(9, 18);
        if (!g.ok) { hide(imGullB, k); hide(imGullW, k * 2); hide(imGullW, k * 2 + 1); continue; }
      } else if (g.st === 0 && g.t > g.next * 0.65 && pick(SHORE, 6, 22)) {
        g.lx = TMP.x; g.lz = TMP.z; g.st = 1;
      }
      if (g.st === 1) {                                     // gliding down to the sand
        const dx = g.lx - g.x, dz = g.lz - g.z, d = Math.hypot(dx, dz) || 1;
        const sp = Math.min(d, 5 * dt);
        g.x += dx / d * sp; g.z += dz / d * sp; g.yaw = Math.atan2(dx, dz);
        const gy = fn.heightAt(g.x, g.z) + 0.16;
        g.y = lerp(g.y, gy, 1 - Math.exp(-3 * dt));
        if (d < 0.4 && Math.abs(g.y - gy) < 0.12) { g.st = 2; g.t = 0; g.next = rand(5, 12); }
      } else if (g.st === 2) {                              // sitting; a runner sends the flock up
        g.y = fn.heightAt(g.x, g.z) + 0.16;
        if (g.t > g.next || Math.hypot(g.x - px, g.z - pz) < 4.2) { g.st = 3; g.t = 0; g.next = 1.3; }
      } else if (g.st === 3) {                              // scattering
        const dx = g.x - px, dz = g.z - pz, d = Math.hypot(dx, dz) || 1;
        g.x += dx / d * 5.5 * dt; g.z += dz / d * 5.5 * dt; g.yaw = Math.atan2(dx, dz);
        g.y = lerp(g.y, fn.heightAt(g.x, g.z) + g.h, 1 - Math.exp(-2.2 * dt));
        if (g.t > g.next) { g.st = 0; g.t = 0; g.next = rand(9, 18); g.ax = g.x - Math.cos(g.a) * g.r; g.az = g.z - Math.sin(g.a) * g.r; }
      } else if (g.st === 0) {
        g.a += g.sp * dt;
        const tx = g.ax + Math.cos(g.a) * g.r, tz = g.az + Math.sin(g.a) * g.r;
        g.yaw = Math.atan2(tx - g.x, tz - g.z); g.x = tx; g.z = tz;
        g.y = lerp(g.y, Math.max(fn.heightAt(g.x, g.z), WATER_Y) + g.h + Math.sin(t * 0.7 + k) * 0.3, 1 - Math.exp(-2 * dt));
      }
      const flap = g.st === 2 ? 0.08 : calm ? Math.sin(t * 13 + k * 2) * 0.75 : 0.2;
      put(imGullB, k, g.x, g.y, g.z, 0.5, 0.24, 0.3, g.yaw);
      const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
      for (const side of [-1, 1]) {
        const ox = side * 0.26 * c, oz = -side * 0.26 * s, oy = Math.sin(flap) * side * -0.02 + Math.abs(Math.sin(flap)) * 0.07;
        put(imGullW, k * 2 + (side > 0 ? 1 : 0), g.x + ox, g.y + oy, g.z + oz, 0.5, 0.05, 0.24, g.yaw, flap * side);
      }
    }
    imGullB.instanceMatrix.needsUpdate = imGullW.instanceMatrix.needsUpdate = true;

    /* --- crabs: sideways along the waterline, and straight into the surf when you come close --- */
    const crabsUp = !storm && SHORE.length > 0;
    imCrabB.visible = imCrabC.visible = crabsUp;
    if (crabsUp) for (let k = 0; k < NC; k++) {
      const c2 = crabs[k];
      if (k >= nC) { hide(imCrabB, k); hide(imCrabC, k * 2); hide(imCrabC, k * 2 + 1); continue; }
      if (!c2.ok || Math.hypot(c2.x - px, c2.z - pz) > 32) {
        if (!pick(SHORE, 5, 24)) { hide(imCrabB, k); hide(imCrabC, k * 2); hide(imCrabC, k * 2 + 1); continue; }
        c2.x = TMP.x; c2.z = TMP.z; c2.a = rand(0, TAU); c2.t = 0; c2.next = rand(1, 3); c2.ok = true;
      }
      c2.t += dt;
      const dp = Math.hypot(c2.x - px, c2.z - pz);
      if (dp < 3.6) { c2.run = 1.2; c2.a = Math.atan2(c2.z - pz, c2.x - px); }
      if (c2.run > 0) c2.run -= dt;
      else if (c2.t > c2.next) { c2.a += rand(-1.4, 1.4); c2.t = 0; c2.next = rand(1, 3.4); }
      const sp = (c2.run > 0 ? 3.4 : 0.9) * dt;
      const nx = c2.x + Math.cos(c2.a) * sp, nz = c2.z + Math.sin(c2.a) * sp;
      if (fn.heightAt(nx, nz) === 3) { c2.x = nx; c2.z = nz; } else c2.a += 2.1;
      const y = fn.heightAt(c2.x, c2.z) + 0.11, yaw = c2.a + Math.PI / 2, wig = calm ? Math.sin(t * 9 + k) * 0.22 : 0;
      put(imCrabB, k, c2.x, y, c2.z, 0.3, 0.16, 0.24, yaw);
      const cc = Math.cos(yaw), ss = Math.sin(yaw);
      for (const side of [-1, 1])
        put(imCrabC, k * 2 + (side > 0 ? 1 : 0), c2.x + side * 0.18 * cc + wig * 0.04, y + 0.03, c2.z - side * 0.18 * ss, 0.12, 0.1, 0.12, yaw + wig * side);
    }
    imCrabB.instanceMatrix.needsUpdate = imCrabC.instanceMatrix.needsUpdate = true;

    /* --- butterflies by day, fireflies on a clear night --- */
    const bUp = day && !storm && GRASS.length > 0;
    imBfly.visible = bUp;
    if (bUp) for (let k = 0; k < NB; k++) {
      const b = bflys[k];
      if (k >= nB) { hide(imBfly, k * 2); hide(imBfly, k * 2 + 1); continue; }
      if (!b.ok || Math.hypot(b.hx - px, b.hz - pz) > 26) {
        if (!pick(GRASS, 3, 18)) { hide(imBfly, k * 2); hide(imBfly, k * 2 + 1); continue; }
        b.hx = TMP.x; b.hz = TMP.z; b.ph = rand(0, TAU); b.sp = rand(0.5, 0.95); b.ok = true;
        b.c = ['#ffcf5c', '#ff9ec4', '#9fe8ff', '#fff2b8', '#c490ff'][(Math.random() * 5) | 0];
        col(imBfly, k * 2, b.c); col(imBfly, k * 2 + 1, b.c);
      }
      b.t += dt;
      const x = b.hx + Math.sin(b.t * b.sp + b.ph) * 1.7 + Math.sin(b.t * 0.43) * 0.7;
      const z = b.hz + Math.cos(b.t * b.sp * 0.8 + b.ph * 1.7) * 1.7;
      const y = fn.heightAt(x, z) + 0.75 + Math.sin(b.t * 2.6 + b.ph) * 0.3;
      const yaw = b.t * b.sp, flap = calm ? Math.sin(b.t * 17 + b.ph) * 1.05 : 0.5;
      for (const side of [-1, 1])
        put(imBfly, k * 2 + (side > 0 ? 1 : 0), x + side * 0.06 * Math.cos(yaw), y, z - side * 0.06 * Math.sin(yaw), 0.17, 0.02, 0.12, yaw, flap * side);
    }
    imBfly.instanceMatrix.needsUpdate = true;
    if (imBfly.instanceColor) imBfly.instanceColor.needsUpdate = true;

    const fUp = night && RF.weather === 'clear' && GRASS.length > 0;
    imFfly.visible = fUp;
    if (fUp) for (let k = 0; k < NF; k++) {
      const f = fflys[k];
      if (k >= nF) { hide(imFfly, k); continue; }
      if (!f.ok || Math.hypot(f.hx - px, f.hz - pz) > 24) {
        if (!pick(GRASS, 2, 16)) { hide(imFfly, k); continue; }
        f.hx = TMP.x; f.hz = TMP.z; f.ph = rand(0, TAU); f.ok = true;
      }
      f.t += dt;
      const x = f.hx + Math.sin(f.t * 0.45 + f.ph) * 1.5, z = f.hz + Math.cos(f.t * 0.33 + f.ph * 1.4) * 1.5;
      const y = fn.heightAt(x, z) + 0.6 + Math.sin(f.t * 0.9 + f.ph) * 0.45;
      const b = calm ? Math.pow(Math.max(0, Math.sin(f.t * 1.7 + f.ph)), 3) * 0.9 + 0.08 : 0.6;
      col(imFfly, k, '#ffe98a', b);
      put(imFfly, k, x, y, z, 0.1, 0.1, 0.1, 0);
    }
    imFfly.instanceMatrix.needsUpdate = true;
    if (imFfly.instanceColor) imFfly.instanceColor.needsUpdate = true;

    /* --- moths, drawn to the four casino lamps once the sun is down --- */
    const mUp = night && !storm && CAS_LAMP.length > 0 && Math.hypot(RF.casino.position.x - px, RF.casino.position.z - pz) < 34;
    imMoth.visible = mUp;
    if (mUp) for (let k = 0; k < NM; k++) {
      const m2 = moths[k];
      if (k >= nM) { hide(imMoth, k); continue; }
      if (!m2.ok) { const i = ((Math.random() * (CAS_LAMP.length / 3)) | 0) * 3;
        m2.cx = CAS_LAMP[i]; m2.cy = CAS_LAMP[i + 1]; m2.cz = CAS_LAMP[i + 2];
        m2.r = rand(0.4, 1.1); m2.ph = rand(0, TAU); m2.a = rand(0, TAU); m2.ok = true; }
      m2.a += dt * rand(1.6, 2.4);
      const x = m2.cx + Math.cos(m2.a) * m2.r, z = m2.cz + Math.sin(m2.a * 1.3 + m2.ph) * m2.r;
      const y = m2.cy + Math.sin(m2.a * 2.1 + m2.ph) * 0.3;
      put(imMoth, k, x, y, z, 0.15, 0.04, 0.11, m2.a, calm ? Math.sin(t * 21 + k) * 0.6 : 0.3);
    }
    imMoth.instanceMatrix.needsUpdate = true;

    /* --- fish breaking the surface: rarer and heavier at dusk --- */
    const jUp = !storm && SEA.length > 0;
    imJump.visible = jUp;
    const dusk = (RF.dayT > 0.6 && RF.dayT < 0.8) || (RF.dayT > 0.04 && RF.dayT < 0.2);
    if (jUp) for (let k = 0; k < NJ; k++) {
      const j = jumps[k];
      if (k >= nJ) { hide(imJump, k); continue; }
      if (!j.on) {
        j.wait -= dt;
        if (j.wait <= 0) {
          j.wait = rand(dusk ? 3 : 6, dusk ? 9 : 20);
          if (pick(SEA, 6, 26)) {
            j.on = true; j.t = 0; j.h = dusk ? rand(1.5, 2.6) : rand(0.8, 1.5);
            j.dur = 0.55 + j.h * 0.32; j.x = TMP.x; j.z = TMP.z; j.y0 = WATER_Y;
            j.yaw = rand(0, TAU); RF.sfx.splash(0.05);
          }
        }
        hide(imJump, k); continue;
      }
      j.t += dt;
      const u = j.t / j.dur;
      if (u >= 1) { j.on = false; splash(j.x, j.z, dusk ? 1.35 : 1); hide(imJump, k); continue; }
      const y = j.y0 + 4 * j.h * u * (1 - u), vy = 4 * j.h * (1 - 2 * u);
      const sc = dusk ? 1.35 : 1;
      put(imJump, k, j.x + Math.sin(j.yaw) * u * 0.7, y, j.z + Math.cos(j.yaw) * u * 0.7,
        0.46 * sc, 0.16 * sc, 0.17 * sc, j.yaw, -Math.atan2(vy, 1.6));
    }
    imJump.instanceMatrix.needsUpdate = true;

    for (const r of rings) {
      if (!r.on) continue;
      r.t += dt;
      const u = r.t / 0.95;
      if (u >= 1) { r.on = false; r.m.visible = false; continue; }
      const s2 = (0.5 + u * 3.2) * r.sc; r.m.scale.set(s2, 1, s2); r.mat.opacity = 0.55 * (1 - u);
    }

    /* --- drifting matter: petals, leaves, ash, settling snow --- */
    const moteUp = fn.isAsh() ? true : !storm;
    imMote.visible = moteUp;
    if (moteUp) for (let k = 0; k < NP; k++) {
      const p = motes[k];
      if (k >= nP) { hide(imMote, k); continue; }
      if (!p.on) {
        const kind = moteKind();
        if (!kind) { hide(imMote, k); continue; }
        p.set = 0; p.k = kind;
        if (kind === 'ash') {
          p.x = px + rand(-16, 16); p.z = pz + rand(-16, 16); p.y = fn.heightAt(p.x, p.z) + rand(0.5, 7);
          p.vx = wx * 0.5 + rand(-0.2, 0.2); p.vz = wz * 0.5 + rand(-0.2, 0.2); p.vy = rand(0.05, 0.4);
          p.life = rand(5, 10); p.s = rand(0.05, 0.12); p.c = Math.random() < 0.14 ? '#ff8a3a' : '#7d6f68';
        } else if (kind === 'snow') {
          p.x = px + rand(-15, 15); p.z = pz + rand(-15, 15); p.y = fn.heightAt(p.x, p.z) + rand(6, 11);
          p.vx = wx * 0.35; p.vz = wz * 0.35; p.vy = -rand(0.5, 1.1);
          p.life = 16; p.s = rand(0.06, 0.11); p.c = '#f4fbff';
        } else {                                            // petals off the cherries, leaves off everything else
          const src = kind === 'petal' ? PINK : GREEN;
          if (!pick(src, 0, 21)) { hide(imMote, k); continue; }
          p.x = TMP.x + rand(-1, 1); p.z = TMP.z + rand(-1, 1); p.y = fn.heightAt(p.x, p.z) + rand(3, 4.6);
          p.vx = wx * (kind === 'petal' ? 0.6 : 0.95); p.vz = wz * (kind === 'petal' ? 0.6 : 0.95);
          p.vy = -rand(0.3, 0.7); p.life = rand(5, 9);
          p.s = kind === 'petal' ? rand(0.07, 0.13) : rand(0.08, 0.14);
          p.c = kind === 'petal' ? (Math.random() < 0.5 ? '#f5b5d9' : '#ec9fcb') : W.leaf[0];
        }
        p.t = 0; p.on = true; col(imMote, k, p.c);
      }
      p.t += dt;
      if (p.t > p.life) { p.on = false; hide(imMote, k); continue; }
      if (p.set > 0) {                                      // a settled flake shrinks away where it landed
        p.set -= dt;
        if (p.set <= 0) { p.on = false; hide(imMote, k); continue; }
        const s3 = p.s * clamp(p.set / 1.4, 0, 1);
        put(imMote, k, p.x, p.y, p.z, s3 * 1.6, s3 * 0.35, s3 * 1.6, 0);
        continue;
      }
      p.x += (p.vx + Math.sin(p.t * 2 + k) * 0.25) * dt;
      p.z += (p.vz + Math.cos(p.t * 1.7 + k) * 0.25) * dt;
      p.y += p.vy * dt;
      const gy = fn.heightAt(p.x, p.z);
      if (p.vy < 0 && p.y <= gy + 0.05) {
        if (p.k === 'snow') { p.y = gy + 0.04; p.set = 1.4; }   // a flake that lands stays a moment, then melts off
        else { p.on = false; hide(imMote, k); continue; }
      }
      const fade = clamp(Math.min(p.t, p.life - p.t) / 0.8, 0.15, 1), s4 = p.s * fade;
      put(imMote, k, p.x, p.y, p.z, s4, s4, s4, p.t * 1.4);
    }
    imMote.instanceMatrix.needsUpdate = true;
    if (imMote.instanceColor) imMote.instanceColor.needsUpdate = true;
  }

  function splash(x, z, scale) {
    RF.sfx.splash(0.07);
    for (const r of rings) {
      if (r.on) continue;
      r.on = true; r.t = 0; r.sc = scale || 1; r.m.position.set(x, WATER_Y + 0.05, z);
      r.m.scale.set(0.5 * r.sc, 1, 0.5 * r.sc); r.mat.opacity = 0.55; r.m.visible = true;
      return;
    }
  }

  /* ========================================================================
     5. THE CLOCK — one frame hook, everything else on a budget.
     ====================================================================== */
  const AMB_STEP = 1 / 25, MAP_STEP = 1 / 20;
  let ambAcc = 0, mapAcc = 0, slowAcc = 0;
  RF.on('frame', dt => {
    if (dt > 0.25) dt = 0.25;                               // a tab that slept must not teleport the wildlife
    ambAcc += dt;
    if (ambAcc >= AMB_STEP) { const step = ambAcc; ambAcc = 0; ambient(step); beaconTick(RF.clock); }
    if (AO) {
      mapAcc += dt;
      if (mapAcc >= MAP_STEP) { mapAcc = 0; drawAtlas(); }
      slowAcc += dt;
      if (slowAcc >= 0.25) { slowAcc = 0; railDist(); almanac(); if (RF.photoMode || RF.capCam) close(); }
    }
  });

  // the isle changes shape underfoot: a felled tree or a mined vein invalidates
  // nothing static, but the heat plates are density snapshots and must go stale
  const dirtyHeat = () => { heatCv[0] = null; heatCv[1] = null; };
  RF.on('mined', dirtyHeat); RF.on('chopped', dirtyHeat);

  RF.on('start', () => {
    if (DB.seen) return;
    DB.seen = 1; saveDB();
    setTimeout(() => say({ level: 'info', title: 'Atlas', body: 'Press M to chart the isle and plant marks', tag: 'world', ttl: 8000 }), 4000);
  });


  /* ========================================================================
     6. ATMOSPHERE — light, air, water and weather.

     Everything above populates the isle; everything below is the air around
     it. This runs in its own closure so its names can never collide with the
     atlas or the wildlife, and it deliberately owns nothing they own: no
     birds, no crabs, no motes — only the light they fly through.

       a. sun shafts raking the island, reddest when the sun is low
       b. a full-frame colour grade: a real dusk, a vignette that breathes
       c. fog that opens at noon and closes in a storm
       d. ground mist off the sea at first light and after rain
       e. foam breaking along every shoreline cell, downwind
       f. ripples: the bobber, raindrops, the surf, anything that touches water
       g. rain that lands — splashes on the ground, rings on the sea
       h. forked lightning that lights the world, and thunder that arrives late
       i. one wind vector, gusting, bending the grass in travelling waves
       j. a stovepipe on the trader's roof with smoke that leans as it climbs
       k. lantern halos after dark
       l. the moon laid out across the water, carved by its own phase
     ====================================================================== */
  (function () {
    const T = THREE, scene = RF.scene, cam = RF.camera, P = RF.pWorld;
    const WT = WATER_Y, CAVE = !!W.cave;
    const prefersReduce = (function(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }
      catch(e){ return false; } })();
    const reduce = () => prefersReduce || reduced();

    /* Placement rolls come off the world seed, not Math.random: the surf breaks
       on the same rocks and the mist banks sit in the same coves every session.
       Live rolls — a gust, a strike, a raindrop — still use Math.random. */
    const rr = fn.mulberry32(((((W.seed | 0) * 2654435761) | 0) ^ 0x5f3a) | 0);
    const rnd = (a, b) => a + rr() * (b - a);
    const rz = (a, b) => a + Math.random() * (b - a);

    /* ---- textures: soft alpha ramps, so linear filtering, not the block-crisp
       Nearest the terrain wants ------------------------------------------- */
    const tx = c => fn.toTex(c, { nearest: false });
    function radial(size, stops) {
      const c = fn.px(size), g = c.getContext('2d'), h = size / 2;
      const gr = g.createRadialGradient(h, h, 0, h, h, h);
      for (let k = 0; k < stops.length; k++) gr.addColorStop(stops[k][0], stops[k][1]);
      g.fillStyle = gr; g.fillRect(0, 0, size, size); return tx(c);
    }
    const TEX_PUFF = radial(64, [[0, 'rgba(255,255,255,.92)'], [.42, 'rgba(255,255,255,.40)'], [1, 'rgba(255,255,255,0)']]);
    const TEX_GLOW = radial(64, [[0, 'rgba(255,255,255,1)'], [.18, 'rgba(255,255,255,.62)'], [.55, 'rgba(255,255,255,.14)'], [1, 'rgba(255,255,255,0)']]);
    const TEX_RING = (function () {
      const c = fn.px(64), g = c.getContext('2d');
      // a ring, never a disc: bright at r=25 and gone by the edge, so it can only read as a wavefront
      for (let r = 1; r < 32; r++) {
        const a = Math.max(0, 1 - Math.abs(r - 25) / 7.5);
        g.strokeStyle = 'rgba(255,255,255,' + (a * a * 0.85).toFixed(3) + ')'; g.lineWidth = 1.6;
        g.beginPath(); g.arc(32, 32, r, 0, TAU); g.stroke();
      }
      return tx(c);
    })();
    const TEX_FOAM = (function () {
      const c = fn.px(64), g = c.getContext('2d');
      for (let k = 0; k < 80; k++) {
        const x = rnd(2, 62), y = rnd(2, 62), r = rnd(2, 9);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      return tx(c);
    })();
    const TEX_SHAFT = (function () {
      const c = fn.px(64), g = c.getContext('2d');
      const img = g.createImageData(64, 64), d = img.data;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const u = (x + 0.5) / 64, v = (y + 0.5) / 64;
        const ex = Math.pow(Math.sin(u * Math.PI), 1.7);              // soft across the beam's width
        const ey = Math.pow(Math.sin(v * Math.PI), 0.5) * (1 - v * 0.4); // fades at both ends, brightest sunward
        const o = (y * 64 + x) * 4; d[o] = d[o + 1] = d[o + 2] = 255;
        d[o + 3] = clamp(ex * ey, 0, 1) * 255;
      }
      g.putImageData(img, 0, 0); return tx(c);
    })();

    const flatQ = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);   // lies on water or ground
    const billQ = new T.PlaneGeometry(1, 1);                         // turned to face the camera
    const addMat = (tex, op) => new T.MeshBasicMaterial({ map: tex, transparent: true,
      opacity: op === undefined ? 1 : op, blending: T.AdditiveBlending, depthWrite: false });
    const softMat = (tex, c, op) => new T.MeshBasicMaterial({ map: tex, color: c, transparent: true,
      opacity: op, depthWrite: false });
    function inst(geo, mat, n, order) {
      const m = new T.InstancedMesh(geo, mat, n);
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
      m.renderOrder = order || 4; scene.add(m); return m;
    }

    /* ---- the map, read once: where the sea meets the land ---------------- */
    const surf = [];
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      if (HM[i][j] > 2) continue;
      if (HM[i + 1][j] >= 3 || HM[i - 1][j] >= 3 || HM[i][j + 1] >= 3 || HM[i][j - 1] >= 3)
        surf.push(i - HALF, j - HALF);
    }

    /* ---- quality: follows the comfort mod's body dataset, same as the
       wildlife above, with our own stored preference as the fallback ------- */
    const CAP = { high: { ray: 14, mist: 30, foam: 380, moon: 44, smoke: 30 },
                  med:  { ray: 8,  mist: 16, foam: 220, moon: 28, smoke: 20 },
                  low:  { ray: 0,  mist: 0,  foam: 0,   moon: 0,  smoke: 0 } };
    let forcedQ = null;
    const tier = () => { const q = forcedQ || quality(); return CAP[q] ? q : 'high'; };
    const flags = { rays: 1, grade: 1, mist: 1, foam: 1, ripples: 1, smoke: 1,
                    grassWind: 1, lightning: 1, night: 1 };

    /* --- a. sun shafts: one instanced quad per beam, all sharing the tilt the
       sun actually has this instant. depthTest stays on, so a beam dies where
       it meets the ground instead of painting over the island. ------------- */
    const RAY_N = 14;
    const rayMesh = inst(billQ, addMat(TEX_SHAFT, 0.55), RAY_N, 3);
    const rays = []; for (let k = 0; k < RAY_N; k++) rays.push({ off: rnd(-22, 22), sp: rnd(0.35, 0.95),
      w: rnd(1.1, 3.4), depth: rnd(-9, 9), ph: rnd(0, TAU), fl: rnd(0.13, 0.31) });

    /* --- d. ground mist: camera-facing banks just above the waterline that
       creep downwind and wrap around the player, so one never blinks in. --- */
    const MIST_N = 30;
    const mistMesh = inst(billQ, softMat(TEX_PUFF, 0xdfeef4, 0), MIST_N, 3);
    const mistP = []; for (let k = 0; k < MIST_N; k++) mistP.push({ x: rnd(-40, 40), z: rnd(-40, 40),
      y: rnd(-0.2, 1.4), w: rnd(9, 21), h: rnd(4.5, 9), ph: rnd(0, TAU), sp: rnd(0.5, 1.3) });

    /* --- e. foam: one quad per shoreline cell, driven by a wave phase that
       travels with the wind, so the whole beach breaks in one direction. --- */
    const FOAM_N = Math.min(380, surf.length >> 1);
    const foamMesh = FOAM_N ? inst(flatQ, addMat(TEX_FOAM, 0.55), FOAM_N, 5) : null;
    const foamP = [];
    if (FOAM_N) {
      const stride = Math.max(1, Math.floor((surf.length >> 1) / FOAM_N));
      for (let k = 0, c = 0; c < FOAM_N && k < surf.length; k += stride * 2, c++)
        foamP.push({ x: surf[k], z: surf[k + 1], s: rnd(1.5, 2.4), ph: rnd(0, TAU) });
    }

    /* --- f/g. ripples and rain impacts: two small pools. Everything in here
       that touches water goes through ripple(), so it all reads as one sea. */
    const RIP_N = 30;
    const ripMesh = inst(flatQ, addMat(TEX_RING, 0.9), RIP_N, 6);
    const rips = []; for (let k = 0; k < RIP_N; k++)
      rips.push({ life: 0, ttl: 1, x: 0, y: -99, z: 0, r0: 0.6, r1: 3, str: 1, r: .6, g: .9, b: 1 });
    let ripCur = 0;
    function ripple(x, z, size, str, colHex) {
      const p = rips[ripCur]; ripCur = (ripCur + 1) % RIP_N;
      const s = size || 1, c = colHex === undefined ? 0xbfeaff : colHex;
      p.x = x; p.z = z; p.y = WT + 0.06; p.life = p.ttl = 0.55 + s * 0.32;
      p.r0 = s * 0.5; p.r1 = s * 3.4; p.str = str === undefined ? 1 : str;
      p.r = (c >> 16 & 255) / 255; p.g = (c >> 8 & 255) / 255; p.b = (c & 255) / 255;
    }
    const IMP_N = 64;
    const impMesh = inst(flatQ, addMat(TEX_PUFF, 0.5), IMP_N, 6);
    const imps = []; for (let k = 0; k < IMP_N; k++) imps.push({ life: 0, ttl: 1, x: 0, y: -99, z: 0, s: 0.3 });
    let impCur = 0, impAcc = 0;
    function impSpawn(x, y, z, s, ttl) {
      const p = imps[impCur]; impCur = (impCur + 1) % IMP_N;
      p.x = x; p.y = y; p.z = z; p.s = s; p.life = p.ttl = ttl || 0.34;
    }

    /* --- j. smoke: a stovepipe on the trader's roof and, on Cinder Atoll, a
       second lazy column off the summit. Both lean harder the higher they get. */
    const SMOKE_N = 30;
    const smokeMesh = inst(billQ, addMat(TEX_PUFF, 0.42), SMOKE_N, 3);
    const smokeP = [], vents = [];
    if (RF.TRADER_POS) {
      const tp = RF.TRADER_POS;
      vents.push({ x: tp.x + 1.15, y: tp.y + 3.35, z: tp.z - 1.25, rate: 0.62, col: 0xd8dee0, rise: 1.05, grow: 1.5 });
      const pipe = new T.Mesh(new T.BoxGeometry(0.22, 1.0, 0.22), new T.MeshLambertMaterial({ color: 0x36302c }));
      pipe.position.set(tp.x + 1.15, tp.y + 3.0, tp.z - 1.25); pipe.castShadow = true; scene.add(pipe);
      const cap = new T.Mesh(new T.BoxGeometry(0.34, 0.12, 0.34), new T.MeshLambertMaterial({ color: 0x4a423c }));
      cap.position.set(tp.x + 1.15, tp.y + 3.56, tp.z - 1.25); scene.add(cap);
    }
    if (WK === 'volcano') {                 // the crater sits on the summit, and the summit is the tallest cell
      let bi = 1, bj = 1, bh = -1;
      for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) if (HM[i][j] > bh) { bh = HM[i][j]; bi = i; bj = j; }
      vents.push({ x: bi - HALF, y: bh + 1.2, z: bj - HALF, rate: 0.5, col: 0x8f7a70, rise: 1.5, grow: 3.2 });
    }
    for (let k = 0; k < SMOKE_N; k++) smokeP.push({ life: 0, ttl: 1, x: 0, y: -99, z: 0, v: null, ph: rnd(0, TAU) });
    let smokeCur = 0, smokeAcc = 0;

    /* --- k/l. night: a halo on every lamp the engine built, and a glitter path
       running out under the moon. ----------------------------------------- */
    const lampPts = []; {
      const v = new T.Vector3(), L = RF.lamps || [];
      for (let k = 0; k < L.length && lampPts.length < 64; k++) {
        try { L[k].getWorldPosition(v); lampPts.push({ x: v.x, y: v.y, z: v.z, ph: rnd(0, TAU), s: rnd(1.5, 2.6) }); }
        catch (e) {}
      }
    }
    const lampMesh = lampPts.length ? inst(billQ, addMat(TEX_GLOW, 0.85), lampPts.length, 3) : null;
    const MOON_N = 44;
    const moonMesh = inst(flatQ, addMat(TEX_GLOW, 0.9), MOON_N, 5);
    const moonP = []; for (let k = 0; k < MOON_N; k++)
      moonP.push({ t: rnd(0.04, 1), lat: rnd(-1, 1), ph: rnd(0, TAU), s: rnd(0.5, 1.5) });

    /* --- b. the grade: four fixed layers between the canvas and the HUD.
       Colours are lerped in JS and written at 8Hz — nothing animates in CSS,
       so a slow machine pays nothing for the look. ------------------------- */
    RF.css(`
#w-grade,#w-vig,#w-flash,#w-bolt{position:fixed;inset:0;pointer-events:none;}
#w-grade,#w-vig{z-index:3;}
#w-flash{z-index:4;background:#e8f4ff;opacity:0;}
#w-bolt{z-index:4;width:100%;height:100%;opacity:0;}
@media (prefers-reduced-motion: reduce){ #w-bolt{display:none;} }
`, '04-world-atmos-css');
    const gradeEl = RF.el('<div id="w-grade"></div>');
    const vigEl   = RF.el('<div id="w-vig"></div>');
    const flashEl = RF.el('<div id="w-flash"></div>');
    const boltEl  = RF.el('<canvas id="w-bolt" width="640" height="360"></canvas>');
    const boltX   = boltEl && boltEl.getContext ? boltEl.getContext('2d') : null;

    /* --- i. wind: the one vector everything else asks. Two slow sines beating
       against each other wander without repeating; gusts spike and decay. -- */
    const wind = { a: 0, x: 1, z: 0, s: 0.3, gust: 0 };
    let gustSfx = 0;

    /* Grass: the engine writes every tuft matrix from its own sway, and this
       hook runs after it — so we re-write them with that sway PLUS a lean that
       travels downwind as a wave. The base layout is read on the first frame,
       because at mod-load time the engine has not written a matrix yet and they
       are all still identity. */
    let tuftMesh = null, tuftPos = null, tuftPh = null, tuftScl = null;
    for (let k = 0; k < scene.children.length; k++) {
      const o = scene.children[k];
      if (o && o.isInstancedMesh && o.material && o.material.map === RF.TEX.blade) { tuftMesh = o; break; }
    }

    /* --- h. storm strikes: the flash is real light — sun, hemisphere, ambient
       and fog — stacked on after the engine's sky pass has already written
       them, so it lands on this frame and is gone by the next. ------------- */
    let strikeT = rz(6, 16), flash = 0, boltT = 0;
    function drawBolt(near) {
      if (!boltX || reduce()) return;
      const VW = 640, VH = 360; boltX.clearRect(0, 0, VW, VH);
      let x = rz(VW * 0.12, VW * 0.88), y = 0;
      const endY = VH * (near ? 0.62 : 0.44), seg = near ? 12 : 9, pts = [[x, y]];
      for (let k = 1; k <= seg; k++) { y = endY * k / seg; x += rz(-38, 38); pts.push([x, y]); }
      const stroke = (w2, a) => {
        boltX.strokeStyle = 'rgba(226,242,255,' + a + ')'; boltX.lineWidth = w2; boltX.lineJoin = 'round';
        boltX.beginPath(); boltX.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) boltX.lineTo(pts[k][0], pts[k][1]);
        boltX.stroke();
      };
      boltX.shadowColor = 'rgba(150,205,255,.9)'; boltX.shadowBlur = near ? 26 : 14;
      stroke(near ? 7 : 4, 0.35); boltX.shadowBlur = 0; stroke(near ? 2.4 : 1.4, 0.95);
      // one or two forks peeling off partway down — an unbranched line reads as a scratch
      for (let f = 0; f < (near ? 2 : 1); f++) {
        const i = 2 + ((Math.random() * (seg - 3)) | 0);
        let fx = pts[i][0], fy = pts[i][1];
        boltX.strokeStyle = 'rgba(214,236,255,.7)'; boltX.lineWidth = near ? 1.6 : 1;
        boltX.beginPath(); boltX.moveTo(fx, fy);
        for (let k = 0; k < 4; k++) { fx += rz(-34, 34); fy += rz(16, 34); boltX.lineTo(fx, fy); }
        boltX.stroke();
      }
      boltT = near ? 0.13 : 0.09;
    }
    function strike(force) {
      const near = force === true || Math.random() < 0.34;
      flash = Math.max(flash, near ? 1 : 0.5);
      drawBolt(near);
      if (RF.running) {
        const delay = (near ? rz(60, 340) : rz(900, 3400)) | 0;
        setTimeout(() => { try { (near ? RF.sfx.thunder : RF.sfx.rumble)(); } catch (e) {} }, delay);
        if (near) fn.addShake(0.22);
      }
    }

    /* ---- reactions -------------------------------------------------------- */
    let lastCast = 'idle', wetness = 0, mistAmt = 0;
    RF.on('catch', () => { const b = RF.bobber;
      if (b && b.visible) ripple(b.position.x, b.position.z, 1.8, 1.3, 0xd9f6ff); });
    RF.on('mined', e => {                     // dust hangs where the pick landed
      if (!flags.ripples) return;
      const n = e && e.node; if (!n || typeof n.x !== 'number') return;
      impSpawn(n.x, n.y + 0.65, n.z, 0.55, 0.4);
    });
    RF.on('weather', (w2, prev) => {
      if (w2 === 'storm') strikeT = rz(2.5, 7);
      if (prev === 'rain' || prev === 'storm') wetness = 1;   // wet ground steams for a good while after
    });

    /* ---- per-frame state: every temporary hoisted, the hook allocates none - */
    const q1 = new T.Object3D(), q2 = new T.Object3D(), mtA = new T.Matrix4();
    const vUp = new T.Vector3(), vFwd = new T.Vector3(), vRight = new T.Vector3(), vDir = new T.Vector3();
    const basis = new T.Matrix4(), qRay = new T.Quaternion(), camQ = new T.Quaternion();
    const cTmp = new T.Color(), cHaze = new T.Color(0xffa464), cI = new T.Color(), cWat = new T.Color(W.water);
    const AMB0 = RF.ambL ? RF.ambL.intensity : 0.16;
    let gradeAcc = 1, fogNear = scene.fog ? scene.fog.near : 150, fogFar = scene.fog ? scene.fog.far : 255;
    let colorTick = 0;

    function sunState() {   // the same arc the engine's sky pass walks, so the beams agree with the disc
      const dayFrac = (RF.dayT - 0.12) / 0.64;
      if (dayFrac < 0 || dayFrac > 1) return null;
      const a = dayFrac * Math.PI;
      return { x: -Math.cos(a), y: Math.sin(a), frac: dayFrac };
    }
    const moonFull = () => Math.abs(Math.cos(((Math.floor(RF.dayCount) % 8) / 8) * TAU));
    function weatherDim() {
      const w2 = RF.weather;
      return w2 === 'storm' ? 0.1 : w2 === 'rain' ? 0.26 : w2 === 'snow' ? 0.5 : w2 === 'ash' ? 0.55 : 1;
    }

    /* =====================================================================
       THE FRAME — this runs after the engine's own sky, water and grass
       passes, so whatever it writes is the last word before the render.
       ===================================================================== */
    RF.on('frame', (dtRaw, rdt) => {
      const dt = dtRaw > 0.05 ? 0.05 : dtRaw, t = RF.clock;
      const WX = RF.weather, night = fn.isNight(), wet = WX === 'rain' || WX === 'storm';
      const cap = CAP[tier()], soft = reduce();

      /* --- wind ---------------------------------------------------------- */
      wind.a = Math.sin(t * 0.037) * 1.7 + Math.sin(t * 0.0113 + 2.1) * 1.1;
      wind.gust *= Math.exp(-dt * 0.85);
      const gustOdds = (WX === 'storm' ? 0.55 : WX === 'rain' ? 0.22 : 0.13) * (soft ? 0.35 : 1);
      if (Math.random() < dt * gustOdds) wind.gust += rz(0.2, 0.85) * (soft ? 0.4 : 1);
      wind.s = (WX === 'storm' ? 0.95 : WX === 'rain' ? 0.6 : WX === 'snow' ? 0.42 : CAVE ? 0.08 : 0.3) + wind.gust;
      wind.x = Math.cos(wind.a); wind.z = Math.sin(wind.a);
      gustSfx -= dt;
      if (wind.gust > 0.72 && gustSfx <= 0 && RF.running && !CAVE) {
        gustSfx = rz(22, 50); try { RF.sfx.gust(); } catch (e) {}
      }

      /* --- wetness: rain soaks the ground, then it steams off over a minute */
      wetness = wet ? Math.min(1, wetness + dt * 0.16) : Math.max(0, wetness - dt * 0.011);

      /* --- h. lightning: stacked on top of whatever the sky pass just wrote  */
      if (flags.lightning && WX === 'storm' && RF.running && !CAVE) {
        strikeT -= dt;
        if (strikeT <= 0) { strikeT = rz(5, 17); strike(); }
      }
      if (flash > 0.001) {
        flash *= Math.exp(-dt * 11);
        RF.sun.intensity += flash * 2.4;
        RF.hemiL.intensity += flash * 1.3;
        if (RF.ambL) RF.ambL.intensity = AMB0 + flash * 0.5;
        if (scene.fog) scene.fog.color.lerp(cTmp.setRGB(0.88, 0.94, 1), flash * 0.5);
        if (flashEl) flashEl.style.opacity = (flash * (soft ? 0.08 : 0.42)).toFixed(3);
      } else if (flash !== 0) {
        flash = 0;
        if (RF.ambL) RF.ambL.intensity = AMB0;
        if (flashEl) flashEl.style.opacity = '0';
      }
      if (boltT > 0) {
        boltT -= dt;
        if (boltT <= 0) { if (boltEl) boltEl.style.opacity = '0'; if (boltX) boltX.clearRect(0, 0, 640, 360); }
        else if (boltEl && boltEl.style.opacity !== '1') boltEl.style.opacity = '1';
      }

      /* --- c. fog that breathes: a storm closes the horizon, noon opens it - */
      if (scene.fog) {
        const tgtN = CAVE ? 92 : WX === 'storm' ? 100 : wet ? 118 : night ? 126 : WX === 'snow' ? 112 : 178;
        const tgtF = CAVE ? 185 : WX === 'storm' ? 186 : wet ? 214 : night ? 226 : 300;
        const kf = 1 - Math.exp(-dt * 0.55);
        fogNear = lerp(fogNear, tgtN, kf); fogFar = lerp(fogFar, tgtF, kf);
        scene.fog.near = fogNear; scene.fog.far = fogFar;
        // let the far sea bleed into the haze, so the horizon reads as water and not as a wall
        if (!CAVE) scene.fog.color.lerp(cWat, 0.13);
      }

      camQ.copy(cam.quaternion);
      const sun = CAVE ? null : sunState();
      colorTick = (colorTick + 1) & 1;   // half-rate colour uploads: invisible, and it halves the bus traffic

      /* --- a. sun shafts -------------------------------------------------- */
      { const n = (flags.rays && sun) ? Math.min(RAY_N, cap.ray) : 0;
        rayMesh.count = n; rayMesh.visible = n > 0;
        if (n) {
          const low = 1 - Math.min(1, Math.abs(sun.y) * 1.35);      // 0 at noon, 1 on the horizon
          const str = (0.085 + 0.34 * low * low) * weatherDim() * (soft ? 0.6 : 1);
          vUp.set(-sun.x * 0.75, Math.max(0.16, sun.y), 0.42).normalize();   // points at the sun
          cam.getWorldDirection(vFwd); vFwd.negate();
          vRight.crossVectors(vUp, vFwd);
          if (vRight.lengthSq() > 1e-6) {
            vRight.normalize(); vFwd.crossVectors(vRight, vUp).normalize();
            basis.makeBasis(vRight, vUp, vFwd); qRay.setFromRotationMatrix(basis);
          }
          cTmp.setHex(0xfff4d8).lerp(cHaze, low * 0.75);
          const cy = 6 + 10 * vUp.y;
          for (let k = 0; k < n; k++) {
            const r = rays[k];
            r.off += dt * r.sp * (1 + wind.s * 0.8);
            if (r.off > 22) r.off -= 44;
            const flick = 0.55 + 0.45 * Math.sin(t * 0.31 + r.ph) * Math.sin(t * 0.13 + r.ph * 1.7);
            q1.position.set(P.x, 0, P.z).addScaledVector(vRight, r.off).addScaledVector(vFwd, r.depth);
            q1.position.y = cy;
            q1.quaternion.copy(qRay); q1.scale.set(r.w, 44, 1);
            q1.updateMatrix(); rayMesh.setMatrixAt(k, q1.matrix);
            rayMesh.setColorAt(k, cI.copy(cTmp).multiplyScalar(str * r.fl * Math.max(0, flick) * 2.6));
          }
          rayMesh.instanceMatrix.needsUpdate = true;
          if (rayMesh.instanceColor) rayMesh.instanceColor.needsUpdate = true;
        } }

      /* --- d. ground mist -------------------------------------------------- */
      { const n = flags.mist ? Math.min(MIST_N, cap.mist) : 0;
        // dawn and dusk make it, rain leaves it behind, cold water keeps it after dark
        const dawn = sun ? Math.max(0, 1 - Math.abs(sun.frac - 0.06) * 9) + Math.max(0, 1 - Math.abs(sun.frac - 0.94) * 9) : 0;
        const tgt = clamp(dawn * 0.5 + wetness * 0.45 + (night ? 0.16 : 0) + (WK === 'frost' ? 0.18 : 0) + (CAVE ? 0.3 : 0), 0, 0.62);
        mistAmt = lerp(mistAmt, tgt, 1 - Math.exp(-dt * 0.5));
        mistMesh.count = n;
        mistMesh.material.opacity = mistAmt * 0.72;
        mistMesh.visible = n > 0 && mistAmt > 0.012;
        if (mistMesh.visible) {
          for (let k = 0; k < n; k++) {
            const m = mistP[k];
            m.x += wind.x * wind.s * m.sp * dt * 2.4; m.z += wind.z * wind.s * m.sp * dt * 2.4;
            const dx = m.x - P.x, dz = m.z - P.z;      // wrap, never respawn: a bank must not blink
            if (dx > 44) m.x -= 88; else if (dx < -44) m.x += 88;
            if (dz > 44) m.z -= 88; else if (dz < -44) m.z += 88;
            q1.position.set(m.x, WT + 0.35 + m.y + Math.sin(t * 0.24 + m.ph) * 0.25, m.z);
            q1.quaternion.copy(camQ);
            q1.scale.set(m.w * (1 + Math.sin(t * 0.17 + m.ph) * 0.07), m.h, 1);
            q1.updateMatrix(); mistMesh.setMatrixAt(k, q1.matrix);
          }
          mistMesh.instanceMatrix.needsUpdate = true;
        } }

      /* --- e. foam, and after dark the bioluminescence in it --------------- */
      if (foamMesh) {
        const n = flags.foam ? Math.min(foamP.length, cap.foam) : 0;
        foamMesh.count = n; foamMesh.visible = n > 0;
        if (n) {
          const bio = (flags.night && night && !CAVE) ? 1 : 0;
          const swell = 0.55 + wind.s * 0.5 + (WX === 'storm' ? 0.5 : 0);
          for (let k = 0; k < n; k++) {
            const f = foamP[k];
            // the break travels downwind across the beach instead of every cell pulsing at once
            const a = Math.max(0, Math.sin((f.x * wind.x + f.z * wind.z) * 0.5 - t * 1.35 + f.ph)) * swell;
            q1.position.set(f.x, WT + 0.055, f.z);
            q1.rotation.set(0, f.ph, 0);
            const s = f.s * (0.62 + a * 0.55);
            q1.scale.set(s, 1, s);
            q1.updateMatrix(); foamMesh.setMatrixAt(k, q1.matrix);
            if (!colorTick) {
              const b = a * 0.9 + 0.06;
              if (bio) cI.setRGB(b * 0.28, b, b * 0.94); else cI.setRGB(b, b, b);
              foamMesh.setColorAt(k, cI);
            }
          }
          foamMesh.instanceMatrix.needsUpdate = true;
          if (!colorTick && foamMesh.instanceColor) foamMesh.instanceColor.needsUpdate = true;
          if (bio && Math.random() < dt * 1.6) { const f = foamP[(Math.random() * n) | 0]; ripple(f.x, f.z, 0.7, 0.5, 0x39d7c4); }
        }
      }

      /* --- f. ripples ------------------------------------------------------ */
      { let live = false;
        for (let k = 0; k < RIP_N; k++) {
          const p = rips[k];
          if (p.life > 0) {
            live = true; p.life -= dt;
            const u = 1 - Math.max(0, p.life) / p.ttl;
            const s = lerp(p.r0, p.r1, u * u * 0.6 + u * 0.4), b = (1 - u) * (1 - u) * p.str;
            q1.position.set(p.x, p.y, p.z); q1.rotation.set(0, 0, 0); q1.scale.set(s, 1, s);
            cI.setRGB(p.r * b, p.g * b, p.b * b);
          } else {
            q1.position.set(0, -99, 0); q1.rotation.set(0, 0, 0); q1.scale.set(0.0001, 0.0001, 0.0001);
            cI.setRGB(0, 0, 0);
          }
          q1.updateMatrix(); ripMesh.setMatrixAt(k, q1.matrix); ripMesh.setColorAt(k, cI);
        }
        ripMesh.instanceMatrix.needsUpdate = true;
        if (ripMesh.instanceColor) ripMesh.instanceColor.needsUpdate = true;
        ripMesh.visible = live && !!flags.ripples; }

      /* --- g. rain that lands: splashes on the ground, rings on the water -- */
      { if (flags.ripples && wet && !CAVE) {
          impAcc += dt * (WX === 'storm' ? 52 : 28);
          while (impAcc >= 1) {
            impAcc -= 1;
            const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * 15;
            const x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
            if (fn.isWaterAt(x, z)) { if (Math.random() < 0.35) ripple(x, z, 0.45, 0.5); }
            else impSpawn(x, fn.heightAt(x, z) + 0.06, z, rz(0.22, 0.42), rz(0.22, 0.4));
          }
        } else impAcc = 0;
        let live = false;
        for (let k = 0; k < IMP_N; k++) {
          const p = imps[k];
          if (p.life > 0) {
            live = true; p.life -= dt;
            const u = 1 - p.life / p.ttl, s = p.s * (0.5 + u * 1.3);
            q1.position.set(p.x, p.y, p.z); q1.rotation.set(0, 0, 0); q1.scale.set(s, 1, s);
          } else { q1.position.set(0, -99, 0); q1.rotation.set(0, 0, 0); q1.scale.set(0.0001, 0.0001, 0.0001); }
          q1.updateMatrix(); impMesh.setMatrixAt(k, q1.matrix);
        }
        impMesh.instanceMatrix.needsUpdate = true; impMesh.visible = live; }

      /* --- the bobber's own splash, read off the fishing state machine ----- */
      if (RF.fishing) {
        const st = RF.fishing.state, b = RF.bobber;
        if (lastCast === 'cast' && st === 'wait' && b) ripple(b.position.x, b.position.z, 1.2, 1, 0xd9f6ff);
        if (st === 'bite' && b && Math.random() < dt * 6) ripple(b.position.x, b.position.z, 0.5, 0.6);
        lastCast = st;
      }

      /* --- j. smoke -------------------------------------------------------- */
      if (vents.length) {
        const n = flags.smoke ? Math.min(SMOKE_N, cap.smoke) : 0;
        smokeMesh.count = n; smokeMesh.visible = n > 0;
        if (n) {
          if (smokeCur >= n) smokeCur = 0;
          smokeAcc += dt * (night ? 2.6 : 1.9);
          while (smokeAcc >= 1) {
            smokeAcc -= 1;
            const v = vents[(Math.random() * vents.length) | 0];
            if (Math.random() > v.rate) continue;
            const p = smokeP[smokeCur]; smokeCur = (smokeCur + 1) % n;
            p.v = v; p.life = p.ttl = rz(3.2, 5.4); p.ph = Math.random() * TAU;
            p.x = v.x + rz(-0.1, 0.1); p.y = v.y; p.z = v.z + rz(-0.1, 0.1);
          }
          for (let k = 0; k < n; k++) {
            const p = smokeP[k];
            if (p.life > 0 && p.v) {
              p.life -= dt;
              const u = 1 - p.life / p.ttl;
              p.y += dt * p.v.rise * (0.6 + u);
              p.x += wind.x * wind.s * dt * (0.7 + u * 3.4);   // the higher it climbs, the harder the wind has it
              p.z += wind.z * wind.s * dt * (0.7 + u * 3.4);
              const s = 0.55 + u * p.v.grow;
              q1.position.set(p.x + Math.sin(u * 4 + p.ph) * 0.16, p.y, p.z + Math.cos(u * 3.4 + p.ph) * 0.16);
              q1.quaternion.copy(camQ); q1.scale.set(s, s, 1);
              if (!colorTick) smokeMesh.setColorAt(k, cI.setHex(p.v.col).multiplyScalar(Math.min(1, u * 4) * (1 - u) * (1 - u)));
            } else {
              q1.position.set(0, -99, 0); q1.quaternion.set(0, 0, 0, 1); q1.scale.set(0.0001, 0.0001, 0.0001);
              if (!colorTick) smokeMesh.setColorAt(k, cI.setRGB(0, 0, 0));
            }
            q1.updateMatrix(); smokeMesh.setMatrixAt(k, q1.matrix);
          }
          smokeMesh.instanceMatrix.needsUpdate = true;
          if (!colorTick && smokeMesh.instanceColor) smokeMesh.instanceColor.needsUpdate = true;
        }
      }

      /* --- k. lantern halos ------------------------------------------------ */
      if (lampMesh) {
        lampMesh.visible = !!flags.night && tier() !== 'low' && (CAVE || night);
        if (lampMesh.visible) {
          for (let k = 0; k < lampPts.length; k++) {
            const L = lampPts[k], pulse = 0.9 + Math.sin(t * 3 + L.ph) * 0.09;
            q1.position.set(L.x, L.y, L.z); q1.quaternion.copy(camQ);
            q1.scale.set(L.s * pulse, L.s * pulse, 1); q1.updateMatrix();
            lampMesh.setMatrixAt(k, q1.matrix);
            lampMesh.setColorAt(k, cI.setRGB(0.62, 0.45, 0.17).multiplyScalar(pulse));
          }
          lampMesh.instanceMatrix.needsUpdate = true;
          if (lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate = true;
        }
      }

      /* --- l. the moon laid out on the water ------------------------------- */
      { const n = flags.night ? Math.min(MOON_N, cap.moon) : 0;
        const moonLit = (!CAVE && night) ? moonFull() * weatherDim() : 0;
        moonMesh.count = n; moonMesh.visible = n > 0 && moonLit > 0.05;
        if (moonMesh.visible) {
          // the moon walks the sun's arc half a day out of phase — borrow that azimuth and flip it
          const ma = ((RF.dayT - 0.12) / 0.64 + 0.5) * Math.PI;
          vDir.set(-Math.cos(ma) * 0.75, 0, 0.42).normalize();
          const pxr = -vDir.z, pzr = vDir.x;
          for (let k = 0; k < n; k++) {
            const m = moonP[k], dist = 4 + m.t * 52, spread = 1.4 + m.t * 9;
            const x = P.x + vDir.x * dist + pxr * m.lat * spread, z = P.z + vDir.z * dist + pzr * m.lat * spread;
            const over = fn.isWaterAt(x, z) ? 1 : 0;
            const s = m.s * (1.1 + m.t * 2.4) * (over ? 1 : 0.0001);
            q1.position.set(x, WT + 0.05, z); q1.rotation.set(0, 0, 0); q1.scale.set(s, 1, s * 0.55);
            q1.updateMatrix(); moonMesh.setMatrixAt(k, q1.matrix);
            const b = over * moonLit * 0.5 * (0.3 + 0.7 * Math.pow(Math.max(0, Math.sin(t * 2.2 + m.ph * 5)), 2));
            moonMesh.setColorAt(k, cI.setRGB(b * 0.78, b * 0.86, b));
          }
          moonMesh.instanceMatrix.needsUpdate = true;
          if (moonMesh.instanceColor) moonMesh.instanceColor.needsUpdate = true;
        } }

      /* --- i. grass in the wind -------------------------------------------- */
      if (tuftMesh && flags.grassWind) {
        if (!tuftPos) {
          const cnt = tuftMesh.count | 0;
          if (cnt > 0) {
            const pos = new Float32Array(cnt * 3), phs = new Float32Array(cnt), scl = new Float32Array(cnt);
            let written = false;
            for (let k = 0; k < cnt; k++) {
              tuftMesh.getMatrixAt(k, mtA); const e = mtA.elements;
              pos[k * 3] = e[12]; pos[k * 3 + 1] = e[13]; pos[k * 3 + 2] = e[14];
              scl[k] = Math.hypot(e[0], e[1], e[2]) || 1;
              phs[k] = ((e[12] * 12.9898 + e[14] * 78.233) % TAU + TAU) % TAU;
              if (e[13] !== 0) written = true;
            }
            // still identity means the engine's first animGrass has not landed — look again next frame
            if (written) { tuftPos = pos; tuftPh = phs; tuftScl = scl; }
          } else tuftMesh = null;
        }
        if (tuftPos) {
          const cnt = tuftMesh.count | 0, lean = Math.min(0.62, wind.s * 0.44);
          for (let k = 0; k < cnt; k++) {
            const gx = tuftPos[k * 3], gz = tuftPos[k * 3 + 2], ph = tuftPh[k];
            // a gust wave travelling downwind: you watch the wind arrive before it reaches you
            const L = lean * (0.65 + 0.5 * Math.sin((gx * wind.x + gz * wind.z) * 0.34 - t * 2.3));
            q1.position.set(gx, tuftPos[k * 3 + 1], gz);
            q1.rotation.set(Math.cos(t * 1.1 + ph) * 0.10 + wind.z * L, ph, Math.sin(t * 1.6 + ph) * 0.18 - wind.x * L);
            q1.scale.setScalar(tuftScl[k]);
            q1.updateMatrix(); tuftMesh.setMatrixAt(k, q1.matrix);
          }
          tuftMesh.instanceMatrix.needsUpdate = true;
        }
      }

      /* --- b. the grade, at 8Hz -------------------------------------------- */
      gradeAcc += dt;
      if (flags.grade && gradeAcc > 0.125) {
        gradeAcc = 0;
        let r, g, b, a;
        if (CAVE) { r = 8; g = 14; b = 26; a = 0.34; }
        else {
          const dT = RF.dayT;
          // night → dawn → open day → dusk → night, keyed off the engine's own day curve
          const nightAmt = clamp(dT < 0.12 ? 1 - dT / 0.12 * 0.7 : dT > 0.76 ? (dT - 0.76) / 0.24 * 0.7 + 0.3 : 0, 0, 1);
          const goldAmt = Math.max(0, 1 - Math.abs(dT - 0.14) * 11) + Math.max(0, 1 - Math.abs(dT - 0.72) * 11);
          r = 26; g = 40; b = 84; a = nightAmt * 0.30;
          if (goldAmt > 0) {
            const kk = goldAmt / (goldAmt + a * 3 + 0.001);
            r = lerp(r, 255, kk); g = lerp(g, 150, kk); b = lerp(b, 86, kk); a = Math.max(a, goldAmt * 0.19);
          }
          if (WX === 'rain') { r = lerp(r, 104, .6); g = lerp(g, 130, .6); b = lerp(b, 142, .6); a = Math.max(a, 0.16); }
          else if (WX === 'storm') { r = lerp(r, 58, .7); g = lerp(g, 74, .7); b = lerp(b, 90, .7); a = Math.max(a, 0.25); }
          else if (WX === 'snow') { r = lerp(r, 206, .7); g = lerp(g, 230, .7); b = lerp(b, 242, .7); a = Math.max(a, 0.13); }
          else if (WX === 'ash') { r = lerp(r, 132, .7); g = lerp(g, 76, .7); b = lerp(b, 52, .7); a = Math.max(a, 0.21); }
          a += mistAmt * 0.10;
        }
        gradeEl.style.backgroundColor = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')';
        // the vignette closes in at night and in weather, and opens back up at noon
        const vg = clamp(0.18 + (CAVE ? 0.4 : 0) + (night ? 0.24 : 0) + (WX === 'storm' ? 0.24 : wet ? 0.12 : 0), 0, 0.72);
        vigEl.style.background = 'radial-gradient(120% 96% at 50% 44%,rgba(0,0,0,0) 52%,rgba(3,10,12,' + vg.toFixed(3) + ') 100%)';
      }
    });

    /* ---- the surface the comfort mod turns, and anyone can fire ---------- */
    RF.world = {
      wind: wind, flags: flags, ripple: ripple, strike: strike,
      get quality() { return tier(); },
      get wetness() { return wetness; },
      get mist() { return mistAmt; },
      setQuality(q) { if (!CAP[q]) return false; forcedQ = q; return true; },
      set(k, v) { if (Object.prototype.hasOwnProperty.call(flags, k)) { flags[k] = v ? 1 : 0; return true; } return false; },
      toggles: ['rays', 'grade', 'mist', 'foam', 'ripples', 'smoke', 'grassWind', 'lightning', 'night']
    };
  })();

  RF.api.atlas = { open: open, close: close, toggle: () => (AO ? close() : open()), isOpen: () => AO };
});
