/* 06-content — THE SHORE CAMP: a working camp on the tideline, and ten new things to do at it.
   1. Shoreline foraging — kelp, clams, samphire, driftwood and sea glass regrow on the sand; G gathers.
   2. Trim / Prime / Legend cuts — every fish you land leaves a cut behind; the whole camp runs on them.
   3. The cookfire — six recipes that turn a haul into a timed buff, with a live buff strip on the HUD.
   4. The curing rack — three slots that cure goods on the wall clock, hanging in 3D while they do.
   5. Crab pots — weave one, sink it in the shallows, walk away, come back to whatever crawled in.
   6. The lure bench — five hand-tied lures that wear out with use; the equipped one bends the bite.
   7. The tank — a glass trophy tank you stock from your Fishdex; the fish swim, and steady your hand.
   8. Messages in bottles — 22 fragments of isle lore wash up on the tideline, kept in a ledger.
   9. The notice board — rumours read straight off the live world: market, weather, moon, pots, tide.
  10. Barnacle — a gull you feed once, who then spots things for you and brings back small gifts.
  11. Lantern Tide — a nine-minute festival on the wall clock: lanterns lit, blue fire, a generous shore.
  Nothing here touches coins, ores, the bucket or pearls directly: the larder is the mod's own, so the
  camp behaves identically whether you are signed in or playing offline. */
