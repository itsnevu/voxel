/* 07-juice — the feel pass: sound that listens to the world, a camera that breathes,
   impacts you can feel in your hands. Every sound here is procedural WebAudio.
   1.  Living ambience — a positional bed per biome: surf swells at the waterline, wind rises on the ridge,
       the stone holds a room tone, the Undermine drips.
   2.  Weather in the air — rain hiss, storm gusts, snow's thin dead air, ash grit; lightning you SEE.
   3.  Night hush & the dawn chorus — the whole mix leans back after dusk, crickets come up, birds at sunrise.
   4.  The second voice — an adaptive score layer in the isle's own key: tense on the reel, predatory when
       something big is hooked, patient inside a geode, one soft bell a night when nothing is happening.
   5.  The mix bus — a limiter, a duck on every impact, a muffle when a panel takes the screen.
   6.  No two the same — footsteps, picks, axes and splashes get pitch/timbre variation and a repeat gate.
   7.  Stings — a line-tension warning, a near-miss, a rarity cadence, a house-wins fall, all in key.
   8.  A camera that breathes — punch-in on the big ones, a slow idle drift, a lean into your run, spring settle.
   9.  Impact grammar — directional shake with a roll, a shake budget so it never nauseates, micro hit-stop.
   10. Screen-space drama — a vignette that tightens with the line, chromatic flash on heavy hits, a rarity bloom.
   11. Instant answer — the first press wakes the audio, E always replies, holding E sings back at you. */
