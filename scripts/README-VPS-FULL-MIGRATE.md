# Migrasi Full VPS (Hostinger → Server Baru)

Backup **hampir seluruh filesystem** VPS (app SaaS billing, FreeRADIUS, Nginx, SSL, PM2, data) lalu restore dengan **1 skrip** di Ubuntu 22.04 baru.

## Prasyarat

| Item | Keterangan |
|------|------------|
| VPS lama | Ubuntu 22.04 (Hostinger), root SSH |
| VPS baru | Ubuntu **22.04** fresh, root SSH, disk bebas ≥ **80 GB** |
| Ruang backup di VPS lama | Disarankan ≥ **40–50 GB** bebas di `/root` |
| Transfer | `scp` / `rsync` ke server baru |

Estimasi: disk terpakai ~42 GB → arsip `.tar.zst` tipikal ~15–25 GB (tergantung kompresi).

---

## 1. Backup di VPS lama (1 perintah)

```bash
cd /root/Saas-Kalimasada_Inti_Sarana
sudo bash scripts/vps-full-backup.sh
```

Hasil di `/root/`:

- `vps-full-YYYYMMDD_HHMMSS.tar.zst`
- `vps-full-YYYYMMDD_HHMMSS.tar.zst.sha256`
- `vps-full-YYYYMMDD_HHMMSS.MANIFEST.txt`

Yang dilakukan skrip:

1. Stop PM2 `billing-kalimasada` + FreeRADIUS + Nginx (konsistensi SQLite / log)
2. WAL checkpoint `billing.db` / `sessions.db` / `radius.db`
3. Arsip hampir seluruh `/` (exclude `/proc`, `/sys`, `/dev`, `/run`, `/tmp`, `/snap`, `/var/log`, …)
4. `tar` exit code 1 (file berubah saat dibaca) **tidak** dianggap gagal
5. SHA256 + start ulang service

Opsional:

```bash
# simpan arsip ke path lain
sudo OUT_DIR=/mnt/backup bash scripts/vps-full-backup.sh

# tanpa stop service (tidak disarankan untuk migrasi)
sudo KEEP_RUNNING=1 bash scripts/vps-full-backup.sh
```

**Downtime:** beberapa menit sampai puluhan menit selama stop service + packing (tergantung disk/CPU).

---

## 2. Transfer ke server baru

```bash
# dari VPS lama
scp /root/vps-full-*.tar.zst /root/vps-full-*.tar.zst.sha256 root@IP_SERVER_BARU:/root/
```

Atau:

```bash
rsync -avhP /root/vps-full-YYYYMMDD_HHMMSS.tar.zst* root@IP_SERVER_BARU:/root/
```

---

## 3. Restore di server baru (1 skrip)

Server baru harus sudah bisa SSH (Ubuntu 22.04 minimal). Salin juga skrip restore jika belum ada di arsip path yang sama, atau extract dulu — biasanya skrip sudah ikut di dalam arsip di:

`/root/Saas-Kalimasada_Inti_Sarana/scripts/vps-full-restore.sh`

Cara paling aman sebelum extract penuh: bawa skrip terpisah kecil, atau jalankan dari salinan lokal:

```bash
# Jika repo/skrip sudah Anda scp terpisah:
sudo bash /root/Saas-Kalimasada_Inti_Sarana/scripts/vps-full-restore.sh /root/vps-full-YYYYMMDD_HHMMSS.tar.zst
```

Jika skrip belum ada di server baru, salin dulu dari VPS lama:

```bash
scp /root/Saas-Kalimasada_Inti_Sarana/scripts/vps-full-restore.sh root@IP_BARU:/root/
ssh root@IP_BARU 'bash /root/vps-full-restore.sh /root/vps-full-YYYYMMDD_HHMMSS.tar.zst'
```

### Satu skrip restore sudah include

- App billing (`/root/Saas-Kalimasada_Inti_Sarana`: DB, WA session, uploads, `.env`, `settings.json`)
- FreeRADIUS (`/etc/freeradius`, `/var/lib/freeradius`)
- Nginx (`/etc/nginx`)
- SSL Let's Encrypt (`/etc/letsencrypt`)
- PM2 → start `billing-kalimasada`
- Start service + cek integrity SQLite

### Tidak ditimpa (agar IP/SSH server baru tetap hidup)

`/etc/fstab`, hostname, hosts, machine-id, netplan/network, resolv.conf, cloud-init, SSH host keys (kecuali `RESTORE_SSH_KEYS=1`).

---

## 4. Verifikasi

```bash
pm2 status
systemctl status freeradius nginx --no-pager
sqlite3 /root/Saas-Kalimasada_Inti_Sarana/data/billing.db "PRAGMA integrity_check;"
sqlite3 /var/lib/freeradius/radius.db "PRAGMA integrity_check;"
```

Uji: login admin, 1 tenant, auth RADIUS, WhatsApp.

---

## 5. Cutover manual (setelah restore file)

Skrip **tidak** mengubah DNS/Mikrotik di luar server:

1. DNS A record → IP server baru  
2. Jika IP berubah: update RADIUS client di Mikrotik + clients FreeRADIUS  
3. Sesuaikan `PUBLIC_APP_BASE_URL` di `.env` bila domain/IP beda  
4. **Jangan** jalankan `node scripts/fresh-server-installation.js` (menghapus data)

---

## Troubleshooting

| Gejala | Tindakan |
|--------|----------|
| `nginx -t` gagal | Cek domain/cert path di `/etc/nginx/sites-enabled/` |
| FreeRADIUS gagal start | `journalctl -u freeradius -n 50`; cek ownership `/var/lib/freeradius` |
| PM2 tidak ada | `npm install -g pm2` lalu `cd APP && pm2 start ecosystem.config.cjs` |
| Checksum gagal | Transfer ulang file `.tar.zst` + `.sha256` |
| Disk penuh saat backup | Kosongkan log, exclude `public/mobile-app` manual, atau naikkan disk |

---

## Ringkas

```text
VPS lama:  sudo bash scripts/vps-full-backup.sh
Transfer:  scp vps-full-*.tar.zst* root@IP_BARU:/root/
VPS baru:  sudo bash vps-full-restore.sh /root/vps-full-XXXX.tar.zst
Cutover:   DNS + Mikrotik + .env URL
```
