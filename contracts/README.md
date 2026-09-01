# Isle Ledger Deeds — Kontrak Sertifikat Pencapaian (Soulbound)

Kontrak: [`IsleLedger.sol`](./IsleLedger.sol) → `contract IsleLedgerDeeds`
Solidity `^0.8.20`, **tanpa dependency eksternal** (tidak import OpenZeppelin — ECDSA, Base64, dan uint→string ditulis sendiri di file yang sama).

Ini adalah komponen **opsional dan terpisah** dari game. Backend otoritatif (`/server`) tetap jalan normal tanpa blockchain sama sekali. Kontrak ini hanya menambah satu hal: pemain bisa mencetak "piagam" on-chain untuk pencapaian yang **sudah diverifikasi server**.

---

## (a) Apa itu Soulbound, dan kenapa dipilih

**Soulbound Token (SBT)** = token NFT yang **melekat permanen** ke satu alamat wallet. Sekali di-mint, tidak bisa dipindahkan ke alamat lain. Istilahnya dipopulerkan Vitalik Buterin (2022) untuk kredensial, ijazah, badge, dan reputasi — hal-hal yang secara konsep **tidak masuk akal diperjualbelikan**.

Di `IsleLedgerDeeds`, sifat ini dipaksakan di level kontrak:

| Fungsi ERC-721 | Perilaku |
|---|---|
| `transferFrom` | `revert Soulbound()` |
| `safeTransferFrom` (2 overload) | `revert Soulbound()` |
| `approve` | `revert Soulbound()` |
| `setApprovalForAll` | `revert Soulbound()` |
| `getApproved` | selalu `address(0)` |
| `isApprovedForAll` | selalu `false` |

Sengaja `revert` (bukan diam-diam no-op) supaya marketplace dan wallet **gagal keras** dan tidak pernah menampilkan deed ini sebagai barang yang bisa di-*list*.

### Kenapa ini penting untuk game ini secara spesifik

Reel Fortune 3D punya mekanik acak: roll ikan, drop ore, drop saham, **roulette**, kiosk. Semuanya dihitung server dan hasilnya adalah angka in-game (`coins`, `pearls`, item). Selama angka itu tidak bisa ditukar uang nyata, itu **game**, bukan judi.

Rantai logikanya begini:

```
token bisa dijual  →  token punya harga pasar  →  hasil acak in-game membayar sesuatu
                      yang bernilai uang nyata  →  itu JUDI UANG NYATA
```

Soulbound memutus rantai itu di langkah pertama:

- **Tidak ada pasar sekunder** → tidak ada harga → tidak ada nilai tukar uang.
- Deed **tidak pernah menjadi hadiah dari roulette/kiosk**. Deed hanya diberikan untuk pencapaian deterministik ("pernah menangkap ikan X", "pernah mencapai level pickaxe Y") yang sudah dicatat server.
- Deed = trophy/piagam. Nilainya reputasi, bukan uang.

Tambahan pengaman di kontrak: **tidak ada fungsi `payable`, tidak ada harga mint, tidak ada `withdraw`, kontrak tidak pernah memegang dana apa pun.** Tidak ada uang yang bisa masuk maupun keluar.

### Fitur teknis singkat

