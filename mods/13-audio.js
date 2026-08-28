/* ============================================================================
   13-AUDIO — the living soundscape. Core owns one track per isle and one sound
   per action; this is everything in between, so the isle sounds like a PLACE
   and not like a menu with a loop behind it.

   A. THE BED — surf, wind, rain and a per-world layer. Built once, at the first
      'start', and from then on only cross-faded. Nothing here ever restarts, so
      nothing here can ever click.
   B. PLACES — the market, the casino, the harbour, the portal and the mine each
      radiate their own motif, mixed by distance at 5Hz. Every motif is rolled
      fresh — pitch, length, filter, and the offset it reads the noise buffer
      from — so none of them can ever be heard to repeat.
   C. EVENT COLOUR — only what core does NOT already make: a far-off jump out on
      the open water, a bird put up when you run past a tree, rubble settling a
      beat after a node breaks, and a gust in the bed answering the weather card.
   D. TRANSITIONS — every level is a smoothed target: eight seconds for time of
      day, three for weather, a tenth of a second for stepping into the casino.
      No value is ever written straight to an AudioParam.
   E. DISCIPLINE — ONE sub-bus under RF.audio.bus('music'), so the music fader
      and the ♪ mute both govern the whole bed for free. Silent before Set sail,
      silent when muted, and the schedulers are RELEASED (not merely muted) when
      the tab goes away. Look-ahead never exceeds a fifth of a second.

   Node count is bounded and published: forty-odd long-lived nodes plus at most
   RF.api.soundscape.stats().cap concurrent one-shot voices.
   ========================================================================== */
