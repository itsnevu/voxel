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
