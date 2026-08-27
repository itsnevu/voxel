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

let SKY=0x6fd6f6;
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

const hemiL=new THREE.HemisphereLight(0xffffff,0x8fb060,0.62); scene.add(hemiL);
const ambL=new THREE.AmbientLight(0xd6ecf2,0.16); scene.add(ambL);
const sun=new THREE.DirectionalLight(0xffefcf,0.55);
sun.position.set(60,100,44); sun.castShadow=true;
sun.shadow.mapSize.set(4096,4096);
sun.shadow.camera.near=1; sun.shadow.camera.far=320;
sun.shadow.camera.left=-60; sun.shadow.camera.right=60; sun.shadow.camera.top=60; sun.shadow.camera.bottom=-60;
sun.shadow.bias=-0.0005;
scene.add(sun); scene.add(sun.target);

/* ========================================================================
   1b. WORLDS — themed islands unlocked at the Harbor (travel = regenerate)
   ======================================================================== */
const WORLDS={
  isle:{name:'Fortune Isle',sub:'world 1',cost:0,seed:0,hMul:1,stoneH:6,fishMul:1,oreN:14,oreYield:1,
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
  frost:{name:'Frostbite Isle',sub:'world 4 · frozen riches',cost:25000,seed:311,hMul:1.2,stoneH:6,fishMul:4,oreN:26,oreYield:1,
    sky:0xbfe6f5,water:0x7fd4e8,pink:0,treeMax:60,
    grass:['#e8f2f5','#dcebf0',['#f5fbfd','#cfe2e8','#ffffff','#c2d8e0']],
    leaf:['#9fd0c8',['#8fc2ba','#b2ded6','#7fb3ab']],
    sand:['#d8e4e8',['#cbd9de','#e6eff2','#bccdd3']],
    stone:['#a8b4bc',['#98a4ac','#b6c2ca','#8a969e']]}};
const WORLD_ORDER=['isle','mine','volcano','frost'];
let worldKey='isle'; try{ const wk=localStorage.getItem('reelfortune3d-world'); if(wk&&WORLDS[wk])worldKey=wk; }catch(e){}
const WORLD=WORLDS[worldKey];
SKY=WORLD.sky; scene.background.setHex(SKY); scene.fog.color.setHex(SKY);

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

// guarantee a mineable quarry: if no stone is reachable, raise a plateau on a far reachable grass cell
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
function findCellNear(cx,cj,minR,maxR,extra){ let cand=null,bd=1e9;
  for(let i=0;i<N;i++)for(let j=0;j<N;j++){ const h=heightMap[i][j];
    if(h<4||h>=WORLD.stoneH||usedCells.has(keyOf(i,j))||!reachable(i,j))continue;
    if(extra&&!extra(i,j))continue;
    const d=Math.hypot(i-cx,j-cj); if(d>=minR&&d<=maxR&&d<bd){bd=d;cand=[i,j,h];} }
  return cand; }
const traderCell=findCellNear(spawnCell[0],spawnCell[1],7,12)||spawnCell; usedCells.add(keyOf(traderCell[0],traderCell[1]));
const casinoCell=findCellNear(spawnCell[0],spawnCell[1],11,20,(i,j)=>Math.hypot(i-traderCell[0],j-traderCell[1])>=9)
  ||findCellNear(spawnCell[0],spawnCell[1],9,26)||spawnCell;
usedCells.add(keyOf(casinoCell[0],casinoCell[1]));

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
const trunkMats=[],leafG=[],leafP=[],treePts=[],treeData=[];
{ const sh=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh){ if(treePts.length>=WORLD.treeMax)break;
    if(!decorOK(i,j,3.2)||nearAny(i,j,treePts,2.6))continue;
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

// --- casino: stone dais, gold lamps + a REAL roulette table standing in the world ---
const NSEG=15,SEG=[]; SEG[0]='green'; for(let i=1;i<NSEG;i++)SEG[i]=(i%2===1)?'red':'black';
const SEGCOL={red:0xc0392b,black:0x242a30,green:0x2fae5e};
const SEGA=TAU/NSEG, WR=1.15;
const R_TRACK=1.44,R_POCK=0.82,Y_TRACK=1.36,Y_POCK=1.31; // ball path, local to the table group
function wedgeGeo(r,thetaStart,thetaLength,h){
  const shape=new THREE.Shape(); shape.moveTo(0,0); shape.absarc(0,0,r,thetaStart,thetaStart+thetaLength,false); shape.lineTo(0,0);
  const g=new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:false}); g.rotateX(-Math.PI/2); return g; }
const casino=new THREE.Group(); const lamps=[];
{ const cbase=texturedBox(4.2,0.5,4.2,TEX.stone); cbase.position.y=0.25; cbase.castShadow=true; cbase.receiveShadow=true; casino.add(cbase);
  for(const [lx,lz] of [[-1.85,-1.85],[1.85,-1.85],[-1.85,1.85],[1.85,1.85]]){
    const post=texturedBox(0.18,2.4,0.18,TEX.bark); post.position.set(lx,1.55,lz); post.castShadow=true; casino.add(post);
    const lamp=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.34,0.34), new THREE.MeshLambertMaterial({color:0xffd24f,emissive:0xffb320,emissiveIntensity:0.85}));
    lamp.position.set(lx,2.95,lz); casino.add(lamp); lamps.push(lamp); } }
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
for(let i=0;i<NSEG;i++){ const w=new THREE.Mesh(wedgeGeo(WR,i*SEGA,SEGA,0.14),new THREE.MeshLambertMaterial({color:SEGCOL[SEG[i]]}));
  w.castShadow=true; wheelDisc.add(w); }
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
const casinoLabel=makeLabel('CASINO','#ff5d7a'); casinoLabel.position.copy(casino.position).add(new THREE.Vector3(0,3.9,0)); scene.add(casinoLabel);
const CASINO_POS=casino.position.clone();
const WHEEL_CENTER=casino.position.clone().add(new THREE.Vector3(0,1.7,0));
let viewMode='follow'; // 'follow' walks with the player · 'casino' flies the camera onto the table
let wheelAngle=0, ballA=0, ballLockIdx=0;
function setBall(b,r,y){ ballA=b; ball.position.set(Math.cos(b)*r,y,Math.sin(b)*r); }
function setBallPocket(i){ const phi=i*SEGA+SEGA/2; setBall(-phi-wheelAngle,R_POCK,Y_POCK); }
setBallPocket(0);

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
  gate.position.set(gx,gy,gz); gate.rotation.y=Math.atan2(ux,uz); scene.add(gate); }

