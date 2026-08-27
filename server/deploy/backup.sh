#!/usr/bin/env bash
#
# backup.sh - backup harian database SQLite Reel Fortune 3D, rotasi 7 hari.
#
# Memakai perintah `.backup` milik sqlite3, BUKAN `cp`. Ini penting: server
# jalan dengan mode WAL, jadi menyalin file .db mentah saat ada transaksi
# berjalan bisa menghasilkan backup yang korup. `.backup` mengambil snapshot
# konsisten secara online tanpa perlu menghentikan service.
#
# Pemakaian:
#   ./backup.sh                     # pakai path bawaan
#   DB_PATH=/x/y.db ./backup.sh     # override lewat environment
#   ./backup.sh /x/y.db /var/backup # override lewat argumen
#
# Contoh cron harian jam 03:15 (sebagai root):
#   15 3 * * * /opt/reelfortune/server/deploy/backup.sh >> /var/log/reelfortune-backup.log 2>&1

set -euo pipefail

# --- Konfigurasi ------------------------------------------------------------
DB_PATH="${1:-${DB_PATH:-/opt/reelfortune/server/data/reelfortune.db}}"
BACKUP_DIR="${2:-${BACKUP_DIR:-/var/backups/reelfortune}}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
OWNER="${BACKUP_OWNER:-root:root}"

STAMP="$(date +%Y%m%d-%H%M%S)"
BASENAME="reelfortune-${STAMP}.db"
TMP_FILE="${BACKUP_DIR}/.${BASENAME}.partial"
OUT_FILE="${BACKUP_DIR}/${BASENAME}.gz"
LOCK_FILE="/var/lock/reelfortune-backup.lock"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Bersihkan file sementara kalau script mati di tengah jalan.
cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT

# --- Cegah dua backup jalan bersamaan --------------------------------------
# Kalau flock tersedia, jalankan ulang diri sendiri di bawah lock eksklusif.
if [ -z "${_RF_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  export _RF_LOCKED=1
  exec flock -n "$LOCK_FILE" "$0" "$@"
fi

# --- Pemeriksaan awal -------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 \
  || die "sqlite3 tidak terpasang. Jalankan: apt install -y sqlite3"
command -v gzip >/dev/null 2>&1 \
  || die "gzip tidak terpasang. Jalankan: apt install -y gzip"

[ -f "$DB_PATH" ] || die "database tidak ditemukan: $DB_PATH"
[ -r "$DB_PATH" ] || die "database tidak bisa dibaca: $DB_PATH (jalankan sebagai root?)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log "Mulai backup: $DB_PATH -> $OUT_FILE"

# --- Ambil snapshot ---------------------------------------------------------
# .backup aman dijalankan sementara server tetap melayani request.
sqlite3 "$DB_PATH" ".backup '$TMP_FILE'" \
  || die "sqlite3 .backup gagal (database terkunci atau korup?)"

# Verifikasi snapshot sebelum dianggap sah. Backup yang tidak bisa dibuka
# lebih berbahaya daripada tidak ada backup sama sekali.
INTEGRITY="$(sqlite3 "$TMP_FILE" 'PRAGMA integrity_check;' 2>/dev/null || echo 'failed')"
[ "$INTEGRITY" = "ok" ] || die "integrity_check gagal pada snapshot: $INTEGRITY"

# --- Kompres & pasang di tempat final ---------------------------------------
gzip -9 -c "$TMP_FILE" > "${OUT_FILE}.partial" || die "gzip gagal"
mv -f "${OUT_FILE}.partial" "$OUT_FILE"
rm -f "$TMP_FILE"

chown "$OWNER" "$OUT_FILE" 2>/dev/null || true
chmod 600 "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
log "Backup selesai: $OUT_FILE ($SIZE)"

# --- Rotasi -----------------------------------------------------------------
# Hapus backup yang lebih tua dari RETENTION_DAYS hari.
DELETED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  log "Dihapus (lebih dari ${RETENTION_DAYS} hari): $(basename "$old")"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'reelfortune-*.db.gz' \
           -mtime "+${RETENTION_DAYS}" -print0)

# Sapu juga sisa file .partial yang tertinggal dari run yang gagal.
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mtime +1 -delete 2>/dev/null || true

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'reelfortune-*.db.gz' | wc -l | tr -d ' ')"
log "Rotasi selesai: ${DELETED} dihapus, ${REMAINING} backup tersimpan di ${BACKUP_DIR}"

# --- Cara restore (untuk dibaca saat panik) ---------------------------------
# 1. systemctl stop reelfortune
# 2. gunzip -c /var/backups/reelfortune/reelfortune-YYYYMMDD-HHMMSS.db.gz \
#      > /opt/reelfortune/server/data/reelfortune.db
# 3. rm -f /opt/reelfortune/server/data/reelfortune.db-wal \
#          /opt/reelfortune/server/data/reelfortune.db-shm
# 4. chown reelfortune:reelfortune /opt/reelfortune/server/data/reelfortune.db
# 5. systemctl start reelfortune
