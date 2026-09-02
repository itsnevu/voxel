#!/usr/bin/env bash
# Ganti mintPrice Reel Fortune Anglers jadi ~$1 di Robinhood Chain mainnet.
# Jalankan:  bash ~/Documents/ReelFortune3D/contracts/set-mint-price.sh
set -euo pipefail

RPC="https://robinhood-rpc.publicnode.com"
NFT="0x24E754Ae2Ca4b7e150c307Fc87FF6504e02b9cac"
PRICE="${PRICE:-420000000000000}"          # 0.00042 ETH ~= $1

die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m%s\033[0m\n' "$*"; }

command -v cast >/dev/null || die "foundry/cast tidak ketemu di PATH"

echo "Membaca kontrak on-chain..."
OWNER=$(cast call "$NFT" 'owner()(address)'       --rpc-url "$RPC")
CUR=$(  cast call "$NFT" 'mintPrice()(uint256)'   --rpc-url "$RPC" | awk '{print $1}')
SUP=$(  cast call "$NFT" 'totalSupply()(uint256)' --rpc-url "$RPC" | awk '{print $1}')

ETHUSD=$(curl -s -m 10 "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd" \
         | sed -n 's/.*"usd":\([0-9.]*\).*/\1/p'); ETHUSD="${ETHUSD:-0}"
usd() { python3 -c "print('\$%.2f' % ($1/1e18*$ETHUSD))" 2>/dev/null || echo "?"; }

echo
echo "  owner kontrak  $OWNER"
echo "  sudah ke-mint  $SUP"
echo "  harga now      $(cast from-wei "$CUR") ETH  ( $(usd "$CUR") )"
echo "  harga baru     $(cast from-wei "$PRICE") ETH  ( $(usd "$PRICE") )"
echo

[ "$CUR" = "$PRICE" ] && { ok "Harga sudah benar. Tidak ada yang perlu dikirim."; exit 0; }

cat <<'HELP'
──────────────────────────────────────────────────────────────────
 Butuh PRIVATE KEY dari wallet owner di atas.
 Ambil di: MetaMask/Rabby > pilih akun itu > Account details
           > Show/Export private key

 Bentuknya 64 huruf-angka, contoh (INI CUMA CONTOH, BUKAN PUNYAMU):
   4c0883a69102937d6231471b5dbb6204fe512961708279e2e3a15f3f6b8c9a71

 BUKAN yang ini (itu alamat, 40 karakter, diawali 0x65d3...):
   0x65d34E999dA43e96D6B24AD983161df2B3aADBc2
──────────────────────────────────────────────────────────────────
HELP

printf 'Paste private key lalu Enter (tidak akan kelihatan di layar): '
read -rs PK; echo; echo

PK="${PK// /}"; PK="${PK#0x}"
[ -n "$PK" ] || die "kosong. Tidak ada yang dikirim."
case "$PK" in *[!0-9a-fA-F]*) die "ada karakter yang bukan hex. Yang di-paste bukan private key." ;; esac
if [ "${#PK}" -eq 40 ]; then
  die "itu ALAMAT wallet (40 karakter), bukan private key. Private key panjangnya 64. Export dulu dari wallet-mu."
fi
[ "${#PK}" -eq 64 ] || die "panjangnya ${#PK} karakter, seharusnya 64. Cek lagi hasil export dari wallet."

FROM=$(cast wallet address --private-key "0x$PK") || die "private key tidak valid"
echo "  wallet-mu      $FROM"

if [ "$(echo "$FROM" | tr 'A-Z' 'a-z')" != "$(echo "$OWNER" | tr 'A-Z' 'a-z')" ]; then
  die "wallet ini BUKAN owner kontrak. Tx pasti ditolak. Kamu butuh key dari $OWNER"
fi
ok "  ✓ cocok dengan owner"

BAL=$(cast balance "$FROM" --rpc-url "$RPC" | awk '{print $1}')
echo "  saldo          $(cast from-wei "$BAL") ETH"
[ "$BAL" = "0" ] && die "saldo 0 ETH — tidak bisa bayar gas"

echo
printf 'Kirim sekarang? ketik ya lalu Enter: '
read -r GO
[ "$GO" = "ya" ] || die "dibatalkan, tidak ada yang dikirim"
echo

cast send "$NFT" "setMintPrice(uint256)" "$PRICE" --rpc-url "$RPC" --private-key "0x$PK"

echo
NEW=$(cast call "$NFT" 'mintPrice()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
[ "$NEW" = "$PRICE" ] \
  && ok "BERES — mintPrice = $(cast from-wei "$NEW") ETH ( $(usd "$NEW") )" \
  || die "harga on-chain masih $NEW — tx gagal atau belum ter-mine"