// --- quarry: ore nodes on the reachable stone ---
const ORE_INFO={
  wood:   {name:'Wood',   price:3,  color:0x9a6b3a, glow:false, dot:'#9a6b3a'},
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
    if(heightMap[i][j]>=WORLD.stoneH&&reachable(i,j)&&!usedCells.has(keyOf(i,j)))stoneCand.push([i,j,heightMap[i][j]]);
  stoneCand.sort(()=>Math.random()-0.5);
  const pts=[];
  for(const [i,j,h] of stoneCand){ if(oreNodes.length>=WORLD.oreN)break;
    if(nearAny(i,j,pts,2.3))continue; pts.push([i,j]);
    const type=rollOreType(), mesh=makeOreNode(type);
    mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
    oreNodes.push({x:i-HALF,z:j-HALF,y:h,type,mesh,alive:true,respawnAt:0}); }
  // starter nodes on grass so mining is discoverable early (coal/iron only)
  const sh2=grassCells.slice().sort(()=>Math.random()-0.5);
  for(const [i,j,h] of sh2){ if(oreNodes.length>=WORLD.oreN+4)break;
    if(!decorOK(i,j,3)||nearAny(i,j,treePts,1.6)||nearAny(i,j,pts,4))continue;
    if(Math.hypot(i-spawnCell[0],j-spawnCell[1])<6)continue;
    pts.push([i,j]); decorUsed.add(keyOf(i,j));
    const type=Math.random()<0.6?'coal':'iron', mesh=makeOreNode(type);
    mesh.position.set(i-HALF,h,j-HALF); scene.add(mesh);
    oreNodes.push({x:i-HALF,z:j-HALF,y:h,type,mesh,alive:true,respawnAt:0}); } }
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
// tools held in the right hand (parented to the arm so they swing with it)
const armR=player.userData.armR;
const rodMesh=new THREE.Mesh(new THREE.BoxGeometry(0.07,1.1,0.07),new THREE.MeshLambertMaterial({map:TEX.bark}));
rodMesh.position.set(0,-0.55,0.28); rodMesh.rotation.x=-0.6; rodMesh.castShadow=true; rodMesh.visible=false; armR.add(rodMesh);
const pickMesh=new THREE.Group();
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.7,0.06),new THREE.MeshLambertMaterial({map:TEX.bark}));
  const hd=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.1,0.1),new THREE.MeshLambertMaterial({color:0x9aa1a8}));
  hd.position.y=0.32; pickMesh.add(h2,hd); pickMesh.position.set(0,-0.5,0.14); pickMesh.rotation.x=-0.5;
  pickMesh.visible=false; armR.add(pickMesh); }
const axeMesh=new THREE.Group();
{ const h2=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.65,0.06),new THREE.MeshLambertMaterial({map:TEX.bark}));
  const bl=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.24,0.06),new THREE.MeshLambertMaterial({color:0xb8bfc7}));
  bl.position.set(0.1,0.28,0); axeMesh.add(h2,bl); axeMesh.position.set(0,-0.5,0.14); axeMesh.rotation.x=-0.5;
  axeMesh.visible=false; armR.add(axeMesh); }
const lineGeo=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]);
const fishLine=new THREE.Line(lineGeo,new THREE.LineBasicMaterial({color:0xeeeeee,transparent:true,opacity:0.65}));
fishLine.frustumCulled=false; fishLine.visible=false; scene.add(fishLine);
const rodTip=new THREE.Vector3();
function updateFishLine(){
  fishLine.visible=bobber.visible;
  if(!fishLine.visible)return;
  rodTip.set(0.5,1.75,0.85); player.localToWorld(rodTip);
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
    p.col=cols[(Math.random()*cols.length)|0]; p.grav=o.grav!=null?o.grav:9; } }
function fxUpdate(dt){
  for(let k=0;k<FXN;k++){ const p=fxP[k];
    if(p.life>0){ p.life-=dt; p.vy-=p.grav*dt; p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;
      const s=Math.max(0.0001,p.s*Math.max(0,p.life/p.ttl));
      dummy.position.set(p.x,p.y,p.z); dummy.scale.set(s,s,s); dummy.rotation.set(p.life*7,p.life*9,0); }
    else { dummy.position.set(0,-99,0); dummy.scale.set(0.0001,0.0001,0.0001); dummy.rotation.set(0,0,0); }
    dummy.updateMatrix(); fxMesh.setMatrixAt(k,dummy.matrix); fxMesh.setColorAt(k,fxCol.setHex(p.col)); }
  fxMesh.instanceMatrix.needsUpdate=true; if(fxMesh.instanceColor)fxMesh.instanceColor.needsUpdate=true; }
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
  // let Space/Enter activate focused buttons instead of hijacking them
  const tag=e.target&&e.target.tagName;
  const onUI=tag==='BUTTON'||tag==='INPUT'||(e.target&&e.target.closest&&e.target.closest('[role="button"]'));
  if(onUI&&(e.code==='Space'||e.code==='Enter'))return;
  const m=KMAP[e.code]; if(m){e.preventDefault(); if(!keys[m]&&m==='act')actEdge=true; keys[m]=true;}
  if(e.code==='KeyI'||e.code==='Tab'){ e.preventDefault(); if(invOpen)closeInv(); else if(running)openInv(); }
  if(e.code==='Escape'){ if(marketOpen)closeMarket(); else if(casinoOpen)closeCasino(); else if(invOpen)closeInv(); else if(fishing.state!=='idle')cancelFish(); else if(mining.node)cancelMine(); else if(chopping.tree)cancelChop(); else if(digging.active){digging.active=false;hint('');} }},{passive:false});
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
  spin:(f)=>beep(f||120,.05,'square',.02),win:()=>{[523,659,784,1046].forEach((f,i)=>setTimeout(()=>beep(f,.16,'triangle',.06),i*90));},
  lose:()=>{beep(200,.3,'sawtooth',.07);setTimeout(()=>beep(130,.4,'sawtooth',.07),160);},
  pick:()=>beep(340+Math.random()*120,.05,'square',.04),
  ore:()=>{beep(620,.09,'triangle',.06);setTimeout(()=>beep(930,.12,'triangle',.06),80);}};
document.getElementById('mute').onclick=()=>{muted=!muted;const b=document.getElementById('mute');b.textContent=muted?'♪ MUTED':'♪ SOUND';b.style.color=muted?'var(--faint)':'';};

const RAR={common:'#b9c6c4',uncommon:'#74e08a',rare:'#57b7ff',epic:'#c07bff',legendary:'#ffc24b'};
const H={bn:document.querySelector('#hud-bucket .n'),bucket:document.getElementById('hud-bucket'),coins:document.getElementById('coinVal'),
  area:document.getElementById('area'),hint:document.getElementById('hint'),
  oreW:document.getElementById('oreW'),oreC:document.getElementById('oreC'),oreI:document.getElementById('oreI'),oreG:document.getElementById('oreG'),oreD:document.getElementById('oreD')};
const fmt=n=>Math.round(n).toLocaleString('en-US');
function updateHUD(){H.bn.textContent=state.bucket.length+'/'+CAP;H.bucket.classList.toggle('full',state.bucket.length>=CAP);H.coins.textContent=fmt(state.coins);
  H.oreW.textContent=state.ores.wood;H.oreC.textContent=state.ores.coal;H.oreI.textContent=state.ores.iron;H.oreG.textContent=state.ores.gold;H.oreD.textContent=state.ores.diamond;
  if(typeof updateHotbar==='function')updateHotbar(); if(invOpen)renderInv();}
