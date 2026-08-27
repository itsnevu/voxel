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
   1. RENDERER / SCENE / CAMERA / LIGHTS
   ======================================================================== */
let renderer;
try{ renderer=new THREE.WebGLRenderer({antialias:true}); }catch(e){ fail("WebGL could not start in this browser."); return; }
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.getElementById('scene').appendChild(renderer.domElement);
const MAXANISO = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;

const SKY=0x6fd6f6;
const scene=new THREE.Scene();
scene.background=new THREE.Color(SKY);
scene.fog=new THREE.Fog(SKY,150,255);

let camSize=10.5;
const camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,600);
const CAM_OFF=new THREE.Vector3(48,58,48);
function fitCamera(){ const a=window.innerWidth/window.innerHeight;
  camera.left=-camSize*a;camera.right=camSize*a;camera.top=camSize;camera.bottom=-camSize;camera.updateProjectionMatrix(); }
fitCamera();
addEventListener('wheel',e=>{ if(typeof marketOpen!=='undefined'&&(marketOpen||casinoOpen||invOpen))return;
  camSize=clamp(camSize+Math.sign(e.deltaY)*1.1,7,17); fitCamera(); },{passive:true});

scene.add(new THREE.HemisphereLight(0xffffff,0x8fb060,0.62));
scene.add(new THREE.AmbientLight(0xd6ecf2,0.16));
const sun=new THREE.DirectionalLight(0xffefcf,0.55);
sun.position.set(60,100,44); sun.castShadow=true;
sun.shadow.mapSize.set(4096,4096);
sun.shadow.camera.near=1; sun.shadow.camera.far=320;
sun.shadow.camera.left=-60; sun.shadow.camera.right=60; sun.shadow.camera.top=60; sun.shadow.camera.bottom=-60;
sun.shadow.bias=-0.0005;
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
function texDirt(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#8a5a34',['#7a4e2b','#9a683e','#6d4526']); return toTex(c); }
function texSand(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#f2dc9b',['#e6cd87','#ffeeb4','#d9c07c']); return toTex(c); }
function texSeabed(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#dfc98f',['#cfb87e','#eed8a2','#bfa671']); return toTex(c); }
function texStone(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#939ba3',['#848c94','#a1a9b1','#747c84']);
  g.strokeStyle='rgba(55,60,66,.55)';g.beginPath();g.moveTo(2,5);g.lineTo(7,6);g.lineTo(9,11);g.stroke(); return toTex(c); }
function texGrassTop(){ const c=px(S),g=c.getContext('2d');
  // two-tone checker turf + speckles for that vivid Minecraft look
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){ g.fillStyle=((x>>3)+(y>>3))%2?'#4fc32f':'#46b527'; g.fillRect(x,y,1,1); }
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){ if(Math.random()<0.45){ g.fillStyle=['#5bd83b','#3da521','#6ae94a','#43ae24'][(Math.random()*4)|0]; g.fillRect(x,y,1,1);} }
  return toTex(c); }
function texGrassSide(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#8a5a34',['#7a4e2b','#9a683e']);
  for(let x=0;x<S;x++){ const drop=2+((Math.random()*3)|0); for(let y=0;y<drop;y++){ g.fillStyle=['#4fc32f','#5bd83b','#46b527'][(Math.random()*3)|0]; g.fillRect(x,y,1,1);} }
  return toTex(c); }
function texPath(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#cba86f',['#bb975c','#dcbc85','#ab884f']);
  g.fillStyle='#9d7c47'; for(let k=0;k<4;k++)g.fillRect((Math.random()*14)|0,(Math.random()*14)|0,2,2); return toTex(c); }
function texBark(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#7a5028';g.fillRect(0,0,S,S);
  for(let x=0;x<S;x+=2){ g.fillStyle=Math.random()<0.5?'#66421f':'#8a5d30'; g.fillRect(x,0,1,S);} return toTex(c); }
function texWood(){ const c=px(S),g=c.getContext('2d'); g.fillStyle='#a8763f';g.fillRect(0,0,S,S);
  for(let y=0;y<S;y++){ g.fillStyle=y%4===0?'#8a5d30':(Math.random()<0.3?'#b8834a':'#9a6b38'); g.fillRect(0,y,S,1);} return toTex(c); }
function texLeaf(){ const c=px(S),g=c.getContext('2d'); noiseFill(g,S,'#3aa626',['#2f9420','#48bb31','#279016','#54cb3c']); return toTex(c); }
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
function cellType(h){ if(h<=2)return 'seabed'; if(h===3)return 'sand'; if(h<=5)return 'grass'; return 'stone'; }

for(let i=0;i<N;i++){ heightMap[i]=[];
  for(let j=0;j<N;j++){
    const n=fbm(i*0.085+3.5,j*0.085+1.2), dx=(i-HALF)/HALF, dz=(j-HALF)/HALF, d=Math.sqrt(dx*dx+dz*dz);
    const fall=clamp(1-Math.pow(d,2.5)*1.02,0,1); heightMap[i][j]=Math.round(n*fall*10);
  } }

function cellIndex(x,z){ return [clamp(Math.round(x+HALF),0,N-1),clamp(Math.round(z+HALF),0,N-1)]; }
function heightAt(x,z){ const [i,j]=cellIndex(x,z); return heightMap[i][j]; }
function isWaterAt(x,z){ return heightAt(x,z)<=2; }

// spawn: walkable grass near the middle
let spawnCell=null,best=1e9;
for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j];
  if(h>=4&&h<=5){ const d=Math.abs(i-HALF)+Math.abs(j-HALF); if(d<best){best=d;spawnCell=[i,j,h];} } }
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

