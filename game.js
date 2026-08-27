/* ============================================================================
   REEL FORTUNE 3D — a voxel fishing & gambling isle (Three.js r128, UMD global)
   Textured Minecraft-style blocks · flowing water · swaying grass.
   Pure client-side, no build step. Open index.html directly (file://) or serve.
   ============================================================================ */
(function () {
"use strict";
const THREE = window.THREE;
const errBox = document.getElementById('err');
function fail(msg){ if(errBox){ errBox.style.display='flex'; errBox.innerHTML=msg; } console.error(msg); }
if(!THREE){ fail("Three.js failed to load.<br>Make sure the folder still contains <b>lib/three.min.js</b>."); return; }

const lerp=(a,b,t)=>a+(b-a)*t, clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), rand=(a,b)=>a+Math.random()*(b-a), TAU=Math.PI*2;

/* ========================================================================
   1. RENDERER / SCENE / CAMERA / LIGHTS
   ======================================================================== */
let renderer;
try{ renderer=new THREE.WebGLRenderer({antialias:true}); }catch(e){ fail("WebGL could not start in this browser."); return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
if('outputEncoding' in renderer) renderer.outputEncoding=THREE.sRGBEncoding;
if('toneMapping' in renderer){ renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.15; }
document.getElementById('scene').appendChild(renderer.domElement);
const MAXANISO = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;

const SKY=0x74d8f5;
const scene=new THREE.Scene();
scene.background=new THREE.Color(SKY);
scene.fog=new THREE.Fog(SKY,72,150);

let camSize=15;
const camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,600);
const CAM_OFF=new THREE.Vector3(48,58,48);
function fitCamera(){ const a=window.innerWidth/window.innerHeight;
  camera.left=-camSize*a;camera.right=camSize*a;camera.top=camSize;camera.bottom=-camSize;camera.updateProjectionMatrix(); }
fitCamera();

scene.add(new THREE.HemisphereLight(0xf2fbff,0x6a8f4f,0.98));
scene.add(new THREE.AmbientLight(0x8fa6ac,0.26));
const sun=new THREE.DirectionalLight(0xfff6df,1.08);
sun.position.set(38,64,26); sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.near=1; sun.shadow.camera.far=200;
sun.shadow.camera.left=-42; sun.shadow.camera.right=42; sun.shadow.camera.top=42; sun.shadow.camera.bottom=-42;
sun.shadow.bias=-0.0006;
scene.add(sun); scene.add(sun.target);

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
function texDirt(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#7a5836',['#6b4c2d','#87643e','#5e4227']); return toTex(c); }
function texSand(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#f2dfa0',['#e6cf8c','#ffedb8','#d9c383']); return toTex(c); }
function texSeabed(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#d8c48f',['#c7b17e','#e6d29e','#b8a173']); return toTex(c); }
function texStone(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#8f969f',['#7f858e','#9ba2ab','#6f757d']);
  g.strokeStyle='rgba(60,64,70,.5)';g.beginPath();g.moveTo(2,5);g.lineTo(7,6);g.lineTo(9,11);g.stroke(); return toTex(c); }
function texGrassTop(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#6cbf3f',['#5cae34','#79cd4b','#54a52f','#84d857']); return toTex(c); }
function texGrassSide(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#7a5836',['#6b4c2d','#87643e']);
  // grass overhang on top few rows
  for(let x=0;x<S;x++){ const drop=2+((Math.random()*3)|0); for(let y=0;y<drop;y++){ g.fillStyle=['#5cae34','#6cbf3f','#79cd4b'][(Math.random()*3)|0]; g.fillRect(x,y,1,1);} }
  return toTex(c); }
function texBark(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#6b4a2b';g.fillRect(0,0,S,S);
  for(let x=0;x<S;x+=2){ g.fillStyle=Math.random()<0.5?'#5a3d23':'#79552f'; g.fillRect(x,0,1,S);} return toTex(c); }
function texWood(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#9a6b3a';g.fillRect(0,0,S,S);
  for(let y=0;y<S;y++){ g.fillStyle=y%4===0?'#7d5530':(Math.random()<0.3?'#a8763f':'#8f6234'); g.fillRect(0,y,S,1);} return toTex(c); }
function texLeaf(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#3f8f4c',['#357c42','#4a9d57','#2d6d39','#57ab63']); return toTex(c); }
function texWater(){ const c=px(64),g=c.getContext('2d'); g.fillStyle='#dff6ff';g.fillRect(0,0,64,64);
  g.strokeStyle='rgba(120,200,220,.6)';g.lineWidth=2;
  for(let k=0;k<10;k++){ g.beginPath(); const y=Math.random()*64; for(let x=0;x<=64;x+=8)g.lineTo(x,y+Math.sin(x*0.2+k)*3); g.stroke(); }
  return toTex(c,{repeat:true,nearest:false}); }
function texBlade(){ const c=px(S),g=c.getContext('2d'); g.clearRect(0,0,S,S);
  for(let x=1;x<S;x+=3){ const h=6+((Math.random()*7)|0); g.fillStyle=['#6cbf3f','#5cae34','#79cd4b'][(Math.random()*3)|0];
    for(let y=0;y<h;y++) g.fillRect(x+((Math.random()<0.3)?1:0), S-1-y, 1,1); }
  return toTex(c); }

const TEX={dirt:texDirt(),sand:texSand(),seabed:texSeabed(),stone:texStone(),grassTop:texGrassTop(),grassSide:texGrassSide(),
  bark:texBark(),leaf:texLeaf(),water:texWater(),blade:texBlade(),wood:texWood()};

/* ========================================================================
   3. TERRAIN (textured voxel island via InstancedMesh, per-face grass)
   ======================================================================== */
const N=64, HALF=N/2, WATER_TOP=2.35;
const heightMap=[];
function hash(x,y){ const n=Math.sin(x*127.1+y*311.7)*43758.5453; return n-Math.floor(n); }
function vnoise(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
  const a=hash(xi,yi),b=hash(xi+1,yi),c=hash(xi,yi+1),d=hash(xi+1,yi+1);
  return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v; }
function fbm(x,y){ let s=0,amp=1,f=1,tot=0; for(let o=0;o<4;o++){s+=vnoise(x*f,y*f)*amp;tot+=amp;amp*=0.5;f*=2;} return s/tot; }
function cellType(h){ if(h<=2)return 'seabed'; if(h===3)return 'sand'; if(h<=5)return 'grass'; return 'stone'; }

const byType={seabed:[],sand:[],grass:[],stone:[]}, landCells=[], grassCells=[];
for(let i=0;i<N;i++){ heightMap[i]=[];
  for(let j=0;j<N;j++){
    const n=fbm(i*0.13+3.5,j*0.13+1.2), dx=(i-HALF)/HALF, dz=(j-HALF)/HALF, d=Math.sqrt(dx*dx+dz*dz);
    const fall=clamp(1-Math.pow(d,2.3)*1.08,0,1); let h=Math.round(n*fall*7);
    heightMap[i][j]=h; const t=cellType(h); byType[t].push([i,j,h]);
    if(h>=3)landCells.push([i,j,h]); if(t==='grass')grassCells.push([i,j,h]);
  } }

const boxGeo=new THREE.BoxGeometry(1,1,1);
const dummy=new THREE.Object3D();
function mat(tex){ return new THREE.MeshLambertMaterial({map:tex}); }
function buildInstanced(list,material){
  if(!list.length) return null;
  const mesh=new THREE.InstancedMesh(boxGeo,material,list.length);
  mesh.castShadow=false; mesh.receiveShadow=true;
  for(let k=0;k<list.length;k++){ const [i,j,h]=list[k],hr=Math.max(h,1);
    dummy.position.set(i-HALF,hr/2,j-HALF); dummy.scale.set(1,hr,1); dummy.rotation.set(0,0,0); dummy.updateMatrix();
    mesh.setMatrixAt(k,dummy.matrix); }
  mesh.instanceMatrix.needsUpdate=true; scene.add(mesh); return mesh;
}
buildInstanced(byType.seabed, mat(TEX.seabed));
buildInstanced(byType.sand,   mat(TEX.sand));
buildInstanced(byType.stone,  mat(TEX.stone));
// grass: per-face materials [right,left,top,bottom,front,back]
const grassSideM=mat(TEX.grassSide), grassTopM=mat(TEX.grassTop), dirtM=mat(TEX.dirt);
buildInstanced(byType.grass, [grassSideM,grassSideM,grassTopM,dirtM,grassSideM,grassSideM]);

// ---- flowing water (vertex waves + scrolling caustic texture) ----
const WSEG=44, waterGeo=new THREE.PlaneGeometry(N+16,N+16,WSEG,WSEG);
TEX.water.repeat.set(9,9);
const waterMat=new THREE.MeshLambertMaterial({color:0x35bcde,map:TEX.water,transparent:true,opacity:0.82,depthWrite:false});
const water=new THREE.Mesh(waterGeo,waterMat);
water.rotation.x=-Math.PI/2; water.position.set(0,WATER_TOP,0);
scene.add(water);
const wPos=waterGeo.attributes.position, wBaseX=new Float32Array(wPos.count), wBaseY=new Float32Array(wPos.count);
for(let i=0;i<wPos.count;i++){ wBaseX[i]=wPos.getX(i); wBaseY[i]=wPos.getY(i); }
function animWater(t){
  for(let i=0;i<wPos.count;i++){ const x=wBaseX[i],y=wBaseY[i];
    const z=Math.sin(x*0.5+t*1.3)*0.11+Math.sin(y*0.4-t*1.1)*0.09+Math.sin((x+y)*0.3+t*0.7)*0.05;
    wPos.setZ(i,z); }
  wPos.needsUpdate=true;
  TEX.water.offset.x=(t*0.015)%1; TEX.water.offset.y=(t*0.01)%1;
}

function cellIndex(x,z){ return [clamp(Math.round(x+HALF),0,N-1),clamp(Math.round(z+HALF),0,N-1)]; }
function heightAt(x,z){ const [i,j]=cellIndex(x,z); return heightMap[i][j]; }
function isWaterAt(x,z){ return heightAt(x,z)<=2; }

/* ========================================================================
   4. SWAYING GRASS TUFTS (instanced cross-billboards)
   ======================================================================== */
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
  const cand=grassCells.filter(()=>Math.random()<0.35).slice(0,200);
  if(cand.length){
    const gm=new THREE.MeshLambertMaterial({map:TEX.blade,alphaTest:0.5,transparent:true,side:THREE.DoubleSide});
    tuftMesh=new THREE.InstancedMesh(bladeGeo(),gm,cand.length);
    tuftMesh.castShadow=false; tuftMesh.receiveShadow=false;
    cand.forEach((c,k)=>{ const [i,j,h]=c; tufts.push({x:i-HALF+rand(-0.3,0.3),y:h,z:j-HALF+rand(-0.3,0.3),ph:rand(0,TAU),s:rand(0.7,1.15)}); });
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
   5. DECOR + LANDMARKS
   ======================================================================== */
function texturedBox(w,h,d,tex,extra){ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshLambertMaterial(Object.assign({map:tex},extra||{}))); }
function makeTree(){ const g=new THREE.Group();
  const trunk=texturedBox(0.6,1.9,0.6,TEX.bark); trunk.position.y=0.95; trunk.castShadow=true; g.add(trunk);
  const l1=texturedBox(2.6,1.6,2.6,TEX.leaf); l1.position.y=2.4; l1.castShadow=true; g.add(l1);
  const l2=texturedBox(1.7,1.3,1.7,TEX.leaf); l2.position.y=3.4; l2.castShadow=true; g.add(l2);
  return g; }
function makeRock(){ const g=new THREE.Group();
  const a=texturedBox(1.4,1.05,1.4,TEX.stone); a.position.y=0.52; a.castShadow=true; g.add(a);
  const b=texturedBox(0.85,0.75,0.85,TEX.stone); b.position.set(0.5,0.95,-0.3); b.castShadow=true; g.add(b); return g; }

const usedCells=new Set(); const keyOf=(i,j)=>i+'_'+j;
function placeOnCell(obj,i,j){ obj.position.set(i-HALF,heightMap[i][j],j-HALF); scene.add(obj); usedCells.add(keyOf(i,j)); }

let spawnCell=null,best=1e9;
for(const [i,j,h] of landCells){ if(h>=3&&h<=5){ const d=Math.abs(i-HALF)+Math.abs(j-HALF); if(d<best){best=d;spawnCell=[i,j,h];} } }
if(!spawnCell) spawnCell=landCells[0]||[HALF,HALF,3];
function findCellNear(cx,cj,minR,maxR){ let cand=null,bd=1e9;
  for(const [i,j,h] of landCells){ if(h<3||h>5||usedCells.has(keyOf(i,j)))continue; const d=Math.hypot(i-cx,j-cj);
    if(d>=minR&&d<=maxR&&d<bd){bd=d;cand=[i,j,h];} } return cand||spawnCell; }
const traderCell=findCellNear(spawnCell[0],spawnCell[1],4,7); usedCells.add(keyOf(traderCell[0],traderCell[1]));
const casinoCell=findCellNear(spawnCell[0],spawnCell[1],6,11); usedCells.add(keyOf(casinoCell[0],casinoCell[1]));
{ let tc=0,rc=0; const sh=landCells.slice().sort(()=>Math.random()-0.5);
  const treePos=[],rockPos=[], TREE_GAP=2.5, ROCK_GAP=1.7, CROSS_GAP=1.3;
  const farFrom=(list,i,j,gap)=>list.every(p=>Math.hypot(p[0]-i,p[1]-j)>=gap);
  for(const [i,j,h] of sh){ if(usedCells.has(keyOf(i,j)))continue; if(Math.hypot(i-spawnCell[0],j-spawnCell[1])<2.4)continue;
    if(Math.hypot(i-traderCell[0],j-traderCell[1])<2.6)continue; if(Math.hypot(i-casinoCell[0],j-casinoCell[1])<2.6)continue;
    if(h>=4&&h<=5&&tc<50&&Math.random()<0.5&&farFrom(treePos,i,j,TREE_GAP)&&farFrom(rockPos,i,j,CROSS_GAP)){placeOnCell(makeTree(),i,j);treePos.push([i,j]);tc++;}
    else if(h>=3&&rc<26&&Math.random()<0.2&&farFrom(rockPos,i,j,ROCK_GAP)&&farFrom(treePos,i,j,CROSS_GAP)){placeOnCell(makeRock(),i,j);rockPos.push([i,j]);rc++;} } }

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

function makeLabel(text,color){ const c=px(256); c.height=64; const x=c.getContext('2d');
  x.fillStyle='rgba(9,16,20,0.82)'; const r=10,w=256,h=52,y=6; x.beginPath();
  x.moveTo(r,y);x.arcTo(w,y,w,h,r);x.arcTo(w,h+y,0,h+y,r);x.arcTo(0,h+y,0,y,r);x.arcTo(0,y,w,y,r);x.closePath();x.fill();
  x.fillStyle=color;x.font='bold 30px "Chakra Petch",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,128,34);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=MAXANISO;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false})); sp.scale.set(3.4,0.85,1); return sp; }

const trader=humanoid({shirt:0x7a4a2a,pants:0x3a2c1c,hat:0xcaa15a,skin:0xe8bd8f});
trader.position.set(traderCell[0]-HALF,heightMap[traderCell[0]][traderCell[1]],traderCell[1]-HALF); scene.add(trader);
const traderLabel=makeLabel('TRADER','#ffcf5c'); traderLabel.position.copy(trader.position).add(new THREE.Vector3(0,2.7,0)); scene.add(traderLabel);
const TRADER_POS=trader.position.clone();
// a little market stall behind the trader
const stall=texturedBox(1.8,1.1,1.2,TEX.wood); stall.position.copy(trader.position).add(new THREE.Vector3(0,0.55,-0.9)); stall.castShadow=true; stall.receiveShadow=true; scene.add(stall);

const casino=new THREE.Group();
const cbase=texturedBox(3,0.6,3,TEX.wood); cbase.position.y=0.3; cbase.castShadow=true; cbase.receiveShadow=true;
const cportal=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.25,1.7), new THREE.MeshLambertMaterial({color:0x9a5cff,emissive:0x6a2fbf,emissiveIntensity:0.6})); cportal.position.y=0.72;
const ring=new THREE.Mesh(new THREE.TorusGeometry(1.15,0.14,10,26), new THREE.MeshLambertMaterial({color:0xff5d7a,emissive:0x7a1030,emissiveIntensity:0.5}));
ring.rotation.x=Math.PI/2; ring.position.y=1.05; ring.castShadow=true;
casino.add(cbase,cportal,ring);
casino.position.set(casinoCell[0]-HALF,heightMap[casinoCell[0]][casinoCell[1]],casinoCell[1]-HALF); scene.add(casino);
const casinoLabel=makeLabel('CASINO','#ff5d7a'); casinoLabel.position.copy(casino.position).add(new THREE.Vector3(0,3.1,0)); scene.add(casinoLabel);
const CASINO_POS=casino.position.clone();

/* ========================================================================
   6. PLAYER + BOBBER
   ======================================================================== */
const player=humanoid({shirt:0xd8483f,pants:0x33507a,hat:0xf0c437,skin:0xf0c090});
const pWorld={x:spawnCell[0]-HALF,z:spawnCell[1]-HALF,y:spawnCell[2],face:0,step:0};
player.position.set(pWorld.x,pWorld.y,pWorld.z); scene.add(player);

const bobber=new THREE.Group();
const bTop=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.2,0.28),new THREE.MeshLambertMaterial({color:0xff5d7a})); bTop.position.y=0.16;
const bBot=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.16,0.28),new THREE.MeshLambertMaterial({color:0xf2f2f2}));
bobber.add(bTop,bBot); bobber.visible=false; scene.add(bobber);

/* ========================================================================
   7. INPUT / AUDIO / HUD / TOAST / REVEAL
   ======================================================================== */
const keys={}; let actEdge=false;
const KMAP={KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',KeyE:'act',Space:'act'};
addEventListener('keydown',e=>{const m=KMAP[e.code]; if(m){e.preventDefault(); if(!keys[m]&&m==='act')actEdge=true; keys[m]=true;}
  if(e.code==='Escape'){ if(marketOpen)closeMarket(); else if(casinoOpen)closeCasino(); else if(fishing.state!=='idle')cancelFish(); }},{passive:false});
addEventListener('keyup',e=>{const m=KMAP[e.code]; if(m)keys[m]=false;});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;});

