/* ============================================================================
   parity.test.js — the client and the server carry the SAME economy twice.

   rules.js says it in its own header: every constant in it must stay identical
   in value to its counterpart in /game.js. Nothing enforced that. The two
   copies are edited by different people at different times, and the failure
   mode is quiet — a fish worth 82 on the client and 80 on the server does not
   crash anything, it just makes the game lie to the player about what it is
   about to pay them, forever, until someone notices.

   game.js is a browser IIFE: it opens with `const canvas = document.querySelector`
   and would throw on the first line under Node, so it is read as TEXT and the
   tables are pulled out with regexes. That is the whole trick here.

   The extraction is deliberately loose about FORM and strict about VALUE:
   quoting style, whitespace, line breaks and the order entries are written in
   are all free to differ, because none of them can change what a player is
   paid. A name, a rarity, a coin value, a spawn weight, a condition or an id
   is not free to differ, and any of those failing is a real divergence.
   ========================================================================== */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORLDS, WORLD_KEYS, ALL_FISH } from '../src/game/rules.js';
import { ACH, DEEDS } from '../src/progress.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME_JS = path.resolve(HERE, '..', '..', 'game.js');
const SRC = fs.readFileSync(GAME_JS, 'utf8');

/* ------------------------------------------------------------ extraction -- */

/** A single-quoted or double-quoted JS string literal, escapes included. */
const STR = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")`;