// guarantee a mineable quarry: if no stone is reachable, raise a plateau on a far reachable grass cell
{ let hasStone=false;
  for(let i=0;i<N&&!hasStone;i++)for(let j=0;j<N;j++) if(heightMap[i][j]>=6&&reachable(i,j)){hasStone=true;break;}
  if(!hasStone){ let cand=null,bd=0;
    for(let i=2;i<N-2;i++)for(let j=2;j<N-2;j++){ if(!reachable(i,j)||heightMap[i][j]<4||heightMap[i][j]>5)continue;
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
function findCellNear(cx,cj,minR,maxR,extra){ let cand=null,bd=1e9;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j];
    if(h<4||h>5||usedCells.has(keyOf(i,j))||!reachable(i,j))continue;
    if(extra&&!extra(i,j))continue;
    const d=Math.hypot(i-cx,j-cj); if(d>=minR&&d<=maxR&&d<bd){bd=d;cand=[i,j,h];} }
  return cand; }
const traderCell=findCellNear(spawnCell[0],spawnCell[1],7,12)||spawnCell; usedCells.add(keyOf(traderCell[0],traderCell[1]));
const casinoCell=findCellNear(spawnCell[0],spawnCell[1],11,20,(i,j)=>Math.hypot(i-traderCell[0],j-traderCell[1])>=9)
  ||findCellNear(spawnCell[0],spawnCell[1],9,26)||spawnCell;
usedCells.add(keyOf(casinoCell[0],casinoCell[1]));

// mine heart: reachable stone cell with the most stone around it
let mineCell=null; { let bs=-1;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ if(heightMap[i][j]<6||!reachable(i,j))continue;
    let s=0; for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++){ const ii=i+a,jj=j+b;
      if(ii>=0&&jj>=0&&ii<N&&jj<N&&heightMap[ii][jj]>=6)s++; }
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
const waterMat=new THREE.MeshLambertMaterial({color:0x2fc0e8,map:TEX.water,transparent:true,opacity:0.84,depthWrite:false});
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

/* ========================================================================
   5. DECOR — stepped voxel trees, cherry trees, flowers, mushrooms, rocks
   ======================================================================== */
const decorUsed=new Set();
const nearAny=(i,j,pts,gap)=>pts.some(p=>Math.hypot(p[0]-i,p[1]-j)<gap);
const landmarks=[spawnCell,traderCell,casinoCell]; if(mineCell)landmarks.push(mineCell);
function decorOK(i,j,gap){ return !usedCells.has(keyOf(i,j))&&!decorUsed.has(keyOf(i,j))&&!pathSet.has(keyOf(i,j))&&!nearAny(i,j,landmarks,gap); }

// tree layouts -> instanced trunk cubes + leaf cubes (green / pink)
const trunkMats=[],leafG=[],leafP=[],treePts=[];
{ const sh=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(treePts.length>=90)break;
    if(!decorOK(i,j,3.2)||nearAny(i,j,treePts,2.6))continue;
    treePts.push([i,j]); decorUsed.add(keyOf(i,j));
    const x=i-HALF,z=j-HALF,pink=Math.random()<0.16,L=pink?leafP:leafG;
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

function makeLabel(text,color){ const c=px(256); c.height=64; const x=c.getContext('2d');
  x.fillStyle='rgba(9,16,20,0.82)'; const r=10,w=256,h=52,y=6; x.beginPath();
  x.moveTo(r,y);x.arcTo(w,y,w,h,r);x.arcTo(w,h+y,0,h+y,r);x.arcTo(0,h+y,0,y,r);x.arcTo(0,y,w,y,r);x.closePath();x.fill();
  x.fillStyle=color;x.font='bold 30px "Chakra Petch",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(text,128,34);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=MAXANISO;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false,depthWrite:false})); sp.scale.set(3.4,0.85,1); return sp; }

// --- trader stall: checkered roof on wooden posts, counter + crates ---
const trader=humanoid({shirt:0x7a4a2a,pants:0x3a2c1c,hat:0xcaa15a,skin:0xe8bd8f});
const tX=traderCell[0]-HALF, tY=heightMap[traderCell[0]][traderCell[1]], tZ=traderCell[1]-HALF;
trader.position.set(tX,tY,tZ); scene.add(trader);
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

// --- casino: stone dais, glowing carpet, gold lamps, spinning ring ---
const casino=new THREE.Group(); const lamps=[];
{ const cbase=texturedBox(3.4,0.5,3.4,TEX.stone); cbase.position.y=0.25; cbase.castShadow=true; cbase.receiveShadow=true; casino.add(cbase);
  const carpet=new THREE.Mesh(new THREE.BoxGeometry(2.3,0.16,2.3), new THREE.MeshLambertMaterial({color:0x9a5cff,emissive:0x6a2fbf,emissiveIntensity:0.65})); carpet.position.y=0.58; casino.add(carpet);
  for(const [lx,lz] of [[-1.45,-1.45],[1.45,-1.45],[-1.45,1.45],[1.45,1.45]]){
    const post=texturedBox(0.18,1.5,0.18,TEX.bark); post.position.set(lx,1.0,lz); post.castShadow=true; casino.add(post);
    const lamp=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.34,0.34), new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0xffb320,emissiveIntensity:0.85}));
    lamp.position.set(lx,1.9,lz); casino.add(lamp); lamps.push(lamp); } }
const ring=new THREE.Mesh(new THREE.TorusGeometry(1.05,0.13,10,26), new THREE.MeshLambertMaterial({color:0xff5d7a,emissive:0x7a1030,emissiveIntensity:0.5}));
ring.rotation.x=Math.PI/2; ring.position.y=1.5; ring.castShadow=true; casino.add(ring);
casino.position.set(casinoCell[0]-HALF,heightMap[casinoCell[0]][casinoCell[1]],casinoCell[1]-HALF); scene.add(casino);
const casinoLabel=makeLabel('CASINO','#ff5d7a'); casinoLabel.position.copy(casino.position).add(new THREE.Vector3(0,3.6,0)); scene.add(casinoLabel);
const CASINO_POS=casino.position.clone();

