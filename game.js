/* ============================================================================
   REEL FORTUNE 3D — a voxel fishing, mining & gambling isle (Three.js r128, UMD)
   Textured Minecraft-style blocks · flowing water · swaying grass · ore mining.
   Pure client-side, no build step. Open index.html directly (file://) or serve.
   ============================================================================ */
(function () {
"use strict";
const THREE = window.THREE;
const errBox = document.getElementById('err');
function fail(msg){ if(errBox){ errBox.style.display='flex'; errBox.innerHTML=msg; } console.error(msg); }
if(!THREE){ fail("Three.js failed to load.<br>Make sure the folder still contains <b>lib/three.min.js</b>."); return; }

const lerp=(a,b,t)=>a+(b-a)*t, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), rand=(a,b)=>a+Math.random()*(b-a), TAU=Math.PI*2;
const lerpAngle=(a,b,t)=>{let d=(b-a)%TAU;if(d>Math.PI)d-=TAU;if(d<-Math.PI)d+=TAU;return a+d*t;};

/* ========================================================================
   0. MOD HOST — the extension surface every mods/*.js file builds on.
   Declared before anything else so hook sites further down can always fire
   into it; the reference table at the very bottom of this file fills in the
   engine handles once the world, the state and the UI all exist.
   ======================================================================== */
const RF = window.RF = {
  version: 1,
  ready: false,
  mods: Object.create(null),          // name -> {name, ok, error}
  order: [],
  hooks: Object.create(null),
  override: Object.create(null),      // named take-overs: return true to replace core behaviour
  _queue: [],
  _quiet: false,
  warn(where, e){ if(!RF._quiet) console.warn('[RF] "' + where + '" threw:', e); },
  /* ---- event bus ---- */
  on(evt, fn, prio){ const L = RF.hooks[evt] || (RF.hooks[evt] = []);
    fn._p = prio || 0; L.push(fn); L.sort((a,b)=>(a._p|0)-(b._p|0)); return fn; },
  off(evt, fn){ const L = RF.hooks[evt]; if(!L) return;
    const i = L.indexOf(fn); if(i >= 0) L.splice(i,1); },
  emit(evt, a, b, c, d){ const L = RF.hooks[evt]; if(!L) return;
    for(let i=0;i<L.length;i++){ try{ L[i](a,b,c,d); }catch(e){ RF.warn(evt,e); } } },
  /* like emit, but the first handler returning true claims the event */
  claim(evt, a, b, c, d){ const L = RF.hooks[evt]; if(!L) return false;
    for(let i=0;i<L.length;i++){ try{ if(L[i](a,b,c,d) === true) return true; }catch(e){ RF.warn(evt,e); } }
    return false; },
  /* ---- value pipelines: RF.modify('oreYield',fn) then core calls RF.pipe(...) ---- */
  modify(name, fn, prio){ return RF.on('~'+name, fn, prio); },
  pipe(name, v, ctx){ const L = RF.hooks['~'+name]; if(!L) return v;
    for(let i=0;i<L.length;i++){ try{ const r = L[i](v, ctx); if(r !== undefined && r === r) v = r; }catch(e){ RF.warn(name,e); } }
    return v; },
  /* ---- per-mod persistence, independent of the server-owned `state` ---- */
  store: {
    get(name, def){ try{ const r = localStorage.getItem('rf-mod-'+name);
        return r ? JSON.parse(r) : (def === undefined ? null : def); }
      catch(e){ return def === undefined ? null : def; } },
    set(name, val){ try{ localStorage.setItem('rf-mod-'+name, JSON.stringify(val)); }catch(e){} },
    del(name){ try{ localStorage.removeItem('rf-mod-'+name); }catch(e){} }
  },
  /* ---- DOM/CSS helpers so a mod ships its own look without touching index.html ---- */
  css(text, id){ const el = document.createElement('style');
    if(id){ const old = document.getElementById(id); if(old) old.remove(); el.id = id; }
    el.textContent = text; document.head.appendChild(el); return el; },
  el(html, parent){ const t = document.createElement('div'); t.innerHTML = String(html).trim();
    const n = t.firstElementChild; if(n && parent !== null) (parent || document.body).appendChild(n); return n; },
  /* ---- frame timers, driven by the 'frame' hook ---- */
  every(sec, fn){ let acc = 0; return RF.on('frame', dt => { acc += dt; if(acc >= sec){ acc = 0; fn(); } }); },
  /* ---- registration: every mods/*.js calls RF.mod('name', RF => {...}) once ---- */
  mod(name, fn){ if(!RF.ready){ RF._queue.push([name, fn]); return; } RF._run(name, fn); },
  _run(name, fn){ const rec = {name: name, ok: false, error: null};
    RF.mods[name] = rec; RF.order.push(name);
    try{ fn(RF); rec.ok = true; }
    catch(e){ rec.error = e; console.error('[RF] mod "' + name + '" failed to load:', e); } },
  _boot(){ RF.ready = true;
    const q = RF._queue.slice(); RF._queue.length = 0;
    for(const [n, f] of q) RF._run(n, f);
    RF.emit('ready'); }
};

/* ========================================================================
   1. RENDERER / SCENE / CAMERA / LIGHTS
   ======================================================================== */
let renderer;
try{ renderer=new THREE.WebGLRenderer({antialias:true}); }catch(e){ fail("WebGL could not start in this browser."); return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.getElementById('scene').appendChild(renderer.domElement);
const MAXANISO = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;

let SKY=0x6fd6f6;
const scene=new THREE.Scene();
scene.background=null;                 // the sky is its own render pass (see skyScene) so sun/moon/stars can live behind the world
scene.fog=new THREE.Fog(SKY,150,255);

/* --- CELESTIAL PASS ---------------------------------------------------------
   The world camera is orthographic and zoomed to ~10 units, so a real sky dome
   out at radius 170 would sit far outside its frustum and never be visible.
   Instead the sky is a separate scene drawn first, in normalised screen space:
   a vertical gradient quad, then a sun and moon that arc across it, then stars.
   -------------------------------------------------------------------------- */
const skyScene=new THREE.Scene();
const skyCam=new THREE.OrthographicCamera(-1,1,1,-1,0,10); skyCam.position.z=5;
const skyGeo=new THREE.PlaneGeometry(2,2);
skyGeo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(12),3)); // 4 verts: TL TR BL BR
const skyQuad=new THREE.Mesh(skyGeo,new THREE.MeshBasicMaterial({vertexColors:true,depthWrite:false,depthTest:false}));
skyQuad.renderOrder=-10; skyScene.add(skyQuad);
const STARN=110;
const starGeo=new THREE.BufferGeometry(); { const sp=new Float32Array(STARN*3);
  for(let k=0;k<STARN;k++){ sp[k*3]=rand(-1.9,1.9); sp[k*3+1]=rand(-0.35,1.0); sp[k*3+2]=0.1; }
  starGeo.setAttribute('position',new THREE.BufferAttribute(sp,3)); }
const starMat=new THREE.PointsMaterial({color:0xffffff,size:0.013,transparent:true,opacity:0,depthTest:false,sizeAttenuation:false});
const stars=new THREE.Points(starGeo,starMat); stars.renderOrder=-9; skyScene.add(stars);
function skyBody(size,col,op){ const m=new THREE.Mesh(new THREE.PlaneGeometry(size,size),
    new THREE.MeshBasicMaterial({color:col,transparent:op<1,opacity:op,depthTest:false,depthWrite:false}));
  m.renderOrder=-8; skyScene.add(m); return m; }
const sunGlow=skyBody(0.42,0xffd98a,0.22), sunDisc=skyBody(0.19,0xfff3c4,1);
const moonGlow=skyBody(0.30,0xbfd4ff,0.16), moonDisc=skyBody(0.135,0xf2f6ff,1);
const moonShade=skyBody(0.135,0x101c38,1); moonShade.renderOrder=-7; // slid across the moon to carve its phase
function fitSky(){ const a=window.innerWidth/window.innerHeight;
  skyCam.left=-a; skyCam.right=a; skyCam.updateProjectionMatrix();
  skyQuad.scale.set(a,1,1); }

let camSize=10.5;
const camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,600);
const CAM_OFF=new THREE.Vector3(48,58,48);
function fitCamera(){ const a=window.innerWidth/window.innerHeight;
  camera.left=-camSize*a;camera.right=camSize*a;camera.top=camSize;camera.bottom=-camSize;camera.updateProjectionMatrix(); fitSky(); }
fitCamera();
addEventListener('wheel',e=>{ if(typeof marketOpen!=='undefined'&&(marketOpen||casinoOpen||invOpen||harborOpen))return;
  if(typeof capCam!=='undefined'&&capCam)return;   // this listener is registered before the flags exist
  camSize=clamp(camSize+Math.sign(e.deltaY)*1.1,7,17); fitCamera(); },{passive:true});

const hemiL=new THREE.HemisphereLight(0xffffff,0x8fb060,0.62); scene.add(hemiL);
const ambL=new THREE.AmbientLight(0xd6ecf2,0.16); scene.add(ambL);
const sun=new THREE.DirectionalLight(0xffefcf,0.55);
sun.position.set(60,100,44); sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048); // 4096 cost ~4x GPU + 67MB VRAM for no visible gain at iso zoom
sun.shadow.camera.near=1; sun.shadow.camera.far=320;
sun.shadow.camera.left=-60; sun.shadow.camera.right=60; sun.shadow.camera.top=60; sun.shadow.camera.bottom=-60;
sun.shadow.bias=-0.0005;
scene.add(sun); scene.add(sun.target);

/* ========================================================================
   1b. WORLDS — themed islands unlocked at the Harbor (travel = regenerate)
   ======================================================================== */
const WORLDS={
  isle:{name:'Fortune Isle',sub:'world 1 · fishing haven',cost:0,seed:0,hMul:1,stoneH:6,fishMul:1,oreN:0,oreYield:1,
    sky:0x6fd6f6,water:0x2fc0e8,pink:0.16,treeMax:90,
    grass:['#4fc32f','#46b527',['#5bd83b','#3da521','#6ae94a','#43ae24']],
    leaf:['#3aa626',['#2f9420','#48bb31','#279016','#54cb3c']],
    sand:['#f2dc9b',['#e6cd87','#ffeeb4','#d9c07c']],
    stone:['#939ba3',['#848c94','#a1a9b1','#747c84']]},
  mine:{name:'The Great Mine',sub:'world 2 · ore ×2',cost:2500,seed:57,hMul:1.3,stoneH:5,fishMul:1.1,oreN:30,oreYield:2,
    sky:0x9fb8c8,water:0x3aa9c9,pink:0,treeMax:40,
    grass:['#7da85c','#719c50',['#8bb96a','#679247','#97c576','#5d8840']],
    leaf:['#5e8f46',['#527f3c','#6da052','#48702f','#7ab15f']],
    sand:['#cfc39b',['#c2b58a','#dbd0ab','#b3a67c']],
    stone:['#8a9098',['#7a8088','#989ea6','#6a7078']]},
  volcano:{name:'Cinder Atoll',sub:'world 3 · danger pays',cost:8000,seed:191,hMul:1.45,stoneH:5,fishMul:2.2,oreN:22,oreYield:1,
    sky:0xd97f4e,water:0x2a6f8e,pink:0,treeMax:26,
    grass:['#8a5a3f','#7d4f36',['#9a6848','#6d452e','#a87454','#5e3b26']],
    leaf:['#3d3a38',['#4a4644','#332f2d','#57524f']],
    sand:['#5e5450',['#524844','#6a605c','#463e3a']],
    stone:['#4e4a48',['#5a5654','#423e3c','#666260']]},
  frost:{name:'Frostbite Isle',sub:'world 4 · frozen riches',cost:15000,seed:311,hMul:1.2,stoneH:6,fishMul:4,oreN:26,oreYield:1,
    sky:0xbfe6f5,water:0x7fd4e8,pink:0,treeMax:60,
    grass:['#e8f2f5','#dcebf0',['#f5fbfd','#cfe2e8','#ffffff','#c2d8e0']],
    leaf:['#9fd0c8',['#8fc2ba','#b2ded6','#7fb3ab']],
    sand:['#d8e4e8',['#cbd9de','#e6eff2','#bccdd3']],
    stone:['#a8b4bc',['#98a4ac','#b6c2ca','#8a969e']]},
  cave:{name:'The Undermine',sub:'the mining cave',cost:750,seed:777,hMul:1.15,stoneH:5,fishMul:2,oreN:40,oreYield:1,cave:true,
    sky:0x0b0e14,water:0x1e6f7a,pink:0,treeMax:16,
    grass:['#3f5a4c','#37503f',['#4a685a','#2f4638','#557767','#283d30']],
    leaf:['#3fae9c',['#35998a','#4cc4b0','#2b8578','#5cd8c4']],
    sand:['#5a5248',['#4e463c','#665e54','#423a30']],
    stone:['#3c4148',['#464b52','#32373e','#50555c']]}};
const WORLD_ORDER=['isle','mine','volcano','frost'];
let worldKey='isle'; try{ const wk=localStorage.getItem('reelfortune3d-world'); if(wk&&WORLDS[wk])worldKey=wk; }catch(e){}
const WORLD=WORLDS[worldKey];
SKY=WORLD.sky; scene.fog.color.setHex(SKY);
{ const c0=new THREE.Color(SKY); paintSky(c0,c0); } // seed the gradient before the first skyUpdate

/* ------------------------------------------------------------------------
   DETERMINISTIC WORLDGEN — required for multiplayer.
   Everything the world is made of (textures, decor, ore-node positions) must be
   identical on every client, or two players standing in the same place would see
   different trees and mine ore the other cannot see. So for the construction
   phase only, Math.random is swapped for a seeded PRNG derived from the world's
   seed; it is restored before any gameplay rolls happen.
   ------------------------------------------------------------------------ */
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }
const REAL_RANDOM=Math.random;
Math.random=mulberry32((WORLD.seed*7919+1013)|0);   // ← restored after section 6

/* ========================================================================
   2. PROCEDURAL PIXEL TEXTURES (Minecraft-style, generated on <canvas>)
   ======================================================================== */
function px(size){ const c=document.createElement('canvas'); c.width=c.height=size; return c; }
function toTex(c,{repeat=false,nearest=true}={}){ const t=new THREE.CanvasTexture(c);
  if(nearest){t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestMipmapNearestFilter;}
  t.anisotropy=MAXANISO; if(repeat){t.wrapS=t.wrapT=THREE.RepeatWrapping;} return t; }
function noiseFill(g,size,base,shades){ g.fillStyle=base; g.fillRect(0,0,size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){ if(Math.random()<0.5){ g.fillStyle=shades[(Math.random()*shades.length)|0]; g.fillRect(x,y,1,1);} } }
const S=16;
function texDirt(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#8a5a34',['#7a4e2b','#9a683e','#6d4526']); return toTex(c); }
function texSand(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,WORLD.sand[0],WORLD.sand[1]); return toTex(c); }
function texSeabed(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,WORLD.sand[0],WORLD.sand[1]); return toTex(c); }
function texStone(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,WORLD.stone[0],WORLD.stone[1]);
  g.strokeStyle='rgba(55,60,66,.55)';g.beginPath();g.moveTo(2,5);g.lineTo(7,6);g.lineTo(9,11);g.stroke(); return toTex(c); }
function texGrassTop(){ const c=px(S),g=c.getContext('2d');
  // two-tone checker turf + speckles, colored per world theme
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){ g.fillStyle=((x>>3)+(y>>3))%2?WORLD.grass[0]:WORLD.grass[1]; g.fillRect(x,y,1,1); }
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){ if(Math.random()<0.45){ g.fillStyle=WORLD.grass[2][(Math.random()*WORLD.grass[2].length)|0]; g.fillRect(x,y,1,1);} }
  return toTex(c); }
function texGrassSide(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#8a5a34',['#7a4e2b','#9a683e']);
  for(let x=0;x<S;x++){ const drop=2+((Math.random()*3)|0); for(let y=0;y<drop;y++){ g.fillStyle=[WORLD.grass[0],WORLD.grass[1],WORLD.grass[2][0]][(Math.random()*3)|0]; g.fillRect(x,y,1,1);} }
  return toTex(c); }
function texPath(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#cba86f',['#bb975c','#dcbc85','#ab884f']);
  g.fillStyle='#9d7c47'; for(let k=0;k<4;k++)g.fillRect((Math.random()*14)|0,(Math.random()*14)|0,2,2); return toTex(c); }
function texBark(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#7a5028';g.fillRect(0,0,S,S);
  for(let x=0;x<S;x+=2){ g.fillStyle=Math.random()<0.5?'#66421f':'#8a5d30'; g.fillRect(x,0,1,S);} return toTex(c); }
function texWood(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#a8763f';g.fillRect(0,0,S,S);
  for(let y=0;y<S;y++){ g.fillStyle=y%4===0?'#8a5d30':(Math.random()<0.3?'#b8834a':'#9a6b38'); g.fillRect(0,y,S,1);} return toTex(c); }
function texLeaf(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,WORLD.leaf[0],WORLD.leaf[1]); return toTex(c); }
function texLeafPink(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#ec9fcb',['#e18abc','#f5b5d9','#d977ae','#f9c6e2']); return toTex(c); }
function texRoof(){ const c=px(32),g=c.getContext('2d');
  for(let y=0;y<4;y++)for(let x=0;x<4;x++){ g.fillStyle=(x+y)%2?'#f3efe4':'#d8352f'; g.fillRect(x*8,y*8,8,8); }
  g.fillStyle='rgba(0,0,0,.08)'; for(let k=0;k<40;k++)g.fillRect((Math.random()*31)|0,(Math.random()*31)|0,1,1);
  return toTex(c); }
function texWater(){ const c=px(64),g=c.getContext('2d'); g.fillStyle='#dff6ff';g.fillRect(0,0,64,64);
  g.strokeStyle='rgba(120,200,220,.6)';g.lineWidth=2;
  for(let k=0;k<10;k++){ g.beginPath(); const y=Math.random()*64; for(let x=0;x<=64;x+=8)g.lineTo(x,y+Math.sin(x*0.2+k)*3); g.stroke(); }
  return toTex(c,{repeat:true,nearest:false}); }
function texBlade(){ const c=px(S),g=c.getContext('2d'); g.clearRect(0,0,S,S);
  for(let x=1;x<S;x+=3){ const h=6+((Math.random()*7)|0); g.fillStyle=['#4fc32f','#5bd83b','#6ae94a'][(Math.random()*3)|0];
    for(let y=0;y<h;y++) g.fillRect(x+((Math.random()<0.3)?1:0), S-1-y, 1,1); }
  return toTex(c); }

const TEX={dirt:texDirt(),sand:texSand(),seabed:texSeabed(),stone:texStone(),grassTop:texGrassTop(),grassSide:texGrassSide(),
  path:texPath(),bark:texBark(),leaf:texLeaf(),leafPink:texLeafPink(),roof:texRoof(),water:texWater(),blade:texBlade(),wood:texWood()};

/* ========================================================================
   3. TERRAIN DATA (bigger island + a stone quarry to mine)
   ======================================================================== */
const N=96, HALF=N/2, WATER_TOP=2.35;
const heightMap=[];
function hash(x,y){ const n=Math.sin(x*127.1+y*311.7)*43758.5453; return n-Math.floor(n); }
function vnoise(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
  const a=hash(xi,yi),b=hash(xi+1,yi),c=hash(xi,yi+1),d=hash(xi+1,yi+1);
  return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v; }
function fbm(x,y){ let s=0,amp=1,f=1,tot=0; for(let o=0;o<4;o++){s+=vnoise(x*f,y*f)*amp;tot+=amp;amp*=0.5;f*=2;} return s/tot; }
function cellType(h){ if(h<=2)return 'seabed'; if(h===3)return 'sand'; if(h<WORLD.stoneH)return 'grass'; return 'stone'; }

for(let i=0;i<N;i++){ heightMap[i]=[];
  for(let j=0;j<N;j++){
    const n=fbm(i*0.085+3.5+WORLD.seed,j*0.085+1.2+WORLD.seed*0.7), dx=(i-HALF)/HALF, dz=(j-HALF)/HALF, d=Math.sqrt(dx*dx+dz*dz);
    const fall=clamp(1-Math.pow(d,2.5)*1.02,0,1); heightMap[i][j]=Math.min(13,Math.round(n*fall*10*WORLD.hMul));
  } }

/* Cinder Atoll gets an ACTUAL volcano: a cone rising to the height cap with a
   sunken crater full of lava. Pure math over the deterministic heightmap, so
   every client builds the identical mountain. The crater floor sits 3 below the
   rim — unreachable on foot, so you admire the lava from the edge. */
let CRATER=null;
if(worldKey==='volcano'){
  let ci=HALF,cj=HALF,pk=-1;
  for(let i=22;i<N-22;i++)for(let j=22;j<N-22;j++)
    if(heightMap[i][j]>pk){pk=heightMap[i][j];ci=i;cj=j;}
  const R=11, RIM=13, FLOOR=10;
  for(let i=ci-R;i<=ci+R;i++)for(let j=cj-R;j<=cj+R;j++){
    if(i<1||j<1||i>=N-1||j>=N-1)continue;
    const d=Math.hypot(i-ci,j-cj);
    if(d>R)continue;
    if(d<=2.2)heightMap[i][j]=FLOOR;                       // crater floor — the lava lake bed
    else if(d<=3.2)heightMap[i][j]=RIM;                    // the rim ring
    else heightMap[i][j]=Math.max(heightMap[i][j],Math.min(13,Math.round(RIM-(d-3.2)*1.05))); // ~1-step slope
  }
  CRATER={i:ci,j:cj,floor:FLOOR,rim:RIM};
}

function cellIndex(x,z){ return [clamp(Math.round(x+HALF),0,N-1),clamp(Math.round(z+HALF),0,N-1)]; }
function heightAt(x,z){ const [i,j]=cellIndex(x,z); return heightMap[i][j]; }
function isWaterAt(x,z){ return heightAt(x,z)<=2; }

// spawn: walkable grass near the middle
let spawnCell=null,best=1e9;
for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j];
  if(h>=4&&h<WORLD.stoneH){ const d=Math.abs(i-HALF)+Math.abs(j-HALF); if(d<best){best=d;spawnCell=[i,j,h];} } }
if(!spawnCell) spawnCell=[HALF,HALF,4];

// BFS reachability (walkable = land, step height <=1) + parent chain for path carving
function runBFS(){ const cameFrom=new Int32Array(N*N).fill(-2); const q=[spawnCell[0]*N+spawnCell[1]];
  cameFrom[q[0]]=-1;
  for(let qi=0;qi<q.length;qi++){ const cur=q[qi],ci=(cur/N)|0,cj=cur%N,ch=heightMap[ci][cj];
    const nb=[[ci+1,cj],[ci-1,cj],[ci,cj+1],[ci,cj-1]];
    for(const [ni,nj] of nb){ if(ni<0||nj<0||ni>=N||nj>=N)continue; const k=ni*N+nj;
      if(cameFrom[k]!==-2)continue; const nh=heightMap[ni][nj];
      if(nh<3||Math.abs(nh-ch)>1)continue; cameFrom[k]=cur; q.push(k); } }
  return cameFrom; }
let cameFrom=runBFS();
const reachable=(i,j)=>cameFrom[i*N+j]!==-2;

// guarantee reachable stone: every world needs a mine-shaft site (even ore-free isles,
// where the shaft is the door down into The Undermine)
{ let hasStone=false;
  for(let i=0;i<N&&!hasStone;i++)for(let j=0;j<N;j++) if(heightMap[i][j]>=WORLD.stoneH&&reachable(i,j)){hasStone=true;break;}
  if(!hasStone){ let cand=null,bd=0;
    for(let i=2;i<N-2;i++)for(let j=2;j<N-2;j++){ if(!reachable(i,j)||heightMap[i][j]<4||heightMap[i][j]>=WORLD.stoneH)continue;
      const d=Math.hypot(i-spawnCell[0],j-spawnCell[1]); if(d>bd&&d<30){bd=d;cand=[i,j];} }
    if(cand){ const [mi,mj]=cand,mh=heightMap[mi][mj];
      for(let i=mi-3;i<=mi+3;i++)for(let j=mj-3;j<=mj+3;j++){ if(i<0||j<0||i>=N||j>=N)continue;
        const d=Math.hypot(i-mi,j-mj);
        if(d<1.4)heightMap[i][j]=Math.max(heightMap[i][j],mh+3);
        else if(d<2.4)heightMap[i][j]=Math.max(heightMap[i][j],mh+2);
        else if(d<3.4)heightMap[i][j]=Math.max(heightMap[i][j],mh+1); }
      cameFrom=runBFS(); } } }

// landmark cells
const usedCells=new Set(); const keyOf=(i,j)=>i+'_'+j;
// every built structure, so a close-up camera can see what heightAt() cannot: {x,z,r,h,g}
const PROPS=[];
function findCellNear(cx,cj,minR,maxR,extra){ let cand=null,bd=1e9;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j];
    if(h<4||h>=WORLD.stoneH||usedCells.has(keyOf(i,j))||!reachable(i,j))continue;
    if(extra&&!extra(i,j))continue;
    const d=Math.hypot(i-cx,j-cj); if(d>=minR&&d<=maxR&&d<bd){bd=d;cand=[i,j,h];} }
  return cand; }
// spread the landmarks: distance bands + angular separation so they fan out across the isle
const angFrom=(i,j)=>Math.atan2(j-spawnCell[1],i-spawnCell[0]);
const angDiff=(a,b)=>{ let d=Math.abs(a-b)%TAU; return d>Math.PI?TAU-d:d; };
const traderCell=findCellNear(spawnCell[0],spawnCell[1],10,16)||findCellNear(spawnCell[0],spawnCell[1],6,20)||spawnCell;
usedCells.add(keyOf(traderCell[0],traderCell[1]));
const traderAng=angFrom(traderCell[0],traderCell[1]);
const casinoCell=findCellNear(spawnCell[0],spawnCell[1],18,30,(i,j)=>angDiff(angFrom(i,j),traderAng)>=1.5)
  ||findCellNear(spawnCell[0],spawnCell[1],14,34,(i,j)=>Math.hypot(i-traderCell[0],j-traderCell[1])>=12)
  ||findCellNear(spawnCell[0],spawnCell[1],9,26)||spawnCell;
usedCells.add(keyOf(casinoCell[0],casinoCell[1]));
const casinoAng=angFrom(casinoCell[0],casinoCell[1]);
const portalCell=findCellNear(spawnCell[0],spawnCell[1],16,30,(i,j)=>angDiff(angFrom(i,j),traderAng)>=1.4&&angDiff(angFrom(i,j),casinoAng)>=1.4)
  ||findCellNear(spawnCell[0],spawnCell[1],12,32,(i,j)=>Math.hypot(i-traderCell[0],j-traderCell[1])>=10&&Math.hypot(i-casinoCell[0],j-casinoCell[1])>=10)
  ||findCellNear(spawnCell[0],spawnCell[1],6,24)||null;
if(portalCell)usedCells.add(keyOf(portalCell[0],portalCell[1]));

// harbor dock: a reachable sand cell with a clear 3-wide water channel running
// toward +x or +z (the iso camera looks from +x/+z, so those piers stay visible)
let harborCell=null,harborDir=null;
{ let bestScore=-1;
  const isWaterCell=(i,j)=>i>=1&&j>=1&&i<N-1&&j<N-1&&heightMap[i][j]<=2;
  for(let i=2;i<N-2;i++)for(let j=2;j<N-2;j++){
    if(heightMap[i][j]!==3||!reachable(i,j)||usedCells.has(keyOf(i,j)))continue;
    const dSp=Math.hypot(i-spawnCell[0],j-spawnCell[1]); if(dSp<6||dSp>36)continue;
    if(Math.hypot(i-traderCell[0],j-traderCell[1])<7)continue;
    if(Math.hypot(i-casinoCell[0],j-casinoCell[1])<7)continue;
    if(portalCell&&Math.hypot(i-portalCell[0],j-portalCell[1])<7)continue;
    for(const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1]]){
      let wide=0; // channel length where boat + pier both fit (3 cells wide)
      for(let k=1;k<=6;k++){ let ok=true;
        for(let s=-1;s<=1;s++){ if(!isWaterCell(i+dx*k-dz*s,j+dz*k+dx*s)){ok=false;break;} }
        if(!ok)break; wide=k; }
      if(wide<4)continue;
      const score=wide*((dx>0||dz>0)?1.6:1)+(20-Math.abs(dSp-13))*0.06;
      if(score>bestScore){bestScore=score;harborCell=[i,j,3];harborDir=[dx,dz];} } }
  if(harborCell)usedCells.add(keyOf(harborCell[0],harborCell[1])); }

// mine heart: reachable stone cell with the most stone around it
let mineCell=null; { let bs=-1;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ if(heightMap[i][j]<WORLD.stoneH||!reachable(i,j))continue;
    let s=0; for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++){ const ii=i+a,jj=j+b;
      if(ii>=0&&jj>=0&&ii<N&&jj<N&&heightMap[ii][jj]>=WORLD.stoneH)s++; }
    if(s>bs){bs=s;mineCell=[i,j,heightMap[i][j]];} } }

// dirt paths spawn -> trader / casino / mine, via the BFS parent chain
const pathSet=new Set();
function carvePath(ti,tj){ let k=ti*N+tj;
  while(k>=0&&cameFrom[k]>=0){ const i=(k/N)|0,j=k%N;
    if(!usedCells.has(keyOf(i,j)))pathSet.add(keyOf(i,j));
    if(Math.random()<0.22){ const [oi,oj]=[[i+1,j],[i-1,j],[i,j+1],[i,j-1]][(Math.random()*4)|0];
      if(oi>=0&&oj>=0&&oi<N&&oj<N&&heightMap[oi][oj]>=3&&!usedCells.has(keyOf(oi,oj)))pathSet.add(keyOf(oi,oj)); }
    k=cameFrom[k]; } }
carvePath(traderCell[0],traderCell[1]); carvePath(casinoCell[0],casinoCell[1]);
if(portalCell)carvePath(portalCell[0],portalCell[1]);
if(harborCell)carvePath(harborCell[0],harborCell[1]);
if(mineCell&&reachable(mineCell[0],mineCell[1]))carvePath(mineCell[0],mineCell[1]);

// partition cells by render type
const byType={seabed:[],sand:[],grass:[],stone:[],path:[]}, landCells=[], grassCells=[];
for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j]; let t=cellType(h);
  if(h>=3)landCells.push([i,j,h]); if(t==='grass')grassCells.push([i,j,h]);
  if(pathSet.has(keyOf(i,j))&&(t==='grass'||t==='sand'))t='path';
  byType[t].push([i,j,h]); }

/* ========================================================================
   4. TERRAIN MESHES (top block + dirt shaft => crisp Minecraft columns)
   ======================================================================== */
const boxGeo=new THREE.BoxGeometry(1,1,1);
const dummy=new THREE.Object3D();
function mat(tex){ return new THREE.MeshLambertMaterial({map:tex}); }
function buildInstanced(list,material,scaleFn){
  if(!list.length) return null;
  const mesh=new THREE.InstancedMesh(boxGeo,material,list.length);
  mesh.frustumCulled=false; // r128 culls by base geometry bounds at origin — instances far away would vanish
  mesh.castShadow=false; mesh.receiveShadow=true;
  for(let k=0;k<list.length;k++){ scaleFn(list[k]); dummy.updateMatrix(); mesh.setMatrixAt(k,dummy.matrix); }
  mesh.instanceMatrix.needsUpdate=true; scene.add(mesh); return mesh;
}
function buildColumns(list,topMat,shaftMat){
  buildInstanced(list,topMat,([i,j,h])=>{ dummy.position.set(i-HALF,h-0.5,j-HALF); dummy.scale.set(1,1,1); dummy.rotation.set(0,0,0); });
  const shafts=list.filter(c=>c[2]>1);
  if(shafts.length) buildInstanced(shafts,shaftMat,([i,j,h])=>{ dummy.position.set(i-HALF,(h-1)/2,j-HALF); dummy.scale.set(1,h-1,1); dummy.rotation.set(0,0,0); });
}
buildInstanced(byType.seabed,mat(TEX.seabed),([i,j,h])=>{ const hr=Math.max(h,1);
  dummy.position.set(i-HALF,hr/2,j-HALF); dummy.scale.set(1,hr,1); dummy.rotation.set(0,0,0); });
const dirtM=mat(TEX.dirt), grassSideM=mat(TEX.grassSide), grassTopM=mat(TEX.grassTop);
buildColumns(byType.sand, mat(TEX.sand), mat(TEX.sand));
buildColumns(byType.stone, mat(TEX.stone), mat(TEX.stone));
buildColumns(byType.grass, [grassSideM,grassSideM,grassTopM,dirtM,grassSideM,grassSideM], dirtM);
buildColumns(byType.path, mat(TEX.path), dirtM);

// ---- flowing water (vertex waves + scrolling caustic texture) ----
const WSEG=64, waterGeo=new THREE.PlaneGeometry(N*3,N*3,WSEG,WSEG);
TEX.water.repeat.set(30,30);
const waterMat=new THREE.MeshLambertMaterial({color:WORLD.water,map:TEX.water,transparent:true,opacity:0.84,depthWrite:false});
const water=new THREE.Mesh(waterGeo,waterMat);
water.rotation.x=-Math.PI/2; water.position.set(0,WATER_TOP,0);
scene.add(water);
// Seabed: the island is a shell of columns with nothing underneath, so any low camera
// angle used to look straight through it into empty sky. This floor closes that hole.
const seabed=new THREE.Mesh(new THREE.PlaneGeometry(N*3,N*3),
  new THREE.MeshLambertMaterial({color:0x14384a}));
seabed.rotation.x=-Math.PI/2; seabed.position.set(0,-0.35,0); seabed.receiveShadow=true;
scene.add(seabed);
const wPos=waterGeo.attributes.position, wBaseX=new Float32Array(wPos.count), wBaseY=new Float32Array(wPos.count);
for(let i=0;i<wPos.count;i++){ wBaseX[i]=wPos.getX(i); wBaseY[i]=wPos.getY(i); }
let waterAlt=0;
function animWater(t){
  TEX.water.offset.x=(t*0.015)%1; TEX.water.offset.y=(t*0.01)%1;
  if((waterAlt^=1))return; // vertex waves at 30Hz — invisible difference, halves the upload cost
  for(let i=0;i<wPos.count;i++){ const x=wBaseX[i],y=wBaseY[i];
    const z=Math.sin(x*0.5+t*1.3)*0.11+Math.sin(y*0.4-t*1.1)*0.09+Math.sin((x+y)*0.3+t*0.7)*0.05;
    wPos.setZ(i,z); }
  wPos.needsUpdate=true;
}

/* ========================================================================
   5. DECOR — stepped voxel trees, cherry trees, flowers, mushrooms, rocks
   ======================================================================== */
const decorUsed=new Set();
const nearAny=(i,j,pts,gap)=>pts.some(p=>Math.hypot(p[0]-i,p[1]-j)<gap);
const landmarks=[spawnCell,traderCell,casinoCell]; if(mineCell)landmarks.push(mineCell); if(portalCell)landmarks.push(portalCell); if(harborCell)landmarks.push(harborCell);
function decorOK(i,j,gap){ return !usedCells.has(keyOf(i,j))&&!decorUsed.has(keyOf(i,j))&&!pathSet.has(keyOf(i,j))&&!nearAny(i,j,landmarks,gap); }

// tree layouts -> instanced trunk cubes + leaf cubes (green / pink)
const trunkMats=[],leafG=[],leafP=[],treePts=[],treeData=[];
{ const sh=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(treePts.length>=WORLD.treeMax)break;
    if(!decorOK(i,j,5.5)||nearAny(i,j,treePts,2.6))continue; // tall trees need a wide berth so landmarks stay visible from the iso camera
    treePts.push([i,j]); decorUsed.add(keyOf(i,j));
    const x=i-HALF,z=j-HALF,pink=Math.random()<WORLD.pink,L=pink?leafP:leafG;
    treeData.push({x,z,y:h,pink,cd:0});
    const trunkH=2+((Math.random()*2)|0);
    for(let y=0;y<trunkH;y++){ dummy.position.set(x,h+0.5+y,z); dummy.scale.set(0.55,1,0.55); dummy.rotation.set(0,0,0);
      dummy.updateMatrix(); trunkMats.push(dummy.matrix.clone()); }
    const cy=h+trunkH;
    for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++){ if(Math.abs(a)===1&&Math.abs(b)===1&&Math.random()<0.45)continue;
      dummy.position.set(x+a*0.92,cy+0.5,z+b*0.92); const s=rand(0.88,1.0); dummy.scale.set(s,s,s); dummy.rotation.set(0,0,0);
      dummy.updateMatrix(); L.push(dummy.matrix.clone()); }
    for(const [a,b] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){ if(Math.abs(a)+Math.abs(b)===1&&Math.random()<0.4)continue;
      dummy.position.set(x+a*0.9,cy+1.42,z+b*0.9); const s=rand(0.8,0.94); dummy.scale.set(s,s,s); dummy.rotation.set(0,0,0);
      dummy.updateMatrix(); L.push(dummy.matrix.clone()); }
    dummy.position.set(x,cy+2.2,z); dummy.scale.set(0.75,0.75,0.75); dummy.rotation.set(0,0,0);
    dummy.updateMatrix(); L.push(dummy.matrix.clone()); } }
function buildFromMats(mats,material){ if(!mats.length)return null;
  const m=new THREE.InstancedMesh(boxGeo,material,mats.length);
  m.frustumCulled=false;
  m.castShadow=true; m.receiveShadow=true;
  for(let k=0;k<mats.length;k++)m.setMatrixAt(k,mats[k]);
  m.instanceMatrix.needsUpdate=true; scene.add(m); return m; }
buildFromMats(trunkMats,mat(TEX.bark));
buildFromMats(leafG,mat(TEX.leaf));
buildFromMats(leafP,mat(TEX.leafPink));

// rocks (instanced, spaced out)
{ const mats=[],pts=[],sh=landCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(mats.length>=34)break;
    if(h<3||!decorOK(i,j,3)||nearAny(i,j,treePts,1.6)||nearAny(i,j,pts,2.6))continue;
    pts.push([i,j]); decorUsed.add(keyOf(i,j));
    dummy.position.set(i-HALF+rand(-0.15,0.15),h+0.32,j-HALF+rand(-0.15,0.15));
    dummy.scale.set(rand(0.7,1.15),rand(0.55,0.85),rand(0.7,1.15)); dummy.rotation.set(0,rand(0,TAU),0);
    dummy.updateMatrix(); mats.push(dummy.matrix.clone()); }
  buildFromMats(mats,mat(TEX.stone)); }

// flowers: colored heads on tiny stems (per-instance color)
{ const stemMats=[],headMats=[],cols=[],PAL=[0xff4f5e,0xffd94f,0xb96ef0,0xffffff,0xff8f3d];
  const sh=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(headMats.length>=130)break;
    if(!decorOK(i,j,2)||nearAny(i,j,treePts,1.2))continue;
    const x=i-HALF+rand(-0.32,0.32),z=j-HALF+rand(-0.32,0.32);
    dummy.position.set(x,h+0.14,z); dummy.scale.set(0.07,0.28,0.07); dummy.rotation.set(0,0,0);
    dummy.updateMatrix(); stemMats.push(dummy.matrix.clone());
    dummy.position.set(x,h+0.33,z); const s=rand(0.16,0.24); dummy.scale.set(s,s,s); dummy.rotation.set(0,rand(0,TAU),0);
    dummy.updateMatrix(); headMats.push(dummy.matrix.clone());
    cols.push(PAL[(Math.random()*PAL.length)|0]); }
  buildFromMats(stemMats,new THREE.MeshLambertMaterial({color:0x3e9b2c}));
  if(headMats.length){ const m=new THREE.InstancedMesh(boxGeo,new THREE.MeshLambertMaterial({color:0xffffff}),headMats.length);
    m.frustumCulled=false;
    const c=new THREE.Color();
    for(let k=0;k<headMats.length;k++){ m.setMatrixAt(k,headMats[k]); m.setColorAt(k,c.setHex(cols[k])); }
    m.instanceMatrix.needsUpdate=true; if(m.instanceColor)m.instanceColor.needsUpdate=true;
    scene.add(m); } }

// mushrooms
{ const stemMats=[],capMats=[];
  const sh=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(capMats.length>=26)break;
    if(!decorOK(i,j,2)||nearAny(i,j,treePts,1.4))continue; decorUsed.add(keyOf(i,j));
    const x=i-HALF+rand(-0.25,0.25),z=j-HALF+rand(-0.25,0.25);
    dummy.position.set(x,h+0.14,z); dummy.scale.set(0.14,0.3,0.14); dummy.rotation.set(0,0,0);
    dummy.updateMatrix(); stemMats.push(dummy.matrix.clone());
    dummy.position.set(x,h+0.36,z); dummy.scale.set(0.36,0.16,0.36); dummy.rotation.set(0,rand(0,TAU),0);
    dummy.updateMatrix(); capMats.push(dummy.matrix.clone()); }
  buildFromMats(stemMats,new THREE.MeshLambertMaterial({color:0xf0e6d6}));
  buildFromMats(capMats,new THREE.MeshLambertMaterial({color:0xe03a34})); }

// swaying grass tufts
function bladeGeo(){
  const g=new THREE.BufferGeometry();
  const p=[ -0.4,0,0, 0.4,0,0, 0.4,0.9,0,  -0.4,0,0, 0.4,0.9,0, -0.4,0.9,0,
            0,0,-0.4, 0,0,0.4, 0,0.9,0.4,   0,0,-0.4, 0,0.9,0.4, 0,0.9,-0.4 ];
  const uv=[ 0,0, 1,0, 1,1, 0,0, 1,1, 0,1,  0,0, 1,0, 1,1, 0,0, 1,1, 0,1 ];
  g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.computeVertexNormals();
  return g;
}
let tuftMesh=null; const tufts=[];
{
  const cand=grassCells.filter(c=>!pathSet.has(keyOf(c[0],c[1]))&&Math.random()<0.35).slice(0,380);
  if(cand.length){
    const gm=new THREE.MeshLambertMaterial({map:TEX.blade,alphaTest:0.5,transparent:true,side:THREE.DoubleSide});
    tuftMesh=new THREE.InstancedMesh(bladeGeo(),gm,cand.length);
    tuftMesh.frustumCulled=false;
    tuftMesh.castShadow=false; tuftMesh.receiveShadow=false;
    cand.forEach(c=>{ const [i,j,h]=c; tufts.push({x:i-HALF+rand(-0.3,0.3),y:h,z:j-HALF+rand(-0.3,0.3),ph:rand(0,TAU),s:rand(0.7,1.15)}); });
    scene.add(tuftMesh);
  }
}
function animGrass(t){ if(!tuftMesh)return;
  for(let k=0;k<tufts.length;k++){ const g=tufts[k];
    dummy.position.set(g.x,g.y,g.z);
    dummy.rotation.set(Math.cos(t*1.1+g.ph)*0.10, g.ph, Math.sin(t*1.6+g.ph)*0.18);
    dummy.scale.set(g.s,g.s,g.s); dummy.updateMatrix(); tuftMesh.setMatrixAt(k,dummy.matrix); }
  tuftMesh.instanceMatrix.needsUpdate=true;
}

/* ========================================================================
   6. LANDMARKS — trader stall, casino dais, quarry + ore nodes
   ======================================================================== */
function texturedBox(w,h,d,tex,extra){ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshLambertMaterial(Object.assign({map:tex},extra||{}))); }
function humanoid(sc){ const g=new THREE.Group();
  const skin=new THREE.MeshLambertMaterial({color:sc.skin||0xf0c090}), shirt=new THREE.MeshLambertMaterial({color:sc.shirt}),
    pants=new THREE.MeshLambertMaterial({color:sc.pants}), hatM=new THREE.MeshLambertMaterial({color:sc.hat||sc.shirt});
  const legL=new THREE.Mesh(new THREE.BoxGeometry(0.32,0.62,0.32),pants); legL.position.set(-0.2,0.31,0);
  const legR=legL.clone(); legR.position.x=0.2;
  const body=new THREE.Mesh(new THREE.BoxGeometry(0.72,0.7,0.44),shirt); body.position.y=0.95;
  const armL=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.6,0.28),shirt); armL.position.set(-0.47,0.98,0);
  const armR=armL.clone(); armR.position.x=0.47;
  const head=new THREE.Mesh(new THREE.BoxGeometry(0.56,0.52,0.5),skin); head.position.y=1.56;
  const hat=new THREE.Mesh(new THREE.BoxGeometry(0.64,0.2,0.6),hatM); hat.position.y=1.86;
  const brim=new THREE.Mesh(new THREE.BoxGeometry(0.78,0.08,0.74),hatM); brim.position.y=1.74;
  [legL,legR,body,armL,armR,head,hat,brim].forEach(m=>{m.castShadow=true;g.add(m);});
  g.userData={legL,legR,armL,armR}; return g; }

// --- the HERO: a signature captain-angler with a real face, straw hat & scarf ---
function texFace(){ const c=px(16),g=c.getContext('2d');
  g.fillStyle='#f0c090'; g.fillRect(0,0,16,16);
  for(let k=0;k<26;k++){ g.fillStyle=Math.random()<0.5?'#e8b884':'#f6c898'; g.fillRect((Math.random()*16)|0,(Math.random()*16)|0,1,1); }
  g.fillStyle='#2b2320'; g.fillRect(3,6,3,3); g.fillRect(10,6,3,3);        // eyes
  g.fillStyle='#ffffff'; g.fillRect(4,6,1,1); g.fillRect(11,6,1,1);        // sparkle
  g.fillStyle='#5a4632'; g.fillRect(3,4,3,1); g.fillRect(10,4,3,1);        // brows
  g.fillStyle='#d88a6a'; g.fillRect(2,10,2,1); g.fillRect(12,10,2,1);      // blush
  g.fillStyle='#8a4a3a'; g.fillRect(6,12,4,1); g.fillRect(5,11,1,1); g.fillRect(10,11,1,1); // grin
  return toTex(c); }
function makeHero(){ const g=new THREE.Group();
  const skinM=new THREE.MeshLambertMaterial({color:0xf0c090}),
    vestM=new THREE.MeshLambertMaterial({color:0x2ba394}),   // signature teal vest
    shirtM=new THREE.MeshLambertMaterial({color:0xf2e6c8}),  // cream sleeves
    pantsM=new THREE.MeshLambertMaterial({color:0x33507a}),
    bootM=new THREE.MeshLambertMaterial({color:0x5e4226}),
    strawM=new THREE.MeshLambertMaterial({color:0xe8c86a}),
    bandM=new THREE.MeshLambertMaterial({color:0xd8483f}),
    scarfM=new THREE.MeshLambertMaterial({color:0xd8483f}),
    goldM=new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0x8a6a1e,emissiveIntensity:0.25});
  const legL=new THREE.Mesh(new THREE.BoxGeometry(0.32,0.62,0.32),pantsM); legL.position.set(-0.2,0.31,0);
  const bootL=new THREE.Mesh(new THREE.BoxGeometry(0.36,0.2,0.4),bootM); bootL.position.set(0,-0.24,0.03); legL.add(bootL);
  const legR=legL.clone(); legR.position.x=0.2;
  const body=new THREE.Mesh(new THREE.BoxGeometry(0.72,0.7,0.44),vestM); body.position.y=0.95;
  const belly=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.56,0.06),shirtM); belly.position.set(0,-0.02,0.23); body.add(belly);
  const emblem=new THREE.Mesh(new THREE.BoxGeometry(0.14,0.1,0.04),goldM); emblem.position.set(-0.2,0.16,0.25); body.add(emblem); // gold fish pin
  const belt=new THREE.Mesh(new THREE.BoxGeometry(0.74,0.12,0.46),bootM); belt.position.y=0.62;
  const buckle=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.1,0.05),goldM); buckle.position.set(0,0,0.23); belt.add(buckle);
  const armL=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.6,0.28),shirtM); armL.position.set(-0.47,0.98,0);
  const handL=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.16,0.24),skinM); handL.position.set(0,-0.36,0); armL.add(handL);
  const armR=armL.clone(); armR.position.x=0.47;
  const faceM=new THREE.MeshLambertMaterial({map:texFace()});
  const head=new THREE.Mesh(new THREE.BoxGeometry(0.56,0.52,0.5),[skinM,skinM,skinM,skinM,faceM,skinM]); head.position.y=1.56;
  const hair=new THREE.Mesh(new THREE.BoxGeometry(0.58,0.1,0.52),new THREE.MeshLambertMaterial({color:0x5a4632})); hair.position.y=1.79;
  const scarf=new THREE.Mesh(new THREE.BoxGeometry(0.6,0.15,0.5),scarfM); scarf.position.y=1.28;
  const scarfTail=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.36,0.06),scarfM); scarfTail.position.set(0.12,-0.2,-0.26); scarf.add(scarfTail);
  const crown=new THREE.Mesh(new THREE.BoxGeometry(0.6,0.24,0.56),strawM); crown.position.y=1.98;
  const band=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.09,0.58),bandM); band.position.y=1.88;
  const brim=new THREE.Mesh(new THREE.BoxGeometry(0.94,0.08,0.9),strawM); brim.position.y=1.83;
  const lure=new THREE.Mesh(new THREE.BoxGeometry(0.09,0.12,0.05),goldM); lure.position.set(0.4,-0.09,0.3); brim.add(lure); // lucky lure on the brim
  const pack=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.56,0.22),new THREE.MeshLambertMaterial({map:TEX.wood})); pack.position.set(0,1.02,-0.34);
  const strap=new THREE.Mesh(new THREE.BoxGeometry(0.72,0.09,0.46),bootM); strap.position.set(0,1.18,0); strap.rotation.z=0.5;
  [legL,legR,body,belt,armL,armR,head,hair,scarf,crown,band,brim,pack,strap].forEach(m=>{m.castShadow=true;g.add(m);});
  g.userData={legL,legR,armL,armR,scarfTail,head,hair,scarf,crown,band,brim,body,belt,pack,strap,
    bootL,bootR:legR.children[0],handL,handR:armR.children[0],   // clones have no names of their own
    mats:{band:bandM,scarf:scarfM,vest:vestM}}; return g; }

const LABELS=[];   // every world sign, so a cinematic can clear them out of frame
function makeLabel(text,color,reg){ const c=px(256); c.height=64; const x=c.getContext('2d');
  x.fillStyle='rgba(9,16,20,0.82)'; const r=10,w=256,h=52,y=6; x.beginPath();
  x.moveTo(r,y);x.arcTo(w,y,w,h,r);x.arcTo(w,h+y,0,h+y,r);x.arcTo(0,h+y,0,y,r);x.arcTo(0,y,w,y,r);x.closePath();x.fill();
  x.fillStyle=color;x.font='bold 30px "Chakra Petch",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,128,34);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=MAXANISO;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false})); sp.scale.set(3.4,0.85,1);
  if(reg!==false)LABELS.push(sp); return sp; }

// --- trader stall: checkered roof on wooden posts, counter + crates ---
const trader=humanoid({shirt:0x7a4a2a,pants:0x3a2c1c,hat:0xcaa15a,skin:0xe8bd8f});
const tX=traderCell[0]-HALF, tY=heightMap[traderCell[0]][traderCell[1]], tZ=traderCell[1]-HALF;
trader.position.set(tX,tY,tZ); scene.add(trader);
PROPS.push({x:tX,z:tZ,r:2.9,h:tY+3.7,g:null});
{ const stall=new THREE.Group();
  for(const [px2,pz2] of [[-1.45,-1.1],[1.45,-1.1],[-1.45,1.1],[1.45,1.1]]){
    const post=texturedBox(0.2,2.5,0.2,TEX.bark); post.position.set(px2,1.25,pz2); post.castShadow=true; stall.add(post); }
  const roof=texturedBox(3.6,0.28,2.9,TEX.roof); roof.position.y=2.62; roof.castShadow=true; stall.add(roof);
  const roof2=texturedBox(2.6,0.24,2.1,TEX.roof); roof2.position.y=2.98; roof2.castShadow=true; stall.add(roof2);
  const counter=texturedBox(2.6,0.9,0.7,TEX.wood); counter.position.set(0,0.45,1.05); counter.castShadow=true; counter.receiveShadow=true; stall.add(counter);
  for(let k=0;k<3;k++){ const crate=texturedBox(0.62,0.62,0.62,TEX.wood);
    crate.position.set(-2.2+rand(-0.1,0.1),0.31+(k===2?0.62:0),-0.4+k*0.75*(k===2?0:1)); crate.castShadow=true; stall.add(crate); }
  stall.position.set(tX,tY,tZ-0.4); scene.add(stall); }
const traderLabel=makeLabel('TRADER','#ffcf5c'); traderLabel.position.set(tX,tY+3.9,tZ); scene.add(traderLabel);
const TRADER_POS=new THREE.Vector3(tX,tY,tZ);

// --- casino: stone dais, gold lamps + a REAL roulette table standing in the world ---
const NSEG=15,SEG=[]; SEG[0]='green'; for(let i=1;i<NSEG;i++)SEG[i]=(i%2===1)?'red':'black';
const SEGCOL={red:0xc0392b,black:0x242a30,green:0x2fae5e};
const SEGA=TAU/NSEG, WR=1.15;
const R_TRACK=1.44,R_POCK=0.82,Y_TRACK=1.36,Y_POCK=1.31; // ball path, local to the table group
function wedgeGeo(r,thetaStart,thetaLength,h){
  const shape=new THREE.Shape(); shape.moveTo(0,0); shape.absarc(0,0,r,thetaStart,thetaStart+thetaLength,false); shape.lineTo(0,0);
  const g=new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:false}); g.rotateX(-Math.PI/2); return g; }
const casino=new THREE.Group(); const lamps=[], casinoLamps=[]; // casinoLamps flare on a roulette win
{ const cbase=texturedBox(4.2,0.5,4.2,TEX.stone); cbase.position.y=0.25; cbase.castShadow=true; cbase.receiveShadow=true; casino.add(cbase);
  for(const [lx,lz] of [[-1.85,-1.85],[1.85,-1.85],[-1.85,1.85],[1.85,1.85]]){
    const post=texturedBox(0.18,2.4,0.18,TEX.bark); post.position.set(lx,1.55,lz); post.castShadow=true; casino.add(post);
    const lamp=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.34,0.34), new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0xffb320,emissiveIntensity:0.85}));
    lamp.position.set(lx,2.95,lz); casino.add(lamp); lamps.push(lamp); casinoLamps.push(lamp); } }
const tableG=new THREE.Group(); tableG.position.y=0.5; casino.add(tableG);
{ // wooden legs + top + green felt + raised rim: an actual roulette table
  for(const [lx,lz] of [[-0.95,-0.95],[0.95,-0.95],[-0.95,0.95],[0.95,0.95]]){
    const leg=texturedBox(0.2,0.85,0.2,TEX.bark); leg.position.set(lx,0.42,lz); leg.castShadow=true; tableG.add(leg); }
  const ttop=new THREE.Mesh(new THREE.CylinderGeometry(1.95,1.8,0.18,26),new THREE.MeshLambertMaterial({map:TEX.wood}));
  ttop.position.y=0.94; ttop.castShadow=true; ttop.receiveShadow=true; tableG.add(ttop);
  const felt=new THREE.Mesh(new THREE.CylinderGeometry(1.8,1.8,0.1,26),new THREE.MeshLambertMaterial({color:0x1c6a45}));
  felt.position.y=1.06; felt.receiveShadow=true; tableG.add(felt);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(1.56,0.13,10,30),new THREE.MeshLambertMaterial({color:0x8a5d33}));
  rim.rotation.x=Math.PI/2; rim.position.y=1.2; rim.castShadow=true; tableG.add(rim);
  const plankGeo=new THREE.BoxGeometry(0.2,0.26,0.14);
  for(let k=0;k<26;k++){ const a=k*(TAU/26);
    const m=new THREE.Mesh(plankGeo,new THREE.MeshLambertMaterial({color:k%2?0x9a6b3a:0x7d5530}));
    m.position.set(Math.cos(a)*1.86,1.06,Math.sin(a)*1.86); m.rotation.y=-a; m.castShadow=true; tableG.add(m); } }
const wheelDisc=new THREE.Group(); wheelDisc.position.y=1.12; tableG.add(wheelDisc);
const wedges=[];  // kept around so the winning pocket can be lit up on a win
for(let i=0;i<NSEG;i++){ const w=new THREE.Mesh(wedgeGeo(WR,i*SEGA,SEGA,0.14),new THREE.MeshLambertMaterial({color:SEGCOL[SEG[i]]}));
  w.castShadow=true; wheelDisc.add(w); wedges.push(w); }
{ // pocket pins on the wedge borders — they spin with the wheel
  const pinGeo=new THREE.BoxGeometry(0.06,0.14,0.06), pinMat=new THREE.MeshLambertMaterial({color:0xd9b45c,emissive:0x604a17,emissiveIntensity:0.3});
  for(let i=0;i<NSEG;i++){ const a=-(i*SEGA), pin=new THREE.Mesh(pinGeo,pinMat);
    pin.position.set(Math.cos(a)*1.04,0.2,Math.sin(a)*1.04); wheelDisc.add(pin); } }
{ const c=px(64),cx2=c.getContext('2d'); cx2.fillStyle='#eafff1'; cx2.font='700 22px "Chakra Petch",sans-serif';
  cx2.textAlign='center'; cx2.textBaseline='middle'; cx2.fillText('14×',32,34);
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true,depthTest:false}));
  const gAng=-(SEGA/2); spr.position.set(Math.cos(gAng)*WR*0.6,0.26,Math.sin(gAng)*WR*0.6); spr.scale.set(0.5,0.5,1);
  wheelDisc.add(spr); }
{ const hub=new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.3,0.2,10),new THREE.MeshLambertMaterial({color:0x3a4048}));
  hub.position.y=0.2; wheelDisc.add(hub);
  const turr=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.05,0.08),new THREE.MeshLambertMaterial({color:0xd9b45c}));
  turr.position.y=0.32; wheelDisc.add(turr);
  const turr2=turr.clone(); turr2.rotation.y=Math.PI/2; wheelDisc.add(turr2);
  const knob=new THREE.Mesh(new THREE.ConeGeometry(0.09,0.22,8),new THREE.MeshLambertMaterial({color:0xd9b45c}));
  knob.position.y=0.45; wheelDisc.add(knob); }
const ball=new THREE.Mesh(new THREE.SphereGeometry(0.09,12,10),new THREE.MeshLambertMaterial({color:0xf4f6f0,emissive:0x50524e,emissiveIntensity:0.35}));
ball.castShadow=true; tableG.add(ball);
casino.position.set(casinoCell[0]-HALF,heightMap[casinoCell[0]][casinoCell[1]],casinoCell[1]-HALF); scene.add(casino);
PROPS.push({x:casino.position.x,z:casino.position.z,r:2.9,h:casino.position.y+3.2,g:casino});
const casinoLabel=makeLabel('CASINO','#ff5d7a'); casinoLabel.position.copy(casino.position).add(new THREE.Vector3(0,3.9,0)); scene.add(casinoLabel);
const CASINO_POS=casino.position.clone();
const WHEEL_CENTER=casino.position.clone().add(new THREE.Vector3(0,1.7,0));
let viewMode='follow'; // 'follow' walks with the player · 'casino' flies the camera onto the table
let wheelAngle=0, ballA=0, ballLockIdx=0;
function setBall(b,r,y){ ballA=b; ball.position.set(Math.cos(b)*r,y,Math.sin(b)*r); }
function setBallPocket(i){ const phi=i*SEGA+SEGA/2; setBall(-phi-wheelAngle,R_POCK,Y_POCK); }
setBallPocket(0);

/* --- win celebration rig ---------------------------------------------------
   Three cheap layers that read instantly from the casino camera: two shockwave
   rings pushing out across the felt, a light shaft standing in the winning
   pocket (parented to the disc so it rides the wheel), and the wedge itself
   breathing gold. Everything decays on its own — nothing to clean up. */
const winRings=[];
for(let k=0;k<2;k++){
  const rg=new THREE.Mesh(new THREE.RingGeometry(0.86,1.04,44),
    new THREE.MeshBasicMaterial({color:0xffd24f,transparent:true,opacity:0,side:THREE.DoubleSide,
      depthWrite:false,blending:THREE.AdditiveBlending}));
  rg.rotation.x=-Math.PI/2; rg.position.y=1.31; rg.visible=false; tableG.add(rg); winRings.push(rg); }
const BEAM_H=3.2;
const beamGeo=new THREE.CylinderGeometry(0.26,0.14,BEAM_H,10,1,true);
{ // vertex colours fade the shaft to black toward the tip — under additive blending, black is invisible
  const pos=beamGeo.attributes.position, col=new Float32Array(pos.count*3);
  for(let i=0;i<pos.count;i++){ const f=clamp(0.5-pos.getY(i)/BEAM_H,0,1), v=f*f;
    col[i*3]=v; col[i*3+1]=v; col[i*3+2]=v; }
  beamGeo.setAttribute('color',new THREE.BufferAttribute(col,3)); }
const winBeam=new THREE.Mesh(beamGeo,
  new THREE.MeshBasicMaterial({color:0xffd24f,transparent:true,opacity:0,side:THREE.DoubleSide,
    vertexColors:true,depthWrite:false,blending:THREE.AdditiveBlending}));
winBeam.visible=false; wheelDisc.add(winBeam);
const winFx={t:0,dur:0,idx:-1,big:false};
let camPunch=0, casinoFlare=0;
// fired the instant the ball locks into a winning pocket
function triggerWinFx(idx,big){
  const prev=wedges[winFx.idx]; if(prev)prev.material.emissiveIntensity=0;   // a fast re-spin must not leave two wedges lit
  winFx.t=0; winFx.dur=big?2.1:1.35; winFx.idx=idx; winFx.big=!!big;
  camPunch=big?0.58:0.32; casinoFlare=big?1:0.6;
  const phi=idx*SEGA+SEGA/2;
  winBeam.position.set(Math.cos(-phi)*R_POCK,0.16,Math.sin(-phi)*R_POCK); }
function updateWinFx(dt,rdt){
  camPunch*=Math.exp(-6*rdt); casinoFlare*=Math.exp(-2.6*rdt);   // camera + lamps ride real time, they ignore hit-stop
  if(winFx.dur<=0)return;
  const prev=winFx.t; winFx.t+=dt; const T=winFx.t, big=winFx.big, hue=big?0x74e08a:0xffd24f;
  for(let k=0;k<winRings.length;k++){ const rg=winRings[k], s=(T-k*0.17)/(big?0.8:0.62);
    if(s<0||s>1){ rg.visible=false; continue; }
    rg.visible=true; const sc=0.5+s*(big?1.7:1.35);
    rg.scale.set(sc,sc,1); rg.material.color.setHex(hue);
    rg.material.opacity=Math.min(1,s*7)*Math.pow(1-s,1.4)*(big?0.62:0.6); }
  { const gr=Math.min(1,T/0.16), fade=Math.max(0,1-T/(big?1.6:1.05));   // the shaft snaps up, then bleeds away
    winBeam.visible=fade>0; winBeam.scale.set(1,gr,1); winBeam.position.y=0.16+BEAM_H*gr*0.5;
    winBeam.material.color.setHex(hue); winBeam.material.opacity=fade*(big?0.62:0.5); }
  const w=wedges[winFx.idx];
  if(w){ const fall=Math.max(0,1-T/winFx.dur);
    w.material.emissive.setHex(big?0x2fae5e:0xffd24f);
    w.material.emissiveIntensity=fall*(0.6+0.4*Math.sin(T*15))*(big?0.78:0.85); }
  // confetti falls over the table in short bursts rather than one big blob
  const SHOWERS=big?[0.18,0.46,0.8,1.15]:[0.2,0.5];
  for(const s of SHOWERS) if(prev<s&&T>=s){
    fxBurst(WHEEL_CENTER.x+rand(-1,1),WHEEL_CENTER.y+2.7,WHEEL_CENTER.z+rand(-1,1),
      {n:big?11:7,cols:big?[0x74e08a,0xffd24f,0xffefb0]:[0xffd24f,0xffefb0,0xfff2cc],
       speed:1.4,up:0.5,size:0.95,grav:5,ttl:1.6});
    sfx.sparkle(); }
  if(T>=winFx.dur){ winFx.dur=0;
    for(const rg of winRings)rg.visible=false;
    winBeam.visible=false; if(w)w.material.emissiveIntensity=0; } }

// --- entrance monument: a grand voxel gate greeting new arrivals at spawn ---
{ const gate=new THREE.Group();
  const dirX=traderCell[0]-spawnCell[0], dirZ=traderCell[1]-spawnCell[1];
  const dl=Math.hypot(dirX,dirZ)||1, ux=dirX/dl, uz=dirZ/dl;
  const gx=spawnCell[0]-HALF+ux*2.5, gz=spawnCell[1]-HALF+uz*2.5;
  const gy=heightAt(gx,gz);
  for(const side of [-1,1]){
    const base=texturedBox(0.95,0.6,0.95,TEX.stone); base.position.set(side*1.7,0.3,0); base.castShadow=true; gate.add(base);
    const pil=texturedBox(0.62,3.1,0.62,TEX.stone); pil.position.set(side*1.7,2.05,0); pil.castShadow=true; gate.add(pil);
    const cap=texturedBox(0.82,0.3,0.82,TEX.stone); cap.position.set(side*1.7,3.75,0); cap.castShadow=true; gate.add(cap);
    const glow=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.4,0.4),new THREE.MeshLambertMaterial({color:0x7fdcff,emissive:0x3aa9d8,emissiveIntensity:0.9}));
    glow.position.set(side*1.7,4.12,0); gate.add(glow); lamps.push(glow);
    const torch=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.28,0.16),new THREE.MeshLambertMaterial({color:0xffb320,emissive:0xff8c1a,emissiveIntensity:0.9}));
    torch.position.set(side*1.7,2.55,0.44); gate.add(torch); lamps.push(torch); }
  const beam=texturedBox(4.7,0.5,0.82,TEX.stone); beam.position.y=3.35; beam.castShadow=true; gate.add(beam);
  const beam2=texturedBox(3.6,0.34,0.6,TEX.wood); beam2.position.y=3.82; beam2.castShadow=true; gate.add(beam2);
  const banner=makeLabel(WORLD.name.toUpperCase(),'#7fdcff');
  banner.position.set(0,2.55,0); banner.scale.set(3.1,0.78,1); gate.add(banner);
  gate.position.set(gx,gy,gz); gate.rotation.y=Math.atan2(ux,uz); scene.add(gate);
  PROPS.push({x:gx,z:gz,r:3.4,h:gy+4.4,g:gate}); }

// --- island portal: an obsidian arch with a swirling rift — step through to hop isles ---
let PORTAL_POS=null,portalSwirl=null,portalCore=null; const portalBits=[];
if(portalCell){
  const p=new THREE.Group(); const obsMat=new THREE.MeshLambertMaterial({color:0x241b38});
  for(const s of[-1,1]){
    const base=texturedBox(0.8,0.5,0.8,TEX.stone); base.position.set(s*1.25,0.25,0); base.castShadow=true; p.add(base);
    const pil=new THREE.Mesh(new THREE.BoxGeometry(0.55,2.9,0.55),obsMat); pil.position.set(s*1.25,1.95,0); pil.castShadow=true; p.add(pil);
    const gl=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3),new THREE.MeshLambertMaterial({color:0xc490ff,emissive:0x8a3cff,emissiveIntensity:0.9}));
    gl.position.set(s*1.25,3.62,0); p.add(gl); lamps.push(gl); }
  const top=new THREE.Mesh(new THREE.BoxGeometry(3.05,0.55,0.55),obsMat); top.position.y=3.35; top.castShadow=true; p.add(top);
  portalCore=new THREE.Mesh(new THREE.PlaneGeometry(1.85,2.55),
    new THREE.MeshLambertMaterial({color:0x120a22,emissive:0x5b2bd8,emissiveIntensity:0.55,transparent:true,opacity:0.92,side:THREE.DoubleSide}));
  portalCore.position.y=1.82; p.add(portalCore);
  { const sc=px(64),sg=sc.getContext('2d'); sg.translate(32,32);
    for(let a=0;a<70;a++){ const t=a/70,r2=2+t*27,ang=t*TAU*2.3;
      sg.fillStyle=`rgba(${(170+t*70)|0},${(110+t*120)|0},255,${(0.9-t*0.8).toFixed(2)})`;
      sg.fillRect(Math.cos(ang)*r2-2,Math.sin(ang)*r2-2,4,4); }
    portalSwirl=new THREE.Mesh(new THREE.PlaneGeometry(1.6,1.6),
      new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(sc),transparent:true,depthWrite:false,side:THREE.DoubleSide}));
    portalSwirl.position.set(0,1.82,0.04); p.add(portalSwirl); }
  for(let k=0;k<7;k++){ const b=new THREE.Mesh(new THREE.BoxGeometry(0.09,0.09,0.09),
    new THREE.MeshLambertMaterial({color:0xc9a5ff,emissive:0x9a5cff,emissiveIntensity:0.9}));
    b.userData={ph:k/7*TAU,r:rand(1.0,1.5),sp:rand(0.5,1.2)}; p.add(b); portalBits.push(b); }
  p.position.set(portalCell[0]-HALF,portalCell[2],portalCell[1]-HALF); p.rotation.y=Math.PI/4; scene.add(p);
  PROPS.push({x:p.position.x,z:p.position.z,r:2.5,h:p.position.y+5.2,g:p});
  PORTAL_POS=p.position.clone();
  const pl=makeLabel('PORTAL','#c490ff'); pl.position.copy(PORTAL_POS).add(new THREE.Vector3(0,4.5,0)); scene.add(pl); }

/* --- HARBOR DOCK: a timber pier over the shallows + the player's boat.
       Five hand-built voxel ships, raft → galleon, swapped in on upgrade. --- */
function makeBoat(lvl){
  const g=new THREE.Group(); g.userData={sails:[],flags:[],lanterns:[]};
  const woodM=new THREE.MeshLambertMaterial({map:TEX.wood}), barkM=new THREE.MeshLambertMaterial({map:TEX.bark});
  const tealM=new THREE.MeshLambertMaterial({color:0x2ba394}), whiteM=new THREE.MeshLambertMaterial({color:0xf2ede2});
  const darkM=new THREE.MeshLambertMaterial({color:0x4a3520}), ropeM=new THREE.MeshLambertMaterial({color:0x2b2320});
  const sailM=new THREE.MeshLambertMaterial({color:0xf4efe0,side:THREE.DoubleSide});
  const goldM=new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0x8a6a1e,emissiveIntensity:0.3});
  const roseM=new THREE.MeshLambertMaterial({color:0xd8483f});
  const V=(m,x,y,z,sx,sy,sz,par)=>{const b=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),m);b.position.set(x,y,z);b.castShadow=true;(par||g).add(b);return b;};
  const flag=(m,x,y,z,sx,sy)=>{const f=V(m,x,y,z,sx,sy,0.035);f.userData={y0:0};g.userData.flags.push(f);return f;};
  const sail=(x,y,z,sx,sy,sz)=>{const s=V(sailM,x,y,z,sx,sy,sz);s.userData={y0:0};g.userData.sails.push(s);return s;};
  const lantern=(x,y,z,s)=>{const l=new THREE.Mesh(new THREE.BoxGeometry(s,s,s),
    new THREE.MeshLambertMaterial({color:0xffd27a,emissive:0xffa235,emissiveIntensity:0.9}));
    l.position.set(x,y,z); g.add(l); g.userData.lanterns.push(l); return l;};

  if(lvl<=0){ // ── Lv0 · DRIFTWOOD RAFT — lashed logs & a prayer
    for(let k=0;k<4;k++)V(barkM,(k%2?0.05:-0.03),0.07,(k-1.5)*0.33,1.55+(k%2?0.18:0),0.22,0.29);
    V(woodM,-0.52,0.23,0,0.16,0.07,1.34); V(woodM,0.52,0.23,0,0.16,0.07,1.34);
    V(ropeM,-0.52,0.23,0.52,0.2,0.09,0.1); V(ropeM,0.52,0.23,-0.52,0.2,0.09,0.1); // lashings
    V(barkM,-0.62,0.6,-0.4,0.09,0.85,0.09);
    flag(roseM,-0.44,0.86,-0.4,0.3,0.2).userData.y0=0;
    { const pad=new THREE.Group(); pad.position.set(0.3,0.32,0.3); pad.rotation.y=0.55; g.add(pad);
      V(barkM,0,0,0,0.9,0.06,0.07,pad); V(woodM,0.52,0,0,0.24,0.04,0.16,pad); } // paddle
    V(darkM,0.55,0.31,-0.32,0.2,0.13,0.2); // rope coil
  } else if(lvl===1){ // ── Lv1 · CORK DINGHY — a real hull at last
    V(woodM,0,0.14,0,1.9,0.2,0.84);
    V(woodM,0,0.42,0.47,1.9,0.36,0.1); V(woodM,0,0.42,-0.47,1.9,0.36,0.1);
    V(woodM,-0.98,0.42,0,0.13,0.36,0.98);
    V(woodM,1.05,0.42,0,0.42,0.36,0.58); V(woodM,1.3,0.47,0,0.2,0.28,0.26); // stepped bow
    V(darkM,0.05,0.5,0,0.46,0.07,0.86); V(darkM,-0.62,0.5,0,0.32,0.07,0.86); // benches
    for(const s of[-1,1]){ const oar=new THREE.Group(); oar.position.set(0.28,0.56,s*0.34); oar.rotation.set(s*0.32,s*0.5,0); g.add(oar);
      V(barkM,0,0,0,0.07,0.07,1.5,oar); V(woodM,0,0,s*0.82,0.05,0.2,0.36,oar); }
    V(goldM,1.22,0.62,0,0.09,0.07,0.12); // bow cleat
    V(darkM,-0.78,0.56,0.22,0.18,0.12,0.18); // rope coil
  } else if(lvl===2){ // ── Lv2 · TEAL SLOOP — painted hull, single proud sail
    V(tealM,0,0.16,0,2.5,0.26,0.94);
    V(whiteM,0,0.31,0,2.54,0.07,0.99); // waterline stripe
    V(tealM,0,0.49,0.5,2.5,0.3,0.11); V(tealM,0,0.49,-0.5,2.5,0.3,0.11); V(tealM,-1.25,0.49,0,0.13,0.3,1.02);
    V(tealM,1.36,0.4,0,0.5,0.44,0.58); V(tealM,1.66,0.46,0,0.2,0.3,0.28); // pointed bow
    V(woodM,0,0.62,0,2.32,0.07,0.88); // deck
    V(barkM,0.35,1.92,0,0.11,2.7,0.11); // mast
    V(barkM,-0.38,0.9,0,1.42,0.08,0.08); // boom
    sail(-0.4,1.5,0,1.32,1.08,0.05); sail(-0.28,2.28,0,0.84,0.5,0.05); // main, gaff-cut
    sail(1.0,1.55,0,0.72,0.95,0.04); // jib
    flag(tealM,0.55,3.36,0,0.34,0.18);
    { const til=V(woodM,-1.12,0.76,0,0.42,0.07,0.09); til.rotation.y=0.35; } // tiller
    V(woodM,0.75,0.78,0.25,0.32,0.26,0.32); // cargo crate
    V(goldM,1.72,0.58,0,0.09,0.09,0.09);
  } else if(lvl===3){ // ── Lv3 · STORM TRAWLER — iron-clad workhorse with a crane
    const hullM=new THREE.MeshLambertMaterial({color:0x3e5a6e}), roofM=new THREE.MeshLambertMaterial({color:0x2b3a44});
    V(hullM,0,0.18,0,3.1,0.34,1.12);
    V(roseM,0,0.38,0,3.14,0.08,1.17); // red waterline
    V(hullM,0,0.6,0.58,3.1,0.34,0.13); V(hullM,0,0.6,-0.58,3.1,0.34,0.13); V(hullM,-1.55,0.6,0,0.14,0.34,1.2);
    V(hullM,1.72,0.5,0,0.52,0.6,0.78); V(hullM,2.06,0.56,0,0.24,0.44,0.4); // bow
    V(woodM,0,0.76,0,2.94,0.08,1.06); // deck
    V(whiteM,0.62,1.2,0,0.95,0.8,0.92); // wheelhouse
    { const win=new THREE.MeshLambertMaterial({color:0x0c2a30,emissive:0x39d7c4,emissiveIntensity:0.5});
      V(win,1.11,1.34,0,0.05,0.3,0.66); V(win,0.62,1.34,0.48,0.6,0.3,0.05); V(win,0.62,1.34,-0.48,0.6,0.3,0.05); }
    V(roofM,0.62,1.66,0,1.1,0.12,1.06); // roof
    V(roofM,0.3,1.95,0,0.2,0.5,0.2); V(goldM,0.3,2.16,0,0.23,0.09,0.23); // funnel + gold band
    V(barkM,-0.65,1.55,0,0.1,1.55,0.1); // crane mast
    { const boom=V(barkM,-1.18,1.85,0,1.15,0.08,0.08); boom.rotation.z=0.45;
      V(ropeM,-1.62,1.5,0,0.035,0.9,0.035); V(darkM,-1.62,0.98,0,0.42,0.34,0.34); } // rope + hauled net crate
    for(const s of[-1,1]){ V(roseM,0.15,0.52,s*0.68,0.18,0.18,0.09); V(roseM,-0.85,0.52,s*0.68,0.18,0.18,0.09); } // buoys
    for(const s of[-1,1])for(let k=0;k<4;k++)V(roofM,-1.25+k*0.8,0.92,s*0.55,0.05,0.24,0.05); // railing posts
    V(darkM,-1.15,0.92,0.25,0.36,0.24,0.36); V(darkM,-1.15,0.92,-0.28,0.3,0.2,0.3); // catch crates
    lantern(2.1,0.92,0,0.16); lantern(-0.65,2.4,0,0.14);
    flag(whiteM,-0.5,2.28,0,0.3,0.16);
  } else { // ── Lv4 · GILDED GALLEON — pride of the archipelago
    const timM=new THREE.MeshLambertMaterial({color:0x6b4a26}), tim2=new THREE.MeshLambertMaterial({color:0x59391c});
    V(timM,0,0.2,0,4.1,0.4,1.28);
    V(goldM,0,0.44,0,4.14,0.07,1.33); // gilded waterline
    V(tim2,0,0.66,0.66,4.1,0.5,0.15); V(tim2,0,0.66,-0.66,4.1,0.5,0.15); V(tim2,-2.05,0.66,0,0.16,0.5,1.32);
    V(timM,2.2,0.56,0,0.5,0.62,0.86); V(timM,2.56,0.68,0,0.3,0.44,0.48); // bow rise
    { const bs=V(barkM,2.98,0.98,0,0.95,0.1,0.1); bs.rotation.z=0.32; } // bowsprit
    V(goldM,2.64,0.95,0,0.24,0.17,0.15); V(goldM,2.8,1.02,0,0.1,0.1,0.09); // gold fish figurehead
    V(woodM,0.35,0.9,0,3.25,0.08,1.12); // main deck
    V(timM,-1.5,1.12,0,1.15,0.48,1.28); V(woodM,-1.5,1.38,0,1.2,0.07,1.32); // stern castle 1
    V(timM,-1.78,1.6,0,0.62,0.4,1.28); V(woodM,-1.78,1.82,0,0.66,0.07,1.32); // stern castle 2
    for(const s of[-1,1])for(let k=0;k<3;k++)V(goldM,-1.15-k*0.44,1.56,s*0.6,0.05,0.3,0.05); // gilt railing
    lantern(-2.16,1.72,0,0.17); // great stern lantern
    { const mg=new THREE.Group(); mg.position.set(0.5,0,0); mg.rotation.y=0.5; g.add(mg); // main mast, yards braced at an angle so the sails read from every camera side
      V(barkM,0,2.7,0,0.13,3.6,0.13,mg);
      V(barkM,0,3.5,0,0.08,0.08,1.9,mg); V(barkM,0,2.2,0,0.08,0.08,1.95,mg);
      const s1=V(sailM,0,2.85,0,0.07,1.2,1.78,mg), s2=V(sailM,0,3.86,0,0.07,0.62,1.2,mg);
      s1.userData={y0:0}; s2.userData={y0:0}; g.userData.sails.push(s1,s2);
      V(darkM,0,4.42,0,0.36,0.2,0.36,mg); // crow's nest
      const f1=V(tealM,0.22,4.68,0,0.4,0.2,0.035,mg); f1.userData={y0:0}; g.userData.flags.push(f1); }
    { const zg=new THREE.Group(); zg.position.set(-0.85,0,0); zg.rotation.y=0.35; g.add(zg); // mizzen mast
      V(barkM,0,2.3,0,0.11,2.8,0.11,zg);
      V(barkM,0,3.1,0,0.07,0.07,1.5,zg);
      const s3=V(sailM,0,2.62,0,0.07,0.9,1.42,zg); s3.userData={y0:0}; g.userData.sails.push(s3);
      const f2=V(roseM,0.19,3.82,0,0.3,0.16,0.035,zg); f2.userData={y0:0}; g.userData.flags.push(f2); }
    for(const s of[-1,1])for(let k=0;k<5;k++)V(goldM,-1.7+k*0.85,0.95,s*0.68,0.09,0.09,0.05); // gunwale studs
    V(darkM,1.3,1.02,0.3,0.4,0.3,0.4); V(darkM,-0.2,1.0,-0.35,0.34,0.26,0.34); // deck cargo
  }
  return g; }
function animBoat(b,t){ if(!b)return; const u=b.userData; if(!u)return;
  if(u.flags)for(let i=0;i<u.flags.length;i++){const f=u.flags[i];f.rotation.y=(f.userData.y0||0)+Math.sin(t*3.1+i*1.4)*0.4;}
  if(u.sails)for(let i=0;i<u.sails.length;i++){const s=u.sails[i];s.rotation.y=((s.userData&&s.userData.y0)||0)+Math.sin(t*1.5+i)*0.035;}
  if(u.lanterns)for(let i=0;i<u.lanterns.length;i++)u.lanterns[i].material.emissiveIntensity=0.7+Math.sin(t*3+i*2)*0.3; }

let DOCK=null,dockBoat=null;
if(harborCell){
  const ux=harborDir[0],uz=harborDir[1],px_=-uz,pz_=ux,AX=Math.abs(ux);
  const hx=harborCell[0]-HALF,hz=harborCell[1]-HALF,DY=3.02;
  const at=(t,s)=>({x:hx+ux*t+px_*s,z:hz+uz*t+pz_*s});
  const pier=new THREE.Group();
  for(let t=0.55;t<=4.95;t+=0.55){ const p=at(t,0);
    const pl2=texturedBox(AX?0.5:1.18,0.09,AX?1.18:0.5,TEX.wood);
    pl2.position.set(p.x,DY,p.z); pl2.castShadow=true; pl2.receiveShadow=true; pier.add(pl2); }
  for(const s of[-1,1]){ const p=at(2.75,s*0.62); // low side rails
    const r=texturedBox(AX?4.2:0.09,0.07,AX?0.09:4.2,TEX.wood); r.position.set(p.x,DY+0.34,p.z); r.castShadow=true; pier.add(r); }
  for(const t of[1.15,2.5,3.85,4.95])for(const s of[-1,1]){ const p=at(t,s*0.58); // posts to the seabed, bollards at the head
    const hb=Math.max(0.4,heightAt(p.x,p.z)-0.2), top=DY+(t>4.5?0.42:0.22);
    const post=texturedBox(0.17,top-hb,0.17,TEX.bark); post.position.set(p.x,(top+hb)/2,p.z); post.castShadow=true; pier.add(post); }
  { const p=at(4.95,-0.58); // lantern on the pier head
    const lp=texturedBox(0.12,0.95,0.12,TEX.bark); lp.position.set(p.x,DY+0.85,p.z); lp.castShadow=true; pier.add(lp);
    const glow=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.26,0.26),new THREE.MeshLambertMaterial({color:0xffd27a,emissive:0xffa235,emissiveIntensity:0.9}));
    glow.position.set(p.x,DY+1.42,p.z); pier.add(glow); lamps.push(glow); }
  { const p=at(-0.5,0.72); const crate=texturedBox(0.56,0.56,0.56,TEX.wood); crate.position.set(p.x,DY+0.28,p.z); crate.castShadow=true; pier.add(crate);
    const c2=texturedBox(0.44,0.44,0.44,TEX.wood); c2.position.set(p.x-0.1,DY+0.78,p.z+0.06); c2.rotation.y=0.4; c2.castShadow=true; pier.add(c2);
    const p2=at(-0.55,-0.65); const barrel=texturedBox(0.4,0.62,0.4,TEX.bark); barrel.position.set(p2.x,DY+0.31,p2.z); barrel.castShadow=true; pier.add(barrel); }
  scene.add(pier);
  DOCK={boat:at(3.3,1.18), yaw:AX?(ux>0?0:Math.PI):(uz>0?-Math.PI/2:Math.PI/2), base:at(0,0), head:at(4.95,0.58)};
  { const b=DOCK.head, m=at(4.0,0.95); // mooring rope, gently sagging
    const rg=new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(b.x,DY+0.4,b.z), new THREE.Vector3((b.x+m.x)/2,WATER_TOP+0.42,(b.z+m.z)/2), new THREE.Vector3(m.x,WATER_TOP+0.32,m.z)]);
    const rope=new THREE.Line(rg,new THREE.LineBasicMaterial({color:0x2b2320,transparent:true,opacity:0.85})); scene.add(rope); }
  const hLabel=makeLabel('HARBOR','#39d7c4'); hLabel.position.set(at(2.2,0).x,DY+3.1,at(2.2,0).z); scene.add(hLabel); }
const HARBOR_POS=DOCK?new THREE.Vector3(DOCK.base.x,3,DOCK.base.z):null;
function rebuildDockBoat(){ if(!DOCK)return;
  if(dockBoat){ dockBoat.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material&&o.material.dispose)o.material.dispose();}); scene.remove(dockBoat); }
  dockBoat=makeBoat(state.boatLvl);
  dockBoat.position.set(DOCK.boat.x,WATER_TOP+0.02,DOCK.boat.z);
  dockBoat.rotation.y=DOCK.yaw; scene.add(dockBoat); }

// --- quarry: ore nodes on the reachable stone ---
const ORE_INFO={
  wood:   {name:'Wood',   price:6,  color:0x9a6b3a, glow:false, dot:'#9a6b3a'},
  coal:   {name:'Coal',   price:5,  color:0x2e3338, glow:false, dot:'#565e66'},
  iron:   {name:'Iron',   price:12, color:0xd8cfc4, glow:false, dot:'#d8cfc4'},
  gold:   {name:'Gold',   price:28, color:0xffd24f, glow:true,  dot:'#ffd24f'},
  diamond:{name:'Diamond',price:70, color:0x5ee8e2, glow:true,  dot:'#5ee8e2'}};
function rollOreType(){ const r=Math.random(); return r<0.4?'coal':r<0.7?'iron':r<0.9?'gold':'diamond'; }
/* A node's ore is DERIVED from (world, node index), never rolled — the server
   computes the identical value in rules.js:oreTypeFor, so what you see in the
   rock is what you are credited. Ids at or past the quarry count are the grass
   starter nodes and stay coal/iron. Must stay byte-for-byte in step with the server. */
function oreTypeFor(world,id){
  const w=WORLDS[world]||WORLDS.isle, seed=Number.isFinite(w.seed)?w.seed:0;
  const n=(((Math.trunc(id)%100003)+100003)%100003);
  const r=hash(n+1,seed+1);
  if(Math.trunc(id)>=(w.oreN||0))return r<0.6?'coal':'iron';
  return r<0.4?'coal':r<0.7?'iron':r<0.9?'gold':'diamond'; }
function makeOreNode(type,geode){ const g=new THREE.Group(); const info=ORE_INFO[type];
  const base=texturedBox(0.95,0.8,0.95,TEX.stone); base.position.y=0.4; base.castShadow=true; g.add(base);
  for(let k=0;k<5;k++){ const s=rand(0.15,0.23);
    const chip=new THREE.Mesh(new THREE.BoxGeometry(s,s,s),
      new THREE.MeshLambertMaterial({color:info.color,emissive:info.glow?info.color:0x000000,emissiveIntensity:info.glow?0.4:0}));
    if(Math.random()<0.4) chip.position.set(rand(-0.3,0.3),0.8,rand(-0.3,0.3));
    else { const a=rand(0,TAU); chip.position.set(Math.cos(a)*0.48,rand(0.25,0.65),Math.sin(a)*0.48); }
    chip.rotation.y=rand(0,TAU); g.add(chip); }
  if(geode){ // a fat crystal-crusted boulder — worth far more, takes far longer to crack
    g.scale.setScalar(1.32);
    const shell=texturedBox(1.06,0.5,1.06,TEX.stone); shell.position.y=1.0; shell.castShadow=true; g.add(shell);
    for(let k=0;k<7;k++){ const a=rand(0,TAU), s=rand(0.13,0.2);
      const cr=new THREE.Mesh(new THREE.BoxGeometry(s,s*1.9,s),
        new THREE.MeshLambertMaterial({color:info.color,emissive:info.color,emissiveIntensity:0.55}));
      cr.position.set(Math.cos(a)*0.42,1.18+rand(0,0.16),Math.sin(a)*0.42); cr.rotation.set(rand(-0.4,0.4),a,rand(-0.4,0.4)); g.add(cr); } }
  return g; }
const oreNodes=[];
{ const pts=[];
  if(WORLD.oreN>0){ const stoneCand=[]; for(let i=0;i<N;i++)for(let j=0;j<N;j++)
      if(heightMap[i][j]>=WORLD.stoneH&&reachable(i,j)&&!usedCells.has(keyOf(i,j)))stoneCand.push([i,j,heightMap[i][j]]);
    stoneCand.sort(()=>Math.random()-0.5);
    for(const [i,j,h] of stoneCand){ if(oreNodes.length>=WORLD.oreN)break;
      if(nearAny(i,j,pts,2.3))continue; pts.push([i,j]);
      const type=oreTypeFor(worldKey,oreNodes.length), geode=Math.random()<0.14, mesh=makeOreNode(type,geode);
      mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
      oreNodes.push({x:i-HALF,z:j-HALF,y:h,type,mesh,alive:true,respawnAt:0,geode}); } }
  // starter nodes on grass — ALWAYS, even on mine-less isles: guarantees an early coal/iron
  // source so L3 tool crafting ({coal}) is never impossible in world 1
  const sh2=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh2){ if(oreNodes.length>=WORLD.oreN+4)break;
    if(!decorOK(i,j,3)||nearAny(i,j,treePts,1.6)||nearAny(i,j,pts,4))continue;
    if(Math.hypot(i-spawnCell[0],j-spawnCell[1])<6)continue;
    pts.push([i,j]); decorUsed.add(keyOf(i,j));
    const type=oreTypeFor(worldKey,oreNodes.length), mesh=makeOreNode(type);
    mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
    oreNodes.push({x:i-HALF,z:j-HALF,y:h,type,mesh,alive:true,respawnAt:0}); } }
// --- the mine itself: shaft mouth, hoist headframe, cart on rails, timber supports ---
const mineProps={cart:null,z0:0,z1:0,wheel:null,door:null};
if(mineCell){
  const [mi,mj]=mineCell, mh=heightMap[mi][mj];
  const oreNear=(i,j,r)=>oreNodes.some(n=>Math.hypot(n.x-(i-HALF),n.z-(j-HALF))<r);
  const stoneOK=(i,j)=>i>=0&&j>=0&&i<N&&j<N&&heightMap[i][j]>=WORLD.stoneH;
  const steel=new THREE.MeshLambertMaterial({color:0x555b63});
  const propPts=[];
  let ei=mi,ej=mj,eh=mh;
  if(oreNear(mi,mj,1.4)){ let bd=1e9;
    for(let i=mi-3;i<=mi+3;i++)for(let j=mj-3;j<=mj+3;j++){ if(!stoneOK(i,j)||oreNear(i,j,1.35))continue;
      const d=Math.hypot(i-mi,j-mj); if(d<bd){bd=d;ei=i;ej=j;} }
    eh=heightMap[ei][ej]; }
  propPts.push([ei,ej]);
  // the iso camera always looks from +x/+z, so the shaft mouth must face one of
  // those two axes to ever be seen — pick the one with the longer flat rail run
  const flatRun=(dx,dz)=>{ let r=0; for(let k=1;k<=5;k++){ const ci=ei+dx*k,cj=ej+dz*k;
    if(!stoneOK(ci,cj)||heightMap[ci][cj]!==eh||oreNear(ci,cj,1.0))break; r=k; } return r; };
  const runX=flatRun(1,0), runZ=flatRun(0,1);
  const useX=runX>runZ||(runX===runZ&&(spawnCell[0]-mi)>=(spawnCell[1]-mj));
  const fx2=useX?1:0, fz2=useX?0:1, runLen=useX?runX:runZ;
  const yaw=Math.atan2(fx2,fz2);
  const EX=ei-HALF,EZ=ej-HALF;
  mineProps.door=new THREE.Vector3(EX,eh,EZ); // E here descends into (or climbs out of) The Undermine
  const mineLabel=makeLabel(WORLD.cave?'EXIT':'MINE',WORLD.cave?'#7fe8a8':'#9fd7ff');
  mineLabel.position.set(EX,eh+6.4,EZ); scene.add(mineLabel);
  // A. entrance: rock backdrop, dark tunnel mouth, timber frame, lantern, hoist tower
  { const e=new THREE.Group();
    const rock=texturedBox(3.3,2.7,1.15,TEX.stone); rock.position.set(0,1.35,-0.75); rock.castShadow=true; e.add(rock);
    const rock2=texturedBox(2.3,0.8,0.9,TEX.stone); rock2.position.set(0,3.1,-0.75); rock2.castShadow=true; e.add(rock2);
    const mouth=new THREE.Mesh(new THREE.BoxGeometry(1.2,1.55,0.3),new THREE.MeshLambertMaterial({color:0x05090c})); mouth.position.set(0,0.78,-0.12); e.add(mouth);
    for(const s of[-1,1]){ const post=texturedBox(0.26,1.9,0.26,TEX.bark); post.position.set(s*0.78,0.95,0.06); post.castShadow=true; e.add(post); }
    const lintel=texturedBox(1.95,0.3,0.36,TEX.wood); lintel.position.set(0,1.95,0.06); lintel.castShadow=true; e.add(lintel);
    const lant=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.26,0.22),new THREE.MeshLambertMaterial({color:0xffd27a,emissive:0xffa235,emissiveIntensity:0.9}));
    lant.position.set(0,1.62,0.2); e.add(lant); lamps.push(lant);
    for(const a of[-1,1])for(const b of[-1,1]){ const leg=texturedBox(0.16,1.7,0.16,TEX.bark); leg.position.set(a*0.6,4.3,-0.75+b*0.38); leg.castShadow=true; e.add(leg); }
    const cross=texturedBox(1.5,0.18,0.2,TEX.wood); cross.position.set(0,5.12,-0.75); cross.castShadow=true; e.add(cross);
    const rope=new THREE.Mesh(new THREE.BoxGeometry(0.05,1.8,0.05),new THREE.MeshLambertMaterial({color:0x1c2126})); rope.position.set(0,4.4,-0.75); e.add(rope);
    const holder=new THREE.Group(); holder.position.set(0,5.36,-0.75); holder.rotation.z=Math.PI/2; e.add(holder);
    const wheel=new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.12,10),steel); holder.add(wheel);
    mineProps.wheel=wheel;
    e.position.set(EX,eh,EZ); e.rotation.y=yaw; scene.add(e); }
  // B. rails out of the mouth + an ore cart trundling back and forth
  const inRail=(i,j)=>{ const a=(i-ei)*fx2+(j-ej)*fz2, p=Math.abs((i-ei)*fz2)+Math.abs((j-ej)*fx2);
    return a>=-1&&a<=runLen+1&&p<1.2; };
  if(runLen>=2){ const rg=new THREE.Group(); const L=runLen+0.35;
    for(let z=0.75;z<L;z+=0.55){ const sl=texturedBox(0.72,0.07,0.2,TEX.wood); sl.position.set(0,0.045,z); rg.add(sl); }
    for(const s of[-1,1]){ const rail=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,L-0.55),steel);
      rail.position.set(s*0.27,0.115,(0.55+L)/2); rg.add(rail); }
    const cart=new THREE.Group();
    const tub=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.36,0.44),new THREE.MeshLambertMaterial({color:0x454a52})); tub.position.y=0.36; tub.castShadow=true; cart.add(tub);
    const rim=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.08,0.52),new THREE.MeshLambertMaterial({color:0x353a42})); rim.position.y=0.55; cart.add(rim);
    const chunkCols=[[0x2e3338,0],[0xffd24f,0.5],[0xd8cfc4,0]];
    chunkCols.forEach((cc,k2)=>{ const ch=new THREE.Mesh(new THREE.BoxGeometry(0.17,0.17,0.17),
      new THREE.MeshLambertMaterial({color:cc[0],emissive:cc[1]?cc[0]:0x000000,emissiveIntensity:cc[1]}));
      ch.position.set((k2-1)*0.16,0.62,(k2%2?0.09:-0.07)); ch.rotation.y=k2*0.7; cart.add(ch); });
    for(const a of[-1,1])for(const b of[-1,1]){ const wh=new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,0.07,8),steel);
      wh.rotation.z=Math.PI/2; wh.position.set(a*0.27,0.12,b*0.16); cart.add(wh); }
    rg.add(cart); mineProps.cart=cart; mineProps.z0=0.95; mineProps.z1=L-0.35; cart.position.z=mineProps.z0;
    rg.position.set(EX,eh,EZ); rg.rotation.y=yaw; scene.add(rg); }
  // C-F. scattered props: timber supports, lantern posts, rubble, ore crate + stuck pick
  const pickCells=(cnt,r0,r1,gap)=>{ const cand=[];
    for(let i=Math.max(1,mi-9);i<=Math.min(N-2,mi+9);i++)for(let j=Math.max(1,mj-9);j<=Math.min(N-2,mj+9);j++){
      if(!stoneOK(i,j)||oreNear(i,j,1.25)||inRail(i,j))continue;
      const d=Math.hypot(i-ei,j-ej); if(d<r0||d>r1)continue; cand.push([i,j,heightMap[i][j]]); }
    cand.sort(()=>Math.random()-0.5); const out=[];
    for(const c of cand){ if(out.length>=cnt)break; if(nearAny(c[0],c[1],propPts,gap))continue;
      propPts.push([c[0],c[1]]); out.push(c); } return out; };
  for(const [i,j,h] of pickCells(3,2.2,7,2.4)){ const f=new THREE.Group();
    for(const s of[-1,1]){ const post=texturedBox(0.22,1.5,0.22,TEX.bark); post.position.set(s*0.65,0.75,0); post.castShadow=true; f.add(post); }
    const beam=texturedBox(1.72,0.22,0.26,TEX.wood); beam.position.y=1.56; beam.rotation.z=rand(-0.05,0.05); beam.castShadow=true; f.add(beam);
    f.position.set(i-HALF,h,j-HALF); f.rotation.y=(Math.random()<0.5?0:Math.PI/2)+rand(-0.12,0.12); scene.add(f); }
  for(const [i,j,h] of pickCells(3,2,7.5,2.2)){ const p=new THREE.Group();
    const post=texturedBox(0.14,1.3,0.14,TEX.bark); post.position.y=0.65; post.castShadow=true; p.add(post);
    const glow=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.22,0.22),new THREE.MeshLambertMaterial({color:0xffd27a,emissive:0xffa235,emissiveIntensity:0.9}));
    glow.position.y=1.4; p.add(glow); lamps.push(glow);
    p.position.set(i-HALF,h,j-HALF); scene.add(p); }
  for(const [i,j,h] of pickCells(6,1.5,8,1.5)){ const rb=new THREE.Group();
    for(let k=0;k<3;k++){ const s=rand(0.2,0.42); const b=texturedBox(s,s*0.8,s,TEX.stone);
      b.position.set(rand(-0.3,0.3),s*0.4,rand(-0.3,0.3)); b.rotation.y=rand(0,TAU); b.castShadow=true; rb.add(b); }
    rb.position.set(i-HALF,h,j-HALF); scene.add(rb); }
  for(const [i,j,h] of pickCells(1,1.5,4,1.4)){ const c=new THREE.Group();
    const crate=texturedBox(0.6,0.6,0.6,TEX.wood); crate.position.y=0.3; crate.castShadow=true; c.add(crate);
    for(const s of[-1,1]){ const chip=new THREE.Mesh(new THREE.BoxGeometry(0.15,0.15,0.15),
      new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0xffd24f,emissiveIntensity:0.4}));
      chip.position.set(s*0.13,0.66,s*0.08); chip.rotation.y=rand(0,TAU); c.add(chip); }
    const handle=texturedBox(0.09,0.85,0.09,TEX.bark); handle.position.set(0.5,0.4,0.2); handle.rotation.z=0.5; c.add(handle);
    const head=new THREE.Mesh(new THREE.BoxGeometry(0.36,0.12,0.12),steel); head.position.set(0.3,0.78,0.2); c.add(head);
    c.position.set(i-HALF,h,j-HALF); scene.add(c); } }

/* ========================================================================
   WORLD SET PIECES — each isle's signature landmark, built deterministically
   ======================================================================== */
let lavaMat=null,emberMesh=null; const embers=[];
if(worldKey==='volcano'&&CRATER){
  const cx=CRATER.i-HALF, cz=CRATER.j-HALF, fy=CRATER.floor;
  // the lava lake: a fat emissive slab pulsing in the crater, plus a drifting crust plate
  lavaMat=new THREE.MeshLambertMaterial({color:0xff7a1a,emissive:0xff5200,emissiveIntensity:0.95});
  const lava=new THREE.Mesh(new THREE.BoxGeometry(4.6,0.5,4.6),lavaMat);
  lava.position.set(cx,fy+0.35,cz); scene.add(lava);
  const crust=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.56,1.1),new THREE.MeshLambertMaterial({color:0x2a2220}));
  crust.position.set(cx+rand(-0.7,0.7),fy+0.4,cz+rand(-0.7,0.7)); crust.rotation.y=rand(0,TAU); scene.add(crust);
  const glow=new THREE.PointLight(0xff6a20,1.5,28,2); glow.position.set(cx,fy+3.5,cz); scene.add(glow);
  // embers riding the thermals out of the crater (animated in the main loop)
  emberMesh=new THREE.InstancedMesh(boxGeo,
    new THREE.MeshLambertMaterial({color:0xff9a3a,emissive:0xff7a20,emissiveIntensity:1}),36);
  emberMesh.frustumCulled=false; emberMesh.castShadow=false; scene.add(emberMesh);
  for(let k=0;k<36;k++)embers.push({x:cx+rand(-1.8,1.8),z:cz+rand(-1.8,1.8),y:fy+rand(0,7),v:rand(0.7,1.7),ph:rand(0,TAU),s:rand(0.06,0.13)});
  // jagged obsidian shards crowning the rim
  const obsM=new THREE.MeshLambertMaterial({color:0x17141a});
  for(let k=0;k<9;k++){ const a=k/9*TAU+rand(-0.2,0.2);
    const sh=new THREE.Mesh(new THREE.BoxGeometry(rand(0.2,0.36),rand(0.6,1.4),rand(0.2,0.36)),obsM);
    sh.position.set(cx+Math.cos(a)*2.7,CRATER.rim+0.45,cz+Math.sin(a)*2.7);
    sh.rotation.set(rand(-0.25,0.25),a,rand(-0.25,0.25)); sh.castShadow=true; scene.add(sh); }
  // a couple of steaming surface vents on the lower slopes
  for(let k=0;k<3;k++){ const a=rand(0,TAU),r2=rand(5,8);
    const vi=Math.round(CRATER.i+Math.cos(a)*r2), vj=Math.round(CRATER.j+Math.sin(a)*r2);
    if(vi<1||vj<1||vi>=N-1||vj>=N-1)continue;
    const vent=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.3,0.5),
      new THREE.MeshLambertMaterial({color:0x3a2a24,emissive:0xff5200,emissiveIntensity:0.45}));
    vent.position.set(vi-HALF,heightMap[vi][vj]+0.15,vj-HALF); scene.add(vent); lamps.push(vent); }
}
if(worldKey==='frost'){
  const bergM=new THREE.MeshLambertMaterial({color:0xeef8fd});
  const iceM=new THREE.MeshLambertMaterial({color:0xdff2fa,transparent:true,opacity:0.85});
  // icebergs drifting offshore
  let placed=0,guard=0;
  while(placed<6&&guard++<500){
    const i=2+((Math.random()*(N-4))|0), j=2+((Math.random()*(N-4))|0);
    if(heightMap[i][j]>1)continue; const d=Math.hypot(i-HALF,j-HALF); if(d<30||d>44)continue;
    const g=new THREE.Group(), s=rand(1.3,2.7);
    const a=new THREE.Mesh(new THREE.BoxGeometry(s,rand(0.9,1.8),s*rand(0.7,1)),bergM);
    a.position.y=WATER_TOP+0.25; a.castShadow=true; g.add(a);
    const b=new THREE.Mesh(new THREE.BoxGeometry(s*0.55,rand(0.8,1.7),s*0.5),bergM);
    b.position.set(rand(-0.4,0.4),WATER_TOP+1,rand(-0.3,0.3)); b.castShadow=true; g.add(b);
    g.position.set(i-HALF,0,j-HALF); g.rotation.y=rand(0,TAU); scene.add(g); placed++; }
  // thin ice floes hugging the shoreline
  placed=0; guard=0;
  while(placed<12&&guard++<700){
    const i=2+((Math.random()*(N-4))|0), j=2+((Math.random()*(N-4))|0);
    if(heightMap[i][j]>2)continue;
    let shore=false; for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1]]) if(heightMap[i+di][j+dj]>=3)shore=true;
    if(!shore)continue;
    const f=new THREE.Mesh(new THREE.BoxGeometry(rand(1.1,1.9),0.14,rand(1.1,1.9)),iceM);
    f.position.set(i-HALF+rand(-0.2,0.2),WATER_TOP+0.08,j-HALF+rand(-0.2,0.2));
    f.rotation.y=rand(0,TAU); scene.add(f); placed++; }
  // a snowman greeting new arrivals near the spawn gate
  { let si=-1,sj=-1;
    for(const [i,j,h] of grassCells){ const d=Math.hypot(i-spawnCell[0],j-spawnCell[1]);
      if(d>3&&d<8&&decorOK(i,j,1.6)){ si=i; sj=j; break; } }
    if(si>=0){ decorUsed.add(keyOf(si,sj));
      const g=new THREE.Group(), sm=new THREE.MeshLambertMaterial({color:0xf7fcff});
      const b1=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.8,0.9),sm); b1.position.y=0.4;
      const b2=new THREE.Mesh(new THREE.BoxGeometry(0.68,0.62,0.68),sm); b2.position.y=1.08;
      const b3=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.48,0.5),sm); b3.position.y=1.62;
      const nose=new THREE.Mesh(new THREE.BoxGeometry(0.36,0.09,0.09),new THREE.MeshLambertMaterial({color:0xff8c3d})); nose.position.set(0.4,1.64,0);
      const eM=new THREE.MeshLambertMaterial({color:0x22262a});
      const e1=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,0.08),eM); e1.position.set(0.26,1.74,0.13);
      const e2=e1.clone(); e2.position.z=-0.13;
      const arm=texturedBox(0.06,0.72,0.06,TEX.bark); arm.position.set(0,1.15,0.52); arm.rotation.x=1.1;
      const arm2=texturedBox(0.06,0.72,0.06,TEX.bark); arm2.position.set(0,1.15,-0.52); arm2.rotation.x=-1.1;
      [b1,b2,b3].forEach(m=>m.castShadow=true);
      g.add(b1,b2,b3,nose,e1,e2,arm,arm2);
      g.position.set(si-HALF,heightMap[si][sj],sj-HALF); g.rotation.y=rand(0,TAU); scene.add(g); } }
  // glowing ice crystal spikes up on the stone
  { const cryM=new THREE.MeshLambertMaterial({color:0x9fe4f5,emissive:0x2a7f96,emissiveIntensity:0.35,transparent:true,opacity:0.9});
    let n2=0,g2=0;
    while(n2<10&&g2++<500){ const i=2+((Math.random()*(N-4))|0), j=2+((Math.random()*(N-4))|0);
      const h=heightMap[i][j]; if(h<WORLD.stoneH||!decorOK(i,j,2))continue; decorUsed.add(keyOf(i,j));
      const spike=new THREE.Mesh(new THREE.BoxGeometry(rand(0.18,0.3),rand(0.8,1.7),rand(0.18,0.3)),cryM);
      spike.position.set(i-HALF,h+0.5,j-HALF);
      spike.rotation.set(rand(-0.2,0.2),rand(0,TAU),rand(-0.2,0.2)); spike.castShadow=true; scene.add(spike); n2++; } }
}

// world construction finished — hand randomness back for gameplay rolls
Math.random=REAL_RANDOM;
// stable ids let the server say "node 17 is depleted" and every client agree which one
oreNodes.forEach((n,i)=>{n.id=i;});
treeData.forEach((t,i)=>{t.id=i;});

/* ========================================================================
   7. PLAYER + BOBBER
   ======================================================================== */
const player=makeHero();
player.rotation.order='YXZ'; // yaw first, so body lean (rotation.x) always tips along the facing direction
const pWorld={x:spawnCell[0]-HALF,z:spawnCell[1]-HALF,y:spawnCell[2],face:0,step:0};
player.position.set(pWorld.x,pWorld.y,pWorld.z); scene.add(player);

const bobber=new THREE.Group();
const bTop=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.2,0.28),new THREE.MeshLambertMaterial({color:0xff5d7a})); bTop.position.y=0.16;
const bBot=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.16,0.28),new THREE.MeshLambertMaterial({color:0xf2f2f2}));
bobber.add(bTop,bBot); bobber.visible=false; scene.add(bobber);
// tools held in the right hand (parented to the arm so they swing with it)
// chunky voxel props — big enough to read clearly from the iso camera
const armR=player.userData.armR;
const rodMesh=new THREE.Group();
// group origin = the fist. Parts sit so the hand lands ON the red grip with a
// short butt below it — not halfway up the blank like it used to.
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.11,1.5,0.11),new THREE.MeshLambertMaterial({map:TEX.bark}));
  h2.position.y=0.5;                       // blank: butt -0.25, tip +1.25
  const grip=new THREE.Mesh(new THREE.BoxGeometry(0.15,0.28,0.15),new THREE.MeshLambertMaterial({color:0xd8483f}));
  grip.position.y=-0.05;                   // right in the palm
  const reel=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.16,0.1),new THREE.MeshLambertMaterial({color:0xffd24f}));
  reel.position.set(0,0.18,0.12);          // reel seats just above the gripping hand
  rodMesh.add(h2,grip,reel); rodMesh.position.set(0,-0.5,0.34); rodMesh.rotation.x=-0.7;
  rodMesh.userData.tip=new THREE.Vector3(0,1.25,0); // top of the blank, for the fishing line
  rodMesh.traverse(m=>{m.castShadow=true;}); rodMesh.visible=false; armR.add(rodMesh); }
const pickMesh=new THREE.Group();
// group origin = the fist, gripping just above the butt of the haft: ~0.15 of
// wood below the hand, the head at the far end where it belongs.
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.12,1.15,0.12),new THREE.MeshLambertMaterial({map:TEX.bark}));
  h2.position.y=0.42;                      // haft: butt -0.155, top +0.995
  const hd=new THREE.Mesh(new THREE.BoxGeometry(0.85,0.16,0.16),new THREE.MeshLambertMaterial({color:0xb8c2cc}));
  hd.position.y=0.92;
  const tipL=new THREE.Mesh(new THREE.BoxGeometry(0.18,0.14,0.14),new THREE.MeshLambertMaterial({color:0x8a949e}));
  tipL.position.set(-0.5,0.86,0);
  const tipR=tipL.clone(); tipR.position.x=0.5;
  const bind=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.2,0.16),new THREE.MeshLambertMaterial({color:0x6d4a28}));
  bind.position.y=0.84;
  pickMesh.add(h2,hd,tipL,tipR,bind); pickMesh.position.set(0,-0.42,0.3); pickMesh.rotation.x=-0.65;
  pickMesh.rotation.y=Math.PI/2; // spikes fore/aft so the point leads the swing, not the flat of the head
  pickMesh.traverse(m=>{m.castShadow=true;}); pickMesh.visible=false; armR.add(pickMesh); }
const axeMesh=new THREE.Group();
// group origin = the fist, just above the butt of the handle — same grip as the pick.
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.12,1.05,0.12),new THREE.MeshLambertMaterial({map:TEX.bark}));
  h2.position.y=0.38;                      // handle: butt -0.145, top +0.905
  const bl=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.46,0.12),new THREE.MeshLambertMaterial({color:0xcfd8de}));
  bl.position.set(0.24,0.76,0);
  const edge=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.5,0.13),new THREE.MeshLambertMaterial({color:0xf0f5f8}));
  edge.position.set(0.42,0.76,0);
  const bind=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.2,0.16),new THREE.MeshLambertMaterial({color:0x6d4a28}));
  bind.position.y=0.72;
  axeMesh.add(h2,bl,edge,bind); axeMesh.position.set(0,-0.42,0.3); axeMesh.rotation.x=-0.65;
  axeMesh.rotation.y=-Math.PI/2; // blade forward: the cutting edge faces the tree, not the player's right
  axeMesh.traverse(m=>{m.castShadow=true;}); axeMesh.visible=false; armR.add(axeMesh); }
const shovelMesh=new THREE.Group();
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.11,1.1,0.11),new THREE.MeshLambertMaterial({map:TEX.bark}));
  const grip=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.1,0.12),new THREE.MeshLambertMaterial({map:TEX.bark}));
  grip.position.y=0.56;
  const blade=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.4,0.09),new THREE.MeshLambertMaterial({color:0xb8c2cc}));
  blade.position.set(0,-0.62,0);
  const edge=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.09,0.1),new THREE.MeshLambertMaterial({color:0xf0f5f8}));
  edge.position.set(0,-0.84,0);
  shovelMesh.add(h2,grip,blade,edge); shovelMesh.position.set(0,-0.42,0.3); shovelMesh.rotation.x=-0.65;
  shovelMesh.traverse(m=>{m.castShadow=true;}); shovelMesh.visible=false; armR.add(shovelMesh); }
const lineGeo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
const fishLine=new THREE.Line(lineGeo,new THREE.LineBasicMaterial({color:0xeeeeee,transparent:true,opacity:0.65}));
fishLine.frustumCulled=false; fishLine.visible=false; scene.add(fishLine);
const rodTip=new THREE.Vector3();
function updateFishLine(){
  fishLine.visible=bobber.visible;
  if(!fishLine.visible)return;
  rodTip.copy(rodMesh.userData.tip); rodMesh.localToWorld(rodTip); // follows the cast animation too
  const pos=lineGeo.attributes.position;
  pos.setXYZ(0,rodTip.x,rodTip.y,rodTip.z);
  pos.setXYZ(1,bobber.position.x,bobber.position.y+0.25,bobber.position.z);
  pos.needsUpdate=true; }

/* ========================================================================
   7b. VOXEL FX — particle pool, screen shake, hit-stop
   ======================================================================== */
const FXN=256;
const fxMesh=new THREE.InstancedMesh(boxGeo,new THREE.MeshLambertMaterial({color:0xffffff}),FXN);
fxMesh.frustumCulled=false; fxMesh.castShadow=false; fxMesh.receiveShadow=false; scene.add(fxMesh);
const fxCol=new THREE.Color();
const fxP=[]; for(let k=0;k<FXN;k++)fxP.push({life:0,ttl:1,x:0,y:-99,z:0,vx:0,vy:0,vz:0,s:0.1,col:0xffffff,grav:9});
let fxCursor=0;
function fxBurst(x,y,z,o){ o=o||{}; const n=o.n||10,cols=o.cols||[o.col||0xffffff];
  for(let k=0;k<n;k++){ const p=fxP[fxCursor]; fxCursor=(fxCursor+1)%FXN;
    const a=rand(0,TAU),sp=rand(0.4,1)*(o.speed||3);
    p.x=x;p.y=y;p.z=z; p.vx=Math.cos(a)*sp; p.vz=Math.sin(a)*sp; p.vy=rand(0.5,1)*(o.up==null?3.4:o.up);
    p.life=p.ttl=rand(0.35,0.75)*(o.ttl||1); p.s=rand(0.06,0.16)*(o.size||1);
    p.col=cols[(Math.random()*cols.length)|0]; p.grav=o.grav!=null?o.grav:9; }
  fxDirty=true; }
let fxDirty=true; // skip the whole pool pass once everything is dead and hidden
function fxUpdate(dt){
  let any=false;
  for(let k=0;k<FXN;k++)if(fxP[k].life>0){any=true;break;}
  if(!any&&!fxDirty)return;
  for(let k=0;k<FXN;k++){ const p=fxP[k];
    if(p.life>0){ p.life-=dt; p.vy-=p.grav*dt; p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;
      const s=Math.max(0.0001,p.s*Math.max(0,p.life/p.ttl));
      dummy.position.set(p.x,p.y,p.z); dummy.scale.set(s,s,s); dummy.rotation.set(p.life*7,p.life*9,0); }
    else { dummy.position.set(0,-99,0); dummy.scale.set(0.0001,0.0001,0.0001); dummy.rotation.set(0,0,0); }
    dummy.updateMatrix(); fxMesh.setMatrixAt(k,dummy.matrix); fxMesh.setColorAt(k,fxCol.setHex(p.col)); }
  fxMesh.instanceMatrix.needsUpdate=true; if(fxMesh.instanceColor)fxMesh.instanceColor.needsUpdate=true;
  fxDirty=any; }
let trauma=0,freezeT=0;
function addShake(a){trauma=Math.min(1,trauma+a);}
function addFreeze(t){freezeT=Math.max(freezeT,t);}
// DOM coin fly: little gems arcing to the coin counter
function coinFly(n){ const hud=document.getElementById('hud-coins'); if(!hud||!hud.getBoundingClientRect)return;
  const r=hud.getBoundingClientRect(), cx=window.innerWidth/2, cy=window.innerHeight*0.62;
  const count=clamp(Math.round(2+Math.log2(1+n/20)),3,9);
  for(let k=0;k<count;k++){ const el=document.createElement('div'); el.className='coinfly'; el.textContent='◈';
    el.style.left=(cx+rand(-70,70))+'px'; el.style.top=(cy+rand(-30,30))+'px';
    document.body.appendChild(el);
    setTimeout(()=>{ el.style.left=(r.left+r.width/2)+'px'; el.style.top=(r.top+r.height/2)+'px'; el.style.opacity='0'; el.style.transform='scale(0.5)'; },20+k*55);
    setTimeout(()=>el.remove(),900+k*55); } }

/* ========================================================================
   8. INPUT / AUDIO / HUD / MINIMAP / TOAST / REVEAL
   ======================================================================== */
const keys={}; let actEdge=false;
const KMAP={KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',KeyE:'act',Space:'act'};
addEventListener('keydown',e=>{
  if(RF.claim('keydown',e))return;
  // let Space/Enter activate focused buttons instead of hijacking them
  const tag=e.target&&e.target.tagName;
  const onUI=tag==='BUTTON'||tag==='INPUT'||(e.target&&e.target.closest&&e.target.closest('[role="button"]'));
  if(onUI&&(e.code==='Space'||e.code==='Enter'))return;
  const m=KMAP[e.code]; if(m){e.preventDefault(); if(!keys[m]&&m==='act')actEdge=true; keys[m]=true;}
  if(e.code==='KeyI'||e.code==='Tab'){ e.preventDefault(); if(invOpen)closeInv(); else if(running)openInv(); }
  if(e.code==='KeyT'&&running&&!chatOpen&&!marketOpen&&!casinoOpen&&!invOpen){ e.preventDefault(); openChat(); }
  if(e.code>='Digit1'&&e.code<='Digit8'&&running&&capCam&&!chatOpen){ e.preventDefault(); playBarEmote(+e.code.slice(5)-1); return; }
  if(e.code>='Digit1'&&e.code<='Digit5'&&running&&!marketOpen&&!casinoOpen&&!harborOpen){ setHotSlot(+e.code.slice(5)-1); }
  if(e.code==='KeyF'&&running&&!chatOpen&&!marketOpen&&!casinoOpen&&!invOpen&&!harborOpen){ e.preventDefault(); toggleAuto(); }
  if(e.code==='KeyP'&&running){ e.preventDefault(); togglePhoto(); }
  if(e.code==='KeyC'&&running&&!chatOpen&&!marketOpen&&!casinoOpen&&!invOpen&&!harborOpen){ e.preventDefault(); toggleCam(); }
  if(e.code==='Escape'){ if(marketOpen)closeMarket(); else if(casinoOpen)closeCasino(); else if(harborOpen)closeHarbor(); else if(invOpen)closeInv(); else if(capCam)closeCam(); else if(autoFish.on)setAuto(false,'Auto-fishing off'); else if(fishing.state!=='idle')cancelFish(); else if(mining.node)cancelMine(); else if(chopping.tree)cancelChop(); else if(digging.active){digging.active=false;hint('');} }},{passive:false});
addEventListener('keyup',e=>{RF.emit('keyup',e);const m=KMAP[e.code]; if(m)keys[m]=false;});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;});

let AC=null,muted=false;
function initAudio(){if(AC)return;try{AC=new (window.AudioContext||window.webkitAudioContext)();}catch(e){}}
function beep(f,d,t,v){if(!AC||muted)return;const o=AC.createOscillator(),g=AC.createGain();o.type=t||'sine';o.frequency.value=f;
  g.gain.value=.0001;o.connect(g);g.connect(AC.destination);const n=AC.currentTime;
  g.gain.exponentialRampToValueAtTime(v||.05,n+.01);g.gain.exponentialRampToValueAtTime(.0001,n+d);o.start(n);o.stop(n+d+.02);}
/* white noise, built once and cached: footsteps, splashes, tool impacts and
   thunder all need a filtered burst, and oscillators alone can't make one */
let NBUF=null;
function noiseBuf(){ if(!NBUF){ const n=(AC.sampleRate*0.7)|0; NBUF=AC.createBuffer(1,n,AC.sampleRate);
    const d=NBUF.getChannelData(0); for(let i=0;i<n;i++)d[i]=Math.random()*2-1; } return NBUF; }
function nz(dur,cut,vol,o){ if(!AC||muted)return; o=o||{}; const n=AC.currentTime;
  const src=AC.createBufferSource(); src.buffer=noiseBuf(); src.loop=true;
  const f=AC.createBiquadFilter(); f.type=o.type||'lowpass'; f.Q.value=o.q||1;
  f.frequency.setValueAtTime(cut,n); if(o.to)f.frequency.exponentialRampToValueAtTime(o.to,n+dur);
  const g=AC.createGain(); g.gain.setValueAtTime(.0001,n);
  g.gain.exponentialRampToValueAtTime(vol,n+(o.atk||.008));
  g.gain.exponentialRampToValueAtTime(.0001,n+dur);
  src.connect(f); f.connect(g); g.connect(AC.destination); src.start(n); src.stop(n+dur+.03); }
function sweep(f0,f1,d,t,v){ if(!AC||muted)return; const o=AC.createOscillator(),g=AC.createGain(),n=AC.currentTime;
  o.type=t||'sine'; o.frequency.setValueAtTime(f0,n); o.frequency.exponentialRampToValueAtTime(f1,n+d);
  g.gain.setValueAtTime(.0001,n); g.gain.exponentialRampToValueAtTime(v,n+.02);
  g.gain.exponentialRampToValueAtTime(.0001,n+d); o.connect(g); g.connect(AC.destination); o.start(n); o.stop(n+d+.03); }
// footfalls read the ground: soft on grass, gritty on sand, hard on stone, crunchy on snow
const STEPFX={grass:{d:.07,f:2200,t:900,v:.035,q:.9},sand:{d:.08,f:1500,t:600,v:.032,q:.7},
  stone:{d:.055,f:1000,t:380,v:.042,q:1.6},snow:{d:.09,f:3200,t:1400,v:.03,q:.8},
  seabed:{d:.16,f:800,t:240,v:.05,q:.7}};
const sfx={cast:()=>beep(300,.15,'sine',.05),bite:()=>{beep(880,.08,'square',.06);setTimeout(()=>beep(1100,.08,'square',.06),90);},
  reel:()=>beep(200+Math.random()*80,.05,'sawtooth',.03),catch:()=>{beep(523,.1,'triangle',.06);setTimeout(()=>beep(784,.14,'triangle',.06),90);},
  miss:()=>beep(160,.2,'sawtooth',.05),sell:()=>{beep(660,.08,'sine',.06);setTimeout(()=>beep(990,.1,'sine',.06),70);},
  spin:(f)=>beep(f||120,.05,'square',.02),
  sparkle:()=>beep(1500+Math.random()*600,.06,'triangle',.025),
  // a rising arpeggio that lands on a held chord — bright, and over inside a second
  win:()=>{[523,659,784,1046].forEach((f,i)=>setTimeout(()=>{beep(f,.14,'triangle',.06);beep(f*2,.07,'sine',.02);},i*70));
    setTimeout(()=>{beep(784,.42,'triangle',.05);beep(1046,.42,'triangle',.04);beep(1318,.42,'sine',.03);},300);},
  // green pays 14× — it earns a fanfare a bar longer than an ordinary win
  jackpot:()=>{[523,659,784,1046,1318].forEach((f,i)=>setTimeout(()=>{beep(f,.13,'square',.05);beep(f*2,.09,'triangle',.025);},i*62));
    setTimeout(()=>{[1046,1318,1568].forEach((f,i)=>setTimeout(()=>beep(f,.55,'triangle',.05),i*55));},340);
    setTimeout(()=>{for(let i=0;i<5;i++)setTimeout(()=>beep(1760+Math.random()*900,.07,'triangle',.028),i*95);},430);},
  lose:()=>{beep(200,.3,'sawtooth',.07);setTimeout(()=>beep(130,.4,'sawtooth',.07),160);},
  pick:()=>beep(340+Math.random()*120,.05,'square',.04),
  ore:()=>{beep(620,.09,'triangle',.06);setTimeout(()=>beep(930,.12,'triangle',.06),80);},
  /* ---- one sound per action: movement, tools, UI, world events ---- */
  step:k=>{ const S=STEPFX[k]||STEPFX.grass; nz(S.d,S.f,S.v,{type:'bandpass',q:S.q,to:S.t}); },
  splash:v=>{ nz(.26,900,v||.07,{type:'lowpass',q:.7,to:220}); beep(430,.09,'sine',.03); },
  chop:()=>{ nz(.09,1600,.09,{type:'bandpass',q:1.6,to:500}); beep(180+Math.random()*40,.07,'square',.05); },
  dig:()=>{ nz(.13,700,.08,{type:'lowpass',q:.8,to:180}); beep(115,.08,'sine',.05); },
  creak:()=>nz(.3,260,.05,{type:'bandpass',q:6,to:520}),        // the line groans before it snaps
  open:()=>{beep(430,.07,'sine',.045);setTimeout(()=>beep(660,.09,'sine',.04),55);},
  close:()=>{beep(520,.07,'sine',.04);setTimeout(()=>beep(330,.1,'sine',.035),55);},
  click:()=>beep(720,.035,'square',.03),
  tab:()=>beep(880,.04,'triangle',.03),
  deny:()=>{beep(190,.09,'square',.05);setTimeout(()=>beep(140,.13,'square',.045),80);},
  emote:()=>{beep(660,.05,'triangle',.04);setTimeout(()=>beep(990,.07,'triangle',.035),60);},
  shutter:()=>{ nz(.04,3000,.07,{type:'bandpass',q:2}); setTimeout(()=>nz(.06,1800,.05,{type:'bandpass',q:2}),70); },
  chat:()=>{beep(1046,.05,'sine',.035);setTimeout(()=>beep(1318,.06,'sine',.03),55);},
  bait:()=>{ nz(.12,1200,.05,{type:'bandpass',q:1.2,to:600}); beep(500,.06,'triangle',.035); },
  pearl:()=>{beep(1318,.07,'sine',.035);setTimeout(()=>beep(1760,.1,'sine',.03),70);},
  craft:()=>{ beep(392,.09,'square',.05); setTimeout(()=>beep(523,.09,'square',.05),90);
    setTimeout(()=>{beep(659,.22,'triangle',.055);beep(1318,.16,'sine',.02);},180); },
  ach:()=>{ [659,880,1046,1318].forEach((f,i)=>setTimeout(()=>{beep(f,.16,'triangle',.055);beep(f*2,.08,'sine',.018);},i*90)); },
  sail:()=>{ sweep(200,900,.5,'sine',.05); nz(.8,500,.08,{type:'lowpass',to:1500,atk:.25}); },
  door:()=>{ nz(.7,420,.1,{type:'lowpass',q:.9,to:120,atk:.06}); beep(70,.5,'sawtooth',.05); },
  thunder:()=>{ nz(1.6,300,.16,{type:'lowpass',q:.6,to:60,atk:.02}); setTimeout(()=>nz(1.1,180,.1,{type:'lowpass',to:40}),240); },
  rumble:()=>nz(1.1,200,.07,{type:'lowpass',q:.6,to:50,atk:.05}), // a flash on the horizon, not the strike overhead
  gust:()=>nz(1.8,700,.07,{type:'bandpass',q:.5,to:1600,atk:.5}),
  meteor:()=>sweep(1800,300,2.2,'sawtooth',.035),
  boom:()=>{ nz(1.2,220,.18,{type:'lowpass',q:.7,to:45}); beep(48,.5,'sawtooth',.09); },
  pet:()=>{beep(1046,.05,'triangle',.035);setTimeout(()=>beep(1568,.07,'triangle',.03),55);},
  spinUp:()=>sweep(140,520,.6,'sawtooth',.04),
  // a rare catch announces itself — the arpeggio climbs with the rarity, shinies shimmer on top
  rare:(r,shiny)=>{ const n=RORDER[r]||0; if(n<2&&!shiny)return;
    [[784,988,1175],[880,1109,1318,1568],[1046,1318,1568,2093]][Math.max(0,Math.min(2,n-2))]
      .forEach((f,i)=>setTimeout(()=>beep(f,.18,'triangle',.045),i*80));
    if(shiny)setTimeout(()=>{for(let i=0;i<4;i++)setTimeout(()=>beep(2093+Math.random()*900,.06,'sine',.02),i*70);},120); }};
document.getElementById('mute').onclick=()=>{muted=!muted;const b=document.getElementById('mute');b.textContent=muted?'♪ MUTED':'♪ SOUND';b.style.color=muted?'var(--faint)':'';
  if(musMaster)musMaster.gain.value=muted?0:MUS_VOL;};

/* ---- one track per isle — chiptune + ambience, pure WebAudio, no assets ----
   Travel reloads the page, so the world's entry is chosen once in startMusic()
   and nothing ever has to crossfade.
   step  = seconds per 16th · bass/lead = 16-step patterns, 0 = rest
   lift  = per-bar transpose of the lead · hush = the step the lead drops out at
   tick  = the percussive blip · amb = the noise bed · drone = the sub underneath */
const MUS_VOL=0.14;
let musMaster=null,musStep=0,musNext=0,MUS=null;
const MUSIC={
  // Fortune Isle — the original: bright major chiptune over rolling surf
  isle:{step:0.24,bars:4,
    bass:[131,0,98,0, 87,0,98,0, 131,0,98,0, 117,0,98,131],bassType:'triangle',bassVol:0.45,bassDur:1,
    lead:[523,0,659,784, 0,659,0,523, 587,0,698,880, 784,0,698,0],leadType:'square',leadVol:0.18,leadDur:0.83,
    lift:[1,1,1.5,1],hush:[16,16,16,12],                       // bar 3 lifts a fifth, bar 4 breathes
    tick:{f:1760,every:4,at:2,type:'square',vol:0.06,dur:0.05},
    amb:{cut:420,gain:0.28,lfo:0.11,wob:0.14}},
  // The Great Mine — a plodding work song in A minor, pickaxe on the offbeat
  mine:{step:0.27,bars:4,
    bass:[110,0,110,0, 82,0,110,0, 98,0,98,0, 110,0,82,98],bassType:'square',bassVol:0.30,bassDur:1,
    lead:[440,0,523,0, 587,0,523,0, 440,0,392,440, 523,0,440,0],leadType:'triangle',leadVol:0.20,leadDur:0.9,
    lift:[1,1,1,0.5],hush:[16,16,16,14],                       // the last bar drops an octave and leans on the shovel
    tick:{f:349,every:8,at:4,type:'square',vol:0.05,dur:0.07},
    amb:{cut:300,gain:0.22,lfo:0.07,wob:0.1}},
  // Cinder Atoll — fast, Phrygian, sawtooth: the isle is actively trying to kill you
  volcano:{step:0.20,bars:4,
    bass:[73,0,73,73, 78,0,73,0, 65,0,73,0, 78,73,65,73],bassType:'sawtooth',bassVol:0.32,bassDur:1,
    lead:[587,622,587,0, 466,0,523,587, 0,622,587,466, 440,0,466,0],leadType:'sawtooth',leadVol:0.11,leadDur:0.7,
    lift:[1,1,1,1.5],hush:[16,16,16,16],                       // relentless — the lead never rests
    tick:{f:1318,every:4,at:2,type:'square',vol:0.05,dur:0.04},
    drone:{f:44,gain:0.16},                                    // the crater breathing under everything
    amb:{cut:190,gain:0.30,lfo:0.06,wob:0.2}},
  // Frostbite Isle — slow, sparse, glassy: sine bells over thin wind
  frost:{step:0.32,bars:4,
    bass:[73,0,0,0, 0,0,110,0, 98,0,0,0, 0,0,82,0],bassType:'triangle',bassVol:0.34,bassDur:2.6,
    lead:[1174,0,0,880, 0,0,1046,0, 0,1174,0,0, 987,0,880,0],leadType:'sine',leadVol:0.16,leadDur:2.2,
    lift:[1,1,0.5,1],hush:[16,16,16,16],
    tick:{f:2637,every:8,at:6,type:'sine',vol:0.03,dur:0.12},
    amb:{cut:1100,gain:0.16,lfo:0.05,wob:0.14}},
  // The Undermine — near silence with a heartbeat, a far-off echo and one dripping note a bar
  cave:{step:0.30,bars:4,
    bass:[65,0,0,0, 65,0,0,0, 58,0,0,0, 62,0,0,65],bassType:'sine',bassVol:0.50,bassDur:3,
    lead:[0,0,392,0, 0,466,0,0, 523,0,0,392, 0,0,349,0],leadType:'triangle',leadVol:0.15,leadDur:1.6,
    lift:[1,1,2,1],hush:[16,16,16,12],                         // bar 3 answers itself an octave up
    tick:{f:1568,every:16,at:11,type:'sine',vol:0.04,dur:0.08},
    drone:{f:41,gain:0.12},
    amb:{cut:250,gain:0.20,lfo:0.04,wob:0.16}}};
function musNote(t,f,dur,type,vol){ if(!f)return; const o=AC.createOscillator(),g=AC.createGain();
  o.type=type; o.frequency.value=f; g.gain.value=0.0001; o.connect(g); g.connect(musMaster);
  g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(vol,t+0.02);
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur); o.start(t); o.stop(t+dur+0.05); }
function schedMusic(){ if(!AC||!musMaster||!MUS)return; const M=MUS;
  while(musNext<AC.currentTime+0.35){ const s=musStep%16, bar=(musStep>>4)%M.bars;
    musNote(musNext,M.bass[s],M.step*M.bassDur,M.bassType,M.bassVol);
    if(s<M.hush[bar]) musNote(musNext,M.lead[s]*M.lift[bar],M.step*M.leadDur,M.leadType,M.leadVol);
    const t=M.tick; if(t&&s%t.every===t.at%t.every) musNote(musNext,t.f,t.dur,t.type,t.vol);
    musNext+=M.step; musStep++; } }
function startMusic(){ if(!AC||musMaster)return;
  MUS=MUSIC[worldKey]||MUSIC.isle;
  musMaster=AC.createGain(); musMaster.gain.value=muted?0:MUS_VOL; musMaster.connect(AC.destination);
  // ambience bed: looped noise through a slowly wobbling lowpass — surf on the isles,
  // a dull roar in the crater, thin wind on the ice, dripping stillness underground
  const A=MUS.amb, len=(2*AC.sampleRate)|0, buf=AC.createBuffer(1,len,AC.sampleRate), d=buf.getChannelData(0);
  for(let i=0;i<len;i++)d[i]=Math.random()*2-1;
  const noise=AC.createBufferSource(); noise.buffer=buf; noise.loop=true;
  const lp=AC.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=A.cut; lp.Q.value=0.5;
  const ng=AC.createGain(); ng.gain.value=A.gain;
  const lfo=AC.createOscillator(); lfo.frequency.value=A.lfo; const lg=AC.createGain(); lg.gain.value=A.wob;
  lfo.connect(lg); lg.connect(ng.gain); noise.connect(lp); lp.connect(ng); ng.connect(musMaster);
  noise.start(); lfo.start();
  if(MUS.drone){ const dr=AC.createOscillator(); dr.type='sawtooth'; dr.frequency.value=MUS.drone.f;
    const dlp=AC.createBiquadFilter(); dlp.type='lowpass'; dlp.frequency.value=110;
    const dg=AC.createGain(); dg.gain.value=MUS.drone.gain;
    dr.connect(dlp); dlp.connect(dg); dg.connect(musMaster); dr.start(); }
  musNext=AC.currentTime+0.15; musStep=0; setInterval(schedMusic,110); }

const RAR={common:'#b9c6c4',uncommon:'#74e08a',rare:'#57b7ff',epic:'#c07bff',legendary:'#ffc24b'};

/* ---- pixel-art icon set — hand-drawn 12×12 grids rendered as crisp SVG (no emoji) ---- */
const PIX={
rod:{p:{c:'#e8f4f2',w:'#a06a33',h:'#6b421f',l:'#bfe8e2',r:'#ff5d7a',W:'#f2f2f2'},g:[
'............',
'.........c..',
'........cc..',
'.......ww.l.',
'......ww..l.',
'.....ww...l.',
'....ww....l.',
'...ww.....l.',
'..hh.....rr.',
'.hh......WW.',
'hh..........',
'............']},
chart:{p:{g:'#74e08a',r:'#ff5d7a',w:'#e8f4f2'},g:[
'............',
'.w..........',
'.w........g.',
'.w.......gg.',
'.w..g....gg.',
'.w.ggg..ggg.',
'.w.ggg.gggg.',
'.wgggg.gggg.',
'.wggggggggg.',
'.w.rr.......',
'.wwwwwwwwww.',
'............']},
pick:{p:{s:'#cfd8d6',S:'#8a97a0',h:'#8a5a2c'},g:[
'....ssssss..',
'..sssSSSSss.',
'.ss......ss.',
'.s....h..ss.',
'......hh..s.',
'.....hh...s.',
'....hh......',
'...hh.......',
'..hh........',
'.hh.........',
'hh..........',
'............']},
axe:{p:{s:'#cfd8d6',S:'#8a97a0',h:'#8a5a2c'},g:[
'............',
'....ssss....',
'...sSSsss...',
'...sshhss...',
'....hh......',
'...hh.......',
'..hh........',
'.hh.........',
'............',
'............',
'............',
'............']},
bucket:{p:{h:'#9fb2ba',m:'#c4d2d8',b:'#7e929c',w:'#2fd3bd',W:'#c8fff4'},g:[
'...hhhhhh...',
'..h......h..',
'.h........h.',
'.mmmmmmmmmm.',
'.mwwwwWwwwm.',
'.mbbbbbbbbm.',
'.mbbbbbbbbm.',
'..mbbbbbbm..',
'..mbbbbbbm..',
'...mbbbbm...',
'...mmmmmm...',
'............']},
gem:{p:{d:'#2ba898',D:'#5ee8e2',L:'#d8fffb'},g:[
'............',
'............',
'..dddddddd..',
'.dLLDDDDDDd.',
'.dDDDDDDDDd.',
'..dDDDDDDd..',
'...dDDDDd...',
'....dDDd....',
'.....dd.....',
'............',
'............',
'............']},
fish:{p:{b:'#57b7ff',t:'#2f86c9',E:'#0e1a20'},g:[
'............',
'............',
'............',
'.....bbbb...',
'.t..bbbbbb..',
'.ttbbbbbEb..',
'.ttbbbbbbb..',
'.t..bbbbb...',
'.....bbb....',
'............',
'............',
'............']},
ore:{p:{s:'#7e8a92',M:'#5ee8e2'},g:[
'............',
'............',
'...ssssss...',
'..sMMssMMs..',
'.ssMMsssMMs.',
'.sssssMMsss.',
'.sMMsssssss.',
'..ssssMMss..',
'...ssssss...',
'............',
'............',
'............']},
wood:{p:{b:'#7d5530',r:'#d8b078',R:'#a87c46'},g:[
'............',
'............',
'............',
'..rrbbbbbb..',
'.rRRrbbbbbb.',
'.rRRrbbbbbb.',
'..rrbbbbbb..',
'............',
'............',
'............',
'............',
'............']},
wheel:{p:{O:'#c8a04a',g:'#63e58a',r:'#e04545',b:'#2a3138',h:'#ffcf5c'},g:[
'............',
'.....gg.....',
'...OOggOO...',
'..OrrggbbO..',
'.OrrrggbbbO.',
'.OrrrhhbbbO.',
'.ObbbhhrrrO.',
'.ObbbbrrrrO.',
'..ObbbrrrO..',
'...OOOOOO...',
'............',
'............']},
trophy:{p:{g:'#ffcf5c',G:'#c8963c',d:'#e0b04f'},g:[
'............',
'.dggggggggd.',
'.d.gggggg.d.',
'.dd.gggg.dd.',
'..d.gggg.d..',
'....gGGg....',
'.....GG.....',
'.....gg.....',
'....gggg....',
'..gggggggg..',
'............',
'............']},
boat:{p:{m:'#6b421f',s:'#f2ede2',h:'#8a5a2c'},g:[
'............',
'.....m......',
'.....mss....',
'..s..msss...',
'.ss..mssss..',
'sss..msss...',
'.....mss....',
'.....m......',
'.hhhhhhhhhh.',
'..hhhhhhhh..',
'...hhhhhh...',
'............']},
crew:{p:{h:'#e8c9a0',b:'#39d7c4',B:'#ffcf5c'},g:[
'............',
'..hh....hh..',
'..hh....hh..',
'............',
'.bbbb..BBBB.',
'bbbbbb.BBBBB',
'.bbbb..BBBB.',
'.bbbb..BBBB.',
'..b.b...B.B.',
'..b.b...B.B.',
'............',
'............']},
island:{p:{t:'#8a5a2c',L:'#74e08a',s:'#e8d8a8',w:'#4fc3e8'},g:[
'............',
'..LL..LL....',
'.LLLttLLL...',
'.L..tt..L...',
'....tt......',
'....tt......',
'....tt......',
'...sssss....',
'.sssssssss..',
'.ssssssssss.',
'wwwwwwwwwwww',
'............']},
lock:{p:{h:'#9fb2ba',g:'#ffcf5c',K:'#6b4a1f'},g:[
'............',
'....hhhh....',
'...h....h...',
'...h....h...',
'..gggggggg..',
'..gggggggg..',
'..gggKKggg..',
'..gggKKggg..',
'..gggKKggg..',
'..gggggggg..',
'............',
'............']},
sun:{p:{y:'#ffe08a',g:'#ffcf5c',G:'#ffdf7c'},g:[
'............',
'.....yy.....',
'.y........y.',
'...gggggg...',
'..gGGGGGGg..',
'yy.GGGGGG.yy',
'..gGGGGGGg..',
'...gggggg...',
'.y........y.',
'.....yy.....',
'............',
'............']},
moon:{p:{m:'#ffe9a8'},g:[
'............',
'....mmmm....',
'...mmmm.....',
'..mmmm......',
'..mmm.......',
'..mmm.......',
'..mmm.......',
'..mmmm......',
'...mmmm.....',
'....mmmmm...',
'............',
'............']},
dusk:{p:{o:'#f7906a',h:'#3a5a6a'},g:[
'............',
'............',
'............',
'.....oo.....',
'...oooooo...',
'..oooooooo..',
'.hhhhhhhhhh.',
'.hhhhhhhhhh.',
'............',
'............',
'............',
'............']},
rain:{p:{c:'#aebcc4',w:'#4fc3e8'},g:[
'............',
'...ccccc....',
'..cccccccc..',
'.cccccccccc.',
'.cccccccccc.',
'............',
'..w...w...w.',
'............',
'...w...w....',
'............',
'............',
'............']},
storm:{p:{c:'#8a97a0',y:'#ffd24f'},g:[
'............',
'...ccccc....',
'..cccccccc..',
'.cccccccccc.',
'.cccccccccc.',
'.....yy.....',
'....yy......',
'...yyyy.....',
'.....yy.....',
'....yy......',
'....y.......',
'............']},
map:{p:{p:'#a8895c',P:'#e8d8b0',d:'#8a6a3c',x:'#e04545'},g:[
'............',
'.pppppppppp.',
'.pPPPPPPPPp.',
'.pdPPPxPxPp.',
'.pPdPPPxPPp.',
'.pPPdPxPxPp.',
'.pPPdPPPPPp.',
'.pPPPddPPPp.',
'.pppppppppp.',
'............',
'............',
'............']}};
function pixSVG(name,size,ov){ const ic=PIX[name]; if(!ic)return'';
  const p=ov?Object.assign({},ic.p,ov):ic.p; let r='';
  for(let y=0;y<12;y++){ const row=ic.g[y]; let x=0;
    while(x<12){ const ch=row[x]; if(ch==='.'||!p[ch]){x++;continue;}
      let x2=x+1; while(x2<12&&row[x2]===ch)x2++;
      r+=`<rect x="${x}" y="${y}" width="${x2-x}" height="1" fill="${p[ch]}"/>`; x=x2; } }
  return `<svg class="pix" width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`; }
function shade(hex,f){ const n=parseInt(hex.slice(1),16);
  const r=((n>>16&255)*f)|0,g=((n>>8&255)*f)|0,b=((n&255)*f)|0;
  return '#'+((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1); }
const pixFish=(c,size)=>pixSVG('fish',size||16,{b:c,t:shade(c,0.62)});
const oreIcon=(k,size)=>k==='wood'?pixSVG('wood',size||14):pixSVG('ore',size||14,{M:ORE_INFO[k].dot});
// hydrate the static emoji placeholders in index.html
document.querySelectorAll('[data-pix]').forEach(el=>{ el.innerHTML=pixSVG(el.getAttribute('data-pix'),+el.getAttribute('data-pix-size')||24); });

const H={bn:document.querySelector('#hud-bucket .n'),bucket:document.getElementById('hud-bucket'),coins:document.getElementById('coinVal'),
  area:document.getElementById('area'),hint:document.getElementById('hint'),
  oreW:document.getElementById('oreW'),oreC:document.getElementById('oreC'),oreI:document.getElementById('oreI'),oreG:document.getElementById('oreG'),oreD:document.getElementById('oreD')};
const fmt=n=>Math.round(n).toLocaleString('en-US');
function updateHUD(){H.bn.textContent=state.bucket.length+'/'+cap();H.bucket.classList.toggle('full',state.bucket.length>=cap());H.coins.textContent=fmt(state.coins);
  H.oreW.textContent=state.ores.wood;H.oreC.textContent=state.ores.coal;H.oreI.textContent=state.ores.iron;H.oreG.textContent=state.ores.gold;H.oreD.textContent=state.ores.diamond;
  const pv=document.getElementById('pearlVal'); if(pv)pv.textContent='◉ '+fmt(state.pearls);
  const bv=document.getElementById('baitVal');
  if(bv){ const b=activeBait();
    bv.innerHTML=b?`<span class="baitpip" style="background:${b.tint};color:${b.tint}"></span>${b.name} ×${state.bait[state.baitId]}`
      :'<span style="color:var(--faint)">bare hook</span>'; }
  if(typeof updateHotbar==='function')updateHotbar(); if(invOpen)renderInv(); RF.emit('hud');}
let hintCur='';
function hint(h){h=RF.pipe('hint',h);if(h!==hintCur){hintCur=h;if(h){H.hint.innerHTML=h;H.hint.classList.add('on');}else H.hint.classList.remove('on');}}
const tw=document.getElementById('toasts');
function toast(m,k){if(RF.claim('toast',m,k))return null;const d=document.createElement('div');d.className='toast '+(k||'');d.innerHTML=m;tw.appendChild(d);RF.emit('toast',m,k,d);setTimeout(()=>d.remove(),2000);return d;}
let areaCur='',areaT=0;
function setArea(name,sub){if(name!==areaCur){areaCur=name;H.area.innerHTML=name+'<small>'+sub+'</small>';H.area.classList.add('on');areaT=3;}}
// ---- 3D catch reveal: a live Three.js voxel fish on the card ----
function fishSVG(rar){return pixFish(RAR[rar],60);} // fallback when the reveal WebGL context can't start
const revEl=document.getElementById('reveal'); let revT=0;
const fishScene=new THREE.Scene();
const fishCam=new THREE.PerspectiveCamera(30,170/110,0.1,20); fishCam.position.set(0,0.85,3.4); fishCam.lookAt(0,0,0);
fishScene.add(new THREE.HemisphereLight(0xffffff,0x223038,1.05));
{ const k=new THREE.DirectionalLight(0xfff2d8,0.95); k.position.set(2,3,2.5); fishScene.add(k);
  const r=new THREE.DirectionalLight(0x9fd8ff,0.5); r.position.set(-2.5,1,-2); fishScene.add(r); }
let fishRenderer=null;
try{ fishRenderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  fishRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); fishRenderer.setSize(170,110); }catch(e){}
let fishModel=null,fishAnim=null,fishT=0;
function disposeFishModel(){ if(!fishModel)return;
  fishModel.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});
  fishScene.remove(fishModel); fishModel=null; fishAnim=null; }
function buildFishModel(f){ disposeFishModel(); fishT=0;
  const name=(f.name||'').replace('✨ ','').replace('✦ ',''),low=name.toLowerCase(),is=s=>low.includes(s);
  const base=new THREE.Color(RAR[f.rar]||'#b9c6c4');
  const g=new THREE.Group(),A={fins:[],segs:[],glows:[],tail:null,lure:null,sparks:null};
  const M=(mul,extra)=>{const m=new THREE.MeshLambertMaterial(Object.assign({color:base.clone().multiplyScalar(mul)},extra||{}));
    if(f.shiny){m.emissive=new THREE.Color(0xffd24f);m.emissiveIntensity=0.22;} return m;};
  const body=M(1),dark=M(0.6),belly=M(1.4),fin=M(0.78,{transparent:true,opacity:0.92});
  const eye=new THREE.MeshLambertMaterial({color:0x0e1a20});
  const vxx=(mt,x,y,z,sx,sy,sz,par)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mt);m.position.set(x,y,z);(par||g).add(m);return m;};
  const finAt=(x,y,z,sx,sy,sz,rz,ry)=>{const m=vxx(fin,x,y,z,sx,sy,sz);m.rotation.set(0,ry||0,rz||0);A.fins.push({m,rz:rz||0,ry:ry||0});return m;};
  const tailGrp=x=>{const t=new THREE.Group();t.position.set(x,0,0);g.add(t);A.tail=t;return t;};
  let sideZ=0.19;
  if(is('eel')){ sideZ=0.13; // long segmented body that swims in a sine wave
    for(let i=0;i<9;i++){ const t=i/8,sg=vxx(i%2?dark:body,0.85-t*1.9,0,0,0.26,0.36-t*0.18,0.24-t*0.12);
      A.segs.push(sg); if(i>=2&&i<=6&&i%2===0)vxx(fin,0,0.26-t*0.1,0,0.18,0.12,0.04,sg); }
    A.segs[0].scale.set(1.2,1.2,1.3);
    vxx(eye,0.08,0.07,0.11,0.06,0.06,0.04,A.segs[0]); vxx(eye,0.08,0.07,-0.11,0.06,0.06,0.04,A.segs[0]);
    vxx(fin,-0.16,0,0,0.16,0.42,0.04,A.segs[8]);
  } else if(is('angler')){ sideZ=0.24; // huge head, teeth, glowing lure
    vxx(body,0.25,0,0,0.75,0.62,0.44); vxx(dark,-0.35,0.02,0,0.5,0.4,0.3); vxx(belly,0.28,-0.3,0,0.6,0.1,0.36);
    vxx(eye,0.5,0.16,0.23,0.1,0.1,0.05); vxx(eye,0.5,0.16,-0.23,0.1,0.1,0.05);
    vxx(eye,0.64,-0.08,0,0.05,0.14,0.34);
    const teeth=new THREE.MeshLambertMaterial({color:0xf4f8f5});
    for(let k=-1;k<=1;k++)vxx(teeth,0.66,-0.16,k*0.12,0.05,0.1,0.05);
    vxx(dark,0.35,0.44,0,0.06,0.28,0.06); vxx(dark,0.55,0.56,0,0.4,0.06,0.06);
    const lm=new THREE.MeshLambertMaterial({color:0xfff6c9,emissive:new THREE.Color(0xffe27a),emissiveIntensity:1});
    A.lure=vxx(lm,0.78,0.52,0,0.13,0.13,0.13);
    vxx(fin,-0.16,0,0,0.22,0.5,0.05,tailGrp(-0.62));
    finAt(0.3,-0.34,0.24,0.24,0.14,0.05,-0.5,0.35); finAt(0.3,-0.34,-0.24,0.24,0.14,0.05,0.5,-0.35);
  } else if(is('sword')||is('marlin')){ sideZ=0.16; // slim racer with a bill and sickle tail
    vxx(body,0,0,0,1.1,0.42,0.3); vxx(body,0.64,0,0,0.3,0.3,0.24); vxx(belly,0,-0.2,0,0.9,0.1,0.24);
    vxx(dark,1.08,0.02,0,0.6,0.07,0.07);
    vxx(eye,0.66,0.06,0.13,0.07,0.07,0.04); vxx(eye,0.66,0.06,-0.13,0.07,0.07,0.04);
    finAt(-0.08,0.4,0,0.4,0.36,0.05); finAt(0.34,0.28,0,0.14,0.2,0.05);
    const t=tailGrp(-0.6); vxx(fin,-0.16,0.2,0,0.16,0.42,0.05,t); vxx(fin,-0.16,-0.2,0,0.16,0.42,0.05,t);
    finAt(0.25,-0.22,0.16,0.28,0.12,0.05,-0.45,0.3); finAt(0.25,-0.22,-0.16,0.28,0.12,0.05,0.45,-0.3);
  } else { const chunky=is('koi')||is('carp')||is('sturgeon');
    const L=chunky?1.05:0.95,Hh=chunky?0.66:0.54,W=chunky?0.44:0.34; sideZ=W/2+0.02;
    vxx(body,0,0,0,L,Hh,W); vxx(dark,0,Hh/2,0,L*0.7,0.1,W*0.8); vxx(belly,0.04,-Hh/2+0.02,0,L*0.8,0.12,W*0.82);
    vxx(body,L/2+0.13,-0.02,0,0.3,Hh*0.74,W*0.82);
    vxx(eye,L/2+0.2,Hh*0.16,W*0.42,0.08,0.08,0.05); vxx(eye,L/2+0.2,Hh*0.16,-W*0.42,0.08,0.08,0.05);
    vxx(eye,L/2+0.29,-0.12,0,0.06,0.1,0.16);
    finAt(-0.05,Hh/2+0.14,0,0.44,0.26,0.05);
    const t=tailGrp(-L/2-0.06); vxx(fin,-0.13,0,0,0.24,0.46,0.05,t); vxx(fin,-0.28,0,0,0.13,chunky?0.8:0.62,0.05,t);
    finAt(0.2,-Hh*0.32,W/2+0.04,0.26,0.15,0.05,-0.5,0.35); finAt(0.2,-Hh*0.32,-W/2-0.04,0.26,0.15,0.05,0.5,-0.35);
    if(chunky){ const pat=new THREE.MeshLambertMaterial({color:is('golden')?0xffc24b:0xf2f5f0});
      vxx(pat,0.16,Hh*0.18,W/2+0.01,0.26,0.24,0.04); vxx(pat,-0.24,0.02,-W/2-0.01,0.3,0.26,0.04); vxx(pat,-0.08,Hh/2+0.06,0,0.3,0.05,W*0.55); } }
  if(is('glow')||is('moon')||is('midnight')||is('star')||is('thunder')||is('ember')||is('magma')||is('lava')||is('aurora')||is('crystal')||is('abyss')||is('pyro')||is('inferno')){ // bioluminescent flank dots
    const gm=new THREE.MeshLambertMaterial({color:0x0b1418,emissive:base.clone().multiplyScalar(1.2),emissiveIntensity:1});
    for(let k=0;k<4;k++){ const x=0.45-k*0.28,y=(k%2?0.12:-0.02);
      A.glows.push(vxx(gm,x,y,sideZ,0.08,0.08,0.03),vxx(gm,x,y,-sideZ,0.08,0.08,0.03)); } }
  if(f.shiny){ const sm=new THREE.MeshLambertMaterial({color:0xfff2b0,emissive:new THREE.Color(0xffd24f),emissiveIntensity:1});
    A.sparks=new THREE.Group();
    for(let k=0;k<6;k++){ const a=k/6*TAU,m=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,0.07),sm);
      m.position.set(Math.cos(a)*1.05,Math.sin(a*2)*0.32,Math.sin(a)*1.05); A.sparks.add(m); }
    g.add(A.sparks); }
  g.scale.setScalar((0.72+Math.min(f.kg||1,16)/16*0.5)*(is('eel')?0.82:1)); // heavier catch → bigger model
  fishModel=g; fishAnim=A; fishScene.add(g); }
function renderFishScene(dt){ if(!fishRenderer||!fishModel)return; fishT+=dt;
  fishModel.rotation.y=-0.6+fishT*1.4; fishModel.position.y=Math.sin(fishT*2.3)*0.06;
  const A=fishAnim;
  if(A.tail)A.tail.rotation.y=Math.sin(fishT*9)*0.5;
  for(let i=0;i<A.fins.length;i++){const fn=A.fins[i];fn.m.rotation.z=fn.rz+Math.sin(fishT*7+i*2)*0.22;fn.m.rotation.y=fn.ry+Math.sin(fishT*7+i*2)*0.18;}
  for(let i=0;i<A.segs.length;i++){const sg=A.segs[i];sg.position.z=Math.sin(fishT*5.5-i*0.9)*0.09;sg.rotation.y=Math.sin(fishT*5.5-i*0.9+0.9)*0.22;}
  if(A.lure)A.lure.material.emissiveIntensity=0.65+Math.sin(fishT*7)*0.35;
  if(A.glows.length)A.glows[0].material.emissiveIntensity=0.7+Math.sin(fishT*5)*0.3;
  if(A.sparks){A.sparks.rotation.y=fishT*2.2;A.sparks.rotation.x=Math.sin(fishT*1.7)*0.35;}
  fishRenderer.render(fishScene,fishCam); }
/* `quiet` is the auto-rig: it lands a fish every few seconds, and a full 3D
   card for every sardine would bury the screen. Commons get a one-line toast;
   anything the rig was not supposed to find still gets the whole ceremony. */
function reveal(f,quiet){ if(RF.override.reveal&&RF.override.reveal(f,quiet)===true)return;
  sfx.rare(f.rar,f.shiny);
  if(quiet&&RORDER[f.rar]<2&&!f.shiny){ toast(`${pixSVG('fish',13)} ${f.name} · ◈${fmt(f.val)}`); return; }
  const glow=f.shiny?'#ffd24f':RAR[f.rar];
  revEl.innerHTML=`<div class="reveal-card" style="border-color:${glow};box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 30px ${glow}55"><div class="r" style="color:${RAR[f.rar]}">${f.shiny?'✦ shiny ':''}${f.rar}</div><div class="f3d">${fishRenderer?'':fishSVG(f.rar)}</div><div class="nm">${f.name}</div><div class="v">◈ ${fmt(f.val)} · ${f.kg||'?'} kg</div></div>`;
  if(fishRenderer){ revEl.querySelector('.f3d').appendChild(fishRenderer.domElement); buildFishModel(f); renderFishScene(0); }
  revEl.classList.add('on'); revT=2.5; }

// ---- minimap ----
const mmC=document.getElementById('minimap'),mmX=mmC?mmC.getContext('2d'):null;
const mmBase=px(N);
{ const g=mmBase.getContext('2d');
  const waterHex='#'+WORLD.water.toString(16).padStart(6,'0');
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j],t=cellType(h);
    g.fillStyle=t==='seabed'?waterHex:t==='sand'?WORLD.sand[0]:t==='grass'?WORLD.grass[0]:WORLD.stone[0];
    if(pathSet.has(keyOf(i,j))&&(t==='grass'||t==='sand'))g.fillStyle='#cba86f';
    g.fillRect(i,j,1,1); } }
let mmLX=1e9,mmLZ=1e9,mmNext=0;
function drawMinimap(){ if(!mmX)return; if(RF.override.minimap&&RF.override.minimap(mmX,mmC)===true)return; const W=mmC.width;
  // dirty-check: full redraw only when the player moved or every 0.25s (for POI/treasure pulses)
  if(Math.hypot(pWorld.x-mmLX,pWorld.z-mmLZ)<0.12&&clock<mmNext)return;
  mmLX=pWorld.x; mmLZ=pWorld.z; mmNext=clock+0.25;
  mmX.clearRect(0,0,W,W);
  // rotate 45° so map-up matches screen-up (W key), clipped to a circle
  mmX.save(); mmX.beginPath(); mmX.arc(W/2,W/2,W/2-2,0,TAU); mmX.clip();
  mmX.translate(W/2,W/2); mmX.rotate(Math.PI/4); mmX.scale(0.74,0.74); mmX.translate(-W/2,-W/2);
  mmX.imageSmoothingEnabled=false; mmX.drawImage(mmBase,0,0,W,W);
  const dot=(wx,wz,col,r,strk)=>{ mmX.fillStyle=col; mmX.beginPath();
    mmX.arc((wx+HALF)/N*W,(wz+HALF)/N*W,r,0,TAU); mmX.fill();
    if(strk){mmX.strokeStyle='#0a1418';mmX.lineWidth=1.6;mmX.stroke();} };
  dot(TRADER_POS.x,TRADER_POS.z,'#ffcf5c',4);
  dot(CASINO_POS.x,CASINO_POS.z,'#ff5d7a',4);
  if(PORTAL_POS)dot(PORTAL_POS.x,PORTAL_POS.z,'#c490ff',4);
  if(HARBOR_POS)dot(HARBOR_POS.x,HARBOR_POS.z,'#39d7c4',4);
  if(mineCell)dot(mineCell[0]-HALF,mineCell[1]-HALF,'#e8f4ff',4);
  if(CRATER)dot(CRATER.i-HALF,CRATER.j-HALF,'#ff7a1a',4);
  if(state.treasure){ const tx=(state.treasure.i)/N*W, ty=(state.treasure.j)/N*W;
    mmX.strokeStyle='#ffd24f'; mmX.lineWidth=2.4; mmX.beginPath();
    mmX.moveTo(tx-4,ty-4); mmX.lineTo(tx+4,ty+4); mmX.moveTo(tx+4,ty-4); mmX.lineTo(tx-4,ty+4); mmX.stroke(); }
  dot(pWorld.x,pWorld.z,'#ffffff',4,true);
  mmX.restore(); }

/* ========================================================================
   9. STATE + FISH + UPGRADES
   ======================================================================== */
const SAVE='reelfortune3d-v1', CAP_BASE=12, MAXLVL=10;
/* ---- LUCK + BAIT -------------------------------------------------------
   One number bends the whole draw. `luck` scales every table entry's weight
   by rarity: commons thin out, the top of the table swells. Luck 0 is exactly
   the shipped table, and no weight ever drops under 5% of base, so nothing is
   ever impossible. Rod level and bait are the two things that feed it.
   Declared up here because load() runs before the upgrade section.
   ---------------------------------------------------------------------- */
const LUCK_W={common:-0.55,uncommon:-0.15,rare:0.9,epic:1.7,legendary:2.6};
const luckWeight=(rar,luck)=>luck>0?Math.max(0.05,1+luck*(LUCK_W[rar]||0)):1;
/* Rod luck replaces the old "reroll the draw up to 9× at p=0.3" ladder: that
   loop saturated near Lv.10 and left bait nothing to add. Lv.1 = 0, Lv.10 = +1.62. */
const rodLuck=lvl=>+(0.18*(clamp(lvl|0||1,1,MAXLVL)-1)).toFixed(4);
/* ---- AUTO-FISHING: the "lazy line" — mirrors server/src/game/rules.js AUTO.
   A rig you prop up on the shore and walk away from. Nobody sets the hook and
   nobody plays the fish, so it only ever brings up what swims into it: the
   cheap end of the water. W multiplies each species' table weight AFTER the
   world's own weights — on Fortune Isle that moves a legendary from ~1 in 220
   casts to ~1 in 26,000. The rest just make sure an unattended catch is never
   worth as much as one you fought for. These numbers decide the OFFLINE game
   only; signed in, the server rolls all of it and this never runs. ---- */
const AUTO={W:{common:1,uncommon:0.45,rare:0.1,epic:0.03,legendary:0.008},
  luck:0.25,val:0.7,shiny:0.25,pearls:0.5,gapMs:4500};
const autoWeight=rar=>AUTO.W[rar]!==undefined?AUTO.W[rar]:1;
/* Bait: bought by the pack with coins, spent one per fish LANDED (a snapped
   line is free). `min` is a hard floor — the pool is filtered to that rarity
   and up, so Siren's Chum cannot hook anything but a legend. `shiny` scales
   the 1.8% mutation roll. The top rungs only turn a profit in a rich world. */
const BAITS={
  worm:  {name:'Garden Worm',   sub:'wriggly, cheap, honest',        cost:60,   pack:10, luck:0.4, min:null,        shiny:1,   tint:'#c98b6a'},
  shrimp:{name:'Brine Shrimp',  sub:'nothing small bothers with it', cost:180,  pack:10, luck:0.9, min:'uncommon',  shiny:1.2, tint:'#ff9f7a'},
  squid: {name:'Squid Strip',   sub:'the deep answers this one',     cost:400,  pack:10, luck:1.6, min:'rare',      shiny:1.5, tint:'#c9b6ff'},
  glow:  {name:'Glowworm Lure', sub:'burns cold, draws big',         cost:900,  pack:10, luck:2.4, min:'epic',      shiny:2,   tint:'#8ef7c9'},
  siren: {name:"Siren's Chum",  sub:'only legends answer',           cost:6000, pack:10, luck:3.2, min:'legendary', shiny:3,   tint:'#ffd24f'}};
const BAIT_ORDER=['worm','shrimp','squid','glow','siren'], BAIT_MAX=999;
const baitOf=id=>(typeof id==='string'&&Object.prototype.hasOwnProperty.call(BAITS,id))?BAITS[id]:null;
/* What is actually on the hook right now — an equipped bait you ran out of is none. */
const activeBait=()=>{ const b=baitOf(state.baitId); return b&&state.bait[state.baitId]>0?b:null; };
const fishLuck=()=>RF.pipe('fishLuck',(()=>{ const b=activeBait(); return rodLuck(state.rodLvl)+(b?b.luck:0); })());
const state={coins:0,bucket:[],ores:{wood:0,coal:0,iron:0,gold:0,diamond:0},rodLvl:1,pickLvl:1,axeLvl:1,boatLvl:0,
  dex:{},treasure:null,worlds:['isle'],ach:{},
  stocks:{own:{},basis:{},lastDiv:null,lastShareEpoch:0,gotFirst:0},
  pearls:0,pearlsLife:0,wardrobe:{},titleId:'',ownedT:{},ownedW:{},bucketTier:0,boosts:{chumUntil:0},tipEpoch:0,deeds:{},
  bait:{},baitId:'',
  pet:0,charm:0,jackpot:0,bounty:null,bountyEpoch:0,
  stats:{caught:0,mined:0,wood:0,earned:0,bestWin:0,spins:0,winsCt:0,losses:0,divEarned:0}};
const cap=()=>CAP_BASE+2*(state.bucketTier||0);
/* ---- server bridge: when signed in, the SERVER owns the economy ----
   Offline play is unchanged. Online, every action below is decided server-side and
   the reply overwrites local state, so editing `state` in the console achieves nothing. */
const SRV={
  get on(){ return !!(window.RFNet&&RFNet.online); },
  busy:false,
  apply(s){ if(!s)return;
    for(const k in s) if(Object.prototype.hasOwnProperty.call(state,k)) state[k]=s[k];
    updateHUD(); if(invOpen)renderInv(); if(marketOpen)renderMarketAll(); },
  /* Fire an authoritative action. Returns the server's `result`, or null when
     offline/rejected — callers fall back to (or simply skip) local resolution. */
  async act(name,body){
    if(!this.on)return null;
    if(this.busy)return null;                       // one economy action in flight at a time
    this.busy=true;
    try{ const r=await RFNet.action(name,body||{});
      if(r&&r.state)this.apply(r.state);
      return r?r.result:null; }
    catch(e){ if(e.status===429)toast('Slow down…');
      else toast('Server: '+(e.message||'error'),'bad');
      return null; }
    finally{ this.busy=false; }
  }
};
function save(){ if(SRV.on){ // server holds the economy; only mirror what it lets us keep
    try{ RFNet.saveCosmetics({wardrobe:state.wardrobe,titleId:state.titleId,tipEpoch:state.tipEpoch,
      ach:state.ach,deeds:state.deeds}); }catch(e){}   // append-only on the server side
    return; }
  try{localStorage.setItem(SAVE,JSON.stringify(state));}catch(e){}}
function load(){try{const r=localStorage.getItem(SAVE);if(r){const s=JSON.parse(r);
  state.coins=s.coins||0;state.bucket=Array.isArray(s.bucket)?s.bucket:[];
  if(s.ores)for(const k in state.ores)state.ores[k]=s.ores[k]|0;
  if(s.stats)for(const k in state.stats)state.stats[k]=+s.stats[k]||0;
  if(s.dex&&typeof s.dex==='object')state.dex=s.dex;
  if(s.ach&&typeof s.ach==='object')state.ach=s.ach;
  if(s.treasure&&s.treasure.i!=null)state.treasure=s.treasure;
  if(Array.isArray(s.worlds)&&s.worlds.length)state.worlds=s.worlds;
  if(s.stocks&&typeof s.stocks==='object'){ const st=s.stocks;
    if(st.own&&typeof st.own==='object')for(const k in st.own)state.stocks.own[k]=clamp(st.own[k]|0,0,100);
    if(st.basis&&typeof st.basis==='object')for(const k in st.basis){const b=+st.basis[k];if(isFinite(b)&&b>0)state.stocks.basis[k]=b;}
    state.stocks.lastDiv=isFinite(+st.lastDiv)?+st.lastDiv:null;
    state.stocks.lastShareEpoch=Math.max(0,+st.lastShareEpoch||0);
    state.stocks.gotFirst=st.gotFirst?1:0; }
  state.pearls=Math.max(0,s.pearls|0); state.pearlsLife=Math.max(0,s.pearlsLife|0);
  if(s.wardrobe&&typeof s.wardrobe==='object')state.wardrobe=s.wardrobe;
  if(s.ownedW&&typeof s.ownedW==='object')state.ownedW=s.ownedW;
  if(s.ownedT&&typeof s.ownedT==='object')state.ownedT=s.ownedT;
  state.titleId=typeof s.titleId==='string'?s.titleId:'';
  state.bucketTier=clamp(s.bucketTier|0,0,4);
  if(s.bait&&typeof s.bait==='object'){ state.bait={};
    for(const k in BAITS){ const n=clamp(s.bait[k]|0,0,BAIT_MAX); if(n>0)state.bait[k]=n; } }
  state.baitId=typeof s.baitId==='string'&&state.bait[s.baitId]>0?s.baitId:''; // no stock = bare hook
  state.tipEpoch=+s.tipEpoch||0;
  if(s.deeds&&typeof s.deeds==='object')state.deeds=s.deeds;
  state.pet=s.pet?1:0; state.charm=s.charm?1:0; state.jackpot=Math.max(0,s.jackpot|0);
  if(s.bounty&&typeof s.bounty==='object')state.bounty=s.bounty; state.bountyEpoch=+s.bountyEpoch||0;
  if(state.treasure&&state.treasure.w==null)state.treasure.w=worldKey; // legacy maps: assume current isle
  if(s.boosts&&typeof s.boosts==='object')state.boosts.chumUntil=+s.boosts.chumUntil||0;
  state.rodLvl=clamp(s.rodLvl|0||1,1,MAXLVL);state.pickLvl=clamp(s.pickLvl|0||1,1,MAXLVL);
  state.axeLvl=clamp(s.axeLvl|0||1,1,MAXLVL);
  state.boatLvl=clamp(s.boatLvl|0,0,4);}}catch(e){}}
load();
rebuildDockBoat();
function F(name,rar,val){return {name,rar,val};}
// time-of-day + weather globals (driven by the sky system in animate)
let dayT=0.3, wState='clear', dayCount=0; // dayCount drives the 8-day lunar phase
const isNight=()=>dayT<0.13||dayT>0.72;
// entries: [species, weight, cond?] — cond gates when it can bite
const TABLE=[[F('Sardine','common',8),40],[F('Perch','common',12),34],[F('Carp','common',10),30],
  [F('Bass','uncommon',20),26],[F('Trout','uncommon',24),22],[F('Snapper','uncommon',34),18],
  [F('Eel','rare',44),14],[F('Tuna','rare',82),10],[F('Koi','rare',130),8],
  [F('Sturgeon','epic',128),6],[F('Swordfish','epic',156),5],[F('Golden Carp','epic',168),4],
  [F('Anglerfish','legendary',430),2],[F('Star Koi','legendary',620),1],
  [F('Glowgill','uncommon',40),10,'night'],[F('Moonfin','rare',95),7,'night'],[F('Midnight Koi','epic',210),4,'night'],
  [F('Rainrunner','uncommon',38),12,'rain'],[F('Mistcarp','rare',88),6,'rain'],
  [F('Thunder Eel','epic',260),5,'storm'],[F('Storm Marlin','legendary',750),2,'storm']];
// ---- per-world fish tables: every isle has its own catch (TABLE = Fortune Isle's) ----
WORLDS.isle.fish=TABLE;
WORLDS.mine.fish=[[F('Pebble Sardine','common',9),40],[F('Gravel Perch','common',13),34],[F('Rust Carp','common',12),30],
  [F('Copperfin','uncommon',24),24],[F('Tin Trout','uncommon',26),20],[F('Quarry Snapper','uncommon',38),16],
  [F('Iron Eel','rare',60),12],[F('Magnetite Tuna','rare',95),9],[F('Cobalt Koi','rare',140),7],
  [F('Silver Sturgeon','epic',150),6],[F('Drill Marlin','epic',175),4],
  [F('Motherlode Koi','legendary',520),2],
  [F('Lantern Glowgill','uncommon',45),9,'night'],[F('Moonvein Eel','rare',105),6,'night'],
  [F('Slag Eel','epic',280),4,'storm'],[F('Forge Marlin','legendary',780),1,'storm']];
WORLDS.volcano.fish=[[F('Ash Sardine','common',10),40],[F('Soot Perch','common',14),32],
  [F('Emberfin','uncommon',26),24],[F('Cinder Snapper','uncommon',36),18],
  [F('Magma Eel','rare',70),12],[F('Basalt Tuna','rare',100),9],
  [F('Obsidian Sturgeon','epic',160),6],[F('Pyro Koi','epic',200),4],
  [F('Phoenix Marlin','legendary',800),2],
  [F('Lava Glowgill','uncommon',48),10,'night'],[F('Ashmoon Koi','epic',240),4,'night'],
  [F('Eruption Eel','epic',300),4,'storm'],[F('Inferno Marlin','legendary',900),1,'storm']];
WORLDS.frost.fish=[[F('Ice Sardine','common',9),40],[F('Frost Perch','common',13),33],
  [F('Snowfin','uncommon',24),22],[F('Glacier Trout','uncommon',26),20],
  [F('Crystal Eel','rare',75),11],[F('Arctic Tuna','rare',105),9],
  [F('Frozen Sturgeon','epic',165),5],[F('Snowflake Koi','epic',210),4],
  [F('Aurora Marlin','legendary',850),2],
  [F('Polar Glowgill','uncommon',50),9,'night'],[F('Moonfrost Koi','epic',230),4,'night'],
  [F('Blizzard Eel','epic',290),4,'storm'],[F('Yeti Carp','legendary',820),1,'storm']];
// cave: eternal night, so its glow species are the everyday population (three shared with isle nights)
WORLDS.cave.fish=[[F('Cave Guppy','common',10),40],[F('Blind Perch','common',14),32],
  [F('Glowgill','uncommon',40),20],[F('Echo Snapper','uncommon',36),16],
  [F('Dweller Eel','rare',78),12],[F('Moonfin','rare',95),8],[F('Crystal Koi','rare',150),6],
  [F('Midnight Koi','epic',210),5],[F('Fossil Sturgeon','epic',170),4],
  [F('Abyss Anglerfish','legendary',900),2],[F('Wyrm Eel','legendary',850),1]];
// combined species list (unique by name) — drives the Fishdex and completion achievements
const ALL_FISH=[]; { const seenF=new Set();
  for(const k in WORLDS){ const wf=WORLDS[k].fish; if(!wf)continue;
    for(const e of wf) if(!seenF.has(e[0].name)){ seenF.add(e[0].name); ALL_FISH.push(e); } } }
function condOK(c){ if(!c)return true; if(c==='night')return isNight();
  if(c==='rain')return wState==='rain'||wState==='storm'; if(c==='storm')return wState==='storm'; return true; }
const RORDER={common:0,uncommon:1,rare:2,epic:3,legendary:4};
// `minRar` is bait's rarity floor — anything under it is cut from the pool.
// A floor that would empty the pool is ignored: no world is ever unfishable.
function fishPool(minRar){ const pool=(typeof WORLD!=='undefined'&&WORLD.fish?WORLD.fish:TABLE).filter(e=>condOK(e[2]));
  const fl=RORDER[minRar]; if(fl==null)return pool;
  const up=pool.filter(e=>RORDER[e[0].rar]>=fl); return up.length?up:pool; }
function mkFish(t,mul,auto){ return {uid:(Date.now()+Math.random()).toString(36),name:t.name,rar:t.rar,
  // never below 1: an auto-caught sardine is cheap, not free
  val:Math.max(1,Math.round(t.val*mul*rand(0.85,1.18)*(auto?AUTO.val:1))),
  kg:+(t.val/9*rand(0.5,1.6)+0.2).toFixed(1),wins:0}; }
function rollOnce(luck,minRar,auto){ const pool=fishPool(minRar); if(!pool.length)return null;
  const mul=typeof WORLD!=='undefined'?WORLD.fishMul||1:1;
  const wt=pool.map(e=>e[1]*luckWeight(e[0].rar,luck||0)*(auto?autoWeight(e[0].rar):1));
  let tot=0; for(const x of wt)tot+=x; let r=Math.random()*tot;
  for(let i=0;i<pool.length;i++){ r-=wt[i]; if(r<=0)return mkFish(pool[i][0],mul,auto); }
  return mkFish(pool[pool.length-1][0],mul,auto); }
// `noBait` is for a fish that was never on a line at all (the one buried in a
// treasure chest): rod luck still counts, the bait in your pocket does not.
function rollFish(noBait,auto){ // an unattended hook carries no bait: no luck from it, no rarity floor either
  const b=(noBait||auto)?null:activeBait(), min=b?b.min:null,
    luck=auto?rodLuck(state.rodLvl)*AUTO.luck:rodLuck(state.rodLvl)+(b?b.luck:0);
  let f=rollOnce(luck,min,auto);
  // weather and hull only stir up better fish for someone holding the rod —
  // the lazy line gets one flat draw and no second chances
  if(!auto){
    if((wState==='rain'||wState==='storm')&&Math.random()<0.12){ const g=rollOnce(luck,min); if(RORDER[g.rar]>RORDER[f.rar])f=g; }
    const bl=BOATS[state.boatLvl]?BOATS[state.boatLvl].luck:0; // a finer ship stirs finer fish
    if(bl&&Math.random()<bl){ const g=rollOnce(luck,min); if(RORDER[g.rar]>RORDER[f.rar])f=g; } }
  if(Math.random()<0.018*(auto?AUTO.shiny:(b?b.shiny:1))){ f.shiny=true; f.val*=5; f.name='✦ '+f.name; } // shiny mutation
  return f; }
/* Tell the player when their last bait went in the water — the same call site
   whether the server or the offline roll decided it. */
function noteBaitSpent(u){ if(u&&u.out)toast(`${u.name} · that was your last one`,'bad'); }
/* Spend one of the equipped bait — only once a fish is really in the bucket,
   so a snapped line never costs you anything. */
function useBait(){ const id=state.baitId, b=baitOf(id);
  if(!b||!(state.bait[id]>0))return null;
  const left=state.bait[id]-1;
  if(left>0)state.bait[id]=left; else { delete state.bait[id]; state.baitId=''; }
  sfx.bait();
  return {id,name:b.name,left,out:left===0}; }
function biteTime(){ const wet=(wState==='rain'||wState==='storm')?0.65:1;
  const chum=Date.now()<state.boosts.chumUntil?0.5:1; // Chum Jar boost
  return Math.max(0.15,RF.pipe('biteTime',rand(1.1,3.2)*Math.max(0.35,1-0.06*(state.rodLvl-1))*wet*chum)); }
function onCatch(fish,auto){ state.stats.caught++; state.bucket.push(fish);
  if(RORDER[fish.rar]>=2)rareCaught++; // feeds the "land N rare-or-better" bounty
  const dexName=fish.shiny?fish.name.replace('✨ ','').replace('✦ ',''):fish.name;
  const d=state.dex[dexName]||(state.dex[dexName]={n:0,best:0});
  d.n++; const isNew=d.n===1; let isRec=false;
  if(fish.kg>d.best){ d.best=fish.kg; isRec=true; if(!isNew)toast(`${pixSVG('trophy',13)} Record ${dexName}: ${fish.kg} kg!`,'good'); }
  if(isNew){ toast(`✦ NEW SPECIES: ${dexName}`,'gold'); addShake(0.1); }
  if(fish.shiny){ toast('✦ SHINY! Worth 5× more','gold'); addShake(0.18); addFreeze(0.1); }
  // pearls: flat activity points by rarity (never scaled by world/price)
  let pp={common:1,uncommon:2,rare:4,epic:8,legendary:16}[fish.rar]||1;
  if(fish.shiny)pp*=3;
  // the rig earns half the activity points; a first sighting is still a first
  // sighting, so the discovery bonuses ride on top untouched
  if(auto)pp=Math.max(1,Math.floor(pp*AUTO.pearls));
  if(isNew)pp+=5; else if(isRec)pp+=2;
  addPearls(pp);
  // epic+ catches can come with a Reel Fisheries share certificate
  if(RORDER[fish.rar]>=3&&Math.random()<0.05)grantShare('REEL');
  // rare chance the catch also snags a bottled treasure map. Never off the
  // auto-rig: the map roll is a flat 8% per catch, the one drop the crushed
  // rarity table does not already gate.
  if(!auto&&!state.treasure&&Math.random()<0.08){ const cand=landCells.filter(c=>reachable(c[0],c[1])&&Math.hypot(c[0]-spawnCell[0],c[1]-spawnCell[1])>14);
    if(cand.length){ const c=cand[(Math.random()*cand.length)|0]; state.treasure={i:c[0],j:c[1],w:worldKey};
      toast(pixSVG('map',13)+' A bottle! X marks the spot on your map','gold'); } }
  RF.emit('catch',fish,{auto:!!auto,isNew:isNew,isRec:isRec,server:false});
  sfx.catch(); reveal(fish,auto); }
/* Same celebration, but the server already decided (and banked) everything. */
function revealServerCatch(r){ const fish=r.fish;
  if(r.isRec&&!r.isNew)toast(`${pixSVG('trophy',13)} Record ${fish.name}: ${fish.kg} kg!`,'good');
  if(r.isNew){ toast(`✦ NEW SPECIES: ${fish.name}`,'gold'); addShake(0.1); }
  if(fish.shiny){ toast('✦ SHINY! Worth 5× more','gold'); addShake(0.18); addFreeze(0.1); }
  if(r.pearls)toast(`+${r.pearls} ◉`,'good');
  noteBaitSpent(r.bait);
  if(r.share)toast(`${pixSVG('chart',13)} +1 share ${r.share}`,'gold');
  if(r.treasure)toast(pixSVG('map',13)+' A bottle! X marks the spot on your map','gold');
  RF.emit('catch',fish,{auto:!!r.auto,isNew:!!r.isNew,isRec:!!r.isRec,server:true});
  sfx.catch(); reveal(fish,r.auto); }
// rotating market demand: every 3 min one category is HOT (x1.6), one SURPLUS (x0.75)
const MKT_CATS=['fish','wood','coal','iron','gold','diamond'];
const MKT_MS=180000;
const mktEpochNow=()=>Math.floor(Date.now()/MKT_MS);
function mktModsAt(e){
  const hi=Math.floor(hash(e,7)*MKT_CATS.length)%MKT_CATS.length;
  let lo=Math.floor(hash(e,13)*(MKT_CATS.length-1))%(MKT_CATS.length-1); if(lo>=hi)lo++;
  return {hot:MKT_CATS[hi],cold:MKT_CATS[lo]}; }
function mktMods(){ return mktModsAt(mktEpochNow()); }
function priceMult(cat){ const m=mktMods(); return RF.pipe('priceMult',cat===m.hot?1.6:cat===m.cold?0.75:1,{cat:cat,mods:m}); }

/* ---- ISLE EXCHANGE: five fictional stocks priced purely from the real clock ----
   Prices are deterministic functions of the wall-clock epoch (no reroll, no server);
   holders earn dividends every quarter (20 epochs = 1 hour), even while offline. */
const STOCKS={
  DIGG:{name:'Deep Digg Mining Co.',   base:60, vol:1.0, cats:['coal','iron','gold','diamond'], yield:0.008, salt:101},
  REEL:{name:'Reel Fortune Fisheries', base:40, vol:0.8, cats:['fish'],                         yield:0.009, salt:211},
  LUMB:{name:'Lumberline Timber',      base:25, vol:0.55,cats:['wood'],                         yield:0.012, salt:307},
  EEL: {name:'Spinning Eel Ent.',      base:90, vol:1.8, cats:[],                               yield:0,     salt:401},
  HARB:{name:'Harbor Star Lines',      base:150,vol:0.4, cats:[],                               yield:0.015, salt:503}};
const STOCK_KEYS=Object.keys(STOCKS), STOCK_CAP=100, DIV_Q=20;
function stockPrice(k,e){ const s=STOCKS[k];
  const slow=(vnoise(e*0.004,s.salt)-0.5)*2.0, mid=(vnoise(e*0.05,s.salt*1.7)-0.5)*0.8, fast=(hash(e,s.salt)-0.5)*0.15;
  const m=mktModsAt(e), hotMul=s.cats.includes(m.hot)?1.08:s.cats.includes(m.cold)?0.94:1; // regime swing < spread: tips give an edge, not an ATM
  return Math.max(1,Math.round(s.base*Math.exp((slow+mid)*s.vol+fast)*hotMul)); }
const stockAsk=(k,e)=>Math.ceil(stockPrice(k,e)*1.05)+2;   // spread + flat fee folded in
const stockBid=(k,e)=>Math.max(1,Math.floor(stockPrice(k,e)*0.95)-2);
function grantShare(k){ const e=mktEpochNow(), st=state.stocks;
  if(e<=st.lastShareEpoch)return false; // pity-cap: at most 1 dropped share per market epoch
  st.lastShareEpoch=e;
  if((st.own[k]|0)>=STOCK_CAP){ const g=stockBid(k,e); state.coins+=g;
    toast(`Portfolio full · sold 1 ${k} for ◈${fmt(g)}`,'gold'); updateHUD(); save(); return true; }
  const n=st.own[k]|0, p=stockPrice(k,e);
  st.basis[k]=((st.basis[k]||p)*n+p)/(n+1); st.own[k]=n+1;
  const first=!st.gotFirst; st.gotFirst=1;
  toast(`${pixSVG('chart',13)} +1 share ${k} · ${STOCKS[k].name}`,'gold'); sfx.ore(); addShake(0.08);
  if(first)setTimeout(()=>toast('Shares pay hourly dividends · see ISLE EXCHANGE at the Trader','good'),1000);
  updateHUD(); if(typeof marketOpen!=='undefined'&&marketOpen)renderMarketAll(); save(); return true; }
function payDividends(){ const st=state.stocks, dNow=Math.floor(Date.now()/(MKT_MS*DIV_Q));
  if(st.lastDiv==null||!isFinite(st.lastDiv)||st.lastDiv>dNow){ st.lastDiv=dNow; return; }
  if(dNow<=st.lastDiv)return;
  const from=Math.max(st.lastDiv+1,dNow-23); let tot=0; // offline catch-up capped at 24 quarters
  for(let d=from;d<=dNow;d++)for(const k of STOCK_KEYS){ const n=st.own[k]|0; if(!n)continue;
    const s=STOCKS[k]; if(!s.yield||hash(d,s.salt+77)<=0.25)continue; // 25% of quarters: board retains earnings
    tot+=n*Math.ceil(stockPrice(k,d*DIV_Q)*s.yield); }
  st.lastDiv=dNow;
  if(tot>0){ state.coins+=tot; state.stats.earned+=tot; state.stats.divEarned+=tot;
    toast(`${pixSVG('chart',13)} Dividends paid: +◈${fmt(tot)}`,'gold'); coinFly(tot); sfx.win(); updateHUD(); }
  save(); }
// ---- PEARLS: flat activity points, never convertible to/from coins ----
function addPearls(n,why){ n=Math.round(RF.pipe('pearls',n,{why:why})); if(n<=0)return; state.pearls+=n; state.pearlsLife+=n; sfx.pearl();
  RF.emit('pearls',n,why);
  if(n>=2)toast(`+${n} ◉${why?' · '+why:''}`,'good');
  updateHUD(); }
const catLabel=c=>c==='fish'?'Fish':ORE_INFO[c].name;
/* ---- the fleet: coins + ores buy the next hull at the Harbor dock ---- */
const BOATS=[
  {name:'Driftwood Raft', sub:'lashed logs & a prayer',      cost:0,     req:{},                  luck:0,    seats:1},
  {name:'Cork Dinghy',    sub:'a real hull at last',         cost:600,   req:{wood:12},           luck:0.06, seats:2},
  {name:'Teal Sloop',     sub:'painted hull · single sail',  cost:2400,  req:{wood:20,iron:8},    luck:0.12, seats:4},
  {name:'Storm Trawler',  sub:'iron-clad workhorse',         cost:8000,  req:{iron:14,gold:8},    luck:0.2,  seats:6},
  {name:'Gilded Galleon', sub:'pride of the archipelago',    cost:22000, req:{gold:14,diamond:6}, luck:0.3,  seats:10}];
// seats count the captain, so crewSlots(raft)=0: you need a real hull to carry anyone
const boatSeats=lvl=>(BOATS[clamp(lvl|0,0,BOATS.length-1)]||BOATS[0]).seats;
const crewSlots=lvl=>Math.max(0,boatSeats(lvl)-1);
const seatLabel=lvl=>{ const n=boatSeats(lvl); return n===1?'sails alone · 1 seat':`seats ${n} · ${n-1} crew`; };
const BOAT_REQ={isle:0,mine:1,volcano:2,frost:3}; // boat level needed to UNLOCK each isle
const ROD_BASE=250, PICK_BASE=200, AXE_BASE=180;
const AXE_NAMES=['','Dull Axe','Stone Axe','Iron Axe','Steel Axe','Golden Axe','Crystal Axe','Obsidian Axe','Mythril Axe','Dragon Axe','Titan Axe'];
const upCost=(base,lvl)=>Math.round(base*Math.pow(1.75,lvl-1)); // cost lvl -> lvl+1
const ROD_NAMES=['','Old Rod','Birch Rod','Lucky Rod','Fiber Rod','Golden Rod','Prism Rod','Storm Rod','Mythic Rod','Abyss Rod','Poseidon Rod'];
const PICK_NAMES=['','Rusty Pick','Stone Pick','Iron Pick','Steel Pick','Golden Pick','Crystal Pick','Obsidian Pick','Mythril Pick','Dragon Pick','Titan Pick'];
// ore ingredients to craft the next tier (indexed by TARGET level) — mining feeds progression
const UP_REQ=[null,null,{wood:5},{wood:8,coal:4},{iron:4},{iron:8},{gold:3},{gold:6},{diamond:2},{diamond:4},{diamond:7}];
// axe has its own gentler ladder — wood is a 6-coin commodity, so its tool must not cost diamonds
const AXE_REQ=[null,null,{wood:5},{wood:10,coal:3},{iron:3},{iron:6},{gold:2},{gold:4},{gold:6},{gold:8},{gold:10}];
const axeCost=lvl=>Math.round(90*Math.pow(1.5,lvl-1)); // L1->L10 total ~6.7k vs 36.7k before
function haveOres(req){ for(const k in req)if(state.ores[k]<req[k])return false; return true; }
function reqLabel(req){ return Object.keys(req).map(k=>`${req[k]} ${ORE_INFO[k].name}`).join(' + '); }

/* ---- achievements: milestone rewards, checked on a slow tick ---- */
const ACH=[
  ['fish1','First Catch','catch your first fish',25,s=>s.stats.caught>=1],
  ['fish25','Angler','catch 25 fish',100,s=>s.stats.caught>=25],
  ['fish100','Master Angler','catch 100 fish',300,s=>s.stats.caught>=100],
  ['fish500','Sea Legend','catch 500 fish',1500,s=>s.stats.caught>=500],
  ['mine10','Prospector','mine 10 ores',50,s=>s.stats.mined>=10],
  ['mine100','Quarry Boss','mine 100 ores',300,s=>s.stats.mined>=100],
  ['rich1k','First Grand','earn 1,000 coins',100,s=>s.stats.earned>=1000],
  ['rich10k','Tycoon','earn 10,000 coins',500,s=>s.stats.earned>=10000],
  ['rich100k','Isle Magnate','earn 100,000 coins',3000,s=>s.stats.earned>=100000],
  ['spin10','Regular','spin the wheel 10 times',100,s=>s.stats.spins>=10],
  ['win5','Eel Tamer','win 5 spins',150,s=>s.stats.winsCt>=5],
  ['big1k','High Roller','a single win worth 1,000+',250,s=>s.stats.bestWin>=1000],
  ['dex5','Collector','5 species in the Fishdex',150,s=>Object.keys(s.dex).length>=5],
  ['dexAll','Completionist','every species in the Fishdex',2000,s=>Object.keys(s.dex).length>=ALL_FISH.length],
  ['world2','Set Sail','unlock a second island',400,s=>s.worlds.length>=2],
  ['world4','Archipelago','unlock every island',5000,s=>s.worlds.length>=4],
  ['boat1','Shipwright','build your first real boat',150,s=>s.boatLvl>=1],
  ['boat4','Admiral of the Isles','launch the Gilded Galleon',2500,s=>s.boatLvl>=4]];
/* ---- ISLE LEDGER: purely fictional blockchain-styled deeds of record.
   No wallet, no chain, no real value — a trophy wall with hash cosplay. ---- */
const DEEDS=[
  ['d_arrive','Deed of Arrival','first catch or ore on the isle',s=>s.stats.caught+s.stats.mined>=1],
  ['d_leg','Legendary Angler','land a legendary fish',s=>Object.keys(s.dex).some(n=>{const e=ALL_FISH.find(x=>x[0].name===n);return e&&e[0].rar==='legendary';})],
  ['d_w2','Charter · Great Mine','claim the second island',s=>s.worlds.includes('mine')],
  ['d_w3','Charter · Cinder Atoll','claim the volcanic isle',s=>s.worlds.includes('volcano')],
  ['d_w4','Charter · Frostbite','claim the frozen isle',s=>s.worlds.includes('frost')],
  ['d_rod','Poseidon\'s Patent','forge the Poseidon Rod',s=>s.rodLvl>=10],
  ['d_pick','Titan Mining Rights','forge the Titan Pick',s=>s.pickLvl>=10],
  ['d_axe','Timber Baron\'s Seal','forge the Titan Axe',s=>s.axeLvl>=10],
  ['d_eel','Meme Lord Certificate','hold 25+ EEL shares at once',s=>(s.stocks.own.EEL|0)>=25],
  ['d_div','Dividend Baron','collect ◈1,000 in dividends',s=>s.stats.divEarned>=1000],
  ['d_win','Whale of the Eel','win ◈2,500+ on a single spin',s=>s.stats.bestWin>=2500],
  ['d_dex','Master of the Dex','complete the entire Fishdex',s=>Object.keys(s.dex).length>=ALL_FISH.length]];
function deedHash(id){ let seed=0; for(let i=0;i<id.length;i++)seed+=id.charCodeAt(i)*(i+7);
  const mint=state.deeds[id]||0; let out='';
  for(let k=0;k<20;k++)out+=((hash(seed+mint,k*13.7)*16)|0).toString(16);
  return '0x'+out; }
function checkDeeds(){ let minted=false;
  for(const [id,name] of DEEDS){ if(state.deeds[id])continue;
    const d=DEEDS.find(x=>x[0]===id);
    if(!d[3](state))continue;
    state.deeds[id]=mktEpochNow(); minted=true;
    toast(`📜 Deed minted on the Isle Ledger: ${name}`,'gold'); addShake(0.12); sfx.ach(); }
  if(minted){ save(); if(invOpen)renderInv(); } }
let achT=0;
function checkAch(){ for(const [id,name,desc,rw,chk] of ACH){
  if(state.ach[id]||!chk(state))continue;
  state.ach[id]=1; state.coins+=rw;
  toast(`${pixSVG('trophy',13)} ${name} · +◈${fmt(rw)}`,'gold'); coinFly(rw); sfx.ach(); RF.emit('ach',id,name,rw);
  updateHUD(); save(); } }

/* ========================================================================
   10. MARKET (fish · ores · upgrades)
   ======================================================================== */
let marketOpen=false;
const marketEl=document.getElementById('market'),marketList=document.getElementById('marketList'),
  oreList=document.getElementById('oreList'),upgList=document.getElementById('upgList'),mktBanner=document.getElementById('mktBanner');
function renderBanner(){ const m=mktMods(), left=MKT_MS-(Date.now()%MKT_MS), mm=Math.floor(left/60000), ss=Math.floor(left/1000)%60;
  let tip='';
  if(state.tipEpoch===mktEpochNow()+1){ const t=mktModsAt(state.tipEpoch);
    tip=`<br><span style="color:var(--teal)">◉ TIP · next: HOT ${catLabel(t.hot)} · SURPLUS ${catLabel(t.cold)}</span>`; }
  mktBanner.innerHTML=`<span class="mkthot">▲ HOT: ${catLabel(m.hot)} ×1.6</span> · <span class="mktcold">▼ SURPLUS: ${catLabel(m.cold)} ×0.75</span>
    <span style="color:var(--faint)"> · rotates in ${mm}:${String(ss).padStart(2,'0')}</span>${tip}`; }
function renderMarket(){ if(!state.bucket.length){marketList.innerHTML='<div class="empty">Your bucket is empty. Go catch something!</div>';return;}
  const pm=priceMult('fish');
  let h=''; state.bucket.forEach((f,i)=>{h+=`<div class="fishrow">${pixFish(RAR[f.rar],18)}
    <span class="nm">${f.name} ${f.wins?`<span class="hot">${'★'.repeat(Math.min(f.wins,5))} ×${Math.pow(2,f.wins)}</span>`:''}</span>
    <span class="rr" style="color:${RAR[f.rar]}">${f.rar}</span><span class="vv">◈ ${fmt(f.val*pm)}</span><button class="btn" data-sellone="${i}">Sell</button></div>`;});
  marketList.innerHTML=h; }
function renderOres(){ const any=Object.values(state.ores).some(v=>v>0);
  if(!any){oreList.innerHTML='<div class="empty">No ores yet · find rocks with colored chunks and hold E.</div>';return;}
  let h=''; for(const k in ORE_INFO){ const n=state.ores[k]; if(!n)continue; const info=ORE_INFO[k];
    h+=`<div class="fishrow">${oreIcon(k,16)}
      <span class="nm">${info.name} <span style="color:var(--muted)">×${n}</span></span>
      <span class="vv">◈ ${fmt(Math.round(info.price*n*priceMult(k)*(n>=100?1.15:n>=50?1.1:n>=20?1.05:1)))}${n>=20?`<small style="color:var(--teal)"> bulk +${n>=100?15:n>=50?10:5}%</small>`:''}</span><button class="btn" data-sellore="${k}">Sell all</button></div>`; }
  oreList.innerHTML=h; }
function renderUpg(){
  const row=(kind,lvl,base,names)=>{ const nxt=lvl+1,
    cost=kind==='axe'?axeCost(lvl):upCost(base,lvl),
    req=(kind==='axe'?AXE_REQ:UP_REQ)[nxt];
    if(lvl>=MAXLVL)return `<div class="fishrow"><span class="nm">${pixSVG(kind==='rod'?'rod':kind==='axe'?'axe':'pick',14)} ${names[lvl]} <span style="color:var(--teal)">Lv.${lvl}</span></span><span class="rr" style="color:var(--gold)">MAX</span></div>`;
    const can=state.coins>=cost&&haveOres(req);
    /* the rod row spells out what the craft actually buys: rarer fish */
    const gain=kind==='rod'?` · luck +${rodLuck(lvl).toFixed(2)} → <b style="color:var(--gold)">+${rodLuck(nxt).toFixed(2)}</b>`:'';
    return `<div class="fishrow"><span class="nm">${pixSVG(kind==='rod'?'rod':kind==='axe'?'axe':'pick',14)} ${names[lvl]} <span style="color:var(--teal)">Lv.${lvl}</span>
        <span style="color:var(--faint);font-size:11px">→ ${names[nxt]} · needs ${reqLabel(req)}${gain}</span></span>
      <span class="vv">◈ ${fmt(cost)}</span><button class="btn gold" data-buy="${kind}" ${can?'':'disabled'}>Craft</button></div>`; };
  upgList.innerHTML=row('rod',state.rodLvl,ROD_BASE,ROD_NAMES)+row('pick',state.pickLvl,PICK_BASE,PICK_NAMES)+row('axe',state.axeLvl,AXE_BASE,AXE_NAMES)+renderWorldRows(); }
/* Bait Shack — buy by the pack with coins, click a stocked bait to hook it.
   The luck line is the honest number: what this bait adds on top of your rod. */
function renderBait(){ if(!baitList)return;
  const rl=rodLuck(state.rodLvl);
  let h=`<div class="fishrow"><span class="nm">${pixSVG('rod',14)} ${ROD_NAMES[state.rodLvl]} <span style="color:var(--teal)">Lv.${state.rodLvl}</span>
      <span style="color:var(--faint);font-size:11px">rod luck +${rl.toFixed(2)}${state.rodLvl<MAXLVL?` · Lv.${state.rodLvl+1} would be +${rodLuck(state.rodLvl+1).toFixed(2)}`:' · MAX'}</span></span>
    <span class="rr" style="color:var(--gold)">total luck +${fishLuck().toFixed(2)}</span></div>`;
  for(const id of BAIT_ORDER){ const b=BAITS[id], n=state.bait[id]|0, on=state.baitId===id&&n>0;
    const per=Math.round(b.cost/b.pack), floor=b.min?`never under <b style="color:${RAR[b.min]}">${b.min}</b>`:'no floor';
    h+=`<div class="fishrow"${on?' style="outline:1px solid var(--gold);outline-offset:-1px"':''}>
      <span class="baitpip" style="background:${b.tint};color:${b.tint}"></span>
      <span class="nm">${b.name} <span style="color:var(--faint);font-size:10px">${b.sub}</span>
        <span style="display:block;font-size:10px;color:var(--muted)">luck +${b.luck.toFixed(1)} · ${floor}${b.shiny>1?` · shiny ×${b.shiny}`:''} · ◈${per}/fish</span></span>
      <span class="vv" style="color:${n?'var(--teal)':'var(--faint)'}">×${n}</span>
      <button class="btn" data-baiteq="${id}" ${n?'':'disabled'}>${on?'ON HOOK':'Use'}</button>
      <button class="btn gold" data-baitbuy="${id}" ${state.coins<b.cost?'disabled':''}>◈${fmt(b.cost)} / ${b.pack}</button></div>`; }
  baitList.innerHTML=h; }
function renderWorldRows(){
  let h='<div class="seclab" style="margin-top:14px">'+pixSVG('boat',12)+' Harbor · sail to another island</div>';
  for(const k of WORLD_ORDER){ const w=WORLDS[k];
    if(k===worldKey){ h+=`<div class="fishrow"><span class="nm">${pixSVG('island',15)} ${w.name} <span style="color:var(--faint)">${w.sub}</span></span><span class="rr" style="color:var(--teal)">YOU ARE HERE</span></div>`; }
    else if(state.worlds.includes(k)){ h+=`<div class="fishrow"><span class="nm">${pixSVG('island',15)} ${w.name} <span style="color:var(--faint)">${w.sub}</span></span><button class="btn" data-world="${k}">SAIL</button></div>`; }
    else { const br=BOAT_REQ[k]||0, okBoat=state.boatLvl>=br;
      h+=`<div class="fishrow"><span class="nm">${pixSVG('lock',15)} ${w.name} <span style="color:var(--faint)">${w.sub}${okBoat?'':` · needs ${BOATS[br].name}`}</span></span><span class="vv">◈ ${fmt(w.cost)}</span><button class="btn gold" data-world="${k}" ${state.coins<w.cost||!okBoat?'disabled':''}>Unlock</button></div>`; } }
  return h; }
function buyOrSail(k){ const w=WORLDS[k]; if(!w||k===worldKey)return;
  if(SRV.on){ SRV.act('travel',{world:k}).then(r=>{ if(!r)return;
      if(r.unlocked){ sfx.win(); addShake(0.1); toast(pixSVG('island',13)+' '+w.name+' unlocked!','gold'); return; }
      try{localStorage.setItem('reelfortune3d-world',k);}catch(e){}
      sfx.sail(); toast(pixSVG('boat',13)+' Sailing to '+w.name+'…','good');
      setTimeout(()=>location.reload(),600); });
    return; }
  if(!state.worlds.includes(k)){
    const br=BOAT_REQ[k]||0;
    if(state.boatLvl<br){ sfx.deny(); toast('Your '+BOATS[state.boatLvl].name+" can't make that voyage · see the Harbor dock",'bad'); return; }
    if(state.coins<w.cost){ sfx.deny(); return; }
    state.coins-=w.cost; state.worlds.push(k); sfx.win(); addShake(0.1);
    toast(pixSVG('island',13)+' '+w.name+' unlocked!','gold'); updateHUD(); renderUpg(); save(); return; }
  save(); try{localStorage.setItem('reelfortune3d-world',k);}catch(e){}
  sfx.sail(); toast(pixSVG('boat',13)+' Sailing to '+w.name+'…','good');
  setTimeout(()=>location.reload(),600); }
// the portal hops to the next unlocked isle in order (null while only one is unlocked)
function portalDest(){ const un=WORLD_ORDER.filter(k=>state.worlds.includes(k));
  if(un.length<2)return null; return un[(un.indexOf(worldKey)+1)%un.length]; }
// the mine shaft is the door to The Undermine cave; climbing out returns to the isle you came from
function caveReturn(){ let r='isle'; try{ const v=localStorage.getItem('reelfortune3d-return'); if(v&&WORLDS[v]&&v!=='cave')r=v; }catch(e){} return r; }
function caveTravel(){ initAudio();
  // first descent costs coins: pay once to open the shaft, then travel is free forever
  if(!WORLD.cave&&!state.worlds.includes('cave')){ const c=WORLDS.cave.cost;
    if(state.coins<c){ toast('Need ◈ '+fmt(c)+' to open the mine shaft','bad'); sfx.miss(); return; }
    if(SRV.on){ // buying the shaft must go through the server, or the reload bounces us back out
      SRV.act('travel',{world:'cave'}).then(r=>{ if(!r)return; sfx.win();
        toast(pixSVG('pick',13)+' Mine shaft opened · ◈ '+fmt(c),'gold');
        setTimeout(caveTravel,400); });
      return; }
    state.coins-=c; state.worlds.push('cave'); updateHUD(); sfx.win();
    toast(pixSVG('pick',13)+' Mine shaft opened · ◈ '+fmt(c),'gold'); }
  if(SRV.on){ // tell the server which isle we are standing on before the reload
    const dest=WORLD.cave?caveReturn():'cave';
    sfx.door(); SRV.act('travel',{world:dest}).then(()=>{
      try{ localStorage.setItem('reelfortune3d-world',dest); }catch(e){}
      setTimeout(()=>location.reload(),400); });
    return; }
  save();
  const back=caveReturn();
  try{ if(WORLD.cave){ localStorage.setItem('reelfortune3d-world',back); }
    else { localStorage.setItem('reelfortune3d-return',worldKey); localStorage.setItem('reelfortune3d-world','cave'); } }catch(e){}
  sfx.door(); toast(pixSVG('pick',13)+(WORLD.cave?' Climbing back to '+WORLDS[back].name+'…':' Descending into The Undermine…'),'good');
  setTimeout(()=>location.reload(),600); }
/* ---- ISLE EXCHANGE panel ---- */
const stockList=document.getElementById('stockList'),kioskList=document.getElementById('kioskList'),
  baitList=document.getElementById('baitList');
function renderStocks(){ if(!stockList)return; const e=mktEpochNow(); let h='';
  for(const k of STOCK_KEYS){ const s=STOCKS[k],p=stockPrice(k,e),prev=stockPrice(k,e-1);
    const dl=(p-prev)/prev*100, up=dl>=0, own=state.stocks.own[k]|0, ask=stockAsk(k,e), bid=stockBid(k,e);
    h+=`<div class="fishrow">${pixSVG('chart',16)}
      <span class="nm">${k} <span style="color:var(--faint);font-size:10px">${s.name}${s.yield?` · div ${(s.yield*100).toFixed(1)}%/hr`:' · no dividend'}</span><br>
        <span style="font-size:10px;color:${up?'var(--teal)':'var(--rose)'}">${up?'▲':'▼'} ${Math.abs(dl).toFixed(1)}%</span>
        <span style="font-size:10px;color:var(--muted)"> · own ${own}${own?` · avg ◈${fmt(state.stocks.basis[k]||p)}`:''}</span></span>
      <canvas class="spark" data-stk="${k}" width="90" height="24"></canvas>
      <span class="vv">◈ ${fmt(ask)}</span>
      <button class="btn gold" data-buystk="${k}" ${state.coins<ask||own>=STOCK_CAP?'disabled':''}>Buy</button>
      <button class="btn" data-sellstk="${k}" ${own?'':'disabled'}>Sell ◈${fmt(bid)}</button></div>`; }
  stockList.innerHTML=h;
  stockList.querySelectorAll('canvas.spark').forEach(c=>{ const k=c.getAttribute('data-stk'),g=c.getContext('2d');
    const pts=[]; let mn=1e9,mx=0;
    for(let i=31;i>=0;i--){ const v=stockPrice(k,e-i); pts.push(v); mn=Math.min(mn,v); mx=Math.max(mx,v); }
    const up=pts[31]>=pts[0]; g.strokeStyle=up?'#74e08a':'#ff5d7a'; g.lineWidth=1.5; g.beginPath();
    pts.forEach((v,i)=>{ const x=1+i/31*86, y=22-((v-mn)/Math.max(1,mx-mn))*19; i?g.lineTo(x,y):g.moveTo(x,y); });
    g.stroke(); g.fillStyle=g.strokeStyle;
    g.fillRect(87,21-((pts[31]-mn)/Math.max(1,mx-mn))*19,3,3); }); }
/* ---- PEARL KIOSK ---- */
const WPAL=[0xd8483f,0xffd24f,0x2ba394,0x57b7ff,0xc07bff,0xf2f2f2,0x2e3338,0xff8f3d];
const BUCKET_COST=[150,300,600,1000];
const WDEF={band:0xd8483f,scarf:0xd8483f,vest:0x2ba394}; // makeHero defaults
function applyWardrobe(){ const m=player.userData.mats; if(!m)return;
  for(const slot of ['band','scarf','vest']){ const i=state.wardrobe[slot];
    m[slot].color.setHex(i!=null&&WPAL[i]!=null?WPAL[i]:WDEF[slot]); } }
let titleSprite=null;
function applyTitle(){
  if(titleSprite){ titleSprite.material.map.dispose(); titleSprite.material.dispose();
    scene.remove(titleSprite); titleSprite=null; }
  if(!state.titleId)return;
  titleSprite=makeLabel(state.titleId,'#7fdcff',false); titleSprite.scale.set(2.3,0.58,1);
  titleSprite.position.set(pWorld.x,pWorld.y+2.95,pWorld.z);
  scene.add(titleSprite); }
const KIOSK_TITLES=[['t1','Deckhand',50],['t2','Pearl Diver',150],['t3','Eel Whisperer',500],['t4','Isle Legend',2500]];
function renderKiosk(){ if(!kioskList)return; let h='';
  // wardrobe: buy once, then recolor freely
  if(!state.ownedW.wardrobe)
    h+=`<div class="fishrow"><span class="nm">Hero Wardrobe <span style="color:var(--faint);font-size:10px">recolor hat band · scarf · vest, any time</span></span>
      <span class="vv" style="color:var(--teal)">◉ 80</span><button class="btn" data-kiosk="wardrobe" ${state.pearls<80?'disabled':''}>Buy</button></div>`;
  else for(const slot of ['band','scarf','vest'])
    h+=`<div class="swatchrow"><span class="sl">${slot}</span>${WPAL.map((c,i)=>
      `<button class="sw${state.wardrobe[slot]===i?' sel':''}" data-wcol="${slot}:${i}" style="background:#${c.toString(16).padStart(6,'0')}"></button>`).join('')}</div>`;
  for(const [id,name,cost] of KIOSK_TITLES){
    const owned=state.ownedT[id], eq=state.titleId===name;
    h+=`<div class="fishrow"><span class="nm">Title: “${name}”</span>
      ${owned?`<button class="btn ${eq?'gold':''}" data-title="${id}">${eq?'EQUIPPED':'Equip'}</button>`
        :`<span class="vv" style="color:var(--teal)">◉ ${cost}</span><button class="btn" data-kiosk="${id}" ${state.pearls<cost?'disabled':''}>Buy</button>`}</div>`; }
  const chumOn=Date.now()<state.boosts.chumUntil;
  h+=`<div class="fishrow"><span class="nm">Chum Jar <span style="color:var(--faint);font-size:10px">bites 2× faster · 10 min${chumOn?' · ACTIVE':''}</span></span>
    <span class="vv" style="color:var(--teal)">◉ 80</span><button class="btn" data-kiosk="chum" ${state.pearls<80||chumOn?'disabled':''}>${chumOn?'Active':'Buy'}</button></div>`;
  const bt=state.bucketTier;
  h+=bt>=4?`<div class="fishrow"><span class="nm">Deep Bucket <span style="color:var(--teal)">cap ${cap()}</span></span><span class="rr" style="color:var(--gold)">MAX</span></div>`
    :`<div class="fishrow"><span class="nm">Deep Bucket <span style="color:var(--faint);font-size:10px">bucket ${cap()} → ${cap()+2} (permanent)</span></span>
      <span class="vv" style="color:var(--teal)">◉ ${BUCKET_COST[bt]}</span><button class="btn" data-kiosk="bucket" ${state.pearls<BUCKET_COST[bt]?'disabled':''}>Buy</button></div>`;
  h+=`<div class="fishrow"><span class="nm">Insider Tip <span style="color:var(--faint);font-size:10px">reveal the NEXT market rotation</span></span>
    <span class="vv" style="color:var(--teal)">◉ 30</span><button class="btn" data-kiosk="tip" ${state.pearls<30?'disabled':''}>Buy</button></div>`;
  h+=state.pet?`<div class="fishrow"><span class="nm">Spirit Fish <span style="color:var(--faint);font-size:10px">it swims at your shoulder</span></span><span class="rr" style="color:var(--teal)">OWNED</span></div>`
    :`<div class="fishrow"><span class="nm">Spirit Fish <span style="color:var(--faint);font-size:10px">a glowing companion that follows you everywhere</span></span>
      <span class="vv" style="color:var(--teal)">◉ 400</span><button class="btn" data-kiosk="pet" ${state.pearls<400?'disabled':''}>Buy</button></div>`;
  h+=state.charm?`<div class="fishrow"><span class="nm">Lucky Charm <span style="color:var(--faint);font-size:10px">re-rolls 1 losing spin in 5</span></span><span class="rr" style="color:var(--teal)">OWNED</span></div>`
    :`<div class="fishrow"><span class="nm">Lucky Charm <span style="color:var(--faint);font-size:10px">the wheel re-rolls one losing spin in five</span></span>
      <span class="vv" style="color:var(--teal)">◉ 600</span><button class="btn" data-kiosk="charm" ${state.pearls<600?'disabled':''}>Buy</button></div>`;
  kioskList.innerHTML=h; }
/* --- BOUNTY BOARD: three objectives that reroll every market epoch ---------- */
const BOUNTY_POOL=[
  ['catch','Land {n} fish',       [6,10,16],   [400,700,1200]],
  ['mine', 'Mine {n} ore',        [8,14,22],   [450,800,1400]],
  ['wood', 'Chop {n} wood',       [6,12,20],   [350,650,1100]],
  ['spin', 'Take {n} spins',      [3,6,10],    [500,900,1500]],
  ['rare', 'Land {n} rare-or-better', [2,4,7], [700,1300,2200]],
];
// bounties key off lifetime counters, so progress is just "counter now − counter when issued"
function bountyCounter(kind){ const st=state.stats;
  return kind==='catch'?st.caught:kind==='mine'?st.mined:kind==='wood'?(st.wood||0):kind==='spin'?st.spins:rareCaught; }
let rareCaught=0;
function rollBounties(){ const epoch=mktEpochNow();
  const pool=BOUNTY_POOL.slice().sort(()=>Math.random()-0.5).slice(0,3);
  state.bounty={epoch,list:pool.map(([kind,label,ns,rw])=>{ const t=(Math.random()*3)|0;
    return {kind,label:label.replace('{n}',ns[t]),need:ns[t],reward:rw[t],base:bountyCounter(kind),done:0}; })};
  state.bountyEpoch=epoch; }
function checkBounties(){
  if(!state.bounty||state.bounty.epoch!==mktEpochNow())rollBounties();
  let changed=false;
  for(const b of state.bounty.list){ if(b.done)continue;
    if(bountyCounter(b.kind)-b.base>=b.need){ b.done=1; changed=true;
      state.coins+=b.reward; state.stats.earned+=b.reward; addPearls(5,'bounty'); coinFly(b.reward); sfx.win();
      toast(`${pixSVG('trophy',13)} Bounty complete · ◈${fmt(b.reward)}`,'gold'); } }
  if(changed){ updateHUD(); save(); if(marketOpen)renderBounties(); } }
function renderBounties(){ const el=document.getElementById('bountyList'); if(!el)return;
  if(!state.bounty)rollBounties();
  el.innerHTML=state.bounty.list.map(b=>{ const have=clamp(bountyCounter(b.kind)-b.base,0,b.need),
      k=Math.round(have/b.need*8);
    return `<div class="fishrow" style="${b.done?'opacity:.6':''}">${pixSVG('trophy',15)}
      <span class="nm">${b.label} <span style="color:var(--faint);font-size:10px">${have}/${b.need}</span></span>
      <span class="rr" style="color:var(--muted)"><b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b></span>
      <span class="vv" style="color:${b.done?'var(--teal)':'var(--gold)'}">${b.done?'✓ paid':'◈ '+fmt(b.reward)}</span></div>`; }).join(''); }
function renderMarketAll(){ renderMarket(); renderOres(); renderUpg(); renderBait(); renderStocks(); renderKiosk(); renderBounties(); }
function openMarket(){marketOpen=true; RF.emit('panel','market',true);sfx.open();marketEl.classList.add('on');renderBanner();renderMarketAll();}
function closeMarket(){marketOpen=false; RF.emit('panel','market',false);sfx.close();marketEl.classList.remove('on');save();}
document.getElementById('marketX').onclick=closeMarket;
document.getElementById('sellAll').onclick=()=>{ if(!state.bucket.length){toast('Bucket empty');return;}
  if(SRV.on){ SRV.act('sell',{kind:'allfish'}).then(r=>{ if(r&&r.gained){coinFly(r.gained);sfx.sell();
    toast('+'+fmt(r.gained)+' coins'+(r.kept?` (kept ${r.kept} ★)`:''),'gold');} }); return; }
  let g=0,kept=0; const pm=priceMult('fish');
  state.bucket=state.bucket.filter(f=>{ if(f.wins>0){kept++;return true;} g+=Math.round(f.val*pm); return false; });
  if(!g){toast(kept?'Only ★ starred fish left · sell them one by one':'Bucket empty');return;}
  state.coins+=g;state.stats.earned+=g;coinFly(g);sfx.sell();
  toast('+'+fmt(g)+' coins'+(kept?` (kept ${kept} ★)`:''),'gold');updateHUD();renderMarketAll();save();};
marketEl.addEventListener('click',e=>{
  const t1=e.target.closest?e.target.closest('[data-sellone]'):null;
  if(t1){const i=+t1.getAttribute('data-sellone'),f=state.bucket[i];
    if(SRV.on){ SRV.act('sell',{kind:'fish',index:i}).then(r=>{ if(r&&r.gained){coinFly(r.gained);sfx.sell();toast('+'+fmt(r.gained)+' coins','gold');} }); return; }
    if(f){const g=Math.round(f.val*priceMult('fish'));state.coins+=g;state.stats.earned+=g;state.bucket.splice(i,1);sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderMarketAll();save();} return;}
  const t2=e.target.closest?e.target.closest('[data-sellore]'):null;
  if(t2){const k=t2.getAttribute('data-sellore'),n=state.ores[k];
    if(SRV.on){ SRV.act('sell',{kind:'ore',oreKey:k}).then(r=>{ if(r&&r.gained){coinFly(r.gained);sfx.sell();toast('+'+fmt(r.gained)+' coins','gold');} }); return; }
    if(n>0){const bulk=n>=100?1.15:n>=50?1.1:n>=20?1.05:1;   // big hauls beat trickle-trading
      const g=Math.round(n*ORE_INFO[k].price*priceMult(k)*bulk);state.coins+=g;state.stats.earned+=g;state.ores[k]=0;sfx.sell();
      toast('+'+fmt(g)+' coins'+(bulk>1?` · bulk +${Math.round((bulk-1)*100)}%`:''),'gold');updateHUD();renderMarketAll();save();} return;}
  const t3=e.target.closest?e.target.closest('[data-buy]'):null;
  if(t3){const kind=t3.getAttribute('data-buy');
    if(SRV.on){ SRV.act('craft',{tool:kind}).then(r=>{ if(r&&r.name){sfx.craft();addShake(0.1);
      toast(pixSVG(kind==='rod'?'rod':kind==='axe'?'axe':'pick',13)+' '+r.name+' crafted!','gold');} }); return; }
    const doCraft=(lvlKey,base,names)=>{ const lvl=state[lvlKey]; if(lvl>=MAXLVL)return;
      const cost=lvlKey==='axeLvl'?axeCost(lvl):upCost(base,lvl),
        req=(lvlKey==='axeLvl'?AXE_REQ:UP_REQ)[lvl+1];
      if(state.coins<cost||!haveOres(req))return;
      state.coins-=cost; for(const k in req)state.ores[k]-=req[k];
      state[lvlKey]=lvl+1; sfx.craft(); addShake(0.1); toast(pixSVG(lvlKey==='rodLvl'?'rod':'pick',13)+' '+names[lvl+1]+' crafted!','gold'); };
    if(kind==='rod')doCraft('rodLvl',ROD_BASE,ROD_NAMES);
    else if(kind==='pick')doCraft('pickLvl',PICK_BASE,PICK_NAMES);
    else if(kind==='axe')doCraft('axeLvl',AXE_BASE,AXE_NAMES);
    updateHUD();renderMarketAll();save(); return;}
  const tbb=e.target.closest?e.target.closest('[data-baitbuy]'):null;
  if(tbb){ const id=tbb.getAttribute('data-baitbuy'), b=baitOf(id); if(!b)return;
    if(SRV.on){ SRV.act('bait',{op:'buy',id,packs:1}).then(r=>{ if(r){ sfx.sell();
      toast(`${pixSVG('fish',13)} +${r.count} ${r.name}`,'good'); } }); return; }
    const have=state.bait[id]|0;
    if(have+b.pack>BAIT_MAX){ toast(`You cannot carry any more ${b.name}`,'bad'); return; }
    if(state.coins<b.cost){ toast('Not enough coins','bad'); return; }
    state.coins-=b.cost; state.bait[id]=have+b.pack;
    if(!state.baitId)state.baitId=id;                    // your first bait goes straight on the hook
    sfx.sell(); toast(`${pixSVG('fish',13)} +${b.pack} ${b.name}`,'good');
    updateHUD(); renderMarketAll(); save(); return;}
  const tbe=e.target.closest?e.target.closest('[data-baiteq]'):null;
  if(tbe){ const id=tbe.getAttribute('data-baiteq');
    if(SRV.on){ SRV.act('bait',{op:'equip',id}).then(r=>{ if(r)toast(r.baitId?`${BAITS[r.baitId].name} on the hook`:'Bare hook','good'); }); return; }
    if(!(state.bait[id]>0))return;
    state.baitId=state.baitId===id?'':id;                // clicking the hooked bait takes it back off
    toast(state.baitId?`${BAITS[id].name} on the hook`:'Bare hook','good');
    updateHUD(); renderMarketAll(); save(); return;}
  const t4=e.target.closest?e.target.closest('[data-world]'):null;
  if(t4){buyOrSail(t4.getAttribute('data-world'));return;}
  const t5=e.target.closest?e.target.closest('[data-buystk]'):null;
  if(t5){ const k=t5.getAttribute('data-buystk'),ep=mktEpochNow(),a=stockAsk(k,ep),st=state.stocks;
    if(SRV.on){ SRV.act('stock',{op:'buy',ticker:k}).then(r=>{ if(r){sfx.sell();toast('+1 share '+k,'good');} }); return; }
    if(state.coins>=a&&(st.own[k]|0)<STOCK_CAP){ state.coins-=a;
      const n=st.own[k]|0,p=stockPrice(k,ep);
      st.basis[k]=((st.basis[k]||p)*n+p)/(n+1); st.own[k]=n+1;
      sfx.sell(); toast('+1 share '+k,'good'); updateHUD(); renderMarketAll(); save(); } return;}
  const t6=e.target.closest?e.target.closest('[data-sellstk]'):null;
  if(t6){ const k=t6.getAttribute('data-sellstk'),ep=mktEpochNow(),st=state.stocks;
    if(SRV.on){ SRV.act('stock',{op:'sell',ticker:k}).then(r=>{ if(r&&r.gained){sfx.sell();coinFly(r.gained);toast('Sold 1 '+k+' for ◈'+fmt(r.gained),'gold');} }); return; }
    if((st.own[k]|0)>0){ const g=stockBid(k,ep);
      st.own[k]--; state.coins+=g;
      state.stats.earned+=Math.max(0,g-Math.round(st.basis[k]||g)); // only real profit counts toward records
      sfx.sell(); coinFly(g); toast('Sold 1 '+k+' for ◈'+fmt(g),'gold'); updateHUD(); renderMarketAll(); save(); } return;}
  const t7=e.target.closest?e.target.closest('[data-kiosk]'):null;
  if(t7){ const id=t7.getAttribute('data-kiosk');
    if(SRV.on){ SRV.act('kiosk',{item:id}).then(r=>{ if(r){ sfx.ore(); if(r.message)toast(r.message,'good');
      applyWardrobe(); applyTitle(); } }); return; }
    const buy=(cost,fn)=>{ if(state.pearls<cost)return; state.pearls-=cost; fn(); sfx.ore(); updateHUD(); renderMarketAll(); save(); };
    if(id==='wardrobe')buy(80,()=>{state.ownedW.wardrobe=1;toast('Wardrobe unlocked · pick your colors!','good');});
    else if(id==='chum')buy(80,()=>{state.boosts.chumUntil=Date.now()+600000;toast('Chum in the water · bites 2× faster for 10 min','good');});
    else if(id==='bucket'&&state.bucketTier<4)buy(BUCKET_COST[state.bucketTier],()=>{state.bucketTier++;toast('Deep Bucket! Capacity is now '+cap(),'good');});
    else if(id==='tip')buy(30,()=>{state.tipEpoch=mktEpochNow()+1;renderBanner();const m=mktModsAt(mktEpochNow()+1);
      toast(`Tip: next HOT ${catLabel(m.hot)} · SURPLUS ${catLabel(m.cold)}`,'gold');});
    else if(id==='pet')buy(400,()=>{state.pet=1;toast('A Spirit Fish drifts to your side…','gold');});
    else if(id==='charm')buy(600,()=>{state.charm=1;toast('🍀 Lucky Charm · the wheel likes you now','gold');});
    else{ const t=KIOSK_TITLES.find(x=>x[0]===id);
      if(t)buy(t[2],()=>{state.ownedT[id]=1;state.titleId=t[1];applyTitle();toast('Title equipped: '+t[1],'good');}); }
    return;}
  const t8=e.target.closest?e.target.closest('[data-title]'):null;
  if(t8){ const t=KIOSK_TITLES.find(x=>x[0]===t8.getAttribute('data-title'));
    if(t&&state.ownedT[t[0]]){ state.titleId=state.titleId===t[1]?'':t[1]; applyTitle(); renderKiosk(); save(); } return;}
  const t9=e.target.closest?e.target.closest('[data-wcol]'):null;
  if(t9){ const [slot,i]=t9.getAttribute('data-wcol').split(':');
    if(state.ownedW.wardrobe){ state.wardrobe[slot]=+i; applyWardrobe(); renderKiosk(); save(); } return;} });

/* ========================================================================
   10b. THE HARBOR — shipwright panel with a live 3D boat preview
   ======================================================================== */
let harborOpen=false,previewLvl=0;
const harborEl=document.getElementById('harbor'),boatCurEl=document.getElementById('boatCur'),
  boatListEl=document.getElementById('boatList'),sailListEl=document.getElementById('sailList'),
  dockViewEl=document.getElementById('dockView'),dockCapEl=document.getElementById('dockCap'),
  crewPanelEl=document.getElementById('crewPanel');
const dockScene=new THREE.Scene();
const dockCam=new THREE.PerspectiveCamera(30,320/180,0.1,40); dockCam.position.set(4.6,3.1,6.2); dockCam.lookAt(0,0.8,0);
dockScene.add(new THREE.HemisphereLight(0xffffff,0x1c3038,1.0));
{ const k=new THREE.DirectionalLight(0xfff2d8,0.95); k.position.set(3,5,3.5); dockScene.add(k);
  const r=new THREE.DirectionalLight(0x9fd8ff,0.45); r.position.set(-3,2,-3); dockScene.add(r); }
{ const sea=new THREE.Mesh(new THREE.CircleGeometry(3.6,26),
    new THREE.MeshLambertMaterial({color:0x2fc0e8,transparent:true,opacity:0.55}));
  sea.rotation.x=-Math.PI/2; sea.position.y=-0.03; dockScene.add(sea); }
let dockRenderer=null;
try{ dockRenderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  dockRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); dockRenderer.setSize(320,180);
  if(dockViewEl)dockViewEl.appendChild(dockRenderer.domElement); }catch(e){}
let previewBoat=null,dockT=0;
const BOAT_VIEW=[1.5,1.4,1.12,0.95,0.78]; // per-tier zoom so every hull fills the frame
function buildPreview(lvl){ previewLvl=lvl;
  if(previewBoat){ previewBoat.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material&&o.material.dispose)o.material.dispose();}); dockScene.remove(previewBoat); }
  previewBoat=makeBoat(lvl); previewBoat.scale.setScalar(BOAT_VIEW[lvl]||1); dockScene.add(previewBoat);
  if(dockCapEl)dockCapEl.innerHTML=`${BOATS[lvl].name} · <span style="color:var(--muted)">${BOATS[lvl].sub}</span>`+
    ` <span style="color:var(--teal)">· ${seatLabel(lvl)}</span>${lvl>state.boatLvl?' <span style="color:var(--faint)">· preview</span>':''}`; }
function renderDockView(dt){ if(!dockRenderer||!previewBoat)return; dockT+=dt;
  previewBoat.rotation.y=dockT*0.45; previewBoat.position.y=Math.sin(dockT*1.4)*0.045;
  previewBoat.rotation.z=Math.sin(dockT*0.9)*0.02;
  animBoat(previewBoat,dockT);
  dockRenderer.render(dockScene,dockCam); }
/* ========================================================================
   CREW — a hull seats a fixed number of hands, the captain included, so a
   Driftwood Raft (1 seat) sails alone and a Gilded Galleon carries nine
   guests. Berths are GRANTED, never taken: a sailor knocks with "ask to
   board" and only the captain's ADMIT seats them.

   The server owns the manifest — this panel is a view over /api/crew plus
   six intents. Offline it degrades to a note about what the hull could hold.
   ======================================================================== */
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let crewInfo=null,     // last /api/crew payload
    crewCaps=null,     // last /api/crew/captains list
    crewBusy=false,    // one intent in flight at a time
    crewNote='',       // last error, shown above the rows
    crewTimer=0;
const crewOnline=()=>!!(window.RFNet&&RFNet.online);

// captain's berth first (gold), then the berths in use, then the empty ones
function seatPips(seats,taken){ let h=`<span class="seats" title="${seats} seats">`;
  for(let i=0;i<Math.min(seats,12);i++)h+=`<i class="${i===0?'cap':i<=taken?'on':''}"></i>`;
  return h+'</span>'; }

function renderCrew(){ if(!crewPanelEl)return;
  let h='<div class="seclab" style="margin-top:14px">'+pixSVG('crew',12)+' Crew · the captain admits every hand aboard</div>';

  if(!crewOnline()){
    const lvl=state.boatLvl;
    h+=`<div class="crewnote">Your ${BOATS[lvl].name} ${seatPips(boatSeats(lvl),0)} — ${seatLabel(lvl)}.
      Crews are kept on the server: sign in from the title screen to ask for a berth or take hands aboard.</div>`;
    crewPanelEl.innerHTML=h; return; }

  if(crewNote)h+=`<div class="crewnote" style="color:var(--rose)">${esc(crewNote)}</div>`;
  const v=crewInfo;
  if(!v){ h+='<div class="crewnote">Reading the harbour register…</div>'; crewPanelEl.innerHTML=h; return; }

  if(v.berth){
    // --- sailing as someone else's guest: your own hull stays moored --------
    const b=v.berth, mates=b.crew.filter(m=>m.username!==v.you.username);
    h+=`<div class="fishrow" style="border-color:rgba(57,215,196,.45)">${pixSVG('boat',16)}
      <span class="nm">Aboard ${esc(b.captain)}'s ${esc(b.boat.name)} ${seatPips(b.boat.seats,b.crew.length)}
        <span style="color:var(--faint);font-size:11px">${b.crew.length+1}/${b.boat.seats} aboard · your own hull is moored while you sail as a guest</span></span>
      <span class="btns"><button class="btn rose" data-crew="leave">STEP ASHORE</button></span></div>`;
    h+=`<div class="fishrow">${pixSVG('crew',15)}<span class="nm">${esc(b.captain)}
        <span style="color:var(--gold);font-size:11px">captain</span></span></div>`;
    for(const m of mates)
      h+=`<div class="fishrow">${pixSVG('crew',15)}<span class="nm">${esc(m.username)}
        <span style="color:var(--faint);font-size:11px">shipmate</span></span></div>`;
  } else {
    // --- your own deck ------------------------------------------------------
    const seats=v.you.boat.seats, slots=v.you.slots, aboard=v.manifest.length;
    const line=slots
      ? `${aboard}/${slots} berths filled · you hold the wheel`
      : `a ${v.you.boat.name} seats one · build a Cork Dinghy to take a hand aboard`;
    h+=`<div class="fishrow" style="border-color:rgba(57,215,196,.45)">${pixSVG('boat',16)}
      <span class="nm">${esc(v.you.boat.name)} ${seatPips(seats,aboard)}
        <span style="color:var(--faint);font-size:11px">${line}</span></span>
      <span class="rr" style="color:var(--teal)">${aboard+1}/${seats}</span></div>`;

    for(const m of v.manifest)
      h+=`<div class="fishrow">${pixSVG('crew',15)}
        <span class="nm">${esc(m.username)} <span style="color:var(--faint);font-size:11px">crew</span></span>
        <span class="btns"><button class="btn rose" data-crew="kick" data-crewuser="${esc(m.username)}">PUT ASHORE</button></span></div>`;

    if(v.requests.length){
      const full=aboard>=slots;
      h+=`<div class="crewnote" style="color:var(--gold)">${v.requests.length} waiting at the gangway${full?' · no berth free until someone steps ashore':''}</div>`;
      for(const r of v.requests)
        h+=`<div class="fishrow" style="border-color:rgba(255,207,92,.45)">${pixSVG('crew',15)}
          <span class="nm">${esc(r.username)} <span style="color:var(--faint);font-size:11px">asks to board · sails a ${esc(r.boat.name)}</span></span>
          <span class="btns">
            <button class="btn gold" data-crew="admit" data-crewuser="${esc(r.username)}" ${full?'disabled':''}>ADMIT</button>
            <button class="btn rose" data-crew="deny" data-crewuser="${esc(r.username)}">DENY</button></span></div>`;
    }
  }

  // --- who else is moored here --------------------------------------------
  h+='<div class="seclab" style="margin-top:12px">Other captains · ask for a berth</div>';
  const blocked=v.berth?'You are already aboard a boat'
    :v.manifest.length?'Send your own crew ashore first'
    :'';
  if(blocked)h+=`<div class="crewnote">${blocked} · one berth per sailor.</div>`;
  if(!crewCaps||!crewCaps.length)h+='<div class="crewnote">No other captains have moored here yet.</div>';
  else for(const c of crewCaps){ const full=c.free<=0, yours=v.berth&&v.berth.captain===c.username;
    h+=`<div class="fishrow"${yours?' style="border-color:rgba(57,215,196,.45)"':''}>${pixSVG('boat',15)}
      <span class="nm">${esc(c.username)} ${seatPips(c.boat.seats,c.aboard)}
        <span style="color:var(--faint);font-size:11px">${esc(c.boat.name)} · ${c.aboard}/${c.slots} berths taken</span></span>
      ${yours?'<span class="rr" style="color:var(--teal)">YOUR BERTH</span>':`<span class="btns">${c.pending
        ? `<button class="btn" data-crew="cancel" data-crewuser="${esc(c.username)}">WAITING · CANCEL</button>`
        : `<button class="btn" data-crew="request" data-crewuser="${esc(c.username)}" ${blocked||full?'disabled':''}>${full?'FULL':'ASK TO BOARD'}</button>`}</span>`}</div>`; }

  crewPanelEl.innerHTML=h; }

/** Pull manifest + captain list together; the panel is useless with only one. */
async function crewRefresh(){
  if(!crewOnline()){ crewInfo=null; crewCaps=null; renderCrew(); return; }
  try{ const [v,c]=await Promise.all([RFNet.crew(),RFNet.crewCaptains()]);
    crewInfo=v; crewCaps=c.captains||[]; crewNote=''; }
  catch(e){ crewNote=e.message||'the harbour register is unreachable'; }
  if(harborOpen)renderCrew(); }

const CREW_SAID={admit:n=>`${n} is aboard`, deny:n=>`${n} turned away`, kick:n=>`${n} put ashore`,
  leave:()=>'Back on your own deck', request:n=>`Asked ${n} for a berth`, cancel:n=>`Withdrew your ask to ${n}`};

async function crewAct(kind,who){
  if(crewBusy||!crewOnline())return;
  const call={admit:()=>RFNet.crewAdmit(who), deny:()=>RFNet.crewDeny(who), kick:()=>RFNet.crewKick(who),
    leave:()=>RFNet.crewLeave(), request:()=>RFNet.crewRequest(who), cancel:()=>RFNet.crewCancel(who)}[kind];
  if(!call)return;
  crewBusy=true;
  try{
    crewInfo=await call(); crewNote='';
    toast(pixSVG('crew',13)+' '+esc(CREW_SAID[kind](who)), kind==='deny'||kind==='kick'?'bad':'good');
    if(kind==='admit'||kind==='leave'){ sfx.win(); addShake(0.08); }
    // the roster the buttons were drawn from is now stale
    try{ const c=await RFNet.crewCaptains(); crewCaps=c.captains||[]; }catch(e){}
  }catch(e){ crewNote=e.message||'that did not take'; toast(esc(crewNote),'bad'); }
  crewBusy=false; renderCrew(); }
function renderHarbor(){ if(!boatCurEl)return;
  const cur=BOATS[state.boatLvl], nxt=BOATS[state.boatLvl+1];
  let h=`<div class="fishrow">${pixSVG('boat',16)}
    <span class="nm">${cur.name} <span style="color:var(--teal)">Lv.${state.boatLvl}</span> ${seatPips(cur.seats,0)}
      <span style="color:var(--faint);font-size:11px">${cur.sub} · ${seatLabel(state.boatLvl)} · sea luck +${Math.round(cur.luck*100)}%</span></span>
    <span class="rr" style="color:var(--teal)">YOUR BOAT</span></div>`;
  if(nxt){ const can=state.coins>=nxt.cost&&haveOres(nxt.req);
    h+=`<div class="fishrow">${pixSVG('boat',16)}
      <span class="nm">${nxt.name} ${seatPips(nxt.seats,0)} <span style="color:var(--faint);font-size:11px">${nxt.sub} · ${seatLabel(state.boatLvl+1)} · needs ${reqLabel(nxt.req)} · sea luck +${Math.round(nxt.luck*100)}%</span></span>
      <span class="vv">◈ ${fmt(nxt.cost)}</span><button class="btn gold" data-buyboat="1" ${can?'':'disabled'}>BUILD</button></div>`; }
  else h+=`<div class="fishrow"><span class="nm">Fleet complete · the seas bow to you, Admiral</span><span class="rr" style="color:var(--gold)">MAX</span></div>`;
  boatCurEl.innerHTML=h;
  let fl=''; BOATS.forEach((b,i)=>{ const st=i<=state.boatLvl?'OWNED':i===state.boatLvl+1?'NEXT':'LOCKED';
    fl+=`<div class="fishrow" data-prevboat="${i}" style="cursor:pointer;${i===previewLvl?'border-color:rgba(57,215,196,.55);':''}${i>state.boatLvl+1?'opacity:.55;':''}">
      ${pixSVG(i<=state.boatLvl?'boat':'lock',15)}
      <span class="nm">${b.name} ${seatPips(b.seats,0)} <span style="color:var(--faint);font-size:11px">${b.sub} · ${seatLabel(i)}</span></span>
      ${b.cost?`<span class="vv">◈ ${fmt(b.cost)}</span>`:''}
      <span class="rr" style="color:${st==='OWNED'?'var(--teal)':st==='NEXT'?'var(--gold)':'var(--faint)'}">${st}</span></div>`; });
  boatListEl.innerHTML=fl;
  renderCrew();
  if(sailListEl)sailListEl.innerHTML=renderWorldRows(); }
function buyBoat(){ const nxt=state.boatLvl+1; if(nxt>=BOATS.length)return; const b=BOATS[nxt];
  if(state.coins<b.cost||!haveOres(b.req))return;
  if(SRV.on){ // the server owns the shipyard too, or the hull would vanish on the next reply
    SRV.act('boat',{}).then(r=>{ if(!r)return;
      sfx.win(); addShake(0.14); toast(pixSVG('boat',13)+' '+(r.name||b.name)+' launched!','gold');
      if(DOCK)fxBurst(DOCK.boat.x,WATER_TOP+0.3,DOCK.boat.z,{n:22,cols:[0x7fdcff,0xd9f6ff,0xffd24f],speed:2.8,up:3.6,size:1.1,grav:7});
      rebuildDockBoat(); buildPreview(state.boatLvl); renderHarbor();
      if(crewOnline())crewRefresh(); });
    return; }
  state.coins-=b.cost; for(const k in b.req)state.ores[k]-=b.req[k];
  state.boatLvl=nxt; sfx.win(); addShake(0.14);
  toast(pixSVG('boat',13)+' '+b.name+' launched!','gold');
  if(DOCK)fxBurst(DOCK.boat.x,WATER_TOP+0.3,DOCK.boat.z,{n:22,cols:[0x7fdcff,0xd9f6ff,0xffd24f],speed:2.8,up:3.6,size:1.1,grav:7});
  rebuildDockBoat(); buildPreview(state.boatLvl); renderHarbor(); updateHUD(); save();
  if(crewOnline())crewRefresh(); }
function openHarbor(){ if(marketOpen||casinoOpen||invOpen)return; RF.emit('panel','harbor',true);
  harborOpen=true; sfx.open(); harborEl.classList.add('on'); buildPreview(state.boatLvl); renderHarbor();
  // a knock can arrive while the captain is standing at the dock
  crewRefresh(); if(crewTimer)clearInterval(crewTimer);
  crewTimer=setInterval(()=>{ if(harborOpen&&!crewBusy)crewRefresh(); },6000); }
function closeHarbor(){ harborOpen=false; RF.emit('panel','harbor',false); sfx.close(); harborEl.classList.remove('on');
  if(crewTimer){ clearInterval(crewTimer); crewTimer=0; } save(); }
if(harborEl){
  document.getElementById('harborX').onclick=closeHarbor;
  harborEl.addEventListener('click',e=>{
    if(e.target.closest&&e.target.closest('[data-buyboat]')){ buyBoat(); return; }
    const pv=e.target.closest?e.target.closest('[data-prevboat]'):null;
    if(pv){ buildPreview(+pv.getAttribute('data-prevboat')); renderHarbor(); return; }
    const cw=e.target.closest?e.target.closest('[data-crew]'):null;
    if(cw){ crewAct(cw.getAttribute('data-crew'),cw.getAttribute('data-crewuser')||''); return; }
    const wd=e.target.closest?e.target.closest('[data-world]'):null;
    if(wd){ buyOrSail(wd.getAttribute('data-world')); renderHarbor(); return; } }); }

/* ========================================================================
   11. CASINO ROULETTE — bets & spins on the real table out in the world
   (the wheel, ball and table live at the casino landmark, section 6)
   ======================================================================== */
let casinoOpen=false,stakeIdx=-1,betColor=null,spinning=false,coinStake=0;
const casinoEl=document.getElementById('casino'),stakeListEl=document.getElementById('stakeList'),
  spinBtn=document.getElementById('spinBtn'),spinResult=document.getElementById('spinResult');
const COIN_STAKES=[50,250,1000,5000];
// a bet is won by whichever pocket the ball lands in — colour bets, parity bets and high/low
function betWins(bet,idx){ const col=SEG[idx];
  if(bet==='red'||bet==='black'||bet==='green')return col===bet;
  if(idx===0)return false;                       // the green zero eats every outside bet, as it should
  if(bet==='odd')return idx%2===1;
  if(bet==='even')return idx%2===0;
  if(bet==='high')return idx>=8;
  return false; }
const betPay=bet=>bet==='green'?14:2;
// the house skims 4% of every stake into a pot that GREEN pays out in full
const JACK_CUT=0.04;
// bigger sticks unlock bigger stakes — gear tier gates how much you may risk
const betCap=()=>[250,1000,5000,25000,100000][clamp(Math.floor((state.rodLvl-1)/2),0,4)];
function renderJackpot(){ const el=document.getElementById('jackpotBar'); if(!el)return;
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px;
      padding:6px 10px;border-radius:10px;background:rgba(255,210,79,.08);border:1px solid rgba(255,210,79,.25)">
    <span style="font-size:11px;color:var(--faint)">PROGRESSIVE POT · won on <b style="color:var(--good)">GREEN</b></span>
    <b style="color:var(--gold)">◈ ${fmt(state.jackpot||0)}</b></div>
    <div style="font-size:10px;color:var(--faint);margin-top:4px;text-align:right">max stake ◈${fmt(betCap())} · rod Lv.${state.rodLvl}${state.charm?' · 🍀 charm active':''}</div>`; }
function renderStakes(){
  const capv=betCap();
  let h='<div class="bets" style="margin:0 0 6px">'+COIN_STAKES.map(c=>{ const over=c>capv, poor=state.coins<c;
    return `<div class="betbtn${coinStake===c?' sel':''}" data-cstake="${c}" role="button" tabindex="0" style="color:var(--gold)${poor||over?';opacity:.4':''}">◈${fmt(c)}<small>${over?'rod too low':poor?'not enough':'coin stake'}</small></div>`;}).join('')+'</div>';
  if(!state.bucket.length) h+='<div class="empty" style="padding:8px">No fish to stake · bet coins or go fishing.</div>';
  else state.bucket.forEach((f,i)=>{h+=`<div class="stake${i===stakeIdx?' sel':''}" data-stake="${i}">${pixFish(RAR[f.rar],16)}
    <span class="nm">${f.name}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</span><span class="vv">◈ ${fmt(f.val)}</span></div>`;});
  stakeListEl.innerHTML=h; }
function updateSpinBtn(){ const hasStake=(stakeIdx>=0&&state.bucket[stakeIdx])||(coinStake>0&&state.coins>=coinStake);
  spinBtn.disabled=!(hasStake&&betColor&&!spinning); }
function openCasino(){casinoOpen=true; RF.emit('panel','casino',true);sfx.open();viewMode='casino';casinoLabel.visible=false;casinoEl.classList.add('on');stakeIdx=-1;betColor=null;spinning=false;coinStake=0;spinResult.innerHTML='';renderJackpot();
  document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));renderStakes();updateSpinBtn();}
function closeCasino(){ RF.emit('panel','casino',false);
  // closing mid-spin settles the wheel HONESTLY: no loss-dodging, no swallowed stakes
  if(spinAnim){ const sa=spinAnim; spinAnim=null; ballLockIdx=sa.winIdx; resolveSpin(sa); }
  casinoOpen=false;sfx.close();viewMode='follow';casinoLabel.visible=true;spinSeq++;spinning=false;casinoEl.classList.remove('on');save();}
document.getElementById('casinoX').onclick=closeCasino;
stakeListEl.addEventListener('click',e=>{if(spinning)return;
  const c=e.target.closest('[data-cstake]');
  if(c){ const amt=+c.getAttribute('data-cstake');
    if(amt>betCap()){ sfx.deny(); toast(`Rod Lv.${state.rodLvl} caps you at ◈${fmt(betCap())} · upgrade to bet bigger`,'bad'); return; }
    if(state.coins>=amt){ sfx.click(); coinStake=(coinStake===amt?0:amt); if(coinStake)stakeIdx=-1; renderStakes(); updateSpinBtn(); } return; }
  const t=e.target.closest('[data-stake]');if(t){sfx.click();stakeIdx=+t.getAttribute('data-stake');coinStake=0;renderStakes();updateSpinBtn();}});
document.querySelectorAll('.betbtn').forEach(b=>{const pick=()=>{if(spinning)return;sfx.click();betColor=b.getAttribute('data-bet');
  document.querySelectorAll('.betbtn[data-bet]').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');updateSpinBtn();};
  b.onclick=pick;b.onkeydown=e=>{if(e.code==='Enter'||e.code==='Space'){e.preventDefault();pick();}};});
let spinSeq=0,spinAnim=null;
/* Launch the ball toward a pocket. Offline we pick it; ONLINE the server already did. */
function startSpinAnim(winIdx,fish,coins,bet,srv){
  const th0=wheelAngle, th1=th0-(4+Math.random()*2)*TAU;   // wheel spins one way…
  const bTarget=-(winIdx*SEGA+SEGA/2)-th1;                 // …ball must come to rest on the winning pocket
  let base=(ballA-bTarget)%TAU; if(base<0)base+=TAU;
  spinAnim={seq:++spinSeq,t:0,dur:4.4,th0,th1,b0:ballA,bTot:base+6*TAU,winIdx,fish,coins,bet,srv,lastPocket:-1}; }
spinBtn.onclick=()=>{ if(spinBtn.disabled)return; sfx.spinUp();
  const fish=stakeIdx>=0?state.bucket[stakeIdx]:null, coins=fish?0:coinStake;
  if(!fish&&!(coins>0&&state.coins>=coins))return;
  if(SRV.on){ // the house is the server: it rolls the pocket, we only animate to it
    spinning=true;updateSpinBtn();spinResult.innerHTML='<span style="color:var(--muted)">No more bets · the ball is rolling…</span>';
    const bet=betColor;
    SRV.act('spin',fish?{bet,stakeIdx}:{bet,coinStake:coins}).then(r=>{
      if(!r){ spinning=false; updateSpinBtn(); spinResult.innerHTML='<span class="lose">The table refused that bet.</span>'; return; }
      startSpinAnim(r.winIdx,fish,coins,bet,r); });
    return; }
  if(coins){ state.coins-=coins; state.jackpot=(state.jackpot||0)+Math.round(coins*JACK_CUT); updateHUD(); renderJackpot(); } // stake leaves now; a slice feeds the pot
  spinning=true;updateSpinBtn();spinResult.innerHTML='<span style="color:var(--muted)">No more bets · the ball is rolling…</span>';
  let winIdx=Math.floor(Math.random()*NSEG);
  // the lucky charm quietly re-rolls one losing spin in five — it nudges the odds, it does not rig them
  if(state.charm&&!betWins(betColor,winIdx)&&Math.random()<0.2)winIdx=Math.floor(Math.random()*NSEG);
  startSpinAnim(winIdx,fish,coins,betColor,null); };
function updateRoulette(dt){ // every frame from the main loop — the table is part of the world
  if(spinAnim){
    if(spinAnim.seq!==spinSeq||!casinoOpen){ if(spinAnim.coins){state.coins+=spinAnim.coins;updateHUD();} spinAnim=null; } // cancelled (ESC/close) — stake refunded
    else{ spinAnim.t+=dt; const p=Math.min(1,spinAnim.t/spinAnim.dur);
      const ew=1-Math.pow(1-p,3), eb=1-Math.pow(1-p,2.55);
      wheelAngle=spinAnim.th0+(spinAnim.th1-spinAnim.th0)*ew;
      const b=spinAnim.b0-spinAnim.bTot*eb; let r,by;
      if(p<0.55){ r=R_TRACK; by=Y_TRACK; }
      else{ const s=(p-0.55)/0.45; r=lerp(R_TRACK,R_POCK,s); // spiral down + little bounces as it settles
        by=lerp(Y_TRACK,Y_POCK,s)+Math.abs(Math.sin(s*Math.PI*2.5))*0.1*(1-s); }
      setBall(b,r,by);
      const phi=(((-b-wheelAngle)%TAU)+TAU)%TAU, pk=Math.floor(phi/SEGA);
      if(pk!==spinAnim.lastPocket){ spinAnim.lastPocket=pk; sfx.spin(420-280*p); } // pitch falls as it settles
      if(p>=1){ const sa=spinAnim; spinAnim=null; ballLockIdx=sa.winIdx; resolveSpin(sa); } } }
  if(!spinAnim){ wheelAngle-=dt*(casinoOpen?0.4:0.7); setBallPocket(ballLockIdx); } // idle attract spin
  wheelDisc.rotation.y=wheelAngle; }
const ballWP=new THREE.Vector3();
const winFlashEl=document.getElementById('winFlash');
// re-arm the CSS animations by dropping the class and forcing a reflow before re-adding it
function popWin(big){
  spinResult.classList.remove('pop'); void spinResult.offsetWidth; spinResult.classList.add('pop');
  if(winFlashEl){ winFlashEl.className=''; void winFlashEl.offsetWidth; winFlashEl.className=big?'on big':'on'; } }
function resolveSpin(sa){ const idx=sa.winIdx,fish=sa.fish,coins=sa.coins||0,color=SEG[idx],won=betWins(sa.bet,idx);
  const PL=color.toUpperCase()+' '+idx; // parity/high bets need the pocket NUMBER, not just its colour
  ball.getWorldPosition(ballWP);
  if(sa.srv){ // server already settled the books — show the outcome only
    const r=sa.srv;
    if(r.won){ const big=color==='green';
      addShake(big?0.45:0.25); addFreeze(big?0.22:0.1); triggerWinFx(idx,big);   // beat of hit-stop, then the celebration lands
      fxBurst(ballWP.x,ballWP.y+0.2,ballWP.z,{n:big?34:16,cols:[0xffd24f,0xffefb0,0x74e08a],speed:2.6,up:3.6,size:1.1,grav:7});
      if(r.payout)coinFly(r.payout);
      spinResult.innerHTML=`<span class="win">▲ ${PL} · WON! ${r.message||''}</span>`;
      popWin(big); toast(r.message||'You won!','gold'); (big?sfx.jackpot:sfx.win)(); }
    else{ addShake(0.2);
      fxBurst(ballWP.x,ballWP.y+0.15,ballWP.z,{n:14,cols:[0xff5d7a,0x8a2033,0x242a30],speed:2.2,up:2.6,size:1,grav:8});
      spinResult.innerHTML=`<span class="lose">▼ ${PL} · ${r.message||'the eel swallowed it.'}</span>`;
      toast(r.message||'Lost it','bad'); sfx.lose(); }
    spinning=false; betColor=null; stakeIdx=-1; coinStake=0;
    document.querySelectorAll('.betbtn[data-bet]').forEach(b=>b.classList.remove('sel'));
    renderStakes(); updateHUD(); updateSpinBtn(); return; }
  state.stats.spins++;
  if(won){ const mult=betPay(sa.bet);
    state.stats.winsCt++;
    if(sa.bet==='green')grantShare('EEL'); // jackpot pays out a meme-stock certificate too
    // GREEN also empties the progressive pot into your purse
    if(sa.bet==='green'&&state.jackpot>0){ const pot=state.jackpot; state.jackpot=0;
      state.coins+=pot; state.stats.earned+=pot; coinFly(pot); addFreeze(0.2);
      toast(`★ PROGRESSIVE POT · ◈${fmt(pot)}!`,'gold'); renderJackpot(); }
    const big=color==='green';
    addShake(big?0.45:0.25); addFreeze(big?0.22:0.1); triggerWinFx(idx,big); popWin(big);
    fxBurst(ballWP.x,ballWP.y+0.2,ballWP.z,{n:big?34:16,cols:[0xffd24f,0xffefb0,0x74e08a],speed:2.6,up:3.6,size:1.1,grav:7});
    if(fish){ const before=fish.val; fish.val=Math.round(fish.val*mult); fish.wins++;
      state.stats.bestWin=Math.max(state.stats.bestWin,fish.val);
      spinResult.innerHTML=`<span class="win">▲ ${PL} · WON! ${fish.name} ◈${fmt(before)} → <b>◈${fmt(fish.val)}</b>. Spin again or cash out.</span>`;
      toast(`${fish.name} doubled → ◈${fmt(fish.val)}`,'gold'); }
    else{ const gain=coins*mult; state.coins+=gain; state.stats.earned+=gain-coins;
      state.stats.bestWin=Math.max(state.stats.bestWin,gain); coinFly(gain);
      spinResult.innerHTML=`<span class="win">▲ ${PL} · WON! ◈${fmt(coins)} → <b>◈${fmt(gain)}</b>. Again?</span>`;
      toast(`◈${fmt(coins)} → ◈${fmt(gain)}!`,'gold'); }
    (big?sfx.jackpot:sfx.win)(); }
  else { state.stats.losses++; addShake(0.2);
    fxBurst(ballWP.x,ballWP.y+0.15,ballWP.z,{n:14,cols:[0xff5d7a,0x8a2033,0x242a30],speed:2.2,up:2.6,size:1,grav:8});
    if(fish){ const lost=fish.name,li=state.bucket.indexOf(fish); if(li>=0)state.bucket.splice(li,1); stakeIdx=-1;
      spinResult.innerHTML=`<span class="lose">▼ ${PL} · the eel swallowed your ${lost}. Gone.</span>`; toast('Lost your '+lost,'bad'); }
    else{ spinResult.innerHTML=`<span class="lose">▼ ${PL} · the eel gulped your ◈${fmt(coins)}.</span>`; toast('Lost ◈'+fmt(coins),'bad'); }
    sfx.lose(); }
  spinning=false;betColor=null;document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));
  renderStakes();updateHUD();updateSpinBtn();save(); }

/* ========================================================================
   12. FISHING (3D)
   ======================================================================== */
const fishing={state:'idle',t:0,biteAt:0,reel:0,reelT:0,tx:0,tz:0,cast:0,
  tens:0,fight:0,surge:0,surgeT:0,hooked:null,auto:false}; // tens/fight/surge drive the reel-in tug-of-war

/* ---- THE AUTO-RIG ------------------------------------------------------
   Toggle it with F and the loop plays itself: it casts at the nearest water,
   sets the hook a beat after the bite, and reels with a hand steady enough
   that the line never snaps. You do not have to be at the keyboard for any
   of it — which is the whole point, and exactly what it pays for with the
   AUTO table above.

   `nextAt` is wall-clock, not a frame counter: the server enforces the same
   AUTO.gapMs floor between two auto catches, so the rig paces itself a
   quarter-second on the safe side of it rather than being bounced by a 400. */
const autoFish={on:false,nextAt:0};
const isMoving=()=>!!(keys.up||keys.down||keys.left||keys.right);
function paintAuto(){ const el=document.getElementById('hud-auto'); if(!el)return;
  el.classList.toggle('on',autoFish.on);
  const v=document.getElementById('autoVal'); if(v)v.textContent=autoFish.on?'fishing':'off';
  const b=document.getElementById('autoBtn'); if(b)b.classList.toggle('lit',autoFish.on); }
function setAuto(on,why){
  if(autoFish.on===!!on)return;
  autoFish.on=!!on; autoFish.nextAt=0;
  if(!autoFish.on&&fishing.state!=='idle')cancelFish();
  paintAuto();
  if(autoFish.on)toast(`${pixSVG('rod',13)} Auto-fishing ON · the rig only brings up cheap fish`,'good');
  else toast(why||'Auto-fishing off'); }
function toggleAuto(){ if(!running)return; initAudio(); setAuto(!autoFish.on); }
// how hard each rarity pulls — legendaries will snap a starter rod if you just hold E
const FIGHT={common:0.52,uncommon:0.66,rare:0.86,epic:1.06,legendary:1.32};
function cancelFish(){fishing.state='idle';bobber.visible=false;fishing.hooked=null;fishing.tens=0;hint('');}
// consecutive clean catches pay a rising bonus; one snapped line resets it
let catchStreak=0;
const streakMult=()=>1+Math.min(0.6,catchStreak*0.06);
function nearestWater(){ const [ci,cj]=cellIndex(pWorld.x,pWorld.z); let bestC=null,bd=1e9;
  for(let i=ci-3;i<=ci+3;i++)for(let j=cj-3;j<=cj+3;j++){ if(i<0||j<0||i>=N||j>=N)continue; if(heightMap[i][j]>2)continue;
    const wx2=i-HALF,wz2=j-HALF,d=Math.hypot(wx2-pWorld.x,wz2-pWorld.z); if(d<bd){bd=d;bestC={x:wx2,z:wz2,dist:d};} } return bestC; }
function startCast(w){ initAudio(); fishing.state='cast';fishing.cast=0;fishing.tx=w.x;fishing.tz=w.z;
  fishing.auto=autoFish.on;   // whose cast this is, decided once — toggling mid-fight cannot change it
  bobber.visible=true;bobber.position.set(pWorld.x,pWorld.y+1,pWorld.z);sfx.cast(); }
function updateFishing(dt){ const f=fishing;
  if(RF.override.fishing&&RF.override.fishing(dt,f)===true)return;
  if(f.state==='cast'){ f.cast=Math.min(1,f.cast+dt*2.2);
    bobber.position.x=lerp(pWorld.x,f.tx,f.cast);bobber.position.z=lerp(pWorld.z,f.tz,f.cast);
    bobber.position.y=lerp(pWorld.y+1,WATER_TOP+0.1,f.cast)+Math.sin(f.cast*Math.PI)*1.2; hint(f.auto?'The rig casts…':'Casting…');
    if(f.cast>=1){f.state='wait';f.biteAt=biteTime();f.t=0;sfx.splash(0.06);
      fxBurst(f.tx,WATER_TOP+0.15,f.tz,{n:8,cols:[0x7fdcff,0xd9f6ff,0xffffff],speed:1.8,up:2.6,size:0.9,grav:7});} }
  else if(f.state==='wait'){ f.t+=dt; bobber.position.y=WATER_TOP+0.1+Math.sin(clock*3)*0.05; hint(f.auto?`${pixSVG('rod',13)} the rig waits for a bite… <span class="key">F</span> stop`:'Waiting for a bite… <span class="key">ESC</span> reel in');
    if(f.t>=f.biteAt){f.state='bite';f.t=0;sfx.bite();
      fxBurst(bobber.position.x,WATER_TOP+0.15,bobber.position.z,{n:6,cols:[0x7fdcff,0xffffff],speed:1.6,up:2.2,size:0.8,grav:7});} }
  else if(f.state==='bite'){ f.t+=dt; bobber.position.y=WATER_TOP+0.05+Math.sin(clock*22)*0.14;
    hint(f.auto?'<b style="color:var(--rose)">!</b> the rig sets the hook…':'<b style="color:var(--rose)">!</b> <b>BITE!</b> press <span class="key">E</span> now!');
    if(actEdge||(f.auto&&f.t>0.3)){ f.state='reel'; f.reel=0; f.reelT=0; f.tens=0; f.surge=0; f.surgeT=rand(0.5,1.1);
      // hook the fish NOW so the fight has real weight behind it — the one you fight is the one you land
      f.hooked=SRV.on?null:rollFish(false,f.auto);
      f.fight=f.hooked?FIGHT[f.hooked.rar]:0.7; }
    else if(f.t>0.85){cancelFish();sfx.miss();catchStreak=0;toast('It got away…');} }
  else if(f.state==='reel'){ f.reelT+=dt;
    // the fish fights in waves: during a SURGE the line loads up nearly 3× faster and you must give slack
    f.surgeT-=dt;
    if(f.surgeT<=0){ f.surge=f.surge?0:1; f.surgeT=f.surge?rand(0.6,1.25):rand(0.8,1.7);
      if(f.surge){ sfx.bite(); addShake(0.05);
        fxBurst(bobber.position.x,WATER_TOP+0.15,bobber.position.z,{n:5,cols:[0x7fdcff,0xffffff],speed:2,up:2.4,size:0.8,grav:7}); } }
    const strain=f.fight*(f.surge?2.6:0.8)/(1+(state.rodLvl-1)*0.13); // a better rod takes more punishment
    /* The rig has a steadier hand than any player: it hauls only while the line
       is slack enough and gives every surge straight back, so it never snaps.
       That patience is the other half of what it trades the good fish away for
       — it lands everything it hooks, and it hooks almost nothing worth having. */
    const hold=f.auto?(!f.surge&&f.tens<0.55):keys.act;
    if(hold){ f.reel+=dt*0.62; f.tens+=dt*strain; if(Math.random()<0.08)sfx.reel(); if(f.tens>0.72&&Math.random()<0.07)sfx.creak(); }
    else { f.reel-=dt*0.1; f.tens-=dt*1.25; }                          // let go to bleed tension off
    f.reel=clamp(f.reel,0,1); f.tens=clamp(f.tens,0,1);
    bobber.position.y=WATER_TOP+0.1+f.reel*0.3;
    { const rk=Math.floor(f.reel*8), tk=Math.floor(f.tens*8),
        tc=f.tens>0.78?'var(--rose)':f.tens>0.5?'var(--gold)':'var(--teal)';
      hint(`${f.auto?'the rig works it in · ':f.surge?'<b style="color:var(--rose)">IT RUNS!</b> let go · ':'hold <span class="key">E</span> · '}`
        +`line <b style="color:${tc}">${'▰'.repeat(tk)+'▱'.repeat(8-tk)}</b>  fish <b>${'▰'.repeat(rk)+'▱'.repeat(8-rk)}</b>`); }
    if(f.tens>=1){ // snapped — the fish and the streak are both gone
      cancelFish(); sfx.miss(); addShake(0.18);
      fxBurst(bobber.position.x,WATER_TOP+0.2,bobber.position.z,{n:10,cols:[0xff5d7a,0xffffff],speed:2.4,up:3,size:0.9,grav:8});
      catchStreak=0; toast('The line SNAPPED · too much tension','bad'); return; }
    if(f.reel>=1){ f.state='idle'; bobber.visible=false;
      const bx=bobber.position.x,bz=bobber.position.z;
      const land=fish=>{ sfx.splash(0.11); fxBurst(bx,WATER_TOP+0.2,bz,{n:16,cols:[0x7fdcff,0xd9f6ff,0xffffff],speed:2.6,up:4,size:1.1,grav:7});
        addShake(fish.rar==='legendary'||fish.rar==='epic'?0.25:0.1);
        if(fish.rar==='legendary')addFreeze(0.14); };
      const auto=f.auto;
      // pace the next cast off the wall clock, a hair wider than the floor the
      // server enforces between two auto catches
      if(auto)autoFish.nextAt=Date.now()+AUTO.gapMs+250;
      if(SRV.on){ // the server rolls the fish and banks it
        SRV.act('catch',{night:isNight(),wet:wState,storm:wState==='storm',auto}).then(r=>{
          if(!r||!r.fish)return; land(r.fish); revealServerCatch(r); });
      } else { const fish=f.hooked||rollFish(false,auto); land(fish);
        // the streak is a reward for playing the fish yourself; an unattended
        // rig neither builds it nor keeps one alive
        if(auto)catchStreak=0;
        else{ catchStreak++;
          if(catchStreak>1){ const m=streakMult();    // a clean run pays a rising bonus on the fish's value
            fish.val=Math.round(fish.val*m);
            if(catchStreak%3===0)toast(`${pixSVG('fish',13)} ${catchStreak} in a row · ×${m.toFixed(2)} value!`,'gold'); } }
        f.hooked=null;
        if(state.bucket.length<cap()){ onCatch(fish,auto); if(!auto)noteBaitSpent(useBait()); updateHUD(); save(); }
        else toast('Bucket full · sell some fish!'); } } }
}

/* ========================================================================
   13. MINING
   ======================================================================== */
const mining={node:null,t:0,dur:1.7};
function cancelMine(){if(mining.node)mining.node.mesh.scale.setScalar(1);mining.node=null;hint('');}
function nearestOre(){ let bestN=null,bd=1e9;
  for(const n of oreNodes){ if(!n.alive)continue; const d=Math.hypot(n.x-pWorld.x,n.z-pWorld.z);
    if(d<bd){bd=d;bestN=n;} } return bestN&&bd<2.0?bestN:null; }
function startMine(n){ initAudio(); mining.node=n; mining.t=0;
  mining.dur=1.7/(1+(state.pickLvl-1)*0.22)*(n.geode?2.3:1); } // geodes are a real commitment
// chain-mining: break nodes back-to-back and the vein pays out harder each time
let oreCombo=0,oreComboT=0;
const comboMult=()=>1+Math.min(1.5,Math.floor(oreCombo/2)*0.5);
function updateMining(dt){ const n=mining.node;
  if(RF.override.mining&&RF.override.mining(dt,n)===true)return;
  if(!n||!n.alive){cancelMine();return;}
  if(keys.up||keys.down||keys.left||keys.right){cancelMine();return;}
  if(keys.act){ mining.t+=dt; } // impact fx/sfx fire from the swing animation, synced to the hit frame
  else { mining.t-=dt*0.6; if(mining.t<=0){ n.mesh.scale.setScalar(1); cancelMine(); return; } }
  mining.t=clamp(mining.t,0,mining.dur);
  const p=mining.t/mining.dur,k=Math.floor(p*8);
  hint(`${pixSVG('pick',13)} ${n.geode?'<b style="color:var(--gold)">GEODE</b> · cracking':'Mining '+ORE_INFO[n.type].name}… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`
    +(oreComboT>0?`  <span style="color:var(--gold)">vein ×${oreCombo}</span>`:''));
  if(mining.t>=mining.dur){ n.mesh.scale.setScalar(1);
    oreCombo=oreComboT>0?oreCombo+1:1; oreComboT=6.5;   // keep the chain alive by finding the next node fast
    addShake(n.geode?0.4:0.22); addFreeze(n.geode?0.12:0.05);
    fxBurst(n.x,n.y+0.6,n.z,{n:n.geode?40:18,cols:[ORE_INFO[n.type].color,0x9aa1a8,0x747c84],speed:n.geode?4.4:3.2,up:n.geode?5.5:4.2,size:1.1});
    if(SRV.on){ sfx.ore();
      // hide it optimistically, but PUT IT BACK if the server refuses — otherwise a
      // rate-limited swing would erase the vein for a minute and pay nothing
      n.alive=false; n.mesh.visible=false;
      SRV.act('mine',{type:n.type,node:n.id}).then(r=>{
        if(r&&r.got)toast(`+${r.got} ${ORE_INFO[r.type||n.type].name}`,'good');
        else if(!n.srvUntil){ n.alive=true; n.mesh.visible=true; } });
      cancelMine(); return; }
    n.alive=false; n.mesh.visible=false; n.respawnAt=clock+40+rand(0,25);
    const bonus=Math.random()<Math.min(0.85,0.15+0.08*(state.pickLvl-1))?1:0;
    // a storm loosens the rock — bad weather actually pays at the quarry
    const wBoost=(wState==='storm'?1.5:wState==='rain'||wState==='snow'||wState==='ash'?1.2:1);
    let got=Math.round((1+bonus+(state.pickLvl>=6&&Math.random()<0.2?1:0))*(WORLD.oreYield||1)*comboMult()*wBoost*(n.geode?3.5:1));
    got=Math.max(1,Math.round(RF.pipe('oreYield',got,{node:n,type:n.type,geode:!!n.geode,combo:oreCombo})));
    state.ores[n.type]+=got; state.stats.mined+=got; sfx.ore();
    if(n.geode){ sfx.win(); // cracking one open sprays gems everywhere
      fxBurst(n.x,n.y+1.1,n.z,{n:26,cols:[0x5ee8e2,0xffd24f,0xffefb0],speed:3.6,up:5,size:1.2,grav:6}); }
    addPearls({coal:1,iron:1,gold:2,diamond:5}[n.type]||1); // pearls track effort, not ore value
    // mining is the main source of share certificates ("mineral rights")
    const shC=0.06+0.015*(state.pickLvl-1);
    if(n.type==='diamond')grantShare(STOCK_KEYS[(Math.random()*STOCK_KEYS.length)|0]);
    else if(n.type==='gold'){ if(Math.random()<shC)grantShare(Math.random()<0.5?'HARB':'EEL'); }
    else if(Math.random()<shC)grantShare('DIGG');
    toast(`+${got} ${ORE_INFO[n.type].name}`+(n.geode?' · GEODE!':'')+(oreCombo>1?`  vein ×${oreCombo}`:''),n.geode?'gold':'good');
    RF.emit('mined',{type:n.type,got:got,geode:!!n.geode,node:n,combo:oreCombo});
    cancelMine(); updateHUD(); save(); } }

/* ========================================================================
   13e. PHOTO MODE — hide the whole UI and orbit the hero (P)
   ======================================================================== */
let photoMode=false,photoAng=0,photoPitch=0.72,photoSnap=false; // pitch 0 = eye level (sky fills the top), 1 = the usual iso look-down
function togglePhoto(){ if(capCam)closeCam();   // both modes own vTargP/vTargL — only one may drive
  photoMode=!photoMode; sfx.shutter();
  document.body.classList.toggle('photo',photoMode);
  photoSnap=true;                                  // jump straight to the new framing instead of drifting into it
  if(photoMode){ photoAng=0; photoPitch=0.72;
    toast('📷 Photo mode · ←/→ orbit · ↑/↓ tilt to the horizon · scroll zoom · P exits','gold'); } }

/* ========================================================================
   CAPTAIN CAM — click the hero (or press C) to fly in close and show off.
   The camera turntables around the captain, the world dims to a letterbox,
   and eight procedural emotes drive the rig directly. Photo mode is this
   feature's free-roam sibling: the two are mutually exclusive, because both
   own vTargP/vTargL and would otherwise fight over the frame.
   ======================================================================== */
let capCam=false, capAng=0;
const CAP_R=6.2, CAP_EY=4.4, CAP_ORBIT=0.22, CAP_SHIFT=1.35, CAP_SIZE=2.9; // ortho: only CAP_SIZE zooms
// 35deg elevation — lower than the 40.5deg follow-cam for a heroic read, high enough to clear a 1-block step
const capCardEl=document.getElementById('capcard'), emoBarEl=document.getElementById('emotebar');

// the rig's rest pose, captured once — the per-frame loop never resets the head/hat/torso, so we must
const RIG_BASE={}; for(const k in player.userData){ const m=player.userData[k];
  if(m&&m.isObject3D)RIG_BASE[k]={x:m.position.x,y:m.position.y,z:m.position.z,
    rx:m.rotation.x,ry:m.rotation.y,rz:m.rotation.z}; }   // strap already carries a baked rotation.z — restore, never zero
const HATN=['crown','band','brim'];

// props the emotes hand the captain
const emoCoin=(()=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.26,0.06),
  new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0x8a6a1e,emissiveIntensity:0.45}));
  m.visible=false; m.castShadow=true; scene.add(m); return m; })();
const emoFish=(()=>{ const g=new THREE.Group();
  const bM=new THREE.MeshLambertMaterial({color:0x59c8e8}), fM=new THREE.MeshLambertMaterial({color:0x2f9bc0});
  const b=new THREE.Mesh(new THREE.BoxGeometry(0.66,0.36,0.24),bM);
  const tl=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.32,0.06),fM); tl.position.set(-0.42,0.02,0);
  const df=new THREE.Mesh(new THREE.BoxGeometry(0.24,0.15,0.05),fM); df.position.set(0.02,0.24,0);
  const ey=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,0.26),new THREE.MeshLambertMaterial({color:0x101a1e}));
  ey.position.set(0.22,0.07,0);
  [b,tl,df,ey].forEach(m=>{m.castShadow=true;g.add(m);});
  g.visible=false; scene.add(g); return g; })();

// floating "z" sprites for the snooze emote — a tiny 3-slot pool, no per-frame allocation
const zSpr=[]; let zT=0;
function zEnsure(){ if(zSpr.length)return;
  const c=px(32),g2=c.getContext('2d'); g2.clearRect(0,0,32,32);
  g2.font='bold 25px "Chakra Petch",sans-serif'; g2.textAlign='center'; g2.textBaseline='middle';
  g2.strokeStyle='rgba(3,16,20,.85)'; g2.lineWidth=5; g2.strokeText('z',16,17);
  g2.fillStyle='#ffffff'; g2.fillText('z',16,17);
  const tx=toTex(c,{nearest:false});
  for(let i=0;i<3;i++){ const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tx,transparent:true,depthTest:false,opacity:0}));
    s.renderOrder=8; s.visible=false; scene.add(s); zSpr.push({s,t:-1}); } }
function zHide(){ for(const z of zSpr){ z.t=-1; z.s.visible=false; } }
function zUpdate(dt,on){ zEnsure(); zT+=dt;
  if(on>0.9&&zT>1.0){ zT=0; const f=zSpr.find(z=>z.t<0); if(f)f.t=0; }
  for(const z of zSpr){ if(z.t<0){z.s.visible=false;continue;}
    z.t+=dt; const q=z.t/2.3;
    if(q>=1){ z.t=-1; z.s.visible=false; continue; }
    z.s.visible=true; z.s.material.opacity=Math.sin(q*Math.PI)*0.95;
    const sc=0.26+q*0.44; z.s.scale.set(sc,sc,1);
    z.s.position.set(pWorld.x+0.4+Math.sin(q*4.2)*0.17, pWorld.y+0.8+q*1.55, pWorld.z+0.22); } }

// ---- the emote roster (bar order == keys 1-8) + three unlisted idle fidgets ----
const EMO=[
  {k:'dance',n:'Dance',    e:'\u{1F57A}', d:0  },   // 0 = loops until you stop it
  {k:'wave', n:'Wave',     e:'\u{1F44B}', d:1.9},
  {k:'coin', n:'Coin Flip',e:'\u{1FA99}', d:2.3},
  {k:'flex', n:'Fish Flex',e:'\u{1F41F}', d:2.7},
  {k:'flip', n:'Backflip', e:'\u{1F938}', d:1.2},
  {k:'sleep',n:'Snooze',   e:'\u{1F634}', d:0  },
  {k:'hat',  n:'Hat Tip',  e:'\u{1F3A9}', d:2.1},
  {k:'win',  n:'Victory',  e:'\u{1F389}', d:2.5}];
const FIDGETS=[['yawn',2.4],['scratch',2.0],['look',2.7]];
const emo={k:'',t:0,d:0,bi:-1,fid:false,beat:-1,fired:{}};
let fidT=rand(9,15);

function faceCam(){ pWorld.face=Math.atan2(Math.cos(capAng),Math.sin(capAng)); } // square up to the lens

function rigRest(){ const pd=player.userData;
  for(const k in pd){ const m=pd[k]; if(!m||!m.isObject3D)continue;
    const b=RIG_BASE[k]; if(b){ m.position.set(b.x,b.y,b.z); m.rotation.set(b.rx,b.ry,b.rz); } else m.rotation.set(0,0,0); }
  player.scale.set(1,1,1); player.rotation.z=0;
  emoCoin.visible=false; emoFish.visible=false; zHide(); }

function playEmote(k,d,bi,fid){
  initAudio(); sfx.emote();
  if(emo.k)rigRest();
  emo.k=k; emo.t=0; emo.d=d; emo.bi=bi==null?-1:bi; emo.fid=!!fid; emo.beat=-1; emo.fired={};
  if(capCam)faceCam();
  markEmote(emo.bi);
  if(k==='flex'){ const bc=bestCatch(); if(bc!=='·')toast(pixSVG('fish',13)+' Personal best · <b>'+bc+'</b>','gold'); } }
function playBarEmote(i){ const m=EMO[i]; if(!m)return;
  if(emo.k===m.k&&!emo.fid){ stopEmote(); return; }   // same key again = stop
  playEmote(m.k,m.d,i,false); }
function cycleEmote(){ let n=emo.bi<0?0:(emo.bi+1)%EMO.length; playEmote(EMO[n].k,EMO[n].d,n,false); }
function stopEmote(){ if(!emo.k)return; emo.k=''; emo.fid=false; rigRest(); markEmote(-1); }
function markEmote(i){ if(!emoBarEl)return;
  emoBarEl.querySelectorAll('.eslot').forEach((b,k)=>b.classList.toggle('on',k===i)); }
function once(id,at,fn){ if(emo.t>=at&&!emo.fired[id]){ emo.fired[id]=1; fn(); } }
function confetti(y){ fxBurst(pWorld.x,pWorld.y+y,pWorld.z,
  {n:16,cols:[0xffcf5c,0x39d7c4,0xff5d7a,0xffffff],speed:3.4,up:4.2,size:0.8,ttl:1.4,grav:5.5}); }
function dust(n,sp){ fxBurst(pWorld.x,pWorld.y+0.06,pWorld.z,
  {n:n,cols:[0xd8d0b8,0xbfae90,0x9a8f78],speed:sp,up:1.4,size:0.85,ttl:0.6,grav:8}); }

/* The whole pose is written AFTER the walk/activity block has had its say, so every
   value here is final. Anything we touch that the base loop never resets is undone by rigRest(). */
function updateEmote(dt){
  if(!emo.k){ idleFidget(dt); return; }
  if(fishing.state!=='idle'||mining.node||chopping.tree||digging.active){ stopEmote(); return; }
  if(!capCam&&(keys.up||keys.down||keys.left||keys.right)){ stopEmote(); return; } // walking cancels
  emo.t+=dt;
  const t=emo.t, k=emo.k, d=emo.d;
  if(d>0&&t>=d){ stopEmote(); return; }
  const pd=player.userData, S=Math.sin, C=Math.cos;
  const A=pd.armL, B=pd.armR, L=pd.legL, R=pd.legR, H=pd.head;
  rodMesh.visible=pickMesh.visible=shovelMesh.visible=axeMesh.visible=false; // empty hands, always
  let py=0, pz=0, sy=1;

  if(k==='dance'){                                    // the signature move: bounce, sway, hat spin
    const b=t*5.0, s1=S(b), bob=Math.abs(s1);
    py=bob*0.24; sy=1+S(b*2)*0.11;
    player.rotation.z=s1*0.14;
    L.rotation.x=s1*0.55; R.rotation.x=-s1*0.55; L.rotation.z=-0.14; R.rotation.z=0.14;
    A.rotation.x=-2.25+s1*0.8; A.rotation.z=0.5;
    B.rotation.x=-2.25-s1*0.8; B.rotation.z=-0.5;
    H.rotation.z=s1*0.2; H.rotation.y=S(b*0.5)*0.35;
    for(const n of HATN)pd[n].rotation.y=b*0.9;
    pd.scarfTail.rotation.x=0.5+S(b*2)*0.6; pd.scarfTail.rotation.z=s1*0.5;
    const step=Math.floor(b/Math.PI);
    if(step!==emo.beat){ emo.beat=step;
      const sc=[392,440,523,587,659];
      beep(sc[((step%5)+5)%5]*(step%8<4?1:1.5),0.08,'square',0.045);
      dust(4,1.5);
      if(step%4===0)fxBurst(pWorld.x,pWorld.y+1.95,pWorld.z,
        {n:5,cols:[0xffcf5c,0x39d7c4,0xff5d7a],speed:2.2,up:2.4,size:0.75,ttl:0.9,grav:5}); } }

  else if(k==='wave'){
    const g=Math.min(1,t/0.28)*Math.min(1,(d-t)/0.3);
    B.rotation.x=-2.5*g; B.rotation.z=(-0.3+S(t*13)*0.5)*g;
    A.rotation.x=-0.12; H.rotation.z=0.16*g;
    player.rotation.z=S(t*6.6)*0.05*g; py=Math.abs(S(t*6.6))*0.05*g;
    pd.scarfTail.rotation.z=S(t*6.6)*0.3;
    once('w',0.1,()=>beep(660,0.07,'sine',0.045)); }

  else if(k==='coin'){                                 // flick a coin up, watch it, catch it
    const T0=0.28, T1=1.72;
    const fx=S(player.rotation.y), fz=C(player.rotation.y);
    const bx=pWorld.x+fx*0.34, bz=pWorld.z+fz*0.34, by=pWorld.y+1.04;
    if(t<T0){ const q=t/T0; sy=1-0.14*S(q*Math.PI); py=-0.06*S(q*Math.PI);
      B.rotation.x=-0.35-q*0.55; A.rotation.x=-0.1; emoCoin.visible=false; }
    else if(t<T1){ const q=(t-T0)/(T1-T0);
      B.rotation.x=lerp(-2.35,-1.15,Math.min(1,q*2.6)); A.rotation.x=-0.15;
      H.rotation.x=-0.34*S(q*Math.PI); sy=1+0.06*S(q*Math.PI);
      emoCoin.visible=true;
      emoCoin.position.set(bx,by+S(q*Math.PI)*2.05,bz);
      emoCoin.rotation.x=q*TAU*4.2; emoCoin.rotation.y=q*2.2; }
    else{ const q=Math.min(1,(t-T1)/0.3);
      B.rotation.x=lerp(-1.15,-0.78,q); B.rotation.z=-0.22; sy=1-0.12*(1-q)*(1-q);
      emoCoin.visible=true; emoCoin.position.set(bx,by,bz); emoCoin.rotation.x+=dt*3.2; }
    once('flick',T0,()=>beep(880,0.06,'square',0.05));
    once('catch',T1,()=>{ beep(1180,0.09,'sine',0.05); addShake(0.03);
      fxBurst(bx,by,bz,{n:6,cols:[0xffd24f,0xffcf5c,0xffffff],speed:1.8,up:1.4,size:0.6,ttl:0.6,grav:6}); }); }

  else if(k==='flex'){                                 // hoist the personal best overhead
    const g=Math.min(1,t/0.45)*Math.min(1,(d-t)/0.4);
    A.rotation.x=-3.0*g; B.rotation.x=-3.0*g; A.rotation.z=0.3*g; B.rotation.z=-0.3*g;
    H.rotation.x=-0.28*g; sy=1+0.05*g*S(t*3); py=0.03*g;
    player.rotation.z=S(t*2.2)*0.04*g;
    emoFish.visible=g>0.05;
    emoFish.position.set(pWorld.x,pWorld.y+0.35+2.95*g,pWorld.z);   // clear of the hat brim
    emoFish.rotation.y=player.rotation.y+S(t*4)*0.35;
    emoFish.rotation.z=S(t*7)*0.22;
    emoFish.scale.setScalar(0.88+0.12*S(t*5));
    once('f',0.45,()=>beep(520,0.12,'triangle',0.05)); }

  else if(k==='flip'){                                 // launch, tuck, rotate about the waist, land
    const q=Math.min(1,t/d);
    py=S(Math.PI*Math.min(1,q/0.94))*1.6;
    const a=-TAU*clamp((q-0.06)/0.82,0,1);
    player.rotation.x=a;
    const pv=0.92; py+=pv*(1-C(a)); pz=-pv*S(a);
    const tuck=S(Math.PI*q);
    L.rotation.x=-1.5*tuck; R.rotation.x=-1.5*tuck;
    A.rotation.x=-2.2*tuck; B.rotation.x=-2.2*tuck; H.rotation.x=-0.3*tuck;
    sy=q<0.08?1-0.28*(q/0.08):q>0.93?1-0.3*((q-0.93)/0.07):1+0.12*tuck;
    once('go',0.06,()=>{ beep(300,0.09,'square',0.06); dust(8,2.6); });
    once('land',d*0.94,()=>{ beep(140,0.12,'sine',0.07); addShake(0.07); dust(12,3.2); }); }

  else if(k==='sleep'){                                // flop onto the back, hat over the eyes
    const lie=Math.min(1,t/0.7), a=-1.42*lie;
    player.rotation.x=a;
    const pv=0.5; py=pv*(1-C(a))-0.06*lie; pz=-pv*S(a);
    sy=1+S(t*1.7)*0.045;
    A.rotation.x=-0.1; A.rotation.z=0.75*lie; B.rotation.z=-0.75*lie;
    L.rotation.x=0.12*lie; R.rotation.x=-0.05*lie; H.rotation.z=0.3*lie;
    for(const n of HATN)pd[n].rotation.z=0.42*lie;
    pd.scarfTail.rotation.x=0.1;
    zUpdate(dt,lie);
    once('yawn',0.2,()=>beep(200,0.34,'sine',0.03)); }

  else if(k==='hat'){                                  // doff it, spin it, catch it
    const T0=0.3, T1=1.5;
    if(t<T0){ const q=t/T0; B.rotation.x=-2.5*q; B.rotation.z=-0.18*q; }
    else if(t<T1){ const q=(t-T0)/(T1-T0), lift=S(q*Math.PI)*0.55;
      B.rotation.x=-2.5+S(q*Math.PI)*0.35; B.rotation.z=-0.18;
      for(const n of HATN){ pd[n].position.y=RIG_BASE[n].y+lift; pd[n].rotation.y=q*TAU*1.6; pd[n].rotation.z=S(q*Math.PI)*0.3; }
      H.rotation.x=0.3*S(q*Math.PI); sy=1-0.04*S(q*Math.PI); }
    else{ const q=Math.min(1,(t-T1)/(d-T1)); B.rotation.x=lerp(-2.5,0,q); H.rotation.x=0.3*(1-q); }
    once('h',T0,()=>beep(740,0.08,'triangle',0.045));
    once('h2',T1,()=>beep(430,0.1,'triangle',0.04)); }

  else if(k==='win'){                                  // crouch, leap, double fist-pump, confetti
    const T0=0.26;
    if(t<T0){ const q=t/T0; sy=1-0.26*q; py=-0.1*q; A.rotation.x=0.4*q; B.rotation.x=0.4*q; }
    else{ const q=(t-T0)/(d-T0), air=S(Math.PI*Math.min(1,q/0.42));
      py=air*0.92; sy=1+0.16*air;
      A.rotation.x=-3.0; B.rotation.x=-3.0; A.rotation.z=0.42; B.rotation.z=-0.42;
      H.rotation.x=-0.22; player.rotation.z=S(q*9)*0.06*(1-q);
      if(q>0.5){ const w=S((q-0.5)*11); A.rotation.z=0.42+w*0.16; B.rotation.z=-0.42-w*0.16; py+=Math.abs(w)*0.05; } }
    once('j',T0,()=>{ if(sfx&&sfx.win)sfx.win(); confetti(2.2); dust(6,2.2); });
    once('c2',1.15,()=>confetti(2.4)); }

  // --- idle fidgets: the small stuff that makes a voxel captain look alive ---
  else if(k==='yawn'){ const g=S(Math.PI*Math.min(1,(t/d)/0.85));
    A.rotation.x=-2.6*g; B.rotation.x=-2.7*g; A.rotation.z=0.35*g; B.rotation.z=-0.35*g;
    H.rotation.x=-0.42*g; sy=1+0.09*g; py=0.05*g;
    once('y',0.35,()=>beep(240,0.3,'sine',0.028)); }
  else if(k==='scratch'){ const g=S(Math.PI*Math.min(1,(t/d)/0.9));
    B.rotation.x=-2.55*g; B.rotation.z=(-0.5+S(t*15)*0.13)*g;
    H.rotation.z=-0.14*g; H.rotation.x=0.1*g;
    for(const n of HATN)pd[n].rotation.z=-0.12*g; }
  else if(k==='look'){ const q=t/d;
    H.rotation.y=S(q*TAU)*0.62; H.rotation.z=S(q*TAU*2)*0.07;
    player.rotation.z=S(q*TAU)*0.03; }

  // squash & stretch is what sells every one of the above — volume-preserving on the group
  if(sy!==1)player.scale.set(1/Math.sqrt(sy),sy,1/Math.sqrt(sy));
  player.position.y+=py;
  if(pz){ player.position.x+=pz*S(player.rotation.y); player.position.z+=pz*C(player.rotation.y); } }

function idleFidget(dt){
  if(!running||fishing.state!=='idle'||mining.node||chopping.tree||digging.active
     ||marketOpen||casinoOpen||invOpen||harborOpen
     ||keys.up||keys.down||keys.left||keys.right){ fidT=rand(9,15); return; }
  if((fidT-=dt)>0)return;
  fidT=rand(10,17);
  const f=FIDGETS[(Math.random()*FIDGETS.length)|0];
  playEmote(f[0],f[1],-1,true); }

// ---- the close-up itself ----
/* Occlusion. Two levers, in order of preference:
   1. Pick a GOOD AZIMUTH. Spawn sits in a hollow at the foot of a cliff — from the follow-cam side the
      terrain climbs 5→8 and the captain is simply not visible from there at any elevation. So on open we
      scan the circle, find the widest arc with a clean sight line, and sweep back and forth inside it.
   2. DOLLY IN along the view axis. For an ortho camera that changes nothing about scale or framing —
      it only walks the near plane past a ridge. Used as the in-arc safety net. */
const CAP_EL=Math.atan2(CAP_EY,CAP_R), CAP_DIST=4.4;   // NOT hypot(R,EY): ortho scale ignores distance,
// so we sit deliberately close — only props within 4.4 units can ever come between the lens and the captain
let capA0=0, capA1=TAU, capPhase=Math.PI/2;
function capClear(a){                       // furthest the eye can sit on this bearing with the feet in view
  const ce=Math.cos(CAP_EL), ux=Math.cos(a)*ce, uy=Math.sin(CAP_EL), uz=Math.sin(a)*ce;
  for(let i=2;i<=14;i++){ const d=CAP_DIST*i/14;
    const sx=pWorld.x+ux*d, sz=pWorld.z+uz*d, sy=pWorld.y+uy*d;
    if(sy<heightAt(sx,sz)+0.55||capHit(sx,sy,sz))return CAP_DIST*(i-1)/14; }
  return CAP_DIST; }
let capElNow=CAP_EL; const capOut=[CAP_EL,CAP_DIST];
const capNear=[], capHid=[];
function capGather(){ capNear.length=0;
  for(const t of treeData)if(Math.hypot(t.x-pWorld.x,t.z-pWorld.z)<11)capNear.push({x:t.x,z:t.z,r:1.7,h:t.y+5.4});
  for(const p of PROPS){ const d=Math.hypot(p.x-pWorld.x,p.z-pWorld.z);
    if(d<5.5&&p.g){ capHid.push(p.g); p.g.visible=false; }   // standing inside it: hiding beats staring at its wall
    else if(d<12)capNear.push(p); } }
function capShow(){ for(const g of capHid)g.visible=true; capHid.length=0; }
function capHit(x,y,z){ for(const b of capNear)
  if(y<b.h&&(x-b.x)*(x-b.x)+(z-b.z)*(z-b.z)<b.r*b.r)return true; return false; }
function capSolve(a){                       // first (elevation, distance) pair on this bearing that sees the feet
  for(let e=0;e<6;e++){
    const el=CAP_EL+e*0.115, ce=Math.cos(el), ux=Math.cos(a)*ce, uy=Math.sin(el), uz=Math.sin(a)*ce;
    let t=CAP_DIST, hit=false;
    for(let i=2;i<=14;i++){ const d=CAP_DIST*i/14;
      const sx=pWorld.x+ux*d, sz=pWorld.z+uz*d, sy=pWorld.y+uy*d;
      if(sy<heightAt(sx,sz)+0.55||capHit(sx,sy,sz)){ t=CAP_DIST*(i-1)/14-0.15; hit=true; break; } }
    if(!hit||t>=3.4){ capOut[0]=el; capOut[1]=clamp(t,2.6,CAP_DIST); return; } }
  capOut[0]=CAP_EL+5*0.115; capOut[1]=CAP_DIST; }   // last resort: look down over whatever it is
function capPickArc(){                      // the widest run of clear bearings, scanned twice around for wrap
  const N=48, ok=[]; let any=false;
  for(let i=0;i<N;i++){ const c=capClear(i/N*TAU)>=3.4; ok.push(c); any=any||c; }
  capA0=0; capA1=TAU; capPhase=Math.PI/2;
  if(!any)return;                           // ringed in on every side: fall back to a plain full turn
  let bl=-1,st=0,en=0,s=-1,run=0;
  for(let i=0;i<N*2;i++){ if(ok[i%N]){ if(s<0)s=i; if(++run>bl){bl=run;st=s;en=i;} } else { s=-1; run=0; } }
  if(bl>=N)return;                          // clear all the way round
  const m=0.7;                              // pull in from both edges so the sweep never grazes the cliff
  capA0=(st+m)/N*TAU; capA1=(en+1-m)/N*TAU;
  if(capA1-capA0<0.5){ const c=(capA0+capA1)/2; capA0=c-0.25; capA1=c+0.25; } }
function capLabels(on){ for(const l of LABELS){ if(on){ l.userData._pv=l.visible; l.visible=false; }
  else if(l.userData._pv!==undefined)l.visible=l.userData._pv; } }
function capShadow(on){ const c=sun.shadow.camera, s=on?15:60; // tighten the shadow map or the close-up goes blocky
  c.left=-s;c.right=s;c.top=s;c.bottom=-s;c.updateProjectionMatrix(); }
function bestCatch(){ let bn='',bk=0;
  for(const k in state.dex){ const d=state.dex[k]; if(d&&d.best>bk){bk=d.best;bn=k;} }
  return bn?bn+' · '+bk+' kg':'·'; }
function renderCapCard(){ if(!capCardEl)return; const st=state.stats;
  const isles=state.worlds.filter(w=>WORLD_ORDER.includes(w)).length;
  const deeds=Object.keys(state.deeds||{}).length;
  const row=(ic,lab,val,cl)=>`<div class="crow"><span>${ic} ${lab}</span><b${cl?' style="color:'+cl+'"':''}>${val}</b></div>`;
  capCardEl.innerHTML=`<div class="capc">
    <div class="caph"><span class="cape">THE CAPTAIN</span><span class="capt">${state.titleId||'Castaway'}</span></div>
    <div class="capcoin">◈ ${fmt(state.coins)}</div>
    <div class="capgear">
      <span>${pixSVG('rod',15)}<b>Lv ${state.rodLvl}</b></span>
      <span>${pixSVG('pick',15)}<b>Lv ${state.pickLvl}</b></span>
      <span>${pixSVG('axe',15)}<b>Lv ${state.axeLvl}</b></span>
      <span>${pixSVG('boat',15)}<b>Lv ${state.boatLvl}</b></span></div>
    ${row(pixSVG('trophy',14),'Personal best',bestCatch(),'var(--gold)')}
    ${row(pixSVG('fish',14),'Fish caught',fmt(st.caught))}
    ${row(pixSVG('ore',14),'Ores mined',fmt(Math.max(0,st.mined-(st.wood||0))))}
    ${row(pixSVG('wood',14),'Logs chopped',fmt(st.wood||0))}
    ${row('◈','Coins earned',fmt(st.earned))}
    ${row('◉','Pearls (lifetime)',fmt(state.pearlsLife),'var(--teal)')}
    ${row(pixSVG('island',14),'Isles unlocked',isles+'/'+WORLD_ORDER.length)}
    ${row(pixSVG('map',14),'Deeds held',fmt(deeds))}
    <div class="capf"><b>1</b>–<b>8</b> emote · click the captain to cycle · <b>ESC</b> exits</div>
  </div>`; }

function openCam(){
  if(!running||capCam||marketOpen||casinoOpen||invOpen||harborOpen)return;
  initAudio();
  if(photoMode)togglePhoto();
  if(fishing.state!=='idle')cancelFish();
  if(mining.node)cancelMine();
  if(chopping.tree)cancelChop();
  digging.active=false;
  capCam=true;
  capGather(); capPickArc();               // know the obstacles, then find a bearing that can actually see him
  capAng=capA1-capA0>=TAU-0.01?Math.atan2(CAM_OFF.z,CAM_OFF.x):(capA0+capA1)/2;
  capPhase=capA1-capA0>=TAU-0.01?0:Math.PI/2;
  capSolve(capAng); capElNow=capOut[0];   // open at the right tilt instead of easing into it
  document.body.classList.add('capcam');
  capShadow(true); capLabels(true); renderCapCard(); markEmote(-1); hint('');
  faceCam(); addFreeze(0.05);
  beep(520,0.09,'sine',0.05); setTimeout(()=>beep(780,0.13,'sine',0.045),75); }
function closeCam(){
  if(!capCam)return;
  capCam=false; stopEmote();
  document.body.classList.remove('capcam');
  capShadow(false); capLabels(false); capShow();
  beep(300,0.09,'sine',0.04); }
function toggleCam(){ capCam?closeCam():openCam(); }

// ---- click the captain: no raycasting existed in this file, so this is the whole rig ----
const capRay=new THREE.Raycaster(), capNDC=new THREE.Vector2();
const heroHit=new THREE.Mesh(new THREE.BoxGeometry(1.5,2.5,1.5),
  new THREE.MeshBasicMaterial({visible:false}));   // material-invisible, not object-invisible: still raycastable
heroHit.position.y=1.15; player.add(heroHit);
let capDown=null;
renderer.domElement.addEventListener('pointerdown',e=>{ capDown={x:e.clientX,y:e.clientY,t:performance.now()}; });
renderer.domElement.addEventListener('pointerup',e=>{
  const dn=capDown; capDown=null;
  if(!dn||!running)return;
  if(Math.hypot(e.clientX-dn.x,e.clientY-dn.y)>6||performance.now()-dn.t>520)return; // a drag is not a click
  if(marketOpen||casinoOpen||invOpen||harborOpen)return;
  const r=renderer.domElement.getBoundingClientRect();
  capNDC.set(((e.clientX-r.left)/r.width)*2-1,-((e.clientY-r.top)/r.height)*2+1);
  capRay.setFromCamera(capNDC,camera);
  if(capRay.intersectObject(heroHit,false).length){ if(capCam)cycleEmote(); else openCam(); } });

if(emoBarEl){
  emoBarEl.innerHTML=EMO.map((m,i)=>
    `<button class="eslot" type="button"><span class="ee">${m.e}</span><span class="en">${m.n}</span><span class="ek">${i+1}</span></button>`).join('');
  emoBarEl.querySelectorAll('.eslot').forEach((b,i)=>b.addEventListener('click',()=>{ b.blur(); playBarEmote(i); })); }
const capBtnEl=document.getElementById('capBtn');
if(capBtnEl)capBtnEl.addEventListener('click',()=>toggleCam());
const autoBtnEl=document.getElementById('autoBtn');
if(autoBtnEl)autoBtnEl.addEventListener('click',()=>toggleAuto());
paintAuto();


/* ========================================================================
   13c. METEOR STRIKES — rare sky event that plants a rich, short-lived node
   ======================================================================== */
const meteors=[]; let metTimer=rand(80,190);
const METEOR_MAT=new THREE.MeshLambertMaterial({color:0x4a3c38,emissive:0xff6a2a,emissiveIntensity:0.7});
function spawnMeteor(){
  // land it a short walk away, on solid reachable ground so the player can actually get there
  let tries=0,ix,jz;
  do{ ix=(pWorld.x+rand(-16,16))|0; jz=(pWorld.z+rand(-16,16))|0; tries++; }
  while(tries<40&&heightAt(ix,jz)<=WATER_TOP+0.5);
  if(heightAt(ix,jz)<=WATER_TOP+0.5)return;
  const gy=heightAt(ix,jz);
  const g=new THREE.Group();
  const rock=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.75,0.9),METEOR_MAT); rock.position.y=0.38; rock.castShadow=true; g.add(rock);
  for(let k=0;k<5;k++){ const s=rand(0.16,0.24);
    const em=new THREE.Mesh(new THREE.BoxGeometry(s,s,s),new THREE.MeshLambertMaterial({color:0xff8a3a,emissive:0xff6a2a,emissiveIntensity:0.9}));
    const a=rand(0,TAU); em.position.set(Math.cos(a)*0.44,rand(0.2,0.7),Math.sin(a)*0.44); g.add(em); }
  g.position.set(ix,gy+26,jz); scene.add(g);                 // starts high and falls
  meteors.push({g,x:ix,z:jz,gy,vy:0,landed:false,life:95}); sfx.meteor();
  if(running)toast('☄ A METEOR is falling · find the crater!','gold');
}
function updateMeteors(dt){
  if((metTimer-=dt)<=0){ metTimer=rand(150,320); if(!WORLD.cave)spawnMeteor(); }
  for(let i=meteors.length-1;i>=0;i--){ const m=meteors[i];
    if(!m.landed){ m.vy+=dt*46; m.g.position.y-=m.vy*dt;
      m.g.rotation.x+=dt*4; m.g.rotation.z+=dt*3;
      fxBurst(m.g.position.x,m.g.position.y,m.g.position.z,{n:1,cols:[0xff8a3a,0xffd24f],speed:0.6,up:0.4,size:0.8,grav:2});
      if(m.g.position.y<=m.gy){ m.g.position.y=m.gy; m.g.rotation.set(0,rand(0,TAU),0); m.landed=true;
        addShake(0.5); addFreeze(0.1); sfx.boom();
        fxBurst(m.x,m.gy+0.4,m.z,{n:30,cols:[0xff6a2a,0xffd24f,0x4a3c38],speed:4.2,up:5,size:1.3,grav:9}); } }
    else { m.g.children[0].material.emissiveIntensity=0.5+Math.sin(clock*4)*0.25;
      if((m.life-=dt)<=0){ scene.remove(m.g); meteors.splice(i,1); } } }
}
function nearestMeteor(){ for(const m of meteors){ if(!m.landed)continue;
    if(Math.hypot(m.x-pWorld.x,m.z-pWorld.z)<2.0)return m; } return null; }
function claimMeteor(m){
  const idx=meteors.indexOf(m); if(idx>=0)meteors.splice(idx,1); scene.remove(m.g);
  addShake(0.35); addFreeze(0.08); sfx.win();
  fxBurst(m.x,m.gy+0.6,m.z,{n:28,cols:[0xff6a2a,0xffd24f,0x5ee8e2],speed:3.8,up:5,size:1.2});
  const gold=2+((Math.random()*3)|0), dia=1+((Math.random()*2)|0);
  state.ores.gold+=gold; state.ores.diamond+=dia; state.stats.mined+=gold+dia;
  addPearls(8,'meteor'); grantShare('DIGG');
  toast(`☄ Meteoric ore! +${gold} Gold +${dia} Diamond`,'gold');
  updateHUD(); save();
}

/* ========================================================================
   13d. SPIRIT FISH — a companion that trails you once you've earned it
   ======================================================================== */
let pet=null,petBob=0;
function buildPet(){ if(pet)return;
  const g=new THREE.Group();
  const body=new THREE.Mesh(new THREE.BoxGeometry(0.42,0.3,0.62),
    new THREE.MeshLambertMaterial({color:0x7fe6ff,emissive:0x2fa8d8,emissiveIntensity:0.75,transparent:true,opacity:0.82}));
  const tail=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.28,0.24),
    new THREE.MeshLambertMaterial({color:0xa8f0ff,emissive:0x2fa8d8,emissiveIntensity:0.6,transparent:true,opacity:0.75}));
  tail.position.z=-0.42;
  const eye=new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,0.05),new THREE.MeshBasicMaterial({color:0x0b1a22}));
  eye.position.set(0.16,0.06,0.28);
  const eye2=eye.clone(); eye2.position.x=-0.16;
  g.add(body,tail,eye,eye2); g.userData={tail}; sfx.pet();
  pet=g; scene.add(g); pet.position.set(pWorld.x,pWorld.y+2,pWorld.z);
}
function updatePet(dt){
  if(!state.pet){ if(pet){scene.remove(pet);pet=null;} return; }
  if(!pet)buildPet();
  petBob+=dt;
  // swims a lazy orbit behind the player's shoulder, always facing where it's headed
  const tx=pWorld.x-Math.sin(pWorld.face)*1.15+Math.cos(petBob*0.7)*0.5,
        tz=pWorld.z-Math.cos(pWorld.face)*1.15+Math.sin(petBob*0.7)*0.5,
        ty=pWorld.y+1.75+Math.sin(petBob*2.2)*0.16;
  const k=1-Math.exp(-3.4*dt);
  const px2=pet.position.x,pz2=pet.position.z;
  pet.position.x+=(tx-px2)*k; pet.position.z+=(tz-pz2)*k; pet.position.y+=(ty-pet.position.y)*k;
  const dx=pet.position.x-px2,dz=pet.position.z-pz2;
  if(dx*dx+dz*dz>1e-6)pet.rotation.y=lerpAngle(pet.rotation.y,Math.atan2(dx,dz),0.2);
  pet.userData.tail.rotation.y=Math.sin(petBob*9)*0.55;
  if(Math.random()<dt*1.6)fxBurst(pet.position.x,pet.position.y,pet.position.z,{n:1,cols:[0x7fe6ff,0xd9f6ff],speed:0.4,up:0.5,size:0.5,grav:-1});
}

/* ========================================================================
   13a. WOODCUTTING — chop trees for wood (they regrow)
   ======================================================================== */
const chopping={tree:null,t:0,dur:1.4};
function nearestTree(){ let bestT=null,bd=1e9;
  for(const t of treeData){ if(t.srvUntil?Date.now()<t.srvUntil:t.cd>clock)continue;
    const d=Math.hypot(t.x-pWorld.x,t.z-pWorld.z); if(d<bd){bd=d;bestT=t;} }
  return bestT&&bd<1.9?bestT:null; }
function cancelChop(){chopping.tree=null;hint('');}
function updateChopping(dt){ const t=chopping.tree;
  if(!t||(t.srvUntil?Date.now()<t.srvUntil:t.cd>clock)){cancelChop();return;}
  if(keys.up||keys.down||keys.left||keys.right){cancelChop();return;}
  if(keys.act){ chopping.t+=dt; } // impact fx/sfx fire from the swing animation, synced to the hit frame
  else { chopping.t-=dt*0.6; if(chopping.t<=0){cancelChop();return;} }
  chopping.t=clamp(chopping.t,0,chopping.dur);
  const p=chopping.t/chopping.dur,k=Math.floor(p*8);
  hint(`${pixSVG('axe',13)} Chopping… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  if(chopping.t>=chopping.dur){
    addShake(0.16); sfx.ore();
    const leafCols=t.pink?[0xec9fcb,0xf5b5d9,0x9a6b3a]:[0x3aa626,0x54cb3c,0x9a6b3a];
    fxBurst(t.x,t.y+3,t.z,{n:16,cols:leafCols,speed:2.6,up:1.6,size:1.1,grav:5});
    if(SRV.on){ const wasCd=t.cd; t.cd=clock+30+rand(0,15);
      SRV.act('chop',{tree:t.id}).then(r=>{
        if(r&&r.got)toast(`+${r.got} Wood`,'good');
        else if(!t.srvUntil)t.cd=wasCd; });   // refused: the tree is still standing
      cancelChop(); return; }
    t.cd=clock+30+rand(0,15);
    const wWood=(wState==='storm'?1.5:wState==='rain'||wState==='snow'||wState==='ash'?1.2:1); // wind brings the limbs down
    let got=Math.round((1+(Math.random()<Math.min(0.85,0.35+0.08*(state.axeLvl-1))?1:0)+(state.axeLvl>=6&&Math.random()<0.2?1:0))*wWood);
    got=Math.max(1,Math.round(RF.pipe('woodYield',got,{tree:t})));
    state.ores.wood+=got; state.stats.mined+=got; state.stats.wood=(state.stats.wood||0)+got;
    addPearls(1); if(Math.random()<0.04)grantShare('LUMB');
    toast(`+${got} Wood`,'good');
    RF.emit('chopped',{got:got,tree:t});
    cancelChop(); updateHUD(); save(); } }

/* ========================================================================
   13b. TREASURE DIGGING
   ======================================================================== */
// digging speed now rides the pickaxe tier — before this it was a flat 1.5s at every level
const digging={active:false,t:0,dur:1.5};
const digDur=()=>1.5/(1+(state.pickLvl-1)*0.16);
function treasureDist(){ const t=state.treasure; if(!t)return 1e9;
  if(t.w&&t.w!==worldKey)return 1e9; // the X is buried on another island
  return Math.hypot(t.i-HALF-pWorld.x,t.j-HALF-pWorld.z); }
function updateDigging(dt){
  if(!state.treasure){digging.active=false;hint('');return;}
  if(keys.up||keys.down||keys.left||keys.right){digging.active=false;hint('');return;}
  if(keys.act)digging.t+=dt; else { digging.t-=dt*0.6; if(digging.t<=0){digging.active=false;hint('');return;} }
  digging.t=clamp(digging.t,0,digging.dur);
  const p=digging.t/digging.dur,k=Math.floor(p*8);
  hint(`${pixSVG('map',13)} Digging… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  // scoop fx/sfx fire from the swing animation, synced to the blade hitting the dirt
  if(digging.t>=digging.dur){ digging.active=false;
    addShake(0.25); addFreeze(0.08);
    fxBurst(pWorld.x,pWorld.y+0.5,pWorld.z,{n:20,cols:[0xffd24f,0xffefb0,0x8a5a34],speed:3.4,up:4.5,size:1.1});
    if(SRV.on){ SRV.act('dig',{}).then(r=>{ if(r&&r.message)toast(r.message,'gold'); if(r&&r.coins)coinFly(r.coins); sfx.win(); });
      hint(''); return; }
    state.treasure=null; addPearls(10,'treasure');
    const r=Math.random();
    if(r<0.55){ const g=Math.round(rand(150,600)*(1+0.12*(state.rodLvl+state.pickLvl)));
      state.coins+=g; state.stats.earned+=g; coinFly(g); sfx.win(); toast(pixSVG('map',13)+' Buried treasure! +'+fmt(g)+' coins','gold'); }
    else if(r<0.85){ const ks=['coal','coal','iron','gold','diamond'],k2=ks[(Math.random()*ks.length)|0],n2=2+((Math.random()*4)|0);
      state.ores[k2]+=n2; state.stats.mined+=n2; sfx.ore(); toast(`${pixSVG('pick',13)} Treasure! +${n2} ${ORE_INFO[k2].name}`,'gold'); }
    else if(state.bucket.length<cap()){ let f=null; for(let k3=0;k3<25;k3++){ f=rollFish(true); if(RORDER[f.rar]>=2)break; }
      onCatch(f); toast(pixSVG('fish',13)+' A rare fish was buried here?!','gold'); }
    else { const g=300; state.coins+=g; state.stats.earned+=g; coinFly(g); toast('◈ +'+fmt(g)+' coins','gold'); }
    RF.emit('dug',{});
    hint(''); updateHUD(); save(); } }

/* ========================================================================
   14. INVENTORY + HOTBAR
   ======================================================================== */
let invOpen=false;
const invEl=document.getElementById('inv'),invTools=document.getElementById('invTools'),
  invFish=document.getElementById('invFish'),invOres=document.getElementById('invOres'),
  invStats=document.getElementById('invStats'),invDex=document.getElementById('invDex');
const HB={rod:document.getElementById('hbRod'),pick:document.getElementById('hbPick'),axe:document.getElementById('hbAxe'),
  bucket:document.getElementById('hbBucket'),pouch:document.getElementById('hbPouch')};
function updateHotbar(){ HB.rod.textContent='Lv'+state.rodLvl; HB.pick.textContent='Lv'+state.pickLvl;
  if(HB.axe)HB.axe.textContent='Lv'+state.axeLvl;
  HB.bucket.textContent=state.bucket.length+'/'+cap();
  HB.pouch.textContent=state.ores.wood+state.ores.coal+state.ores.iron+state.ores.gold+state.ores.diamond; }
function renderInv(){
  const rodNext=state.rodLvl<MAXLVL?`next ◈${fmt(upCost(ROD_BASE,state.rodLvl))} + ${reqLabel(UP_REQ[state.rodLvl+1])}`:'MAX';
  const pickNext=state.pickLvl<MAXLVL?`next ◈${fmt(upCost(PICK_BASE,state.pickLvl))} + ${reqLabel(UP_REQ[state.pickLvl+1])}`:'MAX';
  const axeNext=state.axeLvl<MAXLVL?`next ◈${fmt(axeCost(state.axeLvl))} + ${reqLabel(AXE_REQ[state.axeLvl+1])}`:'MAX';
  invTools.innerHTML=
    `<div class="fishrow"><span class="nm">${pixSVG('rod',15)} ${ROD_NAMES[state.rodLvl]} <span style="color:var(--teal)">Lv.${state.rodLvl}</span>
        <span style="color:var(--faint);font-size:11px">rod luck +${rodLuck(state.rodLvl).toFixed(2)} · on the hook: ${activeBait()?`${activeBait().name} ×${state.bait[state.baitId]}`:'nothing'} · total luck +${fishLuck().toFixed(2)}</span></span>
      <span class="rr" style="color:var(--muted)">${rodNext}</span></div>
    <div class="fishrow"><span class="nm">${pixSVG('axe',15)} ${AXE_NAMES[state.axeLvl]} <span style="color:var(--teal)">Lv.${state.axeLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${axeNext}</span></div>
    <div class="fishrow"><span class="nm">${pixSVG('pick',15)} ${PICK_NAMES[state.pickLvl]} <span style="color:var(--teal)">Lv.${state.pickLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${pickNext}</span></div>
    <div class="fishrow"><span class="nm">${pixSVG('boat',15)} ${BOATS[state.boatLvl].name} <span style="color:var(--teal)">Lv.${state.boatLvl}</span>
        <span style="color:var(--faint);font-size:11px">${seatLabel(state.boatLvl)} · sea luck +${Math.round(BOATS[state.boatLvl].luck*100)}%</span></span>
      <span class="rr" style="color:var(--muted)">${state.boatLvl<BOATS.length-1?'upgrade at the Harbor dock':'MAX'}</span></div>`;
  if(!state.bucket.length)invFish.innerHTML='<div class="empty">Bucket empty · go fishing!</div>';
  else{ let h='<div class="invgrid">';
    state.bucket.forEach(f=>{h+=`<div class="invcard" style="border-color:${RAR[f.rar]}55">${pixFish(RAR[f.rar],15)}
      <div class="inm">${f.name}<span style="color:var(--faint);font-size:10px"> ${f.kg||'?'} kg</span></div><div class="ivv">◈ ${fmt(f.val)}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</div></div>`;});
    invFish.innerHTML=h+'</div>'; }
  // Fishdex — every species across conditions, ??? until first caught
  { const seen=Object.keys(state.dex).length, total=ALL_FISH.length;
    let h=`<div class="seclab" style="margin-top:2px">Fishdex · ${seen}/${total}</div><div class="invgrid">`;
    for(const e of ALL_FISH){ const t=e[0],d=state.dex[t.name];
      if(d) h+=`<div class="invcard" style="border-color:${RAR[t.rar]}55">${pixFish(RAR[t.rar],15)}
        <div class="inm">${t.name}${e[2]?` <span style="color:var(--faint);font-size:9px">${pixSVG(e[2]==='night'?'moon':e[2]==='storm'?'storm':'rain',10)}</span>`:''}<span style="color:var(--faint);font-size:10px"> ×${d.n}</span></div>
        <div class="ivv" style="color:var(--teal)">${d.best} kg</div></div>`;
      else h+=`<div class="invcard" style="opacity:.45">${pixFish('#3a4a50',15)}
        <div class="inm" style="color:var(--faint)">???${e[2]?` <span style="font-size:9px">${pixSVG(e[2]==='night'?'moon':e[2]==='storm'?'storm':'rain',10)}</span>`:''}</div><div class="ivv" style="color:var(--faint)">—</div></div>`; }
    invDex.innerHTML=h+'</div>'; }
  let oh=''; for(const k in ORE_INFO){ const info=ORE_INFO[k];
    oh+=`<div class="fishrow">${oreIcon(k,16)}
      <span class="nm">${info.name}</span><span class="rr" style="color:var(--muted)">×${state.ores[k]}</span>
      <span class="vv">◈ ${fmt(info.price*priceMult(k))}/ea</span></div>`; }
  invOres.innerHTML=oh;
  const st=state.stats, wl=st.spins?` (${st.winsCt}W · ${st.losses}L)`:'';
  invStats.innerHTML=
    `<div class="statrow"><span>${pixSVG('fish',14)} Fish caught</span><b>${fmt(st.caught)}</b></div>
     <div class="statrow"><span>${pixSVG('pick',14)} Ores mined</span><b>${fmt(st.mined)}</b></div>
     <div class="statrow"><span>◈ Coins earned</span><b>${fmt(st.earned)}</b></div>
     <div class="statrow"><span>${pixSVG('wheel',14)} Roulette spins</span><b>${fmt(st.spins)}${wl}</b></div>
     <div class="statrow"><span>${pixSVG('trophy',14)} Biggest win</span><b>◈ ${fmt(st.bestWin)}</b></div>
     <div class="statrow"><span>◉ Pearls earned (lifetime)</span><b style="color:var(--teal)">◉ ${fmt(state.pearlsLife)}</b></div>
     ${(()=>{ const e2=mktEpochNow(); let pv=0,cb=0;
        for(const k of STOCK_KEYS){ const n=state.stocks.own[k]|0; if(!n)continue;
          pv+=n*stockBid(k,e2); cb+=n*Math.round(state.stocks.basis[k]||stockPrice(k,e2)); }
        const pl=pv-cb, up=pl>=0;
        return `<div class="statrow"><span>${pixSVG('chart',14)} Portfolio value</span><b>◈ ${fmt(pv)}</b></div>
          <div class="statrow"><span>${pixSVG('chart',14)} Unrealized P&amp;L</span><b style="color:${up?'var(--teal)':'var(--rose)'}">${up?'▲':'▼'} ◈ ${fmt(Math.abs(pl))}</b></div>
          <div class="statrow"><span>${pixSVG('chart',14)} Dividends received</span><b>◈ ${fmt(st.divEarned||0)}</b></div>`; })()}`;
  const achDone=ACH.filter(a=>state.ach[a[0]]).length;
  const achC=document.getElementById('achCount'); if(achC)achC.textContent=achDone+'/'+ACH.length;
  const achEl=document.getElementById('invAch');
  if(achEl)achEl.innerHTML=ACH.map(([id,name,desc,rw])=>{ const ok=!!state.ach[id];
    return `<div class="statrow" style="${ok?'':'opacity:.55'}"><span>${pixSVG('trophy',13)} <b style="color:${ok?'var(--gold)':'var(--muted)'}">${name}</b> <span style="color:var(--faint)">· ${desc}</span></span><b style="color:${ok?'var(--teal)':'var(--faint)'}">${ok?'✓ done':'◈ '+fmt(rw)}</b></div>`; }).join('');
  // Isle Ledger: certificate wall of minted deeds
  const ledEl=document.getElementById('invLedger');
  if(ledEl){ const got=DEEDS.filter(d=>state.deeds[d[0]]).length;
    const dc=document.getElementById('deedCount'); if(dc)dc.textContent=got+'/'+DEEDS.length;
    ledEl.innerHTML='<div class="deedgrid">'+DEEDS.map(([id,name,desc])=>{ const mint=state.deeds[id];
      if(!mint)return `<div class="deed locked"><div class="dt">???</div><div class="dd">${desc}</div><div class="dh">· not yet minted ·</div></div>`;
      return `<div class="deed"><span class="db">BLOCK #${fmt(mint)}</span><div class="dt">📜 ${name}</div><div class="dd">${desc}</div><div class="dh">${deedHash(id)}</div></div>`; }).join('')+'</div>'; }
}
const invTabs=document.querySelectorAll('#inv .tabbtn');
function setInvTab(t){ invTabs.forEach(b=>b.classList.toggle('sel',b.getAttribute('data-tab')===t));
  for(const k of ['bag','dex','stats','ledger','board']){ const p=document.getElementById('tab-'+k); if(p)p.style.display=k===t?'':'none'; }
  if(t==='board')renderBoard(); }

/* ---- Isle Leaderboard: who is actually ahead of you, refreshed on open ----
   The endpoint is public and cached server-side, so opening this tab costs
   nothing and works even while you are still deciding whether to sign in. */
let lbAt=0,lbRows=null;
function renderBoard(){
  const el=document.getElementById('invBoard'),who=document.getElementById('lbWho');
  if(!el)return;
  if(!(window.RFNet&&RFNet.base)){
    el.innerHTML='<div class="empty">Sign in to a server to see the leaderboard.</div>';
    if(who)who.textContent='offline'; return; }
  if(!lbRows)el.innerHTML='<div class="empty">Loading the board…</div>';
  paintBoard();
  if(Date.now()-lbAt<20000)return;              // server caches 30s; don't hammer it
  lbAt=Date.now();
  RFNet.leaderboard().then(d=>{ lbRows=(d&&d.entries)||[]; paintBoard(); })
    .catch(()=>{ el.innerHTML='<div class="empty">Could not reach the board.</div>'; });
  if(RFNet.online_)RFNet.online_().then(o=>{ if(who&&o)who.textContent=(o.total|0)+' online now'; }).catch(()=>{});
}
function paintBoard(){
  const el=document.getElementById('invBoard'); if(!el||!lbRows)return;
  if(!lbRows.length){ el.innerHTML='<div class="empty">Nobody has sold a fish yet. Be the first name up here.</div>'; return; }
  const me=(window.RFNet&&RFNet.user)||'';
  let mine=null;
  el.innerHTML=lbRows.map(r=>{
    const isMe=r.username===me; if(isMe)mine=r;
    const cls='lbrow'+(isMe?' me':'')+(r.rank<=3?' top'+r.rank:'');
    return `<div class="${cls}"><span class="rk">${r.rank===1?'★':r.rank}</span>
      <span class="who">${esc(r.username)}${isMe?' <span style="color:var(--teal)">· you</span>':''}
        ${r.title?`<small>${esc(r.title)}</small>`:''}</span>
      <span class="prl">◉ ${fmt(r.pearls||0)}</span>
      <span class="amt">◈ ${fmt(r.earned)}</span></div>`; }).join('')
    + (me&&!mine?`<div class="empty">You are not in the top ${lbRows.length} yet — keep fishing.</div>`:'');
}
invTabs.forEach(b=>b.addEventListener('click',()=>{sfx.tab();setInvTab(b.getAttribute('data-tab'));}));
function openInv(){ if(marketOpen||casinoOpen||harborOpen)return; invOpen=true; RF.emit('panel','inventory',true); sfx.open(); invEl.classList.add('on'); renderInv(); setInvTab('bag'); }
function closeInv(){ invOpen=false; RF.emit('panel','inventory',false); sfx.close(); invEl.classList.remove('on'); }
document.getElementById('invX').onclick=closeInv;
// --- hotbar selection: 1-5 pick the held tool; the empty-hand walk shows what you're carrying ---
let hotSlot=0;
const HOT_EL=[...document.querySelectorAll('#hotbar .slot')];
function setHotSlot(i){ sfx.click(); hotSlot=clamp(i,0,4);
  HOT_EL.forEach((el,k)=>el.classList.toggle('sel',k===hotSlot)); }
setHotSlot(0);
HOT_EL.forEach((s,i)=>{ s.addEventListener('click',()=>{
  if(i!==hotSlot&&i<3){ setHotSlot(i); return; }   // tool slots select; bucket/pouch (and re-click) open the bag
  if(invOpen)closeInv(); else openInv(); }); });

/* ========================================================================
   14b. SKY — day/night cycle + weather (rain, storm)
   ======================================================================== */
const DAY_LEN=420; // seconds per full day
const DAYKEYS=[
  [0.00,0x101c38,0.10,0.28],[0.06,0x101c38,0.10,0.28],[0.12,0xf7906a,0.34,0.45],
  [0.20,WORLD.sky,0.55,0.62],[0.60,WORLD.sky,0.55,0.62],[0.68,0xf7906a,0.32,0.45],
  [0.76,0x101c38,0.10,0.28],[1.00,0x101c38,0.10,0.28]];
const cA=new THREE.Color(),cB=new THREE.Color(),cRain=new THREE.Color(0x6b7f8a);
const cTop=new THREE.Color(),cBot=new THREE.Color(),cHaze=new THREE.Color(0xf7b06a),cWat=new THREE.Color();
let wTimer=rand(60,140),flashT=0;
// paint the gradient quad: `top` at the zenith, `bot` at the horizon
function paintSky(top,bot){ const c=skyGeo.attributes.color, a=c.array;
  a[0]=a[3]=top.r; a[1]=a[4]=top.g; a[2]=a[5]=top.b;
  a[6]=a[9]=bot.r; a[7]=a[10]=bot.g; a[8]=a[11]=bot.b; c.needsUpdate=true; }
// COLD worlds get snow instead of rain; the volcano gets ash. Weather is per-world now.
const isCold=()=>worldKey==='frost', isAsh=()=>worldKey==='volcano';
const SUN_DIR=new THREE.Vector3();
function skyUpdate(dt){
  if(WORLD.cave){ // eternal underground gloom: no day cycle, no weather — lamps and night fish rule
    dayT=0.02; wState='clear'; rainMesh.visible=false; snowMesh.visible=false;
    cA.setHex(WORLD.sky); scene.fog.color.copy(cA);
    paintSky(cA,cA); starMat.opacity=0;
    sunDisc.visible=sunGlow.visible=moonDisc.visible=moonGlow.visible=moonShade.visible=false;
    sun.intensity=0.12; hemiL.intensity=0.34; return; }
  { const nd=dayT+dt/DAY_LEN; if(nd>=1)dayCount++; dayT=nd%1; } // rolling over midnight advances the moon
  let seg=null;
  for(let k=0;k<DAYKEYS.length-1;k++){ if(dayT>=DAYKEYS[k][0]&&dayT<=DAYKEYS[k+1][0]){seg=[DAYKEYS[k],DAYKEYS[k+1]];break;} }
  if(!seg)seg=[DAYKEYS[0],DAYKEYS[1]];
  const u=(dayT-seg[0][0])/Math.max(1e-6,seg[1][0]-seg[0][0]);
  cA.setHex(seg[0][1]); cB.setHex(seg[1][1]); cA.lerp(cB,u);
  let sunI=lerp(seg[0][2],seg[1][2],u), hemiI=lerp(seg[0][3],seg[1][3],u);
  const wet=wState==='rain'||wState==='storm';
  if(wet){ cA.lerp(cRain,0.45); sunI*=0.55; }
  if(wState==='snow'){ cA.lerp(cB.setHex(0xc8d8e4),0.4); sunI*=0.7; }
  if(wState==='ash'){ cA.lerp(cB.setHex(0x6a4a42),0.42); sunI*=0.6; }
  if(flashT>0){ flashT-=dt; sunI+=1.0; cA.lerp(cB.setHex(0xffffff),0.25); }
  scene.fog.color.copy(cA);
  sun.intensity=sunI; hemiL.intensity=hemiI;

  /* --- the sky itself: gradient, arcing sun & moon, stars --- */
  // sun rides an arc from dawn (0.12) to dusk (0.76); the moon runs the opposite half
  const dayFrac=(dayT-0.12)/0.64, sunUp=dayFrac>=0&&dayFrac<=1;
  const sunAng=dayFrac*Math.PI, sunX=-Math.cos(sunAng), sunY=Math.sin(sunAng);
  let nf=(dayT-0.76)/0.36; if(nf<0)nf=(dayT+0.24)/0.36;      // night wraps midnight
  const moonAng=clamp(nf,0,1)*Math.PI, moonX=-Math.cos(moonAng), moonY=Math.sin(moonAng);
  const aspx=Math.max(1,window.innerWidth/window.innerHeight);
  // zenith is deeper than the horizon; dawn/dusk push a warm haze along the skyline
  cTop.copy(cA).multiplyScalar(0.72);
  cBot.copy(cA);
  const golden=sunUp?Math.max(0,1-Math.abs(sunY)*2.4):0;      // strongest when the sun is low
  if(golden>0)cBot.lerp(cHaze,golden*0.5);
  paintSky(cTop,cBot);
  sunDisc.visible=sunGlow.visible=sunUp;
  if(sunUp){ const x=sunX*aspx*0.92, y=sunY*0.95-0.12;
    sunDisc.position.set(x,y,0); sunGlow.position.set(x,y,0);
    sunGlow.material.opacity=0.16+golden*0.24;
    sunDisc.material.color.setHex(0xfff3c4).lerp(cHaze,golden*0.55); } // reddens at the horizon
  const moonUp=!sunUp;
  moonDisc.visible=moonGlow.visible=moonShade.visible=moonUp;
  if(moonUp){ const x=moonX*aspx*0.92, y=moonY*0.9-0.1;
    moonDisc.position.set(x,y,0); moonGlow.position.set(x,y,0);
    // lunar phase over an 8-day cycle: a shade box slides across the disc
    const ph=(Math.floor(dayCount)%8)/8, off=Math.cos(ph*TAU)*0.145;
    moonShade.position.set(x+off,y,0.01); moonShade.material.color.copy(cA); }
  starMat.opacity=clamp((isNight()?1:0)*(wet||wState==='snow'?0.25:1),0,1)*0.85;
  stars.visible=starMat.opacity>0.01;
  // the sea is the one surface that fills the frame, so let it carry the sky:
  // it reddens at golden hour and goes deep blue-black under stars
  cWat.setHex(WORLD.water).lerp(cA,0.34);
  if(golden>0)cWat.lerp(cHaze,golden*0.3);
  waterMat.color.copy(cWat);
  // the directional light now TRACKS the sun instead of sitting still all day
  const el=sunUp?Math.max(0.18,sunY):0.22;
  SUN_DIR.set(-sunX*0.75,el,0.42).normalize().multiplyScalar(120);
  sun.position.set(pWorld.x+SUN_DIR.x,SUN_DIR.y,pWorld.z+SUN_DIR.z);
  sun.target.position.set(pWorld.x,0,pWorld.z); sun.target.updateMatrixWorld();

  // weather state machine — each world rolls its own kinds of bad weather
  wTimer-=dt;
  if(wTimer<=0){ const r=Math.random(), prev=wState;
    if(isCold()) wState=r<0.45?'clear':r<0.85?'snow':'storm';
    else if(isAsh()) wState=r<0.5?'clear':r<0.82?'ash':'storm';
    else wState=r<0.55?'clear':r<0.88?'rain':'storm';
    wTimer=rand(70,160);
    if(running&&wState!==prev){ (wState==='storm'?sfx.thunder:sfx.gust)();
      if(wState==='rain')toast(pixSVG('rain',13)+' Rain · fish bite faster!','good');
      else if(wState==='snow')toast(pixSVG('rain',13)+' Snowfall · the ice fish rise…','good');
      else if(wState==='ash')toast(pixSVG('rain',13)+' Ashfall · the vents are venting…','gold');
      else if(wState==='storm')toast(pixSVG('storm',13)+' STORM · rare fish stir…','gold');
      else toast(pixSVG('sun',13)+' Skies clear'); } }
  if(wState==='storm'&&Math.random()<dt*0.22){ flashT=0.12; setTimeout(sfx.rumble,rand(180,700)|0);
    setTimeout(()=>beep(58,0.4,'sawtooth',0.07),rand(150,500)); }
  rainMesh.visible=wet;
  snowMesh.visible=wState==='snow'||wState==='ash';
  if(snowMesh.visible)snowMesh.material.color.setHex(wState==='ash'?0x6b5a52:0xffffff);
}
// rain: instanced streaks falling around the player
const RAINN=240;
const rainMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(0.03,0.55,0.03),
  new THREE.MeshBasicMaterial({color:0x9fd4ff,transparent:true,opacity:0.45}),RAINN);
rainMesh.frustumCulled=false; rainMesh.visible=false; scene.add(rainMesh);
const rainP=[]; for(let k=0;k<RAINN;k++)rainP.push({ox:rand(-14,14),oz:rand(-14,14),y:rand(2,16)});
function rainUpdate(dt){ if(!rainMesh.visible)return;
  for(let k=0;k<RAINN;k++){ const p=rainP[k];
    p.y-=dt*(wState==='storm'?30:22);
    if(p.y<WATER_TOP-1){ p.y=rand(12,16); p.ox=rand(-14,14); p.oz=rand(-14,14); }
    dummy.position.set(pWorld.x+p.ox,p.y,pWorld.z+p.oz);
    dummy.rotation.set(0,0,0.12); dummy.scale.set(1,1,1);
    dummy.updateMatrix(); rainMesh.setMatrixAt(k,dummy.matrix); }
  rainMesh.instanceMatrix.needsUpdate=true; }
// snow / volcanic ash: fat slow flakes that drift sideways instead of falling straight
const SNOWN=200;
const snowMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(0.13,0.13,0.13),
  new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.8}),SNOWN);
snowMesh.frustumCulled=false; snowMesh.visible=false; scene.add(snowMesh);
const snowP=[]; for(let k=0;k<SNOWN;k++)snowP.push({ox:rand(-14,14),oz:rand(-14,14),y:rand(2,16),ph:rand(0,TAU),sp:rand(1.4,2.8)});
function snowUpdate(dt){ if(!snowMesh.visible)return;
  for(let k=0;k<SNOWN;k++){ const p=snowP[k];
    p.y-=dt*p.sp;
    if(p.y<WATER_TOP-1){ p.y=rand(12,16); p.ox=rand(-14,14); p.oz=rand(-14,14); }
    const sway=Math.sin(clock*0.8+p.ph)*0.9;                 // lazy sideways drift
    dummy.position.set(pWorld.x+p.ox+sway,p.y,pWorld.z+p.oz+Math.cos(clock*0.6+p.ph)*0.6);
    dummy.rotation.set(clock*0.6+p.ph,clock*0.4+p.ph,0); dummy.scale.setScalar(1);
    dummy.updateMatrix(); snowMesh.setMatrixAt(k,dummy.matrix); }
  snowMesh.instanceMatrix.needsUpdate=true; }
// HUD time/weather chip
const timeIco=document.getElementById('timeIco'),wIco=document.getElementById('wIco');
let chipT=1,chipKey='';  // start past the 0.5s gate so the dial paints on the very first frame
/* --- the sky dial: a pocket-sized sky in the HUD -----------------------------
   The world camera can never show the real sky (an orthographic look-down means
   every screen ray hits ground), so the celestial state gets its own readout.
   It doubles as useful information: night-only species are worth watching for.
   -------------------------------------------------------------------------- */
const skyDial=document.getElementById('skyDial'), skyDialX=skyDial?skyDial.getContext('2d'):null;
const DIAL_STARS=[]; for(let k=0;k<16;k++)DIAL_STARS.push([rand(4,128),rand(3,20)]);
function drawSkyDial(){ if(!skyDialX)return;
  const g=skyDialX,W=132,H=40,HZ=30;                       // HZ = the dial's horizon line
  const hx='#'+cA.getHexString();
  const grd=g.createLinearGradient(0,0,0,HZ);
  const top=cA.clone().multiplyScalar(0.62);
  grd.addColorStop(0,'#'+top.getHexString()); grd.addColorStop(1,hx);
  g.clearRect(0,0,W,H); g.fillStyle=grd; g.fillRect(0,0,W,HZ);
  const night=isNight();
  if(night){ g.fillStyle='rgba(255,255,255,.75)';
    for(const [sx,sy] of DIAL_STARS)g.fillRect(sx,sy,1,1); }
  // the sun and moon ride the same arc, half a day apart
  const dayFrac=(dayT-0.12)/0.64, up=dayFrac>=0&&dayFrac<=1;
  let nf=(dayT-0.76)/0.36; if(nf<0)nf=(dayT+0.24)/0.36;
  const fr=up?dayFrac:clamp(nf,0,1), ang=fr*Math.PI;
  const cx=8+(1-Math.cos(ang))/2*(W-16), cy=HZ-Math.sin(ang)*(HZ-8);
  g.strokeStyle='rgba(255,255,255,.16)'; g.lineWidth=1;                 // the arc itself
  g.beginPath(); for(let k=0;k<=32;k++){ const a=k/32*Math.PI;
    const x=8+(1-Math.cos(a))/2*(W-16), y=HZ-Math.sin(a)*(HZ-8);
    k?g.lineTo(x,y):g.moveTo(x,y); } g.stroke();
  if(up){ g.fillStyle='rgba(255,225,150,.28)'; g.beginPath(); g.arc(cx,cy,9,0,TAU); g.fill();
    g.fillStyle='#fff3c4'; g.beginPath(); g.arc(cx,cy,5,0,TAU); g.fill(); }
  else { g.fillStyle='rgba(200,220,255,.22)'; g.beginPath(); g.arc(cx,cy,8,0,TAU); g.fill();
    g.fillStyle='#f2f6ff'; g.beginPath(); g.arc(cx,cy,4.5,0,TAU); g.fill();
    const ph=(Math.floor(dayCount)%8)/8;                                // carve the phase with a shade disc
    g.fillStyle=hx; g.beginPath(); g.arc(cx+Math.cos(ph*TAU)*5.2,cy,4.5,0,TAU); g.fill(); }
  g.fillStyle='rgba(10,20,26,.85)'; g.fillRect(0,HZ,W,H-HZ);            // ground band
  g.fillStyle=night?'#57b7ff':'#ffcf5c'; g.font='bold 9px monospace'; g.textBaseline='middle';
  // how long until the light flips — the number a night-fisher actually wants
  const toNight=((0.76-dayT)+1)%1, toDay=((0.12-dayT)+1)%1;
  const secs=Math.round((night?toDay:toNight)*DAY_LEN);
  g.fillText((night?'☾ dawn ':'☀ dusk ')+Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'),4,H-5);
  if(wState!=='clear'){ g.fillStyle=wState==='storm'?'#ff5d7a':wState==='snow'?'#dff0ff':wState==='ash'?'#c9a08a':'#9fd4ff';
    g.fillText(wState.toUpperCase(),W-4-g.measureText(wState.toUpperCase()).width,H-5); } }
function chipUpdate(){ drawSkyDial(); if(!timeIco)return;
  const t=isNight()?'moon':(dayT>0.6&&dayT<0.76)||(dayT>0.06&&dayT<0.2)?'dusk':'sun';
  const w=wState==='storm'?'storm':wState==='rain'?'rain':wState==='snow'||wState==='ash'?'rain':'';
  const key=t+'|'+w; if(key===chipKey)return; chipKey=key;
  timeIco.innerHTML=pixSVG(t,14); wIco.innerHTML=w?pixSVG(w,14):''; }

/* ========================================================================
   15. MOVEMENT / INTERACTIONS / LOOP
   ======================================================================== */
const FWD=new THREE.Vector3(-1,0,-1).normalize();
const RIGHT=new THREE.Vector3().crossVectors(FWD,new THREE.Vector3(0,1,0)).normalize();
let running=false,last=0,clock=0;
const moveDir=new THREE.Vector3();
function tryMove(dt){
  let ix=(keys.right?1:0)-(keys.left?1:0), iy=(keys.up?1:0)-(keys.down?1:0);
  if(!ix&&!iy){pWorld.step=0;return;}
  moveDir.set(0,0,0).addScaledVector(FWD,iy).addScaledVector(RIGHT,ix);
  if(moveDir.lengthSq()<1e-4){pWorld.step=0;return;}
  moveDir.normalize();
  const st0=pWorld.step; pWorld.step+=dt*9;
  if((st0/Math.PI|0)!==(pWorld.step/Math.PI|0)) sfx.step(stepSurf()); // one footfall per half-stride
  const sp=Math.max(0.5,RF.pipe('moveSpeed',7.0)), curH=heightAt(pWorld.x,pWorld.z);
  const nx=pWorld.x+moveDir.x*sp*dt;
  if(!isWaterAt(nx,pWorld.z)&&Math.abs(heightAt(nx,pWorld.z)-curH)<2&&Math.abs(nx)<HALF-1)pWorld.x=nx;
  const nz=pWorld.z+moveDir.z*sp*dt, curH2=heightAt(pWorld.x,pWorld.z);
  if(!isWaterAt(pWorld.x,nz)&&Math.abs(heightAt(pWorld.x,nz)-curH2)<2&&Math.abs(nz)<HALF-1)pWorld.z=nz;
  pWorld.face=Math.atan2(moveDir.x,moveDir.z);
}
// frost's 'grass' is snow underfoot — everything else walks as its cell type reads
function stepSurf(){ const t=cellType(heightAt(pWorld.x,pWorld.z)); return t==='grass'&&isCold()?'snow':t; }
let tree=null;
function interactions(){
  if(RF.claim('interact'))return;
  const dT=Math.hypot(pWorld.x-TRADER_POS.x,pWorld.z-TRADER_POS.z), dC=Math.hypot(pWorld.x-CASINO_POS.x,pWorld.z-CASINO_POS.z);
  const ore=nearestOre(), met=nearestMeteor();
  const w=nearestWater(), canFish=w&&w.dist<2.4;
  /* The rig owns the interact loop, but ONLY while you are standing still at
     the water. Walk away and every other prompt — Trader, Harbor, ore — reads
     exactly as it does with the rig off, so you can still go sell your bucket
     without switching it off first. */
  if(autoFish.on&&canFish&&!isMoving()){
    if(state.bucket.length>=cap())setAuto(false,'Bucket full · the auto-rig stopped');
    else{ const wait=Math.max(0,(autoFish.nextAt-Date.now())/1000);
      hint(`${pixSVG('rod',13)} <b>auto-rig</b> ${wait>0.05?`resetting the line… <b>${wait.toFixed(1)}s</b>`:'casting'} · <span class="key">F</span> stop`);
      if(wait<=0)startCast(w);
      return; } }
  if(dT<2.6){ hint('<span class="key">E</span> Trade at the Market'); if(actEdge){initAudio();openMarket();} }
  else if(dC<2.8){ hint('<span class="key">E</span> Enter the Spinning Eel'); if(actEdge){initAudio();openCasino();} }
  else if(PORTAL_POS&&Math.hypot(pWorld.x-PORTAL_POS.x,pWorld.z-PORTAL_POS.z)<2.2){
    const pd=portalDest();
    if(pd){ hint(`<span class="key">E</span> Step through → <b>${WORLDS[pd].name}</b>`); if(actEdge){initAudio();buyOrSail(pd);} }
    else hint('Portal dormant · unlock more isles at the Market'); }
  else if(mineProps.door&&Math.hypot(pWorld.x-mineProps.door.x,pWorld.z-mineProps.door.z)<2.1){
    hint(pixSVG('pick',13)+` <span class="key">E</span> `+(WORLD.cave?`Climb back to <b>${WORLDS[caveReturn()].name}</b>`
      :state.worlds.includes('cave')?'Descend into <b>The Undermine</b>'
      :`Open the shaft &amp; descend · <span style="color:var(--gold)">◈ ${fmt(WORLDS.cave.cost)}</span>`));
    if(actEdge)caveTravel(); }
  else if(HARBOR_POS&&Math.hypot(pWorld.x-HARBOR_POS.x,pWorld.z-HARBOR_POS.z)<2.6){
    hint(pixSVG('boat',13)+' <span class="key">E</span> The Harbor · shipwright &amp; sailings'); if(actEdge){initAudio();openHarbor();} }
  else if(treasureDist()<1.8){ hint(pixSVG('map',13)+' <span class="key">E</span> Dig here!'); if(actEdge){initAudio();digging.active=true;digging.t=0;digging.dur=digDur();} }
  else if(met){ hint('☄ <span class="key">E</span> <b style="color:var(--gold)">Crack the meteorite</b>'); if(actEdge){initAudio();claimMeteor(met);} }
  else if(ore){ hint(`<span class="key">E</span> ${ore.geode?'<b style="color:var(--gold)">Crack the geode</b>':'Mine '+ORE_INFO[ore.type].name}`); if(actEdge)startMine(ore); }
  else if((tree=nearestTree())){ hint(pixSVG('axe',13)+' <span class="key">E</span> Chop wood'); if(actEdge){initAudio();chopping.tree=tree;chopping.t=0;chopping.dur=1.4/(1+(state.axeLvl-1)*0.22);} }
  else if(canFish){ if(state.bucket.length>=cap())hint('Bucket full · sell at the Trader'); else { hint('<span class="key">E</span> Cast your line'); if(actEdge)startCast(w); } }
  else hint('');
}
let lastBiome='',bannerT=0,mktEpochSeen=Math.floor(Date.now()/MKT_MS);
function biomeCheck(){ const t=cellType(heightAt(pWorld.x,pWorld.z));
  if(t!==lastBiome){ lastBiome=t;
    if(t==='stone')setArea(WORLD.cave?'The Undermine':(WORLD.oreN>0?'The Quarry':'The Rocks'),WORLD.oreN>0?'hold E on ore to mine':'find the mine shaft · ore waits below');
    else if(t==='sand')setArea('Shoreline','cast your line'); } }
// smoothed camera state — the view flies between follow-cam and the casino table
const CAS_CAM_OFF=new THREE.Vector3(7.5,13,7.5);           // steeper angle: look down onto the wheel face, over the decor
const CAS_SHIFT=new THREE.Vector3(0.78,0,-0.78);           // nudge the table left of center, clear of the bet panel
const vTargP=new THREE.Vector3(),vTargL=new THREE.Vector3();
const vPos=new THREE.Vector3(pWorld.x+CAM_OFF.x,pWorld.y+CAM_OFF.y,pWorld.z+CAM_OFF.z),
      vLook=new THREE.Vector3(pWorld.x,pWorld.y+1,pWorld.z);
let vSize=camSize;
const swing={p:0,last:0}; let leanT=0,mineFlinch=0; // action-animation state (windup→strike→impact)
function animate(now){
  // clamp BOTH ends: a backwards or NaN rAF timestamp made dt negative, which flipped
  // vk=1-exp(-4.5*dt) hugely negative and blew the camera lerp out to garbage coordinates
  let dt=clamp((now-last)/1000||0,0,0.033); last=now;
  const rdt=dt; // real dt — camera easing/shake keep moving through hit-stop
  if(freezeT>0){freezeT-=dt;dt*=0.08;} // hit-stop: world slows for a beat
  clock+=dt;
  if(running){
    const overlay=marketOpen||casinoOpen||invOpen||harborOpen||capCam;
    if(!overlay){ if(fishing.state!=='idle')updateFishing(dt); else if(mining.node)updateMining(dt); else if(chopping.tree)updateChopping(dt); else if(digging.active)updateDigging(dt); else { tryMove(dt); interactions(); } } else hint('');

    const targetY=heightAt(pWorld.x,pWorld.z);
    pWorld.y=lerp(pWorld.y,targetY,0.35);
    player.rotation.y=lerpAngle(player.rotation.y,pWorld.face,0.2);
    const moving=(keys.up||keys.down||keys.left||keys.right)&&fishing.state==='idle'&&!overlay&&!mining.node&&!chopping.tree;
    const sw=moving?Math.sin(pWorld.step)*0.5:0, pd=player.userData;
    if(pd.legL){pd.legL.rotation.x=sw;pd.legR.rotation.x=-sw;pd.armL.rotation.x=-sw*0.7;pd.armR.rotation.x=sw*0.7;}
    if(pd.scarfTail)pd.scarfTail.rotation.x=0.25+Math.sin(clock*3.2)*0.12+(moving?0.35:0);
    // activity animations: windup → strike → IMPACT (fx/sfx fire on the hit frame), whole-body language
    const act=fishing.state!=='idle'?'fish':mining.node?'mine':chopping.tree?'chop':digging.active?'dig':'';
    let lean=moving?0.06:0; const eo=t=>1-(1-t)*(1-t);
    pd.armL.rotation.z=0;
    if(act==='fish'){ const f=fishing;
      if(bobber.visible)pWorld.face=Math.atan2(bobber.position.x-pWorld.x,bobber.position.z-pWorld.z); // square up to the water
      if(f.state==='cast'){ const c=f.cast,w=0.24;
        if(c<w){ const q=eo(c/w); pd.armR.rotation.x=lerp(-0.9,-2.9,q); rodMesh.rotation.x=-0.7-q*0.5; lean=-0.07*q; } // snap back…
        else{ const q=Math.min(1,(c-w)/0.34); pd.armR.rotation.x=lerp(-2.9,-0.35,q*q); rodMesh.rotation.x=-1.2+q*0.95; lean=lerp(-0.07,0.13,q); } // …whip forward
        pd.armL.rotation.x=-0.25; }
      else if(f.state==='wait'){ pd.armR.rotation.x=-0.95+Math.sin(clock*1.7)*0.05; pd.armL.rotation.x=-0.12+Math.sin(clock*1.7+1)*0.04;
        rodMesh.rotation.x=-0.55; lean=0.04; }
      else if(f.state==='bite'){ const j=Math.sin(clock*26); pd.armR.rotation.x=-0.8+j*0.15; pd.armL.rotation.x=-0.45+j*0.1;
        rodMesh.rotation.x=-0.55+Math.max(0,j)*0.4; lean=0.1; } // the rod yanks down in sharp jerks
      else if(f.state==='reel'){ const on=keys.act, pump=Math.sin(clock*(on?9:2.4))*(on?1:0.25);
        pd.armR.rotation.x=-1.15+pump*0.35; rodMesh.rotation.x=-0.95+pump*0.3;
        pd.armL.rotation.x=-0.95+Math.cos(clock*(on?15:3))*0.45; pd.armL.rotation.z=0.4; // left hand cranks the reel
        lean=-0.09+pump*0.045; } } // leaning back against the fish
    else if(act==='mine'||act==='chop'||act==='dig'){
      const tgt=act==='mine'?mining.node:act==='chop'?chopping.tree:null;
      if(tgt)pWorld.face=Math.atan2(tgt.x-pWorld.x,tgt.z-pWorld.z); // square up to the target
      const HIT=0.58, rate=keys.act?(act==='dig'?1.35:1.8):0.5;
      swing.last=swing.p; swing.p=(swing.p+dt*rate)%1;
      const P=swing.p, hit=keys.act&&swing.last<HIT&&P>=HIT&&swing.last<=P;
      let a,wr;
      if(P<0.42){ const q=eo(P/0.42); a=lerp(-0.7,-2.55,q); wr=-0.4*q; lean=lerp(lean,-0.09,q); }                  // heavy windup
      else if(P<HIT){ const q=(P-0.42)/(HIT-0.42); a=lerp(-2.55,-0.12,q*q*q); wr=lerp(-0.4,0.55,q*q); lean=lerp(-0.09,0.2,q); } // accelerating strike
      else{ const q=eo((P-HIT)/(1-HIT)); a=lerp(-0.12,-0.7,q); wr=lerp(0.55,0,q); lean=lerp(0.2,0,q); }           // recover
      pd.armR.rotation.x=a; pd.armL.rotation.x=a*0.8; pd.armL.rotation.z=0.28; // two-handed grip
      (act==='chop'?axeMesh:act==='dig'?shovelMesh:pickMesh).rotation.x=-0.65+wr; // wrist: the tool head leads the arc
      if(hit){
        if(act==='mine'){ const n=mining.node; sfx.pick(); addShake(0.06); mineFlinch=1;
          fxBurst(n.x,n.y+0.7,n.z,{n:6,cols:[0x9aa1a8,0x747c84,ORE_INFO[n.type].color],speed:2.6,up:2.8,size:0.9}); }
        else if(act==='chop'){ const t2=chopping.tree; sfx.chop(); addShake(0.05);
          fxBurst(t2.x,t2.y+1.1,t2.z,{n:5,cols:[0x9a6b3a,0x7d5530,0xc79a5e],speed:2.4,up:2.4,size:0.9});
          fxBurst(t2.x,t2.y+2.8,t2.z,{n:3,cols:t2.pink?[0xec9fcb,0xf5b5d9]:[0x3aa626,0x54cb3c],speed:1.4,up:0.6,size:0.8,grav:3}); }
        else{ const fx2=pWorld.x+Math.sin(pWorld.face)*0.6, fz2=pWorld.z+Math.cos(pWorld.face)*0.6;
          sfx.dig(); addShake(0.04);
          fxBurst(fx2,pWorld.y+0.15,fz2,{n:7,cols:[0x8a5a34,0x9a683e,0x6d4526],speed:2.2,up:3,size:0.95,grav:8}); } }
      if(act==='mine'&&mining.node){ mining.node.mesh.scale.setScalar(1+mineFlinch*0.09); mineFlinch*=Math.exp(-9*dt); } } // flinch on hit, then relax
    else{ swing.p=swing.last=0; rodMesh.rotation.x=-0.7; }
    leanT=lerp(leanT,lean,1-Math.exp(-10*dt)); player.rotation.x=leanT;
    // idle/walking, the hero carries whatever the hotbar has selected
    const carry=act?'':['fish','mine','chop'][hotSlot]||'';
    rodMesh.visible=(act==='fish'||carry==='fish');
    pickMesh.visible=(act==='mine'||carry==='mine');
    shovelMesh.visible=(act==='dig');
    axeMesh.visible=(act==='chop'||carry==='chop');
    player.position.set(pWorld.x, pWorld.y+(moving?Math.abs(Math.sin(pWorld.step))*0.08:0), pWorld.z);
    updateEmote(rdt); // rdt, not dt: a meteor's hit-stop must not slow a cinematic to 8% speed

    // respawn: online the server's clock rules (so every player sees the same node return)
    for(const n of oreNodes){ if(n.alive)continue;
      const back=n.srvUntil?Date.now()>=n.srvUntil:(n.respawnAt>0&&clock>=n.respawnAt);
      if(back){n.alive=true;n.mesh.visible=true;n.srvUntil=0;} }
    biomeCheck();
    if((achT+=dt)>1.4){achT=0;checkAch();checkDeeds();payDividends();checkBounties();}
    if(oreComboT>0&&(oreComboT-=dt)<=0)oreCombo=0;   // the vein goes cold if you dawdle
    updateMeteors(dt); updatePet(dt);
    if(titleSprite){ titleSprite.visible=!capCam; titleSprite.position.set(pWorld.x,pWorld.y+2.95,pWorld.z); }
    if(marketOpen===true&&clock-bannerT>0.5){bannerT=clock;renderBanner();
      const e=Math.floor(Date.now()/MKT_MS);
      if(e!==mktEpochSeen){mktEpochSeen=e;renderMarket();renderOres();renderStocks();}}
    if(areaT>0){areaT-=dt;if(areaT<=0)H.area.classList.remove('on');}
    if(revT>0){renderFishScene(dt);revT-=dt;if(revT<=0){revEl.classList.remove('on');disposeFishModel();}}
    RF.emit('tick',dt,rdt);
  }

  // camera: smooth fly between the follow-cam and a close-up over the roulette table
  if(!running){ const ta=clock*0.05; vTargL.set(0,5,0); vTargP.set(Math.cos(ta)*62,50,Math.sin(ta)*62); } // title: slow cinematic orbit of the isle
  else if(viewMode==='casino'){ vTargL.copy(WHEEL_CENTER).addScaledVector(CAS_SHIFT,1); vTargP.copy(vTargL).add(CAS_CAM_OFF); }
  else if(capCam){ // Captain Cam: a slow turntable, framed left of centre so the stat card has room
    capPhase+=CAP_ORBIT*rdt*(capA1-capA0>=TAU-0.01?1:1.7);
    const span=capA1-capA0;
    capAng=span>=TAU-0.01?capA0+capPhase                       // open ground: keep turning
      :capA0+span*(0.5-0.5*Math.cos(capPhase));                // boxed in: ease back and forth across the arc
    capSolve(capAng);
    capElNow=lerp(capElNow,capOut[0],1-Math.exp(-3.5*rdt));   // ease the tilt so a passing ridge never snaps it
    const cs=Math.cos(capAng), sn=Math.sin(capAng), ce=Math.cos(capElNow), t=capOut[1];
    const ux=cs*ce, uy=Math.sin(capElNow), uz=sn*ce;
    vTargL.set(pWorld.x+sn*CAP_SHIFT,pWorld.y+1.15,pWorld.z-cs*CAP_SHIFT); // +camera-right shifts the hero LEFT
    vTargP.set(vTargL.x+ux*t,vTargL.y+uy*t,vTargL.z+uz*t); }
  else if(photoMode){ // free orbit around the hero; tilting down to the horizon is what finally reveals the sky
    photoAng+=((keys.right?1:0)-(keys.left?1:0))*rdt*1.1;
    // 0.55 is the verified floor. Lower than this and two things break: an orthographic camera
    // flattens the sea into a sliver at grazing angles, and the terrain's hollow column bottoms
    // come into view. Sealing that properly would mean changing terrain generation.
    photoPitch=clamp(photoPitch+((keys.up?1:0)-(keys.down?1:0))*rdt*0.7,0.55,1.3);
    const r=camSize*1.5, ey=camSize*1.5*photoPitch;
    vTargP.set(pWorld.x+Math.cos(photoAng)*r,pWorld.y+1.1+ey,pWorld.z+Math.sin(photoAng)*r);
    vTargL.set(pWorld.x,pWorld.y+1.1,pWorld.z); }
  else{ vTargP.set(pWorld.x+CAM_OFF.x,pWorld.y+CAM_OFF.y,pWorld.z+CAM_OFF.z); vTargL.set(pWorld.x,pWorld.y+1,pWorld.z); }
  const vTargS=!running?15:viewMode==='casino'?3.2:capCam?CAP_SIZE:camSize, vk=1-Math.exp(-4.5*rdt);
  if(photoSnap){ photoSnap=false; vPos.copy(vTargP); vLook.copy(vTargL); vSize=vTargS; }
  else { vPos.lerp(vTargP,vk); vLook.lerp(vTargL,vk); vSize+=(vTargS-vSize)*vk; }
  { const a=window.innerWidth/window.innerHeight, zs=Math.max(0.5,vSize-camPunch); // camPunch: a quick shove in on a win
    camera.left=-zs*a;camera.right=zs*a;camera.top=zs;camera.bottom=-zs;camera.updateProjectionMatrix(); }
  camera.position.copy(vPos);
  camera.lookAt(vLook);
  if(trauma>0){ const sh=trauma*trauma*(viewMode==='casino'?0.22:capCam?0.13:0.55); // sh is in world units: a close-up needs far less
    camera.position.x+=rand(-sh,sh); camera.position.y+=rand(-sh,sh)*0.5; camera.position.z+=rand(-sh,sh);
    trauma=Math.max(0,trauma-rdt*2.4); }
  updateRoulette(dt);
  updateWinFx(dt,rdt);
  fxUpdate(dt);

  animWater(clock); animGrass(clock);
  skyUpdate(dt); rainUpdate(dt); snowUpdate(dt);
  if((chipT+=dt)>0.5){chipT=0;chipUpdate();}
  water.position.y=WATER_TOP+Math.sin(clock*0.8)*0.03;
  if(dockBoat){ dockBoat.position.y=WATER_TOP+0.03+Math.sin(clock*0.85+1)*0.045;
    dockBoat.rotation.z=Math.sin(clock*0.7)*0.02; dockBoat.rotation.x=Math.sin(clock*0.55+2)*0.015;
    animBoat(dockBoat,clock); }
  if(harborOpen)renderDockView(dt);
  trader.rotation.y=Math.sin(clock*0.5)*0.25;
  if(mineProps.cart)mineProps.cart.position.z=mineProps.z0+(mineProps.z1-mineProps.z0)*(0.5+0.5*Math.sin(clock*0.45));
  if(mineProps.wheel)mineProps.wheel.rotation.y=clock*1.3;
  if(portalSwirl){ portalSwirl.rotation.z=-clock*1.6; const ps=1+Math.sin(clock*2.1)*0.07; portalSwirl.scale.set(ps,ps,1);
    portalCore.material.emissiveIntensity=0.45+Math.sin(clock*2.6)*0.18;
    for(const b of portalBits){ const u=b.userData,a2=clock*u.sp+u.ph;
      b.position.set(Math.cos(a2)*u.r,1.82+Math.sin(a2)*u.r*0.6,0.15); } }
  updateFishLine();
  updatePeers(dt); streamPos(dt); derbyTick(dt);
  if(emberMesh){ // sparks ride the thermals out of the crater; the lava breathes
    for(let k=0;k<embers.length;k++){ const e=embers[k];
      e.y+=e.v*dt; if(e.y>CRATER.floor+8)e.y=CRATER.floor+rand(0,1);
      const fade=Math.max(0.1,1-(e.y-CRATER.floor)/9), s=e.s*fade;
      dummy.position.set(e.x+Math.sin(clock*1.7+e.ph)*0.5,e.y,e.z+Math.cos(clock*1.3+e.ph)*0.5);
      dummy.scale.set(s,s,s); dummy.rotation.set(clock*3+e.ph,e.ph,0);
      dummy.updateMatrix(); emberMesh.setMatrixAt(k,dummy.matrix); }
    emberMesh.instanceMatrix.needsUpdate=true;
    if(lavaMat)lavaMat.emissiveIntensity=0.85+Math.sin(clock*2.3)*0.15; }
  const lampNight=isNight()?1.7:1;
  for(let k=0;k<lamps.length;k++)lamps[k].material.emissiveIntensity=(0.7+Math.sin(clock*3+k*1.7)*0.3)*lampNight;
  if(casinoFlare>0.01)for(const l of casinoLamps)l.material.emissiveIntensity+=casinoFlare*1.7; // the house lamps flare when you win
  drawMinimap();
  RF.emit('frame',dt,rdt);

  actEdge=false;
  renderer.autoClear=false; renderer.clear();
  renderer.render(skyScene,skyCam);   // sky first…
  renderer.clearDepth();
  renderer.render(scene,camera);      // …then the world on top of it
  RF.emit('afterRender',dt,rdt);
  requestAnimationFrame(animate);
}

/* ========================================================================
   15. LIFECYCLE
   ======================================================================== */
addEventListener('resize',()=>{ renderer.setSize(window.innerWidth,window.innerHeight); fitCamera(); });
const startOv=document.getElementById('start');
// world signs stay out of the title shot; they come back on Set sail (capLabels only runs in-game, so no overlap)
if(startOv&&startOv.classList.contains('on'))for(const l of LABELS)l.visible=false;
// title-screen world showcase: real generated map thumbnails per theme, auto-cycling
{ const rowEl=document.getElementById('worldRow'),capEl=document.getElementById('worldCap');
  if(rowEl){ const thumbs=[];
    for(const k of WORLD_ORDER){ const W2=WORLDS[k];
      const c=document.createElement('canvas'); c.width=64; c.height=64; const g=c.getContext('2d');
      const waterHex='#'+W2.water.toString(16).padStart(6,'0');
      let pi=32,pj=32,pk2=-1;
      for(let i=0;i<64;i++)for(let j=0;j<64;j++){ const ii=i*1.5,jj=j*1.5;
        const n=fbm(ii*0.085+3.5+W2.seed,jj*0.085+1.2+W2.seed*0.7),dx=(ii-HALF)/HALF,dz=(jj-HALF)/HALF,d=Math.sqrt(dx*dx+dz*dz);
        const fall=clamp(1-Math.pow(d,2.5)*1.02,0,1),h=Math.min(13,Math.round(n*fall*10*W2.hMul));
        if(h>pk2){pk2=h;pi=i;pj=j;}
        g.fillStyle=h<=2?waterHex:h===3?W2.sand[0]:h<W2.stoneH?W2.grass[0]:W2.stone[0];
        g.fillRect(i,j,1,1); }
      if(k==='volcano'){ // the crater sits on the peak — show the lava on the card
        g.fillStyle='#ff7a1a'; g.fillRect(pi-1,pj-1,3,3); }
      const d2=document.createElement('div'); d2.className='wthumb'+(k===worldKey?' cur':'');
      d2.appendChild(c); const nm=document.createElement('span'); nm.textContent=W2.name; d2.appendChild(nm);
      rowEl.appendChild(d2); thumbs.push({el:d2,w:W2,k}); }
    let ti=Math.max(0,WORLD_ORDER.indexOf(worldKey)); // cave isn't in WORLD_ORDER — indexOf -1 would crash the cycler
    const cyc=()=>{ thumbs.forEach((t,i2)=>t.el.classList.toggle('sel',i2===ti));
      const t=thumbs[ti];
      if(capEl)capEl.textContent=t.k===worldKey?t.w.name+' · you are here':
        t.w.name+' · '+t.w.sub+(state.worlds.includes(t.k)?' · unlocked':' · unlock for ◈'+fmt(t.w.cost));
      ti=(ti+1)%thumbs.length; };
    cyc(); setInterval(cyc,2600); } }
function start(){ initAudio(); if(AC&&AC.state==='suspended')AC.resume(); startMusic();
  startOv.classList.remove('on'); running=true; for(const l of LABELS)l.visible=true;
  updateHUD(); setArea(WORLD.name,WORLD.sub);
  if(state.stats.caught===0&&state.stats.mined===0)toast(pixSVG('island',13)+' Welcome to '+WORLD.name+'! Walk through the gate','gold');
  RF.emit('start'); }
document.getElementById('startBtn').onclick=start;

/* ========================================================================
   16. MULTIPLAYER — other anglers on the same isle
   The socket carries presence, chat and shared-node news only. Positions are
   interpolated toward the last snapshot so 10Hz updates still look smooth.
   ======================================================================== */
const peers=new Map();
function peerColors(g,w){ const m=g.userData.mats; if(!m||!w)return;
  for(const slot of ['band','scarf','vest']){ const i=w[slot];
    m[slot].color.setHex(i!=null&&WPAL[i]!=null?WPAL[i]:WDEF[slot]); } }
function addPeer(p){ if(!p||p.id==null||peers.has(p.id))return;
  const g=makeHero(); g.rotation.order='YXZ'; peerColors(g,p.wardrobe);
  g.position.set(p.x||0,p.y||0,p.z||0); scene.add(g);
  const tag=makeLabel(p.name||'angler','#bfe8e2',false); tag.scale.set(2.1,0.53,1); scene.add(tag);
  const sub=p.title?makeLabel(p.title,'#7fdcff',false):null;
  if(sub){ sub.scale.set(1.8,0.45,1); scene.add(sub); }
  peers.set(p.id,{g,tag,sub,name:p.name||'angler',
    x:p.x||0,y:p.y||0,z:p.z||0,tx:p.x||0,ty:p.y||0,tz:p.z||0,
    face:p.face||0,tface:p.face||0,act:p.act||'',step:0});
  toast(`${p.name} is on the isle`,'good'); }
function dropPeer(id){ const q=peers.get(id); if(!q)return;
  scene.remove(q.g); scene.remove(q.tag); if(q.sub)scene.remove(q.sub);
  q.tag.material.map.dispose(); q.tag.material.dispose();
  if(q.sub){ q.sub.material.map.dispose(); q.sub.material.dispose(); }
  peers.delete(id); }
function clearPeers(){ for(const id of Array.from(peers.keys()))dropPeer(id); }
function updatePeers(dt){ if(!peers.size)return;
  const k=1-Math.exp(-9*dt);
  for(const q of peers.values()){
    const moved=Math.hypot(q.tx-q.x,q.tz-q.z)>0.02;
    q.x=lerp(q.x,q.tx,k); q.y=lerp(q.y,q.ty,k); q.z=lerp(q.z,q.tz,k);
    q.face=lerpAngle(q.face,q.tface,k);
    q.g.position.set(q.x,q.y,q.z); q.g.rotation.y=q.face;
    const pd=q.g.userData;
    if(moved){ q.step+=dt*9;
      const sw=Math.sin(q.step)*0.5;
      if(pd.legL){pd.legL.rotation.x=sw;pd.legR.rotation.x=-sw;pd.armL.rotation.x=-sw*0.7;pd.armR.rotation.x=sw*0.7;} }
    else if(pd.armR){ // idle or working: same arm poses the local hero uses
      pd.armR.rotation.x=q.act==='fish'?-0.85+Math.sin(clock*2)*0.05
        :(q.act==='mine'||q.act==='chop'||q.act==='dig')?-1.15+Math.sin(clock*13)*0.6:0;
      if(pd.legL){pd.legL.rotation.x=0;pd.legR.rotation.x=0;} }
    q.tag.position.set(q.x,q.y+2.75,q.z);
    if(q.sub)q.sub.position.set(q.x,q.y+3.15,q.z); } }

/* chat */
const chatLog=document.getElementById('chatLog'),chatIn=document.getElementById('chatIn'),chatBox=document.getElementById('chat');
let chatOpen=false;
/* Muting is the RECEIVER's choice and lives in this browser: a quiet room for you,
   with no power to silence anyone for everybody else. Reports go to the server. */
const mutedNames=new Set(); try{ (JSON.parse(localStorage.getItem('rf-muted')||'[]')||[]).forEach(n=>mutedNames.add(n)); }catch(e){}
const saveMuted=()=>{ try{ localStorage.setItem('rf-muted',JSON.stringify([...mutedNames].slice(0,200))); }catch(e){} };
function chatPush(name,msg,cls,peerId){ if(!chatLog)return;
  if(name&&mutedNames.has(name))return;                  // muted: never even rendered
  const d=document.createElement('div'); d.className='cmsg '+(cls||'');
  if(name){ const who=document.createElement('b'); who.textContent=name+': ';
    who.title='click to mute / report '+name; who.style.cursor='pointer';
    who.onclick=()=>chatMenu(name,peerId); d.appendChild(who); }
  d.appendChild(document.createTextNode(msg));  // textContent → no HTML injection
  chatLog.appendChild(d); while(chatLog.children.length>60)chatLog.removeChild(chatLog.firstChild);
  if(name)sfx.chat();                                    // someone spoke; system lines stay silent
  chatLog.scrollTop=chatLog.scrollHeight;
  if(chatBox){ chatBox.classList.add('show'); clearTimeout(chatBox._t);
    chatBox._t=setTimeout(()=>{ if(!chatOpen)chatBox.classList.remove('show'); },7000); } }
function openChat(){ if(!chatIn||!RFNet||!RFNet.wsReady)return;
  chatOpen=true; sfx.click(); chatBox.classList.add('show','open'); chatIn.style.display='block'; chatIn.focus(); }
function closeChat(){ chatOpen=false; if(chatIn){chatIn.blur();chatIn.style.display='none';chatIn.value='';}
  if(chatBox)chatBox.classList.remove('open'); }
/* click a name -> mute, unmute or report. Deliberately tiny and reversible. */
function chatMenu(name,peerId){
  if(mutedNames.has(name)){ mutedNames.delete(name); saveMuted();
    if(peerId!=null&&RFNet)RFNet.send({t:'unmute',id:peerId});
    chatPush('','· unmuted '+name+' ·','sys'); return; }
  const act=prompt('“'+name+'”\n\n  m = mute (only you stop seeing them)\n  r = report to the server\n\nType m or r:','m');
  if(!act)return;
  if(act.toLowerCase().startsWith('m')){ mutedNames.add(name); saveMuted();
    if(peerId!=null&&RFNet)RFNet.send({t:'mute',id:peerId});
    chatPush('','· muted '+name+' · click their name again to undo ·','sys'); }
  else if(act.toLowerCase().startsWith('r')){ const why=(prompt('What happened? (short)','')||'').slice(0,120);
    if(peerId!=null&&RFNet)RFNet.send({t:'report',id:peerId,reason:why});
    else if(RFNet&&RFNet.report)RFNet.report(name,why);
    chatPush('','· reported '+name+'. Thanks for keeping the isle friendly. ·','sys'); } }
const CHAT_HELP='commands:  /mute NAME   /unmute NAME   /report NAME reason   /help';
function chatCommand(m){
  const [cmd,...rest]=m.slice(1).split(/\s+/), who=rest[0]||'';
  const c=cmd.toLowerCase();
  if(c==='help'){ chatPush('',CHAT_HELP,'sys'); return true; }
  if(c==='mute'&&who){ mutedNames.add(who); saveMuted(); chatPush('','· muted '+who+' ·','sys'); return true; }
  if(c==='unmute'&&who){ mutedNames.delete(who); saveMuted(); chatPush('','· unmuted '+who+' ·','sys'); return true; }
  if(c==='report'&&who){ const q=peers&&[...peers.entries()].find(([,p])=>p.name===who);
    if(q&&RFNet)RFNet.send({t:'report',id:q[0],reason:rest.slice(1).join(' ').slice(0,120)});
    chatPush('','· reported '+who+' ·','sys'); return true; }
  if(c){ chatPush('','unknown command. '+CHAT_HELP,'sys'); return true; }
  return false; }
if(chatIn)chatIn.addEventListener('keydown',e=>{ e.stopPropagation();
  if(e.code==='Escape'){ closeChat(); return; }
  if(e.code==='Enter'){ const m=chatIn.value.trim();
    if(m){ if(m[0]==='/')chatCommand(m); else RFNet.send({t:'chat',m:m.slice(0,200)}); }
    closeChat(); } });

/* wire the socket once we are signed in */
function startRealtime(){
  if(!window.RFNet||!RFNet.online)return;
  RFNet.on('welcome',d=>{ clearPeers();
    (d.peers||[]).forEach(addPeer);
    applyNodeSnapshot(d);
    chatPush('','· connected to '+(WORLD.name)+' · press T to chat ·','sys'); })
  .on('join',d=>addPeer(d.p))
  .on('leave',d=>{ const q=peers.get(d.id); if(q)toast(q.name+' sailed off'); dropPeer(d.id); })
  .on('snap',d=>{ for(const a of d.a||[]){ const q=peers.get(a[0]); if(!q)continue;
      q.tx=a[1]; q.ty=a[2]; q.tz=a[3]; q.tface=a[4]; q.act=a[5]||''; } })
  .on('chat',d=>chatPush(d.name,d.m,'',d.id))
  .on('chat_err',d=>chatPush('',d&&d.m==='cooldown'
      ? '· easy there: chat paused for a minute ·'
      : '· message not sent ·','sys'))
  .on('mute_ok',()=>{}).on('unmute_ok',()=>{}).on('report_ok',()=>{})
  /* live drama: the isle reacts to what everyone else is doing */
  .on('drama',d=>{ if(!d)return;
    if(d.kind==='spin'){
      if(d.won)toast(`${pixSVG('wheel',13)} ${d.name} won${d.payout?' ◈'+fmt(d.payout):''} at the Eel!`,'gold');
      else if(d.fish||d.lost)toast(`${pixSVG('wheel',13)} the eel ate ${d.name}'s ${d.lost||d.fish}`,'bad');
    } else if(d.kind==='wanted'){
      toast(`${pixSVG('trophy',13)} ${d.name} landed the WANTED ${d.fish} · ◈${fmt(d.bounty)}`,'gold');
    } else if(d.kind==='derby'){
      toast(`${pixSVG('trophy',13)} DERBY: ${d.name} won with ${d.kg} kg · +${d.pearls} ◉`,'gold');
      chatPush('',`· derby over: ${d.name} took it with ${d.kg} kg ·`,'sys');
    } })
  .on('wanted',d=>{ if(d&&d.name)chatPush('','· WANTED: '+d.name+' · ◈'+fmt(d.bounty||0)+' to the first angler ·','sys'); })
  .on('node',d=>{ const n=oreNodes[d.i]; if(!n)return;
      if(d.until>Date.now()){ n.alive=false; n.mesh.visible=false; n.srvUntil=d.until; }
      else { n.alive=true; n.mesh.visible=true; n.srvUntil=0; } })
  .on('tree',d=>{ const t=treeData[d.i]; if(t)t.srvUntil=d.until; })
  .on('close',()=>{ clearPeers(); chatPush('','· disconnected, retrying… ·','sys'); });
  RFNet.connectWS(worldKey,{title:state.titleId,wardrobe:state.wardrobe});
}
function applyNodeSnapshot(d){
  for(const [i,until] of d.nodes||[]){ const n=oreNodes[i];
    if(n&&until>Date.now()){ n.alive=false; n.mesh.visible=false; n.srvUntil=until; } }
  for(const [i,until] of d.trees||[]){ const t=treeData[i]; if(t)t.srvUntil=until; } }
/* The hourly Derby: everyone on the isle fishing the same ten minutes. The
   schedule is derived from the wall clock, so no one has to be told it started. */
const derbyEl=document.getElementById('derby');
let derbyT=0,derbyInfo=null;
function derbyTick(dt){ if(!derbyEl)return;
  if((derbyT-=dt)>0){ if(derbyInfo)paintDerby(); return; }
  derbyT=15;
  if(!(window.RFNet&&RFNet.online)){ derbyEl.classList.remove('on'); return; }
  fetch(RFNet.base+'/api/derby').then(r=>r.json()).then(d=>{ derbyInfo=d&&d.derby||null; paintDerby(); }).catch(()=>{});
}
function paintDerby(){ if(!derbyEl||!derbyInfo){ if(derbyEl)derbyEl.classList.remove('on'); return; }
  const now=Date.now(), live=derbyInfo.active;
  const target=live?derbyInfo.endsAt:derbyInfo.nextAt;
  if(!target){ derbyEl.classList.remove('on'); return; }
  const left=Math.max(0,target-now), mm=Math.floor(left/60000), ss=Math.floor(left/1000)%60;
  derbyEl.textContent=(live?'🏆 DERBY LIVE · ':'🏆 derby in ')+mm+':'+String(ss).padStart(2,'0')+(live?' left':'');
  derbyEl.classList.add('on'); derbyEl.classList.toggle('live',!!live); }

/* stream our own position at 10Hz, but only when it actually changed */
let posT=0,lastSent={x:1e9,z:1e9,f:0,a:''};
function streamPos(dt){ if(!window.RFNet||!RFNet.wsReady)return;
  if((posT-=dt)>0)return; posT=0.1;
  const act=fishing.state!=='idle'?'fish':mining.node?'mine':chopping.tree?'chop':digging.active?'dig':'';
  if(Math.abs(pWorld.x-lastSent.x)<0.02&&Math.abs(pWorld.z-lastSent.z)<0.02
     &&Math.abs(pWorld.face-lastSent.f)<0.02&&act===lastSent.a)return;
  lastSent={x:pWorld.x,z:pWorld.z,f:pWorld.face,a:act};
  RFNet.send({t:'pos',x:pWorld.x,y:pWorld.y,z:pWorld.z,face:pWorld.face,act}); }

/* ---- account panel: offline by default, sign in to hand the economy to the server ---- */
{ const $=id=>document.getElementById(id);
  const statusEl=$('acctStatus'),formEl=$('acctForm'),msgEl=$('acctMsg'),toggleEl=$('acctToggle');
  const msg=(t,cls)=>{ if(msgEl){msgEl.textContent=t||'';msgEl.className=cls||'';} };
  const waysEl=$('acctWays'),noteEl=$('acctNote');
  function paint(){ if(!statusEl)return;
    const on=window.RFNet&&RFNet.online, up=window.RFNet&&RFNet.reachable;
    if(on){
      const w=RFNet.wallet;
      statusEl.textContent=(w?'◆ '+w.slice(0,6)+'…'+w.slice(-4):'signed in as '+RFNet.user)+' · progress saved on the server';
      statusEl.className='on';
      if(formEl)formEl.style.display='none';
      if(waysEl)waysEl.style.display='none';
      if(noteEl)noteEl.style.display='none';
      if(toggleEl)toggleEl.textContent='sign out';
    } else {
      statusEl.textContent=up?'choose how to play online · or just press Set sail to play offline'
                             :'playing offline · progress saved in this browser';
      statusEl.className='';
      if(waysEl)waysEl.style.display=up?'flex':'none';
      if(noteEl)noteEl.style.display=up?'block':'none';
      if(toggleEl)toggleEl.textContent='use a username instead';
    } }
  /* Pull the authoritative state and adopt it wholesale. */
  async function adopt(){ try{ const d=await RFNet.getState();
      if(d&&d.state){ SRV.apply(d.state);
        if(d.state.world&&d.state.world!==worldKey){ // server says we are on another isle
          try{localStorage.setItem('reelfortune3d-world',d.state.world);}catch(e){}
          toast('Syncing to '+((WORLDS[d.state.world]||{}).name||d.state.world)+'…','good');
          setTimeout(()=>location.reload(),700); return; }
        applyWardrobe(); applyTitle();
        if(d.dividends)toast(`${pixSVG('chart',13)} Dividends while away: +◈${fmt(d.dividends)}`,'gold'); }
    }catch(e){ msg('Could not load your save: '+e.message,'bad'); } }
  if(toggleEl)toggleEl.onclick=async()=>{
    if(window.RFNet&&RFNet.online){ await RFNet.logout();
      try{ localStorage.removeItem('rf-wallet'); }catch(e){}   // guest key stays: it IS that guest's account
      if(window.RFNet)RFNet.disconnectWS(); clearPeers();
      paint(); msg('Signed out · back to offline play.'); return; }
    if(formEl)formEl.style.display=formEl.style.display==='none'?'flex':'none';
    if(!(window.RFNet&&RFNet.reachable))msg('No server found at '+(RFNet?RFNet.base||'(none)':'·')+'.','bad');
  };
  const creds=()=>[($('acctUser')||{}).value||'',($('acctPass')||{}).value||''];
  const doAuth=async(fn,label)=>{ const [u,p]=creds();
    if(u.length<3||p.length<8){ msg('Username ≥3 chars, password ≥8.','bad'); return; }
    msg(label+'…');
    try{ await fn(u,p); msg('Welcome, '+RFNet.user+'!','good'); paint(); await adopt(); startRealtime(); }
    catch(e){ msg(e.message||'failed','bad'); } };
  if($('acctLogin'))$('acctLogin').onclick=()=>doAuth((u,p)=>RFNet.login(u,p),'Signing in');
  if($('acctReg'))$('acctReg').onclick=()=>doAuth((u,p)=>RFNet.register(u,p),'Creating account');
  /* one shared finish line for wallet + guest */
  const afterAuth=async label=>{ msg(label,'good'); paint(); await adopt(); startRealtime(); };
  if($('acctWallet'))$('acctWallet').onclick=async()=>{
    if(!RFNet.hasWallet()){ msg('No wallet extension found · install MetaMask, or press PLAY AS GUEST.','bad'); return; }
    msg('Check your wallet · approve the signature request…');
    try{ await RFNet.walletLogin(); await afterAuth('Wallet connected · welcome, '+RFNet.user+'!'); }
    catch(e){ msg(e&&e.code===4001?'Signature rejected · no problem, you can still play as guest.'
      :(e.message||'Wallet sign-in failed'),'bad'); } };
  if($('acctGuest'))$('acctGuest').onclick=async()=>{
    msg('Setting up a guest island…');
    try{ await RFNet.guestLogin(); await afterAuth('Playing as '+RFNet.user+' · this browser keeps your progress.'); }
    catch(e){ msg(e.message||'Guest sign-in failed','bad'); } };
  // boot: is a backend reachable, and is our token still good?
  (async()=>{ if(!window.RFNet)return;
    await RFNet.probe();
    if(RFNet.reachable&&await RFNet.resume()){ await adopt(); startRealtime(); }
    paint(); })();
}


/* ========================================================================
   18. MOD HOST — the reference table.
   Everything a mods/*.js file is allowed to reach lives here. Getters are
   used for anything the engine reassigns, so a mod always reads live values.
   ======================================================================== */
Object.assign(RF, {
  THREE: THREE, scene: scene, camera: camera, renderer: renderer,
  skyScene: skyScene, skyCam: skyCam, sun: sun, hemiL: hemiL, ambL: ambL,
  state: state, player: player, pWorld: pWorld, keys: keys, SRV: SRV, H: H,
  WORLD: WORLD, WORLDS: WORLDS, worldKey: worldKey, WORLD_ORDER: WORLD_ORDER, TEX: TEX,
  N: N, HALF: HALF, WATER_TOP: WATER_TOP, SAVE: SAVE, MAXLVL: MAXLVL,
  fishing: fishing, mining: mining, chopping: chopping, digging: digging, autoFish: autoFish,
  oreNodes: oreNodes, treeData: treeData, landCells: landCells, grassCells: grassCells,
  heightMap: heightMap, pathSet: pathSet, usedCells: usedCells, decorUsed: decorUsed,
  spawnCell: spawnCell, peers: peers, LABELS: LABELS, PROPS: PROPS,
  ORE_INFO: ORE_INFO, TABLE: TABLE, ALL_FISH: ALL_FISH, RAR: RAR, RORDER: RORDER,
  BAITS: BAITS, BAIT_ORDER: BAIT_ORDER, BOATS: BOATS, STOCKS: STOCKS, STOCK_KEYS: STOCK_KEYS,
  ACH: ACH, DEEDS: DEEDS, MKT_CATS: MKT_CATS, MKT_MS: MKT_MS, KIOSK_TITLES: KIOSK_TITLES,
  SEG: SEG, SEGCOL: SEGCOL, EMO: EMO, PIX: PIX, CAM_OFF: CAM_OFF,
  TRADER_POS: TRADER_POS, CASINO_POS: CASINO_POS, HARBOR_POS: HARBOR_POS, PORTAL_POS: PORTAL_POS,
  water: water, trader: trader, casino: casino, lamps: lamps, bobber: bobber,
  fn: {
    toast: toast, hint: hint, setArea: setArea, updateHUD: updateHUD, updateHotbar: updateHotbar,
    pixSVG: pixSVG, pixFish: pixFish, fmt: fmt, shade: shade, coinFly: coinFly,
    fxBurst: fxBurst, addShake: addShake, addFreeze: addFreeze,
    beep: beep, nz: nz, sweep: sweep, initAudio: initAudio,
    save: save, addPearls: addPearls, grantShare: grantShare, checkAch: checkAch,
    heightAt: heightAt, isWaterAt: isWaterAt, cellType: cellType, cellIndex: cellIndex,
    reachable: reachable, findCellNear: findCellNear, keyOf: keyOf,
    isNight: isNight, isCold: isCold, isAsh: isAsh, cap: cap, isMoving: isMoving,
    priceMult: priceMult, mktMods: mktMods, mktEpochNow: mktEpochNow, catLabel: catLabel,
    stockPrice: stockPrice, stockAsk: stockAsk, stockBid: stockBid,
    rollFish: rollFish, mkFish: mkFish, onCatch: onCatch, reveal: reveal, fishPool: fishPool,
    startCast: startCast, cancelFish: cancelFish, nearestWater: nearestWater,
    openMarket: openMarket, closeMarket: closeMarket, openInv: openInv, closeInv: closeInv,
    openCasino: openCasino, closeCasino: closeCasino, openHarbor: openHarbor, closeHarbor: closeHarbor,
    renderInv: renderInv, renderMarketAll: renderMarketAll, setInvTab: setInvTab,
    applyWardrobe: applyWardrobe, applyTitle: applyTitle, playEmote: playEmote,
    humanoid: humanoid, texturedBox: texturedBox, makeLabel: makeLabel, mat: mat,
    upCost: upCost, axeCost: axeCost, haveOres: haveOres, reqLabel: reqLabel,
    lerp: lerp, clamp: clamp, rand: rand, lerpAngle: lerpAngle, mulberry32: mulberry32,
    px: px, toTex: toTex, noiseFill: noiseFill
  },
  sfx: sfx,
  TAU: TAU
});
Object.defineProperties(RF, {
  clock:      {get:()=>clock},
  running:    {get:()=>running},
  dayT:       {get:()=>dayT},
  dayCount:   {get:()=>dayCount},
  weather:    {get:()=>wState},
  viewMode:   {get:()=>viewMode},
  camSize:    {get:()=>camSize, set:v=>{camSize=clamp(v,4,40); fitCamera();}},
  actEdge:    {get:()=>actEdge},
  hotSlot:    {get:()=>hotSlot},
  muted:      {get:()=>muted},
  photoMode:  {get:()=>photoMode},
  capCam:     {get:()=>capCam},
  chatOpen:   {get:()=>chatOpen},
  panelOpen:  {get:()=>!!(marketOpen||casinoOpen||invOpen||harborOpen||capCam)},
  marketOpen: {get:()=>marketOpen},
  invOpen:    {get:()=>invOpen},
  casinoOpen: {get:()=>casinoOpen},
  harborOpen: {get:()=>harborOpen},
  online:     {get:()=>!!(window.RFNet&&RFNet.online)}
});
RF._boot();

// idle preview loop: the island is already alive behind the start menu
last=performance.now(); requestAnimationFrame(animate);
document.getElementById('wipe').onclick=()=>{try{localStorage.removeItem(SAVE);localStorage.removeItem('reelfortune3d-world');}catch(e){}
  // a fresh save deserves a fresh boot: reload resets world, hero colors, title, dock — everything
  toast('Save wiped'); setTimeout(()=>location.reload(),500); };
applyWardrobe(); applyTitle(); payDividends(); // welcome-back dividends + saved cosmetics
updateHUD();
})();
