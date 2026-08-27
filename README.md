# 🎣 Reel Fortune 3D

A voxel (Minecraft-style) fishing, mining & gambling adventure across four themed islands — built with **Three.js**. Fish the shores, mine the quarry, chop the woods, play a living market with its own stock exchange, upgrade your gear, and gamble your best catch at a real 3D roulette table. **Double your fish or lose it.**

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
| **W A S D** / arrows | walk |
| **E** | cast · hook a bite · interact (Trader / Casino / dig) |
| **hold E** | reel in · mine ore · chop trees · dig treasure |
| **I** / Tab | inventory (Bag · Fishdex · Stats) |
| **scroll** | zoom |
| **ESC** | close / cancel |

## 🔁 The loop

1. **Fish** any shore — some species only bite at night 🌙, in rain 🌧 or storms ⛈; 1.8% are ✦ shiny (×5 value). Every catch logs weight records in the **Fishdex**.
2. **Mine** the quarry (coal→diamond) and **chop** trees for wood — ore nodes sometimes drop **share certificates**.
3. **Sell at the Trader** — every 3 minutes one category is **HOT ×1.6**, one **SURPLUS ×0.75**.
4. **Craft** better gear (coins + ores): Rod, Pickaxe & Axe, each 10 tiers.
5. **Invest** at the **Isle Exchange** — 5 fictional stocks with live charts and hourly dividends (paid even offline). EEL never pays a dividend; the eel eats the profits.
6. **Spend Pearls ◉** (activity points — never convertible to coins) at the **Pearl Kiosk**: hero outfit colors, floating titles, Chum Jar, Deep Bucket, Insider Tips.
7. **Gamble** at the Casino — walk up to the roulette table, the camera dives onto the felt, the ball rattles into a pocket. Win = fish worth double (re-spin to push ×4, ×8…). Lose = the eel eats it.
8. **Unlock new islands** at the ⛵ Harbor and do it all again, richer.

Progress **auto-saves** in your browser. Achievements pay coin bounties. There's a **wipe save** link on the start screen.

## 🗺️ Worlds

| World | Cost | Theme |
|-------|------|-------|
| Fortune Isle | free | vivid starter island |
| The Great Mine | ◈2,500 | grey highlands, **double ore yield** |
| Cinder Atoll | ◈8,000 | volcanic ash & black sand, fish ×2.2 |
| Frostbite Isle | ◈25,000 | snow & frosted pines, fish ×4 |

Coins, gear, pearls, dex and your stock portfolio travel with you — sailing regenerates the island.

## 🚢 The fleet & crew

Every hull seats a fixed number of people — **the captain included** — so the raft you start on genuinely sails alone.

| Hull | Cost | Seats | Berths for crew | Sea luck |
|------|------|-------|-----------------|----------|
| Driftwood Raft | free | 1 | — | +0% |
| Cork Dinghy | ◈600 | 2 | 1 | +6% |
| Teal Sloop | ◈2,400 | 4 | 3 | +12% |
| Storm Trawler | ◈8,000 | 6 | 5 | +20% |
| Gilded Galleon | ◈22,000 | 10 | 9 | +30% |

A berth is **granted, never taken**. At the Harbor you pick a captain and *ask to board*; the request sits at their gangway until they hit **ADMIT** or **DENY**. Captains can also put a hand ashore later, and any guest can step ashore themselves.

The rules the server enforces:

- one berth per sailor — you cannot be aboard two boats
- a captain hosting crew cannot go and crew for someone else (send yours ashore first)
- a manifest never exceeds `seats - 1`, re-checked when ADMIT is pressed, not when the button is drawn

Crews live on the server (`/api/crew*`), so this part needs a sign-in — offline play still shows what each hull *could* hold.

## 📈 Isle Exchange

Five tickers priced purely from the real-world clock (deterministic — reloading can't reroll them), correlated with the HOT/SURPLUS rotation:

| Ticker | Company | Personality |
|--------|---------|-------------|
| DIGG | Deep Digg Mining Co. | high volatility, tracks ore demand |
| REEL | Reel Fortune Fisheries | steady, tracks fish demand |
| LUMB | Lumberline Timber | boring but pays the best regular dividend |
| EEL | Spinning Eel Ent. | meme stock — wild swings, **never** pays |
| HARB | Harbor Star Lines | blue-chip, highest yield |

Shares drop from play (mining is the main source; a diamond guarantees one). Buy/sell at a 10% spread; dividends land hourly — including while you were away.

## 🗂️ Project structure

```
ReelFortune3D/
├── index.html       ← page, HUD, minimap, menus, styling  (open this)
├── game.js          ← all game code (world, fishing, mining, market, exchange, roulette)
├── lib/three.min.js ← the Three.js engine (r128)
└── README.md
```

## 🛠️ Editing

Plain JavaScript — no build step. Open `game.js` and tweak:

- **World** — `N`, `WORLDS` (themes/seeds/costs), `fbm()` falloff, `tex*()` palettes
- **Fish** — `TABLE` (species, rarity, value, weight, `night/rain/storm` conditions)
- **Economy** — `ORE_INFO`, `upCost`/`UP_REQ` crafting, `MKT_MS` rotation, `STOCKS` (bases, volatility, yields), Pearl prices in `KIOSK_TITLES`/`BUCKET_COST`
- **Look** — `CAM_OFF`, lights, `DAYKEYS` day/night palette, glass tokens in `index.html`

Save, refresh, play.

## ✨ Everything inside

96×96 procedural islands · BFS-carved dirt paths · entrance monument gate · day/night cycle with dusk palettes · rain & thunderstorms · swaying grass, cherry trees, flowers, mushrooms · signature hero with a real pixel face, straw hat & swaying scarf (recolorable) · animated tool props (rod/pick/axe in hand) · fishing line & bobber · voxel particle bursts, screen shake & hit-stop · coin-fly & pearl toasts · glassmorphism UI with pixel-art icons · minimap with POIs & treasure X · hotbar + tabbed inventory · Fishdex with ??? silhouettes · treasure maps · achievements · procedural music & sfx (♪ to mute) · a physical 3D roulette table the camera flies onto · title screen with an orbiting camera and live map previews of all four worlds.

Built with [Three.js](https://threejs.org) r128. Pure client-side, MIT-spirited — no wallet, no server, no blockchain: just fortune.