let AC=null,muted=false;
function initAudio(){if(AC)return;try{AC=new (window.AudioContext||window.webkitAudioContext)();}catch(e){}}
function beep(f,d,t,v){if(!AC||muted)return;const o=AC.createOscillator(),g=AC.createGain();o.type=t||'sine';o.frequency.value=f;
  g.gain.value=.0001;o.connect(g);g.connect(AC.destination);const n=AC.currentTime;
  g.gain.exponentialRampToValueAtTime(v||.05,n+.01);g.gain.exponentialRampToValueAtTime(.0001,n+d);o.start(n);o.stop(n+d+.02);}
const sfx={cast:()=>beep(300,.15,'sine',.05),bite:()=>{beep(880,.08,'square',.06);setTimeout(()=>beep(1100,.08,'square',.06),90);},
  reel:()=>beep(200+Math.random()*80,.05,'sawtooth',.03),catch:()=>{beep(523,.1,'triangle',.06);setTimeout(()=>beep(784,.14,'triangle',.06),90);},
  miss:()=>beep(160,.2,'sawtooth',.05),sell:()=>{beep(660,.08,'sine',.06);setTimeout(()=>beep(990,.1,'sine',.06),70);},
  spin:()=>beep(120,.05,'square',.02),win:()=>{[523,659,784,1046].forEach((f,i)=>setTimeout(()=>beep(f,.16,'triangle',.06),i*90));},
  lose:()=>{beep(200,.3,'sawtooth',.07);setTimeout(()=>beep(130,.4,'sawtooth',.07),160);}};
