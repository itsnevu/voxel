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
  /* ---- Connect Wallet: the wallet is an IDENTITY, never a payment rail.
     We ask it to sign a plain-text message; that proves the address is yours.
     No transaction is ever built, no chain is read, no funds are touched. ---- */
  hasWallet(){ return !!(window.ethereum); },
  async walletLogin(){
    if(!window.ethereum) throw new Error('No wallet found · install MetaMask or use Guest');
    const accs=await window.ethereum.request({method:'eth_requestAccounts'});
    const address=(accs&&accs[0]||'').toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Wallet gave no address');
    const {message}=await req('/api/auth/wallet/nonce?address='+encodeURIComponent(address),{auth:false});
    const signature=await window.ethereum.request({method:'personal_sign',params:[message,address]});
    const d=await req('/api/auth/wallet/verify',{method:'POST',auth:false,body:{address,signature}});
    token=d.token; user=d.username||address.slice(0,8); store(LS_TOK,token); store(LS_USER,user);
    if(d.wallet)store('rf-wallet',d.wallet);
    reachable=true; return d;
  },
  /* ---- Guest: a real server account with a generated key kept in this browser,
     so a guest keeps their island across reloads without ever signing up. ---- */
  async guestLogin(){
    const saved=localStorage.getItem('rf-guest');
    if(saved){ try{ const g=JSON.parse(saved); const d=await this.login(g.u,g.k); return d; }catch(e){} }
    const d=await req('/api/auth/guest',{method:'POST',auth:false,body:{}});
    token=d.token; user=d.username; store(LS_TOK,token); store(LS_USER,user);
    try{ localStorage.setItem('rf-guest',JSON.stringify({u:d.username,k:d.guestKey})); }catch(e){}
    reachable=true; return d;
  },
  get wallet(){ return localStorage.getItem('rf-wallet')||''; },

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

  /* ---- CREW: a berth on someone's boat is granted by its captain, never
     taken. request() only knocks; admit()/deny() are the captain's call. ---- */
  crew(){ return req('/api/crew'); },
  crewCaptains(){ return req('/api/crew/captains'); },
  crewRequest(captain){ return req('/api/crew/request',{method:'POST',body:{captain}}); },
  crewCancel(captain){ return req('/api/crew/cancel',{method:'POST',body:{captain}}); },
  crewAdmit(user){ return req('/api/crew/admit',{method:'POST',body:{user}}); },
  crewDeny(user){ return req('/api/crew/deny',{method:'POST',body:{user}}); },
  crewKick(user){ return req('/api/crew/kick',{method:'POST',body:{user}}); },
  crewLeave(){ return req('/api/crew/leave',{method:'POST'}); },
  ledger(){ return req('/api/ledger'); },
  claimDeed(deedId,address){ return req('/api/ledger/claim',{method:'POST',body:{deedId,address}}); },
  online_(){ return req('/api/online',{auth:false}); },

  /* ======================= REALTIME MULTIPLAYER =======================
     A thin event bus over one WebSocket. The socket carries only presence,
     chat and shared-resource news — never money. Anything that moves a coin
     still goes through the authenticated HTTP actions above, so a forged
     socket frame cannot make anyone richer. */
  ws:null, wsReady:false, _h:{}, _retry:0, _tmr:null, _world:'', _meta:null,
  on(evt,fn){ (this._h[evt]||(this._h[evt]=[])).push(fn); return this; },
  _emit(evt,d){ const l=this._h[evt]; if(l)for(const f of l){ try{ f(d); }catch(e){ console.warn('RFNet handler',evt,e); } } },

  connectWS(world,meta){
    if(!this.online)return;
    this._world=world; this._meta=meta||{};
    if(this.ws&&(this.ws.readyState===0||this.ws.readyState===1))return;   // already connecting/open
    let url;
    try{ url=new URL(base); }catch(e){ return; }
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    url.pathname=(url.pathname.replace(/\/+$/,''))+'/ws';
    url.search='?token='+encodeURIComponent(token);
    let s; try{ s=new WebSocket(url.toString()); }catch(e){ return; }
    this.ws=s;
    s.onopen=()=>{ this.wsReady=true; this._retry=0;
      this.send({t:'hello',world:this._world,title:this._meta.title||'',wardrobe:this._meta.wardrobe||{}});
      this._emit('open'); };
    s.onmessage=ev=>{ let d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
      if(!d||typeof d.t!=='string')return;
      if(d.t==='pong')return;
      this._emit(d.t,d); };
    s.onclose=()=>{ this.wsReady=false; this.ws=null; this._emit('close');
      if(!this.online)return;                     // signed out on purpose
      const wait=Math.min(30000,1000*Math.pow(2,this._retry++));
      clearTimeout(this._tmr); this._tmr=setTimeout(()=>this.connectWS(this._world,this._meta),wait); };
    s.onerror=()=>{ try{ s.close(); }catch(e){} };
  },
  send(obj){ if(this.ws&&this.ws.readyState===1){ try{ this.ws.send(JSON.stringify(obj)); }catch(e){} } },
  disconnectWS(){ clearTimeout(this._tmr); this._retry=0;
    if(this.ws){ try{ this.ws.close(1000,'bye'); }catch(e){} this.ws=null; } this.wsReady=false; },
};

window.RFNet=Net;
})();
