#!/usr/bin/env bash
# deploy.sh — deploy ReelFortuneAnglers.sol with plain `forge create`.
# No forge-std, no Foundry scripts, no OpenZeppelin: just forge + cast.
#
# ---------------------------------------------------------------------------
#  ANVIL QUICKSTART (local chain, chain id 31337)
# ---------------------------------------------------------------------------
#
#   # terminal 1 — local chain, listens on http://127.0.0.1:8545
#   anvil
#
#   # terminal 2 — from GAME/contracts
#   RPC_URL=http://127.0.0.1:8545 \
#   PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
#   BASE_URI=http://localhost:8000/nft/json/ \
#   ACTIVATE=1 \
#   ./deploy.sh
#
#   That private key is anvil's account #0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
#   10 000 ETH). The FIRST contract it deploys (nonce 0) always lands at
#       0x5FbDB2315678afecb367f032d93F642f64180aa3
#   which is exactly the `contract` already written for chain 31337 in
#   GAME/mint/config.js. Restart anvil (fresh nonce 0) to get that address again.
#
#   Then serve the game (python3 -m http.server 8000 from GAME) and open
#   http://localhost:8000/mint.html with MetaMask on "Anvil (local)".
#
# ---------------------------------------------------------------------------
#  ENVIRONMENT
# ---------------------------------------------------------------------------
#   RPC_URL         JSON-RPC endpoint            (default http://127.0.0.1:8545)
#   PRIVATE_KEY     deployer key, 0x-prefixed    (REQUIRED) -> becomes owner()
#   MAX_SUPPLY      collection size              (default 1000)
#   MINT_PRICE_WEI  price per token in wei       (default 420000000000000 = 0.00042 ether ≈ $1)
#   MAX_PER_WALLET  public-mint cap per wallet   (default 5)
#   BASE_URI        metadata prefix, WITH the trailing slash (REQUIRED)
#                   e.g. https://reelfortune.example/nft/json/
#   ACTIVATE=1      also call setSaleActive(true) right after deploying
#
#   Testnet / mainnet examples:
#     RPC_URL=https://sepolia.base.org       PRIVATE_KEY=0x... BASE_URI=https://site/nft/json/ ./deploy.sh
#     RPC_URL=https://mainnet.base.org       PRIVATE_KEY=0x... BASE_URI=https://site/nft/json/ ./deploy.sh
#
#   Robinhood Chain (Arbitrum Orbit L2, gas paid in ETH, deploy permissionless):
#     # TESTNET first — free ETH from the faucet, chain id 46630
#     RPC_URL=https://rpc.testnet.chain.robinhood.com PRIVATE_KEY=0x... \
#       BASE_URI=https://your.site/nft/json/ ACTIVATE=1 ./deploy.sh
#     # MAINNET — real ETH bridged to Robinhood Chain, chain id 4663
#     RPC_URL=https://rpc.mainnet.chain.robinhood.com PRIVATE_KEY=0x... \
#       BASE_URI=https://your.site/nft/json/ ACTIVATE=1 ./deploy.sh
#   After it prints the address, paste it into mint/config.js chains[4663].contract
#   (or [46630] for testnet) and set chainId there. Verify on Blockscout:
#     https://robinhoodchain.blockscout.com  (mainnet)
#
set -euo pipefail

# Always run from the contracts folder so forge finds foundry.toml.
cd "$(dirname "${BASH_SOURCE[0]}")"

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
MAX_SUPPLY="${MAX_SUPPLY:-1000}"
MINT_PRICE_WEI="${MINT_PRICE_WEI:-420000000000000}"
MAX_PER_WALLET="${MAX_PER_WALLET:-5}"
ACTIVATE="${ACTIVATE:-0}"

die() { echo "deploy.sh: $*" >&2; exit 1; }

command -v forge >/dev/null 2>&1 || die "forge not found on PATH (install Foundry: https://getfoundry.sh; ~/.foundry/bin)"
command -v cast  >/dev/null 2>&1 || die "cast not found on PATH"
[[ -n "${PRIVATE_KEY:-}" ]] || die "PRIVATE_KEY is required (0x-prefixed hex)"
[[ -n "${BASE_URI:-}" ]]    || die "BASE_URI is required, e.g. BASE_URI=https://site/nft/json/"
# baseURI is baked into the contract and read verbatim by every wallet and
# marketplace, so a malformed one (a stray copy-paste space, a missing scheme,
# no trailing slash) silently ships tokenURIs nobody can fetch. It IS repairable
# later with setBaseURI(string), but the first paid mints would show broken art
# until someone noticed — so hard-fail here instead of warning. To deploy with
# an empty baseURI on purpose and set it later, pass BASE_URI=- (a lone dash).
if [[ "$BASE_URI" == "-" ]]; then
  BASE_URI=""
  echo "deploy.sh: NOTE: deploying with an EMPTY baseURI; tokenURI() returns \"\" until you run setBaseURI(string)." >&2
