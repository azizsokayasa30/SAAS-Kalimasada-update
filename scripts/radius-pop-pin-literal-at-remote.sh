#!/usr/bin/env bash
# radius-pop-pin-literal-at-remote.sh — dorong + terapkan pin literal-@ ke POP FreeRADIUS.
# Default: POP_SYNC_HOST=10.10.0.12 user ajizs (sama seperti radius-pop-sync-publish).
#
# Jika sudo di POP butuh password, skrip tetap mengunggah pin script lalu cetak perintah manual:
#   ssh ajizs@POP 'sudo bash ~/radius-sync/freeradius-pin-literal-at.sh'
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIN_SRC="${ROOT_DIR}/scripts/lib/freeradius-pin-literal-at.sh"
POP_HOST="${POP_SYNC_HOST:-10.10.0.12}"
POP_USER="${POP_SYNC_USER:-ajizs}"
SSH_KEY="${POP_SYNC_SSH_KEY:-/root/.ssh/id_ed25519_radius_pop}"
REMOTE_DIR="${POP_SYNC_DIR:-radius-sync}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die() { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

[[ -f $PIN_SRC ]] || die "Pin script tidak ada: $PIN_SRC"
[[ -f $SSH_KEY ]] || die "SSH key tidak ada: $SSH_KEY"

SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
SCP=(scp -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

log "Upload pin script → ${POP_USER}@${POP_HOST}:~/${REMOTE_DIR}/"
"${SSH[@]}" "${POP_USER}@${POP_HOST}" "mkdir -p ~/${REMOTE_DIR}"
"${SCP[@]}" "$PIN_SRC" "${POP_USER}@${POP_HOST}:${REMOTE_DIR}/freeradius-pin-literal-at.sh"
"${SSH[@]}" "${POP_USER}@${POP_HOST}" "chmod +x ~/${REMOTE_DIR}/freeradius-pin-literal-at.sh"

# Optional sudoers snippet for future NOPASSWD (install manually once as root on POP)
"${SSH[@]}" "${POP_USER}@${POP_HOST}" "cat > ~/${REMOTE_DIR}/sudoers-pin-literal-at.example <<'EOF'
# Install once as root on POP:
#   sudo install -m 440 ~/radius-sync/sudoers-pin-literal-at.example /etc/sudoers.d/kalimasada-pin-literal-at
#   sudo visudo -cf /etc/sudoers.d/kalimasada-pin-literal-at
ajizs ALL=(root) NOPASSWD: /home/ajizs/radius-sync/freeradius-pin-literal-at.sh
EOF"

if "${SSH[@]}" "${POP_USER}@${POP_HOST}" "sudo -n bash ~/${REMOTE_DIR}/freeradius-pin-literal-at.sh"; then
  log "Pin diterapkan di POP via sudo -n"
  # Verify remotely (readable)
  "${SSH[@]}" "${POP_USER}@${POP_HOST}" "grep -cE '^[ \\t]+suffix([ \\t]|\$)' /etc/freeradius/3.0/sites-available/default || true"
  exit 0
fi

warn "sudo -n gagal (butuh password / NOPASSWD belum dipasang)."
warn "Jalankan SEKALI di POP (user dengan sudo):"
echo "  ssh -i ${SSH_KEY} ${POP_USER}@${POP_HOST}"
echo "  sudo bash ~/${REMOTE_DIR}/freeradius-pin-literal-at.sh"
echo "  # opsional agar VPS bisa apply ulang tanpa password:"
echo "  sudo install -m 440 ~/${REMOTE_DIR}/sudoers-pin-literal-at.example /etc/sudoers.d/kalimasada-pin-literal-at"
exit 2