- ERC-721 metadata minimal: `name` ("Isle Ledger Deeds"), `symbol` ("DEED"), `ownerOf`, `balanceOf`, `tokenURI`, `supportsInterface` untuk `0x01ffc9a7` (165), `0x80ac58cd` (721), `0x5b5e139f` (721Metadata).
- Mint **hanya** lewat `claim()` bertanda tangan backend (ECDSA + prefix EIP-191).
- `tokenId = uint256(keccak256(abi.encodePacked(player, deedId)))` → deterministik & unik per (pemain, deed). Satu pemain tidak bisa punya deed yang sama dua kali.
- Anti-replay: `mapping(bytes32 => bool) used` atas digest, plus cek `tokenId` sudah ada, plus digest mengikat `address(this)` dan `block.chainid` (anti replay lintas-kontrak dan lintas-chain), plus signature terikat `msg.sender` (signature pemain A tidak bisa dipakai pemain B).
- Signature malleability ditolak (EIP-2: `s` di upper-half order ditolak).
- `tokenURI` menghasilkan `data:application/json;base64` berisi **SVG on-chain** bergaya pixel (kartu gelap, judul deed, block number). Tidak butuh IPFS, tidak butuh server metadata — kalau VPS mati, piagamnya tetap ada.
- `deedId` divalidasi ketat: hanya `[A-Za-z0-9 . _ -]`, panjang 1–32. Ini yang membuat penanaman string langsung ke JSON/SVG aman (tidak ada `"`, `<`, `>`).
- Bonus: `tokensOfOwner(address)` mengembalikan semua tokenId milik satu alamat. Aman disimpan sebagai array append-only justru **karena** soulbound — tidak ada transfer, jadi tidak pernah perlu hapus elemen.

---

## (b) Deploy di TESTNET lewat Remix (langkah demi langkah)

> **Deploy di TESTNET saja** (Sepolia atau Base Sepolia). ETH testnet tidak punya nilai uang. Jangan deploy ke mainnet kecuali kamu benar-benar paham konsekuensi hukum & biayanya.

### 0. Siapkan wallet + ETH testnet