RF.mod('07-juice', function (RF) {
  'use strict';
  const fn = RF.fn, sfx = RF.sfx;
  const clamp = fn.clamp, lerp = fn.lerp, rand = fn.rand, TAU = RF.TAU || Math.PI * 2;
  const RORDER = RF.RORDER || {}, RAR = RF.RAR || {};

  /* Reduced motion is a promise, not a suggestion: it kills the drift, the lean, the roll and the
     chromatic split outright, and halves what is left. Two sources say it — the OS media query and
     10-comfort's `body.rf-reduced` — and either one is enough. Audio is untouched: motion sickness
     comes from the picture. `rfQuality:'low'` additionally drops every decorative extra.
     Both are re-read on the slow tick because the settings panel can flip them mid-game. */
  let REDUCE = false, QUALITY = 'high', camMotion = true;
  const decor = () => QUALITY !== 'low';
  function readComfort() {
    let r = false;
    try { r = !!matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    try { if (document.body.classList.contains('rf-reduced')) r = true; } catch (e) {}
    if (r !== REDUCE) { REDUCE = r; if (fxEl) fxEl.classList.toggle('rf-juice-still', REDUCE); }
    try { QUALITY = (document.body.dataset && document.body.dataset.rfQuality) || 'high'; } catch (e) {}
    // 10-comfort kills camera trauma by returning 0 from the `shake` pipe; take that as
    // "no camera motion at all" and stand the drift, lean and roll down with it
    camMotion = RF.pipe('shake', 1, { src: 'juice:probe' }) > 0;
  }

  /* ══════════════════════════════════════════════════════════════════════
     1. THE MIX BUS
     game.js now builds a real mixer (master -> music/sfx) inside initAudio(),
     but there is still nothing between that mixer and the speakers. We take the
     context the instant it is born — before initAudio() has wired master to the
     output — and shadow `destination`, so the finished game mix arrives on a bus
     we can duck, muffle and limit. Our own voices hang off sibling buses that
     MIRROR RF.audio.master/music/sfx, so the settings panel's sliders govern
     them exactly as they govern everything else. If any of it fails we degrade
     to plain playback rather than going silent.
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
    // gentle bus glue, not a brickwall: a jackpot over thunder over footsteps must not clip,
    // but a lone footstep must not get pumped either
    lim.threshold.value = -14; lim.knee.value = 16; lim.ratio.value = 5;
    lim.attack.value = 0.004; lim.release.value = 0.22;
    lim.connect(dest);

    // a press is the one thing that must always cut through: ui skips both muffle and duck
    const ui = c.createGain(); ui.gain.value = 1; ui.connect(lim);
    const duck = c.createGain(); duck.gain.value = 1; duck.connect(lim);
    const muf = c.createBiquadFilter(); muf.type = 'lowpass'; muf.Q.value = 0.35;
    muf.frequency.value = 20000; muf.connect(duck);                       // transparent until a panel opens
    const game = c.createGain(); game.gain.value = 1; game.connect(muf);  // everything game.js plays
    const world = c.createGain(); world.gain.value = 1; world.connect(muf); // our one-shots  (follows .sfx)
    const bed = c.createGain(); bed.gain.value = 1; bed.connect(muf);      // ambience + layer (follows .music)
    const mus = c.createGain(); mus.gain.value = 0; mus.connect(bed);
    const amb = c.createGain(); amb.gain.value = 1; amb.connect(bed);
    return { dest: dest, lim: lim, ui: ui, duck: duck, muf: muf, game: game, world: world, bed: bed, mus: mus, amb: amb };
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
  /* the belt to the constructor patch's braces: if the context was already alive when we
     loaded, we still get our own buses — we just cannot duck or muffle the game's half */
  function grab() { if (!AC && RF.audio && RF.audio.ctx) adopt(RF.audio.ctx); return !!AC; }

  /* mirror the player's three sliders onto our buses, and stand everything down while sailing */
  let sailing = false, bedLevel = 1;
  function followMixer() {
    if (!BUS) return;
    const M = RF.audio || {};
    const m = typeof M.master === 'number' ? M.master : 1;
    const sv = typeof M.sfx === 'number' ? M.sfx : 1;
    const mv = typeof M.music === 'number' ? M.music : 1;
    const gate = (RF.muted || sailing) ? 0 : 1, t = T();
    try {
      BUS.world.gain.setTargetAtTime(m * sv * gate, t, 0.12);
      BUS.ui.gain.setTargetAtTime(m * sv * gate, t, 0.12);
      BUS.bed.gain.setTargetAtTime(m * mv * gate * bedLevel, t, 0.5);
    } catch (e) {}
  }

  (function patchCtx() {
    const names = ['AudioContext', 'webkitAudioContext'];
    for (let i = 0; i < names.length; i++) {
      const k = names[i], Native = window[k];
      if (typeof Native !== 'function' || Native.__rfJuice) continue;
      const Patched = function (a) { const c = new Native(a); try { adopt(c); } catch (e) { RF.warn('juice:adopt', e); } return c; };
      Patched.prototype = Native.prototype;
      Patched.__rfJuice = true;
      try { window[k] = Patched; } catch (e) {}
    }
  })();

  const ready = () => !!(AC && BUS && AC.state !== 'closed');
  const audible = () => ready() && !RF.muted;
  const T = () => AC.currentTime;

  /* ---- voice factory: one gain, an optional pan, self-disconnecting ---- */
  function out(o) {
    const g = AC.createGain(); g.gain.value = 0.0001;
    let tail = g;
    if (o.pan != null && AC.createStereoPanner) {
      const p = AC.createStereoPanner(); p.pan.value = clamp(o.pan, -1, 1); g.connect(p); tail = p;
    }
    tail.connect(o.bus || BUS.world);
    return { g: g, tail: tail };
  }
  function env(g, t, d, v, atk) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t + (atk || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  }
  function tone(f, d, type, v, o) {
    if (!audible() || !(f > 0)) return;
    o = o || {}; const t = T() + (o.at || 0), n = out(o);
    const osc = AC.createOscillator(); osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f, t);
    if (o.to > 0) osc.frequency.exponentialRampToValueAtTime(o.to, t + d);
    if (o.det) osc.detune.value = o.det;
    osc.connect(n.g); env(n.g, t, d, v, o.atk);
    osc.start(t); osc.stop(t + d + 0.03);
    osc.onended = () => { try { osc.disconnect(); n.g.disconnect(); if (n.tail !== n.g) n.tail.disconnect(); } catch (e) {} };
  }
  let NB = null;
  function nbuf() {
    if (!NB) { const n = (AC.sampleRate * 1.4) | 0; NB = AC.createBuffer(1, n, AC.sampleRate);
      const d = NB.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
    return NB;
  }
  function noise(d, cut, v, o) {
    if (!audible()) return;
    o = o || {}; const t = T() + (o.at || 0), n = out(o);
    const src = AC.createBufferSource(); src.buffer = nbuf(); src.loop = true;
    const f = AC.createBiquadFilter(); f.type = o.type || 'lowpass'; f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(Math.max(20, cut), t);
    if (o.to > 0) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + d);
    src.connect(f); f.connect(n.g); env(n.g, t, d, v, o.atk);
    // a random read head means the same "burst" is never literally the same samples twice
    src.start(t, Math.random()); src.stop(t + d + 0.04);
    src.onended = () => { try { src.disconnect(); f.disconnect(); n.g.disconnect(); if (n.tail !== n.g) n.tail.disconnect(); } catch (e) {} };
  }

  /* duck: every real impact shoves the whole world down for a beat so the hit itself reads.
     A watchdog puts the gain back if anything ever leaves it low. */
  let duckUntil = 0;
  function duck(amount, hold) {
    if (!ready()) return;
    const t = T(), g = BUS.duck.gain, lo = clamp(1 - amount, 0.35, 1);
    try {
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(lo, t + 0.018);
      g.linearRampToValueAtTime(1, t + 0.018 + (hold || 0.2));
    } catch (e) {}
    duckUntil = t + 0.018 + (hold || 0.2);
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. AMBIENCE — four running noise beds whose gain and cutoff are steered by
     where you stand and what the sky is doing. Started once, never restarted;
     targets are written at 5 Hz through setTargetAtTime so nothing zippers.
     ══════════════════════════════════════════════════════════════════════ */
  const A = {
    surf: { type: 'lowpass', q: 0.7, cut: 620, lfo: 0.11, wob: 0.35, g: 0, c: 620 },
    wind: { type: 'bandpass', q: 0.55, cut: 900, lfo: 0.07, wob: 0.30, g: 0, c: 900 },
    rain: { type: 'bandpass', q: 0.4, cut: 2600, lfo: 0.23, wob: 0.12, g: 0, c: 2600 },
    room: { type: 'lowpass', q: 0.8, cut: 210, lfo: 0.04, wob: 0.25, g: 0, c: 210 }
  };
  let ambBuilt = false;
  function buildAmb() {
    if (ambBuilt || !ready()) return;
    ambBuilt = true;
    for (const k in A) {
      const L = A[k];
      const src = AC.createBufferSource(); src.buffer = nbuf(); src.loop = true;
      const f = AC.createBiquadFilter(); f.type = L.type; f.Q.value = L.q; f.frequency.value = L.cut;
      const g = AC.createGain(); g.gain.value = 0;
      // the swell: an LFO summed onto the gain param, so surf breathes and wind gusts on its own
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
    const t = T();
    try {
      L.node.gain.setTargetAtTime(gain, t, 0.45);
      L.lg.gain.setTargetAtTime(gain * L.wob, t, 0.6);
      L.f.frequency.setTargetAtTime(cut, t, 0.7);
    } catch (e) {}
  }

  const isCave = () => !!(RF.WORLD && RF.WORLD.cave);
  const isFrost = () => RF.worldKey === 'frost';
  const isVolc = () => RF.worldKey === 'volcano';

  /* how far from open water, in cells — nearestWater() only sees a 7×7 patch, so beyond it we
     just say "far" and the surf falls away, which is exactly right when you are up in the rocks */
  function waterDist() { const w = fn.nearestWater(); return w ? w.dist : 12; }

  let ambT = 0, gustT = 6, dripT = 3, crickT = 1.4, popT = 2;
  function ambTick() {
    if (!ready()) return;
    buildAmb();
    if (!ambBuilt) return;
    const P = RF.pWorld, h = fn.heightAt(P.x, P.z), ground = fn.cellType(h);
    const w = RF.weather, cave = isCave(), night = fn.isNight();
    const alt = clamp((h - 3) / 9, 0, 1);
    const wd = waterDist();
    const nearShore = 1 - clamp((wd - 1.1) / 8, 0, 1);      // 1 at the waterline, 0 eight cells inland

    // surf — the loudest thing on an isle, and the first thing that tells you the sea is that way
    ambSet(A.surf,
      cave ? 0.010 : 0.085 * nearShore * (w === 'storm' ? 1.9 : w === 'rain' ? 1.25 : 1) * (night ? 0.88 : 1),
      cave ? 180 : 560 + (w === 'storm' ? 520 : 0) + nearShore * 180);
    // wind — altitude and weather; underground there is none, which is the point
    ambSet(A.wind,
      cave ? 0.006 : (0.011 + alt * 0.05) * (w === 'storm' ? 2.4 : w === 'snow' ? 1.7 : w === 'ash' ? 1.3 : 1) * (night ? 0.85 : 1),
      700 + alt * 900 + (w === 'storm' ? 700 : 0) - (night ? 140 : 0));
    // precipitation — snow is nearly silent on purpose: what you hear is the absence of everything else
    ambSet(A.rain,
      w === 'rain' ? 0.050 : w === 'storm' ? 0.085 : w === 'snow' ? 0.011 : w === 'ash' ? 0.030 : 0,
      w === 'ash' ? 900 : w === 'snow' ? 5200 : 2500);
    // room tone — the held breath of stone
    ambSet(A.room, cave ? 0.055 : ground === 'stone' ? 0.030 : 0.004, cave ? 150 : 230);

    try { BUS.amb.gain.setTargetAtTime(RF.running ? 1 : 0.5, T(), 1.2); } catch (e) {}
    // the whole game leans back after dusk and swells at dawn — only possible because we own the bus
    if (shadowed) {
      try { BUS.game.gain.setTargetAtTime(night ? 0.86 : 1, T(), 1.6); } catch (e) {}
    }
    // panels take the screen, so let them take the room too. The casino is exempt: the wheel's
    // ticks ARE the tension, and a dull wheel is a broken wheel.
    const heavy = RF.marketOpen || RF.invOpen || RF.harborOpen;
    try { BUS.muf.frequency.setTargetAtTime(heavy ? 900 : RF.capCam ? 1900 : RF.chatOpen ? 4200 : 20000, T(), 0.16); } catch (e) {}
  }

  /* discrete ambience: things that happen, not things that hum */
  const ground = () => fn.cellType(fn.heightAt(RF.pWorld.x, RF.pWorld.z));  // only ever called on an event
  function ambEvents(rdt) {
    if (!audible() || !RF.running) return;
    const cave = isCave(), w = RF.weather;

    if ((gustT -= rdt) <= 0) {
      gustT = rand(7, 16) / (w === 'storm' ? 2.4 : 1);
      if (!cave && decor()) noise(rand(1.6, 2.9), 640, (w === 'storm' ? 0.055 : 0.022) * (0.6 + clamp(fn.heightAt(RF.pWorld.x, RF.pWorld.z) / 12, 0, 1)),
        { type: 'bandpass', q: 0.5, to: 1700, atk: 0.7, pan: rand(-0.7, 0.7) });
    }
    if ((dripT -= rdt) <= 0) {
      dripT = cave ? rand(1.6, 4.6) : rand(5, 12);
      if (decor() && (cave || ground() === 'stone')) { // a drip is a pitched plink with a fast fall — cheap, unmistakable
        const f = rand(900, 1700), pan = rand(-0.75, 0.75);
        tone(f, 0.16, 'sine', 0.030, { to: f * 0.42, pan: pan });
        noise(0.05, 2600, 0.012, { type: 'bandpass', q: 2.2, pan: pan });
        if (cave) tone(f * 0.5, 0.22, 'sine', 0.010, { to: f * 0.25, pan: -pan, at: 0.19 }); // the shaft answers
      }
    }
    if ((crickT -= rdt) <= 0) {
      crickT = rand(0.6, 2.1);
      if (decor() && fn.isNight() && !cave && !isFrost() && !isVolc() && w === 'clear' && ground() !== 'stone') {
        const pan = rand(-0.85, 0.85), f = rand(4100, 4900);
        for (let i = 0; i < 3; i++) tone(f, 0.022, 'triangle', 0.008, { pan: pan, at: i * 0.035 });
      }
    }
    if ((popT -= rdt) <= 0) {
      popT = rand(0.9, 3.4);
      if (decor() && isVolc() && ground() === 'stone') { // the crater keeps clearing its throat
        noise(rand(0.05, 0.13), rand(300, 700), 0.030, { type: 'bandpass', q: 1.4, to: 140, pan: rand(-0.6, 0.6) });
        if (Math.random() < 0.25) tone(rand(50, 70), 0.5, 'sine', 0.035, { to: 34 });
      }
    }
  }

  /* dawn chorus / dusk owl — once each per in-game day, and only where birds would live */
  let lastDayPhase = -1;
  function skyVoices() {
    if (!audible() || !RF.running || isCave() || isVolc()) return;
    const d = RF.dayT, phase = d < 0.13 ? 0 : d < 0.22 ? 1 : d < 0.66 ? 2 : d < 0.74 ? 3 : 4;
    if (phase === lastDayPhase) { return; }
    const prev = lastDayPhase; lastDayPhase = phase;
    if (prev < 0) return;                       // never sing on the very first read
    if (phase === 1) {                          // sunrise: three bright answering calls
      const base = isFrost() ? 2400 : 1900;
      [0, 0.19, 0.33, 0.62].forEach((at, i) => {
        const f = base * (1 + i * 0.14);
        tone(f, 0.075, 'triangle', 0.020, { to: f * 1.35, at: at, pan: rand(-0.6, 0.6) });
        tone(f * 1.5, 0.05, 'sine', 0.010, { at: at + 0.045, pan: rand(-0.6, 0.6) });
      });
    } else if (phase === 4) {                   // dusk: one low, patient hoot
      tone(320, 0.42, 'sine', 0.024, { to: 262, pan: rand(-0.4, 0.4) });
      tone(320, 0.34, 'sine', 0.018, { to: 262, at: 0.55, pan: rand(-0.4, 0.4) });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     3. THE SECOND VOICE — an adaptive layer that sits under game.js's own
     chiptune loop, in the same key and at the same step length so the two
     never argue. It has four things to say and stays quiet otherwise.
     ══════════════════════════════════════════════════════════════════════ */
  const KEYS = {
    isle:    { root: 261.63, sc: [0, 2, 4, 7, 9],  step: 0.24 },   // C major pentatonic
    mine:    { root: 220.00, sc: [0, 3, 5, 7, 10], step: 0.27 },   // A minor pentatonic
    volcano: { root: 293.66, sc: [0, 1, 5, 7, 8],  step: 0.20 },   // D phrygian, the isle's threat
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
  const MODE_GAIN = { calm: 0.45, tense: 0.55, hunt: 1, deep: 0.7 };  // calm schedules almost nothing, so its bus may stay open
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
    const t = T();
    if (mNext < t) { mNext = t + 0.06; mStep = 0; }
    const night = fn.isNight();
    while (mNext < t + 0.30) {
      const s = mStep & 15, bar = (mStep >> 4) & 3;
      if (mMode === 'tense') {
        if (s % 4 === 0) lnote(mNext, deg(-7), 'triangle', 0.055, K.step * 1.7);          // pedal under the fight
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
        lnote(mNext, deg(7), 'sine', 0.016, K.step * 4);                                  // one bell a night, no more
      }
      mNext += K.step; mStep++;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     4. STINGS — short, in key, and each used for exactly one thing.
     ══════════════════════════════════════════════════════════════════════ */
  const STING = {
    danger() {                                        // the line is going to go
      tone(deg(0) * 0.5, 0.20, 'sawtooth', 0.030, { to: deg(1) * 0.5 });
      tone(deg(0) * 0.5, 0.20, 'sawtooth', 0.022, { to: deg(1) * 0.5, det: 22 });  // detuned twin = beating = unease
      tone(deg(4), 0.14, 'triangle', 0.018, { at: 0.10 });
    },
    snap() {                                          // it went
      noise(0.09, 3200, 0.10, { type: 'bandpass', q: 1.4, to: 700 });
      tone(deg(2), 0.42, 'sawtooth', 0.048, { to: deg(-9) });
      tone(deg(-7) * 0.5, 0.55, 'sine', 0.055, { to: deg(-12) * 0.5, at: 0.02 });
    },
    nearmiss() {                                      // it got away; you were close
      tone(deg(2), 0.13, 'triangle', 0.030, { to: deg(1) });
      tone(deg(0), 0.30, 'triangle', 0.026, { at: 0.11, to: deg(-1) });
    },
    land(rar, shiny) {                                // rarity cadence, resolving the tension layer
      const n = RORDER[rar] || 0;
      if (n < 2 && !shiny) { tone(deg(4), 0.16, 'sine', 0.018, { at: 0.06 }); return; }
      const top = 7 + Math.min(3, n - 1);
      [[0, 0], [2, 0.07], [4, 0.14], [top, 0.21]].forEach(p => tone(deg(p[0]), 0.30, 'triangle', 0.032, { at: p[1] }));
      tone(deg(top) * 2, 0.45, 'sine', 0.014, { at: 0.24 });
      if (shiny) for (let i = 0; i < 5; i++) tone(deg(9 + i), 0.09, 'sine', 0.013, { at: 0.30 + i * 0.055, pan: rand(-0.6, 0.6) });
      if (n >= 4) tone(deg(-7) * 0.5, 0.9, 'sine', 0.055, { at: 0.05 });     // a legendary gets a floor under it
    },
    houseWins() {                                     // the eel ate it: felt more than heard
      tone(deg(-7) * 0.5, 0.75, 'sine', 0.070, { to: deg(-14) * 0.5 });
      tone(deg(1), 0.40, 'sawtooth', 0.020, { to: deg(-2), at: 0.06 });
    },
    bigWin() {
      tone(deg(-7) * 0.5, 1.0, 'sine', 0.075, { at: 0.02 });
      for (let i = 0; i < 4; i++) tone(deg(7 + i * 2), 0.5, 'sine', 0.016, { at: 0.18 + i * 0.09 });
    },
    hookSet() {                                       // the moment the rod loads up
      tone(deg(-7), 0.10, 'square', 0.045, { to: deg(-3) });
      noise(0.07, 1400, 0.035, { type: 'bandpass', q: 1.1, to: 500 });
    },
    nudge() { tone(deg(-9) * 0.5, 0.08, 'sine', 0.020, { bus: BUS && BUS.ui, to: deg(-12) * 0.5 }); }
  };

  /* ══════════════════════════════════════════════════════════════════════
     5. SOUND VARIATION — the roster game.js ships is good; what it lacks is
     variance. These re-authors keep the same character and add pitch, pan and
     read-head jitter, so a hundred footfalls are a hundred footfalls.
     ══════════════════════════════════════════════════════════════════════ */
  const orig = {};
  for (const k in sfx) orig[k] = sfx[k];

  /* the reel's last honest reading: cancelFish() zeroes tension the instant a line snaps,
     so by the time anything downstream looks, the drama has already been erased */
  let lastTens = 0, lastReel = 0, lastCatchAt = -9;

  const last = Object.create(null);
  function gate(k, ms) { const t = Date.now(); if (last[k] && t - last[k] < ms) return false; last[k] = t; return true; }

  // footfalls: surface colour, a body thump, alternating feet, cloth every fourth step,
  // and a slapback underground because the Undermine is a room
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
    const j = 1 + rand(-0.12, 0.12), pan = footL * 0.26, gain = rand(0.84, 1.14);
    noise(S.d * j, S.f * j, S.v * gain, { type: 'bandpass', q: S.q, to: S.to * j, pan: pan });
    tone(S.t * j, 0.065, 'sine', S.tv * gain, { pan: pan, to: S.t * 0.66 });
    if (footN % 4 === 0) noise(0.05, 3400, 0.011, { type: 'bandpass', q: 1.5, to: 1800, pan: -pan });  // cloth
    if (isCave()) noise(S.d, S.f * 0.55, S.v * 0.26, { type: 'bandpass', q: 1.1, to: S.to * 0.5, pan: -pan, at: 0.115 });
  };

  sfx.pick = () => { if (!audible() || !gate('pick', 55)) return;
    const j = 1 + rand(-0.15, 0.15);
    noise(0.055, 2600 * j, 0.045, { type: 'bandpass', q: 2.6, to: 900 * j });
    tone(360 * j, 0.055, 'square', 0.036, { to: 190 * j });
    tone(96 * j, 0.11, 'sine', 0.030, { to: 62 }); };
  sfx.chop = () => { if (!audible() || !gate('chop', 55)) return;
    const j = 1 + rand(-0.13, 0.13);
    noise(0.095, 1650 * j, 0.085, { type: 'bandpass', q: 1.7, to: 480 * j });
    tone(185 * j, 0.075, 'square', 0.045, { to: 120 * j });
    tone(70, 0.16, 'sine', 0.028, { to: 48 }); };
  sfx.dig = () => { if (!audible() || !gate('dig', 55)) return;
    const j = 1 + rand(-0.16, 0.16);
    noise(0.14, 720 * j, 0.075, { type: 'lowpass', q: 0.8, to: 170 });
    tone(112 * j, 0.09, 'sine', 0.044, { to: 74 }); };
  sfx.splash = v => { if (!audible()) return;
    const j = 1 + rand(-0.18, 0.18), a = (typeof v === 'number' && v > 0) ? v : 0.07;
    noise(0.28 * j, 940 * j, a, { type: 'lowpass', q: 0.7, to: 210 });
    noise(0.10, 4200, a * 0.35, { type: 'bandpass', q: 1.1, to: 1600 });
    tone(430 * j, 0.09, 'sine', a * 0.4, { to: 260 }); };
  sfx.reel = () => { if (!audible() || !gate('reel', 60)) return;
    const f = rand(190, 300);
    tone(f, 0.05, 'sawtooth', 0.026, { to: f * 0.8, pan: rand(-0.2, 0.2) }); };
  sfx.creak = () => { if (!audible() || !gate('creak', 200)) return;
    const f = rand(220, 320);
    noise(0.32, f, 0.045, { type: 'bandpass', q: 7, to: f * 2.1 }); };
  sfx.sparkle = () => { if (!audible() || !gate('sparkle', 40)) return;
    tone(rand(1500, 2300), 0.06, 'triangle', 0.021, { pan: rand(-0.7, 0.7) }); };

  /* wraps: keep what the engine says, add what it feels like */
  function wrap(name, extra) {
    const o = orig[name];
    if (typeof o !== 'function') return;
    sfx[name] = function (a, b) { try { extra(a, b); } catch (e) { RF.warn('juice:sfx:' + name, e); } return o.apply(sfx, arguments); };
  }
  wrap('bite', () => { STING.hookSet(); duck(0.18, 0.12); flash(0.10, 'rgba(255,207,92,.5)'); });
  wrap('miss', () => { if (lastTens < 0.85) { STING.nearmiss(); vigPulse(0.35, 'rgba(255,93,122,.85)'); } });
  wrap('deny', () => { vigPulse(0.30, 'rgba(255,93,122,.9)'); duck(0.12, 0.1); });
  wrap('ore', () => { tone(deg(9), 0.22, 'sine', 0.014, { at: 0.06 }); duck(0.2, 0.16); });
  wrap('thunder', () => { lightning(1); duck(0.42, 0.55); });
  wrap('rumble', () => { lightning(0.42); duck(0.2, 0.35); });
  wrap('boom', () => { impact(rand(-1, 1), rand(-1, 1), 0.16, 0.9); chroma(1); flash(0.5, 'rgba(255,207,92,.8)'); duck(0.5, 0.5); });
  wrap('win', () => { punch(0.16); duck(0.24, 0.3); });
  wrap('jackpot', () => { STING.bigWin(); punch(0.34); chroma(0.7); flash(0.4, 'rgba(255,207,92,.85)'); duck(0.35, 0.4); });
  wrap('lose', () => { STING.houseWins(); vigPulse(0.55, 'rgba(255,93,122,.9)'); duck(0.28, 0.3); });
  wrap('ach', () => { punch(0.18); bloom(0.55, 'rgba(255,207,92,.55)'); });
  wrap('craft', () => { punch(0.13); });
  wrap('sail', () => { duck(0.3, 1.2); });
  wrap('shutter', () => { flash(0.55, 'rgba(255,255,255,.9)'); });
  wrap('sell', () => { tone(deg(7), 0.22, 'sine', 0.012, { at: 0.10 }); });
  wrap('pearl', () => { tone(deg(11), 0.3, 'sine', 0.010, { at: 0.09 }); });

  /* ══════════════════════════════════════════════════════════════════════
     6. SCREEN-SPACE DRAMA — one fixed layer, five children, driven by CSS
     custom properties that are only written when they actually change.
     ══════════════════════════════════════════════════════════════════════ */
  /* z-index 3 on purpose: above the world and core's #vig, BELOW the HUD at 5. A flash that
     covers the coin counter is a bug, not drama — and this band belongs to no mod's panel. */
  RF.css(`
  #rf-juice-fx{position:fixed;inset:0;pointer-events:none;z-index:3;
    --rf-jv:0;--rf-jb:0;--rf-jf:0;--rf-jc:0;--rf-jcx:0;
    --rf-jvc:rgba(255,93,122,.9);--rf-jbc:rgba(255,207,92,.5);--rf-jfc:rgba(255,255,255,.9);}
  #rf-juice-fx>i{position:absolute;inset:0;display:block;will-change:opacity;}
  .rf-juice-vig{background:radial-gradient(118% 96% at 50% 46%,rgba(0,0,0,0) 42%,var(--rf-jvc) 122%);opacity:var(--rf-jv);}
  .rf-juice-bloom{background:radial-gradient(58% 46% at 50% 40%,var(--rf-jbc) 0%,rgba(0,0,0,0) 74%);opacity:var(--rf-jb);}
  .rf-juice-flash{background:var(--rf-jfc);opacity:var(--rf-jf);}
  .rf-juice-car{background:radial-gradient(96% 80% at 50% 50%,rgba(0,0,0,0) 56%,rgba(255,93,122,.5) 100%);
    opacity:var(--rf-jc);transform:translate3d(calc(var(--rf-jcx)*1px),0,0);}
  .rf-juice-cab{background:radial-gradient(96% 80% at 50% 50%,rgba(0,0,0,0) 56%,rgba(57,215,196,.5) 100%);
    opacity:var(--rf-jc);transform:translate3d(calc(var(--rf-jcx)*-1px),0,0);}
  body.photo #rf-juice-fx{display:none!important;}
  #rf-juice-fx.rf-juice-still .rf-juice-car,#rf-juice-fx.rf-juice-still .rf-juice-cab{display:none;}
  body.rf-reduced #rf-juice-fx .rf-juice-car,body.rf-reduced #rf-juice-fx .rf-juice-cab{display:none;}
  @media (prefers-reduced-motion:reduce){#rf-juice-fx .rf-juice-car,#rf-juice-fx .rf-juice-cab{display:none;}}
  `, 'rf-juice-css');
  const fxEl = RF.el('<div id="rf-juice-fx" aria-hidden="true"><i class="rf-juice-vig"></i><i class="rf-juice-bloom"></i>'
    + '<i class="rf-juice-car"></i><i class="rf-juice-cab"></i><i class="rf-juice-flash"></i></div>');

  const FX = { vig: 0, vigHold: 0, bloom: 0, flash: 0, chroma: 0, vigC: '', bloomC: '', flashC: '' };
  const WROTE = { jv: -1, jb: -1, jf: -1, jc: -1, jcx: -1, jvc: '', jbc: '', jfc: '' };
  const VAR = { jv: '--rf-jv', jb: '--rf-jb', jf: '--rf-jf', jc: '--rf-jc', jcx: '--rf-jcx',
    jvc: '--rf-jvc', jbc: '--rf-jbc', jfc: '--rf-jfc' };
  function setVar(k, v) { if (!fxEl || WROTE[k] === v) return; WROTE[k] = v; fxEl.style.setProperty(VAR[k], v); }
  const scale = () => (REDUCE ? 0.45 : 1);

  function vigPulse(a, col) { FX.vigHold = Math.max(FX.vigHold, a * scale()); if (col) FX.vigC = col; }
  function bloom(a, col) { FX.bloom = Math.min(1, FX.bloom + a * scale()); if (col) FX.bloomC = col; }
  function flash(a, col) { FX.flash = Math.min(0.85, FX.flash + a * scale()); if (col) FX.flashC = col; }
  function chroma(a) { if (REDUCE || !decor()) return; FX.chroma = Math.min(1, FX.chroma + a); }
  function lightning(power) {
    // two flashes, the second weaker and a beat later — the shape real lightning has
    flash(0.30 * power, 'rgba(214,240,255,.9)');
    setTimeout(() => { flash(0.16 * power, 'rgba(214,240,255,.85)'); }, 95 + (Math.random() * 60 | 0));
  }

  function fxTick(rdt) {
    if (!fxEl) return;
    // line tension owns the vignette while you are fighting a fish; nothing else may touch it there
    let vTarget = 0, vCol = FX.vigC || 'rgba(255,93,122,.9)';
    const f = RF.fishing;
    if (RF.running && f && f.state === 'reel') {
      const t = clamp(f.tens, 0, 1);
      vTarget = t * t * 0.82 * scale();
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
     7. CAMERA + IMPACT — a post-pass that runs after game.js has aimed the
     camera and before the renderer draws, so we add to its work instead of
     fighting it. Everything here is a pure translation, a frustum scale, or a
     roll about the view axis: the aim point is never disturbed.
     ══════════════════════════════════════════════════════════════════════ */
  const CAM = { pk: 0, pv: 0, drift: 0, idle: 0, leanX: 0, leanZ: 0, px: 0, pz: 0, seeded: false };
  const HITS = []; const HIT_MAX = 5;
  let shakeLoad = 0;

    // 5.5 is the conversion from "how big is this moment" to spring velocity: with w=7.87 and z=0.70
  // the peak frustum squeeze lands at roughly a*0.32, i.e. a legendary tightens the frame ~9%
  function punch(a) { if (!camMotion) return; CAM.pv -= a * 5.5 * (REDUCE ? 0.4 : 1) * (RF.capCam || RF.photoMode ? 0.35 : 1); }
  function impact(dx, dz, amp, roll) {
    // the same pipe core's addShake() runs through, so 10-comfort's "no shake" kills ours too
    amp = RF.pipe('shake', amp, { src: 'juice' });
    if (!(amp > 0) || !camMotion) return;
    if (HITS.length >= HIT_MAX) HITS.shift();
    // the budget: a chain of hits gets progressively politer instead of shaking you to pieces
    const damp = 1 / (1 + shakeLoad * 1.7);
    const a = amp * damp * (REDUCE ? 0.3 : 1) * (RF.capCam || RF.photoMode ? 0.3 : 1);
    shakeLoad += amp;
    const L = Math.hypot(dx, dz) || 1;
    HITS.push({ x: dx / L, z: dz / L, a: a, t: 0, f: rand(26, 34), d: rand(7, 10), r: (roll || 0) * (REDUCE ? 0 : 1) * (Math.random() < 0.5 ? -1 : 1) });
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
      if (!REDUCE && camMotion) { camAdd.x += CAM.leanX; camAdd.z += CAM.leanZ; }

      // idle drift: leave the hero alone for twelve seconds and the camera starts to wander
      const busy = RF.keys.up || RF.keys.down || RF.keys.left || RF.keys.right || RF.keys.act
        || RF.panelOpen || RF.chatOpen || (RF.fishing && RF.fishing.state !== 'idle') || (RF.mining && RF.mining.node);
      CAM.idle = busy ? 0 : CAM.idle + rdt;
      const want = (!REDUCE && camMotion && CAM.idle > 12) ? clamp((CAM.idle - 12) / 3.5, 0, 1) : 0;
      CAM.drift = lerp(CAM.drift, want, 1 - Math.exp(-2 * rdt));
      if (CAM.drift > 0.002) {
        const a = RF.clock * 0.09, amp = CAM.drift * 0.42;
        camAdd.x += Math.cos(a) * amp; camAdd.z += Math.sin(a * 1.13) * amp;
        camAdd.y += Math.sin(a * 0.61) * amp * 0.5;
      }
    } else { CAM.idle = 0; CAM.drift = 0; CAM.leanX = 0; CAM.leanZ = 0; CAM.seeded = false; }

    if (camAdd.x || camAdd.y || camAdd.z) { cam.position.x += camAdd.x; cam.position.y += camAdd.y; cam.position.z += camAdd.z; }
    if (roll) cam.rotateZ(roll * 0.02);         // applied to the fresh lookAt each frame, so it never accumulates
    if (CAM.pk) {
      // an ortho camera punches by shrinking its frustum; game.js just wrote it, so scaling is safe
      const s = 1 / (1 + clamp(-CAM.pk, -0.18, 0.26));
      cam.left *= s; cam.right *= s; cam.top *= s; cam.bottom *= s;
      cam.updateProjectionMatrix();
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     8. INSTANT ANSWER — nothing you press may go unacknowledged.
     ══════════════════════════════════════════════════════════════════════ */
  function wake() {
    if (gestured) return; gestured = true;
    try { fn.initAudio(); } catch (e) {}
    try { if (AC && AC.state === 'suspended') AC.resume(); } catch (e) {}
  }
  addEventListener('pointerdown', wake, { passive: true, capture: true });
  addEventListener('keydown', wake, { passive: true, capture: true });

  let nudgeT = -1;            // counts down after an E press that found nothing
  RF.on('keydown', e => {
    wake();
    if (!RF.running || RF.chatOpen) return;                    // never speak over the chat box
    if (e.code === 'KeyE' || e.code === 'Space') {
      const f = RF.fishing, m = RF.mining, c = RF.chopping, d = RF.digging;
      const idle = f.state === 'idle' && !m.node && !c.tree && !d.active;
      if (idle && !RF.panelOpen) nudgeT = 0.16;                // give the engine a couple of frames to answer
      else if (audible()) tone(deg(-2), 0.035, 'square', 0.020, { bus: BUS.ui });
    } else if (e.code >= 'Digit1' && e.code <= 'Digit5' && !RF.panelOpen) {
      if (audible()) { // a mechanical thock, pitched by slot, so the hotbar answers before the icon moves
        const i = +e.code.slice(5) - 1;
        tone(180 + i * 26, 0.045, 'square', 0.030, { bus: BUS.ui, to: 110 + i * 18 });
        noise(0.03, 2600, 0.016, { type: 'bandpass', q: 2, bus: BUS.ui });
      }
    }
    return undefined;                                          // we never claim a key
  });

  /* the held tools sing back: a strain voice on the rod, a grind on the pick.
     Two oscillators, created once, left running at silence — cheaper and smoother
     than starting a voice every frame you hold E. */
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
    const t = T();
    try {
      h.osc.frequency.setTargetAtTime(freq, t, 0.06);
      h.f.frequency.setTargetAtTime(cut, t, 0.08);
      h.g.gain.setTargetAtTime(vol, t, vol > 0 ? 0.05 : 0.12);
    } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════════════
     9. THE GAME TALKS BACK — event wiring
     ══════════════════════════════════════════════════════════════════════ */
  RF.on('catch', (f, info) => {
    if (!f) return;
    lastCatchAt = RF.clock;
    const n = RORDER[f.rar] || 0;
    STING.land(f.rar, !!f.shiny);
    if (n >= 2 || f.shiny) {
      bloom(n >= 4 ? 0.85 : n >= 3 ? 0.6 : 0.4, RAR[f.rar] ? hexA(RAR[f.rar], n >= 4 ? 0.55 : 0.38) : 'rgba(255,207,92,.45)');
      punch(n >= 4 ? 0.30 : n >= 3 ? 0.19 : 0.11);
      if (n >= 4) { chroma(0.5); duck(0.35, 0.45); }
    }
    if (f.shiny) { chroma(0.35); flash(0.18, 'rgba(255,255,255,.85)'); }
    if (info && info.isNew) punch(0.14);
    // a landed fish is an upward impact: the rod comes up, so the camera does too
    impact(rand(-0.3, 0.3), rand(-0.3, 0.3), 0.03 + n * 0.018, n >= 3 ? 0.5 : 0);
  });
  RF.on('mined', d => {
    if (!d) return;
    const n = d.node;
    if (n) impact(RF.pWorld.x - n.x, RF.pWorld.z - n.z, d.geode ? 0.14 : 0.055, d.geode ? 0.9 : 0.25);
    if (d.geode) { punch(0.26); chroma(0.6); bloom(0.5, 'rgba(94,232,226,.45)'); duck(0.4, 0.35); }
    if (d.combo > 2) tone(deg(4 + Math.min(6, d.combo)), 0.18, 'triangle', 0.020, { at: 0.10 });
  });
  RF.on('chopped', d => { if (d && d.tree) impact(RF.pWorld.x - d.tree.x, RF.pWorld.z - d.tree.z, 0.05, 0.3); });
  RF.on('dug', () => impact(rand(-1, 1), rand(-1, 1), 0.03, 0));
  RF.on('spin', d => { if (d && d.won) { punch(0.2); bloom(0.5, 'rgba(255,207,92,.45)'); } });
  RF.on('weather', (w, prev) => {
    if (!RF.running || w === prev) return;
    if (w === 'storm') { duck(0.3, 1.4); vigPulse(0.30, 'rgba(87,183,255,.7)'); }
    else if (w === 'clear') vigPulse(0.10, 'rgba(57,215,196,.45)');
  });
  RF.on('travel', () => { if (ready()) try { BUS.world.gain.setTargetAtTime(0, T(), 0.18); } catch (e) {} });
  RF.on('panel', () => { if (ready()) duck(0.12, 0.14); });
  function hexA(hex, a) {
    // RAR colours are '#rrggbb' strings; the bloom needs them as rgba
    const h = String(hex).replace('#', '');
    if (h.length < 6) return 'rgba(255,207,92,' + a + ')';
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  /* fishing-state watcher: the two moments the engine has no event for —
     the hook-set, and the line letting go. Both want a beat of hit-stop. */
  let fState = 'idle', dangerArmed = false;
  function fishWatch() {
    const f = RF.fishing, s = f.state;
    if (s !== fState) {
      if (fState === 'bite' && s === 'reel') {  // the hook-set: a 50ms stop is felt, not heard
        fn.addFreeze(0.05); impact(rand(-1, 1), rand(-1, 1), 0.045, 0.4); dangerArmed = false;
      } else if (fState === 'reel' && s === 'idle') {
        // a snap is "tension was at the line's limit AND the fish was not landed". lastTens/lastReel
        // are last frame's, because cancelFish() has already zeroed the real ones; the catch guard
        // covers the online path, where landing resolves later and fires no state change of its own.
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

  /* ══════════════════════════════════════════════════════════════════════
     10. THE LOOP — one frame hook. Everything expensive is throttled;
     nothing here allocates.
     ══════════════════════════════════════════════════════════════════════ */
  let slowT = 0, heldT = 0;
  RF.on('frame', (dt, rdt) => {
    rdt = rdt || dt || 0.016;
    camPass(rdt);
    fxTick(rdt);
    if (!ready()) return;

    if ((mSchedT -= rdt) <= 0) { mSchedT = 0.09; musSched(); }
    if ((heldT -= rdt) <= 0) { heldT = 0.05; heldTick(); }

    if ((slowT -= rdt) <= 0) {
      slowT = 0.2;
      ambTick(); skyVoices();
      if (RF.running) {
        const mode = pickMode();
        if (mode !== mMode) { mMode = mode; mStep = 0; mNext = 0; }
        const g = MODE_GAIN[mMode] * (mMode === 'tense' ? 0.45 + mInt * 0.55 : 1) * (fn.isNight() ? 0.88 : 1);
        try { BUS.mus.gain.setTargetAtTime(RF.muted ? 0 : g, T(), 0.55); } catch (e) {}
      } else {
        try { BUS.mus.gain.setTargetAtTime(0, T(), 0.4); } catch (e) {}
      }
      // watchdog: the duck must always come home, whatever else went wrong
      if (T() > duckUntil + 0.4 && BUS.duck.gain.value < 0.98) {
        try { const t = T(); BUS.duck.gain.cancelScheduledValues(t); BUS.duck.gain.setValueAtTime(BUS.duck.gain.value, t);
          BUS.duck.gain.linearRampToValueAtTime(1, t + 0.25); } catch (e) {}
      }
    }
    if (!RF.running) return;
    ambEvents(rdt);
    fishWatch();
    if (nudgeT > 0 && (nudgeT -= rdt) <= 0) {
      nudgeT = -1;
      const f = RF.fishing, m = RF.mining, c = RF.chopping, d = RF.digging;
      if (f.state === 'idle' && !m.node && !c.tree && !d.active && !RF.panelOpen) STING.nudge();
    }
  });

  /* leaving the page: stop the beds rather than let a suspended context hold them */
  addEventListener('pagehide', () => {
    try {
      for (const k in A) if (A[k].src) { A[k].src.stop(); A[k].src.disconnect(); }
      if (held) { held.osc.stop(); held.osc.disconnect(); }
    } catch (e) {}
  }, { once: true });

  /* a small public surface so the other mods can borrow the feel instead of reinventing it */
  RF.juice = {
    punch: punch, impact: impact, duck: duck,
    flash: flash, bloom: bloom, vignette: vigPulse, chroma: chroma,
    tone: tone, noise: noise, sting: STING,
    get bus() { return BUS; }, get reduced() { return REDUCE; }
  };
});
