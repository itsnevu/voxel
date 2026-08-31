#!/usr/bin/env bash
#
# backup.sh - backup harian database SQLite Reel Fortune 3D, rotasi 7 hari.
#
# Memakai perintah `.backup` milik sqlite3, BUKAN `cp`. Ini penting: server
# jalan dengan mode WAL, jadi menyalin file .db mentah saat ada transaksi
# berjalan bisa menghasilkan backup yang korup. `.backup` mengambil snapshot
# konsisten secara online tanpa perlu menghentikan service.
#
# Aturan main script ini: nama final hanya boleh ditempati file yang sudah
# diverifikasi. Semua tulis-menulis terjadi di nama sementara, dan rename baru
# dilakukan setelah artefak yang benar-benar disimpan (yang .gz, bukan snapshot
# yang dibuang) lolos pemeriksaan. Backup rusak yang terlihat paling baru lebih
# berbahaya daripada tidak ada backup: proses restore akan meraih itu duluan.
#
# Pemakaian:
#   ./backup.sh                     # pakai path bawaan
#   DB_PATH=/x/y.db ./backup.sh     # override lewat environment
#   ./backup.sh /x/y.db /var/backup # override lewat argumen
#
# Contoh cron harian jam 03:15 (sebagai root):
#   15 3 * * * /opt/reelfortune/server/deploy/backup.sh >> /var/log/reelfortune-backup.log 2>&1

set -euo pipefail
umask 077

# --- Konfigurasi ------------------------------------------------------------
DB_PATH="${1:-${DB_PATH:-/opt/reelfortune/server/data/reelfortune.db}}"
BACKUP_DIR="${2:-${BACKUP_DIR:-/var/backups/reelfortune}}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
# Batas bawah rotasi. Umur saja tidak cukup: kalau cron mati sebulan lalu hidup
# lagi, aturan umur murni akan membuang semua backup lama sekaligus.
MIN_KEEP="${MIN_KEEP:-3}"
OWNER="${BACKUP_OWNER:-root:root}"

STAMP="$(date +%Y%m%d-%H%M%S)"
BASENAME="reelfortune-${STAMP}.db"
TMP_FILE="${BACKUP_DIR}/.${BASENAME}.partial"
OUT_FILE="${BACKUP_DIR}/${BASENAME}.gz"
GZ_TMP="${OUT_FILE}.partial"
LOCK_FILE="${BACKUP_LOCK:-/var/lock/reelfortune-backup.lock}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Bersihkan file sementara kalau script mati di tengah jalan. Termasuk .gz
# setengah jadi: gzip yang mati karena disk penuh justru terjadi di saat file
# sampah paling tidak boleh ditinggal, di filesystem yang sama dengan database.
cleanup() { rm -f "$TMP_FILE" "$GZ_TMP"; }
trap cleanup EXIT

# --- Cegah dua backup jalan bersamaan --------------------------------------
# Lock dipegang lewat file descriptor, bukan `exec flock`, supaya run yang
# dilewati punya suara sendiri di log. Diam-diam exit 1 tidak bisa dibedakan
# dari cron yang memang tidak pernah terpasang.
LOCK_DIR="$(dirname "$LOCK_FILE")"
if command -v flock >/dev/null 2>&1 && { [ -w "$LOCK_FILE" ] || [ -w "$LOCK_DIR" ]; }; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "Backup lain masih jalan (lock: ${LOCK_FILE}) · run ini dilewati"
    exit 0
  fi
else
  log "PERINGATAN: lock tidak dipasang (flock/${LOCK_FILE} tidak tersedia)"
fi

# --- Pemeriksaan awal -------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 \
  || die "sqlite3 tidak terpasang. Jalankan: apt install -y sqlite3"
command -v gzip >/dev/null 2>&1 \
  || die "gzip tidak terpasang. Jalankan: apt install -y gzip"

[ -f "$DB_PATH" ] || die "database tidak ditemukan: $DB_PATH"
[ -r "$DB_PATH" ] || die "database tidak bisa dibaca: $DB_PATH (jalankan sebagai root?)"

mkdir -p "$BACKUP_DIR" || die "tidak bisa membuat direktori backup: $BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
[ -w "$BACKUP_DIR" ] || die "direktori backup tidak bisa ditulis: $BACKUP_DIR"

# Sapu sisa .partial dari run yang gagal SEBELUM menulis apa pun. Kalau sapuan
# ini cuma jalan di akhir run yang sukses, disk yang tetap penuh tidak akan
# pernah membersihkan dirinya sendiri. Batas 3 jam jauh lebih lama dari durasi
# backup normal, jadi run tetangga yang sah tidak ikut kena.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mmin +180 -exec rm -f {} + 2>/dev/null || true

# Peringatan dini kalau ruang kosong tidak cukup untuk snapshot + hasil gzip.
DB_KB="$(du -k "$DB_PATH" 2>/dev/null | cut -f1)"
FREE_KB="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
case "${DB_KB:-x}${FREE_KB:-x}" in
  *x*) : ;;
  *) [ "$FREE_KB" -gt $((DB_KB * 2)) ] \
       || log "PERINGATAN: sisa disk ${FREE_KB}K untuk database ${DB_KB}K · backup mungkin gagal" ;;