1. Install MetaMask.
2. Buat wallet **khusus development** (JANGAN pakai wallet yang berisi aset asli).
3. Tambahkan jaringan:
   - **Sepolia** — biasanya sudah ada di MetaMask (aktifkan "Show test networks" di Settings → Advanced).
   - **Base Sepolia** — Chain ID `84532`, RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`.
4. Ambil ETH testnet dari faucet (cari "Sepolia faucet" / "Base Sepolia faucet"). Butuh sedikit saja, ~0.01 ETH cukup.

### 1. Buka Remix

Buka <https://remix.ethereum.org>.

### 2. Masukkan file kontrak

Di panel **File Explorer**, folder `contracts`, buat file baru `IsleLedger.sol`, lalu **copy-paste seluruh isi** [`IsleLedger.sol`](./IsleLedger.sol) dari repo ini.

### 3. Compile

1. Buka tab **Solidity Compiler** (ikon huruf S di sidebar kiri).
2. Compiler version: pilih **0.8.20** atau lebih baru (misal `0.8.24`).
3. (Opsional, disarankan) Advanced Configurations → centang **Enable optimization**, runs `200`.
   `tokenURI` merangkai SVG cukup panjang, optimizer membantu ukuran bytecode.
4. Klik **Compile IsleLedger.sol**. Pastikan muncul centang hijau, tanpa error.

> Kontrak ini sudah diuji kompilasi pada solc **0.8.20** dan **0.8.24**, dengan optimizer **on maupun off**, tanpa perlu `viaIR`. Ukuran deployed bytecode ~10 KB (batas EIP-170 = 24 KB), jadi masih lega.

### 4. Deploy

1. Buka tab **Deploy & Run Transactions** (ikon logo Ethereum).
2. **ENVIRONMENT**: pilih **Injected Provider - MetaMask**.
3. MetaMask akan minta connect → izinkan. Pastikan jaringan yang aktif di MetaMask adalah **Sepolia** / **Base Sepolia** — Remix akan menampilkan chain id-nya, cek ulang di sini.
4. **CONTRACT**: pilih `IsleLedgerDeeds - contracts/IsleLedger.sol`.
5. Di sebelah tombol **Deploy** ada satu field konstruktor: `_INITIALSIGNER (address)`.
   - Isi dengan **alamat public dari wallet backend** (lihat bagian (c)), atau
   - Isi `0x0000000000000000000000000000000000000000` dulu, lalu set nanti pakai `setSigner`.
6. Klik **Deploy** → konfirmasi di MetaMask → tunggu transaksi selesai.
7. Kontrak muncul di **Deployed Contracts**. Klik ikon **copy** untuk menyalin alamat kontrak. **Simpan alamat ini** — nanti dipakai backend dan frontend.

### 5. (Opsional) Verifikasi di block explorer

Supaya orang bisa membaca source code-nya di Etherscan/Basescan:

1. Buka Etherscan Sepolia / Basescan Sepolia → cari alamat kontrak.
2. **Contract → Verify and Publish**.
3. Compiler type: **Solidity (Single file)**, versi compiler harus **persis sama** dengan yang dipakai di Remix, License: **MIT**.
4. Paste source code, isi setting optimizer **persis sama** (enabled + runs 200 kalau tadi dinyalakan).
5. Constructor arguments biasanya terdeteksi otomatis; kalau tidak, ambil dari tab Input Data transaksi deploy.

Alternatif: plugin **Contract Verification** di dalam Remix.

---

## (c) Mengatur `signer` ke alamat backend

`signer` adalah alamat wallet yang **private key-nya dipegang backend**. Hanya tanda tangan dari alamat ini yang diterima `claim()`.

### 1. Buat wallet backend

Wallet ini **khusus untuk menandatangani**, tidak perlu berisi ETH sama sekali (penandatanganan pesan itu off-chain dan gratis; gas untuk `claim()` dibayar pemain).

Buat sekali, lalu simpan private key-nya:

```bash
node -e "const{Wallet}=require('ethers');const w=Wallet.createRandom();console.log('addr:',w.address);console.log('pk  :',w.privateKey)"
```

> Kalau `ethers` belum terpasang di VPS, cukup buat wallet baru di MetaMask dan export private key-nya (Account details → Show private key). Sekali lagi: **wallet kosong, khusus signer.**

### 2. Simpan private key sebagai environment variable di VPS

Jangan pernah hardcode di source, jangan commit ke git, jangan kirim ke client.

```bash
# /etc/systemd/system/reelfortune.service  (atau .env yang di-gitignore)
DEED_SIGNER_PK=0x....
DEED_CONTRACT=0x....   # alamat kontrak hasil deploy
DEED_CHAIN_ID=11155111 # 11155111 = Sepolia, 84532 = Base Sepolia
```

Konsekuensi kalau private key ini bocor: siapa pun bisa mencetak deed palsu untuk dirinya sendiri. Tidak ada dana yang bisa dicuri (kontrak tidak memegang uang), tapi kredibilitas semua deed hilang. Kalau bocor: buat wallet baru → panggil `setSigner` dengan alamat baru → deed lama tetap valid, klaim baru pakai key baru.

### 3. Set signer di kontrak

Lewat Remix, dari wallet **owner** (wallet yang men-deploy):

1. Buka kontrak di **Deployed Contracts**.
2. Expand fungsi `setSigner`.
3. Isi `newSigner` dengan alamat wallet backend.
4. **transact** → konfirmasi di MetaMask.
5. Verifikasi: klik tombol biru `signer` (fungsi view) → harus mengembalikan alamat yang barusan di-set.

Fungsi admin lain: `transferOwnership(address)` untuk mengoper hak admin. Itu saja — tidak ada fungsi lain yang bisa dilakukan owner. Owner **tidak bisa** mencetak deed sendiri, tidak bisa membakar deed orang, tidak bisa menarik dana (tidak ada dana).

---

## (d) Alur claim dari game

### Ringkas

```
[Game/Client]                [Backend /server]              [Kontrak on-chain]
     |                              |                              |
  1. main game ------------------>  | state otoritatif di SQLite   |
     |                              | deteksi milestone tercapai   |
     |                              | deedsRepo.add(uid,deedId,..) |
     |                              |                              |
  2. "Claim on-chain" ---------->   |                              |
     kirim alamat wallet            | 3. cek deedsRepo.has()       |
     |                              |    hitung digest             |
     |                              |    tanda tangani (EIP-191)   |
     |                              |    deedsRepo.setClaim(...)   |
     | <-------- {deedId,blockNo,signature} ---------              |
     |                              |                              |
  4. wallet.claim(deedId, blockNo, signature) ----------------->   |
     (pemain bayar gas sendiri)                                    | verifikasi signer
     |                                                             | cek used[digest]
     | <------------------- DeedMinted event ----------------------|
