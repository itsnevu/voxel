/* ============================================================================
   07-JUICE — game feel. No new systems, no economy, no data: every line here
   is feedback on something the game already did, made to land harder.

   A. Floating values projected out of the 3D world onto a pooled DOM layer.
   B. Catch and sell streaks in one compact meter; the ore vein rides the float.
   C. Rarity landing: an edge bloom in the rarity colour, a split vignette pulse,
      and core's own hit-stop for epic and legendary.
   D. World feedback: ripple rings, boot dust, pick sparks, a leaf fall, and a
      fish that shows itself while you wait on the line.
   E. Transitions: a swept wipe and a wind card on weather, a wash and two notes
      at dawn and dusk.
   F. The coin and pearl counters roll instead of snapping — with a back-off so
      that if another mod is already rolling them, this one gets out of the way.
   G. The feel layer (its own closure, section G): a positional ambient bed, an
      adaptive score layer, a real mix bus with duck/muffle/limiter, sfx
      variation, in-key stings, a camera that punches/drifts/leans/settles,
      directional shake on a budget, and a sub-60ms answer to every press.

   Everything is off under body.rf-reduced, budgeted by body.dataset.rfQuality
   (low spawns nothing decorative), hidden under body.photo, and killable in one
   call through RF.api.juice.set(false).
   ========================================================================== */