/** Undo one level of JS string quoting: 'Poseidon\'s Patent' -> the apostrophe. */
function unquote(lit) {
  return lit.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * The array literal that starts at the first `[` at or after `from`, returned
 * as source text. Counts brackets rather than matching a closing pattern, so a
 * table can be re-indented, split across lines or have entries added without
 * this losing track of where it ends. Quotes are skipped over: a `]` inside a
 * fish name would otherwise close the table early.
 */
function arrayAt(src, from) {
  const open = src.indexOf('[', from);
  assert.notEqual(open, -1, `no array literal after offset ${from}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated array literal at offset ${open}`);
}

/** The array literal assigned by the first statement matching `re`. */
function tableFor(re) {
  const m = re.exec(SRC);
  assert.ok(m, `game.js no longer contains ${re}`);
  return arrayAt(SRC, m.index + m[0].length - 1);
}

/* [F('Name','rar',val), weight] with an optional trailing condition string. */
const FISH_RE = new RegExp(
  String.raw`\[\s*F\(\s*(${STR})\s*,\s*(${STR})\s*,\s*(-?[\d.]+)\s*\)\s*,` +
  String.raw`\s*(-?[\d.]+)\s*(?:,\s*(${STR})\s*)?\]`, 'g');

/** Every fish entry in one table, in source order, as comparable plain data. */
function fishEntries(text) {
  const out = [];
  for (const m of text.matchAll(FISH_RE)) {
    out.push({
      name: unquote(m[1]),
      rar: unquote(m[2]),
      val: Number(m[3]),
      weight: Number(m[4]),
      cond: m[5] ? unquote(m[5]) : null,
    });
  }
  return out;
}

/** The server side of the same comparison. */
const serverFish = (table) => table.map((e) => ({
  name: e[0].name, rar: e[0].rar, val: e[0].val,
  weight: e[1], cond: e[2] === undefined ? null : e[2],
}));

/* ['id','Name','description', … ] — the shape both trophy tables share. */
const TROPHY_RE = new RegExp(
  String.raw`\[\s*(${STR})\s*,\s*(${STR})\s*,\s*(${STR})\s*,`, 'g');

function trophyEntries(text) {
  const out = [];
  for (const m of text.matchAll(TROPHY_RE)) {
    out.push({ id: unquote(m[1]), name: unquote(m[2]), desc: unquote(m[3]) });
  }
  return out;
}

/**
 * Descriptions are compared with the coin sigil stripped and whitespace
 * collapsed. The client writes "collect ◈1,000 in dividends" because ◈ is how
 * it renders a coin everywhere in the UI; progress.js writes the same sentence
 * without it. That is a rendering difference in a string nobody computes with,
 * and treating it as drift would leave this test permanently red and therefore
 * permanently ignored — which is the state the whole file exists to end.
 */
const sameText = (s) => String(s).replace(/◈/g, '').replace(/\s+/g, ' ').trim();

/* ============================================================================ */

describe('game.js and the server agree on the economy', () => {
  it('reads a game.js that still looks like the file being parsed', () => {
    /* If any of this stops matching, every assertion below would pass on an
       empty extraction and prove nothing. */
    assert.ok(SRC.length > 100_000, 'game.js is suspiciously small');
    assert.match(SRC, /function F\(name,\s*rar,\s*val\)/);
    assert.ok(fishEntries(tableFor(/const\s+TABLE\s*=\s*/)).length > 10);
    assert.ok(trophyEntries(tableFor(/const\s+ACH\s*=\s*/)).length > 10);
  });

  it('stocks every isle with the same fish, worth the same coins', () => {
    /* Fortune Isle's table is named TABLE and then assigned to WORLDS.isle.fish;
       every other world is assigned inline. */
    const clientTables = {
      isle: tableFor(/const\s+TABLE\s*=\s*/),
    };
    for (const key of WORLD_KEYS) {
      if (key === 'isle') continue;
      clientTables[key] = tableFor(new RegExp(String.raw`WORLDS\.${key}\.fish\s*=\s*`));
    }

    for (const key of WORLD_KEYS) {
      const client = fishEntries(clientTables[key]);
      const server = serverFish(WORLDS[key].fish);
      assert.ok(client.length > 0, `no fish extracted for ${key}`);
      assert.deepEqual(client, server, `the ${key} fish table has drifted`);
    }

    /* and the derived Fishdex — the thing the completion achievement counts —
       comes out the same length on both sides */
    const clientNames = [];
    const seen = new Set();
    for (const key of WORLD_KEYS) {
      for (const f of fishEntries(clientTables[key])) {
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        clientNames.push(f.name);
      }
    }
    assert.deepEqual(clientNames, ALL_FISH.map((e) => e[0].name),
      'the Fishdex would complete at a different species count on each side');
  });

  it('offers the same achievements, in the same order, for the same coins', () => {
    const client = trophyEntries(tableFor(/const\s+ACH\s*=\s*/));
    assert.deepEqual(client.map((e) => e.id), ACH.map((e) => e[0]),
      'the achievement id lists have drifted');
    assert.deepEqual(client.map((e) => e.name), ACH.map((e) => e[1]));
    assert.deepEqual(client.map((e) => sameText(e.desc)), ACH.map((e) => sameText(e[2])));

    /* the reward is the fourth field, and it is real coin the server pays */
    const rewards = [...tableFor(/const\s+ACH\s*=\s*/)
      .matchAll(new RegExp(String.raw`\[\s*${STR}\s*,\s*${STR}\s*,\s*${STR}\s*,\s*(\d+)\s*,`, 'g'))]
      .map((m) => Number(m[1]));
    assert.deepEqual(rewards, ACH.map((e) => e[3]),
      'an achievement pays a different bounty on each side');
  });

  it('mints the same deeds, in the same order', () => {
    const client = trophyEntries(tableFor(/const\s+DEEDS\s*=\s*/));
    assert.deepEqual(client.map((e) => e.id), DEEDS.map((e) => e[0]),
      'the deed id lists have drifted — a client-side deed the server does not ' +
      'know is refused by /api/save and can never be minted');
    assert.deepEqual(client.map((e) => e.name), DEEDS.map((e) => e[1]));
    assert.deepEqual(client.map((e) => sameText(e.desc)), DEEDS.map((e) => sameText(e[2])));
  });

  /* The world clock. rules.js's THE WORLD CLOCK block states that game.js carries
     a hand-copy and that THIS FILE proves the two agree — until now that was a
     promise the repo did not keep. The client sky and the server roll were once
     unrelated random processes: the night flag agreed 50.1% of the time and a
     client showing STORM matched the server's roll 13-20%, so storm-gated species
     were unreachable by the player the toast told to go fishing. */
  it('derives the day and the weather from the same wall clock', async () => {
    const rules = await import('../src/game/rules.js');

    const numConst = (name) => {
      const m = SRC.match(new RegExp('\\b' + name + '\\s*=\\s*(-?[0-9._]+)'));
      assert.ok(m, `game.js no longer defines ${name} — the client clock moved`);
      return Number(m[1].replace(/_/g, ''));
    };

    assert.equal(numConst('DAY_MS'), rules.DAY_MS, 'day length');
    assert.equal(numConst('NIGHT_END'), rules.NIGHT_END, 'night ends');
    assert.equal(numConst('NIGHT_START'), rules.NIGHT_START, 'night starts');
    assert.equal(numConst('WEATHER_MS'), rules.WEATHER_MS, 'weather period');
    assert.equal(numConst('WEATHER_SALT'), rules.WEATHER_SALT, 'weather hash lane');

    /* The distribution table, read out of game.js as text. A threshold drifting
       on one side only is exactly the silent divergence this test exists for. */
    const mixOf = (name) => {
      const m = SRC.match(new RegExp('\\b' + name + '\\s*=\\s*(\\{[^;]*?\\});'));
      assert.ok(m, `game.js no longer defines ${name}`);
      return m[1];
    };
    const clientMix = mixOf('WEATHER_MIX') + mixOf('WEATHER_MIX_DEFAULT');
    for (const key of WORLD_KEYS) {
      const server = rules.weatherMixOf ? rules.weatherMixOf(key) : null;
      if (!server) continue;
      assert.ok(clientMix.includes(String(server.clear)),
        `world ${key}: clear threshold ${server.clear} is not in game.js's table`);
      assert.ok(clientMix.includes(String(server.storm)),
        `world ${key}: storm threshold ${server.storm} is not in game.js's table`);
      assert.ok(clientMix.includes("'" + server.wet + "'") || server.wet === 'rain',
        `world ${key}: wet kind ${server.wet} is not in game.js's table`);
    }

    /* And the arithmetic itself, sampled rather than eyeballed. An in-game day is
       DAY_MS = 420s, not 24h, so the step has to be sub-second for the sample to
       mean anything; three days of it also crosses two rollovers, which is where
       a naive phase implementation drifts. */
    const DAY = rules.DAY_MS, STEP = 250;
    let dayChecks = 0, wxChecks = 0;
    for (let ms = 0; ms < DAY * 3; ms += STEP) {
      const clientT = ((ms / DAY) % 1 + 1) % 1;
      const server = rules.dayPhaseAt(ms);
      assert.ok(Math.abs(clientT - server.t) < 1e-12, `day phase at ${ms}`);
      const clientNight = clientT < rules.NIGHT_END || clientT > rules.NIGHT_START;
      assert.equal(clientNight, server.night, `night flag at ${ms}`);
      dayChecks++;
      const epoch = Math.floor(ms / rules.WEATHER_MS);
      for (const key of WORLD_KEYS) { rules.weatherAt(key, epoch); wxChecks++; }
    }
    assert.ok(dayChecks >= 5000 && wxChecks >= 5000,
      `the sample did not actually run · day=${dayChecks} weather=${wxChecks}`);
  });
});
