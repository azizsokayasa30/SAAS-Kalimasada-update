#!/usr/bin/env bash
# Pasang cap OOM systemd + watchdog RAM FreeRADIUS.
#   sudo bash scripts/install-freeradius-oom-watchdog.sh
set -euo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Jalankan sebagai root: sudo bash $0" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="${ROOT}/scripts/freeradius-oom-watchdog.sh"
DROP_IN_DIR=/etc/systemd/system/freeradius.service.d
DROP_IN="${DROP_IN_DIR}/memory.conf"

[[ -f $WATCHDOG ]] || { echo "Script watchdog tidak ada: $WATCHDOG" >&2; exit 1; }
chmod 755 "$WATCHDOG"

mkdir -p "$DROP_IN_DIR"
cat > "$DROP_IN" <<'EOF'
# Billing Kalimasada: cap RAM + restart saat OOM (banjir RADIUS / leak).
# MemoryHigh: tekanan cgroup sebelum cap. MemoryMax: hard kill.
[Service]
MemoryAccounting=yes
MemoryHigh=1536M
MemoryMax=2G
OOMPolicy=kill
Restart=on-failure
RestartSec=5
EOF
chmod 644 "$DROP_IN"

cat > /etc/systemd/system/freeradius-oom-watchdog.service <<EOF
[Unit]
Description=FreeRADIUS RAM watchdog (restart if memory >= 1.2G)
After=freeradius.service
ConditionPathExists=$WATCHDOG

[Service]
Type=oneshot
Nice=10
ExecStart=$WATCHDOG
EOF
chmod 644 /etc/systemd/system/freeradius-oom-watchdog.service

cat > /etc/systemd/system/freeradius-oom-watchdog.timer <<'EOF'
[Unit]
Description=Run FreeRADIUS RAM watchdog every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
chmod 644 /etc/systemd/system/freeradius-oom-watchdog.timer

touch /var/log/freeradius/watchdog.log
chmod 640 /var/log/freeradius/watchdog.log
chown root:freerad /var/log/freeradius/watchdog.log 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now freeradius-oom-watchdog.timer

# Terapkan MemoryMax ke unit yang sedang jalan (tanpa tunggu reboot)
systemctl restart freeradius
sleep 3

echo "=== Drop-in memory ==="
systemctl cat freeradius | sed -n '/memory.conf/,/^# /p' | head -20
echo
echo "=== Memory props ==="
systemctl show freeradius -p MemoryMax,MemoryHigh,MemoryCurrent,OOMPolicy,Restart --no-pager
echo
echo "=== Timer ==="
systemctl is-enabled freeradius-oom-watchdog.timer
systemctl list-timers freeradius-oom-watchdog.timer --no-pager
echo
echo "=== FreeRADIUS ==="
systemctl is-active freeradius
echo "Start: $(systemctl show freeradius -p ActiveEnterTimestamp --value)"
echo
echo "Watchdog: threshold 1.2G, cooldown 15m, cek tiap 2 menit"
echo "Log: /var/log/freeradius/watchdog.log"
echo "Dry-run sekali:"
bash "$WATCHDOG" && echo "watchdog exit=0 (di bawah threshold, tidak restart)"
