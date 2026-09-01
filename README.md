# 🎣 Reel Fortune

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
| **F** | plant / pack up your **auto-rig** at the shore |
| **I** / Tab | inventory (Bag · Fishdex · Stats) |
| **scroll** | zoom |
| **ESC** | close / cancel |

## 🔁 The loop

1. **Fish** any shore — some species only bite at night 🌙, in rain 🌧 or storms ⛈; 1.8% are ✦ shiny (×5 value). Every catch logs weight records in the **Fishdex**.
2. **Plant the auto-rig** (**F**) at any shore and walk away — it fishes on its own while you mine, trade or stand in the Casino. It only brings up the cheap end of the water though: rare-and-up runs ~3% against ~35% on a rod you hold, a legendary is ~75× rarer, catches sell for 30% less, it burns no bait, bottles no maps and scores nothing in the derby. Upgrade it at the Pearl Kiosk (Driftwood → Braced → Tidewatch) for a faster line and slightly better odds.
3. **Mine** the quarry (coal→diamond) and **chop** trees for wood — ore nodes sometimes drop **share certificates**.
4. **Sell at the Trader** — every 3 minutes one category is **HOT ×1.6**, one **SURPLUS ×0.75**.
5. **Craft** better gear (coins + ores): Rod, Pickaxe & Axe, each 10 tiers.
6. **Invest** at the **Isle Exchange** — 5 fictional stocks with live charts and hourly dividends (paid even offline). EEL never pays a dividend; the eel eats the profits.
7. **Spend Pearls ◉** (activity points — never convertible to coins) at the **Pearl Kiosk**: hero outfit colors, floating titles, Chum Jar, Deep Bucket, auto-rig upgrades, Insider Tips.
8. **Gamble** at the Casino — walk up to the roulette table, the camera dives onto the felt, the ball rattles into a pocket. Win = fish worth double (re-spin to push ×4, ×8…). Lose = the eel eats it.
9. **Unlock new islands** at the ⛵ Harbor and do it all again, richer.

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
├── index.html            ← page, HUD, minimap, menus, styling  (open this)
├── game.js               ← the engine: world, fishing, mining, market, exchange, roulette
├── net.js                ← RFNet — the optional bridge to the server (absent = offline play)
├── lib/three.min.js      ← the Three.js engine (r128)
├── mods/                 ← 15 self-contained feature slots layered on top of game.js
│   ├── 00-notify.js … 14-npc.js
│   ├── SPEC.md           ← the mod contract: slots, keys, z-index bands, error codes
│   └── RF-API.txt        ← every engine handle a mod may touch (generated from game.js)
├── server/               ← optional authoritative Node + SQLite backend
│   ├── src/              ← auth, realtime (WebSocket), economy rules, moderation console
│   ├── test/             ← the test suite  (`cd server && npm test`)
│   ├── deploy/           ← nginx, systemd unit, backup script
│   └── README.md         ← full VPS install guide (in Indonesian)
├── contracts/            ← IsleLedger.sol — the deed wall. A trophy, never a payment rail
│                            ReelFortuneAnglers.sol — the Anglers NFT (ERC-721) + forge tests + deploy.sh
├── mint.html · mint/     ← the self-hosted mint page: connect a wallet, mint an Angler, no marketplace
├── nft/                  ← the generated collection: 1000 images + metadata + rarity, served as-is
├── .github/workflows/    ← CI: every push runs the whole suite on Node 18 and 20, plus forge test
├── sw.js · manifest.webmanifest · icon*.svg/png · og-card.jpg  ← installable + share card
└── README.md
```

Two of those are genuinely optional. **`mods/`** is a layer: every file hangs itself off the
`RF` host `game.js` publishes, never edits the engine, and a mod that throws while loading is
caught and reported instead of taking the game down. **`server/`** is a separate program — the
game never needs it, but when it is there and you are signed in, it becomes the authority on
every roll and every coin, and the console can no longer mint anything.

## 🧬 Reel Fortune Anglers — the NFT

**1000 unique voxel anglers** — the game's own hero, re-rolled: 13 trait layers (island
background, aura, backpack, pants, outfit, skin, eyes, mouth, hair, neckwear, headwear, tool,
companion) with real rarity weights. Minted **from this site**, at [`mint.html`](mint.html), on the
chain in [`mint/config.js`](mint/config.js) — no OpenSea, no marketplace in the loop.

| Piece | Where | What |
|-------|-------|------|
| Art engine | `../hashlips_art_engine-main/reelfortune/` | draws the hero as a voxel box-model into transparent layer PNGs; HashLips rolls the DNA, rarity and metadata |
| Collection | [`nft/`](nft/) | `images/N.png`, `json/N.json` (ERC-721 metadata), `rarity.json`, `collection.json` |
| Contract | [`contracts/ReelFortuneAnglers.sol`](contracts/ReelFortuneAnglers.sol) | dependency-free ERC-721 + ERC-2981: `mint(quantity)` payable, supply cap, per-wallet cap, owner reserve, `withdraw()` |
| Mint page | [`mint.html`](mint.html) + [`mint/`](mint/) | wallet connect, chain switch, live supply, mint, "your anglers" gallery, trait rarity — zero dependencies |

Regenerate the collection (engine repo), then deploy and point the page at it:

```bash
cd ../hashlips_art_engine-main
npm run rf:layers                                     # draw every trait layer PNG
npm run rf:build -- --force                           # roll 1000 unique editions
npm run rf:export -- --public-url https://your.site   # → ReelFortune3D/nft/

