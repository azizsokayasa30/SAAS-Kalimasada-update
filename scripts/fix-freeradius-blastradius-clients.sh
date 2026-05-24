#!/usr/bin/env bash
# Set require_message_authenticator = yes untuk semua client di clients.conf (BlastRADIUS / RouterOS baru).
#   sudo bash scripts/fix-freeradius-blastradius-clients.sh
#
set -euo pipefail

CLIENTS="/etc/freeradius/3.0/clients.conf"
[[ ${EUID} -eq 0 ]] || { echo "sudo bash $0"; exit 1; }
[[ -f $CLIENTS ]] || { echo "Tidak ada $CLIENTS"; exit 1; }

cp -a "$CLIENTS" "${CLIENTS}.bak-blastradius-$(date +%Y%m%d%H%M%S)"

python3 - "$CLIENTS" <<'PY'
import re, sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text().splitlines(keepends=True)
out = []
i = 0
changed = 0
while i < len(lines):
    line = lines[i]
    out.append(line)
    if re.match(r'^\s*client\s+\S+\s*\{', line.strip()):
        block = [line]
        depth = line.count('{') - line.count('}')
        i += 1
        has_msg = False
        while i < len(lines) and depth > 0:
            bl = lines[i]
            bs = bl.strip()
            depth += bs.count('{') - bs.count('}')
            if re.match(r'require_message_authenticator\s*=', bs):
                has_msg = True
                if 'yes' not in bs and 'true' not in bs:
                    ind = re.match(r'^(\s*)', bl).group(1)
                    bl = f'{ind}require_message_authenticator = yes\n'
                    changed += 1
            block.append(bl)
            i += 1
        if not has_msg:
            indent = re.match(r'^(\s*)', block[0]).group(1)
            block.insert(1, f'{indent}\trequire_message_authenticator = yes\n')
            changed += 1
        out = out[:-1] + block
        continue
    i += 1

path.write_text(''.join(out))
print(f'Updated {changed} client block(s)')
PY

echo "Restart FreeRADIUS..."
systemctl restart freeradius
systemctl is-active freeradius
echo "OK. Uji auth dari MikroTik atau: radtest USER PASS NAS_IP 0 SECRET"