// --- quarry: ore nodes on the reachable stone ---
const ORE_INFO={
  coal:   {name:'Coal',   price:5,  color:0x2e3338, glow:false, dot:'#565e66'},
  iron:   {name:'Iron',   price:12, color:0xd8cfc4, glow:false, dot:'#d8cfc4'},
  gold:   {name:'Gold',   price:28, color:0xffd24f, glow:true,  dot:'#ffd24f'},
  diamond:{name:'Diamond',price:70, color:0x5ee8e2, glow:true,  dot:'#5ee8e2'}};
function rollOreType(){ const r=Math.random(); return r<0.4?'coal':r<0.7?'iron':r<0.9?'gold':'diamond'; }
function makeOreNode(type){ const g=new THREE.Group(); const info=ORE_INFO[type];
  const base=texturedBox(0.95,0.8,0.95,TEX.stone); base.position.y=0.4; base.castShadow=true; g.add(base);
  for(let k=0;k<5;k++){ const s=rand(0.15,0.23);
    const chip=new THREE.Mesh(new THREE.BoxGeometry(s,s,s),
      new THREE.MeshLambertMaterial({color:info.color,emissive:info.glow?info.color:0x000000,emissiveIntensity:info.glow?0.4:0}));
    if(Math.random()<0.4) chip.position.set(rand(-0.3,0.3),0.8,rand(-0.3,0.3));
    else { const a=rand(0,TAU); chip.position.set(Math.cos(a)*0.48,rand(0.25,0.65),Math.sin(a)*0.48); }
    chip.rotation.y=rand(0,TAU); g.add(chip); }
  return g; }
const oreNodes=[];
{ const stoneCand=[]; for(let i=0;i<N;i++)for(let j=0;j<N;j++)
    if(heightMap[i][j]>=6&&reachable(i,j)&&!usedCells.has(keyOf(i,j)))stoneCand.push([i,j,heightMap[i][j]]);
  stoneCand.sort(()=>Math.random()-0.5);
  const pts=[];
  for(const [i,j,h] of stoneCand){ if(oreNodes.length>=14)break;
    if(nearAny(i,j,pts,2.3))continue; pts.push([i,j]);
    const type=rollOreType(), mesh=makeOreNode(type);
    mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
    oreNodes.push({x:i-HALF,z:j-HALF,type,mesh,alive:true,respawnAt:0}); }
  // starter nodes on grass so mining is discoverable early (coal/iron only)
  const sh2=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh2){ if(oreNodes.length>=18)break;
    if(!decorOK(i,j,3)||nearAny(i,j,treePts,1.6)||nearAny(i,j,pts,4))continue;
    if(Math.hypot(i-spawnCell[0],j-spawnCell[1])<6)continue;
    pts.push([i,j]); decorUsed.add(keyOf(i,j));
    const type=Math.random()<0.6?'coal':'iron', mesh=makeOreNode(type);
    mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
    oreNodes.push({x:i-HALF,z:j-HALF,type,mesh,alive:true,respawnAt:0}); } }
if(mineCell){ const mineLabel=makeLabel('MINE','#9fd7ff');
  mineLabel.position.set(mineCell[0]-HALF,heightMap[mineCell[0]][mineCell[1]]+2.8,mineCell[1]-HALF); scene.add(mineLabel); }

/* ========================================================================
   7. PLAYER + BOBBER
   ======================================================================== */
const player=humanoid({shirt:0xd8483f,pants:0x33507a,hat:0xf0c437,skin:0xf0c090});
const pWorld={x:spawnCell[0]-HALF,z:spawnCell[1]-HALF,y:spawnCell[2],face:0,step:0};
player.position.set(pWorld.x,pWorld.y,pWorld.z); scene.add(player);

const bobber=new THREE.Group();
const bTop=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.2,0.28),new THREE.MeshLambertMaterial({color:0xff5d7a})); bTop.position.y=0.16;
const bBot=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.16,0.28),new THREE.MeshLambertMaterial({color:0xf2f2f2}));
bobber.add(bTop,bBot); bobber.visible=false; scene.add(bobber);

/* ========================================================================
   8. INPUT / AUDIO / HUD / MINIMAP / TOAST / REVEAL
   ======================================================================== */
const keys={}; let actEdge=false;
const KMAP={KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',KeyE:'act',Space:'act'};
addEventListener('keydown',e=>{
  // let Space/Enter activate focused buttons instead of hijacking them
  const tag=e.target&&e.target.tagName;
  const onUI=tag==='BUTTON'||tag==='INPUT'||(e.target&&e.target.closest&&e.target.closest('[role="button"]'));
  if(onUI&&(e.code==='Space'||e.code==='Enter'))return;
  const m=KMAP[e.code]; if(m){e.preventDefault(); if(!keys[m]&&m==='act')actEdge=true; keys[m]=true;}
  if(e.code==='KeyI'||e.code==='Tab'){ e.preventDefault(); if(invOpen)closeInv(); else if(running)openInv(); }
  if(e.code==='Escape'){ if(marketOpen)closeMarket(); else if(casinoOpen)closeCasino(); else if(invOpen)closeInv(); else if(fishing.state!=='idle')cancelFish(); else if(mining.node)cancelMine(); }},{passive:false});
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
  lose:()=>{beep(200,.3,'sawtooth',.07);setTimeout(()=>beep(130,.4,'sawtooth',.07),160);},
  pick:()=>beep(340+Math.random()*120,.05,'square',.04),
  ore:()=>{beep(620,.09,'triangle',.06);setTimeout(()=>beep(930,.12,'triangle',.06),80);}};
document.getElementById('mute').onclick=()=>{muted=!muted;const b=document.getElementById('mute');b.textContent=muted?'♪ MUTED':'♪ SOUND';b.style.color=muted?'var(--faint)':'';};

