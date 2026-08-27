# 🎣 Reel Fortune 3D

A voxel (Minecraft-style) fishing & gambling adventure on one roamable island — built with **Three.js**. Walk around a textured blocky isle, fish the shores, sell to the Trader, then risk your catch on the roulette wheel: **double your fish or lose it.**

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
| **hold E** | reel the fish in |
| **ESC** | close a menu / cancel fishing |

## 🐟 The loop

1. **Walk to any shore** → press **E** to cast. When you see **❗ BITE**, press **E**, then **hold E** to reel it in.
2. Fish fill your **bucket** (top-left). Rarer fish = more coins.
3. Walk to the **TRADER** → press **E** → sell fish for coins.
4. Walk to the **CASINO** (purple dais) → press **E** → stake a fish, bet **RED / BLACK** (×2) or **GREEN** (jackpot ×14), and **SPIN**.
   - **Win** → the fish is worth double. Re-spin a winner to push your luck (×4, ×8…).
   - **Lose** → the eel eats it. Gone.
5. Sell your (hopefully multiplied) fish back at the Trader.

Progress **auto-saves** in your browser. There's a **wipe save** link on the start screen.

## 🗂️ Project structure

```
ReelFortune3D/
├── index.html      ← page, HUD, menus, styling  (open this)
├── game.js         ← all the game code (world, fishing, roulette)
├── lib/three.min.js ← the Three.js engine (r128)
└── README.md
```

## 🛠️ Editing

Everything is plain JavaScript — no build step. Open `game.js` and tweak:

- **World** — `N` (island size), `fbm()` / falloff (terrain shape), `COLORS` & the `tex*()` functions (block textures).
- **Fish** — the `TABLE` array (species, rarity, value, drop weight).
- **Economy** — `RES` sell values, roulette `SEG` / payouts.
- **Look** — `CAM_OFF` (camera angle), `sun` (lighting), water/grass animation in `animWater()` / `animGrass()`.

Save the file and refresh the browser to see changes.

## ✨ What's in it

- Textured voxel terrain (grass / dirt / sand / stone), procedurally generated island
- **Flowing water** — animated waves + scrolling caustics
- **Swaying grass** tufts that move in the wind
- Trees, rocks, a Trader stall and a glowing Casino dais with a spinning ring
- Isometric camera, soft shadows, day-lit sky
- Fishing minigame, market, and a Minecraft-styled roulette wheel
- Sound effects (toggle with the ♪ button) and local auto-save

Built with [Three.js](https://threejs.org) r128. Pure client-side, MIT-spirited — do whatever you like with it.
