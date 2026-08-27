/* ============================================================================
   RFNet — optional bridge to the authoritative Reel Fortune server.

   The game stays fully playable offline from file:// with localStorage.
   When a server is reachable AND the player is signed in, the SERVER becomes the
   source of truth: it rolls every fish, ore, share drop and roulette spin, prices
   every sale, and owns the coin balance. The client then only renders what the
   server returned — editing `state` in the console no longer changes anything
   that matters, because the next action reply overwrites it.
   ========================================================================== */
(function () {
"use strict";
const LS_URL='rf-server', LS_TOK='rf-token', LS_USER='rf-user';
const httpish = location.protocol==='http:'||location.protocol==='https:';

let base  = localStorage.getItem(LS_URL) || (httpish ? location.origin : '');
let token = localStorage.getItem(LS_TOK) || '';
let user  = localStorage.getItem(LS_USER) || '';
let reachable = false;          // server answered a probe
let lastError = '';

const store=(k,v)=>{ try{ v==null?localStorage.removeItem(k):localStorage.setItem(k,v); }catch(e){} };

async function req(path,{method='GET',body=null,auth=true}={}){
  if(!base) throw new Error('no server configured');
  const headers={};
  if(body)headers['Content-Type']='application/json';
  if(auth&&token)headers['Authorization']='Bearer '+token;
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),12000);
  let res;
  try{ res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):null,signal:ctl.signal}); }
  finally{ clearTimeout(timer); }
  let data=null; try{ data=await res.json(); }catch(e){}
  if(!res.ok){ const err=new Error((data&&data.error)||('HTTP '+res.status)); err.status=res.status; err.data=data; throw err; }
  return data;
}

const Net={
  get base(){return base;},
  get user(){return user;},
  get token(){return token;},
  get reachable(){return reachable;},
  get online(){return !!(base&&token&&reachable);},
  get lastError(){return lastError;},

  setBase(u){ base=(u||'').trim().replace(/\/+$/,''); store(LS_URL,base||null); reachable=false; },

  /* Probe an unauthenticated endpoint so we know whether a backend exists at all. */
  async probe(){
    if(!base){reachable=false;return false;}
    try{ await req('/api/leaderboard',{auth:false}); reachable=true; }
    catch(e){ reachable=false; lastError=e.message; }
    return reachable;
  },

  async register(u,p){
    const d=await req('/api/auth/register',{method:'POST',auth:false,body:{username:u,password:p}});
    token=d.token; user=d.username||u; store(LS_TOK,token); store(LS_USER,user); reachable=true; return d;
  },
  async login(u,p){
    const d=await req('/api/auth/login',{method:'POST',auth:false,body:{username:u,password:p}});
    token=d.token; user=d.username||u; store(LS_TOK,token); store(LS_USER,user); reachable=true; return d;
  },
  async logout(){
    try{ await req('/api/auth/logout',{method:'POST'}); }catch(e){}
    token=''; user=''; store(LS_TOK,null); store(LS_USER,null);
  },
  /* Verify a stored token still works (call once at boot). */
  async resume(){
    if(!base||!token)return false;
    try{ const d=await req('/api/auth/me'); user=d.username||user; store(LS_USER,user); reachable=true; return true; }
    catch(e){ if(e.status===401){ token=''; store(LS_TOK,null); } lastError=e.message; return false; }
  },

  getState(){ return req('/api/state'); },
  /* Every economy-relevant action goes through here; the reply carries fresh state. */
  action(name,body){ return req('/api/action/'+encodeURIComponent(name),{method:'POST',body:body||{}}); },
  /* Only cosmetics/preferences — the server ignores anything that touches the economy. */
  saveCosmetics(patch){ return req('/api/save',{method:'POST',body:patch}); },
  leaderboard(){ return req('/api/leaderboard',{auth:false}); },
  ledger(){ return req('/api/ledger'); },
  claimDeed(deedId,address){ return req('/api/ledger/claim',{method:'POST',body:{deedId,address}}); },
};

window.RFNet=Net;
})();