const RAR={common:'#b9c6c4',uncommon:'#74e08a',rare:'#57b7ff',epic:'#c07bff',legendary:'#ffc24b'};
const H={bn:document.querySelector('#hud-bucket .n'),bucket:document.getElementById('hud-bucket'),coins:document.getElementById('coinVal'),
  area:document.getElementById('area'),hint:document.getElementById('hint'),
  oreC:document.getElementById('oreC'),oreI:document.getElementById('oreI'),oreG:document.getElementById('oreG'),oreD:document.getElementById('oreD')};
const fmt=n=>Math.round(n).toLocaleString('en-US');
function updateHUD(){H.bn.textContent=state.bucket.length+'/'+CAP;H.bucket.classList.toggle('full',state.bucket.length>=CAP);H.coins.textContent=fmt(state.coins);
  H.oreC.textContent=state.ores.coal;H.oreI.textContent=state.ores.iron;H.oreG.textContent=state.ores.gold;H.oreD.textContent=state.ores.diamond;
  if(typeof updateHotbar==='function')updateHotbar(); if(invOpen)renderInv();}
let hintCur='';
function hint(h){if(h!==hintCur){hintCur=h;if(h){H.hint.innerHTML=h;H.hint.classList.add('on');}else H.hint.classList.remove('on');}}
const tw=document.getElementById('toasts');
function toast(m,k){const d=document.createElement('div');d.className='toast '+(k||'');d.textContent=m;tw.appendChild(d);setTimeout(()=>d.remove(),2000);}
let areaCur='',areaT=0;
function setArea(name,sub){if(name!==areaCur){areaCur=name;H.area.innerHTML=name+'<small>'+sub+'</small>';H.area.classList.add('on');areaT=3;}}
function fishSVG(rar){const c=RAR[rar];return `<svg width="76" height="46" viewBox="0 0 76 46"><g fill="${c}"><ellipse cx="34" cy="23" rx="24" ry="13"/><polygon points="8,23 -2,12 -2,34"/></g><circle cx="46" cy="20" r="2.4" fill="#0e1a20"/><path d="M50 16 q8 7 0 14" stroke="${c}" stroke-width="2" fill="none"/></svg>`;}
const revEl=document.getElementById('reveal'); let revT=0;
function reveal(f){revEl.innerHTML=`<div class="reveal-card" style="border-color:${RAR[f.rar]};box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 30px ${RAR[f.rar]}55"><div class="r" style="color:${RAR[f.rar]}">${f.rar}</div>${fishSVG(f.rar)}<div class="nm">${f.name}</div><div class="v">◈ ${fmt(f.val)}</div></div>`;revEl.classList.add('on');revT=1.9;}

// ---- minimap ----
const mmC=document.getElementById('minimap'),mmX=mmC?mmC.getContext('2d'):null;
const mmBase=px(N);
{ const g=mmBase.getContext('2d');
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j],t=cellType(h);
    g.fillStyle=t==='seabed'?'#39c7ea':t==='sand'?'#f2dc9b':t==='grass'?'#4fc32f':'#98a0a8';
    if(pathSet.has(keyOf(i,j))&&(t==='grass'||t==='sand'))g.fillStyle='#cba86f';
    g.fillRect(i,j,1,1); } }
function drawMinimap(){ if(!mmX)return; const W=mmC.width;
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
  if(mineCell)dot(mineCell[0]-HALF,mineCell[1]-HALF,'#e8f4ff',4);
  dot(pWorld.x,pWorld.z,'#ffffff',4,true);
  mmX.restore(); }

/* ========================================================================
   9. STATE + FISH + UPGRADES
   ======================================================================== */
const SAVE='reelfortune3d-v1', CAP=12, MAXLVL=3;
const state={coins:0,bucket:[],ores:{coal:0,iron:0,gold:0,diamond:0},rodLvl:1,pickLvl:1,
  stats:{caught:0,mined:0,earned:0,bestWin:0,spins:0,winsCt:0,losses:0}};
function save(){try{localStorage.setItem(SAVE,JSON.stringify(state));}catch(e){}}
function load(){try{const r=localStorage.getItem(SAVE);if(r){const s=JSON.parse(r);
  state.coins=s.coins||0;state.bucket=Array.isArray(s.bucket)?s.bucket:[];
  if(s.ores)for(const k in state.ores)state.ores[k]=s.ores[k]|0;
  if(s.stats)for(const k in state.stats)state.stats[k]=+s.stats[k]||0;
  state.rodLvl=clamp(s.rodLvl|0||1,1,MAXLVL);state.pickLvl=clamp(s.pickLvl|0||1,1,MAXLVL);}}catch(e){}}
load();
function F(name,rar,val){return {name,rar,val};}
const TABLE=[[F('Sardine','common',8),40],[F('Perch','common',12),34],[F('Carp','common',10),30],
  [F('Bass','uncommon',20),26],[F('Trout','uncommon',24),22],[F('Snapper','uncommon',34),18],
  [F('Eel','rare',44),14],[F('Tuna','rare',82),10],[F('Koi','rare',130),8],
  [F('Sturgeon','epic',128),6],[F('Swordfish','epic',156),5],[F('Golden Carp','epic',168),4],
  [F('Anglerfish','legendary',430),2],[F('Star Koi','legendary',620),1]];
const RORDER={common:0,uncommon:1,rare:2,epic:3,legendary:4};
function rollOnce(){ let tot=0; for(const e of TABLE)tot+=e[1]; let r=Math.random()*tot;
  for(const e of TABLE){ r-=e[1]; if(r<=0){ const t=e[0]; return {uid:(Date.now()+Math.random()).toString(36),name:t.name,rar:t.rar,val:Math.round(t.val*rand(0.85,1.18)),wins:0}; } }
  return null; }
