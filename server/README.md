# Reel Fortune 3D — Server Otoritatif

Panduan pemasangan di VPS Ubuntu (22.04 / 24.04 LTS).

Server ini membuat state pemain **tidak bisa dicurangi lewat console browser**. Semua yang menentukan ekonomi dan hasil acak — roll ikan, drop ore, drop saham, hasil roulette, harga jual, craft, jual/beli saham, kiosk, travel — dihitung di server. Client hanya mengirim *intent* ("aku selesai reeling") lalu merender state yang dikembalikan server.

---

## Daftar Isi

1. [Arsitektur singkat](#1-arsitektur-singkat)
2. [Prasyarat](#2-prasyarat)
3. [Menyiapkan server](#3-menyiapkan-server)
4. [Upload kode](#4-upload-kode)
5. [Install dependency](#5-install-dependency)
6. [Konfigurasi `.env`](#6-konfigurasi-env)
7. [Uji coba manual](#7-uji-coba-manual)
8. [Menjalankan lewat systemd](#8-menjalankan-lewat-systemd)
9. [Nginx reverse proxy](#9-nginx-reverse-proxy)
10. [HTTPS dengan certbot](#10-https-dengan-certbot)
11. [Firewall](#11-firewall)
12. [Backup database](#12-backup-database)
13. [Cara update](#13-cara-update)
14. [Troubleshooting](#14-troubleshooting)
15. [Catatan keamanan](#15-catatan-keamanan)

---

## 1. Arsitektur singkat

```
Browser (index.html + game.js + lib/three.min.js)
   │  gerakan & render = client (tidak perlu otoritatif)
   │  intent  ──POST /api/action/{catch,mine,sell,spin,...}──►
   ▼
Nginx :80/:443  ──proxy──►  Node :8787 (127.0.0.1 saja)
                                 │
                                 ▼
                          SQLite (better-sqlite3)
                          data/reelfortune.db
```

| Bagian | Lokasi di VPS |
|---|---|
| Repo lengkap (client + server) | `/opt/reelfortune` |
| Backend Node | `/opt/reelfortune/server` |
| Database SQLite | `/opt/reelfortune/server/data/reelfortune.db` |
| Konfigurasi rahasia | `/opt/reelfortune/server/.env` |
| Backup | `/var/backups/reelfortune` |

Node **hanya** mendengarkan di `127.0.0.1:8787`. Yang menghadap internet adalah nginx.

---

## 2. Prasyarat

- VPS Ubuntu 22.04 atau 24.04, akses root / sudo
- Domain yang sudah diarahkan (A record) ke IP VPS — dibutuhkan untuk HTTPS
- RAM 512 MB sudah cukup; 1 GB nyaman

### 2.1 Update sistem

```bash
sudo apt update && sudo apt upgrade -y
```

### 2.2 Node.js 20 LTS via NodeSource

Node bawaan Ubuntu sering terlalu tua. Pasang dari NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verifikasi — harus Node 18 atau lebih baru:

```bash
node -v    # contoh: v20.19.0
npm -v     # contoh: 10.8.2
```

### 2.3 Toolchain untuk `better-sqlite3`

`better-sqlite3` adalah modul native. Kalau npm tidak menemukan prebuilt binary yang cocok, ia akan mengompilasi dari sumber — dan itu butuh compiler C++ serta Python:

```bash
sudo apt install -y build-essential python3 sqlite3 git
```

- `build-essential` → gcc/g++/make untuk kompilasi native
- `python3` → dibutuhkan `node-gyp`
- `sqlite3` → CLI, dipakai script backup (`.backup`) dan inspeksi manual
- `git` → untuk clone & update

---

## 3. Menyiapkan server

### 3.1 Buat user sistem non-root

Service tidak boleh jalan sebagai root. Buat user khusus tanpa shell login dan tanpa home directory:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin reelfortune
```

Cek berhasil:

```bash
id reelfortune    # uid=999(reelfortune) gid=999(reelfortune) groups=999(reelfortune)
```

### 3.2 Buat folder aplikasi

```bash
sudo mkdir -p /opt/reelfortune
sudo chown "$USER":"$USER" /opt/reelfortune
```

Sementara ini dimiliki user Anda supaya `git pull` dan `npm install` bisa dijalankan tanpa sudo. Permission final dipasang di [langkah 5.2](#52-pasang-permission).

---

## 4. Upload kode

### Opsi A — clone dari git (disarankan, memudahkan update)

```bash
git clone https://github.com/itsnevu/voxel.git /opt/reelfortune
cd /opt/reelfortune
```

### Opsi B — upload dari mesin lokal

Jalankan dari **komputer lokal**, bukan dari VPS:

```bash
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'server/data' \
  --exclude 'server/.env' \
  ~/Documents/ReelFortune3D/ \
  user@IP_VPS:/opt/reelfortune/
```

> `--exclude 'server/.env'` dan `--exclude 'server/data'` itu penting: jangan sampai konfigurasi rahasia atau database produksi tertimpa oleh file dari mesin lokal.

Setelah selesai, struktur di VPS harus seperti ini:

```
/opt/reelfortune/
├── index.html
├── game.js
├── lib/three.min.js
└── server/
    ├── package.json
    ├── src/
    └── deploy/
        ├── reelfortune.service
        ├── nginx.conf
        └── backup.sh
```

---

## 5. Install dependency

### 5.1 Install paket produksi

```bash
cd /opt/reelfortune/server
npm install --omit=dev
```

`--omit=dev` melewati devDependencies — di produksi tidak perlu dan hanya menambah permukaan serangan.

Kompilasi `better-sqlite3` bisa memakan 1–3 menit di VPS kecil. Selama tidak ada baris `ERR!`, biarkan saja.

Verifikasi modul native benar-benar terpasang:

```bash
node -e "import('better-sqlite3').then(m=>{const d=new m.default(':memory:');d.exec('create table t(x)');console.log('better-sqlite3 OK')})"
```

### 5.2 Pasang permission

Buat folder data, lalu serahkan kepemilikan ke user service:

```bash
sudo mkdir -p /opt/reelfortune/server/data

# Kode dimiliki root, hanya bisa dibaca service → service tidak bisa menimpa kodenya sendiri
sudo chown -R root:root /opt/reelfortune
sudo chmod -R 755 /opt/reelfortune

# Folder data HARUS bisa ditulis oleh service (file .db, -wal, -shm)
sudo chown -R reelfortune:reelfortune /opt/reelfortune/server/data
sudo chmod 750 /opt/reelfortune/server/data
```

> Sengaja kode dimiliki `root` dan folder data dimiliki `reelfortune`. Kalau service dibobol, penyerang tetap tidak bisa mengubah `src/game/rules.js` untuk mengarang ekonomi sendiri.

---

## 6. Konfigurasi `.env`

```bash
cd /opt/reelfortune/server
cp .env.example .env
```

### 6.1 Generate `LEDGER_SECRET`

Ini kunci penandatanganan deed Isle Ledger. **Wajib diganti** — jangan pakai nilai contoh dari repo:

```bash
openssl rand -hex 32
```

Salin keluarannya (64 karakter hex) ke `.env`.

### 6.2 Isi `.env`

```bash
sudo nano /opt/reelfortune/server/.env
```

Acuan isi (samakan dengan nama variabel yang ada di `.env.example` milik repo — daftar ini panduan, bukan pengganti):

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DB_PATH=/opt/reelfortune/server/data/reelfortune.db
LEDGER_SECRET=ganti_dengan_hasil_openssl_rand_hex_32
CORS_ORIGIN=https://game.example.com
```

**Aturan format `EnvironmentFile` systemd** — beda dari file `.env` biasa:

- Satu baris `KUNCI=nilai`, tanpa `export`
- **Tanpa spasi** di sekitar `=`
- Tanpa command substitution — `PORT=$(...)` tidak akan jalan
- Komentar hanya dengan `#` di awal baris
- Nilai tidak perlu diberi tanda kutip kecuali memang mengandung spasi

### 6.3 Kunci permission file rahasia

`.env` berisi `LEDGER_SECRET`. Jangan biarkan bisa dibaca semua user:

```bash
sudo chown root:reelfortune /opt/reelfortune/server/.env
sudo chmod 640 /opt/reelfortune/server/.env
```

Cek hasilnya: `-rw-r----- 1 root reelfortune`.

---

## 7. Uji coba manual

Sebelum dijadikan service, pastikan jalan dulu di foreground:

```bash
cd /opt/reelfortune/server
sudo -u reelfortune bash -c 'set -a; . ./.env; set +a; exec node src/index.js'
```

(`set -a` mengekspor setiap variabel yang di-source, meniru apa yang dilakukan `EnvironmentFile` systemd. User `reelfortune` memakai shell `nologin`, tapi `bash -c` memanggil bash secara eksplisit sehingga tetap jalan.)

Harusnya muncul log bahwa server mendengarkan di `127.0.0.1:8787`. Dari terminal kedua:

```bash
curl -i http://127.0.0.1:8787/api/auth/me
```

Respons `401` itu **benar** — artinya server hidup dan `requireAuth` bekerja (belum ada sesi).

Tekan `Ctrl+C` untuk berhenti, lalu lanjut ke systemd.

---

## 8. Menjalankan lewat systemd

### 8.1 Pasang unit file

```bash
sudo cp /opt/reelfortune/server/deploy/reelfortune.service \
        /etc/systemd/system/reelfortune.service
sudo systemctl daemon-reload
```

### 8.2 Enable + start

```bash
sudo systemctl enable --now reelfortune
sudo systemctl status reelfortune
```

Yang dicari: `Active: active (running)`.

### 8.3 Cek log

```bash
# ikuti log real-time
sudo journalctl -u reelfortune -f

# 100 baris terakhir
sudo journalctl -u reelfortune -n 100 --no-pager

# hanya hari ini, level error
sudo journalctl -u reelfortune --since today -p err
```

### 8.4 Perintah harian

```bash
sudo systemctl restart reelfortune
sudo systemctl stop reelfortune
sudo systemctl status reelfortune
```

### 8.5 Catatan tentang hardening

Unit file memakai `ProtectSystem=strict`, yang membuat **seluruh filesystem read-only** untuk service ini. Satu-satunya pengecualian:

```ini
ReadWritePaths=/opt/reelfortune/server/data
```

Kalau Anda memindahkan `DB_PATH` ke lokasi lain, **ubah baris ini juga**, atau service akan mati dengan `SQLITE_CANTOPEN`.

Juga: jangan set `MemoryDenyWriteExecute=yes`. JIT V8 milik Node butuh halaman memori write+execute dan service tidak akan mau start.

---

## 9. Nginx reverse proxy

### 9.1 Install

```bash
sudo apt install -y nginx
```

### 9.2 Pasang konfigurasi

```bash
sudo cp /opt/reelfortune/server/deploy/nginx.conf \
        /etc/nginx/sites-available/reelfortune

# GANTI game.example.com dengan domain Anda
sudo nano /etc/nginx/sites-available/reelfortune

sudo ln -s /etc/nginx/sites-available/reelfortune /etc/nginx/sites-enabled/

# matikan default site supaya tidak bentrok
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` harus bilang `syntax is ok` + `test is successful` sebelum reload.

### 9.3 Uji

```bash
curl -I http://game.example.com/
curl -i http://game.example.com/api/auth/me    # harus 401
```

---

## 10. HTTPS dengan certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d game.example.com
```

Saat ditanya redirect, pilih opsi **Redirect** (HTTP → HTTPS). Certbot akan menyisipkan sendiri blok `listen 443 ssl` beserta sertifikatnya ke file konfigurasi tadi.

Perpanjangan otomatis sudah terpasang sebagai systemd timer. Verifikasi:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

Setelah HTTPS aktif, tambahkan HSTS di blok `443` (jangan di blok 80):

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

Jangan lupa update `CORS_ORIGIN` di `.env` ke `https://` lalu `sudo systemctl restart reelfortune`.

---

## 11. Firewall

Hanya SSH, HTTP, dan HTTPS yang boleh masuk. Port 8787 **tidak pernah** dibuka:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

> Port 80 harus tetap terbuka meskipun sudah pakai HTTPS — certbot memakainya untuk validasi HTTP-01 setiap kali memperpanjang sertifikat.

Pastikan Node memang tidak terekspos:

```bash
sudo ss -tlnp | grep 8787
# harus: 127.0.0.1:8787  — BUKAN 0.0.0.0:8787
```

Kalau muncul `0.0.0.0:8787`, perbaiki `HOST=127.0.0.1` di `.env` dan restart.

---

## 12. Backup database

Database adalah satu-satunya hal yang tidak bisa dibuat ulang. Kode bisa di-clone lagi; progres pemain tidak.

### 12.1 Kenapa tidak boleh `cp` saja

Server jalan dalam mode WAL. Menyalin file `.db` mentah saat ada transaksi berjalan bisa menghasilkan backup korup. Gunakan `sqlite3 .backup`, yang mengambil snapshot konsisten **tanpa menghentikan service**.

### 12.2 Backup manual sekali jalan

```bash
sudo sqlite3 /opt/reelfortune/server/data/reelfortune.db \
  ".backup '/var/backups/reelfortune/manual-$(date +%F).db'"
```

### 12.3 Script backup + rotasi 7 hari

```bash
sudo mkdir -p /var/backups/reelfortune
sudo chmod 700 /var/backups/reelfortune
sudo chmod +x /opt/reelfortune/server/deploy/backup.sh

# uji jalankan sekali
sudo /opt/reelfortune/server/deploy/backup.sh
```

Script akan: mengambil snapshot `.backup`, menjalankan `PRAGMA integrity_check` (backup yang tidak lolos ditolak), kompres gzip, lalu menghapus backup yang lebih tua dari 7 hari.

### 12.4 Jadwalkan harian

```bash
sudo crontab -e
```

Tambahkan:

```cron
15 3 * * * /opt/reelfortune/server/deploy/backup.sh >> /var/log/reelfortune-backup.log 2>&1
```

Backup jam 03:15 setiap hari. Cek beberapa hari kemudian:

```bash
ls -lh /var/backups/reelfortune/
tail -20 /var/log/reelfortune-backup.log
```

### 12.5 Restore

```bash
sudo systemctl stop reelfortune

sudo gunzip -c /var/backups/reelfortune/reelfortune-20260828-031500.db.gz \
  | sudo tee /opt/reelfortune/server/data/reelfortune.db > /dev/null

# WAL/SHM lama harus dibuang, isinya milik database yang sudah diganti
sudo rm -f /opt/reelfortune/server/data/reelfortune.db-wal \
           /opt/reelfortune/server/data/reelfortune.db-shm

sudo chown reelfortune:reelfortune /opt/reelfortune/server/data/reelfortune.db
sudo systemctl start reelfortune
```

> **Salin backup ke luar VPS.** Backup yang hanya ada di mesin yang sama tidak menolong saat disk VPS-nya yang mati. Contoh dari mesin lokal:
> ```bash
> rsync -avz user@IP_VPS:/var/backups/reelfortune/ ~/backup-reelfortune/
> ```

---

## 13. Cara update

```bash
# 1. Backup dulu — selalu, sebelum apa pun
sudo /opt/reelfortune/server/deploy/backup.sh

# 2. Tarik kode baru
cd /opt/reelfortune
sudo git pull

# 3. Install ulang dependency
cd /opt/reelfortune/server
sudo npm ci --omit=dev

# 4. Restart
sudo systemctl restart reelfortune

# 5. Pastikan hidup
sudo systemctl status reelfortune
sudo journalctl -u reelfortune -n 50 --no-pager
```

Catatan:

- `npm ci` (bukan `npm install`) memasang persis versi di `package-lock.json` — deterministik, dan itu yang Anda mau di produksi.
- `git pull` **tidak** menyentuh `.env` dan `data/` karena keduanya di-`.gitignore`.
- Kalau `package.json` tidak berubah, langkah 3 boleh dilewati.
- Kalau update mengubah `game.js`, pemain perlu hard-refresh (`Ctrl+Shift+R`). Konfigurasi nginx sudah mengirim `Cache-Control: no-cache` untuk `game.js` supaya ini jarang jadi masalah.

Rollback kalau update bermasalah:

```bash
cd /opt/reelfortune
sudo git log --oneline -5
sudo git checkout <commit-lama>
cd server && sudo npm ci --omit=dev
sudo systemctl restart reelfortune
```

---

## 14. Troubleshooting

### Port 8787 sudah dipakai

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:8787
```

Cari pemakainya:

```bash
sudo ss -tlnp | grep 8787
sudo lsof -i :8787
```

Biasanya ini proses lama dari uji coba manual di langkah 7 yang belum mati:

```bash
sudo systemctl stop reelfortune
sudo pkill -f 'node src/index.js'
sudo systemctl start reelfortune
```

Kalau portnya memang dipakai aplikasi lain, ganti `PORT` di `.env` **dan** `proxy_pass` di nginx (ada di 3 tempat), lalu reload keduanya.

### `better-sqlite3` gagal build

```
npm ERR! gyp ERR! build error
node-pre-gyp ERR! Pre-built binaries not installable
```

Penyebab paling sering: toolchain belum lengkap.

```bash
sudo apt install -y build-essential python3
cd /opt/reelfortune/server
sudo rm -rf node_modules package-lock.json
sudo npm install --omit=dev --build-from-source
```

Kalau kehabisan RAM saat kompilasi (VPS 512 MB sering kena, prosesnya mati tanpa pesan jelas / "Killed"), buat swap sementara:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
# ulangi npm install, lalu boleh dimatikan lagi:
# sudo swapoff /swapfile && sudo rm /swapfile
```

Cek juga versi Node cocok: `node -v` harus ≥ 18.

### Error `ERR_DLOPEN_FAILED` / `invalid ELF header` setelah update

Modul native dikompilasi untuk versi Node tertentu. Kalau Node di-upgrade (atau `node_modules` disalin dari mesin lain, mis. dari macOS), modul harus dibangun ulang:

```bash
cd /opt/reelfortune/server
sudo rm -rf node_modules
sudo npm ci --omit=dev
sudo systemctl restart reelfortune
```

Jangan pernah ikut mengirim `node_modules` lewat rsync dari laptop.

### Nginx 502 Bad Gateway

Artinya nginx hidup tapi Node tidak menjawab.

```bash
sudo systemctl status reelfortune
sudo journalctl -u reelfortune -n 50 --no-pager
curl -i http://127.0.0.1:8787/api/auth/me
sudo tail -30 /var/log/nginx/reelfortune.error.log
```

Urutan pemeriksaan:

1. Service mati atau crash-loop → baca journalctl, biasanya `.env` salah format atau `DB_PATH` tidak bisa ditulis.
2. `curl` ke `127.0.0.1:8787` juga gagal → masalah di Node, bukan di nginx.
3. `curl` berhasil tapi lewat domain tetap 502 → `proxy_pass` salah port, atau nginx belum di-reload.

### `SQLITE_CANTOPEN: unable to open database file`

Hampir selalu soal permission atau `ReadWritePaths`:

```bash
ls -la /opt/reelfortune/server/data
sudo chown -R reelfortune:reelfortune /opt/reelfortune/server/data
sudo chmod 750 /opt/reelfortune/server/data
```

Kalau `DB_PATH` diarahkan ke luar `/opt/reelfortune/server/data`, tambahkan path itu ke `ReadWritePaths=` di unit file, lalu:

```bash
sudo systemctl daemon-reload && sudo systemctl restart reelfortune
```

Ingat `ProtectSystem=strict` membuat semua path lain read-only, seberapa pun benar permission Unix-nya.

### Service tidak mau start, journalctl bilang `Failed to load environment files`

Format `.env` tidak sesuai aturan systemd. Yang paling sering:

```ini
export PORT=8787     # SALAH — ada 'export'
PORT = 8787          # SALAH — ada spasi di sekitar '='
PORT=8787            # BENAR
```

Cek juga file benar-benar ada dan bisa dibaca grup `reelfortune` (langkah 6.3).

### CORS: "blocked by CORS policy"

Muncul di console browser saat halaman dan API beda origin.

1. Pastikan `CORS_ORIGIN` di `.env` **persis sama** dengan origin halaman — termasuk skema dan tanpa trailing slash:
   - `https://game.example.com` ✅
   - `http://game.example.com` ❌ (skema beda setelah pasang HTTPS)
   - `https://game.example.com/` ❌ (ada slash di ujung)
2. Restart setelah mengubah: `sudo systemctl restart reelfortune`
3. Kalau halaman dan API disajikan dari domain yang sama (setup default panduan ini), seharusnya **tidak ada** CORS sama sekali. CORS yang muncul di setup ini biasanya tanda halaman masih dibuka lewat `file://` atau `localhost` sementara API di domain produksi.
4. Login butuh cookie sesi lintas origin? Maka `credentials: 'include'` di client, dan di server `cors({ origin: CORS_ORIGIN, credentials: true })`. Wildcard `*` **tidak boleh** dipakai bersama credentials — spesifikasi CORS melarangnya.

### Perubahan game tidak muncul di browser

Hard refresh: `Ctrl+Shift+R` (Windows/Linux) atau `Cmd+Shift+R` (macOS). Kalau tetap membandel, buka DevTools → Network → centang "Disable cache". File di `/lib/` memang sengaja di-cache 1 tahun; kalau Three.js diganti, ganti juga nama filenya.

### Sertifikat certbot gagal diperbarui

```bash
sudo certbot renew --dry-run
sudo journalctl -u certbot -n 50 --no-pager
```

Penyebab umum: port 80 ditutup di ufw, atau A record domain sudah tidak menunjuk ke VPS ini.

---

## 15. Catatan keamanan

Daftar periksa sebelum server dibuka untuk publik:

- [ ] **Port 8787 tidak diekspos.** `sudo ss -tlnp | grep 8787` harus menunjukkan `127.0.0.1:8787`, bukan `0.0.0.0`. Hanya nginx yang boleh menghadap internet.
- [ ] **ufw aktif, hanya 80/443/SSH.** Jangan pernah `ufw allow 8787`.
- [ ] **`LEDGER_SECRET` sudah diganti** dengan hasil `openssl rand -hex 32`. Nilai contoh di repo bersifat publik — siapa pun bisa memalsukan deed kalau dipakai apa adanya.
- [ ] **`.env` mode 640, `root:reelfortune`.** Jangan pernah di-commit ke git. Pastikan ada di `.gitignore`.
- [ ] **Service jalan sebagai `reelfortune`, bukan root.** Cek: `systemctl show reelfortune -p User`.
- [ ] **Kode dimiliki root, hanya folder `data/` yang writable.** Service yang dibobol tetap tidak bisa mengubah aturan ekonominya sendiri.
- [ ] **Backup harian aktif dan pernah diuji restore.** Backup yang belum pernah di-restore statusnya "belum diketahui", bukan "aman". Salin juga ke luar VPS.
- [ ] **HTTPS aktif + redirect dari HTTP.** Token sesi lewat HTTP polos bisa disadap.
- [ ] **Rate limiting nginx dinyalakan** untuk `/api/auth/` (lihat komentar di `deploy/nginx.conf`) agar login tidak bisa di-brute force.
- [ ] **Update keamanan sistem rutin:**
  ```bash
  sudo apt install -y unattended-upgrades
  sudo dpkg-reconfigure --priority=low unattended-upgrades
  ```
- [ ] **Rotasi `LEDGER_SECRET` kalau pernah bocor** (mis. tidak sengaja ter-commit). Catat: mengganti secret akan meng-invalidasi tanda tangan deed yang sudah ada.

### Prinsip yang mendasari desain ini

Client **tidak pernah** dipercaya. Client mengirim intent, bukan hasil. Kalau ada endpoint baru yang menerima angka dari client — jumlah koin, berat ikan, harga — itu bug, bukan fitur. Server menghitung sendiri semuanya dari `src/game/rules.js` dan `src/game/economy.js`.

Rate limit per-aksi (`RATE` di `src/game/actions.js`) juga bagian dari keamanan, bukan sekadar anti-spam: itu yang mencegah skrip otomatis memanggil `/api/action/catch` seribu kali per detik.

---

## Referensi cepat

```bash
# status & log
sudo systemctl status reelfortune
sudo journalctl -u reelfortune -f

# restart setelah ubah .env
sudo systemctl restart reelfortune

# reload setelah ubah nginx
sudo nginx -t && sudo systemctl reload nginx

# backup manual
sudo /opt/reelfortune/server/deploy/backup.sh

# inspeksi database
sudo -u reelfortune sqlite3 /opt/reelfortune/server/data/reelfortune.db \
  "SELECT id, username FROM users LIMIT 10;"
```

| File | Isi |
|---|---|
| `deploy/reelfortune.service` | systemd unit + hardening |
| `deploy/nginx.conf` | reverse proxy, gzip, cache `/lib/` |
| `deploy/backup.sh` | backup SQLite harian + rotasi 7 hari |
