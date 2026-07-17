# Persiapan Radius Manager + FreeRADIUS (tanpa cutover MikroTik)

Dokumen operasional persiapan. **Tidak** mengubah `/radius` di MikroTik produksi dan **tidak** menguji putus VPN/PPPoE.

Portal: https://manage.kalimasada-app.com/management/pop/radius

## Status inventaris (sudah diisi)

| POP | Nama | Host | Aktif | Catatan |
|-----|------|------|-------|---------|
| HQ | FreeRADIUS VPS Pusat (aktif) | `127.0.0.1` | ya | Mesin FreeRADIUS yang sedang jalan di VPS DC |
| HQ | FreeRADIUS VPS (IP tunnel VPN) | `10.10.0.1` | ya | IP tunnel VPS yang saat ini dituju NAS via VPN |
| POP-BNA1 | FreeRADIUS lokal POP-BNA1 (Sokayasa) | `103.132.40.22` | ya | Inventaris A3 — secret `skynet-sokayasa`; auth MikroTik tetap pakai IP LAN lokal |

Verifikasi ulang kapan saja (read-only):

```bash
cd /root/Saas-Kalimasada_Inti_Sarana
bash scripts/verify-radius-manager-prep.sh
```

Laporan tersimpan di `data/reports/radius-manager-prep-*.txt`.

## Verifikasi FreeRADIUS (hasil persiapan)

- Service: **active**
- Modul SQL: SQLite `filename = /var/lib/freeradius/radius.db`
- `radcheck`: ~2199 baris
- `nas` / `clients.conf`: NAS terdaftar (alfan123, Dell-R630-SKYNET, Habib, KAISAR-WITEL-PGD, RO_*, X86-8074, dll.)
- Tidak ada perubahan pada konfigurasi MikroTik dari langkah ini

## Align billing ↔ DB FreeRADIUS

| Sumber | Path | Status |
|--------|------|--------|
| FreeRADIUS | `/var/lib/freeradius/radius.db` | **Sumber auth hidup** |
| `.env` `RADIUS_SQLITE_PATH` | `/var/lib/freeradius/radius.db` | **Sejalan** (proses Node + dotenv) |
| `data/radius.db` | salinan terpisah (inode beda, radcheck ~2168) | **Stale — jangan dipakai auth** |

Kesimpulan: billing yang jalan dengan `.env` menulis/membaca DB yang sama dengan FreeRADIUS. Salinan `data/radius.db` boleh diabaikan atau diarsipkan nanti; jangan diarahkan sebagai path produksi.

## Checklist MikroTik (SIAPKAN TEKS — BELUM APPLY)

Ganti placeholder sebelum jadwal cutover jam sepi. **Jangan jalankan di router produksi sekarang.**

### A. Cadangkan konfigurasi dulu

```
/export file=backup-before-radius-local
/radius print detail
/interface pppoe-server server print detail
```

### B. Tambah RADIUS lokal (nanti, setelah PC FreeRADIUS site punya IP)

```
/radius add name=RADIUS-LOCAL address=<IP_FR_LOKAL> secret=<SECRET_SAMA_CLIENTS_CONF> service=ppp authentication-port=1812 accounting-port=1813 timeout=3s
```

### C. Opsional: biarkan RADIUS VPS sebagai cadangan (urutan/priority sesuai RouterOS)

```
/radius add name=RADIUS-VPS address=10.10.0.1 secret=<SECRET_NAS_ITU> service=ppp authentication-port=1812 accounting-port=1813 timeout=3s
```

Secret per NAS harus cocok dengan `clients.conf` / tabel `nas` (contoh: Dell-R630-SKYNET memakai secret yang sudah terdaftar untuk `10.10.0.2`).

### D. Pastikan PPPoE memakai RADIUS

```
/interface pppoe-server server set [find] authentication=radius
```

### E. Setelah apply (fase nanti)

1. Uji 1–2 login pelanggan
2. Cek `/radius monitor` dan log FreeRADIUS (`Access-Accept`)
3. Baru uji isolir 1 user
4. Baru uji putus VPN (bukan sekarang)

### F. Pilot disarankan

- POP: **POP-BNA1-SOKAYASA**
- Setelah PC FreeRADIUS lokal siap: edit stub di Radius Manager → isi host IP LAN nyata + secret + aktifkan
- Sync user dari DB VPS ke DB lokal **sebelum** mengarahkan MikroTik

## Batasan Radius Manager

Menu portal hanya inventaris + monitor host. Setting auth billing tetap di `/admin/radius` per tenant. Sync multi-site belum otomatis dari UI ini.

## Install FreeRADIUS di PC lokal POP

Salin satu file ke Ubuntu site, lalu:

```bash
chmod +x install-freeradius-local-pop.sh
sudo bash install-freeradius-local-pop.sh \
  --pop-name "POP-BNA1" \
  --nas-ip 192.168.10.1 \
  --nas-secret 'SECRET_SAMA_MIKROTIK'
```

Sumber di repo: `scripts/install-freeradius-local-pop.sh` (mandiri, tidak perlu clone penuh).

## Urutan berikutnya (setelah MikroTik siap diset)

1. Isi IP FreeRADIUS lokal di stub POP-BNA1
2. Sync `radcheck` / group ke DB lokal
3. Apply checklist MikroTik di jam sepi
4. Uji login → isolir → (terakhir) uji VPN down
