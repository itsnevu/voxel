/* ============================================================================
   economy.js — market demand, the Isle Exchange, and dividends.
   Ported 1:1 from the client (game.js §"rotating market demand" + "ISLE
   EXCHANGE"). Pure functions over an explicit state; no I/O, no db.

   Prices are a deterministic function of the wall-clock epoch — the client
   draws the same curve from the same `hash`/`vnoise`, so quotes shown in the
   UI and prices settled here agree without any price feed. That also means
   the noise functions and salts are frozen: change one and every portfolio in
   every save is silently repriced.
   ============================================================================ */

import { hash, vnoise, int0 } from './rules.js';

/* ============================================================================
   ROTATING MARKET DEMAND
   Every 3 minutes one category is HOT (×1.6) and one is SURPLUS (×0.75).
   ============================================================================ */
export const MKT_CATS = ['fish', 'wood', 'coal', 'iron', 'gold', 'diamond'];
export const MKT_MS = 180000;

/** Current market epoch (3-minute ticks since the unix epoch). */
export const mktEpochNow = () => Math.floor(Date.now() / MKT_MS);

/** The hot/cold pair for a given epoch — pure, so the future is predictable. */
export function mktModsAt(e) {
  const hi = Math.floor(hash(e, 7) * MKT_CATS.length) % MKT_CATS.length;
  let lo = Math.floor(hash(e, 13) * (MKT_CATS.length - 1)) % (MKT_CATS.length - 1);
  if (lo >= hi) lo++;
  return { hot: MKT_CATS[hi], cold: MKT_CATS[lo] };
}

/** The hot/cold pair right now. */
export const mktMods = () => mktModsAt(mktEpochNow());

/**
 * Sell-price multiplier for a category.
 * `epoch` is optional and exists so a handler can settle a trade against the
 * epoch it validated, rather than re-reading the clock mid-request.
 */
export function priceMult(cat, epoch) {
  const m = mktModsAt(Number.isFinite(+epoch) ? +epoch : mktEpochNow());
  return cat === m.hot ? 1.6 : cat === m.cold ? 0.75 : 1;
}

/* ============================================================================
   ISLE EXCHANGE — five fictional stocks priced purely from the real clock.
   Holders earn dividends every quarter (20 epochs = 1 hour), even offline.
   ============================================================================ */
export const STOCKS = {
  DIGG: { name: 'Deep Digg Mining Co.',   base: 60,  vol: 1.0,  cats: ['coal', 'iron', 'gold', 'diamond'], yield: 0.008, salt: 101 },
  REEL: { name: 'Reel Fortune Fisheries', base: 40,  vol: 0.8,  cats: ['fish'],                            yield: 0.009, salt: 211 },
  LUMB: { name: 'Lumberline Timber',      base: 25,  vol: 0.55, cats: ['wood'],                            yield: 0.012, salt: 307 },
  EEL:  { name: 'Spinning Eel Ent.',      base: 90,  vol: 1.8,  cats: [],                                  yield: 0,     salt: 401 },
  HARB: { name: 'Harbor Star Lines',      base: 150, vol: 0.4,  cats: [],                                  yield: 0.015, salt: 503 }
};
export const STOCK_KEYS = Object.keys(STOCKS);
export const STOCK_CAP = 100;
export const DIV_Q = 20;

/** True when `k` names a tradeable ticker (input validation for handlers). */
export const isTicker = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(STOCKS, k);

/**
 * Mid price for ticker `k` at market epoch `e`.
 * slow + mid waves ride a per-ticker noise salt; `fast` is per-epoch jitter.
 * The regime swing (±8%/−6%) is deliberately smaller than the spread, so a
 * market tip is an edge, not an ATM.
 */
export function stockPrice(k, e) {
  const s = STOCKS[k];
  if (!s) return 0;
  const slow = (vnoise(e * 0.004, s.salt) - 0.5) * 2.0;
  const mid = (vnoise(e * 0.05, s.salt * 1.7) - 0.5) * 0.8;
  const fast = (hash(e, s.salt) - 0.5) * 0.15;
  const m = mktModsAt(e);
  const hotMul = s.cats.includes(m.hot) ? 1.08 : s.cats.includes(m.cold) ? 0.94 : 1;
  return Math.max(1, Math.round(s.base * Math.exp((slow + mid) * s.vol + fast) * hotMul));
}

/** What the player pays to buy — spread + flat fee folded in. */
export const stockAsk = (k, e) => Math.ceil(stockPrice(k, e) * 1.05) + 2;
/** What the player receives when selling. */
export const stockBid = (k, e) => Math.max(1, Math.floor(stockPrice(k, e) * 0.95) - 2);

