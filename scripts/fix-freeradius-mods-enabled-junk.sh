#!/usr/bin/env bash
# Pindahkan backup/rusak dari mods-enabled/ — FreeRADIUS memuat SEMUA file di folder itu.
# Penyebab umum: sql.bak-* → error "${dialect} not found" saat restart.
#
#   sudo bash scripts/fix-freeradius-mods-enabled-junk.sh
#
set -euo pipefail

MODS="/etc/freeradius/3.0/mods-enabled"
ARCHIVE="/etc/freeradius/3.0/disabled-mods-backup-$(date +%Y%m%d%H%M%S)"

[[ ${EUID} -eq 0 ]] || { echo "sudo bash $0"; exit 1; }
[[ -d $MODS ]] || { echo "Tidak ada $MODS"; exit 1; }

mkdir -p "$ARCHIVE"
moved=0
shopt -s nullglob
for f in "$MODS"/*; do
  base=$(basename "$f")
  case "$base" in
    sql) continue ;;
    *.bak*|*~|sql.bak-*)
      echo "Pindah: $base -> $ARCHIVE/"
      mv "$f" "$ARCHIVE/"
      moved=$((moved + 1))
      ;;
  esac
done

echo "Dipindahkan: $moved file"
echo "Isi mods-enabled:"
ls -la "$MODS" | head -25
echo ""
echo "Arsip: $ARCHIVE"