let hintCur='';
function hint(h){if(h!==hintCur){hintCur=h;if(h){H.hint.innerHTML=h;H.hint.classList.add('on');}else H.hint.classList.remove('on');}}
const tw=document.getElementById('toasts');
function toast(m,k){const d=document.createElement('div');d.className='toast '+(k||'');d.textContent=m;tw.appendChild(d);setTimeout(()=>d.remove(),2000);}
let areaCur='',areaT=0;
function setArea(name,sub){if(name!==areaCur){areaCur=name;H.area.innerHTML=name+'<small>'+sub+'</small>';H.area.classList.add('on');areaT=3;}}
// ---- 3D catch reveal: a live Three.js voxel fish on the card ----
function fishSVG(rar){const c=RAR[rar];return `<svg width="76" height="46" viewBox="0 0 76 46"><g fill="${c}"><ellipse cx="34" cy="23" rx="24" ry="13"/><polygon points="8,23 -2,12 -2,34"/></g><circle cx="46" cy="20" r="2.4" fill="#0e1a20"/><path d="M50 16 q8 7 0 14" stroke="${c}" stroke-width="2" fill="none"/></svg>`;} // fallback when the reveal WebGL context can't start
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
  const name=(f.name||'').replace('✨ ',''),low=name.toLowerCase(),is=s=>low.includes(s);
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
  if(is('glow')||is('moon')||is('midnight')||is('star')||is('thunder')){ // bioluminescent flank dots
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
function reveal(f){ const glow=f.shiny?'#ffd24f':RAR[f.rar];
  revEl.innerHTML=`<div class="reveal-card" style="border-color:${glow};box-shadow:0 20px 60px rgba(0,0,0,.6),0 0 30px ${glow}55"><div class="r" style="color:${RAR[f.rar]}">${f.shiny?'✨ shiny ':''}${f.rar}</div><div class="f3d">${fishRenderer?'':fishSVG(f.rar)}</div><div class="nm">${f.name}</div><div class="v">◈ ${fmt(f.val)} · ${f.kg||'?'} kg</div></div>`;
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
  if(state.treasure){ const tx=(state.treasure.i)/N*W, ty=(state.treasure.j)/N*W;
    mmX.strokeStyle='#ffd24f'; mmX.lineWidth=2.4; mmX.beginPath();
    mmX.moveTo(tx-4,ty-4); mmX.lineTo(tx+4,ty+4); mmX.moveTo(tx+4,ty-4); mmX.lineTo(tx-4,ty+4); mmX.stroke(); }
  dot(pWorld.x,pWorld.z,'#ffffff',4,true);
  mmX.restore(); }

/* ========================================================================
   9. STATE + FISH + UPGRADES
   ======================================================================== */
const SAVE='reelfortune3d-v1', CAP=12, MAXLVL=10;
const state={coins:0,bucket:[],ores:{wood:0,coal:0,iron:0,gold:0,diamond:0},rodLvl:1,pickLvl:1,
  dex:{},treasure:null,worlds:['isle'],
  stats:{caught:0,mined:0,earned:0,bestWin:0,spins:0,winsCt:0,losses:0}};
function save(){try{localStorage.setItem(SAVE,JSON.stringify(state));}catch(e){}}
function load(){try{const r=localStorage.getItem(SAVE);if(r){const s=JSON.parse(r);
  state.coins=s.coins||0;state.bucket=Array.isArray(s.bucket)?s.bucket:[];
  if(s.ores)for(const k in state.ores)state.ores[k]=s.ores[k]|0;
  if(s.stats)for(const k in state.stats)state.stats[k]=+s.stats[k]||0;
  if(s.dex&&typeof s.dex==='object')state.dex=s.dex;
  if(s.treasure&&s.treasure.i!=null)state.treasure=s.treasure;
  if(Array.isArray(s.worlds)&&s.worlds.length)state.worlds=s.worlds;
  state.rodLvl=clamp(s.rodLvl|0||1,1,MAXLVL);state.pickLvl=clamp(s.pickLvl|0||1,1,MAXLVL);}}catch(e){}}
load();
function F(name,rar,val){return {name,rar,val};}
// time-of-day + weather globals (driven by the sky system in animate)
let dayT=0.3, wState='clear';
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
function condOK(c){ if(!c)return true; if(c==='night')return isNight();
  if(c==='rain')return wState==='rain'||wState==='storm'; if(c==='storm')return wState==='storm'; return true; }
const RORDER={common:0,uncommon:1,rare:2,epic:3,legendary:4};
function fishPool(){ return (typeof WORLD!=='undefined'&&WORLD.fish?WORLD.fish:TABLE).filter(e=>condOK(e[2])); }
function rollOnce(){ const pool=fishPool(); let tot=0; for(const e of pool)tot+=e[1]; let r=Math.random()*tot;
  for(const e of pool){ r-=e[1]; if(r<=0){ const t=e[0];
    const val=Math.round(t.val*(typeof WORLD!=='undefined'?WORLD.fishMul||1:1)*rand(0.85,1.18));
    return {uid:(Date.now()+Math.random()).toString(36),name:t.name,rar:t.rar,val,
      kg:+(t.val/9*rand(0.5,1.6)+0.2).toFixed(1),wins:0}; } }
  return null; }
function rollFish(){ let f=rollOnce();
  const rr=Math.min(state.rodLvl-1,9);
  for(let k=0;k<rr;k++){ if(Math.random()<0.3){ const g=rollOnce(); if(RORDER[g.rar]>RORDER[f.rar])f=g; } }
  if((wState==='rain'||wState==='storm')&&Math.random()<0.12){ const g=rollOnce(); if(RORDER[g.rar]>RORDER[f.rar])f=g; }
  if(Math.random()<0.018){ f.shiny=true; f.val*=5; f.name='✨ '+f.name; } // shiny mutation
  return f; }
function biteTime(){ const wet=(wState==='rain'||wState==='storm')?0.65:1;
  return rand(1.1,3.2)*Math.max(0.35,1-0.06*(state.rodLvl-1))*wet; }
function onCatch(fish){ state.stats.caught++; state.bucket.push(fish);
  const dexName=fish.shiny?fish.name.replace('✨ ',''):fish.name;
  const d=state.dex[dexName]||(state.dex[dexName]={n:0,best:0});
  d.n++; const isNew=d.n===1;
  if(fish.kg>d.best){ d.best=fish.kg; if(!isNew)toast(`📏 Record ${dexName}: ${fish.kg} kg!`,'good'); }
  if(isNew){ toast(`✨ NEW SPECIES: ${dexName}`,'gold'); addShake(0.1); }
  if(fish.shiny){ toast('✨ SHINY! Worth 5× more','gold'); addShake(0.18); addFreeze(0.1); }
  // rare chance the catch also snags a bottled treasure map
  if(!state.treasure&&Math.random()<0.08){ const cand=landCells.filter(c=>reachable(c[0],c[1])&&Math.hypot(c[0]-spawnCell[0],c[1]-spawnCell[1])>14);
    if(cand.length){ const c=cand[(Math.random()*cand.length)|0]; state.treasure={i:c[0],j:c[1]};
      toast('🗺️ A bottle! X marks the spot on your map','gold'); } }
  sfx.catch(); reveal(fish); }
// rotating market demand: every 3 min one category is HOT (x1.6), one SURPLUS (x0.75)
const MKT_CATS=['fish','wood','coal','iron','gold','diamond'];
const MKT_MS=180000;
function mktMods(){ const e=Math.floor(Date.now()/MKT_MS);
  const hi=Math.floor(hash(e,7)*MKT_CATS.length)%MKT_CATS.length;
  let lo=Math.floor(hash(e,13)*(MKT_CATS.length-1))%(MKT_CATS.length-1); if(lo>=hi)lo++;
  return {hot:MKT_CATS[hi],cold:MKT_CATS[lo]}; }
function priceMult(cat){ const m=mktMods(); return cat===m.hot?1.6:cat===m.cold?0.75:1; }
const catLabel=c=>c==='fish'?'Fish':ORE_INFO[c].name;
const ROD_BASE=250, PICK_BASE=200;
const upCost=(base,lvl)=>Math.round(base*Math.pow(1.75,lvl-1)); // cost lvl -> lvl+1
const ROD_NAMES=['','Old Rod','Birch Rod','Lucky Rod','Fiber Rod','Golden Rod','Prism Rod','Storm Rod','Mythic Rod','Abyss Rod','Poseidon Rod'];
const PICK_NAMES=['','Rusty Pick','Stone Pick','Iron Pick','Steel Pick','Golden Pick','Crystal Pick','Obsidian Pick','Mythril Pick','Dragon Pick','Titan Pick'];
// ore ingredients to craft the next tier (indexed by TARGET level) — mining feeds progression
const UP_REQ=[null,null,{wood:5},{wood:8,coal:4},{iron:4},{iron:8},{gold:3},{gold:6},{diamond:2},{diamond:4},{diamond:7}];
function haveOres(req){ for(const k in req)if(state.ores[k]<req[k])return false; return true; }
function reqLabel(req){ return Object.keys(req).map(k=>`${req[k]} ${ORE_INFO[k].name}`).join(' + '); }

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
  const row=(kind,lvl,base,names)=>{ const nxt=lvl+1, cost=upCost(base,lvl), req=UP_REQ[nxt];
    if(lvl>=MAXLVL)return `<div class="fishrow"><span class="nm">${kind==='rod'?'🎣':'⛏️'} ${names[lvl]} <span style="color:var(--teal)">Lv.${lvl}</span></span><span class="rr" style="color:var(--gold)">MAX</span></div>`;
    const can=state.coins>=cost&&haveOres(req);
    return `<div class="fishrow"><span class="nm">${kind==='rod'?'🎣':'⛏️'} ${names[lvl]} <span style="color:var(--teal)">Lv.${lvl}</span>
        <span style="color:var(--faint);font-size:11px">→ ${names[nxt]} · needs ${reqLabel(req)}</span></span>
      <span class="vv">◈ ${fmt(cost)}</span><button class="btn gold" data-buy="${kind}" ${can?'':'disabled'}>Craft</button></div>`; };
  upgList.innerHTML=row('rod',state.rodLvl,ROD_BASE,ROD_NAMES)+row('pick',state.pickLvl,PICK_BASE,PICK_NAMES)+renderWorldRows(); }
