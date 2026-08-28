/* 04-world — light, air, water and wildlife: the isle stops being a diorama.
   1.  Sun shafts — god rays rake across the island, widest and reddest at dawn and dusk.
   2.  A real dusk — full-frame colour grade, a vignette that breathes, fog that opens and closes.
   3.  Ground mist — banks crawl off the sea at first light and hang around after rain.
   4.  Living shoreline — foam washes in and out of every beach cell, downwind.
   5.  Ripples — expanding rings from the bobber, raindrops, jumping fish and diving gulls.
   6.  Jumpers — fish arc out of the sea offshore, and more of them when the weather turns.
   7.  Gulls — a flock circles the isle all day and mobs you the moment you land a fish.
   8.  Motes — butterflies by day, fireflies by night, ash on the volcano, glitter on the ice.
   9.  Crabs — voxel crabs scuttle the sand sideways and bolt when you walk up on them.
   10. Stall smoke — a thread off the trader's stovepipe that leans harder the higher it climbs.
   11. Wind — one gusting vector; it bends the grass in travelling waves and drags the rest along.
   12. Storm strikes — forked lightning that lights the whole world, and thunder that arrives late.
   Night lays over all of it: lantern halos, a moon path on the water, bioluminescent surf.
   Every part scales through RF.world.setQuality(), and drops a tier itself if frames sag. */
RF.mod('04-world', function (RF) {

const T = RF.THREE, scene = RF.scene, cam = RF.camera, P = RF.pWorld, fn = RF.fn;
const clamp = fn.clamp, lerp = fn.lerp, TAU = RF.TAU;
const N = RF.N, HALF = RF.HALF, WT = RF.WATER_TOP, HM = RF.heightMap;
const CAVE = !!RF.WORLD.cave, WK = RF.worldKey, isNight = fn.isNight;
const reduce = (function(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } })();

/* Placement rolls come off the world seed, not Math.random: the gulls roost in
   the same corner and the surf breaks on the same rocks every time you open the
   game. Live rolls — a gust, a strike, a jumper — still use Math.random. */
const rr = fn.mulberry32(((((RF.WORLD.seed|0) * 2654435761) | 0) ^ 0x5f3a) | 0);
const rnd = (a,b)=>a+rr()*(b-a);
const rz  = (a,b)=>a+Math.random()*(b-a);

/* ---------------------------------------------------------------------------
   TEXTURES — all procedural, drawn once. These are soft alpha ramps, so they
   want linear filtering rather than the block-crisp Nearest the terrain uses.
   --------------------------------------------------------------------------- */
const tx = c => fn.toTex(c, {nearest:false});
function radial(size, stops){ const c=fn.px(size), g=c.getContext('2d'), h=size/2;
  const gr=g.createRadialGradient(h,h,0,h,h,h);
  for(let k=0;k<stops.length;k++) gr.addColorStop(stops[k][0], stops[k][1]);
  g.fillStyle=gr; g.fillRect(0,0,size,size); return tx(c); }

const TEX_PUFF = radial(64, [[0,'rgba(255,255,255,.92)'],[.42,'rgba(255,255,255,.40)'],[1,'rgba(255,255,255,0)']]);
const TEX_GLOW = radial(64, [[0,'rgba(255,255,255,1)'],[.18,'rgba(255,255,255,.62)'],[.55,'rgba(255,255,255,.14)'],[1,'rgba(255,255,255,0)']]);
const TEX_RING = (function(){ const c=fn.px(64), g=c.getContext('2d');
  // a ring, never a disc: bright at r=25, gone by the edge, so it can only read as a wavefront
  for(let r=1;r<32;r++){ const a=Math.max(0,1-Math.abs(r-25)/7.5);
    g.strokeStyle='rgba(255,255,255,'+(a*a*0.85).toFixed(3)+')'; g.lineWidth=1.6;
    g.beginPath(); g.arc(32,32,r,0,TAU); g.stroke(); }
  return tx(c); })();
const TEX_FOAM = (function(){ const c=fn.px(64), g=c.getContext('2d');
  for(let k=0;k<80;k++){ const x=rnd(2,62), y=rnd(2,62), r=rnd(2,9);
    const gr=g.createRadialGradient(x,y,0,x,y,r);
    gr.addColorStop(0,'rgba(255,255,255,.55)'); gr.addColorStop(1,'rgba(255,255,255,0)');
    g.fillStyle=gr; g.beginPath(); g.arc(x,y,r,0,TAU); g.fill(); }
  return tx(c); })();
const TEX_SHAFT = (function(){ const c=fn.px(64), g=c.getContext('2d');
  const img=g.createImageData(64,64), d=img.data;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const u=(x+0.5)/64, v=(y+0.5)/64;
    const ex=Math.pow(Math.sin(u*Math.PI),1.7);              // soft across the beam's width
    const ey=Math.pow(Math.sin(v*Math.PI),0.5)*(1-v*0.4);    // fades at both ends, brightest sunward
    const o=(y*64+x)*4; d[o]=d[o+1]=d[o+2]=255; d[o+3]=clamp(ex*ey,0,1)*255; }
  g.putImageData(img,0,0); return tx(c); })();

const flatGeo = new T.PlaneGeometry(1,1).rotateX(-Math.PI/2);   // lies on water or ground
const billGeo = new T.PlaneGeometry(1,1);                       // turned to face the camera
const cubeGeo = new T.BoxGeometry(1,1,1);
function addMat(tex, col, op){ return new T.MeshBasicMaterial({map:tex, color:col===undefined?0xffffff:col,
  transparent:true, opacity:op===undefined?1:op, blending:T.AdditiveBlending, depthWrite:false}); }
function softMat(tex, col, op){ return new T.MeshBasicMaterial({map:tex, color:col, transparent:true,
  opacity:op, depthWrite:false}); }
function inst(geo, mat, n, order){ const m=new T.InstancedMesh(geo, mat, n);
  m.frustumCulled=false; m.castShadow=false; m.receiveShadow=false;
  m.renderOrder=order||4; scene.add(m); return m; }

/* ---------------------------------------------------------------------------
   THE MAP, READ ONCE — where the sea meets the land, where the beaches are, and
   where the open water is far enough out that a fish clearing it reads as scale.
   --------------------------------------------------------------------------- */
const shore=[], beach=[], offshore=[];
for(let i=1;i<N-1;i++)for(let j=1;j<N-1;j++){
  const h=HM[i][j];
  if(h<=2){
    if(HM[i+1][j]>=3||HM[i-1][j]>=3||HM[i][j+1]>=3||HM[i][j-1]>=3) shore.push(i-HALF, j-HALF);
    else if(h<=1){ const d=Math.hypot(i-HALF,j-HALF); if(d>14&&d<44) offshore.push(i-HALF, j-HALF); }
  } else if(h===3){
    if(HM[i+1][j]<=2||HM[i-1][j]<=2||HM[i][j+1]<=2||HM[i][j-1]<=2) beach.push(i-HALF, j-HALF);
  }
}

/* ---------------------------------------------------------------------------
   QUALITY — one dial the comfort mod can turn, and a watchdog that turns it
   itself when the machine starts choking. Counts come off first, never features.
   --------------------------------------------------------------------------- */
const CAP = { high:{ray:14,mist:30,mote:150,foam:380,moon:44,smoke:30},
              med: {ray:8, mist:16,mote:80, foam:220,moon:28,smoke:20},
              low: {ray:0, mist:0, mote:0,  foam:120,moon:0, smoke:12} };
let Q = RF.store.get('04-world-q', 'high'); if(!CAP[Q]) Q='high';
const flags = {rays:1,grade:1,mist:1,foam:1,ripples:1,jumpers:1,gulls:1,motes:1,
               crabs:1,smoke:1,grassWind:1,lightning:1,night:1};