RF.mod('07-juice', function (RF) {
  'use strict';

  const T = RF.THREE, fn = RF.fn, B = document.body;
  const clamp = fn.clamp, lerp = fn.lerp, rand = fn.rand, fmt = fn.fmt;
  const RAR = RF.RAR || {}, RORDER = RF.RORDER || {}, ORE = RF.ORE_INFO || {};
  const TAU = RF.TAU || Math.PI * 2;
  const byId = function (id) { return document.getElementById(id); };
  const pix = function (n, s) { return (RF.PIX && RF.PIX[n]) ? fn.pixSVG(n, s) : ''; };
  /* Our own clock, advanced from the frame hook. RF.clock is the world's and is
     scaled down through hit-stop; the feedback layer must keep wall-ish time so a
     freeze frame cannot stretch a streak window or stack two floats on top of
     each other. */
  let jt = 0;
  const now = function () { return jt; };

  /* The three switches every effect asks before it spends anything. `enabled`
     is ours (10-comfort flips it), reduced and quality are ambient signals we
     only ever read. Quality 'low' means literally zero decorative spawns —
     the numbers and the meter survive because they are information, not confetti. */
  let enabled = true;
  try { const s = RF.store.get('juice', null); if (s && typeof s.on === 'boolean') enabled = s.on; }
  catch (e) { RF.warn('juice:load', e); }

  const reduced = function () { return B.classList.contains('rf-reduced'); };
  const live = function () { return enabled && !reduced(); };
  const QB = { low: 0, med: 0.55, high: 1, ultra: 1.4 };
  const budget = function () { const q = QB[B.dataset.rfQuality]; return q === undefined ? 1 : q; };
  const spawns = function () { return live() && budget() > 0; };
  const photo = function () { return B.classList.contains('photo'); };

  /* ==========================================================================
     1. LOOK — one stylesheet, five layers, all pointer-transparent.
     z3/z4 sit above the world and below the HUD, which is where 04-world's
     grade already lives; z26 is the float layer (over a panel, under a tooltip);
     z27/z28 are the card and the meter.
     ========================================================================== */
  RF.css(`
  #rf-juice-floats,#rf-juice-edge,#rf-juice-wash,#rf-juice-wipe{position:fixed;inset:0;pointer-events:none;}
  #rf-juice-edge,#rf-juice-wash{z-index:4;}
  #rf-juice-wipe{z-index:4;overflow:hidden;}
  #rf-juice-floats{z-index:26;contain:layout style;}

  /* A · floating values ---------------------------------------------------- */
  .rf-juice-f{position:absolute;left:0;top:0;will-change:transform,opacity;opacity:0;
    font-family:"Chakra Petch",sans-serif;font-weight:700;font-variant-numeric:tabular-nums;
    letter-spacing:.01em;white-space:nowrap;line-height:1;
    display:flex;align-items:center;gap:5px;
    text-shadow:0 2px 9px rgba(2,8,10,.9),0 0 16px currentColor;}
  .rf-juice-f i{display:flex;align-items:center;filter:drop-shadow(0 1px 2px rgba(2,8,10,.8));}
  .rf-juice-f em{font-style:normal;font-family:"IBM Plex Mono",monospace;font-weight:500;
    font-size:.66em;letter-spacing:.14em;opacity:.72;}

  /* C · rarity landing ----------------------------------------------------- */
  #rf-juice-edge i{position:absolute;inset:0;display:block;opacity:0;will-change:opacity,transform;}
  .rf-juice-eg{background:radial-gradient(124% 104% at 50% 50%,transparent 52%,currentColor 100%);}
  .rf-juice-vp{mix-blend-mode:screen;transform-origin:50% 50%;
    background:
      radial-gradient(132% 104% at 48.8% 50%,transparent 58%,rgba(255,93,122,.55) 100%),
      radial-gradient(132% 104% at 51.2% 50%,transparent 58%,rgba(87,183,255,.55) 100%);}

  /* E · transitions -------------------------------------------------------- */
  #rf-juice-wash{will-change:opacity;opacity:0;}
  .rf-juice-band{position:absolute;top:-20%;bottom:-20%;left:0;width:62%;transform:translateX(-170%) skewX(-13deg);}
  #rf-juice-wipe.go .rf-juice-band{animation:rf-juice-sweep 1.05s cubic-bezier(.32,.02,.2,1) forwards;}
  @keyframes rf-juice-sweep{from{transform:translateX(-170%) skewX(-13deg);}
    to{transform:translateX(270%) skewX(-13deg);}}

  #rf-juice-card{position:fixed;left:50%;top:74px;z-index:27;pointer-events:none;
    transform:translateX(-50%) translateY(-10px);opacity:0;
    transition:opacity .34s ease,transform .34s cubic-bezier(.2,.8,.2,1);
    display:flex;align-items:center;gap:11px;padding:9px 15px 9px 13px;border-radius:14px;
    background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);}
  #rf-juice-card.on{opacity:1;transform:translateX(-50%) translateY(0);}
  #rf-juice-card .rf-juice-ci{display:flex;align-items:center;flex:0 0 auto;opacity:.95;}
  #rf-juice-card b{display:block;font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:13px;
    letter-spacing:.13em;text-transform:uppercase;line-height:1.2;}
  #rf-juice-card small{display:block;font-size:10px;color:var(--muted);letter-spacing:.03em;margin-top:2px;}

  /* B · the streak meter --------------------------------------------------- */
  #rf-juice-streak{position:fixed;right:12px;bottom:150px;z-index:28;pointer-events:none;
    width:calc(172px * var(--rf-ui-scale,1));display:none;flex-direction:column;gap:5px;}
  #rf-juice-streak.on{display:flex;}
  .rf-juice-s{position:relative;overflow:hidden;padding:6px 10px 7px;border-radius:11px;
    background:var(--glass-sheen),var(--glass-hud);
    backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid var(--glass-bd);box-shadow:var(--glass-hi),0 6px 20px rgba(2,8,10,.3);
    display:flex;align-items:center;gap:8px;color:var(--c-common);}
  .rf-juice-s .rf-juice-si{display:flex;align-items:center;flex:0 0 auto;opacity:.9;}
  .rf-juice-s .rf-juice-sl{flex:1;min-width:0;font-family:"IBM Plex Mono",monospace;font-size:8.5px;
    letter-spacing:.28em;text-transform:uppercase;color:var(--lab);}
  .rf-juice-s .rf-juice-sn{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:16px;
    font-variant-numeric:tabular-nums;color:currentColor;text-shadow:0 0 14px currentColor;}
  .rf-juice-s .rf-juice-sb{position:absolute;left:0;bottom:0;height:2px;width:0;
    background:currentColor;box-shadow:0 0 8px currentColor;opacity:.85;}
  .rf-juice-s.bump{animation:rf-juice-bump .3s cubic-bezier(.2,1.5,.4,1);}
  @keyframes rf-juice-bump{0%{transform:scale(1);}44%{transform:scale(1.055);}100%{transform:scale(1);}}

  /* F · the counters pop when they land ------------------------------------ */
  body.rf-juice-on #coinVal,body.rf-juice-on #pearlVal{display:inline-block;transform-origin:100% 50%;}
  body.rf-juice-on #coinVal.rf-juice-pop,body.rf-juice-on #pearlVal.rf-juice-pop{
    animation:rf-juice-pop .34s cubic-bezier(.2,1.6,.4,1);}
  @keyframes rf-juice-pop{0%{transform:scale(1);}40%{transform:scale(1.13);}100%{transform:scale(1);}}

  body.photo #rf-juice-floats,body.photo #rf-juice-streak,body.photo #rf-juice-card,
  body.photo #rf-juice-edge,body.photo #rf-juice-wash,body.photo #rf-juice-wipe{opacity:0!important;}
  body.rf-reduced #rf-juice-floats,body.rf-reduced #rf-juice-edge,body.rf-reduced #rf-juice-wash,
  body.rf-reduced #rf-juice-wipe,body.rf-reduced #rf-juice-streak,body.rf-reduced #rf-juice-card{display:none!important;}
  @media (prefers-reduced-motion:reduce){
    #rf-juice-card{transition:none;}
    .rf-juice-s.bump{animation:none;}
    body.rf-juice-on #coinVal.rf-juice-pop,body.rf-juice-on #pearlVal.rf-juice-pop{animation:none;}
  }
  `, '07-juice-css');

  const floatsEl = RF.el('<div id="rf-juice-floats" aria-hidden="true"></div>');
  const edgeEl = RF.el('<div id="rf-juice-edge" aria-hidden="true"><i class="rf-juice-eg"></i><i class="rf-juice-vp"></i></div>');
  const glowEl = edgeEl ? edgeEl.querySelector('.rf-juice-eg') : null;
  const vigEl = edgeEl ? edgeEl.querySelector('.rf-juice-vp') : null;
  const washEl = RF.el('<div id="rf-juice-wash" aria-hidden="true"></div>');
  const wipeEl = RF.el('<div id="rf-juice-wipe" aria-hidden="true"><i class="rf-juice-band"></i></div>');
  const cardEl = RF.el('<div id="rf-juice-card" aria-hidden="true">'
    + '<span class="rf-juice-ci"></span><span><b></b><small></small></span></div>');
  const streakEl = RF.el('<div id="rf-juice-streak" aria-hidden="true"></div>');

  /* ==========================================================================
     2. A — THE FLOAT POOL
     24 nodes, allocated once. A float either tracks a world point (it is a
     label on a thing that happened out there) or a screen point (the sale you
     made with the Market covering the world). Only transform and opacity are
     written per frame, so the compositor does the work, not the layout engine.
     ========================================================================== */
  const FN = 24, floats = [];
  if (floatsEl) for (let k = 0; k < FN; k++) {
    const el = RF.el('<div class="rf-juice-f"><i></i><span></span></div>', floatsEl);
    floats.push({ el: el, ic: el.firstElementChild, tx: el.lastElementChild,
      on: false, wx: 0, wy: 0, wz: 0, sx: 0, sy: 0, world: true,
      life: 0, ttl: 1, rise: 0, drift: 0, off: 0 });
  }
  let fCur = 0, fLive = 0, stackN = 0, stackAt = -9;
  const vProj = T ? new T.Vector3() : null;

  /* Two payouts in the same breath must not print on top of each other, so each
     float inside a 400 ms window starts one rung higher than the last. */
  function stagger() {
    const t = now();
    if (t - stackAt > 0.4) stackN = 0; else stackN = Math.min(5, stackN + 1);
    stackAt = t; return stackN * -21;
  }

  function popFloat(o) {
    if (!floats.length || !live()) return;
    const f = floats[fCur]; fCur = (fCur + 1) % FN;
    if (!f.on) fLive++;
    f.on = true; f.life = 0; f.ttl = o.ttl || 1.35;
    f.world = o.world !== false;
    f.wx = o.x || 0; f.wy = o.y || 0; f.wz = o.z || 0;
    f.sx = o.sx || 0; f.sy = o.sy || 0;
    f.off = stagger();
    f.rise = o.rise || 54; f.drift = rand(-16, 16);
    const mag = Math.abs(o.mag || 0);
    const size = 13 + clamp(Math.log(1 + mag) * 2.1, 0, 11);
    const el = f.el;
    el.style.fontSize = size.toFixed(1) + 'px';
    el.style.color = o.col || 'var(--ink)';
    f.ic.innerHTML = (budget() > 0 && o.icon) ? pix(o.icon, Math.round(size * 0.86)) : '';
    f.tx.innerHTML = o.text;
    el.style.opacity = '0';
  }

  function drawFloats(dt) {
    if (!fLive) return;
    const w = window.innerWidth, h = window.innerHeight, cam = RF.camera;
    // a float still ages out behind a panel or a photo shot — it just goes unseen,
    // so nothing is left hanging in the air when the screen comes back
    const hide = RF.panelOpen || photo(), ok = !!(cam && vProj);
    for (let k = 0; k < FN; k++) {
      const f = floats[k]; if (!f.on) continue;
      f.life += dt;
      if (f.life >= f.ttl) { f.on = false; fLive--; f.el.style.opacity = '0'; continue; }
      const p = f.life / f.ttl;
      let x, y, vis = true;
      if (f.world) {
        if (hide || !ok) { vis = false; }
        else {
          vProj.set(f.wx, f.wy, f.wz).project(cam);
          if (vProj.z > 1) vis = false;
          x = (vProj.x * 0.5 + 0.5) * w; y = (-vProj.y * 0.5 + 0.5) * h;
        }
      } else { x = f.sx; y = f.sy; }
      if (!vis) { f.el.style.opacity = '0'; continue; }
      // ease-out rise so the number leaps then hangs, and a fade that only bites late
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      const a = p < 0.12 ? p / 0.12 : (p > 0.62 ? 1 - (p - 0.62) / 0.38 : 1);
      const s = p < 0.14 ? 0.72 + (p / 0.14) * 0.34 : 1.06 - (p - 0.14) * 0.07;
      f.el.style.opacity = a.toFixed(3);
      f.el.style.transform = 'translate3d(' + (x + f.drift * e).toFixed(1) + 'px,'
        + (y - f.rise * e + f.off).toFixed(1) + 'px,0) translate(-50%,-50%) scale(' + s.toFixed(3) + ')';
    }
  }

  /* ==========================================================================
     3. D — POOLED 3D FX
     Two instanced meshes, both additive so a per-instance colour fade IS an
     opacity fade with no custom shader: rings that lie flat on water and ground,
     and camera-facing quads for dust, sparks and leaves. Nothing is allocated
     after this block; every burst walks a cursor around a fixed pool.
     ========================================================================== */
  const RN = 12, PN = 56;
  let ringMesh = null, puffMesh = null, jumper = null;
  const rings = [], puffs = [];
  const dObj = T ? new T.Object3D() : null, dCol = T ? new T.Color() : null;
  let ringDirty = true, puffDirty = true;

  try {
    if (T && RF.scene) {
      const rg = new T.RingGeometry(0.86, 1, 26);
      rg.rotateX(-Math.PI / 2);
      ringMesh = new T.InstancedMesh(rg,
        new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9,
          blending: T.AdditiveBlending, depthWrite: false, fog: false, side: T.DoubleSide }), RN);
      ringMesh.frustumCulled = false; ringMesh.renderOrder = 3; RF.scene.add(ringMesh);
      for (let k = 0; k < RN; k++) rings.push({ x: 0, y: -99, z: 0, r0: 0.3, r1: 2, life: 0, ttl: 1, cr: 1, cg: 1, cb: 1 });

      puffMesh = new T.InstancedMesh(new T.PlaneGeometry(1, 1),
        new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85,
          blending: T.AdditiveBlending, depthWrite: false, fog: false, side: T.DoubleSide }), PN);
      puffMesh.frustumCulled = false; puffMesh.renderOrder = 3; RF.scene.add(puffMesh);
      for (let k = 0; k < PN; k++) puffs.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, g: 6, drag: 2,
        life: 0, ttl: 1, s0: 0.2, s1: 0.6, cr: 1, cg: 1, cb: 1, sway: 0, ph: 0 });

      jumper = new T.Mesh(new T.BoxGeometry(0.46, 0.2, 0.14),
        new T.MeshLambertMaterial({ color: 0x8fd8ff, emissive: 0x14313f }));
      jumper.visible = false; jumper.castShadow = false; RF.scene.add(jumper);
    }
  } catch (e) { RF.warn('juice:fxmesh', e); }

  let rCur = 0, pCur = 0;
  function ring(x, y, z, r1, ttl, hex) {
    if (!ringMesh || !spawns()) return;
    const r = rings[rCur]; rCur = (rCur + 1) % RN;
    r.x = x; r.y = y; r.z = z; r.r0 = 0.22; r.r1 = r1; r.life = r.ttl = ttl;
    dCol.setHex(hex === undefined ? 0xbfeaff : hex);
    r.cr = dCol.r; r.cg = dCol.g; r.cb = dCol.b; ringDirty = true;
  }
  function puff(n, o) {
    if (!puffMesh || !spawns()) return;
    n = Math.max(1, Math.round(n * budget()));
    for (let k = 0; k < n; k++) {
      const p = puffs[pCur]; pCur = (pCur + 1) % PN;
      const a = rand(0, TAU), sp = rand(0.35, 1) * (o.speed || 1.6);
      p.x = o.x + rand(-0.12, 0.12); p.y = o.y; p.z = o.z + rand(-0.12, 0.12);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = rand(0.35, 1) * (o.up === undefined ? 1.6 : o.up);
      p.g = o.g === undefined ? 5 : o.g; p.drag = o.drag === undefined ? 2.2 : o.drag;
      p.life = p.ttl = rand(0.7, 1) * (o.ttl || 0.6);
      p.s0 = (o.s0 === undefined ? 0.16 : o.s0) * rand(0.8, 1.25);
      p.s1 = (o.s1 === undefined ? 0.44 : o.s1) * rand(0.8, 1.25);
      p.sway = o.sway || 0; p.ph = rand(0, TAU);
      const cols = o.cols;
      dCol.setHex(cols[(Math.random() * cols.length) | 0]);
      p.cr = dCol.r; p.cg = dCol.g; p.cb = dCol.b;
    }
    puffDirty = true;
  }

  function stepFx(dt) {
    if (ringMesh && ringDirty) {
      let any = false;
      for (let k = 0; k < RN; k++) {
        const r = rings[k];
        if (r.life > 0) {
          r.life -= dt; any = any || r.life > 0;
          const p = 1 - Math.max(0, r.life) / r.ttl, e = 1 - (1 - p) * (1 - p) * (1 - p);
          const s = Math.max(0.0001, lerp(r.r0, r.r1, e)), f = Math.max(0, 1 - p) * 0.9;
          dObj.position.set(r.x, r.y, r.z); dObj.rotation.set(0, 0, 0); dObj.scale.set(s, 1, s);
          dCol.setRGB(r.cr * f, r.cg * f, r.cb * f);
        } else { dObj.position.set(0, -99, 0); dObj.scale.set(0.0001, 0.0001, 0.0001); dCol.setRGB(0, 0, 0); }
        dObj.updateMatrix(); ringMesh.setMatrixAt(k, dObj.matrix); ringMesh.setColorAt(k, dCol);
      }
      ringMesh.instanceMatrix.needsUpdate = true;
      if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
      ringDirty = any;
    }
    if (puffMesh && puffDirty) {
      let any = false;
      const q = RF.camera ? RF.camera.quaternion : null;
      for (let k = 0; k < PN; k++) {
        const p = puffs[k];
        if (p.life > 0) {
          p.life -= dt; any = any || p.life > 0;
          const d = Math.exp(-p.drag * dt);
          p.vx *= d; p.vz *= d; p.vy = p.vy * d - p.g * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.sway) p.x += Math.sin(now() * 2.3 + p.ph) * p.sway * dt;
          const t = 1 - Math.max(0, p.life) / p.ttl;
          const s = Math.max(0.0001, lerp(p.s0, p.s1, t)), f = Math.max(0, 1 - t * t);
          dObj.position.set(p.x, p.y, p.z);
          if (q) dObj.quaternion.copy(q);
          dObj.scale.set(s, s, s);
          dCol.setRGB(p.cr * f, p.cg * f, p.cb * f);
        } else { dObj.position.set(0, -99, 0); dObj.scale.set(0.0001, 0.0001, 0.0001); dCol.setRGB(0, 0, 0); }
        dObj.updateMatrix(); puffMesh.setMatrixAt(k, dObj.matrix); puffMesh.setColorAt(k, dCol);
      }
      puffMesh.instanceMatrix.needsUpdate = true;
      if (puffMesh.instanceColor) puffMesh.instanceColor.needsUpdate = true;
      puffDirty = any;
    }
  }

  /* ==========================================================================
     4. C — RARITY LANDING
     Both layers are scalar-driven from JS rather than CSS animations, so a
     second catch mid-decay re-arms instantly instead of waiting out a keyframe,
     and killing the mod is a single write of 0.
     ========================================================================== */
  let glow = 0, glowMax = 0, vigp = 0, vigMax = 0, glowCol = '#39d7c4';
  function bloom(amount, col) {
    if (!live()) return;
    glowMax = Math.max(glowMax, clamp(amount, 0, 1)); glow = glowMax;
    vigMax = Math.max(vigMax, clamp(amount * 0.85, 0, 1)); vigp = vigMax;
    glowCol = col || glowCol;
    if (glowEl) glowEl.style.color = glowCol;
  }
  function drawEdge(dt) {
    if (glow <= 0.0005 && vigp <= 0.0005) return;
    glow = Math.max(0, glow - dt * 1.55);
    vigp = Math.max(0, vigp - dt * 3.1);
    if (glowEl) glowEl.style.opacity = (glow * 0.62).toFixed(3);
    if (vigEl) {
      vigEl.style.opacity = (vigp * 0.5).toFixed(3);
      vigEl.style.transform = 'scale(' + (1 + vigp * 0.035).toFixed(4) + ')';
    }
    if (glow <= 0.0005) glowMax = 0;
    if (vigp <= 0.0005) vigMax = 0;
  }

  /* ==========================================================================
     5. B — STREAKS
     A catch streak counts clean landings: a snapped line, a missed bite or an
     ESC out of the water breaks it. A sell streak counts payouts in one visit
     to the Trader. The vein combo is core's and stays core's — it only rides
     along on the mined float.
     ========================================================================== */
  const RAMP = ['--c-common', '--c-uncommon', '--c-rare', '--c-epic', '--c-legendary'];
  function mkRow(icon, label) {
    const el = RF.el('<div class="rf-juice-s"><span class="rf-juice-si"></span>'
      + '<span class="rf-juice-sl">' + label + '</span><span class="rf-juice-sn">0</span>'
      + '<i class="rf-juice-sb"></i></div>', streakEl);
    if (!el) return null;
    el.style.display = 'none';
    return { el: el, ic: el.children[0], n: el.children[2], bar: el.children[3], icon: icon, shown: false };
  }
  const rowCatch = mkRow('fish', 'streak'), rowSell = mkRow('trophy', 'sales');
  const cs = { n: 0, t: 0, hold: 26, row: rowCatch, base: 392 };
  const ss = { n: 0, t: 0, hold: 14, row: rowSell, base: 330 };

  function bumpStreak(s) {
    s.n++; s.t = s.hold;
    if (!live()) return;
    // one semitone per rung, capped so a 30-catch run does not end up a dog whistle
    const step = Math.min(s.n - 1, 14);
    fn.beep(s.base * Math.pow(2, step / 12), 0.07, 'triangle', 0.038);
    if (s.n >= 3) fn.beep(s.base * 2 * Math.pow(2, step / 12), 0.05, 'sine', 0.016);
    const r = s.row;
    if (r) { r.el.classList.remove('bump'); void r.el.offsetWidth; r.el.classList.add('bump'); }
  }
  function breakStreak(s) { s.n = 0; s.t = 0; }

  function drawStreak(dt) {
    if (cs.t > 0 && (cs.t -= dt) <= 0) cs.n = 0;
    if (ss.t > 0 && (ss.t -= dt) <= 0) ss.n = 0;
    let on = false;
    on = paintRow(cs) || on;
    on = paintRow(ss) || on;
    if (streakEl) streakEl.classList.toggle('on', on && enabled);
  }
  function paintRow(s) {
    const r = s.row; if (!r) return false;
    const want = s.n >= 2 && enabled;
    if (want !== r.shown) {
      r.shown = want; r.el.style.display = want ? 'flex' : 'none';
      if (want) r.ic.innerHTML = pix(r.icon, 15);
    }
    if (!want) return false;
    const tier = RAMP[Math.min(4, Math.floor((s.n - 2) / 2))];
    r.el.style.color = 'var(' + tier + ')';
    r.n.textContent = '×' + s.n;
    r.bar.style.width = (clamp(s.t / s.hold, 0, 1) * 100).toFixed(1) + '%';
    return true;
  }

  /* ==========================================================================
     6. E — TRANSITIONS
     ========================================================================== */
  const WX = {
    clear: { c: 'rgba(57,215,196,.24)', i: 'sun', t: 'The sky clears', s: 'the wind drops · the water goes flat' },
    rain:  { c: 'rgba(87,183,255,.28)', i: 'rain', t: 'Rain sets in', s: 'fish bite faster · the rock loosens' },
    storm: { c: 'rgba(255,93,122,.32)', i: 'storm', t: 'Storm front', s: 'rare fish stir · the quarry pays 1.5×' },
    snow:  { c: 'rgba(223,240,255,.32)', i: 'rain', t: 'Snowfall', s: 'the ice fish rise · wood comes down' },
    ash:   { c: 'rgba(201,160,138,.32)', i: 'storm', t: 'Ashfall', s: 'the vents are venting · the seams give' }
  };
  let cardT = 0;
  function windCard(w) {
    const x = WX[w] || WX.clear;
    if (wipeEl && live()) {
      const band = wipeEl.firstElementChild;
      if (band) {
        band.style.background = 'linear-gradient(102deg,transparent 0%,' + x.c + ' 34%,' + x.c + ' 56%,transparent 100%)';
        wipeEl.classList.remove('go'); void wipeEl.offsetWidth; wipeEl.classList.add('go');
      }
    }
    if (!cardEl || !live()) return;
    const ico = (w === 'clear' && fn.isNight()) ? 'moon' : x.i;
    cardEl.children[0].innerHTML = pix(ico, 20);
    const body = cardEl.children[1];
    body.children[0].textContent = x.t;
    body.children[0].style.color = w === 'storm' ? 'var(--rose)' : w === 'clear' ? 'var(--teal)' : 'var(--gold)';
    body.children[1].textContent = x.s;
    cardEl.classList.add('on'); cardT = 3.4;
  }

  /* Dawn and dusk are read straight off the day clock: isNight() flips at .13
     and .72, so a crossing of either is the moment the light actually turns. */
  let lastDay = RF.dayT, washT = 0, washDur = 1, dayGate = 0;
  const WASH = {
    dawn: 'linear-gradient(180deg,rgba(255,207,92,.20),rgba(255,180,120,.09) 46%,rgba(57,215,196,.05))',
    dusk: 'linear-gradient(0deg,rgba(93,110,190,.22),rgba(255,140,90,.10) 52%,rgba(255,207,92,.05))'
  };
  function sky(kind) {
    if (!live() || dayGate > 0 || !RF.running) return;
    dayGate = 30;
    if (washEl) { washEl.style.background = WASH[kind]; washT = washDur = 2.6; }
    const a = kind === 'dawn' ? 523 : 784, b = kind === 'dawn' ? 784 : 523;
    fn.beep(a, 0.26, 'sine', 0.04);
    setTimeout(function () { try { fn.beep(b, 0.42, 'sine', 0.035); fn.beep(b * 2, 0.24, 'triangle', 0.012); } catch (e) {} }, 210);
  }
  function drawSky(dt) {
    if (dayGate > 0) dayGate -= dt;
    const d = RF.dayT;
    if (d >= 0.13 && lastDay < 0.13) sky('dawn');
    else if (d >= 0.72 && lastDay < 0.72) sky('dusk');
    lastDay = d;
    if (washT > 0) {
      washT -= dt;
      const p = 1 - Math.max(0, washT) / washDur;
      if (washEl) washEl.style.opacity = (p < 0.22 ? p / 0.22 : 1 - (p - 0.22) / 0.78).toFixed(3);
    }
    if (cardT > 0 && (cardT -= dt) <= 0 && cardEl) cardEl.classList.remove('on');
  }

  /* ==========================================================================
     7. F — COUNTERS THAT ROLL
     02-hud may already be rolling these. Rather than fight it every frame we
     watch our own last write: if something else overwrote it twice in a row,
     that mod owns the counter and we stand down for good.
     ========================================================================== */
  const rollers = [];
  (function () {
    const mk = function (id, read, render) {
      const el = byId(id); if (!el) return;
      const v = read();
      rollers.push({ el: el, read: read, render: render, shown: v, from: v, to: v,
        t: 0, dur: 0, wrote: '', own: true, strikes: 0 });
    };
    mk('coinVal', function () { return RF.state.coins | 0; }, function (v) { return fmt(v); });
    mk('pearlVal', function () { return RF.state.pearls | 0; }, function (v) { return '◉ ' + fmt(v); });
  })();

  function rollTick(dt) {
    for (let k = 0; k < rollers.length; k++) {
      const r = rollers[k];
      if (!r.own || r.dur <= 0) continue;
      if (r.wrote && r.el.textContent !== r.wrote) {
        if (++r.strikes >= 2) { r.own = false; r.dur = 0; r.wrote = ''; continue; }
      }
      r.t += dt;
      const p = clamp(r.t / r.dur, 0, 1), e = 1 - (1 - p) * (1 - p) * (1 - p);
      r.shown = p >= 1 ? r.to : Math.round(lerp(r.from, r.to, e));
      r.wrote = r.render(r.shown);
      r.el.textContent = r.wrote;
      if (p >= 1) {
        r.dur = 0; r.wrote = '';
        r.el.classList.remove('rf-juice-pop'); void r.el.offsetWidth; r.el.classList.add('rf-juice-pop');
      }
    }
  }
  RF.on('hud', function () {
    for (let k = 0; k < rollers.length; k++) {
      const r = rollers[k];
      const v = r.read();
      if (!r.own || !live()) { r.shown = v; r.to = v; r.dur = 0; r.wrote = ''; continue; }
      if (v !== r.to) {
        const d = Math.abs(v - r.shown);
        r.from = r.shown; r.to = v; r.t = 0;
        // a rounding-error delta is not worth a tween; a fortune is worth a longer one
        r.dur = d < 2 ? 0 : (d > 4000 ? 0.62 : 0.45);
        if (r.dur === 0) { r.shown = v; r.wrote = ''; continue; }
      }
      if (r.dur > 0) { r.wrote = r.render(r.shown); r.el.textContent = r.wrote; }
    }
  }, 40);

  /* ==========================================================================
     8. THE GAME TALKS BACK — every hook is one payout of feedback.
     ========================================================================== */
  const oreCol = function (t) { const o = ORE[t]; return o ? o.dot : '#b9c6c4'; };
  const oreIcon = function (t) { return t === 'wood' ? 'wood' : 'ore'; };

  let lastCatchAt = -9;
  RF.on('catch', function (f, info) {
    if (!f) return;
    lastCatchAt = now();
    pendBreak = 0;
    bumpStreak(cs);
    const b = RF.bobber, r = RORDER[f.rar] || 0;
    const col = f.shiny ? '#ffd24f' : (RAR[f.rar] || '#b9c6c4');
    if (b) popFloat({ x: b.position.x, y: RF.WATER_TOP + 0.9, z: b.position.z,
      text: f.name + ' <em>◈' + fmt(f.val) + '</em>', col: col, mag: f.val, icon: 'fish', ttl: 1.7, rise: 74 });
    if (!live()) return;
    // the bloom scales with rarity, and a shiny is always worth a full-strength one
    const amt = clamp(0.2 + r * 0.19 + (f.shiny ? 0.3 : 0), 0, 1);
    if (r >= 1 || f.shiny) bloom(amt, col);
    // core owns hit-stop; we only ask for the big ones and never past a quarter second
    if (r >= 3) fn.addFreeze(Math.min(0.25, 0.1 + (r - 3) * 0.06 + (f.shiny ? 0.05 : 0)));
    if (b) ring(b.position.x, RF.WATER_TOP + 0.03, b.position.z, r >= 3 ? 3.4 : 2.3, 0.85, f.shiny ? 0xffe6a0 : 0xd9f6ff);
  });

  RF.on('mined', function (m) {
    if (!m) return;
    const n = m.node, x = n && n.x !== undefined ? n.x : RF.pWorld.x, z = n && n.z !== undefined ? n.z : RF.pWorld.z;
    const y = (n && n.y !== undefined ? n.y : fn.heightAt(x, z)) + 1.15;
    const vein = m.combo > 1 ? ' <em>vein ×' + m.combo + '</em>' : '';
    popFloat({ x: x, y: y, z: z, text: '+' + m.got + ' ' + (ORE[m.type] ? ORE[m.type].name : m.type) + vein,
      col: oreCol(m.type), mag: m.got * (m.geode ? 6 : 3), icon: oreIcon(m.type), ttl: 1.5, rise: 66 });
    if (m.geode && live()) bloom(0.4, '#5ee8e2');
  });

  RF.on('chopped', function (c) {
    if (!c) return;
    const t = c.tree, x = t ? t.x : RF.pWorld.x, z = t ? t.z : RF.pWorld.z;
    const y = (t ? t.y : fn.heightAt(x, z)) + 3.2;
    popFloat({ x: x, y: y, z: z, text: '+' + c.got + ' Wood', col: oreCol('wood'),
      mag: c.got * 3, icon: 'wood', ttl: 1.4, rise: 62 });
    // core already throws a hard leaf burst on the felling frame; this is the
    // slow fall that follows it down, in the same colours as the canopy
    if (t) puff(7, { x: x, y: y - 0.4, z: z, cols: t.pink ? [0xec9fcb, 0xf5b5d9, 0xd68ab4] : [0x3aa626, 0x54cb3c, 0x2c7d1d],
      speed: 0.9, up: 0.5, g: 1.1, drag: 1.2, ttl: 1.9, s0: 0.16, s1: 0.1, sway: 1.5 });
  });

  RF.on('pearls', function (n) {
    if (!(n > 0)) return;
    popFloat({ x: RF.pWorld.x, y: RF.pWorld.y + 2.35, z: RF.pWorld.z,
      text: '+' + n + ' ◉', col: 'var(--teal)', mag: n * 24, ttl: 1.3, rise: 58 });
  });

  RF.on('dug', function () {
    popFloat({ x: RF.pWorld.x, y: RF.pWorld.y + 1.5, z: RF.pWorld.z,
      text: 'Buried treasure', col: 'var(--gold)', mag: 90, icon: 'map', ttl: 1.7, rise: 70 });
    if (live()) bloom(0.5, '#ffcf5c');
    puff(10, { x: RF.pWorld.x, y: RF.pWorld.y + 0.2, z: RF.pWorld.z,
      cols: [0xffd24f, 0xffefb0, 0xd8c08a], speed: 2.2, up: 2.6, g: 7, ttl: 0.7, s0: 0.14, s1: 0.34 });
  });

  RF.on('sold', function (s) {
    if (!s || !(s.gained > 0)) return;
    bumpStreak(ss);
    const o = { text: '+◈' + fmt(s.gained), col: 'var(--gold)', mag: s.gained, ttl: 1.5, rise: 66 };
    // the Market covers the world, so a sale made inside it flies off the coin
    // counter instead of off a trader nobody can see
    if (RF.panelOpen) {
      const hud = byId('hud-coins'), r = hud && hud.getBoundingClientRect ? hud.getBoundingClientRect() : null;
      o.world = false;
      o.sx = r && r.width ? r.left + r.width / 2 : window.innerWidth - 90;
      o.sy = r && r.width ? r.bottom + 16 : 60;
    } else {
      const tp = RF.TRADER_POS;
      o.x = tp ? tp.x : RF.pWorld.x; o.y = (tp ? tp.y : RF.pWorld.y) + 2.2; o.z = tp ? tp.z : RF.pWorld.z;
    }
    popFloat(o);
    if (live() && s.gained >= 400) bloom(clamp(0.22 + Math.log(1 + s.gained) / 26, 0, 0.7), '#ffcf5c');
  });

  RF.on('weather', function (w) { windCard(w); });
  RF.on('panel', function (name, open) { if (!open && name === 'market') breakStreak(ss); });
  RF.on('travel', function () { breakStreak(cs); breakStreak(ss); });

  /* ==========================================================================
     9. WATCHERS — the feedback core never announces. All of it is read off
     state the reference table already exposes; nothing here writes to it.
     ========================================================================== */
  let fState = 'idle', pendBreak = 0;
  let jump = 0, jumpDur = 0, jx = 0, jz = 0, jdx = 0, jdz = 0, jumpTried = false;
  let stepPh = 0, wasWater = false, armPrev = 0;

  function watchFishing(dt) {
    const f = RF.fishing; if (!f) return;
    const s = f.state;
    if (s !== fState) {
      if (fState === 'cast' && s === 'wait' && RF.bobber) {   // the bobber hitting the water
        ring(RF.bobber.position.x, RF.WATER_TOP + 0.03, RF.bobber.position.z, 2.6, 0.9, 0xbfeaff);
        ring(RF.bobber.position.x, RF.WATER_TOP + 0.03, RF.bobber.position.z, 1.5, 0.55, 0xffffff);
      }
      if (s === 'bite' && RF.bobber) ring(RF.bobber.position.x, RF.WATER_TOP + 0.03, RF.bobber.position.z, 1.5, 0.55, 0xffd24f);
      // going idle out of a live line is either a landing or a loss; the catch
      // hook cancels the pending break, so whatever is left really was a loss
      if (s === 'idle' && fState !== 'idle') pendBreak = now() + 2.5;
      if (s === 'cast') { jumpTried = false; jump = 0; if (jumper) jumper.visible = false; }
      fState = s;
    }
    if (pendBreak && now() > pendBreak) { pendBreak = 0; if (now() - lastCatchAt > 2.4) breakStreak(cs); }

    /* One fish shows itself per cast while the bobber sits: it is the only
       thing in a long wait that says the water is alive. */
    if (jumper) {
      if (jump > 0) {
        jump -= dt;
        const p = 1 - Math.max(0, jump) / jumpDur;
        jumper.visible = true;
        jumper.position.set(jx + jdx * p, RF.WATER_TOP + Math.sin(p * Math.PI) * 1.15 - 0.1, jz + jdz * p);
        jumper.rotation.set(Math.cos(p * Math.PI) * -0.9, Math.atan2(jdx, jdz), 0);
        if (jump <= 0) {
          jumper.visible = false;
          ring(jumper.position.x, RF.WATER_TOP + 0.03, jumper.position.z, 2.1, 0.75, 0xbfeaff);
          if (live() && RF.sfx && RF.sfx.splash) RF.sfx.splash(0.045);
          puff(5, { x: jumper.position.x, y: RF.WATER_TOP + 0.1, z: jumper.position.z,
            cols: [0xbfeaff, 0xffffff, 0x7fdcff], speed: 1.4, up: 1.8, g: 7, ttl: 0.5, s0: 0.1, s1: 0.26 });
        }
      } else if (s === 'wait' && !jumpTried && f.t > 0.55 && spawns() && !RF.panelOpen) {
        jumpTried = true;
        if (Math.random() < 0.45) {
          const b = RF.bobber, a = rand(0, TAU), d = rand(2.4, 4.6);
          const px = (b ? b.position.x : RF.pWorld.x) + Math.cos(a) * d;
          const pz = (b ? b.position.z : RF.pWorld.z) + Math.sin(a) * d;
          if (fn.isWaterAt(px, pz)) {
            jx = px; jz = pz; const a2 = rand(0, TAU);
            jdx = Math.cos(a2) * 0.9; jdz = Math.sin(a2) * 0.9;
            jump = jumpDur = 0.78;
            ring(px, RF.WATER_TOP + 0.03, pz, 1.6, 0.6, 0xbfeaff);
            if (live() && RF.sfx && RF.sfx.splash) RF.sfx.splash(0.05);
          }
        }
      }
    }
  }

  /* Boots on stone and sand kick up grit; a footfall at the waterline rings the
     shallows. Both hang off core's own half-stride counter so the puff lands on
     the same frame as the step sound. */
  function watchSteps() {
    const P = RF.pWorld;
    const st = P.step;
    // core zeroes `step` the moment you stop, so only a rising stride is a footfall
    if (st > stepPh && (stepPh / Math.PI | 0) !== (st / Math.PI | 0)) {
      const h = fn.heightAt(P.x, P.z), t = fn.cellType(h);
      if (t === 'stone' || t === 'sand') {
        puff(3, { x: P.x, y: P.y + 0.05, z: P.z,
          cols: t === 'stone' ? [0x8a949c, 0xa8b2ba, 0x6d767d] : [0xe8d8a8, 0xd8c890, 0xc0b078],
          speed: 0.85, up: 0.7, g: 3.4, drag: 3.4, ttl: 0.5, s0: 0.12, s1: 0.42 });
      }
      if (t === 'sand' && P.face === P.face) {   // a boot at the tideline rings the shallows ahead of it
        const wx = P.x + Math.sin(P.face) * 1.1, wz = P.z + Math.cos(P.face) * 1.1;
        if (fn.isWaterAt(wx, wz)) ring(wx, RF.WATER_TOP + 0.03, wz, 1.2, 0.6, 0x9fe0ff);
      }
    }
    stepPh = st;
    const inW = fn.isWaterAt(P.x, P.z);
    if (inW && !wasWater) {
      ring(P.x, RF.WATER_TOP + 0.03, P.z, 3, 0.95, 0xd9f6ff);
      puff(8, { x: P.x, y: RF.WATER_TOP + 0.1, z: P.z, cols: [0xbfeaff, 0xffffff, 0x7fdcff],
        speed: 1.9, up: 2.4, g: 8, ttl: 0.6, s0: 0.12, s1: 0.3 });
      if (live() && RF.sfx && RF.sfx.splash) RF.sfx.splash(0.08);
    }
    wasWater = inW;
  }

  /* The pick striking stone. Core fires its debris burst from inside the swing
     animation; the only handle a mod has on that same frame is the right arm
     coming through the bottom of the arc, so we ride it. */
  function watchSwing() {
    const pd = RF.player && RF.player.userData, node = RF.mining && RF.mining.node;
    if (!pd || !pd.armR) return;
    const a = pd.armR.rotation.x;
    if (node && RF.keys.act && armPrev < -0.32 && a >= -0.32) {
      const hot = node.geode ? [0x5ee8e2, 0xd8fffb, 0xffefb0] : [0xffd7a0, 0xffefc8, 0xff9d5c];
      puff(5, { x: node.x, y: node.y + 0.72, z: node.z, cols: hot,
        speed: 3.4, up: 2.2, g: 12, drag: 1.2, ttl: 0.34, s0: 0.09, s1: 0.02 });
    }
    armPrev = a;
  }

  /* ==========================================================================
     10. THE LOOP. Two hooks: the world pass before the render, the DOM pass
     after it, so the float projection uses the camera matrices that were just
     drawn instead of last frame's.
     ========================================================================== */
  RF.on('frame', function (dt) {
    try {
      if (!enabled) return;
      jt += dt;
      drawStreak(dt);
      rollTick(dt);
      if (reduced()) return;
      drawEdge(dt);
      drawSky(dt);
      if (RF.running) { watchFishing(dt); watchSteps(); watchSwing(); }
      stepFx(dt);
    } catch (e) { RF.err('juice:frame', e); }
  });
  RF.on('afterRender', function (dt) {
    try { if (enabled) drawFloats(dt); } catch (e) { RF.err('juice:floats', e); }
  });

  /* ==========================================================================
     11. THE MASTER SWITCH — 10-comfort turns the whole pass off in one call.
     ========================================================================== */
  function clearAll() {
    for (let k = 0; k < FN; k++) { const f = floats[k]; f.on = false; f.el.style.opacity = '0'; }
    fLive = 0;
    for (let k = 0; k < rings.length; k++) rings[k].life = 0;
    for (let k = 0; k < puffs.length; k++) puffs[k].life = 0;
    ringDirty = puffDirty = true;
    if (jumper) { jumper.visible = false; jump = 0; }
    glow = vigp = glowMax = vigMax = 0;
    if (glowEl) glowEl.style.opacity = '0';
    if (vigEl) { vigEl.style.opacity = '0'; vigEl.style.transform = 'none'; }
    if (washEl) washEl.style.opacity = '0';
    washT = 0; cardT = 0;
    if (cardEl) cardEl.classList.remove('on');
    if (wipeEl) wipeEl.classList.remove('go');
    if (streakEl) streakEl.classList.remove('on');
  }
  function apply() {
    B.classList.toggle('rf-juice-on', enabled);
    if (ringMesh) ringMesh.visible = enabled;
    if (puffMesh) puffMesh.visible = enabled;
    if (!enabled) clearAll();
    else { pendBreak = 0; stackAt = jt - 9; }
  }
  RF.api = RF.api || {};
  RF.api.juice = {
    enabled: enabled,
    set: function (v) {
      const next = !!v;
      if (next === enabled) return enabled;
      enabled = next; RF.api.juice.enabled = enabled;
      apply();
      try { RF.store.set('juice', { on: enabled }); } catch (e) { RF.warn('juice:save', e); }
      return enabled;
    },
    get: function () { return enabled; },
    /* so another mod can borrow the layer for its own one-off flourish */
    bloom: function (amount, col) { bloom(amount, col); },
    ring: function (x, y, z, r, ttl, hex) { ring(x, y, z, r, ttl, hex); }
  };
  apply();

  /* Coming out of a panel or a photo the pool may hold stale nodes mid-fade;
     a fresh sail also has no business inheriting the last isle's streaks. */
  RF.on('start', function () { clearAll(); lastDay = RF.dayT; stepPh = RF.pWorld.step; wasWater = fn.isWaterAt(RF.pWorld.x, RF.pWorld.z); });

  /* ==========================================================================
     G. THE FEEL LAYER — the other half of juice: what the game SOUNDS like and
     how the camera answers. Kept in its own closure so it shares nothing with
     the visual pass above but the mod record and RF.api.juice.

     G1. Living ambience  · a positional bed per biome: surf swelling at the
         waterline, wind on the ridge, room tone in stone, the Undermine dripping.
     G2. Weather in the air · rain hiss, storm gusts, snow's thin dead air, ash
         grit, and lightning you see as well as hear.
     G3. Night hush & dawn chorus · the mix leans back after dusk, crickets come
         up, birds answer each other at sunrise.
     G4. The second voice · an adaptive score layer in the isle's own key and
         tempo: tense on the reel, predatory when something big is hooked,
         patient inside a geode, one soft bell a night otherwise.
     G5. The mix bus · a limiter, a duck on every impact, a muffle when a panel
         takes the screen, all under the player's own volume sliders.
     G6. No two the same · footsteps, picks, axes and splashes get pitch, pan and
         read-head variation and a repeat gate.
     G7. Stings · a line-tension warning, a near-miss, a rarity cadence, a
         house-wins fall, every one of them in key.
     G8. A camera that breathes · punch-in on the big ones, a slow idle drift, a
         lean into your run, a spring settle after a hit.
     G9. Impact grammar · directional shake with a roll and a budget that stops
         a chain of hits turning into nausea, plus micro hit-stop.
     G10. Instant answer · the first press wakes the audio, E always replies, and
         holding E sings back at you.
     ========================================================================== */
  (function feelLayer(RF) {
    'use strict';
    const fn = RF.fn, sfx = RF.sfx;
    const clamp = fn.clamp, lerp = fn.lerp, rand = fn.rand;
    const RORDER = RF.RORDER || {};

    /* Reduced motion is a promise, not a suggestion: it kills the drift, the lean, the roll and
       the chromatic split outright and halves what is left. Two sources say it — the OS media
       query and 10-comfort's `body.rf-reduced` — and either is enough. Audio is untouched:
       motion sickness comes from the picture. `rfQuality:'low'` drops every decorative extra.
       All of it is re-read on a slow tick, because the settings panel flips them mid-game. */
    let REDUCE = false, QUALITY = 'high', camMotion = true, visuals = true;
    const decor = () => QUALITY !== 'low';
    function readComfort() {
      let r = false;
      try { r = !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
      try { if (document.body.classList.contains('rf-reduced')) r = true; } catch (e) {}
      if (r !== REDUCE) { REDUCE = r; if (fxEl) fxEl.classList.toggle('rf-juice-still', REDUCE); }
      try { QUALITY = (document.body.dataset && document.body.dataset.rfQuality) || 'high'; } catch (e) {}
      // 10-comfort kills camera trauma by returning 0 from the `shake` pipe; read that as
      // "no camera motion at all" and stand the drift, lean and roll down with it
      camMotion = RF.pipe('shake', 1, { src: 'juice:probe' }) > 0;
      // and the pass's own master switch turns the picture off without touching the sound
      visuals = !(RF.api && RF.api.juice && RF.api.juice.enabled === false);
    }

    /* ══════════════════════════════════════════════════════════════════════
       G5. THE MIX BUS
       game.js builds a real mixer (master -> music/sfx) inside initAudio(), but
       there is still nothing between that mixer and the speakers. We take the
       context the instant it is born — before initAudio() has wired master to
       the output — and shadow `destination`, so the finished game mix arrives on
       a bus we can duck, muffle and limit. Our own voices hang off sibling buses
       that MIRROR RF.audio.master/music/sfx, so the settings sliders govern them
       exactly as they govern everything else. Every part of this degrades to
       plain playback rather than to silence.
       ══════════════════════════════════════════════════════════════════════ */
    let AC = null, BUS = null, shadowed = false, gestured = false;

    function buildBus(c) {
      let dest = null;
      try { // find whichever prototype up the chain actually declares `destination`
        let p = Object.getPrototypeOf(c), d = null;
        while (p && !(d = Object.getOwnPropertyDescriptor(p, 'destination'))) p = Object.getPrototypeOf(p);
        if (d && d.get) dest = d.get.call(c);
      } catch (e) {}
      if (!dest) dest = c.destination;
      if (!dest) return null;

      const lim = c.createDynamicsCompressor();
      // bus glue, not a brickwall: a jackpot over thunder over footsteps must not clip,
      // but a lone footstep must not get pumped either
      lim.threshold.value = -14; lim.knee.value = 16; lim.ratio.value = 5;
      lim.attack.value = 0.004; lim.release.value = 0.22;
      lim.connect(dest);

      // a press is the one thing that must always cut through: ui skips both muffle and duck
      const ui = c.createGain(); ui.gain.value = 1; ui.connect(lim);
      const duck = c.createGain(); duck.gain.value = 1; duck.connect(lim);
      const muf = c.createBiquadFilter(); muf.type = 'lowpass'; muf.Q.value = 0.35;
      muf.frequency.value = 20000; muf.connect(duck);                        // transparent until a panel opens
      const game = c.createGain(); game.gain.value = 1; game.connect(muf);   // everything game.js plays
      const world = c.createGain(); world.gain.value = 1; world.connect(muf);// our one-shots  (follows .sfx)
      const bed = c.createGain(); bed.gain.value = 1; bed.connect(muf);      // ambience + layer (follows .music)
      const mus = c.createGain(); mus.gain.value = 0; mus.connect(bed);
      const amb = c.createGain(); amb.gain.value = 1; amb.connect(bed);
      return { dest: dest, lim: lim, ui: ui, duck: duck, muf: muf, game: game,
        world: world, bed: bed, mus: mus, amb: amb };
    }

    function adopt(c) {
      if (AC || !c) return;
      const b = buildBus(c);
      if (!b) return;
      AC = c; BUS = b;
      try { // shadow LAST — a half-built chain must never become the game's output
        Object.defineProperty(c, 'destination', { value: b.game, configurable: true, enumerable: false });
        shadowed = (c.destination === b.game);
      } catch (e) { shadowed = false; }
    }

    (function patchCtx() {
      const names = ['AudioContext', 'webkitAudioContext'];
      for (let i = 0; i < names.length; i++) {
        const k = names[i], Native = window[k];
        if (typeof Native !== 'function' || Native.__rfJuice) continue;
        const Patched = function (a) {
          const c = new Native(a);
          try { adopt(c); } catch (e) { RF.warn('juice:feel:adopt', e); }
          return c;
        };
        Patched.prototype = Native.prototype;
        Patched.__rfJuice = true;
        try { window[k] = Patched; } catch (e) {}
      }
    })();

    /* the belt to that patch's braces: if the context was already alive when we loaded we
       still get our own buses — we simply cannot duck or muffle the game's half of the mix */
    function grab() { if (!AC && RF.audio && RF.audio.ctx) adopt(RF.audio.ctx); return !!AC; }

    const ready = () => !!(AC && BUS && AC.state !== 'closed');
    const audible = () => ready() && !RF.muted;
    const anow = () => anowCtx();
    const anowCtx = () => AC.currentTime;

    /* Phase two of the wiring, and it cannot happen at adopt() time: we take the context
       INSIDE its constructor, before initAudio() has built master/music/sfx, so those nodes
       do not exist yet. The moment they do, our one-shots move under the sfx fader and the
       adaptive layer under the music fader — the player's own sliders then govern them for
       free, with no value to mirror. Until then they hang off the muffle and still sound. */
    let attached = false;
    function attachSliders() {
      if (attached || !BUS || !(RF.audio && RF.audio.ready)) return;
      const sN = RF.audio.sfxNode, mN = RF.audio.musicNode;
      if (!sN || !mN) return;
      try {
        BUS.world.disconnect(); BUS.world.connect(sN);
        BUS.bed.disconnect(); BUS.bed.connect(mN);
        attached = true;
      } catch (e) { RF.warn('juice:feel:attach', e); }
    }

    /* the UI bus is the one that cannot ride a fader: it deliberately sits downstream of the
       muffle and the duck so a press always cuts through, which puts it past master too —
       so this one value, and only this one, is mirrored by hand */
    let sailing = false, ambLevel = 1;
    const MIX = { world: 1, ui: 1, bed: 1, amb: 1 };   // last targets, readable so a settings UI can show them
    function followMixer() {
      if (!BUS) return;
      const M = RF.audio || {};
      const m = typeof M.master === 'number' ? M.master : 1;
      const sv = typeof M.sfx === 'number' ? M.sfx : 1;
      const mv = typeof M.music === 'number' ? M.music : 1;
      const gate = (RF.muted || sailing) ? 0 : 1, t = anow();
      MIX.ui = m * sv * gate;
      // MIX is the loudness a listener ends up with, and it is the same in both states:
      // attached the fader is upstream of us, un-attached we mirror it into the node below
      MIX.world = m * sv * gate;
      MIX.bed = m * mv * gate;
      MIX.amb = MIX.bed * ambLevel;
      try {
        BUS.ui.gain.setTargetAtTime(MIX.ui, t, 0.12);
        BUS.world.gain.setTargetAtTime(attached ? gate : MIX.world, t, 0.12);
        // bed is the PARENT of both amb and mus, so the cede rides on amb alone: hand the
        // island over to 13-audio and the adaptive layer still has a bus to speak through
        BUS.bed.gain.setTargetAtTime(attached ? gate : MIX.bed, t, 0.5);
        BUS.amb.gain.setTargetAtTime(gate * ambLevel, t, 0.5);
      } catch (e) {}
    }

    /* ---- voice factory: one gain, an optional pan, self-disconnecting ---- */
    function vout(o) {
      const g = AC.createGain(); g.gain.value = 0.0001;
      let tail = g;
      if (o.pan != null && AC.createStereoPanner) {
        const p = AC.createStereoPanner(); p.pan.value = clamp(o.pan, -1, 1); g.connect(p); tail = p;
      }
      tail.connect(o.bus || BUS.world);
      return { g: g, tail: tail };
    }
    function venv(g, t, d, v, atk) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + (atk || 0.008));
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    }
    function tone(f, d, type, v, o) {
      if (!audible() || !(f > 0)) return;
      o = o || {}; const t = anow() + (o.at || 0), n = vout(o);
      const osc = AC.createOscillator(); osc.type = type || 'sine';
      osc.frequency.setValueAtTime(f, t);
      if (o.to > 0) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
      if (o.det) osc.detune.value = o.det;
      osc.connect(n.g); venv(n.g, t, d, v, o.atk);
      osc.start(t); osc.stop(t + d + 0.03);
      osc.onended = () => { try { osc.disconnect(); n.g.disconnect(); if (n.tail !== n.g) n.tail.disconnect(); } catch (e) {} };
    }
    let NB = null;
    function nbuf() {
      if (!NB) {
        const n = (AC.sampleRate * 1.4) | 0; NB = AC.createBuffer(1, n, AC.sampleRate);
        const d = NB.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      }
      return NB;
    }
    function noise(d, cut, v, o) {
      if (!audible()) return;
      o = o || {}; const t = anow() + (o.at || 0), n = vout(o);
      const src = AC.createBufferSource(); src.buffer = nbuf(); src.loop = true;
      const f = AC.createBiquadFilter(); f.type = o.type || 'lowpass'; f.Q.value = o.q || 1;
      f.frequency.setValueAtTime(Math.max(20, cut), t);
      if (o.to > 0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + d);
      src.connect(f); f.connect(n.g); venv(n.g, t, d, v, o.atk);
      // a random read head means the same burst is never literally the same samples twice
      src.start(t, Math.random()); src.stop(t + d + 0.04);
      src.onended = () => { try { src.disconnect(); f.disconnect(); n.g.disconnect(); if (n.tail !== n.g) n.tail.disconnect(); } catch (e) {} };
    }

    /* duck: every real impact shoves the world down for a beat so the hit itself reads.
       A watchdog puts the gain back if anything ever leaves it low. */
    let duckUntil = 0;
    function duck(amount, hold) {
      if (!ready()) return;
      const t = anow(), g = BUS.duck.gain, lo = clamp(1 - amount, 0.35, 1);
      try {
        g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(lo, t + 0.018);
        g.linearRampToValueAtTime(1, t + 0.018 + (hold || 0.2));
      } catch (e) {}
      duckUntil = t + 0.018 + (hold || 0.2);
    }

    /* ══════════════════════════════════════════════════════════════════════
       G1-G3. AMBIENCE — four running noise beds whose gain and cutoff are
       steered by where you stand and what the sky is doing. Started once, never
       restarted; targets are written at 5 Hz through setTargetAtTime so nothing
       zippers, and an LFO summed onto each gain gives the bed its own swell.
       ══════════════════════════════════════════════════════════════════════ */
    const AMB = {
      surf: { type: 'lowpass', q: 0.7, cut: 620, lfo: 0.11, wob: 0.35 },
      wind: { type: 'bandpass', q: 0.55, cut: 900, lfo: 0.07, wob: 0.30 },
      rain: { type: 'bandpass', q: 0.4, cut: 2600, lfo: 0.23, wob: 0.12 },
      room: { type: 'lowpass', q: 0.8, cut: 210, lfo: 0.04, wob: 0.25 }
    };
    let ambBuilt = false;
    function buildAmb() {
      if (ambBuilt || !ready()) return;
      ambBuilt = true;
      for (const k in AMB) {
        const L = AMB[k];
        const src = AC.createBufferSource(); src.buffer = nbuf(); src.loop = true;
        const f = AC.createBiquadFilter(); f.type = L.type; f.Q.value = L.q; f.frequency.value = L.cut;
        const g = AC.createGain(); g.gain.value = 0;
        const lfo = AC.createOscillator(); lfo.frequency.value = L.lfo;
        const lg = AC.createGain(); lg.gain.value = 0;
        lfo.connect(lg); lg.connect(g.gain);
        src.connect(f); f.connect(g); g.connect(BUS.amb);
        src.start(0); lfo.start(0);
        L.src = src; L.f = f; L.node = g; L.lg = lg;
      }
    }
    function ambSet(L, gain, cut) {
      if (!L.node) return;
      const t = anow();
      try {
        L.node.gain.setTargetAtTime(gain, t, 0.45);
        L.lg.gain.setTargetAtTime(gain * L.wob, t, 0.6);
        L.f.frequency.setTargetAtTime(cut, t, 0.7);
      } catch (e) {}
    }

    const isCave = () => !!(RF.WORLD && RF.WORLD.cave);
    const isFrost = () => RF.worldKey === 'frost';
    const isVolc = () => RF.worldKey === 'volcano';
    /* nearestWater() only sees a 7x7 patch, so beyond it we just say "far" — which is
       exactly right: up in the rocks the sea should have fallen away to nothing */
    const waterDist = () => { const w = fn.nearestWater(); return w ? w.dist : 12; };

    let gustT = 6, dripT = 3, crickT = 1.4, popT = 2;
    function ambTick() {
      if (!ready()) return;
      buildAmb();
      if (!ambBuilt) return;
      const P = RF.pWorld, h = fn.heightAt(P.x, P.z), g = fn.cellType(h);
      const w = RF.weather, cave = isCave(), night = fn.isNight();
      const alt = clamp((h - 3) / 9, 0, 1);
      const near = 1 - clamp((waterDist() - 1.1) / 8, 0, 1);   // 1 at the waterline, 0 eight cells inland

      // surf — the loudest thing on an isle, and the first thing that says the sea is that way
      ambSet(AMB.surf,
        cave ? 0.010 : 0.085 * near * (w === 'storm' ? 1.9 : w === 'rain' ? 1.25 : 1) * (night ? 0.88 : 1),
        cave ? 180 : 560 + (w === 'storm' ? 520 : 0) + near * 180);
      // wind — altitude and weather; underground there is none, which is the point
      ambSet(AMB.wind,
        cave ? 0.006 : (0.011 + alt * 0.05) * (w === 'storm' ? 2.4 : w === 'snow' ? 1.7 : w === 'ash' ? 1.3 : 1) * (night ? 0.85 : 1),
        700 + alt * 900 + (w === 'storm' ? 700 : 0) - (night ? 140 : 0));
      // precipitation — snow is nearly silent on purpose: what you hear is everything else missing
      ambSet(AMB.rain,
        w === 'rain' ? 0.050 : w === 'storm' ? 0.085 : w === 'snow' ? 0.011 : w === 'ash' ? 0.030 : 0,
        w === 'ash' ? 900 : w === 'snow' ? 5200 : 2500);
      // room tone — the held breath of stone
      ambSet(AMB.room, cave ? 0.055 : g === 'stone' ? 0.030 : 0.004, cave ? 150 : 230);

      // the whole game leans back after dusk and swells at dawn — only possible because we own the bus
      if (shadowed) { try { BUS.game.gain.setTargetAtTime(night ? 0.86 : 1, anow(), 1.6); } catch (e) {} }
      // panels take the screen, so let them take the room too. The casino is exempt: the wheel's
      // ticks ARE the tension there, and a dull wheel is a broken wheel.
      const heavy = RF.marketOpen || RF.invOpen || RF.harborOpen;
      try {
        BUS.muf.frequency.setTargetAtTime(
          heavy ? 900 : RF.capCam ? 1900 : RF.chatOpen ? 4200 : 20000, anow(), 0.16);
      } catch (e) {}
    }

    /* discrete ambience: the things that happen, as opposed to the things that hum */
    const groundAt = () => fn.cellType(fn.heightAt(RF.pWorld.x, RF.pWorld.z));  // only called on an event
    function ambEvents(rdt) {
      if (!audible() || !RF.running) return;
      const cave = isCave(), w = RF.weather;

      if ((gustT -= rdt) <= 0) {
        gustT = rand(7, 16) / (w === 'storm' ? 2.4 : 1);
        if (!cave && decor()) noise(rand(1.6, 2.9), 640,
          (w === 'storm' ? 0.055 : 0.022) * (0.6 + clamp(fn.heightAt(RF.pWorld.x, RF.pWorld.z) / 12, 0, 1)),
          { type: 'bandpass', q: 0.5, to: 1700, atk: 0.7, pan: rand(-0.7, 0.7) });
      }
      if ((dripT -= rdt) <= 0) {
        dripT = cave ? rand(1.6, 4.6) : rand(5, 12);
        if (decor() && (cave || groundAt() === 'stone')) { // a plink with a fast fall: cheap, unmistakable
          const f = rand(900, 1700), pan = rand(-0.75, 0.75);
          tone(f, 0.16, 'sine', 0.030, { to: f * 0.42, pan: pan });
          noise(0.05, 2600, 0.012, { type: 'bandpass', q: 2.2, pan: pan });
          if (cave) tone(f * 0.5, 0.22, 'sine', 0.010, { to: f * 0.25, pan: -pan, at: 0.19 }); // the shaft answers
        }
      }
      if ((crickT -= rdt) <= 0) {
        crickT = rand(0.6, 2.1);
        if (decor() && fn.isNight() && !cave && !isFrost() && !isVolc() && w === 'clear' && groundAt() !== 'stone') {
          const pan = rand(-0.85, 0.85), f = rand(4100, 4900);
          for (let i = 0; i < 3; i++) tone(f, 0.022, 'triangle', 0.008, { pan: pan, at: i * 0.035 });
        }
      }
      if ((popT -= rdt) <= 0) {
        popT = rand(0.9, 3.4);
        if (decor() && isVolc() && groundAt() === 'stone') {   // the crater keeps clearing its throat
          noise(rand(0.05, 0.13), rand(300, 700), 0.030, { type: 'bandpass', q: 1.4, to: 140, pan: rand(-0.6, 0.6) });
          if (Math.random() < 0.25) tone(rand(50, 70), 0.5, 'sine', 0.035, { to: 34 });
        }
      }
    }

    /* dawn chorus and dusk owl — once each per in-game day, and only where birds would live */
    let lastDayPhase = -1;
    function skyVoices() {
      if (!audible() || !RF.running || isCave() || isVolc()) return;
      const d = RF.dayT, phase = d < 0.13 ? 0 : d < 0.22 ? 1 : d < 0.66 ? 2 : d < 0.74 ? 3 : 4;
      if (phase === lastDayPhase) return;
      const prev = lastDayPhase; lastDayPhase = phase;
      if (prev < 0) return;                     // never sing on the very first read
      if (phase === 1) {                        // sunrise: bright calls answering each other
        const base = isFrost() ? 2400 : 1900;
        [0, 0.19, 0.33, 0.62].forEach((at, i) => {
          const f = base * (1 + i * 0.14);
          tone(f, 0.075, 'triangle', 0.020, { to: f * 1.35, at: at, pan: rand(-0.6, 0.6) });
          tone(f * 1.5, 0.05, 'sine', 0.010, { at: at + 0.045, pan: rand(-0.6, 0.6) });
        });
      } else if (phase === 4) {                 // dusk: one low, patient hoot, then its echo
        tone(320, 0.42, 'sine', 0.024, { to: 262, pan: rand(-0.4, 0.4) });
        tone(320, 0.34, 'sine', 0.018, { to: 262, at: 0.55, pan: rand(-0.4, 0.4) });
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
       G4. THE SECOND VOICE — a layer that sits under game.js's own chiptune
       loop, in the same key and at the same step length so the two never argue.
       It has four things to say and stays quiet otherwise.
       ══════════════════════════════════════════════════════════════════════ */
    const KEYS = {
      isle:    { root: 261.63, sc: [0, 2, 4, 7, 9],  step: 0.24 },  // C major pentatonic
      mine:    { root: 220.00, sc: [0, 3, 5, 7, 10], step: 0.27 },  // A minor pentatonic
      volcano: { root: 293.66, sc: [0, 1, 5, 7, 8],  step: 0.20 },  // D phrygian: the isle's own threat
      frost:   { root: 293.66, sc: [0, 2, 5, 7, 10], step: 0.32 },
      cave:    { root: 261.63, sc: [0, 3, 5, 7, 10], step: 0.30 }
    };
    const K = KEYS[RF.worldKey] || KEYS.isle;
    const semi = n => Math.pow(2, n / 12);
    function deg(i) {
      const L = K.sc.length, o = Math.floor(i / L), s = K.sc[((i % L) + L) % L];
      return K.root * semi(s) * Math.pow(2, o);
    }
    function lnote(t, f, type, v, d) {
      if (!audible() || !(f > 0)) return;
      const g = AC.createGain(); g.gain.value = 0.0001;
      const osc = AC.createOscillator(); osc.type = type; osc.frequency.value = f;
      osc.connect(g); g.connect(BUS.mus);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.start(t); osc.stop(t + d + 0.05);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
    }
    let mNext = 0, mStep = 0, mMode = 'calm', mInt = 0, mSchedT = 0;
    // calm schedules almost nothing, so its bus may stay open for the one bell it does play
    const MODE_GAIN = { calm: 0.45, tense: 0.55, hunt: 1, deep: 0.7 };
    function pickMode() {
      const f = RF.fishing, m = RF.mining;
      if (m && m.node && m.node.geode) { mInt = clamp(m.t / Math.max(0.1, m.dur), 0, 1); return 'deep'; }
      if (f && f.state === 'reel') {
        mInt = clamp(f.tens, 0, 1);
        if (f.hooked && (RORDER[f.hooked.rar] || 0) >= 3) return 'hunt';   // an epic or better is on the line
        return 'tense';
      }
      mInt = 0; return 'calm';
    }
    function musSched() {
      if (!audible() || !RF.running) { mNext = 0; return; }
      const t = anow();
      if (mNext < t) { mNext = t + 0.06; mStep = 0; }
      const night = fn.isNight();
      while (mNext < t + 0.30) {
        const s = mStep & 15, bar = (mStep >> 4) & 3;
        if (mMode === 'tense') {
          if (s % 4 === 0) lnote(mNext, deg(-7), 'triangle', 0.055, K.step * 1.7);           // pedal under the fight
          if (s === 2 || s === 10) lnote(mNext, deg(-7) * 0.5, 'sine', 0.030 + 0.030 * mInt, K.step * 1.1); // heartbeat
          if (mInt > 0.6 && (s === 6 || s === 14)) lnote(mNext, deg(1 + ((mStep >> 2) & 3)), 'square', 0.020 * mInt, K.step * 0.7);
        } else if (mMode === 'hunt') {
          const seq = [0, 2, 4, 6, 4, 2];
          if (s % 2 === 0) lnote(mNext, deg(seq[(s >> 1) % 6]), 'square', 0.022, K.step * 0.8);
          if (s === 0) lnote(mNext, deg(-7), 'sawtooth', 0.040, K.step * 3);
          if (s === 8) lnote(mNext, deg(-5), 'sawtooth', 0.030, K.step * 2);
        } else if (mMode === 'deep') {
          if (s === 0 || s === 8) lnote(mNext, deg(-7), 'sine', 0.060, K.step * 4);
          if (s === 6 && (bar & 1)) lnote(mNext, deg(4), 'triangle', 0.020, K.step * 3);
        } else if (night && s === 12 && bar === 2) {
          lnote(mNext, deg(7), 'sine', 0.016, K.step * 4);                                   // one bell a night, no more
        }
        mNext += K.step; mStep++;
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
       G7. STINGS — short, in key, and each used for exactly one thing.
       ══════════════════════════════════════════════════════════════════════ */
    const STING = {
      danger() {                                    // the line is going to go
        tone(deg(0) * 0.5, 0.20, 'sawtooth', 0.030, { to: deg(1) * 0.5 });
        tone(deg(0) * 0.5, 0.20, 'sawtooth', 0.022, { to: deg(1) * 0.5, det: 22 }); // a detuned twin beats: unease
        tone(deg(4), 0.14, 'triangle', 0.018, { at: 0.10 });
      },
      snap() {                                      // it went
        noise(0.09, 3200, 0.10, { type: 'bandpass', q: 1.4, to: 700 });
        tone(deg(2), 0.42, 'sawtooth', 0.048, { to: deg(-9) });
        tone(deg(-7) * 0.5, 0.55, 'sine', 0.055, { to: deg(-12) * 0.5, at: 0.02 });
      },
      nearmiss() {                                  // it got away, and you were close
        tone(deg(2), 0.13, 'triangle', 0.030, { to: deg(1) });
        tone(deg(0), 0.30, 'triangle', 0.026, { at: 0.11, to: deg(-1) });
      },
      land(rar, shiny) {                            // rarity cadence, resolving the tension layer
        const n = RORDER[rar] || 0;
        if (n < 2 && !shiny) { tone(deg(4), 0.16, 'sine', 0.018, { at: 0.06 }); return; }
        const top = 7 + Math.min(3, n - 1);
        [[0, 0], [2, 0.07], [4, 0.14], [top, 0.21]].forEach(p => tone(deg(p[0]), 0.30, 'triangle', 0.032, { at: p[1] }));
        tone(deg(top) * 2, 0.45, 'sine', 0.014, { at: 0.24 });
        if (shiny) for (let i = 0; i < 5; i++) tone(deg(9 + i), 0.09, 'sine', 0.013, { at: 0.30 + i * 0.055, pan: rand(-0.6, 0.6) });
        if (n >= 4) tone(deg(-7) * 0.5, 0.9, 'sine', 0.055, { at: 0.05 });      // a legendary gets a floor under it
      },
      houseWins() {                                 // the eel ate it: felt more than heard
        tone(deg(-7) * 0.5, 0.75, 'sine', 0.070, { to: deg(-14) * 0.5 });
        tone(deg(1), 0.40, 'sawtooth', 0.020, { to: deg(-2), at: 0.06 });
      },
      bigWin() {
        tone(deg(-7) * 0.5, 1.0, 'sine', 0.075, { at: 0.02 });
        for (let i = 0; i < 4; i++) tone(deg(7 + i * 2), 0.5, 'sine', 0.016, { at: 0.18 + i * 0.09 });
      },
      hookSet() {                                   // the moment the rod loads up
        tone(deg(-7), 0.10, 'square', 0.045, { to: deg(-3) });
        noise(0.07, 1400, 0.035, { type: 'bandpass', q: 1.1, to: 500 });
      },
      nudge() { tone(deg(-9) * 0.5, 0.08, 'sine', 0.020, { bus: BUS && BUS.ui, to: deg(-12) * 0.5 }); }
    };

    /* ══════════════════════════════════════════════════════════════════════
       G6. SOUND VARIATION — the roster game.js ships is good; what it lacks is
       variance. These re-authors keep the character and add pitch, pan and
       read-head jitter, so a hundred footfalls are a hundred footfalls.
       ══════════════════════════════════════════════════════════════════════ */
    const orig = {};
    for (const k in sfx) orig[k] = sfx[k];

    /* the reel's last honest reading: cancelFish() zeroes tension the instant a line snaps,
       so by the time anything downstream looks, the drama has already been erased */
    let lastTens = 0, lastReel = 0, lastCatchAt = -9;

    const lastAt = Object.create(null);
    function sgate(k, ms) { const t = Date.now(); if (lastAt[k] && t - lastAt[k] < ms) return false; lastAt[k] = t; return true; }

    // footfalls: surface colour, a body thump, alternating feet, cloth every fourth step,
    // and a slapback underground, because the Undermine is a room
    const SURF = {
      grass:  { d: 0.075, f: 2200, to: 880,  v: 0.034, q: 0.9, t: 150, tv: 0.012 },
      sand:   { d: 0.085, f: 1500, to: 600,  v: 0.032, q: 0.7, t: 128, tv: 0.014 },
      stone:  { d: 0.055, f: 1050, to: 380,  v: 0.042, q: 1.6, t: 190, tv: 0.016 },
      snow:   { d: 0.095, f: 3200, to: 1400, v: 0.030, q: 0.8, t: 210, tv: 0.008 },
      seabed: { d: 0.160, f: 800,  to: 240,  v: 0.050, q: 0.7, t: 96,  tv: 0.018 }
    };
    let footL = 1, footN = 0;
    sfx.step = k => {
      if (!audible()) return;
      const S = SURF[k] || SURF.grass;
      footL = -footL; footN++;
      const j = 1 + rand(-0.12, 0.12), pan = footL * 0.26, g = rand(0.84, 1.14);
      noise(S.d * j, S.f * j, S.v * g, { type: 'bandpass', q: S.q, to: S.to * j, pan: pan });
      tone(S.t * j, 0.065, 'sine', S.tv * g, { pan: pan, to: S.t * 0.66 });
      if (footN % 4 === 0) noise(0.05, 3400, 0.011, { type: 'bandpass', q: 1.5, to: 1800, pan: -pan });  // cloth
      if (isCave()) noise(S.d, S.f * 0.55, S.v * 0.26, { type: 'bandpass', q: 1.1, to: S.to * 0.5, pan: -pan, at: 0.115 });
    };

    sfx.pick = () => {
      if (!audible() || !sgate('pick', 55)) return;
      const j = 1 + rand(-0.15, 0.15);
      noise(0.055, 2600 * j, 0.045, { type: 'bandpass', q: 2.6, to: 900 * j });
      tone(360 * j, 0.055, 'square', 0.036, { to: 190 * j });
      tone(96 * j, 0.11, 'sine', 0.030, { to: 62 });
    };
    sfx.chop = () => {
      if (!audible() || !sgate('chop', 55)) return;
      const j = 1 + rand(-0.13, 0.13);
      noise(0.095, 1650 * j, 0.085, { type: 'bandpass', q: 1.7, to: 480 * j });
      tone(185 * j, 0.075, 'square', 0.045, { to: 120 * j });
      tone(70, 0.16, 'sine', 0.028, { to: 48 });
    };
    sfx.dig = () => {
      if (!audible() || !sgate('dig', 55)) return;
      const j = 1 + rand(-0.16, 0.16);
      noise(0.14, 720 * j, 0.075, { type: 'lowpass', q: 0.8, to: 170 });
      tone(112 * j, 0.09, 'sine', 0.044, { to: 74 });
    };
    sfx.splash = v => {
      if (!audible()) return;
      const j = 1 + rand(-0.18, 0.18), a = (typeof v === 'number' && v > 0) ? v : 0.07;
      noise(0.28 * j, 940 * j, a, { type: 'lowpass', q: 0.7, to: 210 });
      noise(0.10, 4200, a * 0.35, { type: 'bandpass', q: 1.1, to: 1600 });
      tone(430 * j, 0.09, 'sine', a * 0.4, { to: 260 });
    };
    sfx.reel = () => {
      if (!audible() || !sgate('reel', 60)) return;
      const f = rand(190, 300);
      tone(f, 0.05, 'sawtooth', 0.026, { to: f * 0.8, pan: rand(-0.2, 0.2) });
    };
    sfx.creak = () => {
      if (!audible() || !sgate('creak', 200)) return;
      const f = rand(220, 320);
      noise(0.32, f, 0.045, { type: 'bandpass', q: 7, to: f * 2.1 });
    };
    sfx.sparkle = () => {
      if (!audible() || !sgate('sparkle', 40)) return;
      tone(rand(1500, 2300), 0.06, 'triangle', 0.021, { pan: rand(-0.7, 0.7) });
    };

    /* wraps: keep what the engine says, add what it feels like. They double as the
       events RF has no hook for — thunder, the meteor's boom, the shutter. */
    function wrapSfx(name, extra) {
      const o = orig[name];
      if (typeof o !== 'function') return;
      sfx[name] = function () {
        try { extra.apply(null, arguments); } catch (e) { RF.warn('juice:feel:sfx:' + name, e); }
        return o.apply(sfx, arguments);
      };
    }
    wrapSfx('bite', () => { STING.hookSet(); duck(0.18, 0.12); flash(0.10, 'rgba(255,207,92,.5)'); });
    wrapSfx('miss', () => { if (lastTens < 0.85) { STING.nearmiss(); vigPulse(0.35, 'rgba(255,93,122,.85)'); } });
    wrapSfx('deny', () => { vigPulse(0.30, 'rgba(255,93,122,.9)'); duck(0.12, 0.1); });
    wrapSfx('ore', () => { tone(deg(9), 0.22, 'sine', 0.014, { at: 0.06 }); duck(0.2, 0.16); });
    wrapSfx('thunder', () => { lightning(1); duck(0.42, 0.55); });
    wrapSfx('rumble', () => { lightning(0.42); duck(0.2, 0.35); });
    wrapSfx('boom', () => { impact(rand(-1, 1), rand(-1, 1), 0.16, 0.9); chroma(1); flash(0.5, 'rgba(255,207,92,.8)'); duck(0.5, 0.5); });
    wrapSfx('win', () => { punch(0.16); duck(0.24, 0.3); });
    wrapSfx('jackpot', () => { STING.bigWin(); punch(0.34); chroma(0.7); flash(0.4, 'rgba(255,207,92,.85)'); duck(0.35, 0.4); });
    wrapSfx('lose', () => { STING.houseWins(); vigPulse(0.55, 'rgba(255,93,122,.9)'); duck(0.28, 0.3); });
    wrapSfx('ach', () => { punch(0.18); });
    wrapSfx('craft', () => { punch(0.13); });
    wrapSfx('sail', () => { duck(0.3, 1.2); });
    wrapSfx('shutter', () => { flash(0.55, 'rgba(255,255,255,.9)'); });
    wrapSfx('sell', () => { tone(deg(7), 0.22, 'sine', 0.012, { at: 0.10 }); });
    wrapSfx('pearl', () => { tone(deg(11), 0.3, 'sine', 0.010, { at: 0.09 }); });

    /* ══════════════════════════════════════════════════════════════════════
       SCREEN-SPACE DRAMA — one fixed layer driven by CSS custom properties that
       are only written when they actually change. The rarity bloom belongs to
       the visual pass above; this one owns the tension vignette, the chromatic
       split on heavy hits, and lightning.
       z-index 3 on purpose: above the world and core's #vig, BELOW the HUD at 5.
       A flash that covers the coin counter is a bug, not drama.
       ══════════════════════════════════════════════════════════════════════ */
    RF.css(`
    #rf-juice-fx{position:fixed;inset:0;pointer-events:none;z-index:3;
      --rf-jv:0;--rf-jb:0;--rf-jf:0;--rf-jc:0;--rf-jcx:0;
      --rf-jvc:rgba(255,93,122,.9);--rf-jbc:rgba(255,207,92,.5);--rf-jfc:rgba(255,255,255,.9);}
    #rf-juice-fx>i{position:absolute;inset:0;display:block;will-change:opacity;}
    .rf-juice-tv{background:radial-gradient(118% 96% at 50% 46%,rgba(0,0,0,0) 42%,var(--rf-jvc) 122%);opacity:var(--rf-jv);}
    .rf-juice-tb{background:radial-gradient(58% 46% at 50% 40%,var(--rf-jbc) 0%,rgba(0,0,0,0) 74%);opacity:var(--rf-jb);}
    .rf-juice-tf{background:var(--rf-jfc);opacity:var(--rf-jf);}
    .rf-juice-car{background:radial-gradient(96% 80% at 50% 50%,rgba(0,0,0,0) 56%,rgba(255,93,122,.5) 100%);
      opacity:var(--rf-jc);transform:translate3d(calc(var(--rf-jcx)*1px),0,0);}
    .rf-juice-cab{background:radial-gradient(96% 80% at 50% 50%,rgba(0,0,0,0) 56%,rgba(57,215,196,.5) 100%);
      opacity:var(--rf-jc);transform:translate3d(calc(var(--rf-jcx)*-1px),0,0);}
    body.photo #rf-juice-fx{display:none!important;}
    #rf-juice-fx.rf-juice-still .rf-juice-car,#rf-juice-fx.rf-juice-still .rf-juice-cab{display:none;}
    body.rf-reduced #rf-juice-fx .rf-juice-car,body.rf-reduced #rf-juice-fx .rf-juice-cab{display:none;}
    @media (prefers-reduced-motion:reduce){#rf-juice-fx .rf-juice-car,#rf-juice-fx .rf-juice-cab{display:none;}}
    `, 'rf-juice-feel-css');
    const fxEl = RF.el('<div id="rf-juice-fx" aria-hidden="true"><i class="rf-juice-tv"></i><i class="rf-juice-tb"></i>'
      + '<i class="rf-juice-car"></i><i class="rf-juice-cab"></i><i class="rf-juice-tf"></i></div>');

    const FX = { vig: 0, vigHold: 0, bloom: 0, flash: 0, chroma: 0, vigC: '', bloomC: '', flashC: '' };
    const WROTE = { jv: -1, jb: -1, jf: -1, jc: -1, jcx: -1, jvc: '', jbc: '', jfc: '' };
    const VAR = { jv: '--rf-jv', jb: '--rf-jb', jf: '--rf-jf', jc: '--rf-jc', jcx: '--rf-jcx',
      jvc: '--rf-jvc', jbc: '--rf-jbc', jfc: '--rf-jfc' };
    function setVar(k, v) { if (!fxEl || WROTE[k] === v) return; WROTE[k] = v; fxEl.style.setProperty(VAR[k], v); }
    const fxScale = () => (REDUCE ? 0.45 : 1);

    function vigPulse(a, col) { if (!visuals) return; FX.vigHold = Math.max(FX.vigHold, a * fxScale()); if (col) FX.vigC = col; }
    function feelBloom(a, col) { if (!visuals) return; FX.bloom = Math.min(1, FX.bloom + a * fxScale()); if (col) FX.bloomC = col; }
    function flash(a, col) { if (!visuals) return; FX.flash = Math.min(0.85, FX.flash + a * fxScale()); if (col) FX.flashC = col; }
    function chroma(a) { if (!visuals || REDUCE || !decor()) return; FX.chroma = Math.min(1, FX.chroma + a); }
    function lightning(power) {
      // two flashes, the second weaker and a beat later — the shape real lightning has
      flash(0.30 * power, 'rgba(214,240,255,.9)');
      setTimeout(() => { flash(0.16 * power, 'rgba(214,240,255,.85)'); }, 95 + (Math.random() * 60 | 0));
    }

    function fxTick(rdt) {
      if (!fxEl) return;
      // line tension owns the vignette while a fish is on: nothing else may touch it there
      let vTarget = 0, vCol = FX.vigC || 'rgba(255,93,122,.9)';
      const f = RF.fishing;
      if (visuals && RF.running && f && f.state === 'reel') {
        const t = clamp(f.tens, 0, 1);
        vTarget = t * t * 0.82 * fxScale();
        vCol = t > 0.72 ? 'rgba(255,93,122,.95)' : t > 0.45 ? 'rgba(255,207,92,.8)' : 'rgba(57,215,196,.65)';
      }
      FX.vigHold = Math.max(0, FX.vigHold - rdt * 1.6);
      FX.vig = lerp(FX.vig, Math.max(vTarget, FX.vigHold), 1 - Math.exp(-11 * rdt));
      FX.bloom = Math.max(0, FX.bloom - rdt * 1.25);
      FX.flash = Math.max(0, FX.flash - rdt * 4.2);
      FX.chroma = Math.max(0, FX.chroma - rdt * 3.4);

      setVar('jv', +FX.vig.toFixed(3));
      setVar('jb', +FX.bloom.toFixed(3));
      setVar('jf', +FX.flash.toFixed(3));
      setVar('jc', +(FX.chroma * 0.75).toFixed(3));
      setVar('jcx', +(FX.chroma * 9).toFixed(2));
      if (vCol !== WROTE.jvc) setVar('jvc', vCol);
      if (FX.bloomC && FX.bloomC !== WROTE.jbc) setVar('jbc', FX.bloomC);
      if (FX.flashC && FX.flashC !== WROTE.jfc) setVar('jfc', FX.flashC);
    }

    /* ══════════════════════════════════════════════════════════════════════
       G8-G9. CAMERA + IMPACT — a post-pass that runs after game.js has aimed
       the camera and before the renderer draws, so it adds to that work instead
       of fighting it. Everything here is a pure translation, a frustum scale or
       a roll about the view axis: the aim point is never disturbed.
       ══════════════════════════════════════════════════════════════════════ */
    const CAM = { pk: 0, pv: 0, drift: 0, idle: 0, leanX: 0, leanZ: 0, px: 0, pz: 0, seeded: false };
    const HITS = []; const HIT_MAX = 5;
    let shakeLoad = 0;

    // 5.5 converts "how big is this moment" into spring velocity: with w=7.87 and z=0.70 the peak
    // frustum squeeze lands near a*0.32, so a legendary tightens the frame by roughly 9%
    function punch(a) { if (!camMotion || !visuals) return; CAM.pv -= a * 5.5 * (REDUCE ? 0.4 : 1) * (RF.capCam || RF.photoMode ? 0.35 : 1); }
    function impact(dx, dz, amp, roll) {
      amp = RF.pipe('shake', amp, { src: 'juice' });   // the same pipe core's addShake() runs through
      if (!(amp > 0) || !camMotion || !visuals) return;
      if (HITS.length >= HIT_MAX) HITS.shift();
      // the budget: a chain of hits gets progressively politer instead of shaking you to pieces
      const damp = 1 / (1 + shakeLoad * 1.7);
      const a = amp * damp * (REDUCE ? 0.3 : 1) * (RF.capCam || RF.photoMode ? 0.3 : 1);
      shakeLoad += amp;
      const L = Math.hypot(dx, dz) || 1;
      HITS.push({ x: dx / L, z: dz / L, a: a, t: 0, f: rand(26, 34), d: rand(7, 10),
        r: (roll || 0) * (REDUCE ? 0 : 1) * (Math.random() < 0.5 ? -1 : 1) });
    }

    const camAdd = { x: 0, y: 0, z: 0 };
    function camPass(rdt) {
      const cam = RF.camera; if (!cam) return;
      camAdd.x = camAdd.y = camAdd.z = 0;
      let roll = 0;

      // punch: a spring, not a decay, so the frame snaps in and settles back with one small overshoot
      CAM.pv += (-CAM.pk * 62 - CAM.pv * 11) * rdt;
      CAM.pk += CAM.pv * rdt;
      if (Math.abs(CAM.pk) < 0.0006 && Math.abs(CAM.pv) < 0.002) { CAM.pk = 0; CAM.pv = 0; }

      // directional shake: each impact is a damped sine ALONG the direction the hit came from
      shakeLoad = Math.max(0, shakeLoad - rdt * 1.1);
      for (let i = HITS.length - 1; i >= 0; i--) {
        const h = HITS[i]; h.t += rdt;
        const e = Math.exp(-h.d * h.t);
        if (e < 0.02) { HITS.splice(i, 1); continue; }
        const s = Math.sin(h.t * h.f) * h.a * e;
        camAdd.x += h.x * s; camAdd.z += h.z * s; camAdd.y += s * 0.35;
        roll += h.r * e * Math.sin(h.t * h.f * 0.7);
      }

      if (RF.running && !RF.capCam && !RF.photoMode) {
        // lean: the view trails your run by a hair, which is what gives movement weight
        const P = RF.pWorld;
        if (!CAM.seeded) { CAM.px = P.x; CAM.pz = P.z; CAM.seeded = true; }
        const vx = (P.x - CAM.px) / Math.max(rdt, 0.001), vz = (P.z - CAM.pz) / Math.max(rdt, 0.001);
        CAM.px = P.x; CAM.pz = P.z;
        const lk = 1 - Math.exp(-3.5 * rdt);
        CAM.leanX = lerp(CAM.leanX, clamp(vx, -8, 8) * 0.028, lk);
        CAM.leanZ = lerp(CAM.leanZ, clamp(vz, -8, 8) * 0.028, lk);
        if (!REDUCE && camMotion && visuals) { camAdd.x += CAM.leanX; camAdd.z += CAM.leanZ; }

        // idle drift: leave the hero alone for twelve seconds and the camera starts to wander
        const busy = RF.keys.up || RF.keys.down || RF.keys.left || RF.keys.right || RF.keys.act
          || RF.panelOpen || RF.chatOpen || (RF.fishing && RF.fishing.state !== 'idle') || (RF.mining && RF.mining.node);
        CAM.idle = busy ? 0 : CAM.idle + rdt;
        const want = (!REDUCE && camMotion && visuals && CAM.idle > 12) ? clamp((CAM.idle - 12) / 3.5, 0, 1) : 0;
        CAM.drift = lerp(CAM.drift, want, 1 - Math.exp(-2 * rdt));
        if (CAM.drift > 0.002) {
          const a = RF.clock * 0.09, amp = CAM.drift * 0.42;
          camAdd.x += Math.cos(a) * amp; camAdd.z += Math.sin(a * 1.13) * amp;
          camAdd.y += Math.sin(a * 0.61) * amp * 0.5;
        }
      } else { CAM.idle = 0; CAM.drift = 0; CAM.leanX = 0; CAM.leanZ = 0; CAM.seeded = false; }

      if (camAdd.x || camAdd.y || camAdd.z) { cam.position.x += camAdd.x; cam.position.y += camAdd.y; cam.position.z += camAdd.z; }
      if (roll) cam.rotateZ(roll * 0.02);    // applied to a fresh lookAt each frame, so it never accumulates
      if (CAM.pk) {
        // an ortho camera punches by shrinking its frustum; game.js just wrote it, so scaling is safe
        const s = 1 / (1 + clamp(-CAM.pk, -0.18, 0.26));
        cam.left *= s; cam.right *= s; cam.top *= s; cam.bottom *= s;
        cam.updateProjectionMatrix();
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
       G10. INSTANT ANSWER — nothing you press may go unacknowledged.
       ══════════════════════════════════════════════════════════════════════ */
    function wake() {
      if (gestured) return; gestured = true;
      try { fn.initAudio(); } catch (e) {}
      try { if (RF.audio && RF.audio.resume) RF.audio.resume(); } catch (e) {}
    }
    addEventListener('pointerdown', wake, { passive: true, capture: true });
    addEventListener('keydown', wake, { passive: true, capture: true });

    let nudgeT = -1;            // counts down after an E press that found nothing to do
    RF.on('keydown', e => {
      wake();
      if (!RF.running || RF.chatOpen) return;                    // never speak over the chat box
      if (e.code === 'KeyE' || e.code === 'Space') {
        const f = RF.fishing, m = RF.mining, c = RF.chopping, d = RF.digging;
        const idle = f.state === 'idle' && !m.node && !c.tree && !d.active;
        if (idle && !RF.panelOpen) nudgeT = 0.16;                // give the engine a couple of frames to answer
        else if (audible()) tone(deg(-2), 0.035, 'square', 0.020, { bus: BUS.ui });
      } else if (e.code >= 'Digit1' && e.code <= 'Digit5' && !RF.panelOpen && audible()) {
        // a mechanical thock, pitched by slot, so the hotbar answers before the icon has moved
        const i = +e.code.slice(5) - 1;
        tone(180 + i * 26, 0.045, 'square', 0.030, { bus: BUS.ui, to: 110 + i * 18 });
        noise(0.03, 2600, 0.016, { type: 'bandpass', q: 2, bus: BUS.ui });
      }
      return undefined;                                          // this layer never claims a key
    });

    /* the held tools sing back: a strain voice on the rod, a grind on the pick. One oscillator
       created once and left running at silence — smoother and cheaper than a voice per frame. */
    let held = null;
    function heldVoice() {
      if (held || !ready()) return held;
      const osc = AC.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 90;
      const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300; f.Q.value = 3.5;
      const g = AC.createGain(); g.gain.value = 0;
      osc.connect(f); f.connect(g); g.connect(BUS.world); osc.start(0);
      held = { osc: osc, f: f, g: g };
      return held;
    }
    function heldTick() {
      if (!ready()) return;
      const h = heldVoice(); if (!h) return;
      let freq = 90, cut = 300, vol = 0;
      if (audible() && RF.running) {
        const f = RF.fishing, m = RF.mining;
        if (f.state === 'reel') {
          const t = clamp(f.tens, 0, 1);
          freq = 74 + t * 150; cut = 240 + t * 1500; vol = (RF.keys.act ? 0.055 : 0.014) * (0.35 + t * 0.8);
        } else if (m.node && RF.keys.act) {
          const p = clamp(m.t / Math.max(0.1, m.dur), 0, 1);
          freq = 56 + p * 34; cut = 210 + p * 340; vol = 0.030;
        }
      }
      const t = anow();
      try {
        h.osc.frequency.setTargetAtTime(freq, t, 0.06);
        h.f.frequency.setTargetAtTime(cut, t, 0.08);
        h.g.gain.setTargetAtTime(vol, t, vol > 0 ? 0.05 : 0.12);
      } catch (e) {}
    }

    /* ══════════════════════════════════════════════════════════════════════
       THE GAME TALKS BACK — event wiring. The rarity bloom and the floating
       values belong to the visual pass above; this half answers in sound, in
       camera and in the mix.
       ══════════════════════════════════════════════════════════════════════ */
    RF.on('catch', (f, info) => {
      if (!f) return;
      lastCatchAt = RF.clock;
      const n = RORDER[f.rar] || 0;
      STING.land(f.rar, !!f.shiny);
      if (n >= 2 || f.shiny) {
        punch(n >= 4 ? 0.30 : n >= 3 ? 0.19 : 0.11);
        if (n >= 4) { chroma(0.5); duck(0.35, 0.45); }
      }
      if (f.shiny) chroma(0.35);
      if (info && info.isNew) punch(0.14);
      // a landed fish is an upward impact: the rod comes up, so the camera does too
      impact(rand(-0.3, 0.3), rand(-0.3, 0.3), 0.03 + n * 0.018, n >= 3 ? 0.5 : 0);
    });
    RF.on('mined', d => {
      if (!d) return;
      const n = d.node;
      if (n) impact(RF.pWorld.x - n.x, RF.pWorld.z - n.z, d.geode ? 0.14 : 0.055, d.geode ? 0.9 : 0.25);
      if (d.geode) { punch(0.26); chroma(0.6); duck(0.4, 0.35); }
      if (d.combo > 2) tone(deg(4 + Math.min(6, d.combo)), 0.18, 'triangle', 0.020, { at: 0.10 });
    });
    RF.on('chopped', d => { if (d && d.tree) impact(RF.pWorld.x - d.tree.x, RF.pWorld.z - d.tree.z, 0.05, 0.3); });
    RF.on('dug', () => impact(rand(-1, 1), rand(-1, 1), 0.03, 0));
    RF.on('spin', d => { if (d && d.won) punch(0.2); });
    RF.on('weather', (w, prev) => {
      if (!RF.running || w === prev) return;
      if (w === 'storm') { duck(0.3, 1.4); vigPulse(0.30, 'rgba(87,183,255,.7)'); }
      else if (w === 'clear') vigPulse(0.10, 'rgba(57,215,196,.45)');
    });
    RF.on('travel', () => { sailing = true; if (ready()) followMixer(); });   // the isle fades out under the sail
    RF.on('panel', () => { if (ready()) duck(0.12, 0.14); });
    RF.on('muted', () => { if (ready()) followMixer(); });
    RF.on('start', () => { grab(); readComfort(); });

    /* fishing-state watcher: the two moments the engine has no event for — the hook-set,
       and the line letting go. Both want a beat of hit-stop. */
    let fState = 'idle', dangerArmed = false;
    function fishWatch() {
      const f = RF.fishing, s = f.state;
      if (s !== fState) {
        if (fState === 'bite' && s === 'reel') {           // the hook-set: 50ms of stop, felt not heard
          fn.addFreeze(0.05); impact(rand(-1, 1), rand(-1, 1), 0.045, 0.4); dangerArmed = false;
        } else if (fState === 'reel' && s === 'idle') {
          // a snap is "tension at the line's limit AND the fish not landed". lastTens/lastReel are
          // last frame's, because cancelFish() has already zeroed the real ones; the catch guard
          // covers the online path, where landing resolves later and changes no state of its own.
          if (lastTens >= 0.88 && lastReel < 0.97 && RF.clock - lastCatchAt > 0.3) {
            STING.snap(); fn.addFreeze(0.07); impact(rand(-1, 1), rand(-1, 1), 0.11, 0.8);
            chroma(0.55); vigPulse(0.7, 'rgba(255,93,122,.95)'); duck(0.4, 0.35);
          }
          dangerArmed = false;
        }
        fState = s;
      }
      if (s === 'reel') {
        if (!dangerArmed && f.tens > 0.72) { dangerArmed = true; STING.danger(); vigPulse(0.5, 'rgba(255,93,122,.9)'); }
        else if (dangerArmed && f.tens < 0.5) dangerArmed = false;   // re-arms once you have given it slack
        lastTens = f.tens; lastReel = f.reel;
      } else if (s === 'idle') { lastTens = 0; lastReel = 0; }
    }

    /* 13-audio owns "the living soundscape" in the mod contract. If it ever publishes one, our
       bed is the duplicate: it stands down and leaves the stings, camera and mix bus in place.
       Two ambient beds over one island is worse than either alone. */
    let ambOn = true, ceded = false;
    function cedeAmbience() {
      if (ceded || !ambOn) return;
      const api = RF.api;
      if (api && (api.soundscape || api.ambience)) { ceded = true; ambOn = false; }
    }

    /* ---- the loop: one frame hook, everything expensive throttled, nothing allocated ---- */
    let slowT = 0, heldT = 0, comfortT = 0;
    RF.on('frame', (dt, rdt) => {
      try {
        rdt = rdt || dt || 0.016;
        if ((comfortT -= rdt) <= 0) { comfortT = 0.5; readComfort(); }
        camPass(rdt);
        fxTick(rdt);
        if (!ready() && !grab()) return;

        if ((mSchedT -= rdt) <= 0) { mSchedT = 0.09; musSched(); }
        if ((heldT -= rdt) <= 0) { heldT = 0.05; heldTick(); }

        if ((slowT -= rdt) <= 0) {
          slowT = 0.2;
          cedeAmbience();
          ambLevel = ambOn ? (RF.running ? 1 : 0.5) : 0;    // the title screen keeps a quieter isle
          attachSliders();   // initAudio() can build master/music/sfx at any gesture, so keep asking
          followMixer();
          if (ambOn) ambTick();
          if (ambOn) skyVoices();     // one-shots ride the sfx bus, so the cede has to gate them by hand
          if (RF.running) {
            const mode = pickMode();
            if (mode !== mMode) { mMode = mode; mStep = 0; mNext = 0; }
            const g = MODE_GAIN[mMode] * (mMode === 'tense' ? 0.45 + mInt * 0.55 : 1) * (fn.isNight() ? 0.88 : 1);
            try { BUS.mus.gain.setTargetAtTime(RF.muted ? 0 : g, anow(), 0.55); } catch (e) {}
          } else {
            try { BUS.mus.gain.setTargetAtTime(0, anow(), 0.4); } catch (e) {}
          }
          // watchdog: the duck must always come home, whatever else went wrong
          if (anow() > duckUntil + 0.4 && BUS.duck.gain.value < 0.98) {
            try {
              const t = anow(); BUS.duck.gain.cancelScheduledValues(t);
              BUS.duck.gain.setValueAtTime(BUS.duck.gain.value, t);
              BUS.duck.gain.linearRampToValueAtTime(1, t + 0.25);
            } catch (e) {}
          }
        }
        if (!RF.running) return;
        if (ambOn) ambEvents(rdt);
        fishWatch();
        if (nudgeT > 0 && (nudgeT -= rdt) <= 0) {
          nudgeT = -1;
          const f = RF.fishing, m = RF.mining, c = RF.chopping, d = RF.digging;
          if (f.state === 'idle' && !m.node && !c.tree && !d.active && !RF.panelOpen) STING.nudge();
        }
      } catch (e) { RF.err('juice:feel:frame', e); }
    });

    /* leaving the page: stop the beds rather than let a suspended context keep holding them */
    addEventListener('pagehide', () => {
      try {
        for (const k in AMB) if (AMB[k].src) { AMB[k].src.stop(); AMB[k].src.disconnect(); }
        if (held) { held.osc.stop(); held.osc.disconnect(); }
      } catch (e) {}
    }, { once: true });

    /* hang the feel surface off the pass's own api object rather than replacing it,
       so another mod can borrow an impact or a sting instead of reinventing one */
    RF.api = RF.api || {};
    RF.api.juice = RF.api.juice || {};
    RF.api.juice.feel = {
      punch: punch, impact: impact, duck: duck,
      flash: flash, bloom: feelBloom, vignette: vigPulse, chroma: chroma,
      tone: tone, noise: noise, sting: STING,
      setAmbience(v) { ambOn = !!v; ceded = true; },     // 13-audio may switch our bed off by hand
      get bus() { return BUS; },
      get mix() { return MIX; },
      get reduced() { return REDUCE; }
    };
  })(RF);
});