cd ../ReelFortune3D/contracts
forge test                                            # the contract suite
RPC_URL=... PRIVATE_KEY=... BASE_URI=https://your.site/nft/json/ ACTIVATE=1 bash deploy.sh
# paste the printed address into mint/config.js, set chainId — done
```

Local dry run: `anvil` in one terminal, `deploy.sh` against it (the address is deterministic, and
already in `mint/config.js`), serve the folder, open `mint.html`, add the anvil network to MetaMask.
[`contracts/README.md`](contracts/README.md) and [`mint/README.md`](mint/README.md) walk through it.

An Angler is a **cosmetic collectible you buy**. It is never paid out by a roll, a spin, a catch or
a drop — the soulbound argument in `contracts/README.md` for the deed wall still stands, and the
game's economy does not know the collection exists.

## 🛠️ Editing

Plain JavaScript — no build step. Open `game.js` and tweak:

- **World** — `N`, `WORLDS` (themes/seeds/costs), `fbm()` falloff, `tex*()` palettes
- **Fish** — `TABLE` (species, rarity, value, weight, `night/rain/storm` conditions)
- **Economy** — `ORE_INFO`, `upCost`/`UP_REQ` crafting, `MKT_MS` rotation, `STOCKS` (bases, volatility, yields), Pearl prices in `KIOSK_TITLES`/`BUCKET_COST`
- **Look** — `CAM_OFF`, lights, `DAYKEYS` day/night palette, glass tokens in `index.html`

Save, refresh, play.

Adding a **feature** rather than tuning one? It goes in a `mods/` slot, not in `game.js` —
read [`mods/SPEC.md`](mods/SPEC.md) first. Changing anything the economy pays out means
changing it **twice**, in `game.js` and in `server/src/game/rules.js`; `server/test/parity.test.js`
fails the build if the two ever disagree, and `client-contract.test.js` fails it if a mod slot,
an event or an action name drifts.

## ✨ Everything inside

96×96 procedural islands · BFS-carved dirt paths · entrance monument gate · day/night cycle with dusk palettes · rain & thunderstorms · swaying grass, cherry trees, flowers, mushrooms · signature hero with a real pixel face, straw hat & swaying scarf (recolorable) · animated tool props (rod/pick/axe in hand) · fishing line & bobber · voxel particle bursts, screen shake & hit-stop · coin-fly & pearl toasts · glassmorphism UI with pixel-art icons · minimap with POIs & treasure X · hotbar + tabbed inventory · Fishdex with ??? silhouettes · treasure maps · achievements · procedural music & sfx (♪ to mute) · a physical 3D roulette table the camera flies onto · title screen with an orbiting camera and live map previews of all four worlds.

Built with [Three.js](https://threejs.org) r128, no build step, no dependencies past the engine itself.

Opened from a folder it is **pure client-side** and stays that way: your island lives in this
browser and nothing leaves it. Point it at a `server/` and you get sign-in, multiplayer, chat,
crews, the leaderboard and cloud saves — and the server takes over every roll, so the economy
stops being editable from the console. The wallet sign-in is an **identity** only: it signs a
plain-text message to prove an address is yours. No transaction is ever built, no chain is read,
no funds are touched, and the deed wall in `contracts/` is a trophy shelf with hash cosplay —
no value, ever. Just fortune.