/* --- 1. SUN SHAFTS: one instanced quad per beam, all sharing the orientation
   the sun actually has right now. depthTest stays on, so a beam dies where it
   meets the ground instead of painting over the island. -------------------- */
const RAY_N = 14;
const rayMesh = inst(billGeo, addMat(TEX_SHAFT, 0xffffff, 0.55), RAY_N, 3);
const rays=[]; for(let k=0;k<RAY_N;k++) rays.push({off:rnd(-22,22), sp:rnd(0.35,0.95),
  w:rnd(1.1,3.4), depth:rnd(-9,9), ph:rnd(0,TAU), fl:rnd(0.13,0.31)});

/* --- 3. GROUND MIST: camera-facing banks just above the waterline, creeping
   downwind and wrapping around the player so a bank never blinks in. ------- */
const MIST_N = 30;
const mistMesh = inst(billGeo, softMat(TEX_PUFF, 0xdfeef4, 0), MIST_N, 3);
const mist=[]; for(let k=0;k<MIST_N;k++) mist.push({x:rnd(-40,40), z:rnd(-40,40), y:rnd(-0.2,1.4),
  w:rnd(9,21), h:rnd(4.5,9), ph:rnd(0,TAU), sp:rnd(0.5,1.3)});

/* --- 4. FOAM: one quad per shoreline cell, driven by a wave phase that travels
   with the wind, so the whole beach breaks in one direction. --------------- */
const FOAM_N = Math.min(380, shore.length>>1);
const foamMesh = FOAM_N ? inst(flatGeo, addMat(TEX_FOAM, 0xffffff, 0.55), FOAM_N, 5) : null;
const foam=[];
if(FOAM_N){ const stride=Math.max(1,Math.floor((shore.length>>1)/FOAM_N));
  for(let k=0, c=0; c<FOAM_N && k<shore.length; k+=stride*2, c++)
    foam.push({x:shore[k], z:shore[k+1], s:rnd(1.5,2.4), ph:rnd(0,TAU)}); }

/* --- 5. RIPPLES + RAIN IMPACTS: two small pools. Everything in this file that
   touches water goes through ripple(), so it all reads as the same sea. ---- */
const RIP_N = 30;
const ripMesh = inst(flatGeo, addMat(TEX_RING, 0xffffff, 0.9), RIP_N, 6);
const rips=[]; for(let k=0;k<RIP_N;k++) rips.push({life:0,ttl:1,x:0,y:-99,z:0,r0:0.6,r1:3,str:1,r:0.6,g:0.9,b:1});
let ripCur=0;
function ripple(x,z,size,str,col){ const p=rips[ripCur]; ripCur=(ripCur+1)%RIP_N;
  const s=size||1, c=col===undefined?0xbfeaff:col;
  p.x=x; p.z=z; p.y=WT+0.06; p.life=p.ttl=0.55+s*0.32;
  p.r0=s*0.5; p.r1=s*3.4; p.str=str===undefined?1:str;
  p.r=(c>>16&255)/255; p.g=(c>>8&255)/255; p.b=(c&255)/255; }

const IMP_N = 64;
const impMesh = inst(flatGeo, addMat(TEX_PUFF, 0xcfe9f5, 0.55), IMP_N, 6);
const imps=[]; for(let k=0;k<IMP_N;k++) imps.push({life:0,ttl:1,x:0,y:-99,z:0,s:0.3});
let impCur=0, impAcc=0;
function impSpawn(x,y,z,s,ttl){ const p=imps[impCur]; impCur=(impCur+1)%IMP_N;
  p.x=x; p.y=y; p.z=z; p.s=s; p.life=p.ttl=ttl||0.34; }

/* --- 6. JUMPERS: two instanced boxes cover all four fish — a body and a tail
   that whips as the arc peaks. ---------------------------------------------- */
const JUMP_N = 4;
const jumpCol = WK==='frost'?0xa9e6f4 : WK==='volcano'?0xff9a5c : WK==='mine'?0xa8c0c8 : 0x7fd6e8;
const jMat = new T.MeshLambertMaterial({color:jumpCol, emissive:jumpCol, emissiveIntensity:0.18});
const jBody = inst(new T.BoxGeometry(0.42,0.2,0.14), jMat, JUMP_N, 2);
const jTail = inst(new T.BoxGeometry(0.16,0.24,0.05).translate(-0.26,0,0), jMat, JUMP_N, 2);
const jumps=[]; for(let k=0;k<JUMP_N;k++) jumps.push({on:false,t:0,dur:1,x:0,z:0,dx:1,dz:0,d:0,h:1,rl:0});
let jumpT = rz(2,7);

/* --- 7. GULLS: four instanced parts, so a whole flock costs four draw calls.
   They wander a wide circle until you land something, then they come look. -- */
const GULL_N = 7;
const gullWhite = new T.MeshLambertMaterial({color: WK==='volcano'?0xb9b2ad:0xf6fbfd});
const gullGold  = new T.MeshLambertMaterial({color:0xffcf5c});
const gBody = inst(new T.BoxGeometry(0.52,0.16,0.18), gullWhite, GULL_N, 2);
const gBeak = inst(new T.BoxGeometry(0.18,0.08,0.08).translate(0.31,0,0), gullGold, GULL_N, 2);
const gWingL= inst(new T.BoxGeometry(0.2,0.045,0.46).translate(0,0,0.23), gullWhite, GULL_N, 2);
const gWingR= inst(new T.BoxGeometry(0.2,0.045,0.46).translate(0,0,-0.23), gullWhite, GULL_N, 2);
const gulls=[]; for(let k=0;k<GULL_N;k++) gulls.push({a:rnd(0,TAU), r:rnd(11,26), h:rnd(9,15),
  sp:rnd(0.16,0.30)*(rr()<0.5?-1:1), flap:rnd(5,8), ph:rnd(0,TAU), cx:rnd(-16,16), cz:rnd(-16,16),
  tx:rnd(-22,22), tz:rnd(-22,22), mob:0, dive:0, s:rnd(0.85,1.15)});
let gullCry = 0;

/* --- 8. MOTES: one field, five faces. The isle picks the face from the clock
   and the world, and crossfades out and back so the handover never pops. ---- */
const MOTE_N = 150;
const moteMesh = inst(cubeGeo, new T.MeshBasicMaterial({transparent:true, opacity:0.95, depthWrite:false}), MOTE_N, 4);
const motes=[]; for(let k=0;k<MOTE_N;k++) motes.push({x:0,y:-99,z:0,base:0,ph:rnd(0,TAU),
  sp:rnd(0.5,1.6), hue:rr(), s:rnd(0.6,1.25), dead:true});
let moteMode='', moteNext='', moteFade=0;
const BFLY = [0xffcf5c,0xff9ad0,0xfff4c8,0xffb066,0xd7f0a0,0x9fdcff];

/* --- 9. CRABS: three instanced parts, walking the beach sideways. ---------- */
const CRAB_N = beach.length ? 8 : 0;
const crabCol = WK==='frost'?0xd6e8ee : WK==='volcano'?0x4a3a36 : WK==='mine'?0xa8746a : 0xe0583c;
const crabMat = new T.MeshLambertMaterial({color:crabCol});
const cBody = CRAB_N ? inst(new T.BoxGeometry(0.34,0.15,0.26), crabMat, CRAB_N, 2) : null;
const cClawL= CRAB_N ? inst(new T.BoxGeometry(0.14,0.1,0.1).translate(0.2,0,0.15), crabMat, CRAB_N, 2) : null;
const cClawR= CRAB_N ? inst(new T.BoxGeometry(0.14,0.1,0.1).translate(0.2,0,-0.15), crabMat, CRAB_N, 2) : null;
const crabs=[];
function beachPt(near, minD){ // a beach cell, optionally one that isn't right on top of `near`
  if(!beach.length) return null;
  for(let k=0;k<12;k++){ const i=((rr()*(beach.length>>1))|0)*2;
    if(!near || Math.hypot(beach[i]-near[0], beach[i+1]-near[1])>(minD||0)) return [beach[i],beach[i+1]]; }
  return [beach[0],beach[1]]; }