else
  [[ "$BASE_URI" =~ [[:space:]] ]] && die "BASE_URI contains whitespace: '$BASE_URI' — a space in a metadata URL makes every tokenURI unfetchable. Fix the value (no spaces)."
  [[ "$BASE_URI" =~ ^https?://.+/$ ]] || die "BASE_URI must look like 'https://host/path/nft/json/' — an http(s):// URL ending in '/'. Got: '$BASE_URI'. (Pass BASE_URI=- to deploy empty and set it later.)"
fi
[[ "$MAX_SUPPLY" =~ ^[0-9]+$ && "$MINT_PRICE_WEI" =~ ^[0-9]+$ && "$MAX_PER_WALLET" =~ ^[0-9]+$ ]] \
  || die "MAX_SUPPLY / MINT_PRICE_WEI / MAX_PER_WALLET must be plain integers"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")" || die "cannot reach RPC_URL=$RPC_URL"
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")" || die "PRIVATE_KEY is not a valid key"
PRICE_ETH="$(cast from-wei "$MINT_PRICE_WEI" 2>/dev/null || echo '?')"

echo "== ReelFortuneAnglers deploy"
echo "   rpc            $RPC_URL  (chain id $CHAIN_ID)"
echo "   deployer/owner $DEPLOYER"
echo "   MAX_SUPPLY     $MAX_SUPPLY"
echo "   MINT_PRICE_WEI $MINT_PRICE_WEI  (= $PRICE_ETH ether)"
echo "   MAX_PER_WALLET $MAX_PER_WALLET"
echo "   BASE_URI       $BASE_URI"
echo

# forge >= 1.0 needs --broadcast, otherwise `forge create` only dry-runs.
# --json makes the result machine-readable: {"deployer":..,"deployedTo":..,"transactionHash":..}
CREATE_OUT="$(forge create ReelFortuneAnglers.sol:ReelFortuneAnglers \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --json \
  --constructor-args "$MAX_SUPPLY" "$MINT_PRICE_WEI" "$MAX_PER_WALLET" "$BASE_URI")" \
  || die "forge create failed (see output above)"

ADDR="$(printf '%s\n' "$CREATE_OUT" | grep -oE '"deployedTo": *"0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}' | head -n1 || true)"
if [[ -z "$ADDR" ]]; then
  # Fallback for a non-JSON "Deployed to: 0x..." line.
  ADDR="$(printf '%s\n' "$CREATE_OUT" | grep -oE 'Deployed to: *0x[0-9a-fA-F]{40}' | grep -oE '0x[0-9a-fA-F]{40}' | head -n1 || true)"
fi
[[ -n "$ADDR" ]] || { printf '%s\n' "$CREATE_OUT" >&2; die "could not find the deployed address in forge output"; }
TX="$(printf '%s\n' "$CREATE_OUT" | grep -oE '"transactionHash": *"0x[0-9a-fA-F]{64}"' | grep -oE '0x[0-9a-fA-F]{64}' | head -n1 || true)"

echo "== deployed"
echo "   ReelFortuneAnglers at: $ADDR"
[[ -n "$TX" ]] && echo "   tx: $TX"

if [[ "$ACTIVATE" == "1" ]]; then
  echo
  echo "== ACTIVATE=1 -> setSaleActive(true)"
  cast send "$ADDR" "setSaleActive(bool)" true --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null \
    || die "setSaleActive(true) failed"
  echo "   saleActive = $(cast call "$ADDR" 'saleActive()(bool)' --rpc-url "$RPC_URL")"
fi

cat <<EOF

== sanity (cast call)
   name         $(cast call "$ADDR" 'name()(string)' --rpc-url "$RPC_URL")
   MAX_SUPPLY   $(cast call "$ADDR" 'MAX_SUPPLY()(uint256)' --rpc-url "$RPC_URL")
   mintPrice    $(cast call "$ADDR" 'mintPrice()(uint256)' --rpc-url "$RPC_URL")
   maxPerWallet $(cast call "$ADDR" 'maxPerWallet()(uint256)' --rpc-url "$RPC_URL")
   saleActive   $(cast call "$ADDR" 'saleActive()(bool)' --rpc-url "$RPC_URL")
   owner        $(cast call "$ADDR" 'owner()(address)' --rpc-url "$RPC_URL")

== admin commands (owner key only)
   # open / close the public mint
   cast send $ADDR "setSaleActive(bool)" true  --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   cast send $ADDR "setSaleActive(bool)" false --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   # point metadata somewhere else (keep the trailing slash)
   cast send $ADDR "setBaseURI(string)" "$BASE_URI" --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   # sweep the ETH to owner()
   cast send $ADDR "withdraw()" --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   # (optional) price / cap / royalty
   cast send $ADDR "setMintPrice(uint256)" $MINT_PRICE_WEI --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   cast send $ADDR "setMaxPerWallet(uint256)" $MAX_PER_WALLET --rpc-url $RPC_URL --private-key \$PRIVATE_KEY
   cast send $ADDR "setRoyalty(address,uint96)" $DEPLOYER 500 --rpc-url $RPC_URL --private-key \$PRIVATE_KEY

== mint page: paste into GAME/mint/config.js, inside chains[$CHAIN_ID]
   contract: '$ADDR',
   (and make sure chainId: $CHAIN_ID is the active chain, or open mint.html?chain=$CHAIN_ID)

== read back any time
   cast call $ADDR "totalSupply()(uint256)" --rpc-url $RPC_URL
   cast call $ADDR "tokenURI(uint256)(string)" 1 --rpc-url $RPC_URL
EOF
