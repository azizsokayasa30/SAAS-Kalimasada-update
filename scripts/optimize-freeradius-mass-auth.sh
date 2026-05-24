#!/usr/bin/env bash
# Optimasi FreeRADIUS untuk autentikasi PPPoE massal (banyak user konek bersamaan).
# Jalankan sebagai root di server yang menjalankan FreeRADIUS:
#   sudo bash scripts/optimize-freeradius-mass-auth.sh
#
# Perubahan:
# - reject_delay = 0 (cegah Mikrotik timeout saat Access-Reject)
# - thread pool lebih besar (handle burst auth)
# - busy_timeout SQLite di mods-enabled/sql (tahan lock contention)
# - max_connections = 1 untuk SQLite (banyak koneksi = lock parah)
# - nonaktifkan sql di post-auth + skip accounting Interim-Update

set -euo pipefail

RADIUSD_CFG="/etc/freeradius/3.0/radiusd.conf"
SQL_CFG="/etc/freeradius/3.0/mods-enabled/sql"
DEFAULT_SITE="/etc/freeradius/3.0/sites-enabled/default"
INNER_TUNNEL="/etc/freeradius/3.0/sites-enabled/inner-tunnel"
BACKUP_DIR="/etc/freeradius/3.0/backup-mass-auth-$(date +%Y%m%d%H%M%S)"
MARKER_POSTAUTH='# billing: post-auth sql disabled'
MARKER_ACCT='# billing: accounting sql disabled'

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo "Jalankan sebagai root: sudo bash $0" >&2
    exit 1
  fi
}

backup_file() {
  local file=$1
  if [[ -f $file ]]; then
    mkdir -p "$BACKUP_DIR"
    cp "$file" "$BACKUP_DIR/$(basename "$file")"
    echo "Backup: $file -> $BACKUP_DIR/"
  fi
}

update_reject_delay() {
  python3 - "$RADIUSD_CFG" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
line = '    reject_delay = 0'
pattern = re.compile(r'^\s*reject_delay\s*=.*$', re.M)
if pattern.search(text):
    text = pattern.sub(line, text)
else:
    marker = 'security {'
    idx = text.find(marker)
    if idx == -1:
        raise SystemExit('security { block not found in radiusd.conf')
    insert_pos = idx + len(marker)
    text = text[:insert_pos] + '\n' + line + text[insert_pos:]
path.write_text(text)
print('reject_delay = 0')
PY
}

fr_sql_uses_mysql() {
  [[ -f $SQL_CFG ]] && grep -q 'dialect = "mysql"' "$SQL_CFG" 2>/dev/null
}

update_thread_pool() {
  local max_srv=8
  if fr_sql_uses_mysql; then
    max_srv=32
  fi
  export FR_MAX_SERVERS="$max_srv"
  python3 - "$RADIUSD_CFG" <<'PY'
import os
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
max_servers = os.environ.get('FR_MAX_SERVERS', '8')

desired = {
    'start_servers': '4',
    'max_servers': max_servers,
    'min_spare_servers': '2',
    'max_spare_servers': '6',
    'max_requests_per_server': '0',
    'auto_limit_acct': 'no',
}

if 'thread pool {' not in text:
    block = '''
thread pool {
    start_servers = 4
    max_servers = 8
    min_spare_servers = 2
    max_spare_servers = 6
    max_requests_per_server = 0
    auto_limit_acct = no
}
'''
    text = text.rstrip() + '\n' + block
else:
    for key, val in desired.items():
        pat = re.compile(rf'^(\s*{re.escape(key)}\s*=).*', re.M)
        if pat.search(text):
            text = pat.sub(rf'\1 {val}', text)
        else:
            text = re.sub(
                r'(thread pool \{)',
                rf'\1\n    {key} = {val}',
                text,
                count=1,
            )

path.write_text(text)
print(f'thread pool tuned (max_servers={max_servers})')
PY
}

update_sqlite_busy_timeout() {
  if fr_sql_uses_mysql; then
    echo "Skip SQL module tuning: backend MySQL (mods-enabled/sql)"
    return 0
  fi
  [[ -f $SQL_CFG ]] || { echo "Skip SQL module: $SQL_CFG not found"; return 0; }
  python3 - "$SQL_CFG" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()

if 'busy_timeout' not in text:
    if re.search(r'sqlite\s*\{', text, re.I):
        text = re.sub(
            r'(sqlite\s*\{)',
            r'\1\n        busy_timeout = 60000',
            text,
            count=1,
            flags=re.I,
        )
    else:
        text = re.sub(
            r'(driver\s*=\s*"sqlite")',
            r'\1\n    sqlite {\n        busy_timeout = 60000\n    }',
            text,
            count=1,
        )
else:
    text = re.sub(r'busy_timeout\s*=\s*\d+', 'busy_timeout = 60000', text)

if 'max_connections' not in text:
    text = re.sub(
        r'(sql\s*\{)',
        r'\1\n    max_connections = 1',
        text,
        count=1,
    )
else:
    text = re.sub(r'max_connections\s*=\s*\d+', 'max_connections = 1', text)

path.write_text(text)
print('sql module: busy_timeout=60000, max_connections=1 (SQLite)')
PY
}