```

### Langkah detail

**1. Server mencatat pencapaian.**
Milestone dideteksi **di dalam handler server** (`src/game/actions.js`), bukan di client. Contoh: setelah `HANDLERS.catch` menghasilkan ikan legendaris, server memanggil `deedsRepo.add(userId, 'legendary-catch', blockNo, hash)`. Client tidak pernah bisa mengarang pencapaian karena semua roll dihitung server.

`blockNo` adalah angka milestone yang mau diabadikan di sertifikat — misalnya total blok yang sudah ditambang, atau counter langkah in-game saat pencapaian terjadi. Bebas, asal deterministik dari state server.

**2. Pemain menekan "Claim on-chain" di UI**, menghubungkan wallet, dan mengirim alamatnya ke server (endpoint milik tim backend, misal `POST /api/deeds/sign` dengan `{ deedId, address }`, dilindungi `requireAuth`).

**3. Server menandatangani.** Yang **wajib** dilakukan server:

- Verifikasi sesi (`requireAuth` → `req.userId`).
- `deedsRepo.has(userId, deedId)` harus `true`. Kalau tidak, tolak — **jangan pernah** menandatangani deed yang tidak ada di DB.
- Validasi `address` sebagai alamat EVM yang benar (`/^0x[0-9a-fA-F]{40}$/`).
- Ambil `blockNo` **dari DB**, bukan dari body request.
- Rate-limit lewat `actions.mark/countSince`.

Kode penandatanganan (ethers v6):

```js
import { Wallet, solidityPackedKeccak256, getBytes } from 'ethers';

const wallet = new Wallet(process.env.DEED_SIGNER_PK);

// HARUS sama persis dengan claimDigest() di kontrak:
// keccak256(abi.encodePacked(player, deedId, blockNo, address(this), block.chainid))
const digest = solidityPackedKeccak256(
  ['address', 'string', 'uint256', 'address', 'uint256'],
  [playerAddress, deedId, blockNo, process.env.DEED_CONTRACT, Number(process.env.DEED_CHAIN_ID)]
);

// signMessage menambahkan prefix EIP-191 "\x19Ethereum Signed Message:\n32".
// getBytes() WAJIB — tanpa itu digest ditandatangani sebagai teks 66 karakter,
// bukan sebagai 32 byte, dan verifikasi di kontrak akan gagal.
const signature = await wallet.signMessage(getBytes(digest));

deedsRepo.setClaim(userId, deedId, playerAddress, signature);
res.json({ deedId, blockNo, signature });
```

Urutan dan tipe argumen harus **persis** seperti di atas. Salah satu tipe saja (misal `uint64` alih-alih `uint256`) → digest beda → `InvalidSignature()`.

**4. Client memanggil kontrak.** Pemain sendiri yang mengirim transaksi dan membayar gas:

```js
import { BrowserProvider, Contract } from 'ethers';

const ABI = ['function claim(string deedId, uint256 blockNo, bytes signature)'];
const provider = new BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const c = new Contract(process.env.DEED_CONTRACT, ABI, signer);