document.getElementById('mute').onclick=()=>{muted=!muted;const b=document.getElementById('mute');b.textContent=muted?'♪ MUTED':'♪ SOUND';b.style.color=muted?'var(--faint)':'';};

const RAR={common:'#b9c6c4',uncommon:'#74e08a',rare:'#57b7ff',epic:'#c07bff',legendary:'#ffc24b'};
const H={bn:document.querySelector('#hud-bucket .n'),bucket:document.getElementById('hud-bucket'),coins:document.getElementById('coinVal'),area:document.getElementById('area'),hint:document.getElementById('hint')};
const fmt=n=>Math.round(n).toLocaleString('en-US');
function updateHUD(){H.bn.textContent=state.bucket.length+'/'+CAP;H.bucket.classList.toggle('full',state.bucket.length>=CAP);H.coins.textContent=fmt(state.coins);}
let hintCur='';
function hint(h){if(h!==hintCur){hintCur=h;if(h){H.hint.innerHTML=h;H.hint.classList.add('on');}else H.hint.classList.remove('on');}}
const tw=document.getElementById('toasts');
function toast(m,k){const d=document.createElement('div');d.className='toast '+(k||'');d.textContent=m;tw.appendChild(d);setTimeout(()=>d.remove(),2000);}
let areaCur='',areaT=0;
function setArea(name,sub){if(name!==areaCur){areaCur=name;H.area.innerHTML=name+'<small>'+sub+'</small>';H.area.classList.add('on');areaT=3;}}
function fishSVG(rar){const c=RAR[rar];return `<svg width="76" height="46" viewBox="0 0 76 46"><g fill="${c}"><ellipse cx="34" cy="23" rx="24" ry="13"/><polygon points="8,23 -2,12 -2,34"/></g><circle cx="46" cy="20" r="2.4" fill="#0e1a20"/><path d="M50 16 q8 7 0 14" stroke="${c}" stroke-width="2" fill="none"/></svg>`;}
const revEl=document.getElementById('reveal'); let revT=0;
function reveal(f){revEl.innerHTML=`<div class="reveal-card" style="border-color:${RAR[f.rar]};box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 30px ${RAR[f.rar]}55"><div class="r" style="color:${RAR[f.rar]}">${f.rar}</div>${fishSVG(f.rar)}<div class="nm">${f.name}</div><div class="v">◈ ${fmt(f.val)}</div></div>`;revEl.classList.add('on');revT=1.9;}

