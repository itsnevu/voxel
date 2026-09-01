/* RFEth — dependency-free EIP-1193 + ABI helpers for the Reel Fortune Anglers mint page.
   No ethers/viem: the page only needs static calls, one payable send and a receipt poll.
   Every selector below is hard-coded from `cast sig "<signature>"`; mint/test/selectors.test.js
   re-derives all of them and fails on any drift. Works in the browser (window.RFEth) and in
   Node (module.exports) so the test can exercise the same code. */
(function (root) {
  'use strict';

  // cast sig "<signature>" → first 4 bytes of keccak256(signature)
  var SELECTORS = {
    'mint(uint256)':          '0xa0712d68',
    'totalSupply()':          '0x18160ddd',
    'MAX_SUPPLY()':           '0x32cb6b0c',
    'mintPrice()':            '0x6817c76c',
    'maxPerWallet()':         '0x453c2310',
    'saleActive()':           '0x68428a1b',
    'mintedBy(address)':      '0x3cef28d2',
    'balanceOf(address)':     '0x70a08231',
    'tokensOfOwner(address)': '0x8462151c',
    'tokenURI(uint256)':      '0xc87b56dd',
    'owner()':                '0x8da5cb5b',
    'name()':                 '0x06fdde03',
    'symbol()':               '0x95d89b41'
  };

  // custom errors the contract reverts with (+ the two Solidity built-ins), for decoding revert data
  var ERRORS = {
    'SaleNotActive()':   '0xb7b24097',
    'InvalidQuantity()': '0x524f409b',
    'SoldOut()':         '0x52df9fe5',
    'WalletLimit()':     '0x5426a580',
    'WrongPayment()':    '0x788a686f',
    'Error(string)':     '0x08c379a0',
    'Panic(uint256)':    '0x4e487b71'
  };

  var ERROR_TEXT = {
    'SaleNotActive()':   'The sale is not open yet. Check back soon.',
    'InvalidQuantity()': 'That quantity is not allowed.',
    'SoldOut()':         'Not enough anglers left for that quantity.',
    'WalletLimit()':     'This wallet has reached its mint limit.',
    'WrongPayment()':    'The value sent does not match price × quantity.'
  };

  // keccak256("Transfer(address,address,uint256)")
  var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  var MAX_UINT256 = (1n << 256n) - 1n;

  function strip(h) {
    h = String(h);
    return (h.slice(0, 2) === '0x' || h.slice(0, 2) === '0X') ? h.slice(2) : h;
  }

  function toHex(n) {
    n = BigInt(n);
    if (n < 0n) throw new RangeError('toHex: negative value');
    return '0x' + n.toString(16);
  }

  function encodeUint(n) {
    n = BigInt(n);
    if (n < 0n || n > MAX_UINT256) throw new RangeError('encodeUint: out of uint256 range');
    return n.toString(16).padStart(64, '0');
  }

  function encodeAddress(a) {
    var h = strip(a).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) throw new TypeError('encodeAddress: not a 20-byte address: ' + a);
    return h.padStart(64, '0');
  }

  // 32-byte word #i of ABI-encoded data
  function word(hex, i) {
    var h = strip(hex);
    var w = h.substr(i * 64, 64);
    if (w.length !== 64 || !/^[0-9a-fA-F]+$/.test(w)) throw new RangeError('decode: return data too short (word ' + i + ')');
    return BigInt('0x' + w);
  }

  function decodeUint(hex, i) { return word(hex, i || 0); }
  function decodeBool(hex, i) { return word(hex, i || 0) !== 0n; }

  function decodeUintArray(hex) {
    var h = strip(hex);
    if (h === '') return [];
    var off = Number(word(h, 0) / 32n);
    var len = Number(word(h, off));
    var out = [];
    for (var k = 0; k < len; k++) out.push(word(h, off + 1 + k));
    return out;
  }

  function hexToBytes(h) {
    h = strip(h);
    var out = new Uint8Array(h.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function decodeString(hex) {
    var h = strip(hex);
    if (h === '') return '';
    var off = Number(word(h, 0) / 32n);
    var len = Number(word(h, off));
    var start = (off + 1) * 64;
    var body = h.substr(start, len * 2);
    if (body.length !== len * 2) throw new RangeError('decodeString: data too short');
    return bytesToUtf8(hexToBytes(body));
  }

  // 18-decimal fixed point → "0.005" style string, trailing zeros trimmed
  function formatEther(wei, decimals) {
    if (decimals == null) decimals = 4;
    wei = BigInt(wei);
    var neg = wei < 0n; if (neg) wei = -wei;
    var base = 10n ** 18n;
    var whole = wei / base, frac = wei % base;
    var fracStr = frac.toString().padStart(18, '0');
    var cut = fracStr.slice(0, decimals).replace(/0+$/, '');
    // a non-zero price smaller than the requested precision still has to show up as non-zero
    if (cut === '' && whole === 0n && frac > 0n) cut = fracStr.replace(/0+$/, '').slice(0, Math.max(decimals, fracStr.search(/[1-9]/) + 2));
    var s = whole.toString() + (cut ? '.' + cut : '');
    return (neg ? '-' : '') + s;
  }

  function shortAddress(a) {
    if (!a) return '';
    var h = strip(a);
    return '0x' + h.slice(0, 4) + '…' + h.slice(-4);
  }

  // ---- JSON-RPC / EIP-1193 -------------------------------------------------
  var rpcId = 0;

  function request(rpcOrProvider, method, params) {
    if (rpcOrProvider && typeof rpcOrProvider.request === 'function') {
      return Promise.resolve(rpcOrProvider.request({ method: method, params: params || [] }));
    }
    if (typeof rpcOrProvider !== 'string') return Promise.reject(new TypeError('request: need an RPC URL or an EIP-1193 provider'));
    var body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: method, params: params || [] });
    return fetch(rpcOrProvider, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
      .then(function (r) { if (!r.ok) throw new Error('RPC HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.error) {
          var e = new Error(j.error.message || 'RPC error');
          e.code = j.error.code; e.data = j.error.data;
          throw e;
        }
        return j.result;
      });
  }

  function call(rpcOrProvider, to, data) {
    return request(rpcOrProvider, 'eth_call', [{ to: to, data: data }, 'latest']);
  }

  function selector(sig) {
    var s = SELECTORS[sig];
    if (!s) throw new Error('unknown selector: ' + sig);
    return s;
  }

  // encodeCall('mint(uint256)', 3) → 0xa0712d68…03 ; only the value types this page uses
  function encodeCall(sig, args) {
    args = args || [];
    var types = sig.slice(sig.indexOf('(') + 1, -1);
    var list = types ? types.split(',') : [];
    if (list.length !== args.length) throw new Error('encodeCall: ' + sig + ' expects ' + list.length + ' args');
    var out = selector(sig);
    list.forEach(function (t, i) {
      if (t === 'address') out += encodeAddress(args[i]);
      else if (/^uint\d*$/.test(t)) out += encodeUint(args[i]);
      else if (t === 'bool') out += encodeUint(args[i] ? 1 : 0);
      else throw new Error('encodeCall: unsupported type ' + t);
    });
    return out;
  }

  // Transfer(address indexed from, address indexed to, uint256 indexed tokenId) logs → {from,to,tokenId}
  function parseReceiptTransfers(logs, to) {
    var want = to ? strip(to).toLowerCase() : null;
    var out = [];
    (logs || []).forEach(function (l) {
      if (!l || !l.topics || l.topics.length < 4) return;
      if (String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return;
      var from = '0x' + strip(l.topics[1]).slice(24).toLowerCase();
      var toA = '0x' + strip(l.topics[2]).slice(24).toLowerCase();
      if (want && strip(toA) !== want) return;
      out.push({ address: l.address, from: from, to: toA, tokenId: BigInt(l.topics[3]) });
    });
    return out;
  }

  // revert data (0x + selector + args) → { name, message }
  function decodeRevert(data) {
    if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
    var sel = data.slice(0, 10).toLowerCase();
    var rest = '0x' + data.slice(10);
    for (var name in ERRORS) {
      if (ERRORS[name] !== sel) continue;
      if (name === 'Error(string)') {
        var msg = ''; try { msg = decodeString(rest); } catch (e) { /* malformed */ }
        return { name: name, message: msg || 'The contract reverted.' };
      }
      if (name === 'Panic(uint256)') {
        var code = 0n; try { code = decodeUint(rest); } catch (e2) { /* malformed */ }
        return { name: name, message: 'The contract hit a panic (code ' + code.toString() + ').' };
      }
      return { name: name, message: ERROR_TEXT[name] || name };
    }
    return { name: 'unknown', message: 'The contract reverted (' + sel + ').' };
  }

  var KNOWN_SELECTOR = {};
  for (var errName in ERRORS) KNOWN_SELECTOR[ERRORS[errName]] = errName;

  // Wallets bury revert data in different places; dig it out of whatever error object we got.
  function findRevertData(err) {
    var seen = [];
    function walk(o, depth) {
      if (!o || depth > 5 || seen.indexOf(o) >= 0) return null;
      seen.push(o);
      if (typeof o === 'string') {
        // a message may quote the contract address before the revert data: prefer a hex blob
        // whose first 4 bytes are a selector we know, then anything that is not a bare address
        var all = o.match(/0x[0-9a-fA-F]{8,}/g) || [];
        for (var k = 0; k < all.length; k++) if (KNOWN_SELECTOR[all[k].slice(0, 10).toLowerCase()]) return all[k];
        for (var j = 0; j < all.length; j++) if (all[j].length !== 42) return all[j];
        return null;
      }
      if (typeof o !== 'object') return null;
      var keys = ['data', 'originalError', 'error', 'cause', 'info', 'message', 'reason'];
      for (var i = 0; i < keys.length; i++) {
        var v = o[keys[i]];
        if (v == null) continue;
        if (typeof v === 'string' && /^0x[0-9a-fA-F]{8}/.test(v)) return v;
        var r = walk(v, depth + 1);
        if (r) return r;
      }
      return null;
    }
    return walk(err, 0);
  }

  // Any wallet / RPC error → one readable sentence
  function explainError(err, currencySymbol) {
    if (!err) return 'Something went wrong.';
    var code = err.code != null ? err.code : (err.error && err.error.code);
    var msg = String(err.message || err.reason || err || '');
    var low = msg.toLowerCase();
    if (code === 4001 || code === 'ACTION_REJECTED' || /user rejected|user denied|rejected the request/.test(low)) return 'You cancelled the request in your wallet.';
    if (code === 4902) return 'This network is not in your wallet yet.';
    if (code === 4100 || /unauthorized/.test(low)) return 'The wallet has not authorised this site. Connect first.';
    if (code === -32002 || /already pending/.test(low)) return 'Your wallet already has a request open — check its window.';
    if (/insufficient funds/.test(low)) return 'Insufficient funds: this wallet cannot cover price + gas' + (currencySymbol ? ' in ' + currencySymbol : '') + '.';
    if (/nonce too low|replacement transaction/.test(low)) return 'A transaction from this wallet is still pending. Wait for it, then try again.';
    var data = findRevertData(err);
    var dec = data ? decodeRevert(data) : null;
    if (dec && dec.name !== 'unknown') return dec.message;
    if (/execution reverted|revert/.test(low)) return (dec && dec.message) || 'The contract rejected the transaction.';
    if (/failed to fetch|networkerror|load failed|network request failed/.test(low)) return 'Could not reach the RPC node. Is it running?';
    return msg.length > 160 ? msg.slice(0, 157) + '…' : (msg || 'Something went wrong.');
  }

  var RFEth = {
    SELECTORS: SELECTORS, ERRORS: ERRORS, ERROR_TEXT: ERROR_TEXT, TRANSFER_TOPIC: TRANSFER_TOPIC,
    toHex: toHex, encodeUint: encodeUint, encodeAddress: encodeAddress, encodeCall: encodeCall, selector: selector,
    decodeUint: decodeUint, decodeBool: decodeBool, decodeString: decodeString, decodeUintArray: decodeUintArray,
    formatEther: formatEther, shortAddress: shortAddress,
    request: request, call: call,
    parseReceiptTransfers: parseReceiptTransfers, decodeRevert: decodeRevert, findRevertData: findRevertData, explainError: explainError
  };

  root.RFEth = RFEth;
  if (typeof module !== 'undefined' && module.exports) module.exports = RFEth;
})(typeof window !== 'undefined' ? window : globalThis);
