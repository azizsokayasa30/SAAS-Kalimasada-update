#!/usr/bin/env bash
# freeradius-pin-literal-at.sh — Pin FreeRADIUS agar `@` di User-Name literal (bukan realm).
#
# - Nonaktifkan pemanggilan modul `suffix` di sites-enabled/default
# - Pastikan sql_user_name = %{User-Name}
# - Pastikan safe_characters mencakup @
#
# Usage (root):
#   sudo bash scripts/lib/freeradius-pin-literal-at.sh
#   sudo bash scripts/lib/freeradius-pin-literal-at.sh --no-restart
#
set -euo pipefail

FR_DIR="${FR_DIR:-/etc/freeradius/3.0}"
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die() { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Butuh root: sudo bash $0"
command -v python3 >/dev/null || die "python3 diperlukan"

SITE="${FR_DIR}/sites-enabled/default"
[[ -e $SITE ]] || die "Site tidak ada: $SITE"
SITE_REAL="$(readlink -f "$SITE" 2>/dev/null || echo "$SITE")"
[[ -f $SITE_REAL ]] || die "Tidak bisa resolve site: $SITE"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${FR_DIR}/.bak-pin-literal-at-${STAMP}"
mkdir -p "$BACKUP_DIR"
cp -a "$SITE_REAL" "${BACKUP_DIR}/sites-available-default"
log "Backup site → ${BACKUP_DIR}/sites-available-default"

SUFFIX_CHANGED="$(python3 - "$SITE_REAL" <<'PY'
import re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8", errors="replace") as f:
    lines = f.readlines()
out, changed = [], 0
for line in lines:
    m = re.match(r'^([ \t]+)suffix([ \t]*(#.*)?)?\n?$', line)
    if m:
        indent, rest = m.group(1), m.group(2) or ""
        out.append(f"{indent}# suffix{rest}  # kalimasada: literal @ in PPPoE User-Name\n")
        changed += 1
    else:
        out.append(line if line.endswith("\n") else line + "\n")
if changed:
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)
print(changed)
PY
)"
log "Disabled active suffix module calls: $SUFFIX_CHANGED"

# Stock filter_username rejects User-Name with @ unless realm looks like host.domain
# (e.g. tohid@pppoe / KLN@muhaimin → Access-Reject). Soften for literal PPPoE logins.
FILTER="${FR_DIR}/policy.d/filter"
if [[ -f $FILTER ]]; then
  cp -a "$FILTER" "${BACKUP_DIR}/policy.d-filter"
  python3 - "$FILTER" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
if "kalimasada: allow literal @" in text:
    print("already")
    raise SystemExit(0)
block = """\t\t#
\t\t#  must have at least 1 string-dot-string after @
\t\t#  e.g. \"user@site.com\"
\t\t#
\t\tif ((&User-Name =~ /@/) && (&User-Name !~ /@(.+)\\.(.+)$/))  {
\t\t\tupdate request {
\t\t\t\t&Module-Failure-Message += 'Rejected: Realm does not have at least one dot separator'
\t\t\t}
\t\t\treject
\t\t}"""
replacement = """\t\t#
\t\t#  kalimasada: allow literal @ in PPPoE User-Name (e.g. user@site / tohid@pppoe)
\t\t#  Stock rule required email-like realm with a dot; disabled below.
\t\t#
\t\t# if ((&User-Name =~ /@/) && (&User-Name !~ /@(.+)\\.(.+)$/))  {
\t\t#\tupdate request {
\t\t#\t\t&Module-Failure-Message += 'Rejected: Realm does not have at least one dot separator'
\t\t#\t}
\t\t#\treject
\t\t# }"""
if block not in text:
    print("block-not-found")
    raise SystemExit(1)
path.write_text(text.replace(block, replacement, 1), encoding="utf-8")
print("patched")
PY
  FILTER_RC=$?
  if [[ $FILTER_RC -eq 0 ]]; then
    log "filter_username realm-dot rule patched (or already applied)"
  else
    warn "Patch filter_username gagal (rc=$FILTER_RC) — cek $FILTER manual"
  fi