/* ========================================================================
   8. STATE + FISH
   ======================================================================== */
const SAVE='reelfortune3d-v1', CAP=12;
const state={coins:0,bucket:[]};
function save(){try{localStorage.setItem(SAVE,JSON.stringify(state));}catch(e){}}
function load(){try{const r=localStorage.getItem(SAVE);if(r){const s=JSON.parse(r);state.coins=s.coins||0;state.bucket=Array.isArray(s.bucket)?s.bucket:[];}}catch(e){}}
load();
function F(name,rar,val){return {name,rar,val};}
const TABLE=[[F('Sardine','common',8),40],[F('Perch','common',12),34],[F('Carp','common',10),30],
  [F('Bass','uncommon',20),26],[F('Trout','uncommon',24),22],[F('Snapper','uncommon',34),18],
  [F('Eel','rare',44),14],[F('Tuna','rare',82),10],[F('Koi','rare',130),8],
  [F('Sturgeon','epic',128),6],[F('Swordfish','epic',156),5],[F('Golden Carp','epic',168),4],
  [F('Anglerfish','legendary',430),2],[F('Star Koi','legendary',620),1]];
function rollFish(){ let tot=0; for(const e of TABLE)tot+=e[1]; let r=Math.random()*tot;
  for(const e of TABLE){ r-=e[1]; if(r<=0){ const t=e[0]; return {uid:(Date.now()+Math.random()).toString(36),name:t.name,rar:t.rar,val:Math.round(t.val*rand(0.85,1.18)),wins:0}; } }
  return null; }

