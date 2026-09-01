/* RFMint — the Reel Fortune Anglers mint page app.
   Reads the contract over plain JSON-RPC (no wallet needed), connects an EIP-1193 wallet for
   minting, and drives the DOM in mint.html. Exposes window.RFMint = { connect, refresh, mint,
   state, events } so a headless test can drive it. Never hard-reloads the page. */
(function () {
  'use strict';
  var CFG = window.RF_MINT, E = window.RFEth;
  var $ = function (id) { return document.getElementById(id); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- chain selection (?chain=84532 overrides for testing) ----------------
  var params = new URLSearchParams(location.search);
  var chainId = Number(params.get('chain')) || CFG.chainId;
  if (!CFG.chains[chainId]) chainId = CFG.chainId;
  var chain = CFG.chains[chainId];
  var SIZE = CFG.collection.size;
  var SYM = chain.currency.symbol;

  var state = {
    chainId: chainId, chain: chain, contract: chain.contract || '', rpc: chain.rpc[0],
    hasWallet: !!window.ethereum, account: null, walletChainId: null,
    supply: null, maxSupply: null, price: null, maxPerWallet: null, saleActive: null,
    mintedBy: null, balance: null, tokens: [], qty: 1,
    rpcOk: null, status: 'idle', message: '', txHash: null, minted: [],
    rarity: null, collection: null, seed: 0, strip: []
  };
  var events = new EventTarget();
  function emit(type, detail) { try { events.dispatchEvent(new CustomEvent(type, { detail: detail })); } catch (e) { /* old engine */ } }

  // ---- tiny helpers --------------------------------------------------------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function imgUrl(id) { return CFG.assets.images + '/' + id + '.png'; }
  function jsonUrl(id) { return CFG.assets.json + '/' + id + '.json'; }
  function explorerTx(h) { return chain.explorer ? chain.explorer.replace(/\/$/, '') + '/tx/' + h : ''; }
  function explorerAddr(a) { return chain.explorer ? chain.explorer.replace(/\/$/, '') + '/address/' + a : ''; }
  function pctTier(p) { return p >= 18 ? 'common' : p >= 9 ? 'uncommon' : p >= 4.5 ? 'rare' : p >= 1.5 ? 'epic' : 'legendary'; }
  function rankTier(r) { return r <= 10 ? 'legendary' : r <= 50 ? 'epic' : r <= 150 ? 'rare' : r <= 400 ? 'uncommon' : 'common'; }
  function fmtPct(p) { return (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)) + '%'; }
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  // seeded PRNG so the preview strip is reproducible for a given ?seed=
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // one lazily-loaded tile that degrades to a labelled placeholder when nft/ is empty
  function tileHtml(id, extraClass) {
    return '<figure class="tile ' + (extraClass || '') + '" data-id="' + id + '">' +
      '<img loading="lazy" decoding="async" alt="Reel Fortune Angler #' + id + '" src="' + imgUrl(id) + '">' +
      '<figcaption><span>#' + id + '</span></figcaption></figure>';
  }
  function wireTileFallbacks(root) {
    root.querySelectorAll('img').forEach(function (img) {
      if (img.dataset.wired) return; img.dataset.wired = '1';
      img.addEventListener('error', function () { img.closest('.tile').classList.add('ph'); });
      img.addEventListener('load', function () { img.closest('.tile').classList.remove('ph'); });
      if (img.complete && img.naturalWidth === 0 && img.src) img.closest('.tile').classList.add('ph');
    });
  }

  // ---- status line / messages ---------------------------------------------
  function setStatus(kind, text, hash) {
    state.status = kind; state.message = text; if (hash !== undefined) state.txHash = hash;
    var el = $('status'); if (!el) return;
    el.className = 'status ' + kind;
    el.innerHTML = (kind === 'pending' ? '<span class="spin"></span>' : '') + esc(text);
    var link = $('txLink');
    if (link) {
      if (state.txHash) {
        var url = explorerTx(state.txHash);
        link.hidden = false;
        link.innerHTML = url ? 'tx <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(E.shortAddress(state.txHash)) + ' ↗</a>'
                             : 'tx <code title="' + esc(state.txHash) + '">' + esc(E.shortAddress(state.txHash)) + '</code>';
      } else link.hidden = true;
    }
    emit('status', { kind: kind, text: text, hash: state.txHash });
  }

  // ---- rendering -----------------------------------------------------------
  function renderChain() {
    var dot = $('netDot'), name = $('netName');
    if (name) name.textContent = chain.name;
    if (dot) dot.className = 'dot ' + (state.rpcOk === false ? 'bad' : state.rpcOk ? 'ok' : '');
    var fc = $('footContract');
    if (fc) {
      if (state.contract) {
        var a = explorerAddr(state.contract);
        fc.innerHTML = a ? '<a href="' + a + '" target="_blank" rel="noopener">' + esc(state.contract) + ' ↗</a>' : '<code>' + esc(state.contract) + '</code>';
      } else fc.textContent = 'not deployed on ' + chain.name + ' yet';
    }
    var fcn = $('footChain'); if (fcn) fcn.textContent = chain.name + ' · chain id ' + chainId;
    document.querySelectorAll('[data-chain-name]').forEach(function (el) { el.textContent = chain.name; });
    document.querySelectorAll('[data-currency]').forEach(function (el) { el.textContent = SYM; });
  }

  function renderSupply() {
    var minted = state.supply == null ? null : Number(state.supply);
    var max = state.maxSupply == null ? SIZE : Number(state.maxSupply);
    var pct = minted == null ? 0 : Math.min(100, minted / max * 100);
    var fill = $('supplyFill'); if (fill) fill.style.width = pct.toFixed(2) + '%';
    var bar = $('supplyBar'); if (bar) { bar.setAttribute('aria-valuenow', String(minted == null ? 0 : minted)); bar.setAttribute('aria-valuemax', String(max)); }
    var t = $('supplyText'); if (t) t.innerHTML = '<b>' + (minted == null ? '—' : minted.toLocaleString()) + '</b> / ' + max.toLocaleString() + ' minted';
    var p = $('supplyPct'); if (p) p.textContent = minted == null ? '' : (pct >= 99.95 && minted < max ? '99.9' : pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)) + '%';
    var pr = $('priceText'); if (pr) pr.textContent = state.price == null ? '—' : E.formatEther(state.price, 5);
    var total = $('totalText');
    if (total) total.textContent = state.price == null ? '—' : E.formatEther(state.price * BigInt(state.qty), 5) + ' ' + SYM;
    var mx = $('qtyMax'); if (mx) mx.textContent = state.maxPerWallet == null ? '' : 'max ' + Number(state.maxPerWallet) + ' per wallet';
    var q = $('qtyVal'); if (q) q.textContent = String(state.qty);
    var soldOut = minted != null && minted >= max;
    var pill = $('salePill');
    if (pill) {
      pill.hidden = false;
      if (!state.contract) { pill.className = 'pill off'; pill.textContent = 'not deployed'; }
      else if (state.rpcOk === false) { pill.className = 'pill off'; pill.textContent = 'rpc offline'; }
      else if (soldOut) { pill.className = 'pill gold'; pill.textContent = 'sold out'; }
      else if (state.saleActive === true) { pill.className = 'pill live'; pill.textContent = 'sale live'; }
      else if (state.saleActive === false) { pill.className = 'pill off'; pill.textContent = 'sale paused'; }
      else { pill.className = 'pill'; pill.textContent = 'loading…'; }
    }
  }

  function renderAccount() {
    var b = $('navConnect');
    if (b) {
      b.textContent = state.account ? E.shortAddress(state.account) : 'Connect';
      b.classList.toggle('on', !!state.account);
      b.title = state.account || 'Connect a wallet';
    }
    var wm = $('walletMsg');
    if (wm) {
      if (state.account) {
        var bits = [];
        if (state.balance != null) bits.push('<b>' + Number(state.balance) + '</b> angler' + (Number(state.balance) === 1 ? '' : 's') + ' held');
        if (state.mintedBy != null && state.maxPerWallet != null) bits.push('minted <b>' + Number(state.mintedBy) + '</b> of ' + Number(state.maxPerWallet) + ' allowed');
        var wrong = state.walletChainId != null && state.walletChainId !== chainId;
        wm.innerHTML = '<span class="who">' + esc(E.shortAddress(state.account)) + '</span>' + (bits.length ? ' · ' + bits.join(' · ') : '') +
          (wrong ? ' · <span class="warn">wallet is on chain ' + state.walletChainId + ' — switch to ' + esc(chain.name) + '</span>' : '');
      } else wm.innerHTML = state.hasWallet ? 'Connect a wallet to mint.' : 'No wallet detected — <a href="https://metamask.io/download/" target="_blank" rel="noopener">install MetaMask</a> to mint.';
    }
    var yours = $('yours');
    if (yours) yours.hidden = !state.account;
    var ym = $('yoursMeta');
    if (ym && state.account) ym.textContent = E.shortAddress(state.account) + ' · ' + (state.tokens.length ? state.tokens.length + ' angler' + (state.tokens.length === 1 ? '' : 's') : 'no anglers yet');
  }

  function renderMintButton() {
    var btn = $('mintBtn'), note = $('mintNote'); if (!btn) return;
    var minted = state.supply == null ? null : Number(state.supply);
    var max = state.maxSupply == null ? SIZE : Number(state.maxSupply);
    var busy = state.status === 'pending';
    var label, disabled = false, hint = '';
    if (!state.contract) { label = 'Contract not deployed on ' + chain.name + ' yet'; disabled = true; }
    else if (state.rpcOk === false) { label = 'RPC unreachable'; disabled = true; hint = 'Could not read the contract at ' + state.rpc + '.'; }
    else if (state.rpcOk == null) { label = 'Loading…'; disabled = true; }
    else if (minted != null && minted >= max) { label = 'Sold out'; disabled = true; hint = 'All ' + max + ' anglers have been minted.'; }
    else if (state.saleActive === false) { label = 'Sale not open yet'; disabled = true; hint = 'The owner has not opened the sale.'; }
    else if (!state.hasWallet) { label = 'Install MetaMask to mint'; disabled = true; }
    else if (!state.account) { label = 'Connect wallet to mint'; }
    else if (state.walletChainId != null && state.walletChainId !== chainId) { label = 'Switch to ' + chain.name; }
    else if (state.mintedBy != null && state.maxPerWallet != null && Number(state.mintedBy) >= Number(state.maxPerWallet)) { label = 'Wallet limit reached'; disabled = true; hint = 'This wallet already minted ' + Number(state.mintedBy) + '.'; }
    else {
      var q = state.qty;
      label = 'Mint ' + q + ' angler' + (q === 1 ? '' : 's') + (state.price != null ? ' · ' + E.formatEther(state.price * BigInt(q), 5) + ' ' + SYM : '');
      if (state.mintedBy != null && state.maxPerWallet != null) {
        var left = Number(state.maxPerWallet) - Number(state.mintedBy);
        if (q > left) { hint = 'Only ' + left + ' more allowed for this wallet.'; disabled = true; }
      }
    }
    btn.disabled = disabled || busy;
    btn.textContent = busy ? 'Minting…' : label;
    btn.classList.toggle('muted', disabled || busy);
    if (note) note.textContent = hint;
    var stepper = $('stepper'); if (stepper) stepper.classList.toggle('off', !state.contract || state.rpcOk === false);
  }

  function renderAll() { renderChain(); renderSupply(); renderAccount(); renderMintButton(); }

  // ---- on-chain reads (plain JSON-RPC, no wallet required) -----------------
  function read(sig, args) { return E.call(state.rpc, state.contract, E.encodeCall(sig, args || [])); }

  function readChain() {
    if (!state.contract) { state.rpcOk = null; renderAll(); return Promise.resolve(false); }
    return Promise.all([read('totalSupply()'), read('MAX_SUPPLY()'), read('mintPrice()'), read('maxPerWallet()'), read('saleActive()')])
      .then(function (r) {
        state.supply = E.decodeUint(r[0]); state.maxSupply = E.decodeUint(r[1]); state.price = E.decodeUint(r[2]);
        state.maxPerWallet = E.decodeUint(r[3]); state.saleActive = E.decodeBool(r[4]);
        state.rpcOk = true;
        if (state.qty > Number(state.maxPerWallet)) state.qty = Math.max(1, Number(state.maxPerWallet));
        renderAll(); emit('chain', { supply: state.supply, price: state.price });
        return true;
      })
      .catch(function (err) {
        state.rpcOk = false; renderAll();
        emit('rpcerror', { message: E.explainError(err) });
        return false;
      });
  }

  function loadAccount() {
    if (!state.account || !state.contract || state.rpcOk === false) { renderAccount(); renderMintButton(); return Promise.resolve(); }
    var me = state.account;
    return Promise.all([read('mintedBy(address)', [me]), read('balanceOf(address)', [me]), read('tokensOfOwner(address)', [me])])
      .then(function (r) {
        if (state.account !== me) return; // account changed mid-flight
        state.mintedBy = E.decodeUint(r[0]); state.balance = E.decodeUint(r[1]);
        state.tokens = E.decodeUintArray(r[2]).map(function (x) { return Number(x); });
        renderAccount(); renderMintButton();
        emit('account', { account: me, tokens: state.tokens.slice() });
        return loadYourAnglers(state.tokens);
      })
      .catch(function (err) { setStatus('error', E.explainError(err, SYM)); });
  }

  // ---- "Your Anglers" ------------------------------------------------------
  function cardHtml(id, meta) {
    var name = (meta && meta.name) || ('Reel Fortune Angler #' + id);
    var attrs = (meta && meta.attributes) || [];
    var rar = state.rarity;
    var rows = attrs.map(function (a) {
      var t = rar && rar.traits && rar.traits[a.trait_type] && rar.traits[a.trait_type][a.value];
      var pct = t ? Number(t.pct) : NaN;
      return { type: a.trait_type, value: a.value, pct: isFinite(pct) ? pct : null };
    });
    rows.sort(function (a, b) { return (a.pct == null ? 999 : a.pct) - (b.pct == null ? 999 : b.pct); });
    var top = rows.slice(0, 3).map(function (r) {
      var tier = r.pct == null ? 'common' : pctTier(r.pct);
      return '<li class="tr ' + tier + '"><span class="tt">' + esc(r.type) + '</span><span class="tv">' + esc(r.value) + '</span>' + (r.pct != null ? '<span class="tp">' + fmtPct(r.pct) + '</span>' : '') + '</li>';
    }).join('');
    var rk = rar && rar.tokens && rar.tokens[String(id)];
    var rank = rk ? Number(rk.rank) : NaN;
    var badge = isFinite(rank) ? '<span class="rank ' + rankTier(rank) + '">rank #' + esc(rank) + '<small>/ ' + esc(Number(rar.size) || SIZE) + '</small></span>' : '';
    return '<article class="card glass">' + tileHtml(id) + '<div class="cb"><h3>' + esc(name) + '</h3>' + badge +
      (top ? '<ul class="traits">' + top + '</ul>' : '<p class="dim">Metadata not exported yet.</p>') + '</div></article>';
  }

  function loadYourAnglers(ids) {
    var grid = $('yoursGrid'); if (!grid) return Promise.resolve();
    if (!ids.length) { grid.innerHTML = '<p class="empty">No anglers in this wallet yet — mint one above and it shows up here.</p>'; return Promise.resolve(); }
    grid.innerHTML = ids.map(function (id) { return cardHtml(id, null); }).join('');
    wireTileFallbacks(grid);
    return Promise.all(ids.map(function (id) { return fetchJson(jsonUrl(id)).catch(function () { return null; }); })).then(function (metas) {
      if (grid.children.length !== ids.length) return;
      grid.innerHTML = ids.map(function (id, i) { return cardHtml(id, metas[i]); }).join('');
      wireTileFallbacks(grid);
    });
  }

  // ---- wallet --------------------------------------------------------------
  function provider() { return window.ethereum; }

  function ensureChain() {
    var p = provider();
    var hex = E.toHex(BigInt(chainId));
    return p.request({ method: 'eth_chainId' }).then(function (id) {
      state.walletChainId = Number(id);
      if (state.walletChainId === chainId) return true;
      setStatus('pending', 'Switching your wallet to ' + chain.name + '…');
      return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
        .catch(function (err) {
          var code = err && (err.code != null ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
          var unknown = code === 4902 || /unrecognized chain|not been added|4902/i.test(String(err && err.message));
          if (!unknown) throw err;
          var add = { chainId: hex, chainName: chain.name, rpcUrls: chain.rpc, nativeCurrency: chain.currency };
          if (chain.explorer) add.blockExplorerUrls = [chain.explorer];
          return p.request({ method: 'wallet_addEthereumChain', params: [add] })
            .then(function () { return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); });
        })
        .then(function () { return p.request({ method: 'eth_chainId' }); })
        .then(function (id2) {
          state.walletChainId = Number(id2);
          if (state.walletChainId !== chainId) { var e = new Error('Wrong network — switch your wallet to ' + chain.name + '.'); e.code = 'WRONG_CHAIN'; throw e; }
          return true;
        });
    });
  }

  function connect() {
    var p = provider();
    if (!p) {
      state.hasWallet = false; renderAccount(); renderMintButton();
      setStatus('error', 'No wallet found. Install MetaMask (metamask.io/download) and reload.');
      emit('nowallet');
      return Promise.resolve(null);
    }
    setStatus('pending', 'Waiting for your wallet…');
    return p.request({ method: 'eth_requestAccounts' })
      .then(function (accs) {
        state.account = accs && accs[0] ? String(accs[0]).toLowerCase() : null;
        if (!state.account) throw new Error('The wallet returned no account.');
        renderAccount(); emit('connect', { account: state.account });
        setStatus('idle', '');
        return ensureChain().catch(function (err) { setStatus('error', E.explainError(err, SYM)); });
      })
      .then(function () { renderMintButton(); return loadAccount(); })
      .then(function () { if (state.status === 'pending') setStatus('idle', ''); return state.account; })
      .catch(function (err) { setStatus('error', E.explainError(err, SYM)); emit('error', { where: 'connect', message: state.message }); return null; });
  }

  function waitReceipt(hash) {
    var p = provider(), started = Date.now(), every = 1500, limit = 5 * 60 * 1000;
    return new Promise(function (resolve, reject) {
      (function poll() {
        p.request({ method: 'eth_getTransactionReceipt', params: [hash] }).then(function (rc) {
          if (rc && rc.blockNumber) return resolve(rc);
          if (Date.now() - started > limit) return reject(new Error('Still pending after 5 minutes — check the transaction in your wallet or explorer.'));
          setTimeout(poll, every);
        }).catch(function () {
          if (Date.now() - started > limit) return reject(new Error('Lost contact with the node while waiting for the receipt.'));
          setTimeout(poll, every * 2);
        });
      })();
    });
  }

  function renderMinted(ids) {
    var row = $('mintedRow'); if (!row) return;
    if (!ids.length) { row.hidden = true; return; }
    var pageUrl = location.protocol === 'file:' ? '' : ' ' + location.origin + location.pathname;
    var share = 'I just minted ' + ids.length + ' Reel Fortune Angler' + (ids.length === 1 ? '' : 's') + ' (#' + ids.join(', #') + ')!' + pageUrl;
    row.hidden = false;
    row.innerHTML = '<div class="minted-tiles">' + ids.map(function (id) { return tileHtml(id, 'sm'); }).join('') + '</div>' +
      '<div class="share">You own ' + (ids.length === 1 ? 'Angler #' + ids[0] : 'Anglers #' + ids.join(', #')) + '. ' +
      '<a href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(share) + '" target="_blank" rel="noopener">Share ↗</a> · ' +
      '<button type="button" class="linkish" id="copyShare">copy</button></div>';
    wireTileFallbacks(row);
    var cp = $('copyShare');
    if (cp) cp.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(share).then(function () { cp.textContent = 'copied'; }, function () { cp.textContent = 'copy failed'; });
    });
  }

  function mint(qty) {
    qty = Number(qty || state.qty);
    if (!state.contract) { setStatus('error', 'Contract not deployed on ' + chain.name + ' yet.'); return Promise.resolve(null); }
    if (state.status === 'pending') return Promise.resolve(null);
    if (!state.account) return connect().then(function (acc) { return acc ? mint(qty) : null; });
    if (state.saleActive === false) { setStatus('error', E.ERROR_TEXT['SaleNotActive()']); return Promise.resolve(null); }
    if (!(qty >= 1) || (state.maxPerWallet != null && qty > Number(state.maxPerWallet))) { setStatus('error', 'Quantity must be 1–' + Number(state.maxPerWallet || 1) + '.'); return Promise.resolve(null); }
    if (state.price == null) { setStatus('error', 'Price not loaded yet — try again in a moment.'); return Promise.resolve(null); }
    var p = provider();
    var tx = { from: state.account, to: state.contract, value: E.toHex(state.price * BigInt(qty)), data: E.encodeCall('mint(uint256)', [qty]) };
    state.minted = []; renderMinted([]);
    setStatus('pending', 'Checking the mint with the contract…', null);
    renderMintButton();
    emit('mint:start', { qty: qty, tx: tx });
    return ensureChain()
      .then(function () { return p.request({ method: 'eth_estimateGas', params: [tx] }); })
      .then(function () { setStatus('pending', 'Confirm the transaction in your wallet…'); return p.request({ method: 'eth_sendTransaction', params: [tx] }); })
      .then(function (hash) {
        setStatus('pending', 'Transaction sent — waiting for confirmation…', hash);
        emit('mint:sent', { hash: hash });
        return waitReceipt(hash);
      })
      .then(function (rc) {
        if (rc.status !== '0x1' && Number(rc.status) !== 1) throw new Error('The transaction reverted on-chain.');
        var ids = E.parseReceiptTransfers(rc.logs, state.account).map(function (t) { return Number(t.tokenId); });
        state.minted = ids;
        setStatus('ok', ids.length ? 'Minted ' + ids.length + ' angler' + (ids.length === 1 ? '' : 's') + ' — #' + ids.join(', #') + ' ' + (ids.length === 1 ? 'is' : 'are') + ' yours!' : 'Confirmed, but no Transfer to you was found in the receipt.');
        renderMinted(ids);
        emit('mint:done', { ids: ids, hash: state.txHash });
        return refresh().then(function () { return ids; });
      })
      .catch(function (err) {
        setStatus('error', E.explainError(err, SYM));
        renderMintButton();
        emit('error', { where: 'mint', message: state.message, error: err });
        return null;
      });
  }

  function refresh() {
    return readChain().then(function () { return loadAccount(); }).then(function () { renderAll(); emit('refresh'); });
  }

  function setQty(q) {
    var max = state.maxPerWallet == null ? 5 : Math.max(1, Number(state.maxPerWallet));
    state.qty = Math.min(max, Math.max(1, q | 0));
    renderSupply(); renderMintButton();
  }

  // ---- preview strip -------------------------------------------------------
  var strip = { ids: [], timer: null, rand: null };
  function buildStrip() {
    var el = $('strip'); if (!el) return;
    var seed = Number(params.get('seed')) || ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    state.seed = seed; strip.rand = mulberry32(seed);
    var n = 12, used = {}; strip.ids = [];
    while (strip.ids.length < n) { var id = 1 + Math.floor(strip.rand() * SIZE); if (!used[id]) { used[id] = 1; strip.ids.push(id); } }
    state.strip = strip.ids.slice();
    el.innerHTML = strip.ids.map(function (id) { return tileHtml(id); }).join('');
    wireTileFallbacks(el);
    if (!reduceMotion) startCycle();
  }
  function startCycle() {
    if (strip.timer) return;
    strip.timer = setInterval(function () {
      if (document.hidden) return;
      var el = $('strip'); if (!el) return;
      var slot = Math.floor(strip.rand() * strip.ids.length);
      var id; do { id = 1 + Math.floor(strip.rand() * SIZE); } while (strip.ids.indexOf(id) >= 0);
      strip.ids[slot] = id; state.strip = strip.ids.slice();
      var fig = el.children[slot]; if (!fig) return;
      fig.classList.add('out');
      setTimeout(function () {
        fig.outerHTML = tileHtml(id, 'in');
        var nf = el.children[slot]; wireTileFallbacks(el);
        requestAnimationFrame(function () { nf.classList.remove('in'); });
      }, 260);
    }, 3500);
  }

  // ---- traits & rarity -----------------------------------------------------
  function renderRarity() {
    var grid = $('rarityGrid'), note = $('rarityNote'); if (!grid) return;
    var rar = state.rarity;
    if (!rar || !rar.traits) {
      grid.innerHTML = '';
      if (note) { note.hidden = false; note.textContent = 'Trait statistics appear here once the collection is exported (nft/rarity.json — see the README).'; }
      return;
    }
    if (note) note.hidden = true;
    var col = state.collection;
    var order = col && col.layers ? col.layers.map(function (l) { return l.trait_type; }) : Object.keys(rar.traits);
    Object.keys(rar.traits).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    grid.innerHTML = order.filter(function (t) { return rar.traits[t]; }).map(function (t) {
      var vals = Object.keys(rar.traits[t]).map(function (v) { var e = rar.traits[t][v] || {}; return { v: v, c: Number(e.count) || 0, p: Number(e.pct) || 0 }; });
      vals.sort(function (a, b) { return b.p - a.p; }); // commonest first, rarest last
      var max = vals.length && vals[0].p > 0 ? vals[0].p : 1;
      return '<div class="rcol glass"><h3>' + esc(t) + '<small>' + vals.length + ' options</small></h3><ul>' + vals.map(function (x) {
        return '<li class="' + pctTier(x.p) + '"><span class="rn">' + esc(x.v) + '</span><span class="rb"><i style="width:' + (x.p / max * 100).toFixed(1) + '%"></i></span><span class="rp">' + fmtPct(x.p) + '</span></li>';
      }).join('') + '</ul></div>';
    }).join('');
    var tot = $('traitTotal');
    if (tot) {
      var opts = order.reduce(function (n, t) { return n + (rar.traits[t] ? Object.keys(rar.traits[t]).length : 0); }, 0);
      tot.textContent = String(opts);
    }
  }
  function loadRarity() {
    return Promise.all([fetchJson(CFG.assets.rarity).catch(function () { return null; }), fetchJson(CFG.assets.collection).catch(function () { return null; })])
      .then(function (r) { state.rarity = r[0]; state.collection = r[1]; renderRarity(); emit('rarity', { ok: !!r[0] }); });
  }

  // ---- wiring --------------------------------------------------------------
  function wire() {
    var nc = $('navConnect'); if (nc) nc.addEventListener('click', function () { if (!state.account) connect(); else { var y = $('yours'); if (y) y.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); } });
    var mb = $('mintBtn'); if (mb) mb.addEventListener('click', function () {
      if (!state.account) return connect();
      if (state.walletChainId != null && state.walletChainId !== chainId) return ensureChain().then(function () { renderAccount(); renderMintButton(); return loadAccount(); }).catch(function (err) { setStatus('error', E.explainError(err, SYM)); });
      mint(state.qty);
    });
    var mi = $('qtyMinus'); if (mi) mi.addEventListener('click', function () { setQty(state.qty - 1); });
    var pl = $('qtyPlus'); if (pl) pl.addEventListener('click', function () { setQty(state.qty + 1); });
    wireProvider();
    // wallets that inject after our script ran (EIP-1193 `ethereum#initialized`)
    window.addEventListener('ethereum#initialized', function () {
      if (!provider()) return;
      state.hasWallet = true; wireProvider(); renderAccount(); renderMintButton();
    });
  }

  var providerWired = null;
  function wireProvider() {
    var p = provider();
    if (!p || providerWired === p) return;
    providerWired = p;
    if (typeof p.on === 'function') {
      p.on('accountsChanged', function (accs) {
        var next = accs && accs[0] ? String(accs[0]).toLowerCase() : null;
        state.account = next; state.tokens = []; state.mintedBy = null; state.balance = null; state.minted = [];
        renderMinted([]); setStatus('idle', '', null);
        renderAccount(); renderMintButton();
        emit('accountsChanged', { account: next });
        if (next) loadAccount();
      });
      p.on('chainChanged', function (id) {
        state.walletChainId = Number(id);
        renderAccount(); renderMintButton();
        emit('chainChanged', { chainId: state.walletChainId });
        if (state.account && state.walletChainId !== chainId) setStatus('error', 'Your wallet moved to chain ' + state.walletChainId + ' — switch back to ' + chain.name + ' to mint.');
        else if (state.status === 'error') setStatus('idle', '');
      });
      // silently pick up an already-authorised account (no popup)
      p.request({ method: 'eth_accounts' }).then(function (accs) {
        if (accs && accs[0] && !state.account) { state.account = String(accs[0]).toLowerCase(); renderAccount(); return p.request({ method: 'eth_chainId' }).then(function (id) { state.walletChainId = Number(id); renderMintButton(); return loadAccount(); }); }
      }).catch(function () { /* wallet locked */ });
    }
  }

  function boot() {
    wire(); renderAll(); buildStrip();
    var t = $('titleChain'); if (t) t.textContent = chain.name;
    Promise.all([loadRarity(), readChain()]).then(function () { emit('ready', { rpcOk: state.rpcOk }); });
  }

  window.RFMint = { connect: connect, refresh: refresh, mint: mint, setQty: setQty, state: state, events: events, chain: chain, chainId: chainId };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