for(let k=0;k<CRAB_N;k++){ const p=beachPt();
  crabs.push({x:p[0], z:p[1], tx:p[0], tz:p[1], wait:rnd(0,3), sp:rnd(0.5,0.9),
    face:rnd(0,TAU), bob:rnd(0,TAU), rush:0}); }

/* --- 10. SMOKE: a stovepipe on the trader's roof and, on Cinder Atoll, a
   second lazy column off the summit. Both lean harder the higher they get. -- */
const SMOKE_N = 30;
const smokeMesh = inst(billGeo, addMat(TEX_PUFF, 0xffffff, 0.42), SMOKE_N, 3);
const smoke=[]; const vents=[];
if(RF.TRADER_POS){ const tp=RF.TRADER_POS;
  vents.push({x:tp.x+1.15, y:tp.y+3.35, z:tp.z-1.25, rate:0.62, col:0xd8dee0, rise:1.05, grow:1.5});
  const pipe=new T.Mesh(new T.BoxGeometry(0.22,1.0,0.22), new T.MeshLambertMaterial({color:0x36302c}));
  pipe.position.set(tp.x+1.15, tp.y+3.0, tp.z-1.25); pipe.castShadow=true; scene.add(pipe);
  const cap=new T.Mesh(new T.BoxGeometry(0.34,0.12,0.34), new T.MeshLambertMaterial({color:0x4a423c}));
  cap.position.set(tp.x+1.15, tp.y+3.56, tp.z-1.25); scene.add(cap); }
if(WK==='volcano'){ // the summit is the highest cell there is — the crater sits on it
  let bi=1,bj=1,bh=-1;
  for(let i=1;i<N-1;i++)for(let j=1;j<N-1;j++) if(HM[i][j]>bh){bh=HM[i][j];bi=i;bj=j;}
  vents.push({x:bi-HALF, y:bh+1.2, z:bj-HALF, rate:0.5, col:0x8f7a70, rise:1.5, grow:3.2}); }
for(let k=0;k<SMOKE_N;k++) smoke.push({life:0,ttl:1,x:0,y:-99,z:0,v:null,ph:rnd(0,TAU)});
let smokeCur=0, smokeAcc=0;

/* --- NIGHT: a halo on every lamp the engine built, a glitter path out under
   the moon, and surf that goes bioluminescent once the sun is down. --------- */
const lampPts=[]; { const v=new T.Vector3(), L=RF.lamps||[];
  for(let k=0;k<L.length && lampPts.length<64;k++){
    try{ L[k].getWorldPosition(v); lampPts.push({x:v.x,y:v.y,z:v.z,ph:rnd(0,TAU),s:rnd(1.5,2.6)}); }catch(e){} } }
const lampMesh = lampPts.length ? inst(billGeo, addMat(TEX_GLOW, 0xffffff, 0.85), lampPts.length, 3) : null;
const MOON_N = 44;
const moonMesh = inst(flatGeo, addMat(TEX_GLOW, 0xffffff, 0.9), MOON_N, 5);
const moonPts=[]; for(let k=0;k<MOON_N;k++) moonPts.push({t:rnd(0.04,1), lat:rnd(-1,1), ph:rnd(0,TAU), s:rnd(0.5,1.5)});

/* --- 2. THE GRADE: four fixed layers between the canvas and the HUD. Colours
   are lerped in JS and written at 8Hz — nothing animates in CSS, so a slow
   machine pays nothing for the look. --------------------------------------- */
RF.css(`
#w-grade,#w-vig,#w-flash,#w-bolt{position:fixed;inset:0;pointer-events:none;}
#w-grade,#w-vig{z-index:3;}
#w-flash{z-index:4;background:#e8f4ff;opacity:0;}
#w-bolt{z-index:4;width:100%;height:100%;opacity:0;}
@media (prefers-reduced-motion: reduce){ #w-bolt{display:none;} }
`, '04-world-css');
const gradeEl = RF.el('<div id="w-grade"></div>');
const vigEl   = RF.el('<div id="w-vig"></div>');
const flashEl = RF.el('<div id="w-flash"></div>');
const boltEl  = RF.el('<canvas id="w-bolt" width="640" height="360"></canvas>');
const boltX   = boltEl && boltEl.getContext ? boltEl.getContext('2d') : null;

/* --- 11. WIND: the one vector everything else asks. Two slow sines beating
   against each other wander without repeating; gusts spike on top and decay. */
const wind = {a:0, x:1, z:0, s:0.3, gust:0};
let gustSfx = 0;

/* Grass: the engine writes every tuft matrix from its own sway, and this hook
   runs after it — so we re-write them with that sway PLUS a lean that travels
   downwind as a wave. Base positions get read on the first frame, because at
   mod-load time the engine hasn't written a matrix yet and they're all identity. */
let tuftMesh=null, tuftPos=null, tuftPh=null, tuftScale=null;
for(let k=0;k<scene.children.length;k++){ const o=scene.children[k];
  if(o && o.isInstancedMesh && o.material && o.material.map===RF.TEX.blade){ tuftMesh=o; break; } }

/* --- 12. STORM STRIKES: the flash is real light — sun, hemisphere, ambient and
   fog, added after the engine's sky pass has written them, so it lands on this
   frame and is gone by the next. The bolt is a canvas jag; the thunder is late. */
let strikeT = rz(6,16), flash=0, boltT=0;
function drawBolt(near){
  if(!boltX || reduce) return;
  const W=640, H=360; boltX.clearRect(0,0,W,H);
  let x = rz(W*0.12, W*0.88), y = 0;
  const endY = H*(near?0.62:0.44), seg = near?12:9, pts=[[x,y]];
  for(let k=1;k<=seg;k++){ y = endY*k/seg; x += rz(-38,38); pts.push([x,y]); }
  const stroke=(w,a)=>{ boltX.strokeStyle='rgba(226,242,255,'+a+')'; boltX.lineWidth=w;
    boltX.lineJoin='round'; boltX.beginPath(); boltX.moveTo(pts[0][0],pts[0][1]);
    for(let k=1;k<pts.length;k++) boltX.lineTo(pts[k][0],pts[k][1]); boltX.stroke(); };
  boltX.shadowColor='rgba(150,205,255,.9)'; boltX.shadowBlur=near?26:14;
  stroke(near?7:4, 0.35); boltX.shadowBlur=0; stroke(near?2.4:1.4, 0.95);
  // one or two forks peeling off partway down — a single unbranched line reads as a scratch
  for(let f=0; f<(near?2:1); f++){ const i=2+((Math.random()*(seg-3))|0);
    let fx=pts[i][0], fy=pts[i][1];
    boltX.strokeStyle='rgba(214,236,255,.7)'; boltX.lineWidth=near?1.6:1;
    boltX.beginPath(); boltX.moveTo(fx,fy);
    for(let k=0;k<4;k++){ fx+=rz(-34,34); fy+=rz(16,34); boltX.lineTo(fx,fy); } boltX.stroke(); }
  boltT = near?0.13:0.09;
}
function strike(force){
  const near = force===true || Math.random()<0.34;
  flash = Math.max(flash, near?1:0.5);
  drawBolt(near);
  if(RF.running){ const delay = (near ? rz(60,340) : rz(900,3400))|0;
    setTimeout(()=>{ try{ (near?RF.sfx.thunder:RF.sfx.rumble)(); }catch(e){} }, delay);
    if(near) fn.addShake(0.22); }
}

/* ---------------------------------------------------------------------------
   REACTIONS
   --------------------------------------------------------------------------- */