/**
 * Drop one share certificate of `ticker` into `state`.
 *
 * Two guards, both ported from the client:
 *   - pity cap: at most one dropped share per market epoch, so a player
 *     spamming catch/mine can't farm certificates.
 *   - portfolio cap: at STOCK_CAP the share is auto-liquidated at the bid.
 *
 * Mutates `state` in place. Returns {granted:false} when the pity cap (or a
 * bad ticker / malformed state) blocks the drop, {granted:true, soldFor} when
 * the portfolio was full, {granted:true} otherwise.
 */
export function grantShare(state, ticker) {
  if (!state || typeof state !== 'object' || !isTicker(ticker)) return { granted: false };
  const st = state.stocks;
  if (!st || typeof st !== 'object') return { granted: false };
  if (!st.own || typeof st.own !== 'object') st.own = {};
  if (!st.basis || typeof st.basis !== 'object') st.basis = {};

  const e = mktEpochNow();
  /* pity-cap: at most 1 dropped share per market epoch */
  if (e <= (+st.lastShareEpoch || 0)) return { granted: false };
  st.lastShareEpoch = e;

  const n = st.own[ticker] | 0;
  if (n >= STOCK_CAP) {
    const soldFor = stockBid(ticker, e);
    /* int0, never `| 0`: ToInt32 wraps at 2^31, so a nine-figure purse taking
       a 90-coin credit came back NEGATIVE and normalised to 0 on next load */
    state.coins = int0(state.coins) + soldFor;
    return { granted: true, ticker, full: true, soldFor, own: n };
  }

  const p = stockPrice(ticker, e);
  st.basis[ticker] = ((st.basis[ticker] || p) * n + p) / (n + 1);
  st.own[ticker] = n + 1;
  const first = !st.gotFirst;
  st.gotFirst = 1;
  return { granted: true, ticker, price: p, own: n + 1, first };
}

/**
 * Pay every dividend quarter owed since the last payout.
 *
 * Quarters are wall-clock derived, so the ratchet matters: a save whose
 * `lastDiv` sits in the future (clock skew, an edited save, a restored
 * backup) is snapped forward and paid nothing, never paid twice. Offline
 * catch-up is capped at 24 quarters so a year-old save can't mint a fortune.
 *
 * Mutates `state` in place. Returns the total coins paid (0 if none).
 */
export function payDividends(state) {
  if (!state || typeof state !== 'object') return 0;
  const st = state.stocks;
  if (!st || typeof st !== 'object') return 0;
  if (!st.own || typeof st.own !== 'object') st.own = {};

  const dNow = Math.floor(Date.now() / (MKT_MS * DIV_Q));
  if (st.lastDiv == null || !Number.isFinite(+st.lastDiv) || +st.lastDiv > dNow) {
    st.lastDiv = dNow;
    return 0;
  }
  st.lastDiv = +st.lastDiv;
  if (dNow <= st.lastDiv) return 0;

  const from = Math.max(st.lastDiv + 1, dNow - 23); // offline catch-up: 24 quarters
  let tot = 0;
  for (let d = from; d <= dNow; d++) {
    for (const k of STOCK_KEYS) {
      const n = st.own[k] | 0;
      if (!n) continue;
      const s = STOCKS[k];
      /* 25% of quarters the board retains earnings */
      if (!s.yield || hash(d, s.salt + 77) <= 0.25) continue;
      tot += n * Math.ceil(stockPrice(k, d * DIV_Q) * s.yield);
    }
  }
  st.lastDiv = dNow;
  if (tot > 0) {
    if (!state.stats || typeof state.stats !== 'object') state.stats = {};
    state.coins = int0(state.coins) + tot;
    state.stats.earned = int0(state.stats.earned) + tot;
    state.stats.divEarned = int0(state.stats.divEarned) + tot;
  }
  return tot;
}

/**
 * A quote snapshot for the whole exchange — what the client needs to render
 * the Isle Exchange without recomputing prices it could then lie about.
 */
export function quoteAll(e = mktEpochNow()) {
  const out = {};
  for (const k of STOCK_KEYS) {
    out[k] = {
      name: STOCKS[k].name,
      yield: STOCKS[k].yield,
      price: stockPrice(k, e),
      prev: stockPrice(k, e - 1),
      ask: stockAsk(k, e),
      bid: stockBid(k, e)
    };
  }
  return { epoch: e, mods: mktModsAt(e), stocks: out };
}

/** Liquidation value of a portfolio at the bid (used by stats/net worth). */
export function portfolioValue(state, e = mktEpochNow()) {
  const own = state?.stocks?.own || {};
  let value = 0, cost = 0;
  for (const k of STOCK_KEYS) {
    const n = own[k] | 0;
    if (!n) continue;
    value += n * stockBid(k, e);
    cost += n * Math.round(state.stocks.basis?.[k] || stockPrice(k, e));
  }
  return { value, cost };
}