/* ========================================================================
   9. MARKET
   ======================================================================== */
let marketOpen=false;
const marketEl=document.getElementById('market'),marketList=document.getElementById('marketList');
function renderMarket(){ if(!state.bucket.length){marketList.innerHTML='<div class="empty">Your bucket is empty. Go catch something!</div>';return;}
  let h=''; state.bucket.forEach((f,i)=>{h+=`<div class="fishrow"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
    <span class="nm">${f.name} ${f.wins?`<span class="hot">${'★'.repeat(Math.min(f.wins,5))} ×${Math.pow(2,f.wins)}</span>`:''}</span>
    <span class="rr" style="color:${RAR[f.rar]}">${f.rar}</span><span class="vv">◈ ${fmt(f.val)}</span><button class="btn" data-sellone="${i}">Sell</button></div>`;});
  marketList.innerHTML=h; }
function openMarket(){marketOpen=true;marketEl.classList.add('on');renderMarket();}
function closeMarket(){marketOpen=false;marketEl.classList.remove('on');save();}
document.getElementById('marketX').onclick=closeMarket;
document.getElementById('sellAll').onclick=()=>{ if(!state.bucket.length){toast('Bucket empty');return;} let g=0; for(const f of state.bucket)g+=f.val;
  state.coins+=g;state.bucket=[];sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderMarket();save();};
marketEl.addEventListener('click',e=>{const i=e.target.getAttribute&&e.target.getAttribute('data-sellone');
  if(i!=null){const f=state.bucket[+i];if(f){state.coins+=f.val;state.bucket.splice(+i,1);sfx.sell();toast('+'+fmt(f.val)+' coins','gold');updateHUD();renderMarket();save();}}});

