// On-chain character ownership.
//
// The wallet in server/src/wallet.js proves WHO a player is. This file answers
// the separate question of WHAT they may wear: which Reel Fortune Angler tokens
// the proven address actually holds, according to the chain and nothing else.
//
// The client is never asked. A browser saying "I own #417" is a claim anybody
// can type into a console, so every answer here comes from an eth_call made by
// this process to the configured RPC. The address it asks about is the one
// SIWE verified and stored on the account — never one from a request body.
//
// Nothing here spends gas, signs, or moves a token: eth_call is a read.

import { users } from './db.js';
import { requireAuth } from './auth.js';
import { child } from './log.js';

const log = child('nft');

/* ----------------------------------------------------------------------------
   CONFIGURATION
   ----------------------------------------------------------------------------
   The defaults are the local anvil deployment (contracts/deploy.sh), so a
   developer who runs anvil gets a working feature with no env at all. A real
   deployment sets all three. When the RPC simply is not there, this module
   reports "not configured" and the game carries on with the default hero —
   an unreachable chain must never be an unplayable game.
   -------------------------------------------------------------------------- */
/* UNSET falls back to the local anvil deployment; set-but-EMPTY means "there is
   no chain here", which is the honest answer on a box that cannot reach one.
   Reading these with `||` collapsed those two cases into one, so a deployment
   that emptied the variables kept advertising the dev contract and reported
   itself configured — the bug this distinction exists to prevent. */
const envOr = (name, fallback) =>
  (process.env[name] === undefined ? fallback : process.env[name]).trim();

const CHAIN_ID = Number(process.env.NFT_CHAIN_ID) > 0
  ? Math.trunc(Number(process.env.NFT_CHAIN_ID))
  : 31337;
const RPC_URL = envOr('NFT_RPC_URL', 'http://127.0.0.1:8545');
const CONTRACT = envOr('NFT_CONTRACT', '0x5FbDB2315678afecb367f032d93F642f64180aa3').toLowerCase();

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/* Function selectors, first 4 bytes of keccak256 of the signature. These are
   ERC-721 standard (plus the collection's own enumerator), so they are fixed
   for the life of the contract and cost nothing to hardcode. */
const SEL_TOKENS_OF_OWNER = '0x8462151c';   // tokensOfOwner(address)
const SEL_BALANCE_OF      = '0x70a08231';   // balanceOf(address)

/* A chain call is a network call to a machine we do not control, sitting in
   front of a player pressing a button. Bounded, or a stalled RPC becomes a
   stalled request handler. */
const RPC_TIMEOUT_MS = 6000;

/* Ownership barely moves and the answer is per-address, so a short cache turns
   "open the wardrobe" from an RPC round trip into a map read — while staying
   short enough that a token sold two minutes ago stops being wearable. */
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();   // addrLower -> { ids, at }

/** True when a chain is actually reachable-in-principle: config is well formed. */
export function nftConfigured() {
  return ADDRESS_RE.test(CONTRACT) && /^https?:\/\//.test(RPC_URL);
}

export function nftConfig() {
  return {
    chainId: CHAIN_ID,
    contract: CONTRACT,
    configured: nftConfigured(),
    // the site switch, so the client can drop its own link to a closed door
    mintOpen: (process.env.MINT_OPEN === undefined ? '1' : process.env.MINT_OPEN).trim() !== '0',
  };
}

/** 32-byte left-padded hex body for an address argument, no 0x. */
function padAddress(addrLower) {
  return addrLower.slice(2).padStart(64, '0');
}

/** One JSON-RPC eth_call. Returns the '0x…' result, or throws. */
async function ethCall(data) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: CONTRACT, data }, 'latest'],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = await res.json();
    if (body && body.error) throw new Error(body.error.message || 'rpc error');
    const out = body && body.result;
    if (typeof out !== 'string' || !out.startsWith('0x')) throw new Error('rpc gave no result');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode an ABI `uint256[]` return: a 32-byte offset, a 32-byte length, then
 * that many 32-byte words.
 *
 * The length is read as a BigInt and sanity-checked against the bytes actually
 * returned before it is used to size anything. A contract (or a lying RPC) that
 * answers with a length of 2^256-1 must not become an allocation.
 */