RF.mod('06-content', function (RF) {
  const T = RF.THREE, fn = RF.fn, N = RF.N, HALF = RF.HALF, HM = RF.heightMap;
  const clamp = fn.clamp, fmt = fn.fmt, pix = fn.pixSVG, keyOf = fn.keyOf;
  const WK = RF.worldKey || 'isle';
  const RM = (function(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } })();
  const now = () => Date.now();
  let uiReady = false;                                          // the HUD strip is built at the end; early recalcs must not reach for it
  const MIN = 60000;

  /* ---- GOODS: everything the camp trades in. Mod-owned, never the server's. ---- */
  const GOODS = {
    kelp:    {n:'Kelp Frond',  c:'#4fae7a', d:'rubbery. useful anyway'},
    clam:    {n:'Clam',        c:'#e2d6ba', d:'shut, and smug about it'},
    samphire:{n:'Samphire',    c:'#8ede6a', d:'salty greens, free'},
    drift:   {n:'Driftwood',   c:'#a89070', d:'sea-sanded, burns clean'},
    glass:   {n:'Sea Glass',   c:'#7fe6ff', d:'somebody else’s bottle, eventually'},
    crab:    {n:'Crab',        c:'#e07a4a', d:'sideways, and cross about it'},
    prawn:   {n:'Prawn',       c:'#ff9f7a', d:'a potful is a good morning'},
    urchin:  {n:'Urchin',      c:'#9a6ad0', d:'all spine, a little roe'},
    roe:     {n:'Roe',         c:'#ffb35c', d:'orange, expensive-looking'},
    crisp:   {n:'Kelp Crisp',  c:'#2f8f5c', d:'cured stiff on the rack'},
    cured:   {n:'Cured Roe',   c:'#ff8a3c', d:'cured slow on the rack'},
    salt:    {n:'Salt Fish',   c:'#dfe9e7', d:'cured hard on the rack'},
    dried:   {n:'Dried Prawn', c:'#e0704a', d:'cured crisp on the rack'},
    pot:     {n:'Crab Pot',    c:'#c9a86a', d:'woven. it comes back to you'},
    f1:      {n:'Trim',        c:'#b9c6c4', d:'kept back from the bucket'},
    f2:      {n:'Prime Cut',   c:'#57b7ff', d:'kept back from the bucket'},
    f3:      {n:'Legend Cut',  c:'#ffc24b', d:'kept back from the bucket'}
  };
  const GOOD_ORDER = ['f1','f2','f3','kelp','clam','samphire','drift','glass','crab','prawn','urchin','roe',
    'crisp','cured','salt','dried','pot'];

  /* ---- RECIPES: a buff is a duration and a handful of pipeline nudges.
     bite/speed/wood multiply, luck/ore/pearl add. Everything except bite and
     speed only bites offline — signed in, the server rolls it all — so the two
     that always work are deliberately the two on nearly every recipe. ---- */
  const DISHES = [
    {id:'chowder', n:'Clam Chowder',    s:'thick enough to stand a spoon in', req:{clam:2,kelp:1,f1:1},
      ms:8*MIN,  e:{bite:0.80, luck:0.15},           blurb:'steady hands · the line goes tight sooner'},
    {id:'skewers', n:'Prawn Skewers',   s:'eaten walking, always',            req:{prawn:2,samphire:1},
      ms:6*MIN,  e:{speed:1.18},                     blurb:'quick feet · you cover the isle faster'},
    {id:'boil',    n:'Crab Boil',       s:'the pot does the arguing',         req:{crab:1,samphire:1,f1:1},
      ms:6*MIN,  e:{ore:1, speed:1.06},              blurb:'a greedy pick · one more ore a swing'},
    {id:'toast',   n:'Roe on Toast',    s:'breakfast of the briefly rich',    req:{cured:1,crisp:1},
      ms:5*MIN,  e:{luck:0.55, bite:0.94},           blurb:'a sharp eye · better fish look at your hook'},
    {id:'smoke',   n:'Driftwood Smoke', s:'slow fire, patient cook',          req:{drift:3,f2:1},
      ms:10*MIN, e:{wood:2, bite:0.90},              blurb:'the long burn · double logs, quicker bites'},
    {id:'stew',    n:'Lantern Stew',    s:'only cooks while the tide is lit', req:{f3:1,glass:1,urchin:1},
      ms:15*MIN, e:{bite:0.82, luck:0.4, ore:1, wood:1.5, speed:1.1, pearl:1}, fest:true,
      blurb:'tidewalker · a little of everything, for a long while'}
  ];

  /* ---- LURES: tied at the bench, worn out by fish. Uses tick down on a LANDED
     catch only, so a snapped line costs you nothing here either. ---- */
  const LURES = [
    {id:'kelpfly', n:'Kelp Fly',        s:'green, scruffy, effective',       req:{kelp:2,drift:1},        uses:14, e:{bite:0.86}},
    {id:'spoon',   n:'Clamshell Spoon', s:'flashes like a small mistake',    req:{clam:3,glass:1},        uses:16, e:{luck:0.35}},
    {id:'jig',     n:'Crab Jig',        s:'scuttles on the drop',            req:{crab:1,drift:2},        uses:12, e:{luck:0.2, bite:0.92}},
    {id:'minnow',  n:'Glass Minnow',    s:'you can see the hook through it', req:{glass:2,f2:1},          uses:10, e:{luck:0.7}},
    {id:'tidebone',n:'Tidebone Hook',   s:'filed from something that lost',  req:{f3:1,cured:1,glass:2},  uses:8,  e:{luck:1.1, bite:0.82}}
  ];
  const lureById = id => { for(let i=0;i<LURES.length;i++) if(LURES[i].id===id) return LURES[i]; return null; };

  /* ---- CURES: what the rack turns things into, and how long it takes ---- */
  const CURES = {
    kelp: {out:'crisp', ms:5*MIN, n:'hang to crisp'},
    roe:  {out:'cured', ms:9*MIN, n:'salt and wait'},
    f1:   {out:'salt',  ms:7*MIN, n:'split and dry'},
    prawn:{out:'dried', ms:6*MIN, n:'string and dry'}
  };
  const CURE_ORDER = ['kelp','roe','f1','prawn'];

  /* ---- FORAGE: what grows back on the sand, and how often ---- */
  const FORAGE = [
    {k:'kelp',     w:30, col:0x3f9e6a},
    {k:'clam',     w:26, col:0xe2d6ba},
    {k:'samphire', w:20, col:0x8ede6a},
    {k:'drift',    w:18, col:0xa89070},
    {k:'glass',    w:6,  col:0x7fe6ff}
  ];
  const FORAGE_MS = 100000, FORAGE_MS_FEST = 34000, FORAGE_MAX = 20;

  /* ---- POTS ---- */
  const POT_MAX = 3, POT_SOAK = 6*MIN, POT_FULL = 30*MIN;
  const POT_TABLE = [['prawn',40],['crab',26],['urchin',18],['roe',8],['glass',5],['kelp',3]];

  /* ---- LANTERN TIDE: nine minutes in every forty-five, off the wall clock,
     so every angler on the isle is inside the same window without being told. ---- */
  const FEST_CYCLE = 45*MIN, FEST_LEN = 9*MIN;
  const festPhase = () => now() % FEST_CYCLE;
  const festOn = () => festPhase() < FEST_LEN;
  const festLeft = () => festOn() ? FEST_LEN - festPhase() : FEST_CYCLE - festPhase();

  /* ---- THE LEDGER OF SMALL FACTS: what the bottles say ---- */
  const LORE = [
    'the trader keeps a thumb on the scale. everyone knows. nobody mentions it. the coffee is free.',
    'there were four lamps on the casino dais once. the fourth is at the bottom of the bay, with the man who unscrewed it.',
    'the eel is not a metaphor. the eel is in the machine. the eel is fed.',
    'gulls remember a face for three years. that is longer than most contracts on this isle.',
    'the shaft was dug for iron. they hit water at nine feet and called it a well instead. it is not a well.',
    'sea glass is a bottle the ocean has spent thirty years apologising for.',
    'the harbormaster logs every hull that sails. he has never once logged one coming back short-crewed.',
    'kelp grows a foot a day in the right water. so does a rumour.',
    'the first angler here traded a legendary for a rowboat. the rowboat sank. the story did not.',
    'a full moon does not make fish braver. it makes anglers stay out later. the numbers side with the anglers.',
    'the quarry pays better in a storm because nobody sane is standing in it.',
    'somebody buried a chest, drew a map, and then — being thorough — put the map in a bottle and threw it in the sea.',
    'the price of wood has never once gone up on a day it rained. nobody can explain this.',
    'shiny fish are not another species. they are the same fish, having had a very good year.',
    'the portal hums a fifth below the lamp posts. stand between them and the isle is briefly in tune.',
    'crab pots were invented by someone who wanted to fish and also wanted to be elsewhere.',
    'there is a species in the dex nobody on this isle has landed. the dex is patient about it.',
    'the volcano is not angry. it is simply the only thing here with a schedule it keeps.',
    'every deed on the ledger is a hash of a thing that happened. the hash is fiction. the thing that happened is not.',
    'the drying rack was here before the camp. somebody built the camp around it rather than move it.',
    'you can hear the derby start from the shore: everyone stops talking at once.',
    'the tide takes nine minutes to turn and the lanterns burn for exactly that long. not a coincidence — a habit.'
  ];

  const MOON = ['new moon','waxing crescent','first quarter','waxing gibbous',
    'full moon','waning gibbous','last quarter','waning crescent'];

  /* ==================================================================
     STORE — the camp's own save. Never RF.state: the server owns that.
     Kit you carry (larder, rack, lures, tank, ledger, the gull) is global;
     things that are physically in a world (pots, picked-over forage,
     bottles on the sand) are filed under that world's key.
     ================================================================== */
  const S = (function(){ const d = RF.store.get('06-content', null);
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; })();
  const obj = (o,k) => { if(!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; return o[k]; };
  const arr = (o,k) => { if(!Array.isArray(o[k])) o[k] = []; return o[k]; };
  obj(S,'larder'); arr(S,'buffs'); obj(S,'lures'); obj(S,'lore'); arr(S,'tank'); obj(S,'w');
  if(typeof S.lureId !== 'string') S.lureId = '';
  if(typeof S.lureUses !== 'number' || S.lureUses < 0) S.lureUses = 0;
  if(!Array.isArray(S.rack) || S.rack.length !== 3) S.rack = [null,null,null];
  S.gull = S.gull ? 1 : 0;
  if(typeof S.cooked !== 'number') S.cooked = 0;
  if(typeof S.picked !== 'number') S.picked = 0;
  const WS = obj(S.w, WK);
  obj(WS,'nodes'); arr(WS,'pots'); arr(WS,'bottles');
  if(typeof WS.bnext !== 'number') WS.bnext = 0;
  let saveDue = 0;
  const persist = () => { saveDue = 0.8; };                     // batched: several actions in a beat cost one write
  const persistNow = () => { saveDue = 0; try{ RF.store.set('06-content', S); }catch(e){ RF.warn('06-content:save', e); } };

  /* ---- larder arithmetic ---- */
  const have = k => S.larder[k] | 0;
  const give = (k,n) => { if(!GOODS[k] || n <= 0) return; S.larder[k] = Math.min(999, have(k) + n); };
  const take = (k,n) => { const v = have(k) - n; if(v > 0) S.larder[k] = v; else delete S.larder[k]; };
  const canPay = r => { for(const k in r) if(have(k) < r[k]) return false; return true; };
  const pay = r => { for(const k in r) take(k, r[k]); };
  const reqTxt = r => Object.keys(r).map(k => r[k] + '× ' + GOODS[k].n).join(' + ');
  const goodPip = k => `<i style="background:${GOODS[k].c};color:${GOODS[k].c}"></i>`;
  // toasts are innerHTML, so the same pip can ride along inside one
  const goodPipT = k => `<span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${GOODS[k].c};vertical-align:-1px"></span>`;

  const clockTxt = ms => { const s = Math.max(0, Math.round(ms/1000));
    return s >= 3600 ? Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m'
      : s >= 60 ? Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s' : s+'s'; };
  const wroll = table => { let tot = 0; for(let i=0;i<table.length;i++) tot += table[i][1];
    let r = Math.random()*tot; for(let i=0;i<table.length;i++){ r -= table[i][1]; if(r <= 0) return table[i][0]; }
    return table[table.length-1][0]; };

  /* ==================================================================
     BUFFS — one aggregate object the pipelines read. Recomputed on change
     and once a second; the pipes themselves never loop, because biteTime
     and moveSpeed are asked for on hot paths.
     ================================================================== */
  const eff = {bite:1, luck:0, ore:0, wood:1, speed:1, pearl:0};
  const tankLuck = () => Math.min(0.18, S.tank.length * 0.03);
  const liveLure = () => { if(!S.lureId || S.lureUses <= 0) return null; return lureById(S.lureId); };
  function recalc(){ const t = now(); let dropped = false;
    for(let i = S.buffs.length - 1; i >= 0; i--){ const b = S.buffs[i];
      if(!b || typeof b !== 'object' || !(b.until > t)){ S.buffs.splice(i,1); dropped = true; } }
    eff.bite = 1; eff.luck = 0; eff.ore = 0; eff.wood = 1; eff.speed = 1; eff.pearl = 0;
    for(let i = 0; i < S.buffs.length; i++){ const e = S.buffs[i].e || {};
      if(e.bite) eff.bite *= e.bite;  if(e.luck) eff.luck += e.luck;    if(e.ore) eff.ore += e.ore;
      if(e.wood) eff.wood *= e.wood;  if(e.speed) eff.speed *= e.speed; if(e.pearl) eff.pearl += e.pearl; }
    const L = liveLure();
    if(L){ if(L.e.bite) eff.bite *= L.e.bite; if(L.e.luck) eff.luck += L.e.luck; }
    eff.luck += tankLuck();
    eff.speed = clamp(eff.speed, 0.5, 1.35);                    // a buff must never make the hero uncontrollable
    if(dropped){ persist(); if(uiReady) paintHud(); }
    return dropped; }
  function addBuff(d){
    for(let i = 0; i < S.buffs.length; i++) if(S.buffs[i].id === d.id){ S.buffs.splice(i,1); break; } // re-cooking refreshes
    S.buffs.push({id:d.id, n:d.n, until:now() + d.ms, e:d.e});
    recalc(); persist(); paintHud(); }

  RF.modify('biteTime',  v => v * eff.bite);
  RF.modify('fishLuck',  v => v + eff.luck);
  RF.modify('oreYield',  v => v + eff.ore);
  RF.modify('woodYield', v => v * eff.wood);
  RF.modify('moveSpeed', v => v * eff.speed);
  RF.modify('pearls',    v => v + eff.pearl);

  /* ==================================================================
     SITING — where the camp goes. Deterministic: findCellNear scans in a
     fixed order over a seeded heightmap, so the camp lands on the same five
     cells every reload, for every client.
     ================================================================== */
  // distance-to-water, one multi-source BFS. Beats re-scanning a window per
  // candidate inside findCellNear's 9,216-cell sweep, five times over.
  const wdist = new Int16Array(N*N);
  { const q = new Int32Array(N*N); let qh = 0, qt = 0;
    for(let i=0;i<N;i++) for(let j=0;j<N;j++){ const k = i*N+j;
      if(HM[i][j] <= 2){ wdist[k] = 0; q[qt++] = k; } else wdist[k] = 9999; }
    while(qh < qt){ const c = q[qh++], ci = (c/N)|0, cj = c%N, d = wdist[c] + 1;
      if(ci>0   && wdist[c-N] > d){ wdist[c-N] = d; q[qt++] = c-N; }
      if(ci<N-1 && wdist[c+N] > d){ wdist[c+N] = d; q[qt++] = c+N; }
      if(cj>0   && wdist[c-1] > d){ wdist[c-1] = d; q[qt++] = c-1; }
      if(cj<N-1 && wdist[c+1] > d){ wdist[c+1] = d; q[qt++] = c+1; } } }

  // Only the props that existed BEFORE the camp: the stations get their own,
  // looser spacing rule below, or the fifth one would have nowhere to stand.
  const PROP0 = RF.PROPS.length;
  const stations = [];
  /* A station has to clear every landmark prop, the paths, every tree/rock/
     flower cell and every ore node — and sit at least four cells from water.
     That last one is not decoration: it guarantees a station is never inside
     the 2.4-unit casting radius, so claiming the E prompt there can never eat
     a cast or quietly stall the auto-rig. */
  /* `slack` scales every clearance at once: a wooded, ore-rich isle can leave
     no cell at all that clears everything comfortably, and a camp with one
     building in it is worse than a camp that stands a little closer together. */
  const clearOf = (i,j,slack) => { const k = keyOf(i,j), wx = i-HALF, wz = j-HALF, s = slack === undefined ? 1 : slack;
    if(wdist[i*N+j] < 4) return false;                          // never inside the 2.4-unit casting radius
    if(RF.decorUsed.has(k) || RF.pathSet.has(k)) return false;
    for(let n = 0; n < PROP0; n++){ const p = RF.PROPS[n];
      if(Math.hypot(p.x - wx, p.z - wz) < (p.r || 2.5) + 2*s) return false; }
    for(let n = 0; n < RF.treeData.length; n++){ const t2 = RF.treeData[n];
      if(Math.hypot(t2.x - wx, t2.z - wz) < 3.2*s) return false; }
    for(let n = 0; n < RF.oreNodes.length; n++){ const o = RF.oreNodes[n];
      if(Math.hypot(o.x - wx, o.z - wz) < 3.2*s) return false; }
    const gap = Math.max(2.2, 2.7*s);                           // two buildings must never share a doorway
    for(let n = 0; n < stations.length; n++)
      if(Math.hypot(stations[n].x - wx, stations[n].z - wz) < gap) return false;
    return true; };

  const sp = RF.spawnCell || [HALF, HALF, 4];
  const anchor = fn.findCellNear(sp[0], sp[1], 8, 22, (i,j) => wdist[i*N+j] <= 11 && clearOf(i,j,1))
    || fn.findCellNear(sp[0], sp[1], 5, 32, (i,j) => wdist[i*N+j] <= 17 && clearOf(i,j,0.8))
    || fn.findCellNear(sp[0], sp[1], 4, 40, (i,j) => clearOf(i,j,0.66));

  function site(id, label, tab, icon, build){
    if(!anchor) return null;
    const c = fn.findCellNear(anchor[0], anchor[1], 0, 7,  (i,j) => clearOf(i,j,1))
      ||      fn.findCellNear(anchor[0], anchor[1], 0, 12, (i,j) => clearOf(i,j,0.78))
      ||      fn.findCellNear(anchor[0], anchor[1], 0, 18, (i,j) => clearOf(i,j,0.62));
    if(!c) return null;
    RF.usedCells.add(keyOf(c[0], c[1])); RF.decorUsed.add(keyOf(c[0], c[1]));
    const x = c[0]-HALF, y = HM[c[0]][c[1]], z = c[1]-HALF;
    const g = new T.Group(); g.position.set(x, y, z); g.userData.camp = 'station:' + id; RF.scene.add(g);
    const st = {id:id, label:label, tab:tab, icon:icon, x:x, y:y, z:z, g:g, i:c[0], j:c[1]};
    stations.push(st);
    try{ build(g, st); }catch(e){ RF.warn('06-content:build:'+id, e); }
    RF.PROPS.push({x:x, z:z, r:1.2, h:y+2.4, g:g});             // so the photo camera can see past it
    return st; }

  /* ---- voxel helpers: one shared cube geometry, materials cached by colour ---- */
  const G1 = new T.BoxGeometry(1,1,1);
  const mcache = {};
  function vmat(col){ const k = 'c'+col; if(!mcache[k]) mcache[k] = new T.MeshLambertMaterial({color:col}); return mcache[k]; }
  function vox(w,h,d,col){ const m = new T.Mesh(G1, vmat(col)); m.scale.set(w,h,d); m.castShadow = true; return m; }
  // a unique material — anything whose glow or colour is animated needs its own
  function voxE(w,h,d,col,em,ei,op){ const o = {color:col, emissive:em===undefined?col:em, emissiveIntensity:ei===undefined?0.7:ei};
    if(op !== undefined){ o.transparent = true; o.opacity = op; }
    const m = new T.Mesh(G1, new T.MeshLambertMaterial(o)); m.scale.set(w,h,d); return m; }
  const at = (m,x,y,z) => { m.position.set(x,y,z); return m; };
  const hex = s => parseInt(String(s).slice(1), 16);

  /* ==================================================================
     THE FIVE STATIONS — built once, standing in the world whether or not
     anyone has pressed Set sail yet.
     ================================================================== */
  const flames = [], emberMat = new T.MeshLambertMaterial({color:0xff9a3c, emissive:0xff6a1a, emissiveIntensity:0.9});
  const embers = [], emberP = [];
  const fireLight = new T.PointLight(0xff9a3c, 0, 9);

  const fireSt = site('fire','The cookfire','fire', pix('sun',13), (g) => {
    for(let k = 0; k < 9; k++){ const a = k/9*RF.TAU;
      g.add(at(vox(0.3,0.22,0.3, 0x7b8288), Math.cos(a)*0.62, 0.11, Math.sin(a)*0.62)); }
    const l1 = vox(0.92,0.17,0.17, 0x6b4a2a); at(l1, 0, 0.12, 0); l1.rotation.y = 0.5; g.add(l1);
    const l2 = vox(0.92,0.17,0.17, 0x5c3f22); at(l2, 0, 0.26, 0); l2.rotation.y = -0.7; g.add(l2);
    for(let k = 0; k < 3; k++){ const f = voxE(0.34 - k*0.08, 0.4, 0.34 - k*0.08, 0xffb347, 0xff6a1a, 1.1);
      at(f, (k-1)*0.16, 0.42 + k*0.16, (k===1?0.12:-0.08)); g.add(f); flames.push(f); }
    for(let k = 0; k < 8; k++){ const e = new T.Mesh(G1, emberMat); e.scale.setScalar(0.07); e.visible = false;
      g.add(e); embers.push(e); emberP.push({t:0, x:0, y:0, z:0, vy:0}); }
    // a pot on a spit — the thing the recipes actually happen in
    for(const s of [-0.62, 0.62]) g.add(at(vox(0.09,1.1,0.09, 0x4a3a28), s, 0.55, 0));
    g.add(at(vox(1.34,0.08,0.08, 0x4a3a28), 0, 1.06, 0));
    g.add(at(vox(0.56,0.42,0.56, 0x3a4046), 0, 0.72, 0));
    g.add(at(vox(0.62,0.07,0.62, 0x596068), 0, 0.95, 0));
    fireLight.position.set(0, 0.9, 0); g.add(fireLight);
  });

  const rackSlots = [];
  site('rack','The curing rack','rack', pix('fish',13), (g) => {
    for(const s of [-1.05, 1.05]){ g.add(at(vox(0.14,1.7,0.14, 0x6b4a2a), s, 0.85, 0));
      g.add(at(vox(0.5,0.1,0.1, 0x6b4a2a), s, 1.62, 0)); }
    g.add(at(vox(2.3,0.1,0.1, 0x7a5530), 0, 1.62, 0));
    g.add(at(vox(2.3,0.06,0.06, 0x7a5530), 0, 1.36, 0.2));
    for(let k = 0; k < 3; k++){ const h = new T.Group(); h.position.set((k-1)*0.72, 1.62, 0); h.visible = false;
      h.add(at(vox(0.03,0.3,0.03, 0xd9d2c4), 0, -0.15, 0));
      const item = voxE(0.3,0.42,0.13, 0xcccccc, 0x000000, 0); at(item, 0, -0.5, 0); h.add(item);
      g.add(h); rackSlots.push({g:h, item:item}); }
  });

  const benchLures = [];
  site('bench','The lure bench','bench', pix('rod',13), (g) => {
    for(const c of [[-0.72,-0.38],[0.72,-0.38],[-0.72,0.38],[0.72,0.38]])
      g.add(at(vox(0.14,0.78,0.14, 0x6b4a2a), c[0], 0.39, c[1]));
    g.add(at(vox(1.85,0.14,1.1, 0xa8763f), 0, 0.85, 0));
    g.add(at(vox(0.3,0.26,0.3, 0x8a97a0), -0.6, 1.05, 0.18));      // the vise
    g.add(at(vox(0.22,0.22,0.34, 0xd8483f), 0.42, 1.03, -0.16));   // a spool of thread
    g.add(at(vox(0.5,0.16,0.34, 0x7a5530), 0.1, 0.99, 0.3));       // the tin of hooks
    g.add(at(vox(0.06,0.06,1.0, 0x6b4a2a), -0.95, 1.5, 0));
    g.add(at(vox(0.1,0.72,0.1, 0x6b4a2a), -0.95, 1.14, -0.48));
    g.add(at(vox(0.1,0.72,0.1, 0x6b4a2a), -0.95, 1.14, 0.48));
    for(let k = 0; k < 5; k++){ const m = voxE(0.1,0.2,0.06, 0x888888, 0x000000, 0);
      at(m, -0.95, 1.36, -0.4 + k*0.2); m.visible = false; g.add(m); benchLures.push(m); }
  });

  const tankFish = [], tankG = new T.Group();
  site('tank','The tank','tank', pix('trophy',13), (g) => {
    for(const c of [[-0.78,-0.44],[0.78,-0.44],[-0.78,0.44],[0.78,0.44]])
      g.add(at(vox(0.16,0.72,0.16, 0x5c3f22), c[0], 0.36, c[1]));
    g.add(at(vox(2.0,0.14,1.2, 0x8a5d33), 0, 0.79, 0));
    const water = voxE(1.72,0.86,0.96, RF.WORLD.water || 0x2fc0e8, 0x000000, 0, 0.42);
    at(water, 0, 1.32, 0); water.renderOrder = 1; g.add(water);
    const glass = new T.Mesh(G1, new T.MeshLambertMaterial({color:0xcfeef6, transparent:true, opacity:0.16, depthWrite:false}));
    glass.scale.set(1.82,0.96,1.06); at(glass, 0, 1.34, 0); glass.renderOrder = 2; g.add(glass);
    for(const c of [[-0.9,-0.52],[0.9,-0.52],[-0.9,0.52],[0.9,0.52]])
      g.add(at(vox(0.08,1.0,0.08, 0x8a5d33), c[0], 1.34, c[1]));
    g.add(at(vox(1.9,0.08,1.12, 0x8a5d33), 0, 1.85, 0));
    g.add(at(vox(1.66,0.1,0.9, 0xd8cba4), 0, 0.92, 0));            // sand floor
    tankG.position.set(0, 1.3, 0); g.add(tankG);
  });

  site('board','The notice board','board', pix('map',13), (g) => {
    for(const s of [-0.72, 0.72]) g.add(at(vox(0.16,1.9,0.16, 0x6b4a2a), s, 0.95, 0));
    g.add(at(vox(1.9,1.15,0.12, 0x8a5d33), 0, 1.42, 0));
    g.add(at(vox(2.06,0.14,0.2, 0x5c3f22), 0, 2.06, 0));           // a little roof over the papers
    for(let k = 0; k < 5; k++){ const p = vox(0.34,0.44,0.03, k%2 ? 0xf2ede2 : 0xe6dcc4);
      at(p, -0.6 + (k%3)*0.6, 1.62 - ((k/3)|0)*0.5, 0.08); p.rotation.z = (k*0.37 % 0.24) - 0.12; g.add(p); }
  });

  /* ---- the tideline lanterns: dark posts most of the time, a lit shore for
     nine minutes in every forty-five ---- */
  const lanternLamps = [];
  if(anchor){ const cand = [];
    for(let i = 2; i < N-2; i++) for(let j = 2; j < N-2; j++){
      if(HM[i][j] !== 3 || wdist[i*N+j] > 1) continue;
      if(RF.usedCells.has(keyOf(i,j)) || RF.pathSet.has(keyOf(i,j)) || RF.decorUsed.has(keyOf(i,j))) continue;
      if(Math.hypot(i - anchor[0], j - anchor[1]) > 26) continue;   // a rocky isle has few clear sand cells; reach further for them
      cand.push([i,j]); }
    for(let k = 0; k < cand.length && lanternLamps.length < 9; k++){ const c = cand[k];
      let ok = true;
      for(let n = 0; n < lanternLamps.length; n++){ const L = lanternLamps[n];
        if(Math.hypot(L.ci - c[0], L.cj - c[1]) < 3){ ok = false; break; } }
      if(!ok) continue;
      RF.decorUsed.add(keyOf(c[0], c[1]));
      const g = new T.Group(); g.position.set(c[0]-HALF, HM[c[0]][c[1]], c[1]-HALF);
      g.add(at(vox(0.12,1.5,0.12, 0x5c3f22), 0, 0.75, 0));
      g.add(at(vox(0.34,0.08,0.34, 0x5c3f22), 0, 1.56, 0));
      const lamp = voxE(0.26,0.3,0.26, 0xffd98a, 0xffb320, 0, 0.92);
      at(lamp, 0, 1.36, 0); g.add(lamp);
      g.userData.camp = 'lantern'; RF.scene.add(g);
      lanternLamps.push({g:g, lamp:lamp, ci:c[0], cj:c[1]}); } }

  /* ==================================================================
     THE SHORE — forage that regrows, bottles that wash in, pots that soak.
     ================================================================== */
  const nodes = [];
  { // deterministic: a seeded shuffle of the tideline, so every reload plants
    // the same beds and a returning player finds the shore they remember
    const rnd = fn.mulberry32(((RF.WORLD.seed || 0) * 2654435761 + 40503) | 0);
    const cells = [];
    for(let i = 2; i < N-2; i++) for(let j = 2; j < N-2; j++){
      if(HM[i][j] !== 3 || wdist[i*N+j] > 1) continue;
      const k = keyOf(i,j);
      if(RF.usedCells.has(k) || RF.pathSet.has(k) || RF.decorUsed.has(k)) continue;
      if(fn.reachable(i,j)) cells.push([i,j]); }
    for(let i = cells.length - 1; i > 0; i--){ const r = (rnd()*(i+1))|0, t2 = cells[i]; cells[i] = cells[r]; cells[r] = t2; }
    const pick = [];
    for(let k = 0; k < cells.length && pick.length < FORAGE_MAX; k++){ const c = cells[k];
      let ok = true;
      for(let n = 0; n < pick.length; n++) if(Math.hypot(pick[n][0]-c[0], pick[n][1]-c[1]) < 3){ ok = false; break; }
      if(ok) pick.push(c); }
    for(let k = 0; k < pick.length; k++){ const c = pick[k];
      let r = rnd() * 100, type = FORAGE[0];
      for(let f = 0; f < FORAGE.length; f++){ r -= FORAGE[f].w; if(r <= 0){ type = FORAGE[f]; break; } }
      const g = new T.Group(); g.position.set(c[0]-HALF, HM[c[0]][c[1]], c[1]-HALF);
      g.rotation.y = rnd() * RF.TAU;
      if(type.k === 'kelp'){ for(let b = 0; b < 3; b++){ const m = vox(0.09, 0.42 + b*0.1, 0.09, type.col);
          at(m, (b-1)*0.16, (0.42 + b*0.1)/2, b*0.06); m.rotation.z = (b-1)*0.22; g.add(m); } }
      else if(type.k === 'clam'){ g.add(at(vox(0.3,0.13,0.24, type.col), 0, 0.07, 0));
        g.add(at(vox(0.22,0.1,0.18, 0xf2ead6), 0.14, 0.06, 0.1)); }
      else if(type.k === 'samphire'){ for(let b = 0; b < 4; b++)
          g.add(at(vox(0.07,0.3,0.07, type.col), (b%2?0.11:-0.11), 0.15, (b<2?0.1:-0.1))); }
      else if(type.k === 'drift'){ const m = vox(0.72,0.15,0.17, type.col); at(m, 0, 0.08, 0); m.rotation.y = 0.4; g.add(m);
        g.add(at(vox(0.26,0.12,0.13, 0x8f7a5c), 0.28, 0.16, 0.08)); }
      else g.add(at(voxE(0.16,0.12,0.16, type.col, type.col, 0.35, 0.85), 0, 0.07, 0));
      g.userData.camp = 'node:' + type.k; RF.scene.add(g);
      nodes.push({g:g, k:type.k, i:c[0], j:c[1], x:c[0]-HALF, z:c[1]-HALF, idx:k, live:true}); } }

  const bottleMesh = [], BOTTLE_MAX = 2;
  for(let k = 0; k < BOTTLE_MAX; k++){ const g = new T.Group();
    const b = voxE(0.16,0.34,0.16, 0x86d8b0, 0x2f6f52, 0.3, 0.8); at(b, 0, 0.2, 0); b.rotation.z = 1.2; g.add(b);
    g.add(at(vox(0.07,0.09,0.07, 0xc9a86a), 0.2, 0.15, 0));
    g.userData.camp = 'bottle'; g.visible = false; RF.scene.add(g); bottleMesh.push(g); }

  const buoys = [];
  for(let k = 0; k < POT_MAX; k++){ const g = new T.Group();
    const f = voxE(0.24,0.3,0.24, 0x39d7c4, 0x1c8478, 0.5); at(f, 0, 0.15, 0); g.add(f);
    g.add(at(vox(0.08,0.34,0.08, 0x6b4a2a), 0, 0.44, 0));
    const flag = voxE(0.2,0.14,0.03, 0xffcf5c, 0x000000, 0); at(flag, 0.13, 0.54, 0); g.add(flag);
    g.userData.camp = 'buoy'; g.visible = false; RF.scene.add(g); buoys.push({g:g, float:f, flag:flag}); }

  /* ---- Barnacle ---- */
  const gull = new T.Group();
  { gull.add(at(vox(0.34,0.24,0.2, 0xf2f2ee), 0, 0, 0));
    gull.add(at(vox(0.17,0.16,0.15, 0xf2f2ee), 0.2, 0.09, 0));
    gull.add(at(vox(0.11,0.05,0.05, 0xffb347), 0.32, 0.07, 0));
    const wL = vox(0.26,0.05,0.3, 0xdfe6e4); at(wL, -0.02, 0.08, -0.2); gull.add(wL);
    const wR = vox(0.26,0.05,0.3, 0xdfe6e4); at(wR, -0.02, 0.08, 0.2); gull.add(wR);
    const lamp = voxE(0.1,0.12,0.1, 0xffd98a, 0xffb320, 0, 0.9); at(lamp, -0.16, -0.12, 0); gull.add(lamp);
    gull.userData = {wL:wL, wR:wR, lamp:lamp, camp:'gull'};
    gull.visible = false; RF.scene.add(gull); }

  const marker = new T.Group();
  { const m = voxE(0.2,0.2,0.2, 0x39d7c4, 0x39d7c4, 0.9); m.rotation.y = 0.78; marker.add(at(m, 0, 0, 0));
    marker.add(at(voxE(0.05,1.2,0.05, 0x39d7c4, 0x39d7c4, 0.6, 0.35), 0, -0.75, 0));
    marker.visible = false; RF.scene.add(marker); }
  let markerT = 0;

  const RARBY = {}; for(let i = 0; i < RF.ALL_FISH.length; i++) RARBY[RF.ALL_FISH[i][0].name] = RF.ALL_FISH[i][0].rar;

  /* ==================================================================
     WORLD ⇄ SAVE SYNC — the meshes are only ever a picture of the save.
     ================================================================== */
  const foragePeriod = () => festOn() ? FORAGE_MS_FEST : FORAGE_MS;
  function syncNodes(){ const t = now();
    for(let k = 0; k < nodes.length; k++){ const n = nodes[k], gone = WS.nodes[n.idx];
      n.live = !(gone && gone > t);
      if(n.g.visible !== n.live) n.g.visible = n.live; } }
  function syncBottles(){ for(let k = 0; k < bottleMesh.length; k++){ const b = WS.bottles[k];
      if(b){ bottleMesh[k].position.set(b.i - HALF, HM[b.i][b.j], b.j - HALF); bottleMesh[k].visible = true; }
      else bottleMesh[k].visible = false; } }
  function syncPots(){ const t = now();
    for(let k = 0; k < buoys.length; k++){ const p = WS.pots[k], B = buoys[k];
      if(!p){ B.g.visible = false; continue; }
      B.g.visible = true; B.g.position.set(p.i - HALF, RF.WATER_TOP - 0.1, p.j - HALF);
      const ready = t - p.at >= POT_SOAK;
      B.flag.visible = ready;
      B.float.material.color.setHex(ready ? 0xffcf5c : 0x39d7c4);
      B.float.material.emissive.setHex(ready ? 0x8a6a1e : 0x1c8478); } }
  function syncRack(){ const t = now();
    for(let k = 0; k < rackSlots.length; k++){ const s = S.rack[k], R = rackSlots[k];
      if(!s || !CURES[s.in]){ R.g.visible = false; continue; }
      R.g.visible = true;
      const c = CURES[s.in], done = t >= s.at + c.ms;
      R.item.material.color.set(GOODS[done ? c.out : s.in].c);
      R.item.material.emissive.set(done ? GOODS[c.out].c : '#000000');
      R.item.material.emissiveIntensity = done ? 0.4 : 0; } }
  function syncBench(){ for(let k = 0; k < benchLures.length; k++){ const L = LURES[k], m = benchLures[k];
      const n = S.lures[L.id] | 0, eq = S.lureId === L.id && S.lureUses > 0;
      m.visible = n > 0 || eq;
      if(!m.visible) continue;
      m.material.color.set(eq ? '#39d7c4' : '#c9b48a');
      m.material.emissive.set(eq ? '#39d7c4' : '#000000');
      m.material.emissiveIntensity = eq ? 0.5 : 0; } }
  function rebuildTank(){
    while(tankG.children.length) tankG.remove(tankG.children[0]);   // geometry + materials are shared and cached: nothing to dispose
    tankFish.length = 0;
    for(let k = 0; k < S.tank.length && k < 6; k++){ const e = S.tank[k];
      const col = hex(RF.RAR[e.r] || '#b9c6c4'), g = new T.Group();
      g.add(at(vox(0.3,0.17,0.13, col), 0, 0, 0));
      g.add(at(vox(0.1,0.16,0.05, col), -0.19, 0, 0));
      g.add(at(vox(0.04,0.04,0.04, 0x0e1a20), 0.1, 0.03, 0.07));
      tankG.add(g);
      tankFish.push({g:g, ph:k*1.15, sp:0.42 + (k%4)*0.09, rz:0.24 + (k%3)*0.07, y:((k%3)-1)*0.2}); }
    recalc(); }

  syncNodes(); syncBottles(); syncPots(); syncRack(); syncBench(); rebuildTank();

  /* ==================================================================
     ACTIONS
     ================================================================== */
  const say = (m,k) => fn.toast(m, k);

  function gatherNode(n){
    const amt = 1 + (Math.random() < (festOn() ? 0.5 : 0.25) ? 1 : 0);
    give(n.k, amt); S.picked++;
    WS.nodes[n.idx] = now() + foragePeriod() * (0.85 + Math.random()*0.3);
    n.live = false; n.g.visible = false;
    fn.fxBurst(n.x, HM[n.i][n.j] + 0.4, n.z, {n:9, cols:[hex(GOODS[n.k].c), 0xffffff], speed:2.4, up:2.6, size:0.6, ttl:0.7});
    RF.sfx.pick(); fn.addShake(0.05);
    say(`${goodPipT(n.k)} +${amt} ${GOODS[n.k].n}`, 'good');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function readBottle(idx){
    const b = WS.bottles[idx]; if(!b) return;
    WS.bottles.splice(idx, 1); syncBottles();
    const id = clamp(b.id | 0, 0, LORE.length - 1), first = !S.lore[id];
    S.lore[id] = now();
    RF.sfx.sparkle(); fn.addShake(0.06);
    if(Math.random() < 0.5) give('glass', 1);
    const read = Object.keys(S.lore).length;
    showNote((first ? 'A MESSAGE IN A BOTTLE · ' : 'THIS ONE AGAIN · ') + read + '/' + LORE.length, LORE[id]);
    if(first && read === LORE.length) say('📜 the ledger of small facts is complete. it explains nothing.', 'gold');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function setPot(c){
    if(have('pot') <= 0 || WS.pots.length >= POT_MAX) return;
    take('pot', 1);
    WS.pots.push({i:c[0], j:c[1], at:now()});
    syncPots(); RF.sfx.splash(0.06);
    fn.fxBurst(c[0]-HALF, RF.WATER_TOP, c[1]-HALF, {n:12, cols:[0xcfeef6, 0x39d7c4], speed:2.2, up:2.4, size:0.7});
    say(`${pix('boat',13)} pot down. it does the work now.`, 'good');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function haulPot(idx){
    const p = WS.pots[idx]; if(!p) return;
    const soak = now() - p.at;
    if(soak < POT_SOAK){ RF.sfx.deny(); say(`still soaking · ${clockTxt(POT_SOAK - soak)} to go`); return; }
    const count = 1 + Math.floor(Math.min(1, soak / POT_FULL) * 4) + (festOn() ? 1 : 0);
    WS.pots.splice(idx, 1);
    give('pot', 1);                                            // the pot always comes home
    const got = {};
    for(let k = 0; k < count; k++){ const g = wroll(POT_TABLE); give(g, 1); got[g] = (got[g]|0) + 1; }
    syncPots(); RF.sfx.splash(0.09); RF.sfx.ore(); fn.addShake(0.12);
    fn.fxBurst(p.i-HALF, RF.WATER_TOP + 0.3, p.j-HALF, {n:20, cols:[0xff9f7a, 0xe07a4a, 0xcfeef6], speed:3, up:3.6, size:0.8});
    say('the pot came up: ' + Object.keys(got).map(k => goodPipT(k) + ' ' + got[k] + '× ' + GOODS[k].n).join(' · '), 'gold');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function cook(d){
    if(d.fest && !festOn()){ RF.sfx.deny(); say('the stew only cooks while the lanterns are lit'); return; }
    if(!canPay(d.req)){ RF.sfx.deny(); say('the larder is short: ' + reqTxt(d.req), 'bad'); return; }
    pay(d.req); S.cooked++; addBuff(d);
    RF.sfx.craft(); fn.addShake(0.09);
    if(fireSt) fn.fxBurst(fireSt.x, fireSt.y + 1.3, fireSt.z, {n:16, cols:[0xffb347, 0xff6a1a, 0xffe6a8], speed:2.4, up:3.4, size:0.7});
    say(`${pix('sun',13)} <b>${d.n}</b> · ${d.blurb}`, 'gold');
    persist(); if(panelOn) renderPanel(); }

  function rackPut(slot, key){
    if(S.rack[slot]) return;
    if(!CURES[key] || have(key) <= 0){ RF.sfx.deny(); return; }
    take(key, 1); S.rack[slot] = {in:key, at:now()};
    RF.sfx.bait(); syncRack(); say(`${goodPipT(key)} on the rack · ${clockTxt(CURES[key].ms)}`, 'good');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function rackTake(slot){
    const s = S.rack[slot]; if(!s || !CURES[s.in]) return;
    const c = CURES[s.in], left = s.at + c.ms - now();
    if(left > 0){ RF.sfx.deny(); say(`not cured yet · ${clockTxt(left)}`); return; }
    S.rack[slot] = null; give(c.out, 1);
    RF.sfx.ore(); syncRack(); say(`${goodPipT(c.out)} +1 ${GOODS[c.out].n}`, 'good');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function tieLure(L){
    if(!canPay(L.req)){ RF.sfx.deny(); say('the bench is short: ' + reqTxt(L.req), 'bad'); return; }
    pay(L.req); S.lures[L.id] = (S.lures[L.id] | 0) + 1;
    RF.sfx.craft(); syncBench(); say(`${pix('rod',13)} tied a <b>${L.n}</b>`, 'good');
    persist(); if(panelOn) renderPanel(); }

  function equipLure(L){
    if((S.lures[L.id] | 0) <= 0){ RF.sfx.deny(); return; }
    if(S.lureId && S.lureUses > 0) S.lures[S.lureId] = (S.lures[S.lureId] | 0) + 1;  // the old one goes back in the tin
    S.lures[L.id] = (S.lures[L.id] | 0) - 1; if(S.lures[L.id] <= 0) delete S.lures[L.id];
    S.lureId = L.id; S.lureUses = L.uses;
    RF.sfx.bait(); recalc(); syncBench(); paintHud();
    say(`${pix('rod',13)} <b>${L.n}</b> on the line · ${L.uses} fish in it`, 'good');
    persist(); if(panelOn) renderPanel(); }

  function tankAdd(name){
    if(S.tank.length >= 6){ RF.sfx.deny(); say('the tank is full · six is already showing off'); return; }
    const d = RF.state.dex[name]; if(!d) return;
    for(let k = 0; k < S.tank.length; k++) if(S.tank[k].n === name) return;
    S.tank.push({n:name, kg:d.best || 0, r:RARBY[name] || 'common'});
    rebuildTank(); RF.sfx.win(); fn.addShake(0.1);
    say(`${pix('trophy',13)} <b>${name}</b> in the tank · the hand steadies a little`, 'gold');
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function tankDrop(i){ if(!S.tank[i]) return; S.tank.splice(i, 1); rebuildTank(); RF.sfx.close();
    persist(); paintHud(); if(panelOn) renderPanel(); }

  function feedGull(key){
    if(have(key) < 2){ RF.sfx.deny(); return; }
    take(key, 2); S.gull = 1;
    RF.sfx.win(); fn.addShake(0.14);
    say('a gull lands on the rack and refuses to leave. his name is <b>Barnacle</b> now.', 'gold');
    persist(); if(panelOn) renderPanel(); }

  /* ==================================================================
     LOOK — all of it prefixed .lard-, all of it from index.html's tokens.
     ================================================================== */
  RF.css(`
  .lard-ov{z-index:11;}
  .lard-card{width:min(790px,95vw);}
  .lard-card .tabbtn{font-size:10px;letter-spacing:.09em;padding:8px 0;}
  .lard-strip{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 2px;}
  .lard-good{display:flex;align-items:center;gap:6px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:9px;padding:5px 9px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted);}
  .lard-good i{width:9px;height:9px;border-radius:3px;display:inline-block;box-shadow:0 0 6px currentColor;}
  .lard-good b{font-family:"Chakra Petch";font-weight:700;color:var(--ink);}
  .lard-row{display:flex;align-items:center;gap:12px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:12px;padding:10px 13px;margin-bottom:7px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);}
  .lard-row .nm{flex:1;font-size:13px;font-weight:600;color:var(--ink);min-width:0;}
  .lard-row .nm small{display:block;font-size:10.5px;color:var(--muted);font-weight:400;line-height:1.5;}
  .lard-row .cost{font-size:10.5px;color:var(--faint);text-align:right;max-width:220px;}
  .lard-row.on{border-color:rgba(57,215,196,.55);box-shadow:inset 0 0 0 1px rgba(57,215,196,.22);}
  .lard-row.gold{border-color:rgba(255,207,92,.5);}
  .lard-row .btn{flex:0 0 auto;}
  .lard-hint{font-size:11px;color:var(--faint);line-height:1.65;margin:2px 0 10px;}
  .lard-hint b{color:var(--teal);font-weight:600;}
  .lard-empty{font-size:11.5px;color:var(--faint);padding:12px 2px 16px;line-height:1.7;}
  .lard-lore{display:flex;gap:11px;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:11px;padding:9px 12px;margin-bottom:6px;font-size:11.5px;line-height:1.65;color:var(--ink);}
  .lard-lore .no{font-family:"Chakra Petch";font-weight:700;color:var(--faint);min-width:22px;}
  .lard-lore.locked{opacity:.38;}
  .lard-note{position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:12;width:min(520px,86vw);
    background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid rgba(255,207,92,.45);border-radius:13px;padding:14px 18px;font-size:12.5px;line-height:1.7;
    color:var(--ink);box-shadow:var(--glass-hi),0 12px 34px rgba(2,8,10,.45);opacity:0;pointer-events:none;transition:opacity .35s;}
  .lard-note.on{opacity:1;pointer-events:auto;cursor:pointer;}
  .lard-note .lh{font-family:"Chakra Petch";font-weight:700;font-size:9.5px;letter-spacing:.22em;color:var(--gold);margin-bottom:6px;}
  .lard-hud{position:fixed;right:12px;top:196px;z-index:5;display:none;flex-direction:column;gap:5px;align-items:flex-end;}
  .lard-hud.on{display:flex;}
  .lard-chip{display:flex;gap:8px;align-items:center;background:var(--glass-hud);
    backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid var(--glass-bd);border-radius:10px;padding:5px 10px;font-size:10.5px;font-weight:600;
    color:var(--muted);box-shadow:var(--glass-hi),0 5px 16px rgba(2,8,10,.28);font-variant-numeric:tabular-nums;}
  .lard-chip b{font-family:"Chakra Petch";font-weight:700;color:var(--teal);}
  .lard-chip.fest{border-color:rgba(255,207,92,.55);color:var(--gold);animation:lardPulse 2.4s ease-in-out infinite;}
  .lard-chip.fest b{color:var(--gold);}
  .lard-chip.warn{border-color:rgba(255,93,122,.5);color:var(--rose);}
  .lard-chip.warn b{color:var(--rose);}
  @keyframes lardPulse{0%,100%{box-shadow:var(--glass-hi),0 0 12px rgba(255,207,92,.12);}
                        50%{box-shadow:var(--glass-hi),0 0 22px rgba(255,207,92,.34);}}
  @media (prefers-reduced-motion:reduce){
    .lard-note{transition:none;}
    .lard-chip.fest{animation:none;}
  }`, 'mod-06-content-css');

  const hudEl = RF.el('<div class="lard-hud" id="lardHud"></div>');
  const noteEl = RF.el('<div class="lard-note"><div class="lh"></div><div class="lb"></div></div>');
  let noteT = 0;
  noteEl.onclick = () => { noteEl.classList.remove('on'); noteT = 0; };
  function showNote(head, text){ noteEl.firstElementChild.textContent = head;
    noteEl.lastElementChild.textContent = text; noteEl.classList.add('on'); noteT = 11; }

  const TABS = [['fire','FIRE'],['rack','RACK'],['pots','POTS'],['bench','BENCH'],
    ['tank','TANK'],['board','BOARD'],['ledger','LEDGER']];
  const ov = RF.el('<div class="overlay lard-ov"><div class="card lard-card">'
    + '<div class="card-head"><h2 class="font-d">THE SHORE CAMP</h2>'
    + '<span style="display:flex;gap:10px;align-items:baseline"><span class="sub" id="lardSub"></span>'
    + '<button class="x" data-act="close">ESC</button></span></div>'
    + '<div class="lard-strip" id="lardStrip"></div>'
    + '<div class="tabs" id="lardTabs">'
    + TABS.map(t => `<button class="tabbtn" data-act="tab" data-v="${t[0]}">${t[1]}</button>`).join('')
    + '</div><div class="tabpane" id="lardBody"></div></div></div>');
  const subEl = ov.querySelector('#lardSub'), stripEl = ov.querySelector('#lardStrip'),
        tabsEl = ov.querySelector('#lardTabs'), bodyEl = ov.querySelector('#lardBody');
  let panelOn = false, curTab = 'fire';

  function openPanel(tab){ if(tab) curTab = tab;
    if(panelOn){ renderPanel(); return; }
    panelOn = true;
    for(const k in RF.keys) RF.keys[k] = false;               // whatever was held stays behind at the door
    fn.hint(''); ov.classList.add('on'); RF.sfx.open(); renderPanel(); paintHud(); }
  function closePanel(){ if(!panelOn) return;
    panelOn = false; ov.classList.remove('on'); RF.sfx.close(); persistNow(); paintHud(); }
  RF.on('panel', (n, open) => { if(open && panelOn) closePanel(); });

  /* ==================================================================
     PANEL CONTENT
     ================================================================== */
  const row = (cls, name, sub, right, btns) => `<div class="lard-row${cls?' '+cls:''}">`
    + `<div class="nm">${name}<small>${sub}</small></div>`
    + (right ? `<div class="cost">${right}</div>` : '') + (btns || '') + '</div>';
  const btn = (act, v, label, cls, dis) =>
    `<button class="btn${cls?' '+cls:''}" data-act="${act}" data-v="${v}"${dis?' disabled':''}>${label}</button>`;
  const costTxt = r => { const parts = [];
    for(const k in r) parts.push(`<span style="color:${have(k) >= r[k] ? 'var(--muted)' : 'var(--rose)'}">${r[k]}× ${GOODS[k].n}</span>`);
    return parts.join(' + '); };
  function effTxt(e){ const p = [];
    if(e.bite) p.push('bites ' + Math.round((1 - e.bite)*100) + '% sooner');
    if(e.luck) p.push('luck +' + e.luck.toFixed(2));
    if(e.ore) p.push('+' + e.ore + ' ore a swing');
    if(e.wood) p.push('wood ×' + e.wood);
    if(e.speed) p.push(Math.round((e.speed - 1)*100) + '% quicker on foot');
    if(e.pearl) p.push('+' + e.pearl + ' ◉ a catch');
    return p.join(' · ') || 'no effect'; }

  function rFire(){
    let h = '<div class="lard-hint">the fire turns a haul into a while. cooking a dish again refreshes it rather than stacking it.'
      + (RF.online ? ' <b>signed in</b>, the server rolls your catches and your ore — so luck and yield stay home, but a faster bite and quicker feet still count.' : '') + '</div>';
    if(S.buffs.length){ h += '<div class="seclab">on the go</div>';
      for(let i = 0; i < S.buffs.length; i++){ const b = S.buffs[i];
        h += row('on', b.n, effTxt(b.e), '<b style="color:var(--teal)">' + clockTxt(b.until - now()) + '</b>'); } }
    h += '<div class="seclab">the pot</div>';
    for(let i = 0; i < DISHES.length; i++){ const d = DISHES[i];
      const locked = d.fest && !festOn(), ok = canPay(d.req) && !locked;
      h += row(ok ? 'gold' : '',
        d.n + (locked ? ' <span style="color:var(--gold);font-size:10px">· lantern tide only</span>' : ''),
        d.s + ' — ' + d.blurb + ' · ' + Math.round(d.ms/MIN) + ' min',
        costTxt(d.req), btn('cook', d.id, 'COOK', ok ? 'gold' : '', !ok)); }
    return h; }

  function rRack(){
    let h = '<div class="lard-hint">three lines and no hurry. the rack cures on the <b>real clock</b> — close the game, come back, it kept going.</div>';
    for(let k = 0; k < 3; k++){ const s = S.rack[k];
      if(s && CURES[s.in]){ const c = CURES[s.in], left = s.at + c.ms - now(), done = left <= 0;
        h += row(done ? 'gold' : 'on', `line ${k+1} · ${GOODS[s.in].n} → ${GOODS[c.out].n}`,
          done ? 'cured. take it down.' : c.n + '…',
          done ? '<b style="color:var(--gold)">READY</b>' : clockTxt(left),
          btn('racktake', k, done ? 'TAKE' : 'WAIT', done ? 'gold' : '', !done)); }
      else { const opts = CURE_ORDER.filter(x => have(x) > 0);
        h += row('', `line ${k+1} · empty`,
          opts.length ? 'hang something on it' : 'nothing in the larder cures yet — forage, or land a fish for a Trim',
          '', opts.map(x => btn('rackput', k + ':' + x, GOODS[x].n)).join(' ')); } }
    h += '<div class="seclab">what cures into what</div>';
    for(let i = 0; i < CURE_ORDER.length; i++){ const x = CURE_ORDER[i], c = CURES[x];
      h += row('', `${GOODS[x].n} → ${GOODS[c.out].n}`, c.n, Math.round(c.ms/MIN) + ' min'); }
    return h; }

  const POT_REQ = {drift:3, kelp:1};
  function rPots(){
    let h = '<div class="lard-hint">weave a pot, stand at the water and press <b>G</b> to sink it. it fishes while you do not.'
      + ' six minutes gets you something; half an hour gets you a proper haul. the pot always comes back up with the catch.</div>';
    h += row(canPay(POT_REQ) ? 'gold' : '', 'Weave a crab pot', 'withy and driftwood, an afternoon',
      costTxt(POT_REQ), btn('weave', '', 'WEAVE', canPay(POT_REQ) ? 'gold' : '', !canPay(POT_REQ)));
    h += `<div class="seclab">pots out · ${WS.pots.length}/${POT_MAX} · ${have('pot')} in the pack</div>`;
    if(!WS.pots.length) h += '<div class="lard-empty">nothing soaking. the bay is full of crabs having an easy week.</div>';
    for(let k = 0; k < WS.pots.length; k++){ const p = WS.pots[k], soak = now() - p.at, ready = soak >= POT_SOAK;
      const pct = Math.min(100, Math.round(soak / POT_FULL * 100));
      h += row(ready ? 'gold' : 'on', `pot ${k+1} · ${Math.round(p.i - HALF)}, ${Math.round(p.j - HALF)}`,
        ready ? `soaked ${clockTxt(soak)} · ${pct}% full` : `${clockTxt(POT_SOAK - soak)} before it is worth pulling`,
        ready ? '<b style="color:var(--gold)">READY</b>' : pct + '%',
        btn('haul', k, ready ? 'HAUL' : 'SOAKING', ready ? 'gold' : '', !ready)); }
    return h; }

  function rBench(){
    const L = liveLure();
    let h = '<div class="lard-hint">a lure rides under whatever bait you are using and wears out on fish <b>landed</b> — a snapped line costs you nothing here either.</div>';
    h += L ? row('on', 'on the line · ' + L.n, effTxt(L.e), `<b style="color:var(--teal)">${S.lureUses}</b> fish left`, btn('unequip', '', 'STOW'))
           : row('', 'nothing on the line', 'tie one below, then put it on', '');
    h += '<div class="seclab">the tin</div>';
    for(let i = 0; i < LURES.length; i++){ const l = LURES[i], n = S.lures[l.id] | 0, ok = canPay(l.req);
      h += row(n ? 'on' : '', l.n + (n ? ` <span style="color:var(--teal);font-size:11px">×${n}</span>` : ''),
        l.s + ' — ' + effTxt(l.e) + ' · ' + l.uses + ' fish',
        costTxt(l.req), btn('tie', l.id, 'TIE', '', !ok) + ' ' + btn('equip', l.id, 'USE', 'gold', n <= 0)); }
    return h; }

  function rTank(){
    let h = `<div class="lard-hint">six slots of glass on the shore. a stocked tank is worth <b>+${tankLuck().toFixed(2)}</b> luck — every fish adds 0.03 — and you can watch them from the path.</div>`;
    h += `<div class="seclab">in the glass · ${S.tank.length}/6</div>`;
    if(!S.tank.length) h += '<div class="lard-empty">empty water. land something, then mount it.</div>';
    for(let k = 0; k < S.tank.length; k++){ const e = S.tank[k];
      h += row('on', `<span style="color:${RF.RAR[e.r] || '#b9c6c4'}">${e.n}</span>`,
        e.r + ' · personal best ' + e.kg + ' kg', '', btn('tankdrop', k, 'RELEASE')); }
    const names = [];
    for(const n2 in RF.state.dex){ let inTank = false;
      for(let k = 0; k < S.tank.length; k++) if(S.tank[k].n === n2) inTank = true;
      if(!inTank) names.push(n2); }
    names.sort((a,b) => (RF.state.dex[b].best || 0) - (RF.state.dex[a].best || 0));
    h += '<div class="seclab">on the record</div>';
    if(!names.length) h += '<div class="lard-empty">the whole dex is already swimming in there, or you have not caught anything yet.</div>';
    for(let k = 0; k < names.length && k < 14; k++){ const n2 = names[k], d = RF.state.dex[n2];
      h += row('', `<span style="color:${RF.RAR[RARBY[n2]] || '#b9c6c4'}">${n2}</span>`,
        `caught ${d.n} · best ${d.best} kg`, '', btn('tankadd', n2, 'MOUNT', '', S.tank.length >= 6)); }
    return h; }

  function rBoard(){
    let h = '<div class="lard-hint">whoever keeps this board is not signing their name to any of it.</div>';
    const rs = rumours();
    for(let k = 0; k < rs.length; k++) h += `<div class="lard-lore"><span class="no">${rs[k][0]}</span><span>${rs[k][1]}</span></div>`;
    h += '<div class="seclab">the gull</div>';
    if(S.gull) h += row('on', 'Barnacle', 'circles you, screams about anything worth walking to, and now and then drops something he did not earn', '');
    else { const opts = ['prawn','f1'].filter(x => have(x) >= 2);
      h += row('', 'a gull, waiting', 'he has been watching the rack for an hour. two of anything and he is yours.',
        '2× Prawn or 2× Trim',
        opts.length ? opts.map(x => btn('feed', x, 'FEED ' + GOODS[x].n.toUpperCase())).join(' ')
                    : btn('feed', 'prawn', 'FEED', '', true)); }
    return h; }

  function rLedger(){
    const got = Object.keys(S.lore).length;
    let h = `<div class="lard-hint">bottles wash up on the tideline. <b>${got}/${LORE.length}</b> read. none of it is useful.</div>`;
    for(let k = 0; k < LORE.length; k++)
      h += `<div class="lard-lore${S.lore[k] ? '' : ' locked'}"><span class="no">${String(k+1).padStart(2,'0')}</span>`
        + `<span>${S.lore[k] ? LORE[k] : '— — — — — — — — — — — — — —'}</span></div>`;
    return h; }

  const RENDER = {fire:rFire, rack:rRack, pots:rPots, bench:rBench, tank:rTank, board:rBoard, ledger:rLedger};

  /* Rumours are read off the live world, never invented: every line here points
     at something the player can go and act on this minute. */
  function rumours(){
    const out = [], m = fn.mktMods(), w = RF.weather;
    out.push([pix('chart',13), `the market is paying over the odds for <b style="color:var(--gold)">${fn.catLabel(m.hot)}</b> and is sick of the sight of <b>${fn.catLabel(m.cold)}</b>.`]);
    out.push([pix(w === 'storm' ? 'storm' : w === 'rain' ? 'rain' : fn.isNight() ? 'moon' : 'sun', 13),
      w === 'storm' ? 'a storm is on. the quarry loosens up and the big weather fish are awake. go out anyway.'
      : w === 'rain' ? 'rain. the fish bite quicker in it, and the rainrunners are only here while it lasts.'
      : fn.isNight() ? 'dark. the night species are up, and nobody else is.'
      : 'flat and bright. a good day to walk the shore and let the pots do the fishing.']);
    out.push([pix('moon',13), `moon: <b>${MOON[Math.floor(RF.dayCount) % 8]}</b>. it changes nothing. people still plan around it.`]);
    out.push(['◉', festOn()
      ? `<b style="color:var(--gold)">LANTERN TIDE</b> · lit for another ${clockTxt(festLeft())}. the shore regrows three times over and the stew is on.`
      : `lantern tide in <b>${clockTxt(festLeft())}</b>. the lamps along the sand go up for nine minutes.`]);
    let ready = 0; for(let k = 0; k < WS.pots.length; k++) if(now() - WS.pots[k].at >= POT_SOAK) ready++;
    if(WS.pots.length) out.push([pix('boat',13), ready
      ? `<b style="color:var(--gold)">${ready}</b> of your ${WS.pots.length} pots are worth pulling.`
      : `${WS.pots.length} pot${WS.pots.length>1?'s':''} still soaking. leave them.`]);
    let live = 0; for(let k = 0; k < nodes.length; k++) if(nodes[k].live) live++;
    out.push([pix('island',13), `<b>${live}</b> of ${nodes.length} beds on the tideline have grown back. press <b>G</b> at one.`]);
    let cured = 0; for(let k = 0; k < 3; k++){ const s = S.rack[k]; if(s && CURES[s.in] && now() >= s.at + CURES[s.in].ms) cured++; }
    if(cured) out.push([pix('fish',13), `<b style="color:var(--gold)">${cured}</b> line${cured>1?'s':''} on the rack finished curing. it will not improve further.`]);
    // point at a real gap in the dex, with the condition that actually opens it
    const wf = RF.WORLD.fish || RF.TABLE, miss = [];
    for(let k = 0; k < wf.length; k++) if(!RF.state.dex[wf[k][0].name]) miss.push(wf[k]);
    if(miss.length){ const e = miss[Math.floor(now() / (5*MIN)) % miss.length];
      out.push([pix('fish',13), `nobody here has landed a <b style="color:${RF.RAR[e[0].rar]}">${e[0].name}</b> yet`
        + (e[2] === 'night' ? '. it only comes up after dark.' : e[2] === 'rain' ? '. it wants rain.'
          : e[2] === 'storm' ? '. it wants a storm, which is asking a lot.' : '. no excuse — it is always down there.')]); }
    const unread = LORE.length - Object.keys(S.lore).length;
    if(unread > 0) out.push([pix('map',13), `${unread} bottle${unread>1?'s':''} still out there with something in them.`]);
    if(RF.online) out.push([pix('crew',13), 'signed in. the server keeps the coins; the camp keeps the larder.']);
    return out; }

  function renderPanel(){ if(!panelOn) return;
    subEl.innerHTML = (festOn() ? '<span style="color:var(--gold)">LANTERN TIDE</span> · ' : '') + RF.WORLD.name;
    const chips = [];
    for(let k = 0; k < GOOD_ORDER.length; k++){ const g = GOOD_ORDER[k], n = have(g);
      if(n > 0) chips.push(`<span class="lard-good" title="${GOODS[g].d}">${goodPip(g)}${GOODS[g].n} <b>${n}</b></span>`); }
    stripEl.innerHTML = chips.length ? chips.join('')
      : '<span class="lard-good" style="color:var(--faint)">the larder is bare · press <b>G</b> on the tideline</span>';
    const bs = tabsEl.children;
    for(let k = 0; k < bs.length; k++) bs[k].classList.toggle('sel', bs[k].getAttribute('data-v') === curTab);
    bodyEl.innerHTML = (RENDER[curTab] || rFire)(); }

  ov.addEventListener('click', e => {
    const b = (e.target && e.target.closest) ? e.target.closest('[data-act]') : null;
    if(!b) return;
    const a = b.getAttribute('data-act'), v = b.getAttribute('data-v') || '';
    try{
      if(a === 'close'){ closePanel(); return; }
      if(a === 'tab'){ curTab = v; RF.sfx.tab(); renderPanel(); return; }
      if(a === 'cook'){ for(let i=0;i<DISHES.length;i++) if(DISHES[i].id===v) cook(DISHES[i]); return; }
      if(a === 'rackput'){ const p = v.split(':'); rackPut(+p[0], p[1]); return; }
      if(a === 'racktake'){ rackTake(+v); return; }
      if(a === 'weave'){
        if(!canPay(POT_REQ)){ RF.sfx.deny(); say('the bench is short: ' + reqTxt(POT_REQ), 'bad'); return; }
        pay(POT_REQ); give('pot', 1); RF.sfx.craft();
        say(`${goodPipT('pot')} a pot, woven. now go and sink it.`, 'good');
        persist(); renderPanel(); return; }
      if(a === 'haul'){ haulPot(+v); return; }
      if(a === 'tie'){ const l = lureById(v); if(l) tieLure(l); return; }
      if(a === 'equip'){ const l = lureById(v); if(l) equipLure(l); return; }
      if(a === 'unequip'){ if(S.lureId && S.lureUses > 0) S.lures[S.lureId] = (S.lures[S.lureId]|0) + 1;
        S.lureId = ''; S.lureUses = 0; recalc(); syncBench(); paintHud(); RF.sfx.click(); persist(); renderPanel(); return; }
      if(a === 'tankadd'){ tankAdd(v); return; }
      if(a === 'tankdrop'){ tankDrop(+v); return; }
      if(a === 'feed'){ feedGull(v); return; }
    }catch(err){ RF.warn('06-content:ui:'+a, err); }
  });

  /* ==================================================================
     THE HUD STRIP — only ever on when it has something to say.
     ================================================================== */
  function paintHud(){ if(!hudEl) return;
    const rows = [], t = now();
    if(festOn()) rows.push(`<div class="lard-chip fest"><span>LANTERN TIDE</span><b>${clockTxt(festLeft())}</b></div>`);
    for(let k = 0; k < S.buffs.length; k++){ const b = S.buffs[k];
      rows.push(`<div class="lard-chip"><span>${b.n}</span><b>${clockTxt(b.until - t)}</b></div>`); }
    const L = liveLure();
    if(L) rows.push(`<div class="lard-chip"><span>${L.n}</span><b>${S.lureUses}</b></div>`);
    let ready = 0; for(let k = 0; k < WS.pots.length; k++) if(t - WS.pots[k].at >= POT_SOAK) ready++;
    if(ready) rows.push(`<div class="lard-chip warn"><span>pot${ready>1?'s':''} up</span><b>${ready}</b></div>`);
    let cured = 0; for(let k = 0; k < 3; k++){ const s = S.rack[k]; if(s && CURES[s.in] && t >= s.at + CURES[s.in].ms) cured++; }
    if(cured) rows.push(`<div class="lard-chip warn"><span>rack cured</span><b>${cured}</b></div>`);
    hudEl.innerHTML = rows.join('');
    hudEl.classList.toggle('on', rows.length > 0 && RF.running && !panelOn); }

  /* ==================================================================
     WHAT G IS POINTING AT — recomputed on the interact hook (once a frame,
     and only while the hero is idle) and again on the keypress, so a stale
     target can never be acted on.
     ================================================================== */
  function freeWaterCell(){
    const px = RF.pWorld.x, pz = RF.pWorld.z;
    const ci = clamp(Math.round(px + HALF), 1, N-2), cj = clamp(Math.round(pz + HALF), 1, N-2);
    let best = null, bd = 1e9;
    for(let a = -4; a <= 4; a++) for(let b = -4; b <= 4; b++){
      const i = ci + a, j = cj + b;
      if(i < 1 || j < 1 || i >= N-1 || j >= N-1 || HM[i][j] > 2) continue;
      // shallow only: it has to touch land, or you are dropping it off a shelf into the deep
      if(HM[i-1][j] < 3 && HM[i+1][j] < 3 && HM[i][j-1] < 3 && HM[i][j+1] < 3) continue;
      let taken = false;
      for(let k = 0; k < WS.pots.length; k++) if(WS.pots[k].i === i && WS.pots[k].j === j){ taken = true; break; }
      if(taken) continue;
      const d = Math.hypot(px - (i - HALF), pz - (j - HALF));
      if(d >= 0.8 && d <= 3.4 && d < bd){ bd = d; best = [i, j]; } }
    return best; }

  function findGather(){
    const px = RF.pWorld.x, pz = RF.pWorld.z;
    let best = null, bd = 1e9;
    for(let k = 0; k < nodes.length; k++){ const n = nodes[k]; if(!n.live) continue;
      const d = Math.hypot(px - n.x, pz - n.z); if(d < 2.0 && d < bd){ bd = d; best = {t:'node', n:n}; } }
    for(let k = 0; k < WS.bottles.length; k++){ const b = WS.bottles[k];
      const d = Math.hypot(px - (b.i - HALF), pz - (b.j - HALF)); if(d < 2.2 && d < bd){ bd = d; best = {t:'bottle', i:k}; } }
    for(let k = 0; k < WS.pots.length; k++){ const p = WS.pots[k];
      const d = Math.hypot(px - (p.i - HALF), pz - (p.j - HALF)); if(d < 3.3 && d < bd){ bd = d; best = {t:'pot', i:k}; } }
    if(!best && have('pot') > 0 && WS.pots.length < POT_MAX){ const c = freeWaterCell(); if(c) best = {t:'set', c:c}; }
    return best; }

  function gatherPrompt(g){
    if(g.t === 'node') return `${pix('bucket',13)} <span class="key">G</span> gather <b>${GOODS[g.n.k].n}</b>`;
    if(g.t === 'bottle') return `${pix('map',13)} <span class="key">G</span> <b style="color:var(--gold)">a bottle in the weed</b>`;
    if(g.t === 'set') return `${pix('boat',13)} <span class="key">G</span> sink a crab pot here`;
    const p = WS.pots[g.i]; if(!p) return '';
    const soak = now() - p.at;
    return soak >= POT_SOAK ? `${pix('boat',13)} <span class="key">G</span> <b style="color:var(--gold)">haul the pot</b>`
      : `${pix('boat',13)} the pot is soaking · <b>${clockTxt(POT_SOAK - soak)}</b>`; }

  function doGather(){
    const g = findGather(); if(!g){ RF.sfx.deny(); return; }
    fn.initAudio();
    if(g.t === 'node') gatherNode(g.n);
    else if(g.t === 'bottle') readBottle(g.i);
    else if(g.t === 'set') setPot(g.c);
    else haulPot(g.i); }

  let gHint = '';
  RF.on('interact', () => {
    if(!RF.running) return false;
    if(panelOn){ gHint = ''; fn.hint(''); return true; }
    const g = findGather();
    gHint = g ? gatherPrompt(g) : '';
    let st = null, bd = 2.3;
    for(let k = 0; k < stations.length; k++){ const s = stations[k];
      const d = Math.hypot(RF.pWorld.x - s.x, RF.pWorld.z - s.z); if(d < bd){ bd = d; st = s; } }
    if(!st) return false;
    const extra = gHint; gHint = '';                            // it is already in the line below
    fn.hint(`${st.icon} <span class="key">E</span> ${st.label}` + (extra ? ' · ' + extra : ''));
    if(RF.actEdge){ fn.initAudio(); openPanel(st.tab); }
    return true; });

  /* Ride along on the core hint instead of claiming it: standing on the
     tideline you still get "E Cast your line", with the gather prompt after it. */
  RF.modify('hint', h => {
    if(!gHint || panelOn || RF.panelOpen || !RF.running) return h;
    if(RF.fishing.state !== 'idle' || RF.mining.node || RF.chopping.tree || RF.digging.active) return h;
    return h ? h + ' · ' + gHint : gHint; });

  const MOVEK = {KeyW:1,KeyA:1,KeyS:1,KeyD:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1};
  RF.on('keydown', e => {
    if(RF.chatOpen) return false;
    const tag = e.target && e.target.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return false;
    if(panelOn){
      if(e.code === 'Escape' || e.code === 'KeyL'){ closePanel(); return true; }
      // the world must not move behind an open card
      if(MOVEK[e.code] || e.code === 'KeyE' || e.code === 'Space' || e.code === 'KeyF'
         || e.code === 'KeyI' || e.code === 'Tab' || e.code === 'KeyC' || e.code === 'KeyT'
         || e.code === 'KeyG' || e.code === 'KeyP'){ e.preventDefault(); return true; }
      return false; }
    if(!RF.running || RF.panelOpen) return false;
    if(e.code === 'KeyL'){ e.preventDefault(); fn.initAudio(); openPanel(curTab); return true; }
    if(e.code === 'KeyG'){ e.preventDefault(); doGather(); return true; }
    return false; });

  /* ==================================================================
     THE CUT — every landed fish leaves something behind on the board.
     Mod-owned, so it reads the same signed in or off.
     ================================================================== */
  RF.on('catch', (f) => {
    if(!f) return;
    const r = f.rar || 'common';
    const k = r === 'legendary' ? 'f3' : (r === 'rare' || r === 'epic') ? 'f2' : 'f1';
    const p = k === 'f3' ? 1 : k === 'f2' ? 0.85 : 0.55;
    if(Math.random() < p){ const n2 = f.shiny ? 2 : 1; give(k, n2);
      if(k === 'f3') say(`${goodPipT(k)} a <b>Legend Cut</b> for the camp`, 'gold');
      else if(k === 'f2') say(`${goodPipT(k)} +${n2} Prime Cut`, 'good'); }
    if(S.lureId && S.lureUses > 0){ S.lureUses--;
      if(S.lureUses <= 0){ const L = lureById(S.lureId);
        say(`${pix('rod',13)} the ${L ? L.n : 'lure'} finally gave out`, 'bad');
        S.lureId = ''; recalc(); syncBench(); } }
    persist(); paintHud(); });

  /* ==================================================================
     THE SLOW CLOCK — regrowth, bottles, the gull, the tide.
     ================================================================== */
  const tideCells = [];
  for(let i = 2; i < N-2; i++) for(let j = 2; j < N-2; j++){
    if(HM[i][j] !== 3 || wdist[i*N+j] > 1) continue;
    const k = keyOf(i,j);
    if(RF.usedCells.has(k) || RF.pathSet.has(k) || RF.decorUsed.has(k)) continue;
    if(fn.reachable(i,j)) tideCells.push([i,j]); }

  let festWas = festOn();
  RF.every(4, () => {
    syncNodes(); syncPots(); syncRack();
    const fest = festOn();
    if(fest !== festWas){ festWas = fest;
      if(RF.running){
        if(fest){ say(`${pix('sun',13)} <b>LANTERN TIDE</b> · the lamps are up along the sand for nine minutes`, 'gold');
          RF.sfx.win(); fn.addShake(0.1); }
        else say('the lanterns go out. the tide turns back.'); }
      paintHud(); if(panelOn) renderPanel(); }
    // bottles wash in on their own clock; two on the sand at once is plenty
    if(RF.running && tideCells.length && WS.bottles.length < BOTTLE_MAX && now() > WS.bnext){
      const unread = [];
      for(let k = 0; k < LORE.length; k++) if(!S.lore[k]) unread.push(k);
      const id = unread.length ? unread[(Math.random()*unread.length)|0] : (Math.random()*LORE.length)|0;
      for(let tries = 0; tries < 12; tries++){
        const c = tideCells[(Math.random()*tideCells.length)|0];
        let clash = false;
        for(let k = 0; k < WS.bottles.length; k++) if(WS.bottles[k].i === c[0] && WS.bottles[k].j === c[1]) clash = true;
        for(let k = 0; k < nodes.length && !clash; k++) if(nodes[k].live && nodes[k].i === c[0] && nodes[k].j === c[1]) clash = true;
        if(clash) continue;
        WS.bottles.push({i:c[0], j:c[1], id:id});
        WS.bnext = now() + (festOn() ? 70000 : 200000) * (0.8 + Math.random()*0.5);
        syncBottles(); persist(); break; } } });

  RF.every(38, () => {
    if(!S.gull || !RF.running) return;
    // Barnacle's job: point at the nearest thing actually worth walking to
    const px = RF.pWorld.x, pz = RF.pWorld.z;
    let bx = 0, bz = 0, by = 0, bd = 1e9, what = '';
    for(let k = 0; k < nodes.length; k++){ const n = nodes[k]; if(!n.live) continue;
      const d = Math.hypot(px - n.x, pz - n.z);
      if(d > 4 && d < bd){ bd = d; bx = n.x; bz = n.z; by = HM[n.i][n.j]; what = GOODS[n.k].n.toLowerCase(); } }
    for(let k = 0; k < WS.bottles.length; k++){ const b = WS.bottles[k];
      const d = Math.hypot(px - (b.i-HALF), pz - (b.j-HALF)) * 0.4;   // he rates a bottle over a bed
      if(d < bd){ bd = d; bx = b.i-HALF; bz = b.j-HALF; by = HM[b.i][b.j]; what = 'a bottle'; } }
    for(let k = 0; k < WS.pots.length; k++){ const p = WS.pots[k]; if(now() - p.at < POT_SOAK) continue;
      const d = Math.hypot(px - (p.i-HALF), pz - (p.j-HALF)) * 0.3;
      if(d < bd){ bd = d; bx = p.i-HALF; bz = p.j-HALF; by = RF.WATER_TOP; what = 'a full pot'; } }
    if(!what) return;
    marker.position.set(bx, by + 2.2, bz); marker.visible = true; markerT = 14;
    RF.sfx.sparkle(); say(`${pix('crew',13)} Barnacle screams about <b>${what}</b> and will not stop`, 'good'); });

  RF.every(163, () => {
    if(!S.gull || !RF.running) return;
    const pool = ['kelp','clam','drift','samphire','prawn'], g = pool[(Math.random()*pool.length)|0];
    give(g, 1); persist(); paintHud(); if(panelOn) renderPanel();
    say(`${goodPipT(g)} Barnacle drops a ${GOODS[g].n.toLowerCase()} at your feet. no explanation.`, 'good'); });

  RF.every(1, () => { recalc(); paintHud(); });

  /* ==================================================================
     THE FRAME — hoisted temporaries only; nothing in here allocates.
     ================================================================== */
  let lastFestCol = null, gullA = 0;
  const FIRE_WARM = {c:0xffb347, e:0xff6a1a}, FIRE_TIDE = {c:0x9ad8ff, e:0x39d7c4};
  RF.on('frame', dt => {
    if(saveDue > 0){ saveDue -= dt; if(saveDue <= 0) persistNow(); }
    const t = RF.clock, fest = festOn();

    if(noteT > 0){ noteT -= dt; if(noteT <= 0) noteEl.classList.remove('on'); }
    if(markerT > 0){ markerT -= dt;
      if(markerT <= 0) marker.visible = false;
      else { marker.rotation.y = t * 1.4; marker.position.y += Math.sin(t * 2.6) * (RM ? 0 : 0.004); } }

    if(fest !== lastFestCol){ lastFestCol = fest;
      const C = fest ? FIRE_TIDE : FIRE_WARM;
      for(let k = 0; k < flames.length; k++){ flames[k].material.color.setHex(C.c); flames[k].material.emissive.setHex(C.e); }
      emberMat.color.setHex(C.c); emberMat.emissive.setHex(C.e); }

    if(fireSt){
      const fl = 0.86 + Math.sin(t * 9.3) * 0.14 + Math.sin(t * 17.1) * 0.07;
      for(let k = 0; k < flames.length; k++){ const f = flames[k];
        f.material.emissiveIntensity = fl * (1.15 - k * 0.12);
        f.scale.y = (0.4 - k * 0.05) * (0.86 + fl * 0.2); }
      fireLight.intensity = (fn.isNight() ? 1.35 : 0.5) * fl * (fest ? 1.3 : 1);
      fireLight.color.setHex(fest ? 0x7fd8ff : 0xff9a3c);
      for(let k = 0; k < embers.length; k++){ const p = emberP[k], e = embers[k];
        p.t -= dt;
        if(p.t <= 0){ p.t = 0.7 + Math.random() * 0.8; p.x = (Math.random()-0.5) * 0.42;
          p.z = (Math.random()-0.5) * 0.42; p.y = 0.45; p.vy = 0.7 + Math.random() * 0.5; e.visible = true; }
        p.y += p.vy * dt; p.vy -= dt * 0.15;
        e.position.set(p.x + Math.sin(t * 2.4 + k) * 0.06, p.y, p.z + Math.cos(t * 1.9 + k) * 0.06);
        e.scale.setScalar(0.075 * Math.max(0.12, Math.min(1, p.t / 1.1))); } }

    for(let k = 0; k < lanternLamps.length; k++)
      lanternLamps[k].lamp.material.emissiveIntensity = fest ? 0.55 + Math.sin(t * 2.6 + k * 1.3) * 0.22 : 0;

    for(let k = 0; k < tankFish.length; k++){ const f = tankFish[k], a = t * f.sp + f.ph;
      f.g.position.set(Math.cos(a) * 0.62, f.y + (RM ? 0 : Math.sin(a * 2.1) * 0.06), Math.sin(a) * f.rz);
      f.g.rotation.y = -a - Math.PI/2; }

    for(let k = 0; k < buoys.length; k++){ const B = buoys[k]; if(!B.g.visible) continue;
      B.g.position.y = RF.WATER_TOP - 0.1 + (RM ? 0 : Math.sin(t * 1.8 + k) * 0.06);
      B.g.rotation.z = RM ? 0 : Math.sin(t * 1.3 + k) * 0.09; }

    if(S.gull){
      const want = !!RF.running;
      if(gull.visible !== want) gull.visible = want;
      if(want){ gullA += dt * 0.85;
        gull.position.set(RF.pWorld.x + Math.cos(gullA) * 2.5,
          RF.pWorld.y + 3.1 + (RM ? 0 : Math.sin(gullA * 2.3) * 0.22),
          RF.pWorld.z + Math.sin(gullA) * 2.5);
        gull.rotation.y = -gullA - Math.PI/2;
        const flap = RM ? 0.14 : Math.sin(t * 7) * 0.5;
        gull.userData.wL.rotation.x = flap; gull.userData.wR.rotation.x = -flap;
        gull.userData.lamp.material.emissiveIntensity = fest ? 0.8 : 0; } } });

  /* ================================ BOOT ================================ */
  uiReady = true; recalc(); paintHud();

  RF.on('start', () => {
    paintHud();
    if(!anchor){ RF.warn('06-content', new Error('no clear ground for the camp on ' + WK)); return; }
    if(!S.told){ S.told = 1; persist();
      setTimeout(() => { if(!RF.running) return;
        say(`${pix('island',13)} a shore camp stands on the isle · <span class="key">L</span> opens it, <span class="key">G</span> works the tideline`, 'gold'); }, 4200); } });
});