esac

log "Mulai backup: $DB_PATH -> $OUT_FILE"

# --- Ambil snapshot ---------------------------------------------------------
# .backup aman dijalankan sementara server tetap melayani request.
sqlite3 "$DB_PATH" ".backup '$TMP_FILE'" \
  || die "sqlite3 .backup gagal (database terkunci atau korup?)"

INTEGRITY="$(sqlite3 "$TMP_FILE" 'PRAGMA integrity_check;' 2>/dev/null || echo 'failed')"
[ "$INTEGRITY" = "ok" ] || die "integrity_check gagal pada snapshot: $INTEGRITY"

# --- Kompres, verifikasi yang DISIMPAN, baru pasang di tempat final ---------
gzip -9 -c "$TMP_FILE" > "$GZ_TMP" || die "gzip gagal (disk penuh?) · sisa parsial dibuang"

# Snapshot tadi memang lolos integrity_check, tapi snapshot itu dibuang. Yang
# disimpan adalah hasil gzip-nya, jadi itu yang harus dibuktikan: CRC utuh, dan
# hasil dekompresnya byte-per-byte sama dengan snapshot yang sudah lolos. Round
# trip lewat pipe, tanpa file sementara tambahan, supaya tetap aman saat disk
# sudah sempit.
gzip -t "$GZ_TMP" 2>/dev/null || die "artefak gzip rusak (CRC gagal) · dibuang"
gunzip -c "$GZ_TMP" | cmp -s - "$TMP_FILE" \
  || die "hasil dekompres tidak sama dengan snapshot · artefak dibuang"

chown "$OWNER" "$GZ_TMP" 2>/dev/null || true
chmod 600 "$GZ_TMP"
mv -f "$GZ_TMP" "$OUT_FILE" || die "gagal memasang backup di $OUT_FILE"
rm -f "$TMP_FILE"

SIZE_BYTES="$(wc -c < "$OUT_FILE" | tr -d ' ')"
[ "${SIZE_BYTES:-0}" -gt 0 ] || die "backup final berukuran nol: $OUT_FILE"
log "Backup selesai & terverifikasi: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# --- Rotasi -----------------------------------------------------------------
# Sampai di sini $OUT_FILE dijamin backup sehat, jadi rotasi tidak akan pernah
# menyisakan direktori tanpa satu pun backup yang bisa dipakai. Dua rem lain:
# file hari ini tidak pernah jadi kandidat, dan jumlah tersisa tidak boleh
# turun di bawah MIN_KEEP walau semuanya sudah lewat umur.
ALL_COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'reelfortune-*.db.gz' | wc -l | tr -d ' ')"

OLD=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" != "$OUT_FILE" ] || continue
  OLD+=("$f")
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'reelfortune-*.db.gz' \
           -mtime "+${RETENTION_DAYS}" -print | sort)

DELETED=0
if [ ${#OLD[@]} -gt 0 ]; then
  # Terurut menaik lewat sort: stamp ada di nama file, jadi yang tertua dulu.
  for old in "${OLD[@]}"; do
    [ $((ALL_COUNT - DELETED)) -gt "$MIN_KEEP" ] || {
      log "Rotasi berhenti di batas MIN_KEEP=${MIN_KEEP} · sisa backup dipertahankan"
      break
    }
    rm -f "$old" || continue
    log "Dihapus (lebih dari ${RETENTION_DAYS} hari): $(basename "$old")"
    DELETED=$((DELETED + 1))
  done
fi

REMAINING=$((ALL_COUNT - DELETED))
log "Rotasi selesai: ${DELETED} dihapus, ${REMAINING} backup tersimpan di ${BACKUP_DIR}"
# Baris terakhir sengaja machine-readable: monitor bisa memastikan ada backup
# segar berukuran bukan nol, bukan cuma percaya cron masih hidup.
log "{\"msg\":\"backup\",\"ok\":true,\"file\":\"${OUT_FILE}\",\"bytes\":${SIZE_BYTES},\"kept\":${REMAINING}}"

# --- Cara restore (untuk dibaca saat panik) ---------------------------------
# 0. Pilih file .gz TERBARU dan pastikan sehat sebelum menimpa apa pun:
#      gzip -t /var/backups/reelfortune/reelfortune-YYYYMMDD-HHMMSS.db.gz
#    File berakhiran .partial BUKAN backup; itu sisa run gagal, abaikan saja.
# 1. systemctl stop reelfortune
# 2. gunzip -c /var/backups/reelfortune/reelfortune-YYYYMMDD-HHMMSS.db.gz \
#      > /opt/reelfortune/server/data/reelfortune.db
# 3. rm -f /opt/reelfortune/server/data/reelfortune.db-wal \
#          /opt/reelfortune/server/data/reelfortune.db-shm
# 4. sqlite3 /opt/reelfortune/server/data/reelfortune.db 'PRAGMA integrity_check;'
# 5. chown reelfortune:reelfortune /opt/reelfortune/server/data/reelfortune.db
# 6. systemctl start reelfortune