function rollFish(){ let f=rollOnce();
  for(let k=1;k<state.rodLvl;k++){ if(Math.random()<0.45){ const g=rollOnce(); if(RORDER[g.rar]>RORDER[f.rar])f=g; } }
  return f; }
// rotating market demand: every 3 min one category is HOT (x1.6), one SURPLUS (x0.75)
const MKT_CATS=['fish','coal','iron','gold','diamond'];
const MKT_MS=180000;
function mktMods(){ const e=Math.floor(Date.now()/MKT_MS);
  const hi=Math.floor(hash(e,7)*MKT_CATS.length)%MKT_CATS.length;
  let lo=Math.floor(hash(e,13)*(MKT_CATS.length-1))%(MKT_CATS.length-1); if(lo>=hi)lo++;
  return {hot:MKT_CATS[hi],cold:MKT_CATS[lo]}; }
function priceMult(cat){ const m=mktMods(); return cat===m.hot?1.6:cat===m.cold?0.75:1; }
const catLabel=c=>c==='fish'?'Fish':ORE_INFO[c].name;
const ROD_UP=[0,0,250,900], PICK_UP=[0,0,200,750];
const ROD_DESC=['','Old Rod','Lucky Rod — rare fish bite more often','Golden Rod — even luckier'];
const PICK_DESC=['','Rusty Pick','Iron Pick — mines faster, better yield','Diamond Pick — the quarry fears you'];

/* ========================================================================
   10. MARKET (fish · ores · upgrades)
   ======================================================================== */
let marketOpen=false;
const marketEl=document.getElementById('market'),marketList=document.getElementById('marketList'),
  oreList=document.getElementById('oreList'),upgList=document.getElementById('upgList'),mktBanner=document.getElementById('mktBanner');
function renderBanner(){ const m=mktMods(), left=MKT_MS-(Date.now()%MKT_MS), mm=Math.floor(left/60000), ss=Math.floor(left/1000)%60;
  mktBanner.innerHTML=`<span class="mkthot">▲ HOT: ${catLabel(m.hot)} ×1.6</span> · <span class="mktcold">▼ SURPLUS: ${catLabel(m.cold)} ×0.75</span>
    <span style="color:var(--faint)"> · rotates in ${mm}:${String(ss).padStart(2,'0')}</span>`; }
function renderMarket(){ if(!state.bucket.length){marketList.innerHTML='<div class="empty">Your bucket is empty. Go catch something!</div>';return;}
  const pm=priceMult('fish');
  let h=''; state.bucket.forEach((f,i)=>{h+=`<div class="fishrow"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
    <span class="nm">${f.name} ${f.wins?`<span class="hot">${'★'.repeat(Math.min(f.wins,5))} ×${Math.pow(2,f.wins)}</span>`:''}</span>
    <span class="rr" style="color:${RAR[f.rar]}">${f.rar}</span><span class="vv">◈ ${fmt(f.val*pm)}</span><button class="btn" data-sellone="${i}">Sell</button></div>`;});
  marketList.innerHTML=h; }
function renderOres(){ const any=Object.values(state.ores).some(v=>v>0);
  if(!any){oreList.innerHTML='<div class="empty">No ores yet — find rocks with colored chunks and hold E.</div>';return;}
  let h=''; for(const k in ORE_INFO){ const n=state.ores[k]; if(!n)continue; const info=ORE_INFO[k];
    h+=`<div class="fishrow"><span class="dot" style="background:${info.dot};color:${info.dot}"></span>
      <span class="nm">${info.name} <span style="color:var(--muted)">×${n}</span></span>
      <span class="vv">◈ ${fmt(info.price*n*priceMult(k))}</span><button class="btn" data-sellore="${k}">Sell all</button></div>`; }
  oreList.innerHTML=h; }
function renderUpg(){
  const row=(kind,lvl,ups,descs)=>{ const nxt=lvl+1, cost=ups[nxt];
    return `<div class="fishrow"><span class="nm">${kind==='rod'?'🎣':'⛏️'} ${descs[lvl]} <span style="color:var(--teal)">Lv.${lvl}</span></span>
      ${lvl>=MAXLVL?'<span class="rr" style="color:var(--gold)">MAX</span>'
        :`<span class="vv">◈ ${fmt(cost)}</span><button class="btn gold" data-buy="${kind}" ${state.coins<cost?'disabled':''}>Upgrade</button>`}</div>`; };
  upgList.innerHTML=row('rod',state.rodLvl,ROD_UP,ROD_DESC)+row('pick',state.pickLvl,PICK_UP,PICK_DESC); }
function openMarket(){marketOpen=true;marketEl.classList.add('on');renderBanner();renderMarket();renderOres();renderUpg();}
function closeMarket(){marketOpen=false;marketEl.classList.remove('on');save();}
document.getElementById('marketX').onclick=closeMarket;
document.getElementById('sellAll').onclick=()=>{ if(!state.bucket.length){toast('Bucket empty');return;}
  let g=0; const pm=priceMult('fish'); for(const f of state.bucket)g+=Math.round(f.val*pm);
  state.coins+=g;state.stats.earned+=g;state.bucket=[];sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderMarket();renderUpg();save();};