let lastFishState = 'idle', wetness = 0, mistAmt = 0;
RF.on('catch', function(f){
  const b = RF.bobber;
  if(b && b.visible) ripple(b.position.x, b.position.z, 1.8, 1.3, 0xd9f6ff);
  if(!flags.gulls || CAVE || isNight()) return;
  // three of them peel off to see what you pulled out; the rarer it was, the longer they stay
  const rare = !!f && (f.rar==='epic'||f.rar==='legendary');
  let sent=0;
  for(let k=0;k<gulls.length && sent<3;k++){ const g=gulls[k];
    if(g.mob>0) continue;
    g.mob = rare?16:10; g.dive = sent===0 ? 2.4 : 0; sent++; }
  gullCry = 0.4;
});
RF.on('mined', function(e){ // dust hangs where the pick landed
  if(!flags.ripples) return;
  const n = e && e.node; if(!n || n.x===undefined) return;
  impSpawn(n.x, n.y+0.65, n.z, 0.55, 0.4);
});
RF.on('weather', function(w, prev){
  if(w==='storm') strikeT = rz(2.5,7);
  if(prev==='rain'||prev==='storm') wetness = 1;   // wet ground steams for a good while after
});

/* ---------------------------------------------------------------------------
   PER-FRAME STATE — every temporary hoisted; the hook allocates nothing.
   --------------------------------------------------------------------------- */
const d1=new T.Object3D(), d2=new T.Object3D(), mA=new T.Matrix4(), mB=new T.Matrix4();
d1.rotation.order='YXZ'; d2.rotation.order='YXZ';
const vUp=new T.Vector3(), vFwd=new T.Vector3(), vRight=new T.Vector3(), vTmp=new T.Vector3();
const basis=new T.Matrix4(), qRay=new T.Quaternion(), cQ=new T.Quaternion();
const cTmp=new T.Color(), cHaze=new T.Color(0xffa464), cInst=new T.Color(), cWater=new T.Color(RF.WORLD.water);
const AMB0 = RF.ambL ? RF.ambL.intensity : 0.16;
let gradeAcc = 1, fogNear = scene.fog?scene.fog.near:150, fogFar = scene.fog?scene.fog.far:255;
let colorTick = 0, qAcc = 0, qFrames = 0, qSum = 0, qBad = 0, qDropped = 0, upSec = 0;

function sunState(){ // the same arc the engine's sky pass walks, so the beams agree with the disc
  const dayFrac=(RF.dayT-0.12)/0.64;
  if(dayFrac<0||dayFrac>1) return null;
  const a=dayFrac*Math.PI;
  return {x:-Math.cos(a), y:Math.sin(a), frac:dayFrac};
}
function moonFull(){ const ph=(Math.floor(RF.dayCount)%8)/8; return Math.abs(Math.cos(ph*TAU)); }
function weatherDim(){ const w=RF.weather;
  return w==='storm'?0.1 : w==='rain'?0.26 : w==='snow'?0.5 : w==='ash'?0.55 : 1; }

/* =========================================================================
   THE FRAME — runs after the engine's sky, water and grass passes, so anything
   written here is the last word before the renderer sees the scene.
   ========================================================================= */