const tx = await c.claim(deedId, blockNo, signature);
await tx.wait();
```

Deed di-mint ke `msg.sender`. Karena digest mengikat `msg.sender`, signature yang dibuat untuk alamat A **tidak bisa** dipakai alamat B.

**5. Verifikasi & tampilkan.** Setelah `tx.wait()`, baca `tokensOfOwner(address)` lalu `tokenURI(tokenId)` untuk merender kartu SVG-nya, atau `deedOf(tokenId)` untuk data mentah (`deedId`, `blockNo`, `mintedAt`) tanpa perlu parsing base64.

### Error yang mungkin muncul di `claim()`

| Error | Artinya |
|---|---|
| `SignerNotSet()` | `signer` masih `address(0)` — jalankan `setSigner` dulu |
| `InvalidDeedId()` | `deedId` kosong, >32 karakter, atau mengandung karakter di luar `[A-Za-z0-9 . _ -]` |
| `AlreadyClaimed()` | Digest sudah pernah dipakai, atau pemain sudah punya deed itu |
| `BadSignatureLength()` | Signature bukan 65 byte |
| `InvalidSignature()` | Signer tidak cocok — biasanya `getBytes()` lupa dipakai, urutan/tipe argumen digest beda, atau alamat kontrak / chain id salah |
| `Soulbound()` | Ada yang mencoba transfer/approve. Ini memang perilaku yang diinginkan. |

### Debug `InvalidSignature()`

Panggil view `claimDigest(player, deedId, blockNo)` di Remix dan bandingkan hasilnya dengan `solidityPackedKeccak256(...)` di Node. Kalau dua digest ini beda, masalahnya ada di penyusunan digest. Kalau sama tapi tetap gagal, masalahnya ada di `signMessage` (hampir selalu: `getBytes()` tidak dipakai) atau `signer` di kontrak belum di-set ke alamat wallet backend.

---

## (e) ⚠️ PERINGATAN — JANGAN hubungkan token yang bisa dijual ke mekanik casino game ini

**Ini bagian terpenting dari dokumen ini. Baca sampai habis sebelum memodifikasi kontrak ini.**

Reel Fortune 3D punya **roulette**, **kiosk**, dan berbagai **roll acak**. Selama semua hadiah berupa angka in-game yang tidak bisa dicairkan, itu game biasa.

Begitu kamu menghubungkan **token yang bisa diperjualbelikan** (ERC-20, NFT transferable, atau apa pun yang punya pasar sekunder) ke mekanik-mekanik itu, statusnya berubah total:

> Bayar untuk ikut → hasil ditentukan kebetulan → hadiah bernilai uang nyata
> = **JUDI UANG NYATA**

Tiga unsur itulah definisi perjudian di hampir semua yurisdiksi. Tidak peduli tokennya disebut "poin", "gem", atau "utility token" — kalau ada pasar tempat orang menukarnya jadi uang, hukum melihatnya sebagai uang.

**Di Indonesia**, perjudian dalam bentuk apa pun dilarang. Rujukan yang relevan:

- **KUHP Pasal 303 & 303 bis** — menyelenggarakan/menawarkan kesempatan berjudi dan turut serta berjudi, dengan ancaman pidana penjara dan denda.
- **UU ITE** (UU 11/2008 jo. UU 19/2016 jo. UU 1/2024) **Pasal 27 ayat (2)** — mendistribusikan/mentransmisikan konten perjudian secara elektronik.
- Kominfo/Komdigi aktif memblokir domain, dan penyedia layanan pembayaran serta app store menerapkan larangan yang sama.

Yurisdiksi lain punya rezim lisensi masing-masing (UKGC, MGA, dst.) yang biayanya jauh di luar jangkauan proyek hobi, ditambah kewajiban KYC, AML, dan verifikasi umur.

### Yang HARUS dihindari

- ❌ Menjadikan token/NFT **transferable** sebagai hadiah roulette, kiosk, atau drop acak.
- ❌ Menambahkan fungsi `payable` supaya pemain bisa "beli chip" dengan kripto.
- ❌ Membuat jembatan `coins`/`pearls` in-game ⇄ token on-chain, ke arah mana pun.
- ❌ Menambahkan marketplace, fungsi `withdraw`, atau kolam hadiah (prize pool) apa pun.
- ❌ Menghapus `revert Soulbound()` "supaya pemain bisa tukar-tukaran deed". Itu satu commit yang mengubah proyek hobi menjadi operasi perjudian tanpa izin.

### Yang aman (dan itulah desain kontrak ini)

- ✅ Deed **soulbound** → tidak ada pasar → tidak ada nilai uang.
- ✅ Deed diberikan **hanya untuk pencapaian deterministik** yang dicatat server. **Deed tidak boleh pernah menjadi hadiah dari roulette/kiosk/undian.**
- ✅ Tidak ada `payable`, tidak ada harga, tidak ada `withdraw`, kontrak tidak pernah memegang dana.
- ✅ Roulette & mekanik acak lain tetap 100% ekonomi in-game (`coins`, `pearls`) yang tidak bisa dicairkan.
- ✅ Deploy di **testnet**, di mana ETH memang tidak punya nilai uang.

> Ringkasnya: kontrak ini didesain supaya **piagam tetap piagam**. Kalau kamu tergoda membuatnya bisa dijual, berhenti dulu — pertanyaannya bukan lagi soal teknis, tapi soal apakah kamu siap menjalankan (dan melisensikan) sebuah kasino.

**Disclaimer:** dokumen ini bukan nasihat hukum. Kalau kamu berencana membawa proyek ini ke mainnet atau menambahkan elemen bernilai uang, konsultasikan dengan penasihat hukum yang kompeten di yurisdiksimu terlebih dahulu.

---

# Reel Fortune Anglers — Koleksi NFT (ERC-721, BISA dipindahtangankan)

File: `ReelFortuneAnglers.sol` · tes: `test/ReelFortuneAnglers.t.sol` · ABI: `ReelFortuneAnglers.abi.json` · deploy: `deploy.sh` · config Foundry: `foundry.toml`.

Ini kontrak **kedua** di folder ini dan sengaja **berbeda total** dari Isle Ledger Deeds di atas. Anglers adalah koleksi PFP 1000 karakter (hero Reel Fortune 3D versi pixel/voxel, digenerate HashLips) yang **dibeli** lewat halaman `mint.html`, lalu boleh dipindahtangankan/dijual seperti ERC-721 pada umumnya.

## Kenapa boleh transferable, padahal deed di atas soulbound?

Semua argumen di bagian (a) dan (e) di atas **tetap berlaku 100 %** — untuk deed. Kuncinya ada di *cara token itu didapat*:

| | Isle Ledger Deeds | Reel Fortune Anglers |
|---|---|---|
| Cara dapat | pencapaian in-game, ditandatangani backend | **dibeli** dengan harga tetap di mint page |
| Hasil acak di game? | tidak pernah | **tidak pernah**, dan tidak akan pernah |
| Transfer | diblokir (`Soulbound()`) | bebas (ERC-721 penuh) |
| Payable / withdraw | tidak ada | ada (`mint()` bayar, `withdraw()` ke owner) |
| Hubungan ke `coins`/`pearls`/roulette/kiosk | tidak ada | **tidak ada** |

Yang menjadikan sesuatu "judi" adalah *mekanik acak di game yang membayar barang bernilai uang*. Anglers tidak pernah keluar dari roulette, kiosk, drop ikan, atau roll apa pun — satu-satunya jalur mint adalah `mint()` (bayar harga tetap, tanpa unsur acak) dan `ownerMint()` (cadangan tim). Jadi ia setara dengan membeli skin/merch: barang koleksi kosmetik yang harganya ditentukan pasar, bukan hadiah taruhan. Kalau suatu hari Anglers dipakai sebagai kosmetik di game (topi, warna vest), itu masih aman **selama** kepemilikannya tidak pernah menjadi *hadiah* mekanik acak dan tidak ada jembatan ke ekonomi in-game. Peringatan (e) di atas tetap jadi garis merah.

## Ringkasan kontrak

- `pragma solidity ^0.8.20`, **tanpa import** (konvensi repo: semua helper di dalam file).
- ERC-721 + Metadata + ERC-165 + ERC-2981 (royalti, default 5 % ke deployer, maksimum 10 %).
- Id berurutan mulai **1** (HashLips mode ETH juga 1-indexed). Tidak ada burn → `totalSupply()` = id tertinggi.
- `tokenURI(id)` = `baseURI + id + ".json"` → contoh `https://situs/nft/json/7.json` (dilayani situs game sendiri, folder `nft/`). `baseURI` kosong → `tokenURI` mengembalikan `""`.
- `mint(quantity)` payable; urutan pengecekan **tetap** (mint page mengandalkan ini untuk menerjemahkan revert): `SaleNotActive` → `InvalidQuantity` (0 atau > `maxPerWallet`) → `SoldOut` → `WalletLimit` → `WrongPayment` (harus persis `mintPrice * quantity`).
- `mint()` **tidak melakukan external call sama sekali** (tanpa hook `onERC721Received`). Alasannya: satu-satunya fungsi payable jadi bebas reentrancy, `eth_estimateGas` di mint page stabil, dan pembeli di page memang EOA. Contract wallet tetap bisa mint dan memindahkan tokennya belakangan dengan `safeTransferFrom`.
- `ownerMint(to, qty)` — cadangan tim; hanya dibatasi `MAX_SUPPLY`, tidak menghitung `mintedBy`.
- `tokensOfOwner(addr)` — untuk `eth_call` dari mint page ("Your Anglers"); memindai 1..totalSupply, murah untuk 1000 token. ERC-721 Enumerable sengaja **tidak** diklaim.
- Admin (`owner()`, bisa `transferOwnership`): `setSaleActive`, `setMintPrice`, `setMaxPerWallet`, `setBaseURI`, `setRoyalty(receiver, bps ≤ 1000)`, `withdraw()` (seluruh saldo ke owner via `call`; gagal → `WithdrawFailed()`).
- Pola checks-effects-interactions di semua fungsi. External call hanya ada di `safeTransferFrom` (setelah state berubah) dan `withdraw()` (ke owner saja).

