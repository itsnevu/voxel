# `mods/` — the Reel Fortune 3D mod contract

Every file in this folder is a **self-contained feature**. It never edits `game.js`,
`index.html` or `net.js`; it hangs itself off the `RF` mod host that `game.js`
publishes on `window`. A mod that throws while loading is caught by the host and
reported — it can't take the game down with it.

---

## 1. The shape of a mod

The fifteen slots already exist as stubs, already have their `<script>` tags in
`index.html`, and load in numeric order. **Fill your slot in place — never rename
it, never add a file, never add a tag.**

| file | mod name | owns |
|---|---|---|
| `00-notify.js` | `00-notify` | notifications + the error centre (loads first, so it catches every other mod) |
| `01-angler.js` | `01-angler` | fishing depth |
| `02-hud.js` | `02-hud` | the heads-up display |
| `03-panels.js` | `03-panels` | tooltips, inspect, the codex |
| `04-world.js` | `04-world` | the island, the atlas, ambient life |
| `05-progress.js` | `05-progress` | quests, renown, milestones |
| `06-content.js` | `06-content` | the journal, almanac and records |
| `07-juice.js` | `07-juice` | game feel |
| `08-fortune.js` | `08-fortune` | casino & market depth |
| `09-social.js` | `09-social` | connection, presence, chat |
| `10-comfort.js` | `10-comfort` | settings, accessibility, save safety, perf |
| `11-touch.js` | `11-touch` | touch controls and small-screen layout |
| `12-boot.js` | `12-boot` | the boot experience and capability checks |
| `13-audio.js` | `13-audio` | the living soundscape |
| `14-npc.js` | `14-npc` | the people of the isle |
| `15-nft.js` | `15-nft` | the on-chain wardrobe: wear the Reel Fortune Angler NFT you own (ownership checked by the server) |

```js
/* ============================================================================
   <NN-NAME> — one sentence on what this mod is for.
   ========================================================================== */
RF.mod('<nn-name>', function (RF) {
  'use strict';

  RF.css(`...`, 'rf-<name>-css');           // your styles, keyed so a reload replaces them
  const root = RF.el('<div id="rf-<name>">…</div>');   // your DOM, appended to <body>
  // (<name> below always means your slot's short name: notify, angler, hud, …)

  RF.on('frame', dt => { /* every frame — keep this cheap */ });
  RF.every(1.0, () => { /* once a second */ });
  RF.on('catch', (fish, info) => { /* game events */ });

  RF.api = RF.api || {};                    // optional: expose to other mods
});
```

`RF.mod()` may be called before or after the host is ready — early calls queue and
run at `RF._boot()`.

---

## 2. Hard rules

1. **You own exactly one file — your slot.** Never touch another mod's file,
   `game.js`, `index.html`, `net.js`, `README.md`, or anything under `server/`.
   Several of these are written in parallel; a stray edit outside your slot is lost.
2. **No `<script>` tag edits.** The tags already exist in `index.html`.
3. **No new dependencies, no build step, no ES modules, no `import`.** Plain ES2017
   script that runs from `file://`. Three.js r128 (`RF.THREE`) is the only library.
4. **Namespacing.** Every DOM id/class you create starts `rf-<name>` (e.g.
   `#rf-notify-drawer`, `.rf-notify-card`). Every localStorage key goes through
   `RF.store.get/set('<name>', …)`. Never write a bare `localStorage` key.
5. **Never mutate the economy.** `RF.state.coins`, `.ores`, `.bucket`, `.pearls`,
   `.stocks`, `.rodLvl/.pickLvl/.axeLvl`, `.worlds`, `.boatLvl` are **read-only** to
   mods: when the player is signed in the server owns them and overwrites the client
   on the next action, so a local grant silently evaporates. If your mod has rewards,
   they live in your own `RF.store` bucket (see *Renown*, §6). Cosmetic/UI state you
   own yourself is fine.
6. **Never block the frame.** Anything over ~1 ms goes in `RF.every(n, …)` or an
   idle callback. No synchronous loops over `RF.heightMap` per frame.