function decodeUintArray(hex) {
  const body = hex.slice(2);
  if (body.length < 128) return [];                 // offset + length minimum
  const words = body.length / 64;

  const offsetWords = Number(BigInt('0x' + body.slice(0, 64)) / 32n);
  const lenAt = offsetWords * 64;
  if (!Number.isSafeInteger(offsetWords) || lenAt + 64 > body.length) return [];

  const len = BigInt('0x' + body.slice(lenAt, lenAt + 64));
  if (len > BigInt(words)) return [];               // longer than the payload: nonsense

  const out = [];
  for (let i = 0; i < Number(len); i++) {
    const at = lenAt + 64 + i * 64;
    if (at + 64 > body.length) break;
    out.push(Number(BigInt('0x' + body.slice(at, at + 64))));
  }
  return out;
}

/**
 * Token ids held by `addrLower`, newest call cached for CACHE_TTL_MS.
 *
 * Returns { ok, ids, reason }. A chain that cannot be reached is `ok: false`
 * with the tokens the player last had — NOT an empty list, which the wardrobe
 * would render as "you own nothing" and quietly undress somebody whose only
 * problem is a flaky RPC.
 */
export async function tokensOf(addrLower, { fresh = false } = {}) {
  if (!ADDRESS_RE.test(addrLower)) return { ok: false, ids: [], reason: 'BAD_ADDRESS' };
  if (!nftConfigured()) return { ok: false, ids: [], reason: 'NOT_CONFIGURED' };

  const now = Date.now();
  const hit = cache.get(addrLower);
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return { ok: true, ids: hit.ids, cached: true };

  try {
    const raw = await ethCall(SEL_TOKENS_OF_OWNER + padAddress(addrLower));
    const ids = decodeUintArray(raw);
    cache.set(addrLower, { ids, at: now });
    return { ok: true, ids };
  } catch (err) {
    log.warn({ msg: 'ownership lookup failed', err: String(err && err.message || err) });
    return { ok: false, ids: hit ? hit.ids : [], reason: 'CHAIN_UNREACHABLE', stale: !!hit };
  }
}

/** Does this address hold this token id right now? The gate for equipping one. */
export async function ownsToken(addrLower, tokenId) {
  const id = Number(tokenId);
  if (!Number.isInteger(id) || id <= 0) return false;
  // fresh: equipping is rare and worth a round trip, and it is the one moment
  // where a minute-stale cache would let a sold token be worn.
  const res = await tokensOf(addrLower, { fresh: true });
  return res.ok && res.ids.includes(id);
}

/** Drop a cached answer, e.g. right after the player mints. */
export function forget(addrLower) {
  cache.delete(String(addrLower).toLowerCase());
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountNft(app) {
  /* What the client needs to point a mint button at the right chain. Public on
     purpose: it is the same data the mint page ships in mint/config.js. */
  app.get('/api/nft/config', (req, res) => res.json(nftConfig()));

  /* The player's own collection. The address comes from THEIR account row, so
     there is no address parameter to tamper with and no way to ask about
     somebody else's wallet. */
  app.get('/api/nft/characters', requireAuth, async (req, res) => {
    const row = users.findById(req.userId);
    if (!row) return res.status(401).json({ error: 'not authenticated', code: 'UNAUTHENTICATED' });

    const addr = row.wallet ? String(row.wallet).toLowerCase() : '';
    if (!addr) {
      // A guest or password account. Not an error — it is the default hero, and
      // the client renders that as "connect a wallet to wear an Angler".
      return res.json({ wallet: '', tokens: [], configured: nftConfigured(), reason: 'NO_WALLET' });
    }

    const fresh = req.query.fresh === '1';
    const out = await tokensOf(addr, { fresh });
    res.json({
      wallet: addr,
      tokens: out.ids,
      configured: nftConfigured(),
      chainId: CHAIN_ID,
      contract: CONTRACT,
      ok: out.ok,
      stale: !!out.stale,
      reason: out.reason || '',
    });
  });
}
