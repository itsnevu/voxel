# mods/ — the Reel Fortune extension layer

`game.js` is one big IIFE. Near the top it now creates a mod host at `window.RF`
(section 0), and at the very bottom it fills in a reference table (section 18)
with every engine handle a mod is allowed to touch, then calls `RF._boot()`.

Each file here is loaded by a plain `<script>` tag in `index.html` **after**
`game.js`, and registers itself exactly once:

```js
RF.mod('my-feature', function (RF) {
  RF.css(`.myThing{ ... }`, 'my-feature-css');     // own your styling
  const el = RF.el('<div class="myThing"></div>');  // own your DOM
  RF.on('catch', (fish, info) => { ... });          // react to the game
  RF.modify('oreYield', v => v * 2);                // bend a value
  RF.on('frame', dt => { ... });                    // run every frame
});
```

A mod that throws is caught and logged; the rest still load.
Check `RF.mods` in the console to see what loaded.

## The surface

**Events** — `RF.on(name, fn)` / `RF.emit`:
`ready` `start` `tick(dt,rdt)` `frame(dt,rdt)` `afterRender(dt,rdt)`
`catch(fish,{auto,isNew,isRec,server})` `mined({type,got,geode,node,combo})`
`chopped({got,tree})` `dug({})` `pearls(n,why)` `ach(id,name,reward)`
`panel(name,isOpen)` `toast(msg,kind,el)` `hud` `keydown(e)` `keyup(e)`

**Claims** — `RF.on(name, fn)` where returning `true` takes over:
`interact` (own the E-prompt this frame) · `keydown` (swallow the key) · `toast`

**Pipelines** — `RF.modify(name, v => v2)`:
`biteTime` `fishLuck` `oreYield` `woodYield` `priceMult` `pearls` `moveSpeed` `hint`

**Overrides** — `RF.override.x = fn` where returning `true` replaces core:
`fishing(dt,f)` `mining(dt,node)` `reveal(fish,quiet)` `minimap(ctx,canvas)`

**Handles** — `RF.scene` `RF.camera` `RF.renderer` `RF.state` `RF.player`
`RF.pWorld` `RF.keys` `RF.THREE` `RF.oreNodes` `RF.treeData` `RF.landCells`
`RF.heightMap` `RF.WORLD` `RF.TEX` `RF.sfx` `RF.fn.*` (~60 engine functions)

**Live getters** — `RF.clock` `RF.running` `RF.weather` `RF.dayT` `RF.panelOpen`
`RF.actEdge` `RF.camSize` `RF.online` `RF.hotSlot` `RF.viewMode` …

**Helpers** — `RF.css(text,id)` `RF.el(html,parent)` `RF.every(sec,fn)`
`RF.store.get/set/del(name)` (per-mod localStorage, survives the server)