7. **Guard every DOM lookup.** `index.html` changes under you; `const el = document
   .getElementById('x'); if (!el) return;`.
8. **Errors go to the funnel**, never to a bare `console.error`: `RF.err('where', e)`.
   Wrap anything that can throw (JSON parse, `localStorage`, `fetch`, WebGL).
9. **Offline-first.** The game must work opened straight from `file://` with no
   server and no network. Never assume `RF.online`.
10. **Match the house style.** Dense, comment-light-but-meaningful code in the voice
    of `game.js`: explain *why*, never *what*. No emoji in code. Use `·` not `—` in
    UI strings where `game.js` does.

---

## 3. Look & feel

Use the tokens already defined in `index.html` — never hard-code a hex the palette
already names:

```
--bg #0a1418   --panel #122029  --panel2 #182c36  --border #223a44
--ink #e8f4f2  --muted #8aa6a2  --faint #5c7a76   --lab #b5cdc9
--teal #39d7c4 --gold #ffcf5c   --rose #ff5d7a
--c-common --c-uncommon --c-rare --c-epic --c-legendary
--glass --glass-strong --glass-hud --glass-row --glass-bd --glass-bd-soft
--glass-hi --glass-sheen
```

Fonts: `"Chakra Petch", sans-serif` for headings/numbers, `"IBM Plex Mono"` for body.
Panels are glassmorphism: `background: var(--glass-sheen), var(--glass-strong);
backdrop-filter: blur(18px) saturate(1.6); border: 1px solid var(--glass-bd);
border-radius: 14px; box-shadow: var(--glass-hi), 0 8px 28px rgba(2,8,10,.35);`

`RF.fn.pixSVG(name, size)` returns the game's pixel-art icons inline. Available names
are the keys of `RF.PIX` — read them at runtime, don't guess.

**Photo mode.** `body.photo` hides the HUD for screenshots. Any always-on HUD element
you add must hide too — add your selector via your own CSS:
`body.photo #rf-<name>-hud{display:none!important;}`

### z-index bands (do not exceed yours)

| band | what |
|---|---|
| 5–9 | game HUD (taken) |
| 10 | game overlays: market, inventory, harbor, start (taken) |
| 20 | toasts (taken) |
| **24–27** | mod panels / drawers |
| **28–31** | mod HUD pills that must sit over panels |
| **32–34** | tooltips, popovers |
| **35–37** | notifications + modal confirmations |
| 40 | `#err` fatal box (taken) |

---

## 4. Keyboard