## Compile & tes (Foundry, tanpa forge-std)

```bash
cd contracts
forge build          # solc diunduh otomatis oleh forge
forge test -vv       # 36 tes, semua pakai require + interface Vm buatan sendiri
forge inspect ReelFortuneAnglers abi --json > ReelFortuneAnglers.abi.json   # regenerasi ABI kalau kontrak berubah
```

`foundry.toml` di folder ini: `src = "."`, `test = "test"`, `libs = []` (tidak ada dependency), optimizer 200 runs. Folder `out/`, `cache/`, `broadcast/` sudah di-gitignore.

## Deploy

`deploy.sh` memakai `forge create` biasa (forge ≥ 1.0 butuh `--broadcast`, sudah di dalam skrip). Variabel:

| Env | Default | Keterangan |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8545` | endpoint JSON-RPC |
| `PRIVATE_KEY` | *(wajib)* | key deployer → jadi `owner()` |
| `MAX_SUPPLY` | `1000` | ukuran koleksi |
| `MINT_PRICE_WEI` | `5000000000000000` | 0.005 ether |
| `MAX_PER_WALLET` | `5` | cap per wallet untuk `mint()` |
| `BASE_URI` | *(wajib)* | contoh `https://situs/nft/json/` — **pakai slash di akhir** |
| `ACTIVATE=1` | off | langsung `setSaleActive(true)` |