else
  warn "policy.d/filter tidak ada — lewati"
fi

pin_queries() {
  local qfile="$1"
  [[ -f $qfile ]] || return 0
  local base
  base="$(basename "$(dirname "$qfile")")"
  cp -a "$qfile" "${BACKUP_DIR}/${base}-queries.conf"
  python3 - "$qfile" <<'PY'
import re, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8", errors="replace") as f:
    lines = f.readlines()

out = []
seen_user_name = False
seen_safe = False
i = 0
while i < len(lines):
    line = lines[i]
    # Comment out stripped sql_user_name if active
    if re.match(r'^[ \t]*sql_user_name\s*=\s*"%\{%\{Stripped-User-Name\}', line):
        out.append("#" + line if not line.lstrip().startswith("#") else line)
        i += 1
        continue
    # Track / normalize User-Name pin
    if re.match(r'^[ \t]*sql_user_name\s*=\s*"%\{User-Name\}"', line):
        seen_user_name = True
        out.append('sql_user_name = "%{User-Name}"\n')
        i += 1
        continue
    if re.match(r'^[ \t]*#\s*sql_user_name\s*=\s*"%\{User-Name\}"', line):
        if not seen_user_name:
            out.append('sql_user_name = "%{User-Name}"\n')
            seen_user_name = True
        else:
            out.append(line if line.endswith("\n") else line + "\n")
        i += 1
        continue
    # safe_characters
    m = re.match(r'^[ \t]*#?\s*safe_characters\s*=\s*"([^"]*)"(.*)$', line)
    if m and not seen_safe:
        chars = m.group(1)
        if "@" not in chars:
            chars = "@" + chars
        out.append(f'safe_characters = "{chars}"\n')
        seen_safe = True
        i += 1
        continue
    out.append(line if line.endswith("\n") else line + "\n")
    i += 1

if not seen_user_name:
    out.insert(0, 'sql_user_name = "%{User-Name}"\n')
if not seen_safe:
    out.insert(0, 'safe_characters = "@abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_: /"\n')

new = "".join(out)
old = "".join(lines)
if new != old:
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print("updated")
else:
    print("unchanged")
PY
}

for dialect in sqlite mysql; do
  q="${FR_DIR}/mods-config/sql/main/${dialect}/queries.conf"
  if [[ -f $q ]]; then
    result="$(pin_queries "$q")"
    log "Pin queries ${dialect}: $result ($q)"
  fi
done

# Verify site no longer has active suffix
ACTIVE_SUFFIX="$(grep -cE '^[ \t]+suffix([ \t]|$)' "$SITE_REAL" || true)"
if [[ "${ACTIVE_SUFFIX:-0}" -gt 0 ]]; then
  die "Masih ada ${ACTIVE_SUFFIX} pemanggilan suffix aktif di $SITE_REAL"
fi
log "Verified: no active suffix calls in site"

if command -v freeradius >/dev/null 2>&1; then
  if freeradius -C >/dev/null 2>&1; then
    log "freeradius -C OK"
  else
    warn "freeradius -C gagal — output:"
    freeradius -C 2>&1 | tail -40 || true
    die "Config invalid — restore dari $BACKUP_DIR"
  fi
else
  warn "Perintah freeradius tidak ada — lewati -C"
fi

fr_svc() {
  if systemctl list-unit-files 2>/dev/null | grep -q '^freeradius\.service'; then
    echo freeradius
  elif systemctl list-unit-files 2>/dev/null | grep -q '^freeradiusd\.service'; then
    echo freeradiusd
  else
    echo freeradius
  fi
}

if [[ $NO_RESTART -eq 0 ]]; then
  svc="$(fr_svc)"
  systemctl restart "$svc"
  sleep 2
  if systemctl is-active --quiet "$svc"; then
    log "FreeRADIUS restarted ($svc)"
  else
    die "FreeRADIUS gagal start — restore $BACKUP_DIR; journalctl -u $svc -n 40"
  fi
else
  warn "--no-restart: restart FreeRADIUS manual setelah review"
fi

log "Pin literal @ selesai. Backup: $BACKUP_DIR"
