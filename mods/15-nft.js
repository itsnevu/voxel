/* ============================================================================
   15-nft — wear the Reel Fortune Angler you own.

   The mint page sells 1000 voxel anglers (nft/). This slot lets a signed-in
   WALLET account pick one of its own tokens and walk the isle as it: the hero's
   materials are recoloured and a few parts shown/hidden from the token's
   attributes, using nft/traits-palette.json (written by the art engine's
   export) so the in-game hero and the NFT picture agree on every colour.

   Trust model — the client never decides what it owns:
     · the list comes from GET  /api/nft/characters (server → eth_call)
     · wearing goes through POST /api/nft/equip, which re-checks the chain for
       the SIWE-proven address before writing state.charTokenId
     · a guest / password account has no wallet → the server answers NO_WALLET
       and this panel just says so. Guests are always the default hero.
   What this mod keeps locally is purely cosmetic: which token is drawn on the
   hero right now, mirrored from the server's answer.

   Key: K. Escape closes. HUD chip under the minimap appears once a wallet is
   signed in. `RF.api.nft` exposes { list, equip, unequip, equipped, refresh,
   open, close } for other mods and for the test harness.
   ========================================================================== */
RF.mod('15-nft', function (RF) {
  'use strict';

  const NET = () => window.RFNet || null;
  const STORE = '15-nft';
  const ASSETS = { palette: 'nft/traits-palette.json', json: 'nft/json/', images: 'nft/images/' };
  const DEFAULT_NAME = 'Default hero';

  /* --------------------------------------------------------------- state -- */
  let palette = null;          // nft/traits-palette.json, loaded once
  let paletteP = null;
  const meta = new Map();      // tokenId -> metadata json (or null when missing)
  let owned = [];              // token ids the server says this wallet holds
  let info = { wallet: '', configured: null, reason: '', ok: null, stale: false };
  let equippedId = 0;          // what the hero is drawn as (0 = default)
  let target = null;           // resolved colours for equippedId
  let snapshot = null;         // material colours + visibility before the first equip
  let lastKey = '';            // auth fingerprint, to notice sign-in / sign-out
  let busy = false;
  let open = false;

  /* ------------------------------------------------------------ helpers -- */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');
  const toast = (m, k) => { try { RF.fn.toast(m, k || 'good'); } catch (e) { /* no toast yet */ } };
  const notify = (level, title, body) => { if (RF.api && RF.api.notify) RF.api.notify({ level, title, body, tag: 'nft', ttl: 6000 }); };
  const typing = () => { const a = document.activeElement;
    return !!RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };

  const HEX = /^#?[0-9a-f]{6}$/i;
  const toInt = (h) => parseInt(String(h).replace('#', ''), 16);
  const darker = (h, f) => { const v = toInt(h); const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return ((r * f) << 16 | (g * f) << 8 | (b * f)) >>> 0; };

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(url + ' → ' + r.status); return r.json(); });
  }
  function loadPalette() {
    if (palette) return Promise.resolve(palette);
    if (!paletteP) paletteP = fetchJSON(ASSETS.palette).then((p) => (palette = p)).catch((e) => { paletteP = null; RF.err('nft:palette', e, 'warn'); return null; });
    return paletteP;
  }
  function loadMeta(id) {
    if (meta.has(id)) return Promise.resolve(meta.get(id));
    return fetchJSON(ASSETS.json + id + '.json').then((m) => { meta.set(id, m); return m; })
      .catch((e) => { RF.err('nft:meta', e, 'warn'); meta.set(id, null); return null; });
  }

  /* The hero's material handles, by the makeHero() part names. Several meshes
     share one material on purpose (both legs, both boots + belt + strap, both
     arms + belly, skin on head + hands, crown + brim), so setting the material
     recolours every mesh that wears it — exactly what a costume should do. */
  function hero() {
    const u = RF.player && RF.player.userData; if (!u || !u.body) return null;
    const head = Array.isArray(u.head.material) ? u.head.material : [u.head.material, 0, 0, 0, u.head.material];
    return {
      pants: u.legL.material, boots: u.bootL.material, vest: u.body.material, sleeve: u.armL.material,
      skin: head[0], face: head[4], hair: u.hair.material, scarf: u.scarf.material,
      hat: u.crown.material, band: u.band.material,
      show: { scarf: u.scarf, hat: [u.crown, u.band, u.brim], pack: u.pack },
    };
  }
  const COLOR_KEYS = ['pants', 'boots', 'vest', 'sleeve', 'skin', 'face', 'hair', 'scarf', 'hat', 'band'];

  function takeSnapshot() {
    const h = hero(); if (!h) return null;
    const s = { colors: {}, show: { scarf: h.show.scarf.visible, hat: h.show.hat[0].visible, pack: h.show.pack.visible } };
    COLOR_KEYS.forEach((k) => { s.colors[k] = h[k].color.getHex(); });
    return s;
  }
  function restoreSnapshot() {
    const h = hero(); if (!h || !snapshot) return;
    COLOR_KEYS.forEach((k) => { h[k].color.setHex(snapshot.colors[k]); });
    h.show.scarf.visible = snapshot.show.scarf;
    h.show.hat.forEach((m) => { m.visible = snapshot.show.hat; });
    h.show.pack.visible = snapshot.show.pack;
  }

  /* Attributes → what to paint. Only the parts the voxel hero actually has;
     eyes, mouth, tools, companions and the sky stay the game's own. */
  function resolve(attrs) {
    const get = (t) => { const a = (attrs || []).find((x) => x && x.trait_type === t); return a ? String(a.value) : null; };
    const P = (t, v) => (palette && palette.traits && palette.traits[t] && palette.traits[t][v]) || {};
    const out = { colors: {}, show: { scarf: true, hat: true, pack: true }, attrs: attrs || [] };
    const put = (k, hex) => { if (hex && HEX.test(hex)) out.colors[k] = toInt(hex); };

    const o = P('Outfit', get('Outfit')); put('vest', o.vest); put('sleeve', o.sleeve || o.shirt);
    const pa = P('Pants', get('Pants')); put('pants', pa.pants); put('boots', pa.boots);
    const sk = P('Skin', get('Skin')); put('skin', sk.skin);
    const hr = P('Hair', get('Hair')); put('hair', hr.hair);

    const nw = get('Neckwear'); const n = P('Neckwear', nw);
    if (n.scarf) put('scarf', n.scarf); else if (nw) out.show.scarf = false;          // None / necklaces

    const hw = get('Headwear'); const hd = P('Headwear', hw);
    if (hw === 'None') out.show.hat = false;
    else if (hd.hat) { put('hat', hd.hat); put('band', hd.band); }
    else if (hd.primary && HEX.test(hd.primary)) { out.colors.hat = toInt(hd.primary); out.colors.band = darker(hd.primary, 0.6); }

    if (get('Back Gear') === 'None') out.show.pack = false;

    /* The face is a texture painted in the default peach; a material colour
       multiplies it, so the tint is skin / peach per channel (clamped — a
       texture cannot be brightened). Deep skins come out right, pale ones stay
       peach, which is the honest limit of a tint. */
    if (out.colors.skin != null) {
      const s = out.colors.skin, base = [0xf0, 0xc0, 0x90];
      const ch = [(s >> 16) & 255, (s >> 8) & 255, s & 255].map((v, i) => Math.min(255, Math.round(v / base[i] * 255)));
      out.colors.face = (ch[0] << 16 | ch[1] << 8 | ch[2]) >>> 0;
    }
    return out;
  }

  function paint() {
    const h = hero(); if (!h || !target) return;
    for (const k in target.colors) h[k].color.setHex(target.colors[k]);
    h.show.scarf.visible = target.show.scarf;
    h.show.hat.forEach((m) => { m.visible = target.show.hat; });
    h.show.pack.visible = target.show.pack;
  }

  /* Core's wardrobe (Pearl Kiosk) writes band/scarf/vest whenever it likes —
     on a kiosk click, on a server state load. While an Angler is worn its
     costume wins, so re-assert twice a second; three getHex() calls when
     nothing changed, which is nothing. */
  RF.every(0.5, () => {
    if (!equippedId || !target) return;
    const h = hero(); if (!h) return;
    for (const k of ['vest', 'scarf', 'band']) {
      if (target.colors[k] != null && h[k].color.getHex() !== target.colors[k]) { paint(); return; }
    }
  });

  /* ------------------------------------------------- wear / take off ------ */
  function wearLocal(id, m) {
    if (!snapshot) snapshot = takeSnapshot();
    equippedId = id; target = resolve(m && m.attributes);
    paint(); remember();
    render();
  }
  function takeOffLocal() {
    equippedId = 0; target = null;
    restoreSnapshot(); remember(); render();
  }
  function remember() {
    const w = info.wallet || '';
    const st = RF.store.get(STORE, {}) || {};
    st.worn = st.worn || {};
    if (w) { if (equippedId) st.worn[w] = equippedId; else delete st.worn[w]; }
    RF.store.set(STORE, st);
  }

  function equip(id) {
    id = id | 0;
    const N = NET();
    if (!N || !N.online) { toast('Sign in with your wallet to wear an Angler', 'bad'); return Promise.resolve(false); }
    if (busy) return Promise.resolve(false);
    busy = true; render();
    const call = id ? N.nftEquip(id) : N.nftEquip(0);
    return call.then((r) => {
      const worn = Number(r && r.charTokenId != null ? r.charTokenId : id) | 0;
      if (!worn) { takeOffLocal(); toast('Back to the default hero'); return true; }
      return loadPalette().then(() => loadMeta(worn)).then((m) => {
        wearLocal(worn, m);
        toast('Now wearing Angler #' + worn + (m && m.name ? '' : ' (no metadata on this site)'), 'good');
        try { RF.fn.addShake(0.08); } catch (e) { /* cosmetic */ }
        return true;
      });
    }).catch((e) => {
      const code = e && e.data && e.data.code;
      const msg = code === 'NO_WALLET' ? 'Connect a wallet to wear an Angler'
        : code === 'NOT_OWNED' ? 'That Angler is not in this wallet (or the chain is unreachable)'
        : (e && e.message) || 'Could not equip';
      toast(msg, 'bad'); RF.err('nft:equip', e, 'warn'); return false;
    }).finally(() => { busy = false; render(); });
  }

  /* ---------------------------------------------- server: what do I own? -- */
  function refresh(fresh) {
    const N = NET();
    if (!N || !N.online) { owned = []; info = { wallet: '', configured: null, reason: 'OFFLINE', ok: null }; render(); return Promise.resolve(info); }
    return Promise.all([N.nftCharacters(!!fresh), N.getState().catch(() => null)]).then(([r, st]) => {
      owned = Array.isArray(r && r.tokens) ? r.tokens.map((x) => Number(x)).filter((x) => x > 0) : [];
      info = { wallet: (r && r.wallet) || '', configured: !!(r && r.configured), reason: (r && r.reason) || '', ok: r ? r.ok !== false : null, stale: !!(r && r.stale) };
      const s = st && (st.state || st);
      const serverWorn = s && Number.isInteger(Number(s.charTokenId)) ? Number(s.charTokenId) : 0;
      /* The server's record wins. A token sold since is no longer in `owned`,
         so it comes off here too — the save catches up on the next equip. */
      const want = serverWorn && owned.includes(serverWorn) ? serverWorn : 0;
      const cached = (RF.store.get(STORE, {}) || {}).worn || {};
      const fallback = info.wallet && cached[info.wallet] && owned.includes(cached[info.wallet]) ? cached[info.wallet] : 0;
      const wear = want || (serverWorn ? 0 : fallback);
      if (wear && wear !== equippedId) return loadPalette().then(() => loadMeta(wear)).then((m) => { wearLocal(wear, m); return info; });
      if (!wear && equippedId) takeOffLocal();
      render();
      return info;
    }).catch((e) => { RF.err('nft:characters', e, 'warn'); info.reason = 'ERROR'; info.ok = false; render(); return info; });
  }

  /* Notice sign-in / sign-out without a core event for it: one string compare
     per second. */
  RF.every(1.0, () => {
    const N = NET();
    const key = N ? [N.online ? 1 : 0, N.token ? 1 : 0, N.user || '', N.wallet || ''].join('|') : '';
    if (key === lastKey) return;
    lastKey = key;
    if (N && N.online) refresh(false);
    else { owned = []; info = { wallet: '', configured: null, reason: 'OFFLINE', ok: null }; if (equippedId) takeOffLocal(); render(); }
  });

  /* ----------------------------------------------------------------- UI -- */
  RF.css(`
  #rf-nft-hud{position:fixed;left:12px;top:296px;z-index:28;display:none;align-items:center;gap:7px;cursor:pointer;
    background:var(--glass-hud);backdrop-filter:blur(14px) saturate(1.6);-webkit-backdrop-filter:blur(14px) saturate(1.6);
    border:1px solid rgba(255,207,92,.45);border-radius:11px;padding:6px 11px;font-size:11px;font-weight:700;letter-spacing:.06em;
    color:var(--gold);box-shadow:var(--glass-hi),0 0 16px rgba(255,207,92,.16);user-select:none;}
  #rf-nft-hud.on{display:flex;}
  #rf-nft-hud img{width:22px;height:22px;border-radius:6px;image-rendering:pixelated;background:rgba(255,255,255,.06);}
  #rf-nft-hud .k{font-size:9px;letter-spacing:.24em;color:var(--lab);font-family:var(--f-mono);font-weight:500;}
  body.photo #rf-nft-hud{display:none!important;}
  #rf-nft{position:fixed;inset:0;z-index:24;display:none;align-items:center;justify-content:center;background:rgba(3,10,12,.55);}
  #rf-nft.on{display:flex;}
  #rf-nft .card{width:min(760px,94vw);max-height:88vh;overflow:auto;background:var(--glass-sheen),var(--glass-strong);
    backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);border:1px solid var(--glass-bd);
    border-radius:14px;box-shadow:var(--glass-hi),0 8px 28px rgba(2,8,10,.35);padding:18px 20px 20px;}
  #rf-nft .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;}
  #rf-nft .sub{font-size:10px;letter-spacing:.18em;color:var(--gold);text-transform:uppercase;}
  #rf-nft h2{font-family:"Chakra Petch",sans-serif;font-size:22px;margin:2px 0 0;color:var(--ink);}
  #rf-nft .x{background:none;border:1px solid var(--glass-bd);color:var(--muted);font:inherit;font-size:10px;letter-spacing:.1em;
    padding:6px 10px;border-radius:8px;cursor:pointer;}
  #rf-nft .x:hover{color:var(--ink);border-color:var(--teal);}
  #rf-nft .note{font-size:11px;color:var(--muted);line-height:1.5;background:var(--glass-row);border:1px solid var(--glass-bd-soft);
    border-radius:10px;padding:9px 12px;margin-bottom:12px;}
  #rf-nft .note b{color:var(--ink);}
  #rf-nft .note a,#rf-nft .tools a{color:var(--teal);}
  #rf-nft .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}
  #rf-nft .tok{background:var(--glass-row);border:1px solid var(--glass-bd-soft);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:6px;}
  #rf-nft .tok.worn{border-color:rgba(255,207,92,.7);box-shadow:0 0 14px rgba(255,207,92,.2);}
  #rf-nft .tok .im{aspect-ratio:1;border-radius:9px;overflow:hidden;background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;}
  #rf-nft .tok img{width:100%;height:100%;object-fit:cover;image-rendering:pixelated;display:block;}
  #rf-nft .tok .im .ph{font-size:34px;line-height:1;color:var(--faint);}
  #rf-nft .tok .nm{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:12px;color:var(--ink);}
  #rf-nft .tok .tr{font-size:9.5px;color:var(--muted);line-height:1.4;min-height:2.8em;}
  #rf-nft .tok button{font-family:"Chakra Petch",sans-serif;font-weight:700;font-size:10.5px;letter-spacing:.1em;padding:7px 8px;
    border-radius:8px;border:1px solid var(--glass-bd);background:var(--glass-row);color:var(--ink);cursor:pointer;}
  #rf-nft .tok button:hover:not(:disabled){border-color:var(--teal);transform:translateY(-1px);}
  #rf-nft .tok button:disabled{opacity:.45;cursor:default;}
  #rf-nft .tok button.gold{border-color:rgba(255,207,92,.7);color:var(--gold);}
  #rf-nft .tools{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:12px;font-size:10.5px;color:var(--muted);flex-wrap:wrap;}
  #rf-nft .tools button{background:none;border:1px solid var(--glass-bd);color:var(--muted);font:inherit;font-size:10px;letter-spacing:.1em;
    padding:6px 10px;border-radius:8px;cursor:pointer;}
  #rf-nft .tools button:hover:not(:disabled){color:var(--ink);border-color:var(--teal);}
  @media (max-width:640px){ #rf-nft-hud{top:auto;bottom:196px;} #rf-nft .grid{grid-template-columns:repeat(2,1fr);} }
  `, 'rf-nft-css');

  const hud = RF.el(`<div id="rf-nft-hud" role="button" tabindex="0" title="My Anglers · K">
    <img id="rf-nft-hud-im" alt="" hidden><span class="k">ANGLER</span><span id="rf-nft-hud-t">wear yours</span></div>`);
  const root = RF.el(`<div id="rf-nft" role="dialog" aria-modal="true" aria-labelledby="rf-nft-h">
    <div class="card">
      <div class="head"><div><div class="sub">Reel Fortune Anglers · on-chain wardrobe</div><h2 id="rf-nft-h">MY ANGLERS</h2></div>
        <button class="x" id="rf-nft-x" type="button">CLOSE · ESC</button></div>
      <div class="note" id="rf-nft-note"></div>
      <div class="grid" id="rf-nft-grid"></div>
      <div class="tools"><span id="rf-nft-foot"></span>
        <span><button id="rf-nft-refresh" type="button">↻ RE-CHECK CHAIN</button> <a href="mint.html" target="_blank" rel="noopener">◆ mint another →</a></span></div>
    </div></div>`);

  function openPanel() { if (open) return; open = true; root.classList.add('on'); render(); try { RF.fn.beep && RF.fn.beep(660, 0.04); } catch (e) { /* no audio */ } }
  function closePanel() { if (!open) return; open = false; root.classList.remove('on'); }

  hud.addEventListener('click', openPanel);
  hud.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); } });
  $('rf-nft-x').addEventListener('click', closePanel);
  root.addEventListener('click', (e) => { if (e.target === root) closePanel(); });
  $('rf-nft-refresh').addEventListener('click', () => { const b = $('rf-nft-refresh'); if (b) b.disabled = true; refresh(true).finally(() => { if (b) b.disabled = false; }); });
  $('rf-nft-grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-wear]'); if (!b) return;
    equip(Number(b.getAttribute('data-wear')));
  });

  RF.on('keydown', (e) => {
    if (e.code === 'Escape' && open) { closePanel(); return true; }
    if (typing()) return;
    if (e.code === 'KeyK' && !RF.panelOpen) { e.preventDefault(); if (open) closePanel(); else openPanel(); return true; }
  });

  function traitLine(m) {
    if (!m || !Array.isArray(m.attributes)) return 'metadata not on this site';
    const pick = ['Headwear', 'Outfit', 'Background'];
    return m.attributes.filter((a) => pick.includes(a.trait_type)).map((a) => esc(a.value)).join(' · ');
  }

  function render() {
    const N = NET();
    const signed = !!(N && N.online);
    const hasWallet = !!info.wallet;
    /* HUD chip: only once a wallet is signed in, otherwise it is a button to nowhere. */
    hud.classList.toggle('on', signed && hasWallet);
    const t = $('rf-nft-hud-t'), im = $('rf-nft-hud-im');
    if (t) t.textContent = equippedId ? '#' + equippedId : (owned.length ? owned.length + ' owned' : 'wear yours');
    if (im) { if (equippedId) { im.src = ASSETS.images + equippedId + '.png'; im.hidden = false; } else im.hidden = true; }
    if (!open) return;

    const note = $('rf-nft-note'), grid = $('rf-nft-grid'), foot = $('rf-nft-foot');
    if (!note || !grid) return;
    let n = '';
    if (!signed) n = '<b>Offline.</b> Anglers live on the server: sign in with <b>CONNECT WALLET</b> on the title screen to wear one.';
    else if (!hasWallet) n = '<b>This account has no wallet.</b> Guests and password accounts play the default hero. Sign in with a wallet that holds an Angler to wear it — or <a href="mint.html" target="_blank" rel="noopener">mint one</a>.';
    else if (info.configured === false) n = '<b>No chain configured on this server yet</b> — the collection cannot be checked, so everyone is the default hero for now.';
    else if (info.ok === false) n = '<b>Chain unreachable right now</b>' + (info.stale ? ' — showing the last answer it gave.' : ' — nothing to show until it answers.');
    else if (!owned.length) n = 'Wallet <b>' + esc(short(info.wallet)) + '</b> holds no Angler yet. <a href="mint.html" target="_blank" rel="noopener">Mint one</a>, then press RE-CHECK CHAIN.';
    else n = 'Wallet <b>' + esc(short(info.wallet)) + '</b> · <b>' + owned.length + '</b> Angler' + (owned.length > 1 ? 's' : '') + '. Wearing one recolours your hero for you' + ' — hat, outfit, pants, skin, hair, scarf. It overrides the Pearl Kiosk wardrobe while worn.';
    note.innerHTML = n;

    const cards = [];
    cards.push(`<div class="tok${equippedId ? '' : ' worn'}"><div class="im"><span class="ph">🎣</span></div>
      <div class="nm">${esc(DEFAULT_NAME)}</div><div class="tr">Straw hat · Teal Captain · Fortune Isle</div>
      <button type="button" data-wear="0" class="${equippedId ? '' : 'gold'}" ${!equippedId || busy || !signed ? 'disabled' : ''}>${equippedId ? 'TAKE OFF' : 'WEARING'}</button></div>`);
    for (const id of owned) {
      const m = meta.get(id); const worn = id === equippedId;
      cards.push(`<div class="tok${worn ? ' worn' : ''}" data-id="${id}"><div class="im"><img src="${ASSETS.images}${id}.png" alt="Angler #${id}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'#${id}'}))"></div>
        <div class="nm">${esc(m && m.name ? m.name : 'Reel Fortune Angler #' + id)}</div><div class="tr">${traitLine(m)}</div>
        <button type="button" data-wear="${id}" class="${worn ? 'gold' : ''}" ${worn || busy ? 'disabled' : ''}>${worn ? 'WEARING' : 'WEAR'}</button></div>`);
      if (!meta.has(id)) loadMeta(id).then(() => { if (open) render(); });
    }
    grid.innerHTML = cards.join('');
    if (foot) foot.textContent = signed && hasWallet
      ? (info.stale ? 'last chain answer (stale)' : info.configured === false ? 'chain: not configured' : 'ownership checked by the server on the chain')
      : '';
  }

  /* -------------------------------------------------------- public api -- */
  RF.api = RF.api || {};
  RF.api.nft = {
    list: (fresh) => refresh(fresh).then(() => owned.slice()),
    equip: (id) => equip(id),
    unequip: () => equip(0),
    equipped: () => equippedId,
    refresh: (fresh) => refresh(fresh),
    open: openPanel, close: closePanel,
    resolve: (attrs) => loadPalette().then(() => resolve(attrs)),
    /* tokenId -> the same paint job, for a hero that is NOT ours: the core uses
       this to dress other players on the isle. Goes through loadMeta/loadPalette
       so a room of twelve anglers wearing six tokens costs six fetches, not
       twelve — a second cache in the core would have made it twelve. */
    forToken: (id) => (Number(id) > 0
      ? Promise.all([loadPalette(), loadMeta(Number(id))])
        .then((r) => (r[1] ? resolve(r[1].attributes) : null))
        .catch(() => null)
      : Promise.resolve(null)),
  };

  RF.on('ready', () => { loadPalette(); });
});
