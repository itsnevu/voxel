/* ============================================================================
   client-contract.test.js — the client half of the repo, checked without a browser.

   parity.test.js already proves the two copies of the ECONOMY agree. This proves
   the client still holds together as a program: that every file it loads exists,
   that every mod fills the slot it claims, that every event a mod listens for is
   one somebody actually fires, and that the action names it posts are the action
   names the server answers to.

   All of it is textual. game.js opens with `document.querySelector` and would
   throw on its first line under Node, so — exactly as parity.test.js does — the
   client files are read as TEXT. The one exception is parsing: `new vm.Script()`
   compiles a file without running a line of it, which is `node --check` for
   browser scripts and catches the typo that would otherwise only show up as a
   blank isle in a tab nobody opened.

   These tests need no server, no port and no database, so they cost nothing and
   cannot flake.
   ========================================================================== */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { HANDLERS } from '../src/game/actions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const INDEX = read('index.html');
const GAME = read('game.js');
const NET = read('net.js');

const MOD_FILES = fs.readdirSync(path.join(ROOT, 'mods'))
  .filter((f) => /^\d\d-[a-z]+\.js$/.test(f))
  .sort();
const MODS = new Map(MOD_FILES.map((f) => [f, read(path.join('mods', f))]));

/** Every `<script src>` and every local `<link href>` index.html asks for. */
function assetsOf(html) {
  const out = [];
  const push = (u) => { if (u && !/^(https?:)?\/\/|^data:|^#/.test(u)) out.push(u.split('?')[0]); };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) push(m[1]);
  for (const m of html.matchAll(/<meta\b[^>]*\b(?:property|name)="(?:og:image|twitter:image)"[^>]*\bcontent="([^"]+)"/g)) push(m[1]);
  return [...new Set(out)];
}

/** Every `fn('name'` in `src`, for a call spelled exactly `RF.on`, `.act`, … */
function calls(src, pattern) {
  const out = new Set();
  for (const m of src.matchAll(pattern)) out.add(m[1]);
  return out;
}

/**
 * True when the match at `idx` is inside a line comment or a block-comment body.
 * A cheap heuristic on purpose — it only has to keep prose ABOUT a banned call
 * from reading as the call itself, and every real call site in this codebase
 * starts a statement. */
function inComment(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const before = src.slice(lineStart, idx);
  return before.includes('//') || before.includes('/*') || /^\s*\*/.test(before);
}

/* --------------------------------------------------------------- loading -- */

describe('client · every file the page loads exists', () => {
  it('resolves every script, stylesheet, icon and share image', () => {
    for (const rel of assetsOf(INDEX)) {
      assert.ok(exists(rel), `index.html asks for ${rel}, which is not in the repo`);
    }
  });

  it('parses every client script', () => {
    const files = ['game.js', 'net.js', 'sw.js', ...MOD_FILES.map((f) => 'mods/' + f)];
    for (const rel of files) {
      assert.doesNotThrow(
        () => new vm.Script(read(rel), { filename: rel }),
        `${rel} does not parse`);
    }
  });

  it('keeps the manifest valid and its icons on disk', () => {
    const man = JSON.parse(read('manifest.webmanifest'));
    assert.ok(man.name && man.start_url, 'manifest needs a name and a start_url');
    assert.ok(man.icons.length > 0, 'manifest declares no icons');
    for (const ic of man.icons) {
      assert.ok(exists(ic.src), `manifest lists icon ${ic.src}, which is not in the repo`);
    }
  });

  it('keeps every file the service worker precaches on disk', () => {
    const src = read('sw.js');
    const block = src.slice(src.indexOf('const SHELL = ['), src.indexOf('];', src.indexOf('const SHELL = [')));
    const urls = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((u) => u !== './');
    assert.ok(urls.length > 5, 'the SHELL list was not found — did sw.js get restructured?');
    for (const u of urls) {
      assert.ok(exists(u), `sw.js precaches ${u}, which is not in the repo`);
    }
  });
});

/* ------------------------------------------------------------------ mods -- */

describe('client · the mod slots', () => {
  it('has a script tag for every mod file, and a file for every tag', () => {
    const tagged = assetsOf(INDEX).filter((u) => u.startsWith('mods/')).map((u) => u.slice(5)).sort();
    assert.deepEqual(tagged, MOD_FILES,
      'mods/SPEC.md §1: fill a slot in place — never add, rename or drop a file or its tag');
  });

  it('registers each mod under the name of its own slot', () => {
    for (const [file, src] of MODS) {
      const slot = file.replace(/\.js$/, '');
      const m = src.match(/RF\.mod\(\s*'([^']+)'/);
      assert.ok(m, `${file} never calls RF.mod()`);
      assert.equal(m[1], slot, `${file} registers as '${m[1]}' — it must be '${slot}'`);
    }
  });

  it('loads the mods in numeric order', () => {
    const tagged = assetsOf(INDEX).filter((u) => u.startsWith('mods/'));
    const nums = tagged.map((u) => Number(u.slice(5, 7)));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b),
      '00-notify must load first: it is the mod that catches every other mod');
  });

  it('uses no native dialog anywhere in the client', () => {
    /* mods/SPEC.md §11. The browser's own alert/prompt/confirm drop pointer lock,
       cannot be styled, and read as a page hijack — this game has RF.api.confirm
       and its own cards for all three. */
    const re = /(?<![.\w])(alert|prompt|confirm)\s*\(/g;
    for (const [rel, src] of [['game.js', GAME], ['net.js', NET], ...[...MODS].map(([f, s]) => ['mods/' + f, s])]) {
      for (const m of src.matchAll(re)) {
        if (inComment(src, m.index)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        assert.fail(`${rel}:${line} calls ${m[1]}() — use RF.api.confirm or your own UI`);
      }
    }
  });
});

/* ---------------------------------------------------------------- events -- */

describe('client · the RF event surface', () => {
  it('fires every event a mod listens for', () => {
    /* `error` is the documented exception: RF.err() calls those handlers
       DIRECTLY rather than through emit(), so a handler that throws cannot
       recurse into the funnel that is reporting it. */
    const DIRECT = new Set(['error']);
    const fired = new Set([
      ...calls(GAME, /RF\.emit\(\s*'([a-zA-Z]+)'/g),
      ...calls(GAME, /RF\.claim\(\s*'([a-zA-Z]+)'/g),
    ]);
    for (const src of MODS.values()) {
      for (const e of calls(src, /RF\.emit\(\s*'([a-zA-Z]+)'/g)) fired.add(e);
    }
    for (const [file, src] of MODS) {
      for (const e of calls(src, /RF\.on\(\s*'([a-zA-Z]+)'/g)) {
        assert.ok(fired.has(e) || DIRECT.has(e),
          `mods/${file} listens for '${e}', which nothing in game.js ever emits or claims`);
      }
    }
  });
});

/* --------------------------------------------------------------- actions -- */

describe('client · authoritative actions', () => {
  const clientActions = calls(GAME, /\.act\(\s*'([a-z]+)'/g);

  it('posts only actions the server answers to', () => {
    for (const name of clientActions) {
      assert.ok(HANDLERS[name],
        `game.js posts /api/action/${name}, which has no handler in src/game/actions.js`);
    }
  });

  it('leaves no server action unreachable from the client', () => {
    for (const name of Object.keys(HANDLERS)) {
      assert.ok(clientActions.has(name),
        `the server handles '${name}' but no client code ever posts it`);
    }
  });

  it('keeps a client route for every endpoint the game depends on', () => {
    /* net.js is the only place allowed to name an /api path; this catches the
       half-wired feature — a route built on the server that nothing ever calls,
       or a call to a route that was renamed underneath it. */
    for (const p of ['/api/state', '/api/save', '/api/report', '/api/derby',
                     '/api/leaderboard', '/api/client-error']) {
      assert.ok(NET.includes(`'${p}'`), `net.js has no caller for ${p}`);
    }
  });
});