/* ========================================================================
   10. CASINO ROULETTE (Minecraft-styled wheel)
   ======================================================================== */
let casinoOpen=false,stakeIdx=-1,betColor=null,spinning=false;
const casinoEl=document.getElementById('casino'),stakeListEl=document.getElementById('stakeList'),
  spinBtn=document.getElementById('spinBtn'),spinResult=document.getElementById('spinResult');
const NSEG=15,SEG=[]; SEG[0]='green'; for(let i=1;i<NSEG;i++)SEG[i]=(i%2===1)?'red':'black';
const SEGCOL={red:0xc0392b,black:0x242a30,green:0x2fae5e};
const SEGA=TAU/NSEG, WPTR=-Math.PI/2; // angle per wedge · fixed world angle the gold pointer reads off

/* --- a real spinning 3D wheel, rendered into its own scene inside the <canvas id="wheel"> --- */
const wc=document.getElementById('wheel');
const wheelScene=new THREE.Scene();
const wheelCam=new THREE.PerspectiveCamera(30,1,0.1,20); wheelCam.position.set(0,3.5,3.1); wheelCam.lookAt(0,0,0.15);
wheelScene.add(new THREE.HemisphereLight(0xffffff,0x2a2018,1.05));
const wheelSun=new THREE.DirectionalLight(0xfff2d8,0.9); wheelSun.position.set(2.5,5,2); wheelScene.add(wheelSun);
let wheelRenderer=null;
try{ wheelRenderer=new THREE.WebGLRenderer({canvas:wc,antialias:true,alpha:true});
  wheelRenderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); wheelRenderer.setSize(260,260); }catch(e){}

function wedgeGeo(r,thetaStart,thetaLength,h){
  const shape=new THREE.Shape(); shape.moveTo(0,0); shape.absarc(0,0,r,thetaStart,thetaStart+thetaLength,false); shape.lineTo(0,0);
  const g=new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:false}); g.rotateX(-Math.PI/2); return g; }

const WR=1.15;
const wheelDisc=new THREE.Group(); wheelScene.add(wheelDisc);
for(let i=0;i<NSEG;i++) wheelDisc.add(new THREE.Mesh(wedgeGeo(WR,i*SEGA,SEGA,0.22),new THREE.MeshLambertMaterial({color:SEGCOL[SEG[i]]})));
{ const c=px(64),cx2=c.getContext('2d'); cx2.fillStyle='#eafff1'; cx2.font='700 22px "Chakra Petch",sans-serif';
  cx2.textAlign='center'; cx2.textBaseline='middle'; cx2.fillText('14×',32,34);
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true,depthTest:false}));
  const gAng=-(SEGA/2); spr.position.set(Math.cos(gAng)*WR*0.62,0.3,Math.sin(gAng)*WR*0.62); spr.scale.set(0.5,0.5,1);
  wheelDisc.add(spr); }
{ const hub=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.32,0.3,10),new THREE.MeshLambertMaterial({color:0x3a4048}));
  hub.position.y=0.24; wheelScene.add(hub); }
{ const plankGeo=new THREE.BoxGeometry(0.22,0.3,0.16);
  for(let k=0;k<28;k++){ const a=k*(TAU/28);
    const m=new THREE.Mesh(plankGeo,new THREE.MeshLambertMaterial({color:k%2?0x9a6b3a:0x7d5530}));
    m.position.set(Math.cos(a)*(WR+0.16),0.16,Math.sin(a)*(WR+0.16)); m.rotation.y=-a; wheelScene.add(m); } }
{ const ptr=new THREE.Mesh(new THREE.ConeGeometry(0.14,0.26,4),new THREE.MeshLambertMaterial({color:0xffcf5c}));
  ptr.position.set(Math.cos(WPTR)*(WR+0.05),0.5,Math.sin(WPTR)*(WR+0.05)); ptr.rotation.x=Math.PI; wheelScene.add(ptr); }
let wheelAngle=0;
function renderWheelScene(){ wheelDisc.rotation.y=wheelAngle; if(wheelRenderer)wheelRenderer.render(wheelScene,wheelCam); }
function renderStakes(){ if(!state.bucket.length){stakeListEl.innerHTML='<div class="empty" style="padding:8px">No fish to stake — go fishing first.</div>';return;}
  let h=''; state.bucket.forEach((f,i)=>{h+=`<div class="stake${i===stakeIdx?' sel':''}" data-stake="${i}"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
    <span class="nm">${f.name}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</span><span class="vv">◈ ${fmt(f.val)}</span></div>`;});
  stakeListEl.innerHTML=h; }
function updateSpinBtn(){spinBtn.disabled=!(stakeIdx>=0&&betColor&&!spinning&&state.bucket[stakeIdx]);}
function openCasino(){casinoOpen=true;casinoEl.classList.add('on');stakeIdx=-1;betColor=null;spinning=false;spinResult.innerHTML='';
  document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));renderStakes();updateSpinBtn();renderWheelScene();}