Skrip mencetak alamat kontrak, hasil `cast call` sanity, baris `cast send` untuk `setSaleActive` / `setBaseURI` / `withdraw`, dan baris `contract: '0x…'` yang tinggal ditempel ke `mint/config.js`.

### 1. Anvil (lokal, chain id 31337)

```bash
# terminal 1
anvil

# terminal 2
cd contracts
RPC_URL=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
BASE_URI=http://localhost:8000/nft/json/ \
ACTIVATE=1 ./deploy.sh
```

Key itu = akun #0 anvil (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, 10 000 ETH). Kontrak pertama yang ia deploy (nonce 0) **selalu** mendarat di `0x5FbDB2315678afecb367f032d93F642f64180aa3`, dan alamat itu sudah tertulis untuk chain 31337 di `mint/config.js`. Kalau anvil di-restart, deploy ulang dan alamatnya sama lagi.

Coba mint dari akun #1 lewat `cast`:

```bash
A=0x5FbDB2315678afecb367f032d93F642f64180aa3
cast send $A "mint(uint256)" 2 --value 10000000000000000 --rpc-url http://127.0.0.1:8545 \
  --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
cast call $A "totalSupply()(uint256)" --rpc-url http://127.0.0.1:8545
cast call $A "ownerOf(uint256)(address)" 1 --rpc-url http://127.0.0.1:8545
cast call $A "tokenURI(uint256)(string)" 1 --rpc-url http://127.0.0.1:8545
```