`RF.on('keydown', e)` fires for every keydown; **return `true` from a
`RF.on('keydown', …)` handler to claim the event** and stop core from acting on it
(that's `RF.claim` semantics at the core call site).

Before acting on a key, bail out when the player is typing or a core panel owns the
screen:

```js
const typing = () => { const a = document.activeElement;
  return RF.chatOpen || !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)); };
RF.on('keydown', e => {
  if (typing()) return;
  if (e.code === 'KeyQ' && !RF.panelOpen) { e.preventDefault(); toggle(); return true; }
  if (e.code === 'Escape' && isOpen()) { close(); return true; }   // claim ESC only while YOU are open
});
```

**Already taken by core:** `W A S D`, arrows, `E`, `Space`, `I`, `Tab`, `T`, `F`,
`P`, `C`, `Escape`, `Enter`, `Digit1`–`Digit8`.

**Reserved per mod — use only yours:**

| mod | keys |
|---|---|
| `00-notify` | `KeyN` |
| `01-angler` | `KeyB` |
| `02-hud` | *(none)* |
| `03-panels` | `KeyH`, `F1`, `Slash`, `KeyV`, holding `Alt` |
| `04-world` | `KeyM` |
| `05-progress` | `KeyQ` |
| `06-content` | `KeyJ` |
| `07-juice` | *(none)* |
| `08-fortune` | `KeyG` |
| `09-social` | `KeyY` |
| `10-comfort` | `KeyO`, `F3`, `Backquote` |
| `11-touch` | *(none — pointer/touch only)* |
| `12-boot` | *(none)* |
| `13-audio` | *(none — its settings live in `10-comfort`)* |
| `14-npc` | `KeyR` |
| `15-nft` | `KeyK` |

Nothing else. If you want a second binding, put it behind a modifier of a key you
already own (`Shift+M`), never on a bare key another slot holds.

---

## 5. Events, pipelines and take-overs

### `RF.on(evt, fn, prio)` — events core emits

| event | args | when |
|---|---|---|
| `ready` | — | all mods loaded |
| `start` | — | player pressed *Set sail* (game actually running) |
| `frame` | `(dt, rdt)` | every rendered frame, before the render pass |
| `tick` | `(dt, rdt)` | every frame, only while `RF.running` |
| `afterRender` | `(dt, rdt)` | after the world is drawn |
| `hud` | — | `updateHUD()` ran (coins/ores/bucket may have changed) |
| `toast` | `(msg, kind, el)` | a toast was shown (`kind`: `''｜'good'｜'gold'｜'bad'`) |
| `panel` | `(name, open)` | `'market'｜'inventory'｜'casino'｜'harbor'` opened/closed |
| `catch` | `(fish, {auto,isNew,isRec,server})` | a fish was landed |
| `mined` | `({type,got,geode,node,combo})` | an ore node broke |
| `chopped` | `({got,tree})` | a tree was felled |
| `dug` | `({})` | a treasure was dug up |
| `sold` | `({kind,gained,…})` | `kind`: `'allfish'｜'fish'｜'ore'` (offline routes only) |
| `crafted` | `({tool,lvl,name,cost,req})` | a tool tier was crafted |
| `share` | `({ticker,price,owned})` | a share certificate dropped |
| `spin` | `({won,pocket,color,bet,fish,coins,server})` | the roulette settled |
| `travel` | `({from,to})` | sailing (page reloads right after) |
| `unlock` | `({world,cost})` | a world was bought |
| `weather` | `(next, prev)` | `'clear'｜'rain'｜'storm'｜'snow'｜'ash'` |
| `pearls` | `(n, why)` | pearls were awarded |
| `ach` | `(id, name, reward)` | an achievement fired |
| `keydown` / `keyup` | `(e)` | raw key events (return `true` on keydown to claim) |
| `chat` | `({name,msg,cls,peerId,el})` | a chat line was appended (`el` is the live node) |
| `chatcmd` | `(cmd, args, raw)` | a `/command` was typed · **return `true` to claim it** and skip every built-in |
| `save` | `(ok, err)` | a `localStorage` save failed (`false`) or recovered (`true`) |
| `muted` | `(v)` | sound was muted/unmuted from either the ♪ chip or `RF.audio` |
| `error` | `(rec)` | **the error funnel** — see §7 |
| `actionfail` | `(ev)` | a server action was rejected; set `ev.handled = true` to suppress core's fallback toast |

### `RF.audio` — the mixer

`initAudio()` builds `master → {music, sfx}` gain nodes, so volume is real:

```js
RF.audio.ready      // false until the context exists (first gesture)
RF.audio.suspended  // browsers start contexts suspended; RF.audio.resume() from a click
RF.audio.master = 0.8   // 0 .. 1.5, same for .music and .sfx
RF.audio.setMuted(true) // drives core's ♪ chip and the music bed together
RF.audio.ctx        // the AudioContext, or null
```

`RF.on('muted', v)` fires whenever mute flips, from either side.

### `RF.modify(name, fn, prio)` — value pipelines

`fn(value, ctx)` returns the new value (return `undefined` to pass through).
Core pipes: `hint`, `fishLuck`, `biteTime`, `oreYield`, `woodYield`, `pearls`,
`priceMult`, `moveSpeed`, and — for accessibility — **`shake`** (camera trauma,
return 0 to kill it) and **`freeze`** (hit-stop seconds).

### `RF.override.<name> = fn` — take-overs

Return `true` to replace core behaviour entirely: `reveal(f, quiet)`,
`minimap(ctx, canvas)`, `fishing(dt, f)`, `mining(dt, node)`.
**Only claim one if your mod is the documented owner of it.** Chain politely:
`const prev = RF.override.minimap; RF.override.minimap = (…) => { … };`

---

## 6. Renown — the mod-side reward currency

Mods must not mint coins or pearls (§2.5). Anything that wants to reward the player
uses **Renown**, a purely client-side score kept by `mods/05-progress.js`:

```js
// award (any mod)
if (RF.api && RF.api.renown) RF.api.renown.add(25, 'first geode');
// read
const total = (RF.api && RF.api.renown) ? RF.api.renown.get() : 0;
```

`05-progress.js` owns `RF.api.renown = {get(), add(n, why), spend(n), on(fn)}` and
persists it under `RF.store.set('05-progress', …)`. Every other mod must
feature-detect it (`RF.api && RF.api.renown`) and degrade silently when it is
absent — mods load in numeric order, so anything below 05 must also tolerate it
not existing *yet* and look it up lazily, inside the call, never at load time.

---

## 7. Errors and notifications

`mods/00-notify.js` owns all user-facing error reporting. Other mods **never** build
their own error UI — they call:

```js
RF.err('atlas:draw', e);                        // logs + funnels + notifies
RF.api.notify({ level:'warn', title:'Offline', body:'…', tag:'net', ttl:6000 });
```

`RF.err(where, e, level)` pushes `{id,t,where,level,msg,name,stack,raw}` onto
`RF.errors` (ring buffer, last 300) and calls every `RF.on('error')` handler
**directly** — a handler that throws cannot recurse. `level` is
`'warn'｜'error'｜'fatal'`.

`RF.api.notify(opts)` is provided by `00-notify.js`; feature-detect it at call time
and fall back to `RF.fn.toast(msg, kind)`:

```js
const say = (o) => (RF.api && RF.api.notify) ? RF.api.notify(o)
                 : RF.fn.toast(o.title + (o.body ? ' · ' + o.body : ''), o.level === 'error' ? 'bad' : '');
```

---

## 8. Everything `RF` hands you

Read `mods/RF-API.txt` (generated from `game.js`) for the verbatim host source and
the full reference table: scene graph handles, `RF.state`, world data (`heightMap`,
`oreNodes`, `treeData`, `landCells`, `spawnCell`), every data table (`TABLE`,
`ALL_FISH`, `ORE_INFO`, `STOCKS`, `BAITS`, `BOATS`, `ACH`, `PIX`, `EMO`, …) and
~70 helper functions under `RF.fn`. Live values (`RF.clock`, `RF.running`,
`RF.dayT`, `RF.weather`, `RF.panelOpen`, `RF.online`, …) are getters — always read
them fresh, never cache.

Anything not listed there is not part of the contract. If you need a hook that does
not exist, **do not add one to `game.js`** — note it in your handoff instead.

---

## 9. Definition of done

- `node --check mods/<your-slot>.js` passes.
- The file is substantial and finished — a real feature, not a sketch. Aim for
  400–900 lines of dense, working code with no TODOs and no dead branches.
- The mod does nothing at all until it is needed; opening the game shows no new
  clutter unless the player asks for it (a small HUD pill is fine).
- It survives: no server, no `localStorage`, a `file://` origin, a fresh save, a
  1024×640 window, and `body.photo`.
- It never logs to the console in normal operation.

---

## 10. Cross-mod conventions

Mods load in numeric order and any of them may be missing or broken, so these are
**published as ambient signals, never as imports**. Feature-detect at *call* time —
never at load time — and degrade silently.

| signal | owner | everyone else |
|---|---|---|
| `RF.api.notify(opts)`, `RF.api.confirm(opts)` | `00-notify` | `(RF.api && RF.api.notify) ? … : RF.fn.toast(…)` |
| `RF.api.renown` | `05-progress` | `if (RF.api && RF.api.renown) RF.api.renown.add(n, why)` |
| `body.classList` has **`rf-reduced`** | `10-comfort` | skip animation, particles, flashes, camera motion |
| `body.dataset.rfQuality` = `low｜med｜high｜ultra` (default `high`) | `10-comfort` | scale your particle/entity budget; `low` means **zero** decorative spawns |
| `:root` var **`--rf-ui-scale`** (default `1`) | `10-comfort` | size your panels in `em`/`calc(… * var(--rf-ui-scale, 1))` |
| `body.classList` has **`photo`** | `game.js` | hide every always-on element of yours |

Two mods must never write the same signal. If you need one that isn't listed,
keep it inside your own namespace and mention it in your handoff.

## 11. What you must NOT do

- Do not run `git` (no `add`, `commit`, `checkout`, `stash`). The user commits.
- Do not create scratch, test or screenshot files in the repo.
- Do not install anything, add a `package.json`, or reach the network at runtime
  beyond the `RFNet` calls the game already makes.
- Do not rewrite `README.md` or `mods/_README.md`.
- Do not `alert()`, `prompt()` or `confirm()` — use `RF.api.confirm` or your own UI.

---

## 12. Server error codes

Every non-2xx answer from the server now carries a **stable machine code**
alongside the human sentence, because English copy is allowed to change and a
client must never match on it:

```json
{ "error": "too fast", "code": "RATE_LIMIT", "retryAfter": 1400 }
```

`net.js` attaches the whole body to the thrown error, so a handler reads
`e.status`, `e.data.code`, `e.data.error` and `e.data.retryAfter`.

| code | status | meaning · what the player should be told |
|---|---|---|
| `UNAUTHENTICATED` | 401 | the session expired · sign in again |
| `BAD_CREDENTIALS` | 401 | wrong username or password |
| `BAD_USERNAME` / `BAD_PASSWORD` | 400 | the sign-up form was rejected |
| `USERNAME_TAKEN` | 409 | pick another name |
| `BAD_ADDRESS` / `BAD_SIGNATURE` / `NONCE_EXPIRED` | 400/401 | wallet sign-in failed · retry is safe |
| `GUEST_ALLOC_FAILED` | 500 | guest account could not be made · try again |
| `RATE_LIMIT` | 429 | too fast · `retryAfter` is milliseconds, back off exactly that far |
| `UNKNOWN_ACTION` | 404 | client and server are out of step · a reload is the fix |
| `ACTION_REJECTED` | 400 | the server refused this move; `error` explains why · do NOT retry |
| `ACTION_FAILED` / `INTERNAL` | 500 | server trouble · retry once, then fall back |
| `SAVE_UNREADABLE` | 503 | the save was refused, not overwritten · retry after ~30s, nothing was lost |
| `MALFORMED_JSON` / `PAYLOAD_TOO_LARGE` | 400/413 | a client bug · never retry |
| `NOT_FOUND` / `FORBIDDEN` | 404/403 | wrong endpoint |
| crew codes (`ALREADY_ABOARD`, `CREW_FULL`, `NO_SUCH_CAPTAIN`, `HOSTING_CREW`, `CAPTAIN_IS_GUEST`, `HULL_HAS_NO_BERTHS`, `ALREADY_WAITING`, `TOO_MANY_REQUESTS_OUT`, `GUEST_ELSEWHERE`, `NOT_WAITING`, `NOT_ABOARD`, `OWN_BOAT`, `CREW_REJECTED`) | 4xx | the `error` sentence is already player-facing · show it as-is, never retry |
| `LEDGER_DISABLED`, `BAD_DEED_ID`, `DEED_NOT_MINTED`, `CLAIM_FAILED` | 4xx/5xx | deed claiming |
| `LEADERBOARD_UNAVAILABLE`, `UNAVAILABLE`, `REPORT_FAILED`, `ADMIT_FAILED` | 5xx | transient |

Retry is safe for `RATE_LIMIT` (after `retryAfter`), `SAVE_UNREADABLE`,
`ACTION_FAILED`, `INTERNAL` and network-class failures with no code at all.
It is **never** safe for any 4xx that is not a rate limit.

**`GET /api/health`** is unauthenticated, touches no database and answers
`{ok, service, now, uptimeMs, epoch, online}`. It is the endpoint to time for
latency — not `/api/leaderboard`, which hits SQLite on every call.