function closeCasino(){casinoOpen=false;casinoEl.classList.remove('on');save();}
document.getElementById('casinoX').onclick=closeCasino;
stakeListEl.addEventListener('click',e=>{if(spinning)return;const t=e.target.closest('[data-stake]');if(t){stakeIdx=+t.getAttribute('data-stake');renderStakes();updateSpinBtn();}});
document.querySelectorAll('.betbtn').forEach(b=>{const pick=()=>{if(spinning)return;betColor=b.getAttribute('data-bet');
  document.querySelectorAll('.betbtn').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');updateSpinBtn();};
  b.onclick=pick;b.onkeydown=e=>{if(e.code==='Enter'||e.code==='Space'){e.preventDefault();pick();}};});
spinBtn.onclick=()=>{ if(spinBtn.disabled)return; const fish=state.bucket[stakeIdx]; if(!fish)return;
  spinning=true;updateSpinBtn();spinResult.innerHTML='<span style="color:var(--muted)">The wheel spins…</span>';
  const winIdx=Math.floor(Math.random()*NSEG),targetCenter=winIdx*SEGA+SEGA/2,turns=5+Math.floor(Math.random()*3);
  const startA=wheelAngle%TAU; let finalA=-targetCenter-WPTR; while(finalA<startA)finalA+=TAU; finalA+=turns*TAU;
  const dur=3.6; let t0=null,lastBeep=0;
  function tick(ts){ if(t0==null)t0=ts; const el=(ts-t0)/1000,p=Math.min(1,el/dur),e=1-Math.pow(1-p,3);
    wheelAngle=startA+(finalA-startA)*e; renderWheelScene();
    if(el-lastBeep>0.09+0.4*p){lastBeep=el;sfx.spin();}
    if(p<1)requestAnimationFrame(tick); else resolveSpin(winIdx,fish); }
  requestAnimationFrame(tick); };
function resolveSpin(idx,fish){ const color=SEG[idx],won=(color===betColor);
  if(won){ const mult=(color==='green')?14:2,before=fish.val; fish.val=Math.round(fish.val*mult); fish.wins++;
    spinResult.innerHTML=`<span class="win">▲ ${color.toUpperCase()} — WON! ${fish.name} ◈${fmt(before)} → <b>◈${fmt(fish.val)}</b>. Spin again or cash out.</span>`;
    sfx.win();toast(`${fish.name} doubled → ◈${fmt(fish.val)}`,'gold'); }
  else { const lost=fish.name,li=state.bucket.indexOf(fish); if(li>=0)state.bucket.splice(li,1); stakeIdx=-1;
    spinResult.innerHTML=`<span class="lose">▼ ${color.toUpperCase()} — the eel swallowed your ${lost}. Gone.</span>`; sfx.lose();toast('Lost your '+lost,'bad'); }
  spinning=false;betColor=null;document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));
  renderStakes();updateHUD();updateSpinBtn();save(); }

/* ========================================================================
   11. FISHING (3D)
   ======================================================================== */
const fishing={state:'idle',t:0,biteAt:0,reel:0,reelT:0,tx:0,tz:0,cast:0};
function cancelFish(){fishing.state='idle';bobber.visible=false;hint('');}
function nearestWater(){ const [ci,cj]=cellIndex(pWorld.x,pWorld.z); let bestC=null,bd=1e9;
  for(let i=ci-3;i<=ci+3;i++)for(let j=cj-3;j<=cj+3;j++){ if(i<0||j<0||i>=N||j>=N)continue; if(heightMap[i][j]>2)continue;
    const wx2=i-HALF,wz2=j-HALF,d=Math.hypot(wx2-pWorld.x,wz2-pWorld.z); if(d<bd){bd=d;bestC={x:wx2,z:wz2,dist:d};} } return bestC; }
function startCast(w){ initAudio(); fishing.state='cast';fishing.cast=0;fishing.tx=w.x;fishing.tz=w.z;
  bobber.visible=true;bobber.position.set(pWorld.x,pWorld.y+1,pWorld.z);sfx.cast(); }
function updateFishing(dt){ const f=fishing;
  if(f.state==='cast'){ f.cast=Math.min(1,f.cast+dt*2.2);
    bobber.position.x=lerp(pWorld.x,f.tx,f.cast);bobber.position.z=lerp(pWorld.z,f.tz,f.cast);
    bobber.position.y=lerp(pWorld.y+1,WATER_TOP+0.1,f.cast)+Math.sin(f.cast*Math.PI)*1.2; hint('Casting…');
    if(f.cast>=1){f.state='wait';f.biteAt=rand(1.1,3.2);f.t=0;} }
  else if(f.state==='wait'){ f.t+=dt; bobber.position.y=WATER_TOP+0.1+Math.sin(clock*3)*0.05; hint('Waiting for a bite… <span class="key">ESC</span> reel in'); if(f.t>=f.biteAt){f.state='bite';f.t=0;sfx.bite();} }
  else if(f.state==='bite'){ f.t+=dt; bobber.position.y=WATER_TOP+0.05+Math.sin(clock*22)*0.14; hint('❗ <b>BITE!</b> press <span class="key">E</span> now!');
    if(actEdge){f.state='reel';f.reel=0;f.reelT=0;} else if(f.t>0.85){cancelFish();sfx.miss();toast('It got away…');} }
  else if(f.state==='reel'){ f.reelT+=dt; if(keys.act){f.reel+=dt*0.75;if(Math.random()<0.08)sfx.reel();} else f.reel-=dt*0.28; f.reel=clamp(f.reel,0,1);
    bobber.position.y=WATER_TOP+0.1+f.reel*0.3; hint('Reel it in! hold <span class="key">E</span>');
    if(f.reel>=1){ const fish=rollFish(); f.state='idle'; bobber.visible=false;
      if(state.bucket.length<CAP){state.bucket.push(fish);sfx.catch();reveal(fish);updateHUD();save();} else toast('Bucket full — sell some fish!'); }
    else if(f.reelT>4.5){cancelFish();sfx.miss();toast('The line snapped…');} }
}