marketEl.addEventListener('click',e=>{
  const t1=e.target.closest?e.target.closest('[data-sellone]'):null;
  if(t1){const i=+t1.getAttribute('data-sellone'),f=state.bucket[i];
    if(f){const g=Math.round(f.val*priceMult('fish'));state.coins+=g;state.stats.earned+=g;state.bucket.splice(i,1);sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderMarket();renderUpg();save();} return;}
  const t2=e.target.closest?e.target.closest('[data-sellore]'):null;
  if(t2){const k=t2.getAttribute('data-sellore'),n=state.ores[k];
    if(n>0){const g=Math.round(n*ORE_INFO[k].price*priceMult(k));state.coins+=g;state.stats.earned+=g;state.ores[k]=0;sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderOres();renderUpg();save();} return;}
  const t3=e.target.closest?e.target.closest('[data-buy]'):null;
  if(t3){const kind=t3.getAttribute('data-buy');
    if(kind==='rod'&&state.rodLvl<MAXLVL&&state.coins>=ROD_UP[state.rodLvl+1]){state.coins-=ROD_UP[state.rodLvl+1];state.rodLvl++;sfx.ore();toast(ROD_DESC[state.rodLvl]+'!','good');}
    else if(kind==='pick'&&state.pickLvl<MAXLVL&&state.coins>=PICK_UP[state.pickLvl+1]){state.coins-=PICK_UP[state.pickLvl+1];state.pickLvl++;sfx.ore();toast(PICK_DESC[state.pickLvl]+'!','good');}
    updateHUD();renderUpg();save();} });

/* ========================================================================
   11. CASINO ROULETTE (real 3D wheel in its own scene)
   ======================================================================== */
let casinoOpen=false,stakeIdx=-1,betColor=null,spinning=false;
const casinoEl=document.getElementById('casino'),stakeListEl=document.getElementById('stakeList'),
  spinBtn=document.getElementById('spinBtn'),spinResult=document.getElementById('spinResult');
const NSEG=15,SEG=[]; SEG[0]='green'; for(let i=1;i<NSEG;i++)SEG[i]=(i%2===1)?'red':'black';
const SEGCOL={red:0xc0392b,black:0x242a30,green:0x2fae5e};
const SEGA=TAU/NSEG, WPTR=-Math.PI/2; // angle per wedge · fixed world angle the gold pointer reads off

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
function closeCasino(){casinoOpen=false;spinSeq++;spinning=false;casinoEl.classList.remove('on');save();}
document.getElementById('casinoX').onclick=closeCasino;
stakeListEl.addEventListener('click',e=>{if(spinning)return;const t=e.target.closest('[data-stake]');if(t){stakeIdx=+t.getAttribute('data-stake');renderStakes();updateSpinBtn();}});
document.querySelectorAll('.betbtn').forEach(b=>{const pick=()=>{if(spinning)return;betColor=b.getAttribute('data-bet');
  document.querySelectorAll('.betbtn').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');updateSpinBtn();};
  b.onclick=pick;b.onkeydown=e=>{if(e.code==='Enter'||e.code==='Space'){e.preventDefault();pick();}};});
let spinSeq=0;
spinBtn.onclick=()=>{ if(spinBtn.disabled)return; const fish=state.bucket[stakeIdx]; if(!fish)return;
  spinning=true;updateSpinBtn();spinResult.innerHTML='<span style="color:var(--muted)">The wheel spins…</span>';
  const mySpin=++spinSeq, myBet=betColor;
  const winIdx=Math.floor(Math.random()*NSEG),targetCenter=winIdx*SEGA+SEGA/2,turns=5+Math.floor(Math.random()*3);
  const startA=wheelAngle%TAU; let finalA=-targetCenter-WPTR; while(finalA<startA)finalA+=TAU; finalA+=turns*TAU;
  const dur=3.6; let t0=null,lastBeep=0;
  function tick(ts){ if(mySpin!==spinSeq||!casinoOpen)return; // spin cancelled (ESC/close) — fish untouched
    if(t0==null)t0=ts; const el=(ts-t0)/1000,p=Math.min(1,el/dur),e=1-Math.pow(1-p,3);
    wheelAngle=startA+(finalA-startA)*e; renderWheelScene();
    if(el-lastBeep>0.09+0.4*p){lastBeep=el;sfx.spin();}
    if(p<1)requestAnimationFrame(tick); else resolveSpin(winIdx,fish,myBet); }
  requestAnimationFrame(tick); };
function resolveSpin(idx,fish,myBet){ const color=SEG[idx],won=(color===myBet);
  state.stats.spins++;
  if(won){ const mult=(color==='green')?14:2,before=fish.val; fish.val=Math.round(fish.val*mult); fish.wins++;
    state.stats.winsCt++; state.stats.bestWin=Math.max(state.stats.bestWin,fish.val);
    spinResult.innerHTML=`<span class="win">▲ ${color.toUpperCase()} — WON! ${fish.name} ◈${fmt(before)} → <b>◈${fmt(fish.val)}</b>. Spin again or cash out.</span>`;
    sfx.win();toast(`${fish.name} doubled → ◈${fmt(fish.val)}`,'gold'); }
  else { state.stats.losses++; const lost=fish.name,li=state.bucket.indexOf(fish); if(li>=0)state.bucket.splice(li,1); stakeIdx=-1;
    spinResult.innerHTML=`<span class="lose">▼ ${color.toUpperCase()} — the eel swallowed your ${lost}. Gone.</span>`; sfx.lose();toast('Lost your '+lost,'bad'); }
  spinning=false;betColor=null;document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));
  renderStakes();updateHUD();updateSpinBtn();save(); }