RF.on('frame', function(dtRaw, rdt){
  const dt = dtRaw>0.05?0.05:dtRaw, t = RF.clock;
  const W = RF.weather, night = isNight(), wet = W==='rain'||W==='storm';
  const cap = CAP[Q];

  /* --- wind -------------------------------------------------------------- */
  wind.a = Math.sin(t*0.037)*1.7 + Math.sin(t*0.0113+2.1)*1.1;
  wind.gust *= Math.exp(-dt*0.85);
  const gustOdds = (W==='storm'?0.55:W==='rain'?0.22:0.13) * (reduce?0.35:1);
  if(Math.random() < dt*gustOdds) wind.gust += rz(0.2,0.85)*(reduce?0.4:1);
  wind.s = (W==='storm'?0.95:W==='rain'?0.6:W==='snow'?0.42:CAVE?0.08:0.3) + wind.gust;
  wind.x = Math.cos(wind.a); wind.z = Math.sin(wind.a);
  gustSfx -= dt;
  if(wind.gust>0.72 && gustSfx<=0 && RF.running && !CAVE){ gustSfx = rz(22,50); try{ RF.sfx.gust(); }catch(e){} }

  /* --- wetness: rain soaks the ground, then it steams off over a minute --- */
  wetness = wet ? Math.min(1, wetness + dt*0.16) : Math.max(0, wetness - dt*0.011);

  /* --- lightning: stacked on top of whatever the sky pass just wrote ------ */
  if(flags.lightning && W==='storm' && RF.running && !CAVE){
    strikeT -= dt;
    if(strikeT<=0){ strikeT = rz(5,17); strike(); } }
  if(flash>0.001){
    flash *= Math.exp(-dt*11);
    RF.sun.intensity += flash*2.4;
    RF.hemiL.intensity += flash*1.3;
    if(RF.ambL) RF.ambL.intensity = AMB0 + flash*0.5;
    if(scene.fog) scene.fog.color.lerp(cTmp.setRGB(0.88,0.94,1), flash*0.5);
    if(flashEl) flashEl.style.opacity = (flash*(reduce?0.08:0.42)).toFixed(3);
  } else if(flash!==0){ flash=0;
    if(RF.ambL) RF.ambL.intensity = AMB0;
    if(flashEl) flashEl.style.opacity='0'; }
  if(boltT>0){ boltT-=dt;
    if(boltT<=0){ if(boltEl) boltEl.style.opacity='0'; if(boltX) boltX.clearRect(0,0,640,360); }
    else if(boltEl && boltEl.style.opacity!=='1') boltEl.style.opacity='1'; }

  /* --- fog that breathes: a storm closes the horizon, noon opens it ------- */
  if(scene.fog){
    const tgtN = CAVE?92 : W==='storm'?100 : wet?118 : night?126 : W==='snow'?112 : 178;
    const tgtF = CAVE?185 : W==='storm'?186 : wet?214 : night?226 : 300;
    const kf = 1-Math.exp(-dt*0.55);
    fogNear = lerp(fogNear, tgtN, kf); fogFar = lerp(fogFar, tgtF, kf);
    scene.fog.near = fogNear; scene.fog.far = fogFar;
    // let the far sea bleed into the haze, so the horizon reads as water and not as a wall
    if(!CAVE) scene.fog.color.lerp(cWater, 0.13); }

  cQ.copy(cam.quaternion);
  const sun = CAVE?null:sunState();
  colorTick = (colorTick+1)&1;   // half-rate colour uploads: invisible, and it halves the bus traffic

  /* --- 1. sun shafts ----------------------------------------------------- */
  { const n = (flags.rays && sun) ? Math.min(RAY_N, cap.ray) : 0;
    rayMesh.count = n; rayMesh.visible = n>0;
    if(n){
      const low = 1-Math.min(1, Math.abs(sun.y)*1.35);        // 0 at noon, 1 on the horizon
      const str = (0.085 + 0.34*low*low) * weatherDim() * (reduce?0.6:1);
      vUp.set(-sun.x*0.75, Math.max(0.16,sun.y), 0.42).normalize();   // points at the sun
      cam.getWorldDirection(vFwd); vFwd.negate();
      vRight.crossVectors(vUp, vFwd);
      if(vRight.lengthSq()>1e-6){
        vRight.normalize(); vFwd.crossVectors(vRight, vUp).normalize();
        basis.makeBasis(vRight, vUp, vFwd); qRay.setFromRotationMatrix(basis); }
      cTmp.setHex(0xfff4d8).lerp(cHaze, low*0.75);
      const cy = 6 + 10*vUp.y;
      for(let k=0;k<n;k++){ const r=rays[k];
        r.off += dt*r.sp*(1+wind.s*0.8);
        if(r.off>22) r.off -= 44;
        const flick = 0.55 + 0.45*Math.sin(t*0.31+r.ph)*Math.sin(t*0.13+r.ph*1.7);
        d1.position.set(P.x,0,P.z).addScaledVector(vRight, r.off).addScaledVector(vFwd, r.depth);
        d1.position.y = cy;
        d1.quaternion.copy(qRay); d1.scale.set(r.w, 44, 1);
        d1.updateMatrix(); rayMesh.setMatrixAt(k, d1.matrix);
        rayMesh.setColorAt(k, cInst.copy(cTmp).multiplyScalar(str*r.fl*Math.max(0,flick)*2.6)); }
      rayMesh.instanceMatrix.needsUpdate=true;
      if(rayMesh.instanceColor) rayMesh.instanceColor.needsUpdate=true; } }

  /* --- 3. ground mist ---------------------------------------------------- */
  { const n = flags.mist?Math.min(MIST_N, cap.mist):0;
    // dawn and dusk make it, rain leaves it behind, cold water keeps it after dark
    const dawn = sun ? Math.max(0,1-Math.abs(sun.frac-0.06)*9)+Math.max(0,1-Math.abs(sun.frac-0.94)*9) : 0;
    const tgt = clamp(dawn*0.5 + wetness*0.45 + (night?0.16:0) + (WK==='frost'?0.18:0) + (CAVE?0.3:0), 0, 0.62);
    mistAmt = lerp(mistAmt, tgt, 1-Math.exp(-dt*0.5));
    mistMesh.count = n;
    mistMesh.material.opacity = mistAmt*0.72;
    mistMesh.visible = n>0 && mistAmt>0.012;
    if(mistMesh.visible){
      for(let k=0;k<n;k++){ const m=mist[k];
        m.x += wind.x*wind.s*m.sp*dt*2.4; m.z += wind.z*wind.s*m.sp*dt*2.4;
        const dx=m.x-P.x, dz=m.z-P.z;                    // wrap, never respawn: a bank must not blink
        if(dx>44) m.x-=88; else if(dx<-44) m.x+=88;
        if(dz>44) m.z-=88; else if(dz<-44) m.z+=88;
        d1.position.set(m.x, WT+0.35+m.y+Math.sin(t*0.24+m.ph)*0.25, m.z);
        d1.quaternion.copy(cQ);
        d1.scale.set(m.w*(1+Math.sin(t*0.17+m.ph)*0.07), m.h, 1);
        d1.updateMatrix(); mistMesh.setMatrixAt(k, d1.matrix); }
      mistMesh.instanceMatrix.needsUpdate=true; } }

  /* --- 4. foam, and after dark the bioluminescence in it ------------------ */
  if(foamMesh){ const n = flags.foam?Math.min(foam.length, cap.foam):0;
    foamMesh.count = n; foamMesh.visible = n>0;
    if(n){
      const bio = (flags.night && night && !CAVE) ? 1 : 0;
      const swell = 0.55 + wind.s*0.5 + (W==='storm'?0.5:0);
      for(let k=0;k<n;k++){ const f=foam[k];
        // the break travels downwind across the beach instead of every cell pulsing at once
        const a = Math.max(0, Math.sin((f.x*wind.x+f.z*wind.z)*0.5 - t*1.35 + f.ph))*swell;
        d1.position.set(f.x, WT+0.055, f.z);
        d1.rotation.set(0, f.ph, 0);
        const s = f.s*(0.62+a*0.55);
        d1.scale.set(s, 1, s);
        d1.updateMatrix(); foamMesh.setMatrixAt(k, d1.matrix);
        if(!colorTick){ const b=a*0.9+0.06;
          if(bio) cInst.setRGB(b*0.28, b, b*0.94); else cInst.setRGB(b,b,b);
          foamMesh.setColorAt(k, cInst); } }
      foamMesh.instanceMatrix.needsUpdate=true;
      if(!colorTick && foamMesh.instanceColor) foamMesh.instanceColor.needsUpdate=true;
      if(bio && Math.random()<dt*1.6){ const f=foam[(Math.random()*n)|0];
        ripple(f.x, f.z, 0.7, 0.5, 0x39d7c4); } } }

  /* --- 5. ripples -------------------------------------------------------- */
  { let live=false;
    for(let k=0;k<RIP_N;k++){ const p=rips[k];
      if(p.life>0){ live=true; p.life-=dt;
        const u=1-Math.max(0,p.life)/p.ttl, s=lerp(p.r0, p.r1, u*u*0.6+u*0.4), b=(1-u)*(1-u)*p.str;
        d1.position.set(p.x,p.y,p.z); d1.rotation.set(0,0,0); d1.scale.set(s,1,s);
        cInst.setRGB(p.r*b, p.g*b, p.b*b);
      } else { d1.position.set(0,-99,0); d1.rotation.set(0,0,0); d1.scale.set(0.0001,0.0001,0.0001); cInst.setRGB(0,0,0); }
      d1.updateMatrix(); ripMesh.setMatrixAt(k, d1.matrix); ripMesh.setColorAt(k, cInst); }
    ripMesh.instanceMatrix.needsUpdate=true;
    if(ripMesh.instanceColor) ripMesh.instanceColor.needsUpdate=true;
    ripMesh.visible = live && !!flags.ripples; }

  /* --- 5b. rain that lands: splashes on the ground, rings on the water ---- */
  { if(flags.ripples && wet && !CAVE){
      impAcc += dt*(W==='storm'?52:28);
      while(impAcc>=1){ impAcc-=1;
        const a=Math.random()*TAU, r=Math.sqrt(Math.random())*15;
        const x=P.x+Math.cos(a)*r, z=P.z+Math.sin(a)*r;
        if(fn.isWaterAt(x,z)){ if(Math.random()<0.35) ripple(x,z,0.45,0.5); }
        else impSpawn(x, fn.heightAt(x,z)+0.06, z, rz(0.22,0.42), rz(0.22,0.4)); } }
    else impAcc = 0;
    let live=false;
    for(let k=0;k<IMP_N;k++){ const p=imps[k];
      if(p.life>0){ live=true; p.life-=dt;
        const u=1-p.life/p.ttl, s=p.s*(0.5+u*1.3);
        d1.position.set(p.x,p.y,p.z); d1.rotation.set(0,0,0); d1.scale.set(s,1,s);
      } else { d1.position.set(0,-99,0); d1.rotation.set(0,0,0); d1.scale.set(0.0001,0.0001,0.0001); }
      d1.updateMatrix(); impMesh.setMatrixAt(k, d1.matrix); }
    impMesh.instanceMatrix.needsUpdate=true; impMesh.visible=live; }

  /* --- the bobber's own splash, caught off the fishing state machine ------ */
  if(RF.fishing){ const st=RF.fishing.state, b=RF.bobber;
    if(lastFishState==='cast' && st==='wait' && b) ripple(b.position.x, b.position.z, 1.2, 1, 0xd9f6ff);
    if(st==='bite' && b && Math.random()<dt*6) ripple(b.position.x, b.position.z, 0.5, 0.6);
    lastFishState = st; }

  /* --- 6. jumpers -------------------------------------------------------- */
  if(flags.jumpers && offshore.length && !CAVE){
    jumpT -= dt;
    if(jumpT<=0){ jumpT = rz(3.5,10)/(W==='storm'?2.2:wet?1.5:1);
      for(let k=0;k<JUMP_N;k++){ const j=jumps[k];
        if(j.on) continue;
        for(let tryN=0; tryN<10; tryN++){ const i=((Math.random()*(offshore.length>>1))|0)*2;
          const x=offshore[i], z=offshore[i+1];
          if(Math.hypot(x-P.x, z-P.z)>34) continue;       // only ever start one you could see
          const a=Math.random()*TAU;
          j.on=true; j.t=0; j.dur=rz(0.75,1.15); j.x=x; j.z=z;
          j.dx=Math.cos(a); j.dz=Math.sin(a); j.d=rz(1.4,2.6); j.h=rz(0.9,1.7); j.rl=Math.random()*TAU;
          ripple(x,z,0.9,0.9);
          if(RF.running && Math.hypot(x-P.x,z-P.z)<18){ try{ RF.sfx.splash(0.035); }catch(e){} }
          break; }
        break; } } }
  { let any=false;
    for(let k=0;k<JUMP_N;k++){ const j=jumps[k];
      if(j.on){ any=true; j.t+=dt;
        const u=j.t/j.dur;
        if(u>=1){ j.on=false;
          const lx=j.x+j.dx*j.d, lz=j.z+j.dz*j.d;
          ripple(lx,lz,1.1,1);
          fn.fxBurst(lx, WT+0.15, lz, {n:5, cols:[0x7fdcff,0xffffff], speed:1.6, up:2.2, size:0.7, grav:8});
          d1.position.set(0,-99,0); d1.rotation.set(0,0,0); d1.scale.set(0.0001,0.0001,0.0001);
        } else {
          d1.position.set(j.x+j.dx*j.d*u, WT+Math.sin(u*Math.PI)*j.h, j.z+j.dz*j.d*u);
          d1.rotation.set(Math.sin(j.rl)*0.2, Math.atan2(-j.dz, j.dx), Math.cos(u*Math.PI)*1.05);
          d1.scale.set(1,1,1); }
      } else { d1.position.set(0,-99,0); d1.rotation.set(0,0,0); d1.scale.set(0.0001,0.0001,0.0001); }
      d1.updateMatrix(); jBody.setMatrixAt(k, d1.matrix);
      d2.position.set(0,0,0); d2.rotation.set(0, j.on?Math.sin(j.t*26)*0.7:0, 0); d2.scale.set(1,1,1);
      d2.updateMatrix(); mA.multiplyMatrices(d1.matrix, d2.matrix); jTail.setMatrixAt(k, mA); }
    jBody.instanceMatrix.needsUpdate=true; jTail.instanceMatrix.needsUpdate=true;
    jBody.visible=jTail.visible=any; }

  /* --- 7. gulls ---------------------------------------------------------- */
  { const show = !!flags.gulls && !CAVE && !night && Q!=='low';
    gBody.visible=gBeak.visible=gWingL.visible=gWingR.visible=show;
    if(show){
      gullCry -= dt;
      for(let k=0;k<GULL_N;k++){ const g=gulls[k];
        if(g.mob>0){ g.mob-=dt;                       // pulled in tight over whoever just landed one
          g.cx=lerp(g.cx,P.x,1-Math.exp(-dt*1.4)); g.cz=lerp(g.cz,P.z,1-Math.exp(-dt*1.4));
          g.r =lerp(g.r,4.2,1-Math.exp(-dt*1.2));  g.h =lerp(g.h,5.4,1-Math.exp(-dt*1.1));
          if(gullCry<=0 && RF.running){ gullCry=rz(1.1,2.6);
            try{ fn.beep(1150+Math.random()*400,0.06,'triangle',0.018);
                 setTimeout(()=>fn.beep(940,0.07,'triangle',0.014),90); }catch(e){} }
        } else {
          if(Math.hypot(g.cx-g.tx, g.cz-g.tz)<3){ g.tx=rnd(-26,26); g.tz=rnd(-26,26); }
          g.cx=lerp(g.cx,g.tx,1-Math.exp(-dt*0.12)); g.cz=lerp(g.cz,g.tz,1-Math.exp(-dt*0.12));
          g.r =lerp(g.r,17,1-Math.exp(-dt*0.3));     g.h =lerp(g.h,11.5,1-Math.exp(-dt*0.3)); }
        g.a += dt*g.sp*(g.mob>0?2.1:1);
        const x=g.cx+Math.cos(g.a)*g.r, z=g.cz+Math.sin(g.a)*g.r;
        let y=g.h+Math.sin(g.a*2+g.ph)*0.7;
        if(g.dive>0){ g.dive-=dt;                     // one bird drops, kisses the surface, climbs out
          const dip=Math.sin((1-clamp(g.dive/2.4,0,1))*Math.PI);
          y=lerp(y, WT+0.5, dip);
          if(dip>0.93 && Math.random()<dt*8) ripple(x,z,0.8,0.9); }
        const flap=Math.sin(t*g.flap+g.ph);
        d1.position.set(x,y,z);
        d1.rotation.set(flap*0.06, -g.a+(g.sp>0?-Math.PI/2:Math.PI/2), (g.sp>0?-0.34:0.34)+flap*0.05);
        d1.scale.setScalar(g.s); d1.updateMatrix();
        gBody.setMatrixAt(k, d1.matrix); gBeak.setMatrixAt(k, d1.matrix);
        const fa=0.28+flap*0.62;
        d2.position.set(0,0.02,0.05); d2.rotation.set(-fa,0,0); d2.scale.set(1,1,1); d2.updateMatrix();
        mA.multiplyMatrices(d1.matrix, d2.matrix); gWingL.setMatrixAt(k, mA);
        d2.position.set(0,0.02,-0.05); d2.rotation.set(fa,0,0); d2.updateMatrix();
        mB.multiplyMatrices(d1.matrix, d2.matrix); gWingR.setMatrixAt(k, mB); }
      gBody.instanceMatrix.needsUpdate=true; gBeak.instanceMatrix.needsUpdate=true;
      gWingL.instanceMatrix.needsUpdate=true; gWingR.instanceMatrix.needsUpdate=true; } }

  /* --- 8. motes ---------------------------------------------------------- */
  { const n = flags.motes?Math.min(MOTE_N, cap.mote):0;
    const want = CAVE?'spore' : WK==='volcano'?'ash' : night?'fly' : WK==='frost'?'glit' : 'bfly';
    if(moteMode===''){ moteMode=want; moteFade=0; }
    moteNext = want;
    if(moteMode!==moteNext){ moteFade -= dt*1.4;
      if(moteFade<=0){ moteMode=moteNext; moteFade=0;
        for(let k=0;k<MOTE_N;k++) motes[k].dead=true; } }
    else moteFade = Math.min(1, moteFade+dt*0.9);
    moteMesh.count = n;
    moteMesh.material.opacity = 0.95*moteFade;
    moteMesh.visible = n>0 && moteFade>0.02;
    if(moteMesh.visible){
      for(let k=0;k<n;k++){ const m=motes[k];
        if(m.dead || Math.abs(m.x-P.x)>34 || Math.abs(m.z-P.z)>34){
          const a=Math.random()*TAU, r=6+Math.sqrt(Math.random())*24;
          m.x=P.x+Math.cos(a)*r; m.z=P.z+Math.sin(a)*r;
          m.base=fn.heightAt(m.x,m.z); m.y=m.base+rz(0.3,2.4);
          m.ph=Math.random()*TAU; m.dead=false; }
        const s=m.s*0.09;
        if(moteMode==='bfly'){                     // butterflies loop, they don't drift
          m.x += Math.cos(t*m.sp+m.ph)*dt*1.6 + wind.x*wind.s*dt*0.35;
          m.z += Math.sin(t*m.sp*1.3+m.ph)*dt*1.6 + wind.z*wind.s*dt*0.35;
          m.y = m.base+0.7+Math.sin(t*1.7+m.ph)*0.45;
          cInst.setHex(BFLY[(m.hue*BFLY.length)|0]);
          d1.scale.set(s*(1.4+Math.sin(t*13+m.ph)*0.9), s*0.35, s*1.5);
        } else if(moteMode==='fly'){               // a sharp blink: a firefly is off far more than on
          m.x += Math.cos(t*0.4+m.ph)*dt*0.7 + wind.x*wind.s*dt*0.4;
          m.z += Math.sin(t*0.35+m.ph*1.7)*dt*0.7 + wind.z*wind.s*dt*0.4;
          m.y = m.base+0.9+Math.sin(t*0.6+m.ph)*0.55;
          const bl=Math.pow(Math.max(0,Math.sin(t*1.5+m.ph*3)),8);
          cInst.setRGB(0.95,1,0.42); d1.scale.setScalar(s*(0.12+bl*1.1));
        } else if(moteMode==='ash'){
          m.y += dt*m.sp*0.9; m.x += wind.x*wind.s*dt*1.5; m.z += wind.z*wind.s*dt*1.5;
          if(m.y>m.base+9) m.dead=true;
          const f=clamp(1-(m.y-m.base)/9,0,1);
          cInst.setRGB(1,0.42,0.12); d1.scale.setScalar(s*(0.3+f*0.8));
        } else if(moteMode==='glit'){
          m.y -= dt*m.sp*0.35; m.x += wind.x*wind.s*dt*0.9; m.z += wind.z*wind.s*dt*0.9;
          if(m.y<m.base) m.dead=true;
          const tw=Math.pow(Math.max(0,Math.sin(t*3+m.ph*4)),3);
          cInst.setRGB(0.82,0.95,1); d1.scale.setScalar(s*(0.18+tw*0.7));
        } else {                                   // cave spores rise and hang
          m.y += dt*m.sp*0.25; m.x += Math.cos(t*0.2+m.ph)*dt*0.4; m.z += Math.sin(t*0.22+m.ph)*dt*0.4;
          if(m.y>m.base+6) m.dead=true;
          cInst.setRGB(0.22,0.9,0.85);
          d1.scale.setScalar(s*(0.5+0.5*Math.abs(Math.sin(t*0.9+m.ph)))); }
        d1.position.set(m.x,m.y,m.z); d1.rotation.set(0, m.ph+t*0.2, 0);
        d1.updateMatrix(); moteMesh.setMatrixAt(k, d1.matrix); moteMesh.setColorAt(k, cInst); }
      moteMesh.instanceMatrix.needsUpdate=true;
      if(moteMesh.instanceColor) moteMesh.instanceColor.needsUpdate=true; } }

  /* --- 9. crabs ---------------------------------------------------------- */
  if(cBody){ const show = !!flags.crabs && !CAVE;
    cBody.visible=cClawL.visible=cClawR.visible=show;
    if(show){
      for(let k=0;k<CRAB_N;k++){ const c=crabs[k];
        if(RF.running && Math.hypot(c.x-P.x, c.z-P.z)<3.4 && c.rush<=0){
          const bp=beachPt([P.x,P.z], 7); if(bp){ c.tx=bp[0]; c.tz=bp[1]; }
          c.wait=0; c.rush=1.2; }
        c.rush = Math.max(0, c.rush-dt);
        const dx=c.tx-c.x, dz=c.tz-c.z, d=Math.hypot(dx,dz);
        if(d<0.4){ if(c.wait>0) c.wait-=dt;
          else { const bp=beachPt([c.x,c.z],2); if(bp){ c.tx=bp[0]; c.tz=bp[1]; } c.wait=rz(0.6,3.4); } }
        else { const sp=c.sp*(c.rush>0?3.2:1)*dt;
          c.x += dx/d*sp; c.z += dz/d*sp;
          c.face = fn.lerpAngle(c.face, Math.atan2(dx,dz), 1-Math.exp(-dt*5));
          c.bob += dt*(c.rush>0?26:11); }
        // a crab walks sideways: the shell faces ninety degrees off the way it's going
        d1.position.set(c.x, fn.heightAt(c.x,c.z)+0.09+Math.abs(Math.sin(c.bob))*0.045, c.z);
        d1.rotation.set(0, c.face+Math.PI/2, Math.sin(c.bob)*0.09);
        d1.scale.setScalar(1); d1.updateMatrix();
        cBody.setMatrixAt(k, d1.matrix);
        d2.position.set(0,0.02,0); d2.scale.set(1,1,1);
        d2.rotation.set(0, Math.sin(c.bob*0.7)*0.35, 0); d2.updateMatrix();
        mA.multiplyMatrices(d1.matrix, d2.matrix); cClawL.setMatrixAt(k, mA);
        d2.rotation.set(0, -Math.sin(c.bob*0.7)*0.35, 0); d2.updateMatrix();
        mB.multiplyMatrices(d1.matrix, d2.matrix); cClawR.setMatrixAt(k, mB); }
      cBody.instanceMatrix.needsUpdate=true;
      cClawL.instanceMatrix.needsUpdate=true; cClawR.instanceMatrix.needsUpdate=true; } }

  /* --- 10. smoke --------------------------------------------------------- */
  if(vents.length){ const n = flags.smoke?Math.min(SMOKE_N, cap.smoke):0;
    smokeMesh.count = n; smokeMesh.visible = n>0;
    if(n){
      if(smokeCur>=n) smokeCur=0;
      smokeAcc += dt*(night?2.6:1.9);
      while(smokeAcc>=1){ smokeAcc-=1;
        const v=vents[(Math.random()*vents.length)|0];
        if(Math.random()>v.rate) continue;
        const p=smoke[smokeCur]; smokeCur=(smokeCur+1)%n;
        p.v=v; p.life=p.ttl=rz(3.2,5.4); p.ph=Math.random()*TAU;
        p.x=v.x+rz(-0.1,0.1); p.y=v.y; p.z=v.z+rz(-0.1,0.1); }
      for(let k=0;k<n;k++){ const p=smoke[k];
        if(p.life>0 && p.v){ p.life-=dt;
          const u=1-p.life/p.ttl;
          p.y += dt*p.v.rise*(0.6+u);
          p.x += wind.x*wind.s*dt*(0.7+u*3.4);        // the higher it gets, the harder the wind has it
          p.z += wind.z*wind.s*dt*(0.7+u*3.4);
          const s=0.55+u*p.v.grow;
          d1.position.set(p.x+Math.sin(u*4+p.ph)*0.16, p.y, p.z+Math.cos(u*3.4+p.ph)*0.16);
          d1.quaternion.copy(cQ); d1.scale.set(s,s,1);
          if(!colorTick) smokeMesh.setColorAt(k, cInst.setHex(p.v.col).multiplyScalar(Math.min(1,u*4)*(1-u)*(1-u)));
        } else { d1.position.set(0,-99,0); d1.quaternion.set(0,0,0,1); d1.scale.set(0.0001,0.0001,0.0001);
          if(!colorTick) smokeMesh.setColorAt(k, cInst.setRGB(0,0,0)); }
        d1.updateMatrix(); smokeMesh.setMatrixAt(k, d1.matrix); }
      smokeMesh.instanceMatrix.needsUpdate=true;
      if(!colorTick && smokeMesh.instanceColor) smokeMesh.instanceColor.needsUpdate=true; } }

  /* --- night: lantern halos ---------------------------------------------- */
  if(lampMesh){ lampMesh.visible = !!flags.night && Q!=='low' && (CAVE || night);
    if(lampMesh.visible){
      for(let k=0;k<lampPts.length;k++){ const L=lampPts[k], pulse=0.9+Math.sin(t*3+L.ph)*0.09;
        d1.position.set(L.x,L.y,L.z); d1.quaternion.copy(cQ);
        d1.scale.set(L.s*pulse, L.s*pulse, 1); d1.updateMatrix();
        lampMesh.setMatrixAt(k, d1.matrix);
        lampMesh.setColorAt(k, cInst.setRGB(0.62,0.45,0.17).multiplyScalar(pulse)); }
      lampMesh.instanceMatrix.needsUpdate=true;
      if(lampMesh.instanceColor) lampMesh.instanceColor.needsUpdate=true; } }

  /* --- night: the moon laid out on the water ----------------------------- */
  { const n = flags.night?Math.min(MOON_N, cap.moon):0;
    const moonLit = (!CAVE && night) ? moonFull()*weatherDim() : 0;
    moonMesh.count = n; moonMesh.visible = n>0 && moonLit>0.05;
    if(moonMesh.visible){
      // the moon walks the sun's arc half a day out of phase, so borrow that azimuth and flip it
      const ma=((RF.dayT-0.12)/0.64+0.5)*Math.PI;
      vTmp.set(-Math.cos(ma)*0.75, 0, 0.42).normalize();
      const px2=-vTmp.z, pz2=vTmp.x;
      for(let k=0;k<n;k++){ const m=moonPts[k], dist=4+m.t*52, spread=1.4+m.t*9;
        const x=P.x+vTmp.x*dist+px2*m.lat*spread, z=P.z+vTmp.z*dist+pz2*m.lat*spread;
        const over=fn.isWaterAt(x,z) ? 1 : 0;
        const s=m.s*(1.1+m.t*2.4)*(over?1:0.0001);
        d1.position.set(x, WT+0.05, z); d1.rotation.set(0,0,0); d1.scale.set(s,1,s*0.55);
        d1.updateMatrix(); moonMesh.setMatrixAt(k, d1.matrix);
        const b=over*moonLit*0.5*(0.3+0.7*Math.pow(Math.max(0,Math.sin(t*2.2+m.ph*5)),2));
        moonMesh.setColorAt(k, cInst.setRGB(b*0.78, b*0.86, b)); }
      moonMesh.instanceMatrix.needsUpdate=true;
      if(moonMesh.instanceColor) moonMesh.instanceColor.needsUpdate=true; } }

  /* --- 11. grass in the wind --------------------------------------------- */
  if(tuftMesh && flags.grassWind){
    if(!tuftPos){ const cnt=tuftMesh.count|0;
      if(cnt>0){ const pos=new Float32Array(cnt*3), phs=new Float32Array(cnt), scl=new Float32Array(cnt);
        let written=false;
        for(let k=0;k<cnt;k++){ tuftMesh.getMatrixAt(k, mA); const e=mA.elements;
          pos[k*3]=e[12]; pos[k*3+1]=e[13]; pos[k*3+2]=e[14];
          scl[k]=Math.hypot(e[0],e[1],e[2])||1;
          phs[k]=((e[12]*12.9898+e[14]*78.233)%TAU+TAU)%TAU;
          if(e[13]!==0) written=true; }
        // still identity means the engine's first animGrass hasn't landed — look again next frame
        if(written){ tuftPos=pos; tuftPh=phs; tuftScale=scl; }
      } else tuftMesh=null; }
    if(tuftPos){ const cnt=tuftMesh.count|0, lean=Math.min(0.62, wind.s*0.44);
      for(let k=0;k<cnt;k++){ const gx=tuftPos[k*3], gz=tuftPos[k*3+2], ph=tuftPh[k];
        // a gust wave travelling downwind: you watch the wind arrive before it reaches you
        const L=lean*(0.65+0.5*Math.sin((gx*wind.x+gz*wind.z)*0.34 - t*2.3));
        d1.position.set(gx, tuftPos[k*3+1], gz);
        d1.rotation.set(Math.cos(t*1.1+ph)*0.10 + wind.z*L, ph, Math.sin(t*1.6+ph)*0.18 - wind.x*L);
        d1.scale.setScalar(tuftScale[k]);
        d1.updateMatrix(); tuftMesh.setMatrixAt(k, d1.matrix); }
      tuftMesh.instanceMatrix.needsUpdate=true; } }

  /* --- 2. the grade, at 8Hz ---------------------------------------------- */
  gradeAcc += dt;
  if(flags.grade && gradeAcc>0.125){ gradeAcc=0;
    let r,g,b,a;
    if(CAVE){ r=8; g=14; b=26; a=0.34; }
    else { const dT=RF.dayT;
      // night → dawn → open day → dusk → night, keyed off the engine's own day curve
      const nightAmt = clamp(dT<0.12 ? 1-dT/0.12*0.7 : dT>0.76 ? (dT-0.76)/0.24*0.7+0.3 : 0, 0, 1);
      const goldAmt  = Math.max(0,1-Math.abs(dT-0.14)*11) + Math.max(0,1-Math.abs(dT-0.72)*11);
      r=26; g=40; b=84; a=nightAmt*0.30;
      if(goldAmt>0){ const kk=goldAmt/(goldAmt+a*3+0.001);
        r=lerp(r,255,kk); g=lerp(g,150,kk); b=lerp(b,86,kk); a=Math.max(a, goldAmt*0.19); }
      if(W==='rain'){ r=lerp(r,104,0.6); g=lerp(g,130,0.6); b=lerp(b,142,0.6); a=Math.max(a,0.16); }
      else if(W==='storm'){ r=lerp(r,58,0.7); g=lerp(g,74,0.7); b=lerp(b,90,0.7); a=Math.max(a,0.25); }
      else if(W==='snow'){ r=lerp(r,206,0.7); g=lerp(g,230,0.7); b=lerp(b,242,0.7); a=Math.max(a,0.13); }
      else if(W==='ash'){ r=lerp(r,132,0.7); g=lerp(g,76,0.7); b=lerp(b,52,0.7); a=Math.max(a,0.21); }
      a += mistAmt*0.10; }
    gradeEl.style.backgroundColor='rgba('+(r|0)+','+(g|0)+','+(b|0)+','+a.toFixed(3)+')';
    // the vignette closes in at night and in weather, and opens back up at noon
    const vg = clamp(0.18+(CAVE?0.4:0)+(night?0.24:0)+(W==='storm'?0.24:wet?0.12:0), 0, 0.72);
    vigEl.style.background='radial-gradient(120% 96% at 50% 44%,rgba(0,0,0,0) 52%,rgba(3,10,12,'+vg.toFixed(3)+') 100%)'; }

  /* --- quality watchdog: two bad windows in a row costs a tier, twice max -- */
  qFrames++; qSum += rdt||dt; qAcc += dt; upSec += dt;
  if(qAcc>2){ const avg=qSum/Math.max(1,qFrames); qAcc=0; qFrames=0; qSum=0;
    qBad = avg>0.0305 ? qBad+1 : 0;
    if(upSec>6 && qBad>=2 && qDropped<2){ qBad=0; qDropped++;
      setQuality(Q==='high'?'med':'low');
      if(RF.running) fn.toast('the haze thins out to keep the frames up'); } }
});

/* ---------------------------------------------------------------------------
   PUBLIC SURFACE — the comfort mod turns these; anyone can fire a ripple or a
   strike. Nothing here writes to RF.state, so it behaves the same online.
   --------------------------------------------------------------------------- */
function setQuality(q){ if(!CAP[q]) return false; Q=q; RF.store.set('04-world-q', q);
  if(q==='low'){ rayMesh.visible=false; mistMesh.visible=false; moteMesh.visible=false;
    if(lampMesh) lampMesh.visible=false; moonMesh.visible=false; }
  RF.emit('worldQuality', q); return true; }
RF.world = {
  wind: wind, flags: flags, ripple: ripple, strike: strike,
  get quality(){ return Q; },
  get wetness(){ return wetness; },
  get mist(){ return mistAmt; },
  setQuality: setQuality,
  set(k, v){ if(Object.prototype.hasOwnProperty.call(flags,k)){ flags[k]=v?1:0; return true; } return false; },
  toggles: ['rays','grade','mist','foam','ripples','jumpers','gulls','motes','crabs','smoke','grassWind','lightning','night']
};

});