/* ========================================================================
   12. MOVEMENT / CAMERA / LOOP
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
  moveDir.normalize(); pWorld.step+=dt*9;
  const sp=6.2, curH=heightAt(pWorld.x,pWorld.z);
  const nx=pWorld.x+moveDir.x*sp*dt;
  if(!isWaterAt(nx,pWorld.z)&&Math.abs(heightAt(nx,pWorld.z)-curH)<2&&Math.abs(nx)<HALF-1)pWorld.x=nx;
  const nz=pWorld.z+moveDir.z*sp*dt, curH2=heightAt(pWorld.x,pWorld.z);
  if(!isWaterAt(pWorld.x,nz)&&Math.abs(heightAt(pWorld.x,nz)-curH2)<2&&Math.abs(nz)<HALF-1)pWorld.z=nz;
  pWorld.face=Math.atan2(moveDir.x,moveDir.z);
}
function interactions(){
  const dT=Math.hypot(pWorld.x-TRADER_POS.x,pWorld.z-TRADER_POS.z), dC=Math.hypot(pWorld.x-CASINO_POS.x,pWorld.z-CASINO_POS.z);
  const w=nearestWater(), canFish=w&&w.dist<2.4;
  if(dT<2.4){ hint('<span class="key">E</span> Sell fish to the Trader'); if(actEdge){initAudio();openMarket();} }
  else if(dC<2.8){ hint('<span class="key">E</span> Enter the Spinning Eel'); if(actEdge){initAudio();openCasino();} }
  else if(canFish){ if(state.bucket.length>=CAP)hint('Bucket full — sell at the Trader'); else { hint('<span class="key">E</span> Cast your line'); if(actEdge)startCast(w); } }
  else hint('');
}
function animate(now){
  const dt=Math.min(0.033,(now-last)/1000||0); last=now; clock+=dt;
  if(running){
    const overlay=marketOpen||casinoOpen;
    if(!overlay){ if(fishing.state!=='idle')updateFishing(dt); else { tryMove(dt); interactions(); } } else hint('');

    const targetY=heightAt(pWorld.x,pWorld.z);
    pWorld.y=lerp(pWorld.y,targetY,0.35);
    player.rotation.y=lerp(player.rotation.y,pWorld.face,0.2);
    const moving=(keys.up||keys.down||keys.left||keys.right)&&fishing.state==='idle'&&!overlay;
    const sw=moving?Math.sin(pWorld.step)*0.5:0, pd=player.userData;
    if(pd.legL){pd.legL.rotation.x=sw;pd.legR.rotation.x=-sw;pd.armL.rotation.x=-sw*0.7;pd.armR.rotation.x=sw*0.7;}
    player.position.set(pWorld.x, pWorld.y+(moving?Math.abs(Math.sin(pWorld.step))*0.08:0), pWorld.z);

    if(areaT>0){areaT-=dt;if(areaT<=0)H.area.classList.remove('on');}
    if(revT>0){revT-=dt;if(revT<=0)revEl.classList.remove('on');}
  }

  camera.position.set(pWorld.x+CAM_OFF.x,pWorld.y+CAM_OFF.y,pWorld.z+CAM_OFF.z);
  camera.lookAt(pWorld.x,pWorld.y+1,pWorld.z);

  animWater(clock); animGrass(clock);
  water.position.y=WATER_TOP+Math.sin(clock*0.8)*0.03;
  ring.rotation.z+=dt*0.9; trader.rotation.y=Math.sin(clock*0.5)*0.25;

  actEdge=false;
  renderer.render(scene,camera);
  requestAnimationFrame(animate);
}

/* ========================================================================
   13. LIFECYCLE
   ======================================================================== */
addEventListener('resize',()=>{ renderer.setSize(window.innerWidth,window.innerHeight); fitCamera(); });
const startOv=document.getElementById('start');
function start(){ initAudio(); if(AC&&AC.state==='suspended')AC.resume();
  startOv.classList.remove('on'); running=true; updateHUD(); setArea('Arrival Isle','world 1'); }
document.getElementById('startBtn').onclick=start;

// idle preview loop: the island is already alive (water, grass, casino ring) behind the start menu
last=performance.now(); requestAnimationFrame(animate);
document.getElementById('wipe').onclick=()=>{try{localStorage.removeItem(SAVE);}catch(e){}state.coins=0;state.bucket=[];updateHUD();toast('Save wiped');};
updateHUD();
window.__reel={scene,state};
})();
