# Halaman mint — Reel Fortune Anglers

Landing page + mint untuk koleksi **Reel Fortune Anglers** (ERC-721, 1000 angler). Semua berjalan di
browser tanpa build step dan tanpa library: `mint.html` (CSS inline, tampilan sama persis dengan game),
`mint/config.js` (alamat kontrak & chain), `mint/eth.js` (helper JSON-RPC / ABI, `window.RFEth`),
`mint/mint.js` (aplikasinya, `window.RFMint`). Metadata dan gambar dibaca dari `nft/` di situs ini
sendiri (`nft/images/N.png`, `nft/json/N.json`, `nft/rarity.json`, `nft/collection.json` — hasil
`npm run rf:all` di engine). Kalau `nft/` belum ada, halaman tetap jalan: gambar jadi tile placeholder
dan bagian rarity menampilkan catatan.

## 1. Mengarahkan halaman ke kontrak yang sudah di-deploy

Buka `mint/config.js`:

```js
chainId: 31337,   // chain tempat halaman ini mint — harus salah satu key di `chains`
chains: {
  31337: { name: 'Anvil (local)', rpc: ['http://127.0.0.1:8545'], ..., contract: '0x5FbD…0aa3' },
  84532: { name: 'Base Sepolia',  rpc: ['https://sepolia.base.org'], explorer: 'https://sepolia.basescan.org', contract: '' },
  8453:  { name: 'Base',          ... contract: '' },
  ...
}
```

1. Deploy kontrak dengan `contracts/deploy.sh` (lihat `contracts/README.md`). Script itu mencetak
   alamat kontrak dan baris yang siap ditempel ke `mint/config.js`.
2. Tempel alamatnya ke `chains[<id>].contract`, lalu set `chainId` ke id chain tersebut
   (`84532` Base Sepolia, `8453` Base mainnet, `11155111` Sepolia, `137` Polygon).
3. Pastikan `BASE_URI` kontrak menunjuk ke `https://<domain-kamu>/nft/json/` dan `nft/` sudah
   di-export dengan `--public-url https://<domain-kamu>`.

Kalau `contract` untuk chain aktif masih kosong, halaman tetap tampil dan tombol mint diganti
tulisan "Contract not deployed on <chain> yet". Untuk mencoba chain lain tanpa mengubah file, tambahkan
`?chain=84532` di URL.

RPC yang dipakai untuk membaca supply/harga adalah `chains[chainId].rpc[0]` — dibaca lewat `fetch`
biasa, jadi pengunjung tanpa wallet pun melihat data live. Untuk mint dipakai wallet (EIP-1193):
kalau chain wallet berbeda, halaman minta `wallet_switchEthereumChain`, dan kalau chain-nya belum ada
di wallet (error 4902) halaman menambahkannya dulu dari config.

## 2. Menjalankan lokal dengan anvil + MetaMask

```bash
# terminal 1 — chain lokal
anvil

# terminal 2 — deploy + aktifkan sale (kunci account #0 milik anvil)
cd contracts
RPC_URL=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
BASE_URI=http://localhost:8000/nft/json/ ACTIVATE=1 ./deploy.sh
# kontrak pertama dari account #0 (nonce 0) selalu mendarat di
# 0x5FbDB2315678afecb367f032d93F642f64180aa3 — sudah terisi di config.js untuk chain 31337

# terminal 3 — sajikan situs (root repo)
python3 -m http.server 8000
# buka http://localhost:8000/mint.html
```

MetaMask:

1. Settings → Networks → Add network manually: nama `Anvil`, RPC `http://127.0.0.1:8545`,
   chain id `31337`, simbol `ETH`. (Atau biarkan halaman yang menambahkannya saat Connect.)
2. Import account → private key account #0 di atas (atau account #1
   `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`). Saldo 10.000 ETH palsu.
3. Klik **Connect** di halaman, pilih jumlah, **Mint**. Kalau anvil di-restart, reset nonce akun di
   MetaMask (Settings → Advanced → Clear activity tab data), kalau tidak transaksi nyangkut.

Catatan: server Node di `server/` juga bisa dipakai untuk menyajikan situs — ia melayani root repo
dan menolak `/contracts`, `/server`, dll.

## 3. Menjalankan tes

```bash
node mint/test/selectors.test.js
```

Butuh Foundry (`cast` di PATH atau `~/.foundry/bin`). Tes ini:

- menghitung ulang **setiap selector** yang di-hard-code di `mint/eth.js` dengan `cast sig` dan gagal
  kalau ada yang beda (fungsi `mint(uint256)`, `totalSupply()`, … dan custom error `SaleNotActive()`,
  `WalletLimit()`, …);
- membandingkan encoder (`encodeCall`) dengan `cast calldata` dan decoder (`decodeUintArray`,
  `decodeString`, `decodeBool`, `decodeUint`) dengan output `cast abi-encode`;
- mengecek parsing log `Transfer` dari receipt dan decoding revert data;
- kalau `contracts/ReelFortuneAnglers.abi.json` ada, memastikan semua fungsi/error yang dipanggil
  halaman memang ada di ABI hasil compile.

Kalau ABI kontrak berubah (nama fungsi, parameter), jalankan `forge inspect ReelFortuneAnglers abi`
ulang ke `contracts/ReelFortuneAnglers.abi.json`, perbarui selector di `mint/eth.js`, lalu tes lagi.

## 4. Mengetes halaman tanpa MetaMask (headless)

`window.RFMint` mengekspos `connect()`, `refresh()`, `mint(qty)`, `setQty(n)`, `state`, dan
`events` (EventTarget: `ready`, `chain`, `connect`, `account`, `status`, `mint:start`, `mint:sent`,
`mint:done`, `error`, `accountsChanged`, `chainChanged`, `rarity`, `refresh`). Untuk tes otomatis,
pasang `window.ethereum` palsu yang meneruskan `eth_estimateGas` / `eth_sendTransaction` /
`eth_getTransactionReceipt` ke anvil (akun dev anvil sudah unlocked, jadi `eth_sendTransaction`
tanpa tanda tangan berhasil) dan jawab `eth_requestAccounts` dengan alamat akun dev — lalu panggil
`RFMint.connect().then(() => RFMint.mint(2))`.
