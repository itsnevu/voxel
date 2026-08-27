# 🎣 Reel Fortune 3D

A voxel (Minecraft-style) fishing, mining & gambling adventure on one big roamable island — built with **Three.js**. Walk a vivid blocky isle, fish the shores, mine the quarry, play the market's rotating prices, upgrade your gear, then risk your catch on the roulette wheel: **double your fish or lose it.**

## ▶️ How to run

**Easiest:** double-click **`index.html`** — it opens in your browser and just runs. No install, no server, works offline.

If your browser blocks local files, run a tiny server from this folder instead:

```bash
cd ~/Documents/ReelFortune3D
python3 -m http.server 8000
# then open http://localhost:8000 in your browser
```

## 🎮 Controls

| Key | Action |
|-----|--------|
| **W A S D** / arrows | walk around the isle |
| **E** | cast your line · hook the bite · interact with Trader / Casino |
| **hold E** | reel the fish in · mine an ore node |
| **scroll** | zoom the camera in/out |
| **ESC** | close a menu / cancel fishing or mining |

## 🐟⛏️ The loop

1. **Fish any shore** → press **E** to cast. On **❗ BITE**, press **E**, then **hold E** to reel it in.
2. **Mine the quarry** — follow the dirt path to the stone mountain (see the minimap). Hold **E** on ore rocks: coal, iron, gold, diamond. Nodes respawn after a while.
3. **Sell at the TRADER** — fish and ores. Watch the banner: every 3 minutes one category is **HOT ×1.6** and one is **SURPLUS ×0.75**. Time your sales!
4. **Upgrade** at the Trader: a better **rod** (faster bites, rarer fish) and a better **pick** (faster mining, bonus yield).
5. **Gamble** at the **CASINO** — walk up to the real roulette table and the camera dives onto the felt. Stake a fish, bet **RED / BLACK** (×2) or **GREEN** (jackpot ×14), and **SPIN** — the ball rattles around the wheel and drops into a pocket.
   - **Win** → the fish is worth double. Re-spin a winner to push your luck (×4, ×8…).
   - **Lose** → the eel eats it. Gone.

Progress **auto-saves** in your browser. There's a **wipe save** link on the start screen.

## 🗂️ Project structure

```
ReelFortune3D/
├── index.html      ← page, HUD, minimap, menus, styling  (open this)
├── game.js         ← all the game code (world, fishing, mining, market, roulette)
├── lib/three.min.js ← the Three.js engine (r128)
└── README.md
```

## 🛠️ Editing

Everything is plain JavaScript — no build step. Open `game.js` and tweak:

- **World** — `N` (island size), `fbm()` / falloff (terrain shape), `COLORS` in the `tex*()` functions (block textures).
- **Fish** — the `TABLE` array (species, rarity, value, drop weight).
- **Ores** — `ORE_INFO` (prices, colors), node counts in the quarry section.
- **Economy** — `ROD_UP` / `PICK_UP` upgrade costs, `MKT_MS` market rotation, roulette `SEG` / payouts.
- **Look** — `CAM_OFF` (camera angle), `camSize` (zoom), lights in section 1, water/grass animation.

Save the file and refresh the browser to see changes.

## 🗺️ Worlds

Unlock new themed islands at the **⛵ Harbor** section of the Trader's market:

| World | Cost | Theme |
|-------|------|-------|
| Fortune Isle | free | vivid starter island |
| The Great Mine | ◈2,500 | grey highlands, **double ore yield**, 30 nodes |
| Cinder Atoll | ◈8,000 | volcanic ash & black sand, fish worth ×2.2 |
| Frostbite Isle | ◈25,000 | snow & frosted pines, fish worth ×4 |

Your coins, gear, bucket and dex travel with you — sailing regenerates the island.

## ✨ What's in it

- Big 96×96 procedurally generated island with a mineable stone quarry
- Vivid Minecraft-style palette: checkered turf, stepped voxel trees (plus pink cherry trees), flowers, mushrooms, rocks
- Dirt paths carved from spawn to the Trader, Casino and Mine (BFS-guaranteed walkable)
- **Flowing water** — animated waves + scrolling caustics · swaying grass tufts
- Trader stall with a checkered market roof, a glowing casino dais with spinning ring & lamps
- Mining: hold-E ore nodes (coal/iron/gold/diamond) with respawns
- Rotating market demand (HOT/SURPLUS) + rod & pickaxe upgrades
- Minimap with POI markers, resource HUD, isometric camera with scroll zoom, soft shadows
- A real **3D roulette table in the world** — the camera flies onto it, the ball circles the rim and settles into a pocket · sound effects (toggle with ♪) and local auto-save

Built with [Three.js](https://threejs.org) r128. Pure client-side, MIT-spirited — do whatever you like with it.