/* ========================================================================
   12. FISHING (3D)
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
    if(f.cast>=1){f.state='wait';f.biteAt=rand(1.1,3.2)*(1-0.12*(state.rodLvl-1));f.t=0;} }
  else if(f.state==='wait'){ f.t+=dt; bobber.position.y=WATER_TOP+0.1+Math.sin(clock*3)*0.05; hint('Waiting for a bite… <span class="key">ESC</span> reel in'); if(f.t>=f.biteAt){f.state='bite';f.t=0;sfx.bite();} }
  else if(f.state==='bite'){ f.t+=dt; bobber.position.y=WATER_TOP+0.05+Math.sin(clock*22)*0.14; hint('❗ <b>BITE!</b> press <span class="key">E</span> now!');
    if(actEdge){f.state='reel';f.reel=0;f.reelT=0;} else if(f.t>0.85){cancelFish();sfx.miss();toast('It got away…');} }
  else if(f.state==='reel'){ f.reelT+=dt; if(keys.act){f.reel+=dt*0.75;if(Math.random()<0.08)sfx.reel();} else f.reel-=dt*0.28; f.reel=clamp(f.reel,0,1);
    bobber.position.y=WATER_TOP+0.1+f.reel*0.3; hint('Reel it in! hold <span class="key">E</span>');
    if(f.reel>=1){ const fish=rollFish(); f.state='idle'; bobber.visible=false;
      if(state.bucket.length<CAP){state.bucket.push(fish);state.stats.caught++;sfx.catch();reveal(fish);updateHUD();save();} else toast('Bucket full — sell some fish!'); }
    else if(f.reelT>4.5){cancelFish();sfx.miss();toast('The line snapped…');} }
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
  mining.dur=1.7/(1+(state.pickLvl-1)*0.4); }
function updateMining(dt){ const n=mining.node;
  if(!n||!n.alive){cancelMine();return;}
  if(keys.up||keys.down||keys.left||keys.right){cancelMine();return;}
  if(keys.act){ mining.t+=dt; if(Math.random()<0.12)sfx.pick(); n.mesh.scale.setScalar(1+Math.sin(clock*30)*0.03); }
  else { mining.t-=dt*0.6; if(mining.t<=0){ n.mesh.scale.setScalar(1); cancelMine(); return; } }
  mining.t=clamp(mining.t,0,mining.dur);
  const p=mining.t/mining.dur,k=Math.floor(p*8);
  hint(`⛏ Mining ${ORE_INFO[n.type].name}… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  if(mining.t>=mining.dur){ n.mesh.scale.setScalar(1);
    const bonus=Math.random()<(0.2+0.15*(state.pickLvl-1))?1:0, got=1+bonus;
    state.ores[n.type]+=got; state.stats.mined+=got; sfx.ore();
    toast(`+${got} ${ORE_INFO[n.type].name}`,'good');
    n.alive=false; n.mesh.visible=false; n.respawnAt=clock+40+rand(0,25);
    cancelMine(); updateHUD(); save(); } }

/* ========================================================================
   14. INVENTORY + HOTBAR
   ======================================================================== */
let invOpen=false;
const invEl=document.getElementById('inv'),invTools=document.getElementById('invTools'),
  invFish=document.getElementById('invFish'),invOres=document.getElementById('invOres'),invStats=document.getElementById('invStats');
const HB={rod:document.getElementById('hbRod'),pick:document.getElementById('hbPick'),
  bucket:document.getElementById('hbBucket'),pouch:document.getElementById('hbPouch')};
function updateHotbar(){ HB.rod.textContent='Lv'+state.rodLvl; HB.pick.textContent='Lv'+state.pickLvl;
  HB.bucket.textContent=state.bucket.length+'/'+CAP;
  HB.pouch.textContent=state.ores.coal+state.ores.iron+state.ores.gold+state.ores.diamond; }
function renderInv(){
  const rodNext=state.rodLvl<MAXLVL?`next ◈${fmt(ROD_UP[state.rodLvl+1])} at Trader`:'MAX';
  const pickNext=state.pickLvl<MAXLVL?`next ◈${fmt(PICK_UP[state.pickLvl+1])} at Trader`:'MAX';
  invTools.innerHTML=
    `<div class="fishrow"><span class="nm">🎣 ${ROD_DESC[state.rodLvl]} <span style="color:var(--teal)">Lv.${state.rodLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${rodNext}</span></div>
    <div class="fishrow"><span class="nm">⛏️ ${PICK_DESC[state.pickLvl]} <span style="color:var(--teal)">Lv.${state.pickLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${pickNext}</span></div>`;
  if(!state.bucket.length)invFish.innerHTML='<div class="empty">Bucket empty — go fishing!</div>';
  else{ let h='<div class="invgrid">';
    state.bucket.forEach(f=>{h+=`<div class="invcard" style="border-color:${RAR[f.rar]}55"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
      <div class="inm">${f.name}</div><div class="ivv">◈ ${fmt(f.val)}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</div></div>`;});
    invFish.innerHTML=h+'</div>'; }
  let oh=''; for(const k in ORE_INFO){ const info=ORE_INFO[k];
    oh+=`<div class="fishrow"><span class="dot" style="background:${info.dot};color:${info.dot}"></span>
      <span class="nm">${info.name}</span><span class="rr" style="color:var(--muted)">×${state.ores[k]}</span>
      <span class="vv">◈ ${fmt(info.price*priceMult(k))}/ea</span></div>`; }
  invOres.innerHTML=oh;
  const st=state.stats, wl=st.spins?` (${st.winsCt}W · ${st.losses}L)`:'';
  invStats.innerHTML=
    `<div class="statrow"><span>🐟 Fish caught</span><b>${fmt(st.caught)}</b></div>
     <div class="statrow"><span>⛏️ Ores mined</span><b>${fmt(st.mined)}</b></div>
     <div class="statrow"><span>◈ Coins earned</span><b>${fmt(st.earned)}</b></div>
     <div class="statrow"><span>🎰 Roulette spins</span><b>${fmt(st.spins)}${wl}</b></div>
     <div class="statrow"><span>🏆 Biggest win</span><b>◈ ${fmt(st.bestWin)}</b></div>`;
}
function openInv(){ if(marketOpen||casinoOpen)return; invOpen=true; invEl.classList.add('on'); renderInv(); }
function closeInv(){ invOpen=false; invEl.classList.remove('on'); }
document.getElementById('invX').onclick=closeInv;
document.querySelectorAll('#hotbar .slot').forEach(s=>{ s.addEventListener('click',()=>{ if(invOpen)closeInv(); else openInv(); }); });

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
  moveDir.normalize(); pWorld.step+=dt*9;
  const sp=7.0, curH=heightAt(pWorld.x,pWorld.z);
  const nx=pWorld.x+moveDir.x*sp*dt;
  if(!isWaterAt(nx,pWorld.z)&&Math.abs(heightAt(nx,pWorld.z)-curH)<2&&Math.abs(nx)<HALF-1)pWorld.x=nx;
  const nz=pWorld.z+moveDir.z*sp*dt, curH2=heightAt(pWorld.x,pWorld.z);
  if(!isWaterAt(pWorld.x,nz)&&Math.abs(heightAt(pWorld.x,nz)-curH2)<2&&Math.abs(nz)<HALF-1)pWorld.z=nz;
  pWorld.face=Math.atan2(moveDir.x,moveDir.z);
}
function interactions(){
  const dT=Math.hypot(pWorld.x-TRADER_POS.x,pWorld.z-TRADER_POS.z), dC=Math.hypot(pWorld.x-CASINO_POS.x,pWorld.z-CASINO_POS.z);
  const ore=nearestOre();
  const w=nearestWater(), canFish=w&&w.dist<2.4;
  if(dT<2.6){ hint('<span class="key">E</span> Trade at the Market'); if(actEdge){initAudio();openMarket();} }
  else if(dC<2.8){ hint('<span class="key">E</span> Enter the Spinning Eel'); if(actEdge){initAudio();openCasino();} }
  else if(ore){ hint(`<span class="key">E</span> Mine ${ORE_INFO[ore.type].name}`); if(actEdge)startMine(ore); }
  else if(canFish){ if(state.bucket.length>=CAP)hint('Bucket full — sell at the Trader'); else { hint('<span class="key">E</span> Cast your line'); if(actEdge)startCast(w); } }
  else hint('');
}
let lastBiome='',bannerT=0,mktEpochSeen=Math.floor(Date.now()/MKT_MS);
function biomeCheck(){ const t=cellType(heightAt(pWorld.x,pWorld.z));
  if(t!==lastBiome){ lastBiome=t;
    if(t==='stone')setArea('The Quarry','hold E on ore to mine');
    else if(t==='sand')setArea('Shoreline','cast your line'); } }
