# 🔄 Mode RADIUS 100% - Panduan Lengkap

## 📋 Ringkasan

Billing system ini sekarang **100% menggunakan mode RADIUS**. Semua operasi user management, profile management, dan autentikasi dilakukan melalui database RADIUS, bukan lagi melalui RouterOS API.

## ✅ Yang Sudah Dikonfigurasi

### 1. Struktur Koneksi

Sistem sudah dirancang untuk menggunakan dua mode:
- **Mode RADIUS**: Semua operasi melalui database RADIUS
- **Mode Mikrotik API**: (Legacy) Operasi melalui RouterOS API

**Untuk mode RADIUS 100%**, pastikan:
- Mode autentikasi di-setting ke **"RADIUS"** di menu Setting > RADIUS/Api Setup
- Semua fungsi sudah otomatis menggunakan `getRadiusConnection()` ketika mode RADIUS aktif
- Tidak ada lagi koneksi RouterOS API yang digunakan untuk user management

### 2. File Dokumentasi

Dokumentasi lengkap sudah dibuat:

1. **`docs/MIKROTIK_RADIUS_SETUP.md`**
   - Panduan lengkap konfigurasi Mikrotik untuk mode RADIUS
   - Konfigurasi PPPoE dengan RADIUS
   - Konfigurasi Hotspot dengan RADIUS
   - Troubleshooting

2. **`docs/MIKROTIK_RADIUS_PPPOE_CONFIG.rsc`**
   - Script konfigurasi otomatis untuk PPPoE
   - Siap digunakan, tinggal edit variabel

3. **`docs/MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc`**
   - Script konfigurasi otomatis untuk Hotspot
   - Siap digunakan, tinggal edit variabel

4. **`docs/RADIUS_MODE_MIGRATION.md`**
   - Panduan migrasi dari mode Mikrotik API ke RADIUS
   - Checklist lengkap
   - Troubleshooting

## 🚀 Cara Menggunakan Mode RADIUS 100%

### Step 1: Aktifkan Mode RADIUS di Billing

1. Login ke billing system
2. Buka menu: **Setting > RADIUS/Api Setup** atau `/admin/radius`
3. Pilih **Mode Autentikasi: RADIUS**
4. Isi konfigurasi:
   - **RADIUS Host**: IP address RADIUS server (misal: `localhost`)
   - **RADIUS User**: User database (misal: `billing` atau `radius`)
   - **RADIUS Password**: Password database
   - **RADIUS Database**: Nama database (default: `radius`)
5. Klik **Simpan**
6. Klik **Test Koneksi** untuk memastikan koneksi berhasil

### Step 2: Konfigurasi Mikrotik

#### Untuk PPPoE:

1. Edit file `docs/MIKROTIK_RADIUS_PPPOE_CONFIG.rsc`
2. Sesuaikan variabel:
   - `radiusServerIP`: IP address RADIUS server
   - `radiusSecret`: Secret key (harus sama dengan di FreeRADIUS `clients.conf`)
   - `pppoeInterface`: Interface untuk PPPoE server
   - dll
3. Copy script ke Mikrotik (via Winbox > Files)
4. Jalankan: `/import file-name=MIKROTIK_RADIUS_PPPOE_CONFIG.rsc`

**Atau manual:**
```bash
# Tambahkan RADIUS server
/radius add name="RADIUS-Auth" address=192.168.1.100 secret=testing123 service=ppp authentication-port=1812 accounting-port=1813

# Konfigurasi PPPoE server untuk menggunakan RADIUS
/interface pppoe-server server set [find service-name=pppoe] authentication=radius
```

#### Untuk Hotspot:

1. Edit file `docs/MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc`
2. Sesuaikan variabel sesuai kebutuhan
3. Copy script ke Mikrotik
4. Jalankan: `/import file-name=MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc`

**Atau manual:**
```bash
# Tambahkan RADIUS server untuk Hotspot
/radius add name="RADIUS-Hotspot" address=192.168.1.100 secret=testing123 service=hotspot authentication-port=1812 accounting-port=1813

# Konfigurasi Hotspot server untuk menggunakan RADIUS
/ip hotspot set [find name=hotspot1] authentication=radius
```

### Step 3: Verifikasi

1. **Test Koneksi RADIUS** dari billing system
2. **Test Login User** dengan user yang ada di RADIUS database
3. **Cek Accounting** apakah data accounting masuk ke database RADIUS

## 📝 Catatan Penting

### 1. Mode RADIUS 100% Artinya:

- ✅ Semua user dikelola di database RADIUS (tabel `radcheck`, `radusergroup`)
- ✅ Semua profile dikelola di database RADIUS (tabel `radgroupreply`)
- ✅ Mikrotik hanya sebagai NAS (Network Access Server)
- ✅ Tidak ada lagi koneksi RouterOS API untuk user management
- ✅ Semua operasi billing dilakukan melalui database RADIUS

### 2. Yang Perlu Dikonfigurasi di Mikrotik:

