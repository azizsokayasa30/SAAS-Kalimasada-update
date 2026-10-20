#!/usr/bin/env bash
# Restart FreeRADIUS jika cgroup/RSS mendekati cap OOM (banjir auth / leak).
# Dipanggil timer systemd: freeradius-oom-watchdog.timer
set -euo pipefail

UNIT=freeradius
# Restart proaktif sebelum MemoryHigh 1.5G / MemoryMax 2G
THRESHOLD_BYTES=$((1200 * 1024 * 1024))
MIN_UPTIME_SEC=180
COOLDOWN_SEC=900
STATE_DIR=/var/lib/freeradius
STATE_FILE="${STATE_DIR}/watchdog-last-restart"
LOG=/var/log/freeradius/watchdog.log

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] $*" | tee -a "$LOG" >/dev/null
  logger -t freeradius-oom-watchdog -- "$*" || true
}

bytes_human() {
  awk -v b="$1" 'BEGIN {
    if (b < 0) { print "?"; exit }
    if (b >= 1073741824) printf "%.2fG", b/1073741824
    else if (b >= 1048576) printf "%.0fM", b/1048576
    else printf "%dK", b/1024
  }'
}

if ! systemctl is-active --quiet "$UNIT"; then
  exit 0
fi

mem_cur=$(systemctl show "$UNIT" -p MemoryCurrent --value 2>/dev/null || echo "")
if [[ -z $mem_cur || $mem_cur == '[not set]' || $mem_cur == 18446744073709551615 ]]; then
  pid=$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)
  if [[ -n $pid && $pid != 0 && -r /proc/$pid/statm ]]; then
    pages=$(awk '{print $2}' "/proc/$pid/statm")
    page=$(getconf PAGESIZE)
    mem_cur=$((pages * page))
  else
    exit 0
  fi
fi

if (( mem_cur < THRESHOLD_BYTES )); then
  exit 0
fi

pid=$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)
uptime_sec=0
if [[ -n $pid && $pid != 0 ]]; then
  uptime_sec=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
fi
if [[ $uptime_sec =~ ^[0-9]+$ ]] && (( uptime_sec > 0 && uptime_sec < MIN_UPTIME_SEC )); then
  log "Skip restart: memory $(bytes_human "$mem_cur") but uptime ${uptime_sec}s < ${MIN_UPTIME_SEC}s"
  exit 0
fi

now_epoch=$(date +%s)
if [[ -f $STATE_FILE ]]; then
  last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [[ $last =~ ^[0-9]+$ ]] && (( now_epoch - last < COOLDOWN_SEC )); then
    log "Skip restart: memory $(bytes_human "$mem_cur") but cooldown $((COOLDOWN_SEC - (now_epoch - last)))s left"
    exit 0
  fi
fi

mkdir -p "$STATE_DIR"
echo "$now_epoch" > "$STATE_FILE"
log "Restart FreeRADIUS: memory $(bytes_human "$mem_cur") >= $(bytes_human "$THRESHOLD_BYTES")"
systemctl restart "$UNIT"
sleep 2
if systemctl is-active --quiet "$UNIT"; then
  log "FreeRADIUS restarted OK (pid $(systemctl show "$UNIT" -p MainPID --value))"
else
  log "ERROR: FreeRADIUS not active after watchdog restart"
  exit 1
fi