patch_site_sqlite_load() {
  local site=$1
  [[ -f $site ]] || return 0
  python3 - "$site" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
marker_post = '# billing: post-auth sql disabled'
marker_acct_off = '# billing: accounting sql disabled'
changed_post = changed_acct = False

def patch_block(content, block_name, line_predicate, replacement_fn):
    global changed_post, changed_acct
    out = []
    i = 0
    lines = content.splitlines(keepends=True)
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if re.match(rf'{re.escape(block_name)}\s*\{{', stripped):
            block_lines = [line]
            depth = stripped.count('{') - stripped.count('}')
            i += 1
            while i < len(lines) and depth > 0:
                bl = lines[i]
                bs = bl.strip()
                depth += bs.count('{') - bs.count('}')
                if line_predicate(bs) and not bs.startswith('#'):
                    block_lines.extend(replacement_fn(bl))
                    if block_name == 'post-auth':
                        changed_post = True
                    else:
                        changed_acct = True
                else:
                    block_lines.append(bl)
                i += 1
            out.extend(block_lines)
            continue
        out.append(line)
        i += 1
    return ''.join(out)

def is_sql_module_line(s):
    return bool(re.match(r'^-?sql(\s+#.*)?$', s))

def disable_sql_line(original):
    indent = re.match(r'^(\s*)', original).group(1)
    return [
        f'{indent}{marker_post}\n',
        f'{indent}# {original.strip()}  # disabled: radpostauth lock\n',
    ]

def disable_sql_accounting(original):
    indent = re.match(r'^(\s*)', original).group(1)
    return [
        f'{indent}{marker_acct_off}\n',
        f'{indent}# {original.strip()}  # disabled: accounting sqlite lock\n',
    ]

if marker_post not in text:
    text = patch_block(text, 'post-auth', is_sql_module_line, disable_sql_line)

if marker_acct_off not in text:
    text = patch_block(text, 'accounting', is_sql_module_line, disable_sql_accounting)

path.write_text(text)
print(f'{path.name}: post-auth sql off={changed_post}, accounting sql off={changed_acct}')
if not changed_post and marker_post not in path.read_text():
    print(f'  WARN: post-auth sql tidak ditemukan di {path} — cek manual')
PY
}

patch_all_sites() {
  patch_site_sqlite_load "$DEFAULT_SITE"
  patch_site_sqlite_load "$INNER_TUNNEL"
}

verify_patches() {
  local ok=1
  for site in "$DEFAULT_SITE" "$INNER_TUNNEL"; do
    [[ -f $site ]] || continue
    if grep -q "$MARKER_POSTAUTH" "$site" 2>/dev/null; then
      echo "OK: post-auth sql disabled in $(basename "$site")"
    else
      echo "GAGAL: post-auth sql masih aktif di $site — edit manual atau hubungi support"
      ok=0
    fi
  done
  if fr_sql_uses_mysql; then
    echo "OK: SQL backend MySQL (tidak pakai max_connections=1 SQLite)"
  elif grep -q 'max_connections = 1' "$SQL_CFG" 2>/dev/null; then
    echo "OK: sql max_connections=1 (SQLite)"
  else
    echo "PERINGATAN: set max_connections = 1 di $SQL_CFG"
  fi
  return $ok
}

validate_and_restart() {
  if command -v freeradius >/dev/null 2>&1; then
    freeradius -C >/dev/null
    echo "Config validation OK"
  fi
  if systemctl list-unit-files | grep -q freeradius.service; then
    systemctl restart freeradius
    echo "FreeRADIUS restarted"
  elif systemctl list-unit-files | grep -q freeradiusd.service; then
    systemctl restart freeradiusd
    echo "FreeRADIUS restarted (freeradiusd)"
  fi
}

print_mikrotik_hint() {
  cat <<'EOF'

=== Mikrotik (wajib dicek manual) ===
RouterOS: hanya ada properti timeout (maks 3s). TIDAK ada parameter retry= di /radius.
  /radius print
  /radius set [find] timeout=3s

Ulang kirim otomatis jika tidak ada jawaban (lihat: /radius monitor 0 → resends, timeouts).
Karena batas 3s, server HARUS merespons cepat (reject_delay=0, post-auth sql off, SQLite tidak lock).
Dokumentasi: docs/MIKROTIK_RADIUS_PPPOE_CONFIG.rsc

=== Verifikasi (setelah restart) ===
  grep post-auth /etc/freeradius/3.0/sites-enabled/default | head -5
  tail -20 /var/log/freeradius/radius.log | grep -E 'locked|post-auth' || echo "Tidak ada error lock/post-auth"
  # Di Mikrotik: /radius monitor 0 — timeouts/resends harus jarang naik
EOF
}

main() {
  require_root
  for f in "$RADIUSD_CFG"; do
    [[ -f $f ]] || { echo "File not found: $f" >&2; exit 1; }
    backup_file "$f"
  done
  backup_file "$SQL_CFG"
  backup_file "$DEFAULT_SITE"
  backup_file "$INNER_TUNNEL"

  update_reject_delay
  update_thread_pool
  update_sqlite_busy_timeout
  patch_all_sites
  verify_patches || true
  validate_and_restart
  print_mikrotik_hint
  echo ""
  echo "Backup config: $BACKUP_DIR"
  echo "Optimasi mass-auth selesai."
}

main "$@"