#### Untuk PPPoE:
- RADIUS server (IP, secret, port)
- PPPoE server dengan `authentication=radius`
- Profile fallback (opsional, hanya jika RADIUS tidak mengembalikan profile)
- IP pool lokal dengan **nama sama** seperti Remote Address profile billing (`Framed-Pool`); range/subnet **boleh beda per router**
- `local-address` pada PPP profile se-subnet dengan pool di router tersebut
- IP pool fallback (opsional, hanya jika RADIUS tidak mengembalikan `Framed-Pool` / IP)

#### Untuk Hotspot:
- RADIUS server untuk Hotspot (IP, secret, port)
- Hotspot server dengan `authentication=radius`
- Profile fallback (opsional)
- IP pool untuk Hotspot

### 3. Yang Perlu Dikonfigurasi di FreeRADIUS:

- **clients.conf**: Tambahkan Mikrotik sebagai client
  ```conf
  client mikrotik-router-1 {
      ipaddr = 192.168.1.1
      secret = testing123
      nas_type = other
  }
  ```

- **Database**: Pastikan user, profile, dan attributes sudah dikonfigurasi di database RADIUS

## 🔍 Troubleshooting

### User tidak bisa login

1. Cek user ada di RADIUS database:
   ```bash
   mysql -u radius -p radius -e "SELECT * FROM radcheck WHERE username='USERNAME';"
   ```

2. Cek RADIUS server di Mikrotik:
   ```bash
   /radius print
   ```

3. Cek log RADIUS:
   ```bash
   tail -f /var/log/freeradius/radius.log
   ```

### Profile tidak diterapkan

1. Cek user-group mapping:
   ```bash
   mysql -u radius -p radius -e "SELECT * FROM radusergroup WHERE username='USERNAME';"
   ```

2. Cek profile attributes:
   ```bash
   mysql -u radius -p radius -e "SELECT * FROM radgroupreply WHERE groupname='PROFILE_NAME';"
   ```

### Accounting tidak berjalan

1. Cek accounting port di Mikrotik:
   ```bash
   /radius print detail
   ```

2. Cek log accounting:
   ```bash
   tail -f /var/log/freeradius/radius.log | grep accounting
   ```

## 📚 Dokumentasi Lengkap

Untuk detail lebih lengkap, lihat:

- **Konfigurasi Mikrotik**: `docs/MIKROTIK_RADIUS_SETUP.md`
- **Script Konfigurasi PPPoE**: `docs/MIKROTIK_RADIUS_PPPOE_CONFIG.rsc`
- **Script Konfigurasi Hotspot**: `docs/MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc`
- **Panduan Migrasi**: `docs/RADIUS_MODE_MIGRATION.md`
- **Cara Koneksi RADIUS**: `CARA_KONEK_RADIUS.md`

## ✅ Checklist

- [ ] Mode RADIUS sudah diaktifkan di billing system
- [ ] Koneksi RADIUS sudah ditest dan berhasil
- [ ] Mikrotik sudah dikonfigurasi untuk menggunakan RADIUS (PPPoE)
- [ ] Mikrotik sudah dikonfigurasi untuk menggunakan RADIUS (Hotspot)
- [ ] FreeRADIUS clients.conf sudah dikonfigurasi (Mikrotik sebagai client)
- [ ] User sudah ada di database RADIUS
- [ ] Profile sudah dikonfigurasi di database RADIUS
- [ ] Test login user berhasil
- [ ] Accounting berjalan dengan baik
- [ ] FreeRADIUS sudah di-pin untuk username PPPoE literal `@` (`scripts/lib/freeradius-pin-literal-at.sh` di VPS + setiap POP)

## Username PPPoE mengandung `@`

Banyak pelanggan Kalimasada memakai login seperti `user@site` (aman di secret lokal MikroTik). Di FreeRADIUS 3, `@` default diperlakukan seperti realm/email, sehingga auth bisa `Access-Reject`.

Pin yang aman (global, semua tenant):

```bash
# Di VPS (dan setiap host FreeRADIUS POP / auth):
sudo bash scripts/lib/freeradius-pin-literal-at.sh
```

Apa yang dilakukan pin:

1. Nonaktifkan modul `suffix` (tidak memotong `user@realm`)
2. Pastikan `sql_user_name = "%{User-Name}"` (+ `safe_characters` memuat `@`)
3. Longgarkan `policy.d/filter` → `filter_username` agar tidak menolak `@` tanpa bentuk email (`user@host.tld`)

**Penting:** sync user DB ke POP (`radius-pop-sync-*`) **tidak** menyalin config FreeRADIUS. Setelah pin di VPS, terapkan juga di POP:

```bash
sudo bash scripts/radius-pop-pin-literal-at-remote.sh
# jika sudo POP butuh password, jalankan sekali di POP:
#   sudo bash ~/radius-sync/freeradius-pin-literal-at.sh
```

Installer `install-freeradius-billing.sh` / `install-freeradius-local-pop.sh` memanggil pin ini otomatis (jika file `scripts/lib/freeradius-pin-literal-at.sh` tersedia).

Import Excel: hyperlink `mailto:` pada sel PPPoE (karena `@`) dibaca sebagai teks di app (`unwrapExcelCellValue`) agar tidak jadi `[object Object]`.

---

**Last Updated:** 2026-07-15
**Version:** 1.1

