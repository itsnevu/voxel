/* ============================================================================
   RFNet — optional bridge to the authoritative Reel Fortune server.

   The game stays fully playable offline from file:// with localStorage.
   When a server is reachable AND the player is signed in, the SERVER becomes the
   source of truth: it rolls every fish, ore, share drop and roulette spin, prices
   every sale, and owns the coin balance. The client then only renders what the
   server returned — editing `state` in the console no longer changes anything
   that matters, because the next action reply overwrites it.

   That handover is ONE WAY for the life of a session. Once the server has adopted
   us (`adopted` below) a dropped connection does not hand the economy back: the
   game keeps taking its server branch and req() refuses the request outright.
   The alternative — quietly reverting to local rolls — mints coins, ore and pearls
   that the first reply after the reconnect silently deletes, which is worse than
   not being able to fish for a minute. Signing out is the honest way back to
   offline play, and it is one click away in the account panel.
   ========================================================================== */
(function () {
"use strict";
const LS_URL='rf-server', LS_TOK='rf-token', LS_USER='rf-user';
const httpish = location.protocol==='http:'||location.protocol==='https:';

let base  = localStorage.getItem(LS_URL) || (httpish ? location.origin : '');
let token = localStorage.getItem(LS_TOK) || '';
let user  = localStorage.getItem(LS_USER) || '';
let reachable = false;          // server answered a probe
let adopted = false;            // this session proved its token: the server owns the economy
let lastError = '';
let netFails = 0;               // consecutive network-class / gateway failures
let cooldownUntil = 0;          // wall clock when a 429 back-off expires
let healTmr = null, healWait = 0, healGen = 0, healing = false;

const store=(k,v)=>{ try{ v==null?localStorage.removeItem(k):localStorage.setItem(k,v); }catch(e){} };

/* Offline-first only holds if `reachable` can go back down. One failed request
   is noise; three in a row means the box is gone, and the game has to be told
   so it stops promising server rolls it can no longer get. */
const FAIL_LIMIT=3, HEAL_MIN=5000, HEAL_MAX=60000;
function setReachable(v){ if(reachable===v)return; reachable=v; Net._emit('reachable',v); }

/* Which copy of the client this box is serving. The FIRST answer is what we are
   running — we were loaded from it. Any later answer that differs means a deploy
   landed underneath a tab still executing the old JavaScript, and the honest
   thing is to say so before a move comes back UNKNOWN_ACTION and costs the
   player a spin. Said once: someone who keeps playing anyway has decided, and a
   nag every five minutes is its own bug. Absent field (an API-only box that
   serves no game files) means there is nothing to compare and we never ask. */
let buildSeen='', buildToldStale=false;
function noteBuild(d){
  const b=d&&d.build; if(!b)return;
  if(!buildSeen){ buildSeen=b; return; }
  if(b!==buildSeen&&!buildToldStale){ buildToldStale=true; Net._emit('stale',b); }
}
/* One answer to 'is the game server up', shared by probe() and healTick() so the
   two can never disagree about the same reply: a status proves something spoke,
   but 502-504 is the proxy apologising and 404 is a box with no /api/health on it
   at all. Neither of those is this game's server. */
const answered=e=>!!e&&e.status!=null&&e.status!==404&&!(e.status>=502&&e.status<=504);
function noteOk(){ netFails=0; stopHeal(); if(base)setReachable(true); }
function noteFail(){ netFails=Math.min(FAIL_LIMIT,netFails+1);
  if(netFails>=FAIL_LIMIT&&reachable){ setReachable(false); startHeal(); } }

/* Once we are dark, keep knocking on a widening backoff: it is the only thing that
   lifts the refusal in req(), so a session that lost the server mid-play can act
   again the moment it answers. `healing` spans the whole tick, await included —
   healTmr is null for those 12s, and a probe() landing in that window slipped past
   the guard and started a second chain stopHeal() could never reach, doubling the
   poll rate on every repeat. healGen disowns a tick cancelled while it waited. */
function startHeal(){ if(healTmr||healing||!base)return; healWait=HEAL_MIN; healTmr=setTimeout(healTick,healWait); }
function stopHeal(){ if(healTmr)clearTimeout(healTmr); healTmr=null; healWait=0; healGen++; }
async function healTick(){ healTmr=null; healing=true;
  const gen=healGen;
  try{
    if(reachable||!base)return;
    let alive=false;
    try{ noteBuild(await req('/api/health',{auth:false})); alive=true; }
    catch(e){ lastError=e.message; alive=answered(e); }
    if(gen!==healGen||reachable)return;      // stopHeal() or a live request settled it while we waited
    if(alive){ netFails=0; healWait=0; setReachable(true); return; }
    healWait=Math.min(HEAL_MAX,Math.round(healWait*1.8));
    healTmr=setTimeout(healTick,healWait);
  } finally{ healing=false; }
}

async function req(path,{method='GET',body=null,auth=true}={}){
  if(!base) throw new Error('no server configured');
  /* Signed in and known dark. Sending anyway costs the caller a 12s abort for the
     same answer, so refuse now — and refuse LOUDLY, because game.js reads a null
     result as permission to resolve the action locally instead. healTick() above
     is the only way back. */
  if(auth&&token&&!reachable){
    const off=new Error('unreachable · that move was not made · reconnecting');
    off.status=null; off.offline=true; throw off; }
  const headers={};
  if(body)headers['Content-Type']='application/json';
  if(auth&&token)headers['Authorization']='Bearer '+token;
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),12000);
  let res;
  try{ res=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):null,signal:ctl.signal}); }
  catch(e){ noteFail(); throw e; }                    // rejected or aborted: nothing answered
  finally{ clearTimeout(timer); }
  let data=null; try{ data=await res.json(); }catch(e){}
  if(!res.ok){
    if(res.status>=502&&res.status<=504)noteFail();   // a gateway apologising is not a server
    /* SPEC 12: retryAfter is milliseconds and the client must wait exactly that
       long, so publish the moment the door reopens instead of a duration. */
    if(res.status===429&&data&&typeof data.retryAfter==='number'&&isFinite(data.retryAfter)&&data.retryAfter>0)
      cooldownUntil=Date.now()+data.retryAfter;
    const err=new Error((data&&data.error)||('HTTP '+res.status)); err.status=res.status; err.data=data; throw err;
  }
  noteOk();
  return data;
}

