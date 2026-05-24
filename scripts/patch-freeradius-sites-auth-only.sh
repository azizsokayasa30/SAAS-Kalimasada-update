#!/usr/bin/env bash
# Nonaktifkan sql di post-auth & accounting (auth tetap pakai sql di authorize).
# Tidak mengubah mods-enabled/sql — aman dipanggil sebelum atau sesudah migrasi MySQL.
set -euo pipefail

DEFAULT="/etc/freeradius/3.0/sites-enabled/default"
INNER="/etc/freeradius/3.0/sites-enabled/inner-tunnel"

[[ ${EUID} -eq 0 ]] || { echo "sudo bash $0"; exit 1; }

export FR_DEFAULT="$DEFAULT" FR_INNER="$INNER"
python3 <<'PY'
import os, re
from pathlib import Path

MARKER_POST = '# billing: post-auth sql disabled'
MARKER_ACCT_OFF = '# billing: accounting sql disabled (auth-only; stop sqlite lock)'

def is_sql_line(s):
    s = s.strip()
    if not s or s.startswith('#'):
        return False
    return bool(re.match(r'^-?sql(\s*#.*)?$', s))

def patch_file(path: Path):
    text = path.read_text()
    changed_post = changed_acct = False

    def patch_block(content, block_name, on_sql_line):
        nonlocal changed_post, changed_acct
        out, lines, i = [], content.splitlines(keepends=True), 0
        while i < len(lines):
            line = lines[i]
            if re.match(rf'^\s*{re.escape(block_name)}\s*\{{', line.strip()):
                block, depth = [line], line.count('{') - line.count('}')
                i += 1
                while i < len(lines) and depth > 0:
                    bl, bs = lines[i], lines[i].strip()
                    depth += bs.count('{') - bs.count('}')
                    if is_sql_line(bs):
                        block.extend(on_sql_line(bl, block_name))
                        if block_name == 'post-auth':
                            changed_post = True
                        else:
                            changed_acct = True
                    else:
                        block.append(bl)
                    i += 1
                out.extend(block)
                continue
            out.append(line)
            i += 1
        return ''.join(out)

    def disable_post(bl, _name):
        ind = re.match(r'^(\s*)', bl).group(1)
        return [f'{ind}{MARKER_POST}\n', f'{ind}# {bl.strip()}\n']

    def disable_acct(bl, _name):
        ind = re.match(r'^(\s*)', bl).group(1)
        return [f'{ind}{MARKER_ACCT_OFF}\n', f'{ind}# {bl.strip()}\n']

    if MARKER_POST not in text:
        text = patch_block(text, 'post-auth', disable_post)
    if MARKER_ACCT_OFF not in text:
        text = patch_block(text, 'accounting', disable_acct)
    path.write_text(text)
    print(f'{path}: post-auth_disabled={changed_post} accounting_sql_off={changed_acct}')

for p in [os.environ.get('FR_DEFAULT'), os.environ.get('FR_INNER')]:
    if p and Path(p).is_file():
        patch_file(Path(p))
PY

for site in "$DEFAULT" "$INNER"; do
  [[ -f $site ]] || continue
  if grep -q 'billing: post-auth sql disabled' "$site"; then
    echo "OK: post-auth -sql di $(basename "$site")"
  else
    echo "GAGAL: post-auth belum di-patch di $site" >&2
    exit 1
  fi
done