function animate(now){
  const dt=Math.min(0.033,(now-last)/1000||0); last=now; clock+=dt;
  if(running){
    const overlay=marketOpen||casinoOpen||invOpen;
    if(!overlay){ if(fishing.state!=='idle')updateFishing(dt); else if(mining.node)updateMining(dt); else { tryMove(dt); interactions(); } } else hint('');

    const targetY=heightAt(pWorld.x,pWorld.z);
    pWorld.y=lerp(pWorld.y,targetY,0.35);
    player.rotation.y=lerpAngle(player.rotation.y,pWorld.face,0.2);
    const moving=(keys.up||keys.down||keys.left||keys.right)&&fishing.state==='idle'&&!overlay&&!mining.node;
    const sw=moving?Math.sin(pWorld.step)*0.5:0, pd=player.userData;
    if(pd.legL){pd.legL.rotation.x=sw;pd.legR.rotation.x=-sw;pd.armL.rotation.x=-sw*0.7;pd.armR.rotation.x=sw*0.7;}
    player.position.set(pWorld.x, pWorld.y+(moving?Math.abs(Math.sin(pWorld.step))*0.08:0), pWorld.z);

    for(const n of oreNodes){ if(!n.alive&&clock>=n.respawnAt&&n.respawnAt>0){n.alive=true;n.mesh.visible=true;} }
    biomeCheck();
    if(marketOpen===true&&clock-bannerT>0.5){bannerT=clock;renderBanner();
      const e=Math.floor(Date.now()/MKT_MS);
      if(e!==mktEpochSeen){mktEpochSeen=e;renderMarket();renderOres();}}
    if(areaT>0){areaT-=dt;if(areaT<=0)H.area.classList.remove('on');}
    if(revT>0){revT-=dt;if(revT<=0)revEl.classList.remove('on');}
  }

  camera.position.set(pWorld.x+CAM_OFF.x,pWorld.y+CAM_OFF.y,pWorld.z+CAM_OFF.z);
  camera.lookAt(pWorld.x,pWorld.y+1,pWorld.z);

  animWater(clock); animGrass(clock);
  water.position.y=WATER_TOP+Math.sin(clock*0.8)*0.03;
  ring.rotation.z+=dt*0.9; trader.rotation.y=Math.sin(clock*0.5)*0.25;
  for(let k=0;k<lamps.length;k++)lamps[k].material.emissiveIntensity=0.7+Math.sin(clock*3+k*1.7)*0.3;
  drawMinimap();

  actEdge=false;
  renderer.render(scene,camera);
  requestAnimationFrame(animate);
}

/* ========================================================================
   15. LIFECYCLE
   ======================================================================== */
addEventListener('resize',()=>{ renderer.setSize(window.innerWidth,window.innerHeight); fitCamera(); });
const startOv=document.getElementById('start');
function start(){ initAudio(); if(AC&&AC.state==='suspended')AC.resume();
  startOv.classList.remove('on'); running=true; updateHUD(); setArea('Fortune Isle','world 1'); }
document.getElementById('startBtn').onclick=start;

// idle preview loop: the island is already alive behind the start menu
last=performance.now(); requestAnimationFrame(animate);
document.getElementById('wipe').onclick=()=>{try{localStorage.removeItem(SAVE);}catch(e){}
  state.coins=0;state.bucket=[];state.ores={coal:0,iron:0,gold:0,diamond:0};state.rodLvl=1;state.pickLvl=1;
  state.stats={caught:0,mined:0,earned:0,bestWin:0,spins:0,winsCt:0,losses:0};
  updateHUD();toast('Save wiped');};
updateHUD();
})();