RF.mod('13-audio', function (RF) {
  'use strict';

  const fn = RF.fn, B = document.body;
  const clamp = fn.clamp;
  const TAU = RF.TAU || Math.PI * 2;
  const WK = RF.worldKey || 'isle';
  const CAVE = !!(RF.WORLD && RF.WORLD.cave);
  const rz = (a, b) => a + Math.random() * (b - a);

  /* --------------------------------------------------------------------------
     0. SWITCHES. `enabled` is ours and persists; reduced and quality are ambient
     signals owned by 10-comfort that we only ever read. Quality 'low' stops the
     schedulers dead — the continuous bed stays, because it is six filters and a
     handful of oscillators and it is the whole point of the mod.
     -------------------------------------------------------------------------- */
  let enabled = true;
  const trim = { master: 1, bed: 1, places: 1, events: 1 };
  try {
    const s = RF.store.get('audio', null);
    if (s) {
      if (typeof s.on === 'boolean') enabled = s.on;
      if (s.trim) for (const k in trim) if (typeof s.trim[k] === 'number') trim[k] = clamp(s.trim[k], 0, 1.5);
    }
  } catch (e) { RF.warn('audio:load', e); }
  const persist = function () {
    try { RF.store.set('audio', { on: enabled, trim: trim }); } catch (e) { RF.warn('audio:save', e); }
  };

  const reduced = () => B.classList.contains('rf-reduced');
  const density = function () {            // how busy the schedulers may be
    const q = B.dataset.rfQuality || 'high';
    if (q === 'low') return 0;
    return (q === 'med' ? 0.6 : q === 'ultra' ? 1.25 : 1) * (reduced() ? 0.5 : 1);
  };

  /* --------------------------------------------------------------------------
     1. THE GRAPH. Everything hangs off ONE sub-bus taken from RF.audio.bus, so
     the music slider, the master fader and the ♪ chip all reach us without this
     mod knowing anything about them. Nothing here touches ctx.destination.
     -------------------------------------------------------------------------- */
  let AC = null, root = null, mixBed = null, mixPlace = null, mixEvent = null, windGust = null;
  let WHITE = null, BROWN = null;
  let built = false, awake = true, sailing = false;
  let voices = 0, nodes = 0, fired = 0, peak = 0;
  const CAP = 12;                          // concurrent one-shot voices, hard

  /* Two buffers, generated once and shared by every source. White is hiss, air
     and ticks; brown is the body of surf, of the crater, of anything that has to
     sit UNDER the music rather than in front of it. The brown wrap is blended
     back over its own head, or the loop point thumps once every three seconds. */
  function buffers() {
    const sr = AC.sampleRate, n = (sr * 3) | 0;
    WHITE = AC.createBuffer(1, n, sr);
    const w = WHITE.getChannelData(0);
    for (let i = 0; i < n; i++) w[i] = Math.random() * 2 - 1;
    BROWN = AC.createBuffer(1, n, sr);
    const b = BROWN.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { last = (last + 0.021 * (Math.random() * 2 - 1)) / 1.021; b[i] = last * 6; }
    const blend = (sr * 0.12) | 0;
    for (let i = 0; i < blend; i++) { const u = i / blend; b[i] = b[i] * u + b[n - blend + i] * (1 - u); }
  }

  /* --- node factories -------------------------------------------------------
     Long-lived nodes are counted into `nodes` and never disposed; one-shots are
     counted into `voices` and released by their own source's onended, so a tab
     that stalls mid-motif can never leak a chain. ---------------------------- */
  function gain(dest, v) { const g = AC.createGain(); g.gain.value = v === undefined ? 0 : v; g.connect(dest); nodes++; return g; }
  function filt(type, f, q) { const b = AC.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q === undefined ? 0.7 : q; nodes++; return b; }

  /* A slow swell that never repeats: two LFOs on one gain at rates with no
     common period, so the wave the ear latches onto is never the same twice. */
  function swell(dest, base, depth, r1, r2) {
    const g = gain(dest, base);
    const add = function (hz, d) {
      const o = AC.createOscillator(), a = AC.createGain();
      o.frequency.value = hz; a.gain.value = d; o.connect(a); a.connect(g.gain);
      o.start(AC.currentTime + Math.random() * 4); nodes += 2;
    };
    add(r1, depth); add(r2, depth * 0.62);
    return g;
  }

  /* One continuous layer: source → (highpass) → filter → swell → level → dest. */
  function layer(dest, o) {
    const s = AC.createBufferSource(); s.buffer = o.brown ? BROWN : WHITE; s.loop = true;
    s.playbackRate.value = o.rate || 1; nodes++;
    const f = filt(o.type || 'lowpass', o.f, o.q);
    const lvl = gain(dest, 0);
    const sw = o.swell === false ? lvl : swell(lvl, 0.72, 0.26, o.s1 || 0.061, o.s2 || 0.094);
    f.connect(sw);
    if (o.hp) { const h = filt('highpass', o.hp, 0.6); h.connect(f); s.connect(h); } else s.connect(f);
    s.start(AC.currentTime, Math.random() * 2.8);
    return { g: lvl, f: f, s: s };
  }

  /* --- one-shot voices ----------------------------------------------------- */
  function release(chain, src) {
    voices++; if (voices > peak) peak = voices; fired++;
    src.onended = function () {
      voices--; src.onended = null;
      try { for (let i = 0; i < chain.length; i++) chain[i].disconnect(); } catch (e) {}
    };
  }
  function envelope(g, t0, d, v, o) {
    g.gain.value = 1e-4;
    if (o.curve) {
      const c = o.curve, a = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) a[i] = Math.max(1e-5, c[i] * v);
      try { g.gain.setValueCurveAtTime(a, t0, d); return; } catch (e) { /* fall through to the ramp */ }
    }
    const atk = o.atk || 0.012;
    g.gain.setValueAtTime(1e-4, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, v), t0 + atk);
    if (o.hold) g.gain.setValueAtTime(Math.max(1e-4, v), t0 + atk + o.hold);
    g.gain.exponentialRampToValueAtTime(1e-4, t0 + d);
  }
  /* An oscillator voice. `seq` steps the pitch (that is birdsong); f→f2(→f3)
     glides it (that is an owl, a gull, a portal). */
  function tone(dest, o) {
    if (!dest || !AC || voices >= CAP) return;
    const t0 = o.at || AC.currentTime, d = o.dur || 0.2;
    const os = AC.createOscillator(), g = AC.createGain();
    os.type = o.type || 'sine';
    if (o.seq) { for (let i = 0; i < o.seq.length; i++) os.frequency.setValueAtTime(Math.max(1, o.seq[i][1]), t0 + o.seq[i][0]); }
    else {
      os.frequency.setValueAtTime(Math.max(1, o.f), t0);
      if (o.f2) os.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t0 + (o.gl || d) * (o.f3 ? 0.5 : 1));
      if (o.f3) os.frequency.exponentialRampToValueAtTime(Math.max(1, o.f3), t0 + (o.gl || d));
    }
    if (o.det) os.detune.value = o.det;
    envelope(g, t0, d, o.v || 0.02, o);
    os.connect(g); g.connect(dest); os.start(t0);
    release([os, g], os); os.stop(t0 + d + 0.04);
  }
  /* A filtered-noise voice. Every one reads the buffer from a random offset,
     which is what stops a motif from ever sounding like a sample. */
  function hiss(dest, o) {
    if (!dest || !AC || voices >= CAP) return;
    const t0 = o.at || AC.currentTime, d = o.dur || 0.2;
    const s = AC.createBufferSource(); s.buffer = o.brown ? BROWN : WHITE; s.loop = true;
    s.playbackRate.value = o.rate || 1;
    const f = AC.createBiquadFilter(); f.type = o.type || 'bandpass'; f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(Math.max(20, o.f), t0);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + d);
    const g = AC.createGain();
    envelope(g, t0, d, o.v || 0.02, o);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t0, Math.random() * 2.6);
    release([s, f, g], s); s.stop(t0 + d + 0.04);
  }

  /* --- envelope curves ------------------------------------------------------
     A rattle and a trill are the same voice with a different gain shape, which
     is how a handful of chips or a bird's five notes cost two nodes, not ten. */
  function pips(n, tail) {
    const L = 56, a = new Array(L);
    for (let i = 0; i < L; i++) { const p = (i / L) * n, f = p - Math.floor(p); a[i] = (1 - f) * (1 - f) * Math.pow(1 - i / L, tail || 0); }
    a[L - 1] = 0; return a;
  }
  function rattle(n, decel) {
    const L = 56, a = new Array(L);
    for (let i = 0; i < L; i++) a[i] = 0.02;
    let p = 0, gap = decel ? 2 : 3;
    for (let k = 0; k < n && p < L - 2; k++) {
      const i = p | 0; a[i] = 1 - (i / L) * 0.7; a[i + 1] = 0.3;
      p += gap * (0.6 + Math.random() * 0.9); if (decel) gap *= 1.19;
    }
    a[L - 1] = 0; return a;
  }

  /* --------------------------------------------------------------------------
     2. SMOOTHED PARAMS. Nothing writes an AudioParam directly: a target is set,
     and a per-parameter time constant walks the live value there at 5Hz. That is
     what makes "eight seconds for dusk, three for the weather" one number each
     rather than a pile of hand-rolled ramps.
     -------------------------------------------------------------------------- */
  const P = [];
  function param(ap, tau, init) {
    const o = { p: ap, v: init || 0, t: init || 0, tau: tau || 1, dirty: true };
    if (ap) ap.value = o.v; P.push(o); return o;
  }
  function pump(dt, now) {
    for (let i = 0; i < P.length; i++) {
      const o = P[i], d = o.t - o.v;
      if (Math.abs(d) < 1e-4) { if (!o.dirty) continue; o.v = o.t; o.dirty = false; }
      else { o.v += d * (1 - Math.exp(-dt / o.tau)); o.dirty = true; }
      try { o.p.setTargetAtTime(o.v, now, 0.075); } catch (e) { try { o.p.value = o.v; } catch (_) {} }
    }
  }

  /* --------------------------------------------------------------------------
     3. WORLD PROFILE. Each isle weights the shared layers differently and adds
     at most two of its own, so five worlds cost five rows of numbers instead of
     five graphs. `life` is how much lives here: nothing sings on a lava atoll.
     -------------------------------------------------------------------------- */
  const PROFILE = {
    isle:    { surf: 1.00, wind: 0.85, rain: 1.00, life: 1.00, harbour: 1.45, air: 0.42 },
    mine:    { surf: 0.70, wind: 0.95, rain: 1.00, life: 0.80, harbour: 0.90, air: 0.30 },
    volcano: { surf: 0.80, wind: 1.05, rain: 0.90, life: 0.22, harbour: 0.80, air: 0.24 },
    frost:   { surf: 0.55, wind: 1.20, rain: 0.85, life: 0.30, harbour: 0.80, air: 0.20 },
    cave:    { surf: 0.30, wind: 0.10, rain: 0.00, life: 0.00, harbour: 0.00, air: 0.55 }
  };
  const PRO = PROFILE[WK] || PROFILE.isle;

  /* --------------------------------------------------------------------------
     4. FIXED POINTS. Several of these are null on some isles. The mine has no
     handle on RF at all, so it is found by elimination among the world signs —
     the only scene-level sprites the engine publishes. Ambiguity means silence.
     -------------------------------------------------------------------------- */
  function poi(v) { return v && typeof v.x === 'number' ? { x: v.x, z: v.z } : null; }
  const MARKET = poi(RF.TRADER_POS), CASINO = poi(RF.CASINO_POS);
  const HARBOR = poi(RF.HARBOR_POS), PORTAL = poi(RF.PORTAL_POS);
  const MINE = (function () {
    try {
      const L = RF.LABELS; if (!L || !L.length) return null;
      const known = [MARKET, CASINO, HARBOR, PORTAL], hit = [];
      for (let i = 0; i < L.length; i++) {
        const s = L[i];
        if (!s || !s.position || s.parent !== RF.scene) continue;   // the gate banner rides its gate
        let near = false;
        for (let k = 0; k < known.length; k++) {
          const p = known[k]; if (!p) continue;
          if (Math.hypot(s.position.x - p.x, s.position.z - p.z) < 4.2) { near = true; break; }
        }
        if (!near) hit.push({ x: s.position.x, z: s.position.z });
      }
      return hit.length === 1 ? hit[0] : null;
    } catch (e) { RF.warn('audio:mine', e); return null; }
  })();

  /* --------------------------------------------------------------------------
     5. BUILD — once, on the first 'start'. game.js has already made the context
     and resumed it by then, so bus() cannot come back null on the happy path;
     when it does anyway, the 5Hz tick keeps trying for eighty seconds.
     -------------------------------------------------------------------------- */
  const L = {};        // continuous layers
  const A = {};        // smoothed params, by name
  const PLACE = {};    // {pos, R, g} per fixed point
  const D = {};        // live distance level per place key

  function place(key, pos, R) {
    if (!pos) return null;
    const g = gain(mixPlace, 0);
    PLACE[key] = { pos: pos, R: R, g: g };
    A['p_' + key] = param(g.gain, 0.34, 0);
    return PLACE[key];
  }

  function build() {
    if (built) return true;
    if (!RF.audio || !RF.audio.ready) return false;
    AC = RF.audio.ctx; if (!AC) return false;
    root = RF.audio.bus('music'); if (!root) { AC = null; return false; }
    try {
      buffers();
      root.gain.value = 0; nodes++;
      A.root = param(root.gain, 0.9, 0);
      mixBed = gain(root, trim.bed); mixPlace = gain(root, trim.places); mixEvent = gain(root, trim.events);

      /* --- surf: two bands, so the far break and the near wash move apart --- */
      L.surf = layer(mixBed, { brown: true, f: 420, q: 0.55, s1: 0.047, s2: 0.081 });
      L.wash = layer(mixBed, { f: 900, q: 0.8, type: 'bandpass', hp: 260, s1: 0.107, s2: 0.163 });
      A.surf = param(L.surf.g.gain, 0.55, 0);
      A.surfF = param(L.surf.f.frequency, 1.0, 420);
      A.wash = param(L.wash.g.gain, 0.55, 0);

      /* --- wind: level tracks the weather, the band centre tracks the gust.
         windGust is a separate stage so the weather card can ramp it without
         fighting the sampler's automation on the level below it. ------------- */
      windGust = gain(mixBed, 1);
      L.wind = layer(windGust, { f: 620, q: 0.55, type: 'bandpass', s1: 0.129, s2: 0.071 });
      A.wind = param(L.wind.g.gain, 1.0, 0);
      A.windF = param(L.wind.f.frequency, 0.8, 620);

      /* --- rain: hiss only. Core's thunder owns the low end of a storm. ----- */
      L.rain = layer(mixBed, { f: 4200, q: 0.5, type: 'bandpass', hp: 1300, swell: false });
      A.rain = param(L.rain.g.gain, 1.0, 0);
      A.rainF = param(L.rain.f.frequency, 1.0, 4200);

      /* --- per-world beds --------------------------------------------------- */
      if (WK === 'volcano') {
        L.roar = layer(mixBed, { brown: true, f: 96, q: 0.9, s1: 0.037, s2: 0.059 });
        L.ash = layer(mixBed, { f: 3600, q: 0.5, type: 'bandpass', s1: 0.089, s2: 0.143 });
        A.roar = param(L.roar.g.gain, 1.6, 0); A.ash = param(L.ash.g.gain, 1.6, 0);
      } else if (WK === 'frost') {
        L.thin = layer(mixBed, { f: 2500, q: 1.4, type: 'bandpass', s1: 0.113, s2: 0.067 });
        A.thin = param(L.thin.g.gain, 1.6, 0);
      } else if (CAVE) {
        L.room = layer(mixBed, { brown: true, f: 118, q: 9, type: 'bandpass', s1: 0.041, s2: 0.073 });
        L.stone = layer(mixBed, { f: 700, q: 0.5, s1: 0.083, s2: 0.127 });
        A.room = param(L.room.g.gain, 1.6, 0); A.stone = param(L.stone.g.gain, 1.6, 0);
      } else {
        L.air = layer(mixBed, { f: 340, q: 0.5, s1: 0.053, s2: 0.091 });
        A.air = param(L.air.g.gain, 1.6, 0);
      }

      /* --- the two life layers are only mixers for their schedulers ---------- */
      L.night = gain(mixBed, 0); L.day = gain(mixBed, 0);
      A.night = param(L.night.gain, 2.7, 0);      // 3τ ≈ eight seconds across dusk
      A.day = param(L.day.gain, 2.7, 0);

      /* --- places ----------------------------------------------------------- */
      place('market', MARKET, 15);
      place('casino', CASINO, 14);
      place('harbor', HARBOR, 18);
      place('portal', PORTAL, 12);
      place('mine', MINE, 14);

      /* The casino keeps a murmur under its motifs and the portal keeps a hum;
         both hang off their own distance gain, so they mix themselves. */
      if (PLACE.casino) {
        L.murmur = layer(PLACE.casino.g, { f: 480, q: 0.6, s1: 0.19, s2: 0.117 });
        L.murmur.g.gain.value = 0.28;
      }
      if (PLACE.portal) {
        const hg = gain(PLACE.portal.g, 0.045), lp = filt('lowpass', 300, 1.2);
        lp.connect(hg);
        for (const f of [55, 82.4]) {
          const o = AC.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
          o.detune.value = rz(-9, 9); o.connect(lp); o.start(AC.currentTime); nodes++;
        }
        const wob = AC.createOscillator(), wg = AC.createGain();
        wob.frequency.value = 0.083; wg.gain.value = 90; wob.connect(wg); wg.connect(lp.frequency);
        wob.start(AC.currentTime); nodes += 2;
      }
      built = true;
      return true;
    } catch (e) { RF.err('audio:build', e); built = false; return false; }
  }

  /* --------------------------------------------------------------------------
     6. SCHEDULERS. Each owns a gate (how loud it should be here and now) and a
     gap, both re-rolled on every fire, so no motif can settle into a rhythm.
     Look-ahead is one tick: a fifth of a second, never more.
     -------------------------------------------------------------------------- */
  const S = [];
  function every(name, lo, hi, gate, fire) { S.push({ n: name, lo: lo, hi: hi, gate: gate, fire: fire, next: 0 }); }
  function arm(now) { for (let i = 0; i < S.length; i++) S[i].next = now + rz(0.4, S[i].hi); }

  function schedTick(now) {
    const d = density();
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (now < s.next) continue;
      if (now - s.next > 3) { s.next = now + rz(s.lo, s.hi); continue; }   // a stall, not a backlog
      let lv = 0;
      try { lv = s.gate(); } catch (e) { RF.warn('audio:gate:' + s.n, e); }
      const busy = 0.35 + 0.65 * (1 - clamp(lv, 0, 1));                    // closer means more often
      s.next = now + rz(s.lo, s.hi) * busy / Math.max(0.35, d);
      if (d <= 0 || lv < 0.02 || voices >= CAP || !awake) continue;
      try { s.fire(lv * trim.events); } catch (e) { RF.err('audio:' + s.n, e); }
    }
  }

  /* --- the readings every gate shares, refreshed once per 5Hz tick ---------- */
  const R = { water: 0, broad: 0, wet: 0, storm: 0, night: 0, day: 0, dawn: 0, gust: 0.3, on: 0 };
  const gateNight = () => R.night * R.on * PRO.life;
  const gateDay = () => R.day * R.on * PRO.life;
  const gateP = (k) => (D[k] || 0) * R.on;

  /* --- the night: crickets on a jittered schedule, the odd owl -------------- */
  every('cricket', 0.9, 2.9, gateNight, function (l) {
    const f = rz(3900, 4700);
    tone(L.night, { f: f, f2: f * rz(0.98, 1.03), type: 'triangle', dur: rz(0.16, 0.28),
      v: 0.020 * l, curve: pips(4 + (Math.random() * 3 | 0), 0.6) });
  });
  every('owl', 26, 74, () => gateNight() * 0.8, function (l) {
    const f = rz(390, 470), t = AC.currentTime;
    tone(L.night, { f: f, f2: f * 0.9, dur: 0.34, v: 0.024 * l, atk: 0.09, at: t });
    tone(L.night, { f: f * 0.98, f2: f * 0.86, dur: 0.5, v: 0.020 * l, atk: 0.11, at: t + rz(0.42, 0.55) });
  });
  every('rustle', 7, 19, () => gateNight() * 0.6, function (l) {
    hiss(L.night, { f: 2600, f2: 1500, q: 1.1, dur: rz(0.3, 0.6), v: 0.014 * l, atk: 0.14 });
  });

  /* --- the day: four distinct calls, and more of them at first light -------- */
  const CALLS = [
    function (g, l) {                               // a rising trill
      const b = rz(2500, 3100);
      tone(g, { seq: [[0, b], [0.05, b * 1.12], [0.1, b * 1.26], [0.15, b * 1.12], [0.2, b * 1.34]],
        type: 'triangle', dur: 0.27, v: 0.026 * l, curve: pips(5, 0.4) });
    },
    function (g, l) {                               // two notes, falling a fourth
      const b = rz(2700, 3200);
      tone(g, { seq: [[0, b], [0.13, b * 0.74]], dur: 0.26, v: 0.028 * l, curve: pips(2, 0.5) });
    },
    function (g, l) {                               // a warble that turns over
      const b = rz(1900, 2400);
      tone(g, { f: b, f2: b * 1.55, f3: b * 1.05, gl: 0.34, type: 'triangle', dur: 0.36, v: 0.022 * l, atk: 0.05 });
    },
    function (g, l) {                               // one dry chip
      tone(g, { f: rz(3300, 3900), f2: rz(2900, 3300), dur: 0.075, v: 0.024 * l, type: 'square', atk: 0.006 });
    }
  ];
  every('bird', 2.6, 8.5, () => gateDay() * (1 - R.wet * 0.55) * (0.6 + R.dawn * 0.8), function (l) {
    const c = CALLS[(Math.random() * CALLS.length) | 0];
    c(L.day, l);
    /* at dawn a call gets answered from somewhere else on the isle */
    if (Math.random() < 0.22 * R.dawn) setTimeout(function () { try { c(L.day, l * 0.55); } catch (e) {} }, 260 + Math.random() * 340);
  });

  /* --- storm: one distant rumble, kept well clear of core's thunder card ---- */
  let wxLock = 0;
  every('rumble', 34, 96, () => R.storm * R.on * (AC && AC.currentTime > wxLock ? 1 : 0), function (l) {
    hiss(mixEvent, { brown: true, type: 'lowpass', f: 170, f2: 52, q: 0.6,
      dur: rz(1.9, 3.0), v: 0.048 * l, atk: rz(0.25, 0.5) });
  });

  /* --- per-world colour ----------------------------------------------------- */
  if (WK === 'volcano') {
    every('vent', 9, 26, () => R.on, function (l) {
      hiss(mixEvent, { f: 2200, f2: 700, q: 1.3, dur: rz(0.7, 1.6), v: 0.026 * l, atk: 0.25 });
      if (Math.random() < 0.4) tone(mixEvent, { f: rz(58, 78), f2: rz(40, 52), type: 'sawtooth', dur: 1.2, v: 0.018 * l, atk: 0.3 });
    });
  } else if (WK === 'frost') {
    every('creak', 11, 31, () => R.on, function (l) {
      const f = rz(240, 420);
      hiss(mixEvent, { f: f, f2: f * rz(1.5, 2.4), q: 12, dur: rz(0.5, 1.1), v: 0.034 * l, atk: rz(0.18, 0.4) });
      if (Math.random() < 0.35) tone(mixEvent, { f: rz(84, 110), f2: rz(62, 78), type: 'sawtooth', dur: 0.9, v: 0.016 * l, atk: 0.25 });
    });
    every('shard', 17, 48, () => R.on, function (l) {
      hiss(mixEvent, { f: 5200, f2: 3400, q: 3, dur: 0.22, v: 0.018 * l, curve: rattle(5, false) });
    });
  } else if (CAVE) {
    every('drip', 2.2, 7.5, () => R.on, function (l) {
      const f = rz(1100, 1800), t = AC.currentTime;
      tone(mixEvent, { f: f, f2: f * 0.55, gl: 0.06, dur: 0.16, v: 0.032 * l, atk: 0.004, at: t });
      hiss(mixEvent, { f: f * 1.4, q: 5, dur: 0.05, v: 0.012 * l, at: t });
    });
    every('fall', 24, 70, () => R.on, function (l) {
      hiss(mixEvent, { brown: true, type: 'lowpass', f: 260, f2: 90, q: 0.7, dur: rz(0.8, 1.6),
        v: 0.034 * l, curve: rattle(7, true) });
    });
  } else if (WK === 'mine') {
    every('shaft', 14, 38, () => R.on, function (l) {
      hiss(mixEvent, { brown: true, type: 'lowpass', f: 200, f2: 120, q: 0.8, dur: rz(1.0, 2.2), v: 0.022 * l, atk: 0.4 });
    });
  }

  /* --------------------------------------------------------------------------
     B. PLACES — a small motif each, on a randomised schedule, mixed by distance.
     -------------------------------------------------------------------------- */
  if (MARKET) {
    every('chatter', 3.4, 9.5, () => gateP('market'), function (l) {
      const n = 2 + (Math.random() * 2 | 0), t = AC.currentTime, base = rz(0.85, 1.25);
      /* two formants glided under one envelope reads as a syllable; three of
         them with a shared pitch centre reads as one person, not a crowd */
      for (let i = 0; i < n; i++) {
        const at = t + i * rz(0.11, 0.2);
        hiss(PLACE.market.g, { f: rz(520, 780) * base, f2: rz(760, 1500) * base, q: 3.4,
          dur: rz(0.08, 0.16), v: 0.042 * l, at: at, atk: 0.02 });
        if (i === 0 || Math.random() < 0.5)
          tone(PLACE.market.g, { f: rz(115, 205) * base, f2: rz(100, 180) * base, type: 'sawtooth', dur: 0.13, v: 0.010 * l, at: at });
      }
    });
    every('crate', 8, 21, () => gateP('market'), function (l) {
      const t = AC.currentTime;
      hiss(PLACE.market.g, { type: 'lowpass', f: 320, f2: 95, q: 0.9, dur: 0.2, v: 0.050 * l, at: t });
      tone(PLACE.market.g, { f: rz(88, 130), type: 'square', dur: 0.1, v: 0.026 * l, at: t });
      if (Math.random() < 0.6) hiss(PLACE.market.g, { f: 900, f2: 1700, q: 4, dur: rz(0.22, 0.4), v: 0.017 * l, at: t + 0.14, atk: 0.1 });
    });
  }
  if (CASINO) {
    every('chips', 5.5, 14, () => gateP('casino'), function (l) {
      hiss(PLACE.casino.g, { f: rz(2500, 3300), f2: rz(1900, 2600), q: 6, dur: rz(0.2, 0.4),
        v: 0.034 * l, curve: rattle(7 + (Math.random() * 5 | 0), false) });
    });
    every('ball', 13, 34, () => gateP('casino'), function (l) {
      hiss(PLACE.casino.g, { f: rz(1500, 2100), f2: rz(900, 1300), q: 4, dur: rz(0.9, 1.5),
        v: 0.030 * l, curve: rattle(12, true) });
    });
    every('crowd', 9, 22, () => gateP('casino'), function (l) {
      hiss(PLACE.casino.g, { f: rz(380, 560), f2: rz(600, 900), q: 1.6, dur: rz(0.5, 1.1), v: 0.032 * l, atk: 0.22 });
    });
  }
  if (HARBOR) {
    const hb = PRO.harbour;
    let gullLock = 0;
    /* 04-world already mobs you with gulls the moment a fish lands; these are
       the ones that live here, so they stand down for a few seconds after one. */
    RF.on('catch', function () { try { if (AC) gullLock = AC.currentTime + 7; } catch (e) {} });
    every('rope', 4.5, 13, () => gateP('harbor'), function (l) {
      const f = rz(140, 210);
      hiss(PLACE.harbor.g, { f: f, f2: f * rz(1.8, 2.6), q: 11, dur: rz(0.45, 0.9), v: 0.034 * l * hb, atk: rz(0.16, 0.34) });
    });
    every('slap', 3.2, 7.5, () => gateP('harbor'), function (l) {
      hiss(PLACE.harbor.g, { type: 'lowpass', f: rz(420, 700), f2: 150, q: 0.8, dur: rz(0.16, 0.3), v: 0.036 * l * hb, atk: 0.02 });
    });
    every('gull', 14, 38, () => gateP('harbor') * (AC && AC.currentTime > gullLock ? 1 : 0), function (l) {
      const t = AC.currentTime, b = rz(980, 1280);
      for (let i = 0, n = 1 + (Math.random() * 2 | 0); i < n; i++)
        tone(PLACE.harbor.g, { f: b * rz(0.95, 1.06), f2: b * 0.72, type: 'sawtooth', dur: 0.19,
          v: 0.020 * l * hb, atk: 0.03, at: t + i * rz(0.2, 0.34) });
    });
    every('bell', 30, 80, () => gateP('harbor'), function (l) {
      const t = AC.currentTime, f = rz(590, 660);
      tone(PLACE.harbor.g, { f: f, dur: 1.7, v: 0.018 * l * hb, atk: 0.006, at: t });
      tone(PLACE.harbor.g, { f: f * 1.51, dur: 1.1, v: 0.009 * l * hb, atk: 0.006, at: t });
    });
  }
  if (PORTAL) {
    every('shimmer', 5.5, 15, () => gateP('portal'), function (l) {
      const t = AC.currentTime;
      hiss(PLACE.portal.g, { f: rz(420, 620), f2: rz(2200, 3200), q: 7, dur: rz(1.2, 2.0), v: 0.040 * l, atk: rz(0.4, 0.8) });
      tone(PLACE.portal.g, { f: rz(600, 720), f2: rz(1180, 1460), gl: 1.1, type: 'triangle', dur: 1.3, v: 0.018 * l, atk: 0.45, at: t + 0.1 });
    });
  }
  if (MINE) {
    every('hoist', 6, 16, () => gateP('mine'), function (l) {
      const f = rz(330, 470);
      hiss(PLACE.mine.g, { f: f, f2: f * rz(1.2, 1.7), q: 14, dur: rz(0.6, 1.2), v: 0.030 * l, atk: rz(0.2, 0.45) });
    });
    every('knock', 7, 18, () => gateP('mine'), function (l) {
      const t = AC.currentTime, n = 2 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        const at = t + i * rz(0.26, 0.4);
        hiss(PLACE.mine.g, { type: 'lowpass', f: 850, f2: 260, q: 1.1, dur: 0.09, v: 0.034 * l, at: at });
        hiss(PLACE.mine.g, { type: 'lowpass', f: 500, f2: 180, q: 0.8, dur: 0.16, v: 0.010 * l, at: at + 0.23, atk: 0.03 });
      }
    });
    every('cart', 17, 44, () => gateP('mine'), function (l) {
      hiss(PLACE.mine.g, { brown: true, type: 'lowpass', f: rz(190, 280), f2: 130, q: 0.9, dur: rz(1.4, 2.6), v: 0.028 * l, atk: 0.5 });
    });
  }

  /* --------------------------------------------------------------------------
     C. EVENT COLOUR — a jump out on the open water. 04-world plays core's own
     splash for the jumpers it draws inside eighteen metres; this is the one you
     only ever hear, well past that, and it answers itself instead of cracking.
     -------------------------------------------------------------------------- */
  every('farjump', 6, 17, () => R.broad * R.on * (CAVE ? 0.2 : 1) * (1 - R.storm * 0.4), function (l) {
    const t = AC.currentTime;
    hiss(mixEvent, { type: 'lowpass', f: rz(380, 620), f2: 130, q: 0.7, dur: rz(0.24, 0.4), v: 0.026 * l, atk: 0.01, at: t });
    hiss(mixEvent, { type: 'lowpass', f: 300, f2: 110, q: 0.6, dur: 0.5, v: 0.008 * l, atk: 0.1, at: t + rz(0.18, 0.32) });
  });

  /* --------------------------------------------------------------------------
     7. THE 5Hz SAMPLER. Everything expensive lives here and nowhere else:
     twenty-two height lookups, one distance per fixed point, one pass over the
     smoothed params. Nothing this mod does runs on the frame hook itself.
     -------------------------------------------------------------------------- */
  const RING_N = [], RING_B = [];
  for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; RING_N.push([Math.cos(a) * 2.4, Math.sin(a) * 2.4]); }
  for (let k = 0; k < 12; k++) { const a = (k + 0.5) / 12 * TAU; RING_B.push([Math.cos(a) * 9, Math.sin(a) * 9]); }

  /* dusk runs 0.62→0.78 and dawn 0.06→0.20, which is where core's own sky keys
     put them; the eight-second crossfade is the param's tau, not this curve */
  function nightAmt(t) {
    if (t >= 0.78 || t <= 0.06) return 1;
    if (t > 0.62) return (t - 0.62) / 0.16;
    if (t < 0.20) return 1 - (t - 0.06) / 0.14;
    return 0;
  }
  function dawnAmt(t) { const d = Math.abs(t - 0.17); return d > 0.11 ? 0 : 1 - d / 0.11; }

  let lastT = 0, treeIdx = 0, moveT = 0, startleLock = 0;

  function sample() {
    if (!built || !AC) return;
    const now = AC.currentTime, dt = lastT ? clamp(now - lastT, 0.01, 1.2) : 0.2;
    lastT = now;

    /* --- the master gate: nothing before Set sail, nothing while muted ------ */
    const live = enabled && awake && !sailing && RF.running && !RF.muted && !RF.audio.suspended;
    R.on = live ? 1 : 0;
    A.root.t = live ? trim.master : 0;
    A.root.tau = live ? 0.9 : 0.22;                  // out quickly, back in gently
    if (!live) { pump(dt, now); return; }

    /* --- where the water is -------------------------------------------------
       Two rings: the near one is the wash at your feet, the wide one is how much
       open sea there is to break on. Twenty-two clamped lookups at 5Hz. -------- */
    const P0 = RF.pWorld;
    let nearW = 0, broadW = 0;
    for (let i = 0; i < RING_N.length; i++) if (fn.isWaterAt(P0.x + RING_N[i][0], P0.z + RING_N[i][1])) nearW++;
    for (let i = 0; i < RING_B.length; i++) if (fn.isWaterAt(P0.x + RING_B[i][0], P0.z + RING_B[i][1])) broadW++;
    nearW /= RING_N.length; broadW /= RING_B.length;
    const inW = fn.isWaterAt(P0.x, P0.z) ? 1 : 0;
    R.water = clamp(nearW * 0.8 + inW * 0.2, 0, 1);
    R.broad = broadW;

    /* --- weather and the sky ------------------------------------------------ */
    const W = RF.weather;
    const storm = W === 'storm' ? 1 : 0;
    R.storm = storm;
    R.wet = W === 'rain' || W === 'storm' ? 1 : W === 'snow' ? 0.45 : W === 'ash' ? 0.55 : 0;
    const t = RF.dayT;
    R.night = nightAmt(t); R.day = 1 - R.night; R.dawn = dawnAmt(t);

    /* the same gust you can already see in the grass, when 04-world is here */
    let gust = 0.3;
    try { if (RF.world && RF.world.wind) gust = RF.world.wind.s; } catch (e) { gust = 0.3; }
    R.gust = clamp(gust, 0, 2);

    /* --- a panel is a room you stepped into --------------------------------- */
    const cas = RF.casinoOpen ? 1 : 0;
    const pan = RF.panelOpen && !cas ? 1 : 0;
    const bedDuck = cas ? 0.28 : pan ? 0.68 : 1;

    /* --- the bed ------------------------------------------------------------ */
    const surfBase = (0.34 + R.water * 0.9 + R.broad * 0.35) * PRO.surf;
    A.surf.t = clamp(surfBase * (1 + storm * 0.55), 0, 1.4) * 0.28 * bedDuck;
    A.wash.t = clamp(R.water * (0.55 + storm * 0.5) * PRO.surf, 0, 1) * 0.34 * bedDuck;
    A.surfF.t = 420 + storm * 900 + R.wet * 220 + R.water * 260;    // the filter opens in a storm

    A.wind.t = clamp((0.16 + R.gust * 0.42 + storm * 0.4 + (W === 'snow' ? 0.16 : 0)) * PRO.wind, 0, 1.3) * 0.26 * bedDuck;
    A.windF.t = 420 + R.gust * 520 + storm * 700 + (WK === 'frost' ? 900 : 0);

    A.rain.t = clamp(R.wet * (0.55 + storm * 0.45), 0, 1) * PRO.rain * 0.26 * bedDuck;
    A.rainF.t = 3200 + storm * 2400 + (W === 'snow' ? -1200 : 0);

    if (A.roar) { A.roar.t = 0.18 * bedDuck; A.ash.t = (0.05 + (W === 'ash' ? 0.16 : 0)) * bedDuck; }
    if (A.thin) A.thin.t = (0.10 + R.gust * 0.14) * bedDuck;
    if (A.room) { A.room.t = 0.45 * bedDuck; A.stone.t = 0.10 * bedDuck; }
    if (A.air) A.air.t = PRO.air * 0.30 * bedDuck * (1 - R.wet * 0.4);

    A.night.t = R.night * PRO.life * bedDuck;
    A.day.t = R.day * PRO.life * bedDuck * (1 - R.wet * 0.5);

    /* --- places ------------------------------------------------------------- */
    for (const k in PLACE) {
      const p = PLACE[k];
      const u = clamp(1 - Math.hypot(P0.x - p.pos.x, P0.z - p.pos.z) / p.R, 0, 1);
      let lv = u * u;
      if (k === 'casino' && cas) lv = 1;              // you are standing in it
      else if (cas) lv *= 0.15;
      else if (pan) lv *= 0.7;
      D[k] = lv;
      const pr = A['p_' + k];
      pr.t = lv;
      pr.tau = (k === 'casino' && cas) ? 0.09 : 0.34; // stepping in is immediate, still smooth
    }

    /* --- a bird put up when you run past a tree ------------------------------
       Six trees a tick off a rolling cursor: over a second of running that is
       the whole neighbourhood, and it never costs a full pass. ---------------- */
    if (fn.isMoving()) moveT += dt; else moveT = 0;
    if (moveT > 1.1 && now > startleLock && density() > 0 && R.day > 0.4 && !CAVE) {
      const TD = RF.treeData;
      if (TD && TD.length) {
        for (let k = 0; k < 6; k++) {
          const tr = TD[treeIdx = (treeIdx + 1) % TD.length];
          if (!tr) continue;
          if (Math.hypot(P0.x - tr.x, P0.z - tr.z) < 2.6) {
            startleLock = now + rz(9, 20);
            hiss(mixEvent, { f: 900, f2: 2600, q: 1.4, dur: 0.34, v: 0.032 * trim.events, curve: pips(7, 0.5) });
            const b = rz(2600, 3400);
            tone(mixEvent, { seq: [[0, b], [0.06, b * 1.2], [0.12, b * 0.9]], dur: 0.2,
              v: 0.024 * trim.events, curve: pips(3, 0.4), at: now + 0.1 });
            break;
          }
        }
      }
    }

    pump(dt, now);
    schedTick(now);
  }

  /* --------------------------------------------------------------------------
     8. EVENTS. The weather card gusts the bed we already have rather than piling
     another one-shot on top of the thunder core played a frame ago; a broken
     node drops its rubble a beat later; sailing fades out before the reload.
     -------------------------------------------------------------------------- */
  RF.on('weather', function (next) {
    if (!built || !AC) return;
    wxLock = AC.currentTime + 14;          // core just played thunder or a gust: stay off it
    try {
      const n = AC.currentTime, g = windGust.gain;
      g.cancelScheduledValues(n);
      g.setValueAtTime(g.value, n);
      g.linearRampToValueAtTime(next === 'storm' ? 2.2 : 1.7, n + 0.9);
      g.linearRampToValueAtTime(1, n + 3.0);
      /* brightness rides the filter's detune, which the sampler never touches */
      const d = L.wind.f.detune;
      d.cancelScheduledValues(n); d.setValueAtTime(d.value, n);
      d.linearRampToValueAtTime(900, n + 1.0);
      d.linearRampToValueAtTime(0, n + 3.0);
    } catch (e) { RF.warn('audio:weather', e); }
  });

  RF.on('mined', function (m) {
    if (!built || !AC || !awake || !enabled || RF.muted || density() <= 0 || voices >= CAP) return;
    /* core plays the pick and the ore chime; what it never plays is the rock
       remembering it was a rock, half a second after it stopped being one */
    const t = AC.currentTime + rz(0.34, 0.8);
    hiss(mixEvent, { brown: true, type: 'lowpass', f: rz(300, 460), f2: 95, q: 0.8, dur: rz(0.5, 0.95),
      v: 0.038 * trim.events, curve: rattle(6 + (Math.random() * 4 | 0), true), at: t });
    if (m && m.geode)
      hiss(mixEvent, { f: 4200, f2: 2400, q: 5, dur: 0.3, v: 0.013 * trim.events, at: t + 0.1, curve: rattle(4, false) });
  });

  RF.on('travel', function () { sailing = true; if (built) A.root.tau = 0.14; });

  /* --------------------------------------------------------------------------
     9. DISCIPLINE. Mute is a state core owns; hidden is one the browser owns.
     Hidden RELEASES the schedulers: rAF stops, so the tick that would fire them
     stops with it, and every gap is re-armed on the way back — otherwise the
     whole backlog would dump into the first frame after you come back.
     -------------------------------------------------------------------------- */
  /* the ♪ chip and the settings panel both land here; the sampler would pick it
     up within a fifth of a second anyway, but a mute you can hear lag is a bug */
  RF.on('muted', function () { try { if (built) sample(); } catch (e) { RF.warn('audio:muted', e); } });

  function onVis() {
    awake = !document.hidden;
    if (!built || !AC) return;
    try {
      if (document.hidden) {
        A.root.t = 0; A.root.v = 0; A.root.dirty = false;
        A.root.p.setTargetAtTime(0, AC.currentTime, 0.05);
      } else { lastT = 0; arm(AC.currentTime); }
    } catch (e) { RF.warn('audio:vis', e); }
  }
  document.addEventListener('visibilitychange', onVis);

  /* --------------------------------------------------------------------------
     10. LIFECYCLE. Built at the first 'start'; if the context refused the
     gesture the tick keeps trying for eighty seconds and then gives up quietly.
     -------------------------------------------------------------------------- */
  let tries = 0;
  RF.on('start', function () {
    if (!enabled || built) return;
    if (build()) { lastT = 0; arm(AC.currentTime); }
  });

  RF.every(0.2, function () {
    if (!built) {
      if (!enabled || !RF.running || tries > 400) return;
      tries++;
      if (!build()) return;
      lastT = 0; arm(AC.currentTime);
    }
    try { sample(); } catch (e) { RF.err('audio:sample', e); }
  });

  /* --------------------------------------------------------------------------
     11. THE PUBLIC FACE. 10-comfort drives all of this; every call is safe
     before the graph exists and safe when it never does.
     -------------------------------------------------------------------------- */
  const GROUP = { bed: () => mixBed, places: () => mixPlace, events: () => mixEvent };
  const LAYER = { surf: 'surf', wash: 'wash', wind: 'wind', rain: 'rain', night: 'night', day: 'day',
    roar: 'roar', ash: 'ash', thin: 'thin', room: 'room', stone: 'stone', air: 'air' };

  RF.api = RF.api || {};
  RF.api.soundscape = {
    enabled: enabled,
    /* Off means off: the bed fades over a tenth of a second and the schedulers
       stop being asked. The graph is not torn down, so on is instant. */
    set: function (v) {
      const next = !!v;
      if (next === enabled) return enabled;
      enabled = next; RF.api.soundscape.enabled = enabled;
      if (!enabled && built) A.root.tau = 0.1;
      if (enabled && !built && RF.running && build()) { lastT = 0; arm(AC.currentTime); }
      persist();
      try { if (built) sample(); } catch (e) { RF.warn('audio:set', e); }
      return enabled;
    },
    get: function () { return enabled; },
    /* level(name) reads what a layer, a place or a group is doing right now.
       level(name, v) trims a group — 'master'|'bed'|'places'|'events' — and keeps
       it, which is the pair of calls a settings slider needs and nothing more. */
    level: function (name, v) {
      if (v === undefined) {
        if (name === 'master') return built ? A.root.v : 0;
        if (name in trim) return trim[name];
        const k = LAYER[name];
        if (k && A[k]) return A[k].v;
        if (PLACE[name]) return D[name] || 0;
        return 0;
      }
      if (!(name in trim)) return 0;
      const nv = clamp(+v || 0, 0, 1.5);
      trim[name] = nv;
      if (built) {
        try {
          if (name === 'master') { A.root.tau = 0.25; if (R.on) A.root.t = nv; }
          else GROUP[name]().gain.setTargetAtTime(nv, AC.currentTime, 0.08);
        } catch (e) { RF.warn('audio:level', e); }
      }
      persist();
      return nv;
    },
    /* every number this mod would otherwise have been tempted to console.log */
    stats: function () {
      return {
        built: built, enabled: enabled, awake: awake, ctx: AC ? AC.state : 'none',
        nodes: nodes, voices: voices, peak: peak, cap: CAP, fired: fired,
        layers: Object.keys(L).length, places: Object.keys(PLACE).length,
        schedulers: S.length, params: P.length, density: density(),
        world: WK, mine: !!MINE,
        water: +R.water.toFixed(2), broad: +R.broad.toFixed(2),
        night: +R.night.toFixed(2), gust: +R.gust.toFixed(2),
        trim: { master: trim.master, bed: trim.bed, places: trim.places, events: trim.events }
      };
    }
  };
});