### 2. Base Sepolia (testnet, chain id 84532)

1. Isi wallet deployer dengan ETH Base Sepolia (faucet Coinbase / Alchemy / QuickNode).
2. Deploy: `RPC_URL=https://sepolia.base.org PRIVATE_KEY=0x… BASE_URI=https://situs-kamu/nft/json/ ./deploy.sh`
3. Tempel alamatnya ke `mint/config.js` → `chains[84532].contract`, set `chainId: 84532` (atau buka `mint.html?chain=84532`).
4. Aktifkan penjualan saat siap: `cast send <ADDR> "setSaleActive(bool)" true --rpc-url https://sepolia.base.org --private-key 0x…`
5. (Opsional) verifikasi: `forge verify-contract <ADDR> ReelFortuneAnglers.sol:ReelFortuneAnglers --chain 84532 --constructor-args $(cast abi-encode "constructor(uint256,uint256,uint256,string)" 1000 5000000000000000 5 "https://situs-kamu/nft/json/") --etherscan-api-key <KEY>`

### 3. Base mainnet (chain id 8453)

Sama seperti testnet dengan `RPC_URL=https://mainnet.base.org` dan `chains[8453]` di `mint/config.js`. Sebelum mainnet:

- `nft/` (gambar + JSON) sudah online di `BASE_URI` dan bisa dibuka publik (`curl https://situs/nft/json/1.json`).
- `owner()` sebaiknya hardware wallet / multisig — `transferOwnership()` setelah deploy kalau deployer-nya key sekali pakai.
- `setRoyalty()` kalau ingin penerima royalti bukan deployer.
- Baca ulang peringatan (e) di atas: Anglers **tidak boleh** dijadikan hadiah mekanik acak apa pun.

## MetaMask untuk anvil

1. MetaMask → Settings → Networks → **Add a network manually**:
   - Network name: `Anvil (local)`
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `31337`
   - Currency symbol: `ETH`
2. Import akun #0: Account menu → **Import account** → private key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` (atau akun #1 `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` supaya pembeli ≠ owner).
3. Kalau anvil di-restart dan transaksi "stuck"/nonce salah: Settings → Advanced → **Clear activity tab data**.
4. Jalankan situs (`python3 -m http.server 8000` dari root repo) dan buka `http://localhost:8000/mint.html`. Halaman ini juga bisa memanggil `wallet_addEthereumChain` sendiri kalau jaringan 31337 belum ada di MetaMask.

> **Jangan pernah** memakai key anvil di atas di jaringan sungguhan — key itu publik dan semua orang tahu.