const Net={
  get base(){return base;},
  get user(){return user;},
  get token(){return token;},
  get reachable(){return reachable;},
  get adopted(){return adopted;},
  /* Deliberately NOT `&&reachable`: see the header. A signed-in session that loses
     the box stays online so the economy stays the server's, and req() above turns
     every action into a visible refusal instead of a local reward with no future. */
  get online(){return !!(base&&token&&(reachable||adopted));},
  get lastError(){return lastError;},
  /* 0 when nothing is throttled, else the wall clock a 429 lifts at. */
  get cooldownUntil(){ if(cooldownUntil&&cooldownUntil<=Date.now())cooldownUntil=0; return cooldownUntil; },

  setBase(u){ base=(u||'').trim().replace(/\/+$/,''); store(LS_URL,base||null);
    netFails=0; adopted=false; stopHeal(); setReachable(false); },   // a different server is a different account

  /* Probe the cheapest unauthenticated endpoint there is: /api/health touches no
     database, so timing it measures the server and not SQLite. */
  async probe(){
    if(!base){ stopHeal(); setReachable(false); return false; }
    try{ noteBuild(await req('/api/health',{auth:false})); }
    catch(e){ lastError=e.message;
      /* A 500 still proves someone is home; a gateway code or a missing endpoint
         does not, and calling those reachable handed the economy to a box that
         answers nothing — and contradicted healTick() about the same reply. */
      if(!answered(e)){ setReachable(false); startHeal(); return false; }
    }
    netFails=0; stopHeal(); setReachable(true); return true;
  },

  /* The build this box is serving, as of the last health answer we saw. '' when
     nothing has answered yet, or when the box serves no game files to stamp. */
  get build(){ return buildSeen; },
  /* One cheap health call whose only job is the staleness compare. Swallows
     everything: a failed check must never surface as a game error — probe() and
     healTick() are what decide whether the server is up. */
  async checkBuild(){
    if(!base)return '';
    try{ noteBuild(await req('/api/health',{auth:false})); }catch(e){}
    return buildSeen;
  },

  async register(u,p){
    const d=await req('/api/auth/register',{method:'POST',auth:false,body:{username:u,password:p}});
    token=d.token; user=d.username||u; store(LS_TOK,token); store(LS_USER,user); adopted=true; return d;
  },
  async login(u,p){
    const d=await req('/api/auth/login',{method:'POST',auth:false,body:{username:u,password:p}});
    token=d.token; user=d.username||u; store(LS_TOK,token); store(LS_USER,user); adopted=true; return d;
  },
  async logout(){
    if(reachable){ try{ await req('/api/auth/logout',{method:'POST'}); }catch(e){} }
    token=''; user=''; adopted=false; store(LS_TOK,null); store(LS_USER,null);
    /* setBase() and probe() both end the heal loop; this exit forgot, so a sign-out
       during an outage left /api/health being knocked on every 60s for the life of
       the page. `reachable` is left standing: whether the server is up is a fact
       about the server, not about whether we are signed in to it. */
    netFails=0; stopHeal();
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
    adopted=true; return d;
  },
  /* ---- Guest: a real server account with a generated key kept in this browser,
     so a guest keeps their island across reloads without ever signing up. ---- */
  async guestLogin(){
    const saved=localStorage.getItem('rf-guest');
    if(saved){ try{ const g=JSON.parse(saved); const d=await this.login(g.u,g.k); return d; }catch(e){} }
    const d=await req('/api/auth/guest',{method:'POST',auth:false,body:{}});
    token=d.token; user=d.username; store(LS_TOK,token); store(LS_USER,user);
    try{ localStorage.setItem('rf-guest',JSON.stringify({u:d.username,k:d.guestKey})); }catch(e){}
    adopted=true; return d;
  },
  get wallet(){ return localStorage.getItem('rf-wallet')||''; },

  /* Verify a stored token still works (call once at boot). */
  async resume(){
    if(!base||!token)return false;
    try{ const d=await req('/api/auth/me'); user=d.username||user; store(LS_USER,user); adopted=true; return true; }
    catch(e){ if(e.status===401){ token=''; adopted=false; store(LS_TOK,null); } lastError=e.message; return false; }
  },

  getState(){ return req('/api/state'); },
  /* Every economy-relevant action goes through here; the reply carries fresh state. */
  action(name,body){ return req('/api/action/'+encodeURIComponent(name),{method:'POST',body:body||{}}); },
  /* Only cosmetics/preferences — the server ignores anything that touches the economy. */
  /* Each call carries the whole cosmetic snapshot rather than a delta, so a save
     dropped while dark is covered by the next one that lands — swallow that one
     refusal instead of raising a save error on every autosave of an outage. */
  saveCosmetics(patch){ return req('/api/save',{method:'POST',body:patch})
    .catch(e=>{ if(e&&e.offline)return null; throw e; }); },
  leaderboard(){ return req('/api/leaderboard',{auth:false}); },
  /* Public clock for the hourly fishing derby · polled from the render loop, so
     it goes through req() for the 12s abort rather than a bare fetch. */
  derby(){ return req('/api/derby',{auth:false}); },

  /* Client faults, batched. Fire-and-forget on purpose: a report that raises an
     error would be reported, and that is a loop — so every failure here, network
     or 4xx, dies right where it happened. */
  sendErrors(errors,build){
    return req('/api/client-error',{method:'POST',body:{build:build||'',errors:errors||[]}})
      .catch(()=>null); },

  /* ---- Reporting someone. The socket route ({t:'report'}) only reaches a peer
     who is still standing in your room; the moment they sail off, the id is gone
     and there is nobody left to name. This is the door that stays open: it takes
     the NAME, needs no socket, and lands in the same moderation queue. Requires a
     session — an anonymous report is a free way to flood that queue. ---- */
  report(target,reason){
    return req('/api/report',{method:'POST',
      body:{target:String(target||'').slice(0,20),reason:String(reason||'').slice(0,120)}}); },

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
  ws:null, wsReady:false, _h:{}, _retry:0, _tmr:null, _world:'', _meta:null, _wsSub:true,
  on(evt,fn){ (this._h[evt]||(this._h[evt]=[])).push(fn); return this; },
  _emit(evt,d){ const l=this._h[evt]; if(l)for(const f of l){ try{ f(d); }catch(e){ console.warn('RFNet handler',evt,e); } } },

  connectWS(world,meta){
    if(!this.online)return;
    this._world=world; this._meta=meta||{};
    if(this.ws&&(this.ws.readyState===0||this.ws.readyState===1))return;   // already connecting/open
    /* A CLOSING socket (readyState 2 — where onerror leaves it) still owns its
       handlers: let them live and the dying socket's onclose nulls out the
       replacement we are about to make and schedules a third. Cut it loose. */
    if(this.ws){ const old=this.ws; old.onopen=old.onmessage=old.onclose=old.onerror=null;
      try{ old.close(); }catch(e){} this.ws=null; this.wsReady=false; }
    let url;
    try{ url=new URL(base); }catch(e){ return; }
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    url.pathname=(url.pathname.replace(/\/+$/,''))+'/ws';
    url.search='?token='+encodeURIComponent(token);
    /* The 30-day bearer in the query string is written verbatim into every proxy
       access log. A browser cannot set a header on a WebSocket but it can name a
       subprotocol, so offer it there too; the query stays until every deployed
       server reads the subprotocol, and a server that ignores it is handled by
       the plain retry in onclose below. */
    let sub=this._wsSub&&token?'rf.bearer.'+token:'';
    if(sub&&!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(sub))sub='';   // must be an HTTP token
    let s;
    try{ s=sub?new WebSocket(url.toString(),sub):new WebSocket(url.toString()); }
    catch(e){ sub=''; try{ s=new WebSocket(url.toString()); }catch(e2){ return; } }
    this.ws=s; let opened=false;
    s.onopen=()=>{ if(this.ws!==s)return; opened=true; this.wsReady=true; this._retry=0;
      this.send({t:'hello',world:this._world,title:this._meta.title||'',wardrobe:this._meta.wardrobe||{}});
      this._emit('open'); };
    s.onmessage=ev=>{ if(this.ws!==s)return;
      let d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
      if(!d||typeof d.t!=='string')return;
      if(d.t==='pong')return;
      this._emit(d.t,d); };
    s.onclose=()=>{ if(this.ws!==s)return;                       // a stale socket cannot touch live state
      this.wsReady=false; this.ws=null; this._emit('close');
      /* Handshake refused before it ever opened · an older server that selects no
         subprotocol looks exactly like this, so drop the offer and try plain. */
      if(!opened&&sub)this._wsSub=false;
      if(!this.online)return;                     // signed out on purpose
      const wait=Math.min(30000,1000*Math.pow(2,this._retry++));
      clearTimeout(this._tmr); this._tmr=setTimeout(()=>this.connectWS(this._world,this._meta),wait); };
    s.onerror=()=>{ try{ s.close(); }catch(e){} };
  },
  send(obj){ if(this.ws&&this.ws.readyState===1){ try{ this.ws.send(JSON.stringify(obj)); }catch(e){} } },
  disconnectWS(){ clearTimeout(this._tmr); this._retry=0;
    const s=this.ws;
    if(s){ s.onopen=s.onmessage=s.onclose=s.onerror=null; try{ s.close(1000,'bye'); }catch(e){} }
    this.ws=null; this.wsReady=false;
    if(s)this._emit('close');   // the identity guard swallows the socket's own event, so say it here
  },
};

window.RFNet=Net;
})();