function renderWorldRows(){
  let h='<div class="seclab" style="margin-top:14px">⛵ Harbor — sail to another island</div>';
  for(const k of WORLD_ORDER){ const w=WORLDS[k];
    if(k===worldKey){ h+=`<div class="fishrow"><span class="nm">🏝️ ${w.name} <span style="color:var(--faint)">${w.sub}</span></span><span class="rr" style="color:var(--teal)">YOU ARE HERE</span></div>`; }
    else if(state.worlds.includes(k)){ h+=`<div class="fishrow"><span class="nm">🏝️ ${w.name} <span style="color:var(--faint)">${w.sub}</span></span><button class="btn" data-world="${k}">SAIL</button></div>`; }
    else { h+=`<div class="fishrow"><span class="nm">🔒 ${w.name} <span style="color:var(--faint)">${w.sub}</span></span><span class="vv">◈ ${fmt(w.cost)}</span><button class="btn gold" data-world="${k}" ${state.coins<w.cost?'disabled':''}>Unlock</button></div>`; } }
  return h; }
function buyOrSail(k){ const w=WORLDS[k]; if(!w||k===worldKey)return;
  if(!state.worlds.includes(k)){ if(state.coins<w.cost)return;
    state.coins-=w.cost; state.worlds.push(k); sfx.win(); addShake(0.1);
    toast('🗺️ '+w.name+' unlocked!','gold'); updateHUD(); renderUpg(); save(); return; }
  save(); try{localStorage.setItem('reelfortune3d-world',k);}catch(e){}
  toast('⛵ Sailing to '+w.name+'…','good');
  setTimeout(()=>location.reload(),600); }
function openMarket(){marketOpen=true;marketEl.classList.add('on');renderBanner();renderMarket();renderOres();renderUpg();}
function closeMarket(){marketOpen=false;marketEl.classList.remove('on');save();}
document.getElementById('marketX').onclick=closeMarket;
document.getElementById('sellAll').onclick=()=>{ if(!state.bucket.length){toast('Bucket empty');return;}
  let g=0,kept=0; const pm=priceMult('fish');
  state.bucket=state.bucket.filter(f=>{ if(f.wins>0){kept++;return true;} g+=Math.round(f.val*pm); return false; });
  if(!g){toast(kept?'Only ★ starred fish left — sell them one by one':'Bucket empty');return;}
  state.coins+=g;state.stats.earned+=g;coinFly(g);sfx.sell();
  toast('+'+fmt(g)+' coins'+(kept?` (kept ${kept} ★)`:''),'gold');updateHUD();renderMarket();renderUpg();save();};
marketEl.addEventListener('click',e=>{
  const t1=e.target.closest?e.target.closest('[data-sellone]'):null;
  if(t1){const i=+t1.getAttribute('data-sellone'),f=state.bucket[i];
    if(f){const g=Math.round(f.val*priceMult('fish'));state.coins+=g;state.stats.earned+=g;state.bucket.splice(i,1);sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderMarket();renderUpg();save();} return;}
  const t2=e.target.closest?e.target.closest('[data-sellore]'):null;
  if(t2){const k=t2.getAttribute('data-sellore'),n=state.ores[k];
    if(n>0){const g=Math.round(n*ORE_INFO[k].price*priceMult(k));state.coins+=g;state.stats.earned+=g;state.ores[k]=0;sfx.sell();toast('+'+fmt(g)+' coins','gold');updateHUD();renderOres();renderUpg();save();} return;}
  const t3=e.target.closest?e.target.closest('[data-buy]'):null;
  if(t3){const kind=t3.getAttribute('data-buy');
    const doCraft=(lvlKey,base,names)=>{ const lvl=state[lvlKey]; if(lvl>=MAXLVL)return;
      const cost=upCost(base,lvl),req=UP_REQ[lvl+1];
      if(state.coins<cost||!haveOres(req))return;
      state.coins-=cost; for(const k in req)state.ores[k]-=req[k];
      state[lvlKey]=lvl+1; sfx.ore(); addShake(0.1); toast('⚒️ '+names[lvl+1]+' crafted!','gold'); };
    if(kind==='rod')doCraft('rodLvl',ROD_BASE,ROD_NAMES);
    else if(kind==='pick')doCraft('pickLvl',PICK_BASE,PICK_NAMES);
    updateHUD();renderOres();renderUpg();save(); return;}
  const t4=e.target.closest?e.target.closest('[data-world]'):null;
  if(t4){buyOrSail(t4.getAttribute('data-world'));} });

/* ========================================================================
   11. CASINO ROULETTE — bets & spins on the real table out in the world
   (the wheel, ball and table live at the casino landmark, section 6)
   ======================================================================== */
let casinoOpen=false,stakeIdx=-1,betColor=null,spinning=false;
const casinoEl=document.getElementById('casino'),stakeListEl=document.getElementById('stakeList'),
  spinBtn=document.getElementById('spinBtn'),spinResult=document.getElementById('spinResult');
function renderStakes(){ if(!state.bucket.length){stakeListEl.innerHTML='<div class="empty" style="padding:8px">No fish to stake — go fishing first.</div>';return;}
  let h=''; state.bucket.forEach((f,i)=>{h+=`<div class="stake${i===stakeIdx?' sel':''}" data-stake="${i}"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
    <span class="nm">${f.name}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</span><span class="vv">◈ ${fmt(f.val)}</span></div>`;});
  stakeListEl.innerHTML=h; }
function updateSpinBtn(){spinBtn.disabled=!(stakeIdx>=0&&betColor&&!spinning&&state.bucket[stakeIdx]);}
function openCasino(){casinoOpen=true;viewMode='casino';casinoEl.classList.add('on');stakeIdx=-1;betColor=null;spinning=false;spinResult.innerHTML='';
  document.querySelectorAll('.betbtn').forEach(b=>b.classList.remove('sel'));renderStakes();updateSpinBtn();}
function closeCasino(){casinoOpen=false;viewMode='follow';spinSeq++;spinAnim=null;spinning=false;casinoEl.classList.remove('on');save();}
document.getElementById('casinoX').onclick=closeCasino;
stakeListEl.addEventListener('click',e=>{if(spinning)return;const t=e.target.closest('[data-stake]');if(t){stakeIdx=+t.getAttribute('data-stake');renderStakes();updateSpinBtn();}});
document.querySelectorAll('.betbtn').forEach(b=>{const pick=()=>{if(spinning)return;betColor=b.getAttribute('data-bet');
  document.querySelectorAll('.betbtn').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');updateSpinBtn();};
  b.onclick=pick;b.onkeydown=e=>{if(e.code==='Enter'||e.code==='Space'){e.preventDefault();pick();}};});
let spinSeq=0,spinAnim=null;
spinBtn.onclick=()=>{ if(spinBtn.disabled)return; const fish=state.bucket[stakeIdx]; if(!fish)return;
  spinning=true;updateSpinBtn();spinResult.innerHTML='<span style="color:var(--muted)">No more bets — the ball is rolling…</span>';
  const winIdx=Math.floor(Math.random()*NSEG);
  const th0=wheelAngle, th1=th0-(4+Math.random()*2)*TAU;   // wheel spins one way…
  const bTarget=-(winIdx*SEGA+SEGA/2)-th1;                 // …ball must come to rest on the winning pocket
  let base=(ballA-bTarget)%TAU; if(base<0)base+=TAU;
  spinAnim={seq:++spinSeq,t:0,dur:4.4,th0,th1,b0:ballA,bTot:base+6*TAU,winIdx,fish,bet:betColor,lastPocket:-1}; };
function updateRoulette(dt){ // every frame from the main loop — the table is part of the world
  if(spinAnim){
    if(spinAnim.seq!==spinSeq||!casinoOpen) spinAnim=null; // spin cancelled (ESC/close) — fish untouched
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
      if(p>=1){ const sa=spinAnim; spinAnim=null; ballLockIdx=sa.winIdx; resolveSpin(sa.winIdx,sa.fish,sa.bet); } } }
  if(!spinAnim){ wheelAngle-=dt*(casinoOpen?0.4:0.7); setBallPocket(ballLockIdx); } // idle attract spin
  wheelDisc.rotation.y=wheelAngle; }
const ballWP=new THREE.Vector3();
function resolveSpin(idx,fish,myBet){ const color=SEG[idx],won=(color===myBet);
  state.stats.spins++;
  ball.getWorldPosition(ballWP);
  if(won){ const mult=(color==='green')?14:2,before=fish.val; fish.val=Math.round(fish.val*mult); fish.wins++;
    state.stats.winsCt++; state.stats.bestWin=Math.max(state.stats.bestWin,fish.val);
    addShake(color==='green'?0.45:0.25); if(color==='green')addFreeze(0.15);
    fxBurst(ballWP.x,ballWP.y+0.2,ballWP.z,{n:color==='green'?34:16,cols:[0xffd24f,0xffefb0,0x74e08a],speed:2.6,up:3.6,size:1.1,grav:7});
    spinResult.innerHTML=`<span class="win">▲ ${color.toUpperCase()} — WON! ${fish.name} ◈${fmt(before)} → <b>◈${fmt(fish.val)}</b>. Spin again or cash out.</span>`;
    sfx.win();toast(`${fish.name} doubled → ◈${fmt(fish.val)}`,'gold'); }
  else { state.stats.losses++; addShake(0.2); const lost=fish.name,li=state.bucket.indexOf(fish); if(li>=0)state.bucket.splice(li,1); stakeIdx=-1;
    fxBurst(ballWP.x,ballWP.y+0.15,ballWP.z,{n:14,cols:[0xff5d7a,0x8a2033,0x242a30],speed:2.2,up:2.6,size:1,grav:8});
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
    if(f.cast>=1){f.state='wait';f.biteAt=biteTime();f.t=0;
      fxBurst(f.tx,WATER_TOP+0.15,f.tz,{n:8,cols:[0x7fdcff,0xd9f6ff,0xffffff],speed:1.8,up:2.6,size:0.9,grav:7});} }
  else if(f.state==='wait'){ f.t+=dt; bobber.position.y=WATER_TOP+0.1+Math.sin(clock*3)*0.05; hint('Waiting for a bite… <span class="key">ESC</span> reel in');
    if(f.t>=f.biteAt){f.state='bite';f.t=0;sfx.bite();
      fxBurst(bobber.position.x,WATER_TOP+0.15,bobber.position.z,{n:6,cols:[0x7fdcff,0xffffff],speed:1.6,up:2.2,size:0.8,grav:7});} }
  else if(f.state==='bite'){ f.t+=dt; bobber.position.y=WATER_TOP+0.05+Math.sin(clock*22)*0.14; hint('❗ <b>BITE!</b> press <span class="key">E</span> now!');
    if(actEdge){f.state='reel';f.reel=0;f.reelT=0;} else if(f.t>0.85){cancelFish();sfx.miss();toast('It got away…');} }
  else if(f.state==='reel'){ f.reelT+=dt; if(keys.act){f.reel+=dt*0.75;if(Math.random()<0.08)sfx.reel();} else f.reel-=dt*0.28; f.reel=clamp(f.reel,0,1);
    bobber.position.y=WATER_TOP+0.1+f.reel*0.3; hint('Reel it in! hold <span class="key">E</span>');
    if(f.reel>=1){ const fish=rollFish(); f.state='idle';
      fxBurst(bobber.position.x,WATER_TOP+0.2,bobber.position.z,{n:16,cols:[0x7fdcff,0xd9f6ff,0xffffff],speed:2.6,up:4,size:1.1,grav:7});
      addShake(fish.rar==='legendary'||fish.rar==='epic'?0.25:0.1);
      if(fish.rar==='legendary')addFreeze(0.14);
      bobber.visible=false;
      if(state.bucket.length<CAP){onCatch(fish);updateHUD();save();} else toast('Bucket full — sell some fish!'); }
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
  mining.dur=1.7/(1+(state.pickLvl-1)*0.22); }
function updateMining(dt){ const n=mining.node;
  if(!n||!n.alive){cancelMine();return;}
  if(keys.up||keys.down||keys.left||keys.right){cancelMine();return;}
  if(keys.act){ mining.t+=dt;
    if(Math.random()<0.12){ sfx.pick(); addShake(0.05);
      fxBurst(n.x,n.y+0.7,n.z,{n:4,cols:[0x9aa1a8,0x747c84,0xb8bfc7],speed:2.2,up:2.4,size:0.8}); }
    n.mesh.scale.setScalar(1+Math.sin(clock*30)*0.03); }
  else { mining.t-=dt*0.6; if(mining.t<=0){ n.mesh.scale.setScalar(1); cancelMine(); return; } }
  mining.t=clamp(mining.t,0,mining.dur);
  const p=mining.t/mining.dur,k=Math.floor(p*8);
  hint(`⛏ Mining ${ORE_INFO[n.type].name}… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  if(mining.t>=mining.dur){ n.mesh.scale.setScalar(1);
    const bonus=Math.random()<Math.min(0.85,0.15+0.08*(state.pickLvl-1))?1:0,
      got=(1+bonus+(state.pickLvl>=6&&Math.random()<0.2?1:0))*(WORLD.oreYield||1);
    state.ores[n.type]+=got; state.stats.mined+=got; sfx.ore();
    addShake(0.22); addFreeze(0.05);
    fxBurst(n.x,n.y+0.6,n.z,{n:18,cols:[ORE_INFO[n.type].color,0x9aa1a8,0x747c84],speed:3.2,up:4.2,size:1.1});
    toast(`+${got} ${ORE_INFO[n.type].name}`,'good');
    n.alive=false; n.mesh.visible=false; n.respawnAt=clock+40+rand(0,25);
    cancelMine(); updateHUD(); save(); } }

/* ========================================================================
   13a. WOODCUTTING — chop trees for wood (they regrow)
   ======================================================================== */
const chopping={tree:null,t:0,dur:1.4};
function nearestTree(){ let bestT=null,bd=1e9;
  for(const t of treeData){ if(t.cd>clock)continue;
    const d=Math.hypot(t.x-pWorld.x,t.z-pWorld.z); if(d<bd){bd=d;bestT=t;} }
  return bestT&&bd<1.9?bestT:null; }
function cancelChop(){chopping.tree=null;hint('');}
function updateChopping(dt){ const t=chopping.tree;
  if(!t||t.cd>clock){cancelChop();return;}
  if(keys.up||keys.down||keys.left||keys.right){cancelChop();return;}
  if(keys.act){ chopping.t+=dt;
    if(Math.random()<0.14){ beep(190+Math.random()*60,0.06,'square',0.05); addShake(0.04);
      fxBurst(t.x,t.y+1.2,t.z,{n:3,cols:[0x9a6b3a,0x7d5530],speed:2,up:2.2,size:0.8}); } }
  else { chopping.t-=dt*0.6; if(chopping.t<=0){cancelChop();return;} }
  chopping.t=clamp(chopping.t,0,chopping.dur);
  const p=chopping.t/chopping.dur,k=Math.floor(p*8);
  hint(`🪓 Chopping… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  if(chopping.t>=chopping.dur){
    const got=1+(Math.random()<0.45?1:0);
    state.ores.wood+=got; state.stats.mined+=got;
    addShake(0.16); sfx.ore();
    const leafCols=t.pink?[0xec9fcb,0xf5b5d9,0x9a6b3a]:[0x3aa626,0x54cb3c,0x9a6b3a];
    fxBurst(t.x,t.y+3,t.z,{n:16,cols:leafCols,speed:2.6,up:1.6,size:1.1,grav:5});
    toast(`+${got} Wood`,'good');
    t.cd=clock+60+rand(0,30);
    cancelChop(); updateHUD(); save(); } }

/* ========================================================================
   13b. TREASURE DIGGING
   ======================================================================== */
const digging={active:false,t:0,dur:1.5};
function treasureDist(){ if(!state.treasure)return 1e9;
  return Math.hypot(state.treasure.i-HALF-pWorld.x,state.treasure.j-HALF-pWorld.z); }
function updateDigging(dt){
  if(!state.treasure){digging.active=false;hint('');return;}
  if(keys.up||keys.down||keys.left||keys.right){digging.active=false;hint('');return;}
  if(keys.act)digging.t+=dt; else { digging.t-=dt*0.6; if(digging.t<=0){digging.active=false;hint('');return;} }
  digging.t=clamp(digging.t,0,digging.dur);
  const p=digging.t/digging.dur,k=Math.floor(p*8);
  hint(`🗺️ Digging… <b>${'▰'.repeat(k)+'▱'.repeat(8-k)}</b> hold <span class="key">E</span>`);
  if(Math.random()<0.1){ sfx.pick(); fxBurst(pWorld.x,pWorld.y+0.3,pWorld.z,{n:3,cols:[0x8a5a34,0x9a683e],speed:2,up:2.4,size:0.8}); }
  if(digging.t>=digging.dur){ digging.active=false; state.treasure=null;
    addShake(0.25); addFreeze(0.08);
    fxBurst(pWorld.x,pWorld.y+0.5,pWorld.z,{n:20,cols:[0xffd24f,0xffefb0,0x8a5a34],speed:3.4,up:4.5,size:1.1});
    const r=Math.random();
    if(r<0.55){ const g=Math.round(rand(150,600)*(1+0.12*(state.rodLvl+state.pickLvl)));
      state.coins+=g; state.stats.earned+=g; coinFly(g); sfx.win(); toast('💰 Buried treasure! +'+fmt(g)+' coins','gold'); }
    else if(r<0.85){ const ks=['iron','gold','gold','diamond'],k2=ks[(Math.random()*ks.length)|0],n2=2+((Math.random()*4)|0);
      state.ores[k2]+=n2; state.stats.mined+=n2; sfx.ore(); toast(`⛏️ Treasure! +${n2} ${ORE_INFO[k2].name}`,'gold'); }
    else if(state.bucket.length<CAP){ let f=null; for(let k3=0;k3<25;k3++){ f=rollOnce(); if(RORDER[f.rar]>=2)break; }
      onCatch(f); toast('🐟 A rare fish was buried here?!','gold'); }
    else { const g=300; state.coins+=g; state.stats.earned+=g; coinFly(g); toast('💰 +'+fmt(g)+' coins','gold'); }
    hint(''); updateHUD(); save(); } }

/* ========================================================================
   14. INVENTORY + HOTBAR
   ======================================================================== */
let invOpen=false;
const invEl=document.getElementById('inv'),invTools=document.getElementById('invTools'),
  invFish=document.getElementById('invFish'),invOres=document.getElementById('invOres'),
  invStats=document.getElementById('invStats'),invDex=document.getElementById('invDex');
const HB={rod:document.getElementById('hbRod'),pick:document.getElementById('hbPick'),
  bucket:document.getElementById('hbBucket'),pouch:document.getElementById('hbPouch')};
function updateHotbar(){ HB.rod.textContent='Lv'+state.rodLvl; HB.pick.textContent='Lv'+state.pickLvl;
  HB.bucket.textContent=state.bucket.length+'/'+CAP;
  HB.pouch.textContent=state.ores.wood+state.ores.coal+state.ores.iron+state.ores.gold+state.ores.diamond; }
function renderInv(){
  const rodNext=state.rodLvl<MAXLVL?`next ◈${fmt(upCost(ROD_BASE,state.rodLvl))} + ${reqLabel(UP_REQ[state.rodLvl+1])}`:'MAX';
  const pickNext=state.pickLvl<MAXLVL?`next ◈${fmt(upCost(PICK_BASE,state.pickLvl))} + ${reqLabel(UP_REQ[state.pickLvl+1])}`:'MAX';
  invTools.innerHTML=
    `<div class="fishrow"><span class="nm">🎣 ${ROD_NAMES[state.rodLvl]} <span style="color:var(--teal)">Lv.${state.rodLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${rodNext}</span></div>
    <div class="fishrow"><span class="nm">⛏️ ${PICK_NAMES[state.pickLvl]} <span style="color:var(--teal)">Lv.${state.pickLvl}</span></span>
      <span class="rr" style="color:var(--muted)">${pickNext}</span></div>`;
  if(!state.bucket.length)invFish.innerHTML='<div class="empty">Bucket empty — go fishing!</div>';
  else{ let h='<div class="invgrid">';
    state.bucket.forEach(f=>{h+=`<div class="invcard" style="border-color:${RAR[f.rar]}55"><span class="dot" style="background:${RAR[f.rar]};color:${RAR[f.rar]}"></span>
      <div class="inm">${f.name}<span style="color:var(--faint);font-size:10px"> ${f.kg||'?'} kg</span></div><div class="ivv">◈ ${fmt(f.val)}${f.wins?` <span style="color:var(--rose)">★${f.wins}</span>`:''}</div></div>`;});
    invFish.innerHTML=h+'</div>'; }
  // Fishdex — every species across conditions, ??? until first caught
  { const seen=Object.keys(state.dex).length, total=TABLE.length;
    let h=`<div class="seclab" style="margin-top:2px">Fishdex · ${seen}/${total}</div><div class="invgrid">`;
    for(const e of TABLE){ const t=e[0],d=state.dex[t.name];
      if(d) h+=`<div class="invcard" style="border-color:${RAR[t.rar]}55"><span class="dot" style="background:${RAR[t.rar]};color:${RAR[t.rar]}"></span>
        <div class="inm">${t.name}${e[2]?` <span style="color:var(--faint);font-size:9px">${e[2]==='night'?'🌙':e[2]==='storm'?'⛈':'🌧'}</span>`:''}<span style="color:var(--faint);font-size:10px"> ×${d.n}</span></div>
        <div class="ivv" style="color:var(--teal)">${d.best} kg</div></div>`;
      else h+=`<div class="invcard" style="opacity:.45"><span class="dot" style="background:#3a4a50"></span>
        <div class="inm" style="color:var(--faint)">???${e[2]?` <span style="font-size:9px">${e[2]==='night'?'🌙':e[2]==='storm'?'⛈':'🌧'}</span>`:''}</div><div class="ivv" style="color:var(--faint)">—</div></div>`; }
    invDex.innerHTML=h+'</div>'; }
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
   14b. SKY — day/night cycle + weather (rain, storm)
   ======================================================================== */
const DAY_LEN=420; // seconds per full day
const DAYKEYS=[
  [0.00,0x101c38,0.10,0.28],[0.06,0x101c38,0.10,0.28],[0.12,0xf7906a,0.34,0.45],
  [0.20,WORLD.sky,0.55,0.62],[0.60,WORLD.sky,0.55,0.62],[0.68,0xf7906a,0.32,0.45],
  [0.76,0x101c38,0.10,0.28],[1.00,0x101c38,0.10,0.28]];
const cA=new THREE.Color(),cB=new THREE.Color(),cRain=new THREE.Color(0x6b7f8a);
let wTimer=rand(60,140),flashT=0;
function skyUpdate(dt){
  dayT=(dayT+dt/DAY_LEN)%1;
  let seg=null;
  for(let k=0;k<DAYKEYS.length-1;k++){ if(dayT>=DAYKEYS[k][0]&&dayT<=DAYKEYS[k+1][0]){seg=[DAYKEYS[k],DAYKEYS[k+1]];break;} }
  if(!seg)seg=[DAYKEYS[0],DAYKEYS[1]];
  const u=(dayT-seg[0][0])/Math.max(1e-6,seg[1][0]-seg[0][0]);
  cA.setHex(seg[0][1]); cB.setHex(seg[1][1]); cA.lerp(cB,u);
  let sunI=lerp(seg[0][2],seg[1][2],u), hemiI=lerp(seg[0][3],seg[1][3],u);
  const wet=wState==='rain'||wState==='storm';
  if(wet){ cA.lerp(cRain,0.45); sunI*=0.55; }
  if(flashT>0){ flashT-=dt; sunI+=1.0; cA.lerp(cB.setHex(0xffffff),0.25); }
  scene.background.copy(cA); scene.fog.color.copy(cA);
  sun.intensity=sunI; hemiL.intensity=hemiI;
  // weather state machine
  wTimer-=dt;
  if(wTimer<=0){ const r=Math.random(), prev=wState;
    wState=r<0.55?'clear':r<0.88?'rain':'storm'; wTimer=rand(70,160);
    if(running&&wState!==prev){ if(wState==='rain')toast('🌧 Rain — fish bite faster!','good');
      else if(wState==='storm')toast('⛈ STORM — rare fish stir…','gold');
      else toast('☀️ Skies clear'); } }
  if(wState==='storm'&&Math.random()<dt*0.22){ flashT=0.12;
    setTimeout(()=>beep(58,0.4,'sawtooth',0.07),rand(150,500)); }
  rainMesh.visible=wet;
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
// HUD time/weather chip
const timeIco=document.getElementById('timeIco'),wIco=document.getElementById('wIco');
let chipT=0;
function chipUpdate(){ if(!timeIco)return;
  timeIco.textContent=isNight()?'🌙':(dayT>0.6&&dayT<0.76)||(dayT>0.06&&dayT<0.2)?'🌆':'☀️';
  wIco.textContent=wState==='storm'?'⛈':wState==='rain'?'🌧':''; }

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
let tree=null;
function interactions(){
  const dT=Math.hypot(pWorld.x-TRADER_POS.x,pWorld.z-TRADER_POS.z), dC=Math.hypot(pWorld.x-CASINO_POS.x,pWorld.z-CASINO_POS.z);
  const ore=nearestOre();
  const w=nearestWater(), canFish=w&&w.dist<2.4;
  if(dT<2.6){ hint('<span class="key">E</span> Trade at the Market'); if(actEdge){initAudio();openMarket();} }
  else if(dC<2.8){ hint('<span class="key">E</span> Enter the Spinning Eel'); if(actEdge){initAudio();openCasino();} }
  else if(treasureDist()<1.8){ hint('🗺️ <span class="key">E</span> Dig here!'); if(actEdge){initAudio();digging.active=true;digging.t=0;} }
  else if(ore){ hint(`<span class="key">E</span> Mine ${ORE_INFO[ore.type].name}`); if(actEdge)startMine(ore); }
  else if((tree=nearestTree())){ hint('🪓 <span class="key">E</span> Chop wood'); if(actEdge){initAudio();chopping.tree=tree;chopping.t=0;} }
  else if(canFish){ if(state.bucket.length>=CAP)hint('Bucket full — sell at the Trader'); else { hint('<span class="key">E</span> Cast your line'); if(actEdge)startCast(w); } }
  else hint('');
}
let lastBiome='',bannerT=0,mktEpochSeen=Math.floor(Date.now()/MKT_MS);
function biomeCheck(){ const t=cellType(heightAt(pWorld.x,pWorld.z));
  if(t!==lastBiome){ lastBiome=t;
    if(t==='stone')setArea('The Quarry','hold E on ore to mine');
    else if(t==='sand')setArea('Shoreline','cast your line'); } }
function animate(now){
  let dt=Math.min(0.033,(now-last)/1000||0); last=now;
  if(freezeT>0){freezeT-=dt;dt*=0.08;} // hit-stop: world slows for a beat
  clock+=dt;
  if(running){
    const overlay=marketOpen||casinoOpen||invOpen;
    if(!overlay){ if(fishing.state!=='idle')updateFishing(dt); else if(mining.node)updateMining(dt); else if(chopping.tree)updateChopping(dt); else if(digging.active)updateDigging(dt); else { tryMove(dt); interactions(); } } else hint('');

    const targetY=heightAt(pWorld.x,pWorld.z);
    pWorld.y=lerp(pWorld.y,targetY,0.35);
    player.rotation.y=lerpAngle(player.rotation.y,pWorld.face,0.2);
    const moving=(keys.up||keys.down||keys.left||keys.right)&&fishing.state==='idle'&&!overlay&&!mining.node&&!chopping.tree;
    const sw=moving?Math.sin(pWorld.step)*0.5:0, pd=player.userData;
    if(pd.legL){pd.legL.rotation.x=sw;pd.legR.rotation.x=-sw;pd.armL.rotation.x=-sw*0.7;pd.armR.rotation.x=sw*0.7;}
    // activity animations: the right arm acts, tools appear in hand
    const act=fishing.state!=='idle'?'fish':mining.node?'mine':chopping.tree?'chop':digging.active?'dig':'';
    if(act==='fish'){ const f=fishing;
      if(f.state==='cast')pd.armR.rotation.x=-2.4+f.cast*1.55;
      else if(f.state==='reel')pd.armR.rotation.x=-0.7+(keys.act?Math.sin(clock*12)*0.3:0.05);
      else if(f.state==='bite')pd.armR.rotation.x=-0.85+Math.sin(clock*22)*0.12;
      else pd.armR.rotation.x=-0.85+Math.sin(clock*2)*0.05; }
    else if(act==='mine'||act==='chop'||act==='dig'){
      pd.armR.rotation.x=-1.15+Math.sin(clock*13)*(keys.act?0.9:0.15); }
    rodMesh.visible=(act==='fish');
    pickMesh.visible=(act==='mine'||act==='dig');
    axeMesh.visible=(act==='chop');
    player.position.set(pWorld.x, pWorld.y+(moving?Math.abs(Math.sin(pWorld.step))*0.08:0), pWorld.z);

    for(const n of oreNodes){ if(!n.alive&&clock>=n.respawnAt&&n.respawnAt>0){n.alive=true;n.mesh.visible=true;} }
    biomeCheck();
    if(marketOpen===true&&clock-bannerT>0.5){bannerT=clock;renderBanner();
      const e=Math.floor(Date.now()/MKT_MS);
      if(e!==mktEpochSeen){mktEpochSeen=e;renderMarket();renderOres();}}
    if(areaT>0){areaT-=dt;if(areaT<=0)H.area.classList.remove('on');}
    if(revT>0){renderFishScene(dt);revT-=dt;if(revT<=0){revEl.classList.remove('on');disposeFishModel();}}
  }

  // camera: smooth fly between the follow-cam and a close-up over the roulette table
  if(viewMode==='casino'){ vTargL.copy(WHEEL_CENTER).addScaledVector(CAS_SHIFT,1); vTargP.copy(vTargL).add(CAS_CAM_OFF); }
  else{ vTargP.set(pWorld.x+CAM_OFF.x,pWorld.y+CAM_OFF.y,pWorld.z+CAM_OFF.z); vTargL.set(pWorld.x,pWorld.y+1,pWorld.z); }
  const vTargS=viewMode==='casino'?3.2:camSize, vk=1-Math.exp(-4.5*rdt);
  vPos.lerp(vTargP,vk); vLook.lerp(vTargL,vk); vSize+=(vTargS-vSize)*vk;
  { const a=window.innerWidth/window.innerHeight;
    camera.left=-vSize*a;camera.right=vSize*a;camera.top=vSize;camera.bottom=-vSize;camera.updateProjectionMatrix(); }
  camera.position.copy(vPos);
  camera.lookAt(vLook);
  if(trauma>0){ const sh=trauma*trauma*(viewMode==='casino'?0.22:0.55);
    camera.position.x+=rand(-sh,sh); camera.position.y+=rand(-sh,sh)*0.5; camera.position.z+=rand(-sh,sh);
    trauma=Math.max(0,trauma-rdt*2.4); }
  updateRoulette(dt);
  fxUpdate(dt);

  animWater(clock); animGrass(clock);
  skyUpdate(dt); rainUpdate(dt);
  if((chipT+=dt)>0.5){chipT=0;chipUpdate();}
  water.position.y=WATER_TOP+Math.sin(clock*0.8)*0.03;
  trader.rotation.y=Math.sin(clock*0.5)*0.25;
  updateFishLine();
  const lampNight=isNight()?1.7:1;
  for(let k=0;k<lamps.length;k++)lamps[k].material.emissiveIntensity=(0.7+Math.sin(clock*3+k*1.7)*0.3)*lampNight;
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
  startOv.classList.remove('on'); running=true; updateHUD(); setArea(WORLD.name,WORLD.sub);
  if(state.stats.caught===0&&state.stats.mined===0)toast('🏝️ Welcome to '+WORLD.name+'! Walk through the gate','gold'); }
document.getElementById('startBtn').onclick=start;

// idle preview loop: the island is already alive behind the start menu
last=performance.now(); requestAnimationFrame(animate);
document.getElementById('wipe').onclick=()=>{try{localStorage.removeItem(SAVE);localStorage.removeItem('reelfortune3d-world');}catch(e){}
  state.coins=0;state.bucket=[];state.ores={wood:0,coal:0,iron:0,gold:0,diamond:0};state.rodLvl=1;state.pickLvl=1;
  state.dex={};state.treasure=null;state.worlds=['isle'];
  state.stats={caught:0,mined:0,earned:0,bestWin:0,spins:0,winsCt:0,losses:0};
  updateHUD();toast('Save wiped');};
updateHUD();
})();
