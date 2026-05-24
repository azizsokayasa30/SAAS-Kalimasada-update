# 📡 Konfigurasi Mikrotik untuk Mode RADIUS 100%

Dokumentasi lengkap untuk mengkonfigurasi Mikrotik agar bekerja dengan billing system dalam mode RADIUS 100%.

## 📋 Daftar Isi

1. [Prerequisites](#prerequisites)
2. [Konfigurasi PPPoE dengan RADIUS](#konfigurasi-pppoe-dengan-radius)
3. [Konfigurasi Hotspot dengan RADIUS](#konfigurasi-hotspot-dengan-radius)
4. [Verifikasi Konfigurasi](#verifikasi-konfigurasi)
5. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Informasi yang Diperlukan

Sebelum memulai, pastikan Anda memiliki:
- **IP Address RADIUS Server**: IP server tempat FreeRADIUS berjalan (misal: `192.168.1.100`)
- **RADIUS Secret**: Secret key untuk autentikasi antara Mikrotik dan RADIUS server (misal: `testing123`)
- **Port RADIUS**: Default `1812` untuk authentication, `1813` untuk accounting

### 2. Akses ke Mikrotik

- Akses ke Mikrotik RouterOS (via Winbox, WebFig, atau Terminal)
- User dengan hak akses `full` atau minimal `read`, `write`, `test`

---

## Konfigurasi PPPoE dengan RADIUS

### Step 1: Tambahkan RADIUS Server

Jalankan command berikut di terminal Mikrotik:

```bash
# Tambahkan RADIUS server untuk authentication
/radius add name="RADIUS-Auth" address=192.168.1.100 secret=testing123 service=ppp authentication-port=1812 accounting-port=1813 timeout=3s

# Atau jika menggunakan multiple RADIUS servers (load balancing)
/radius add name="RADIUS-Auth-1" address=192.168.1.100 secret=testing123 service=ppp authentication-port=1812 accounting-port=1813 timeout=3s
/radius add name="RADIUS-Auth-2" address=192.168.1.101 secret=testing123 service=ppp authentication-port=1812 accounting-port=1813 timeout=3s
```

**Penjelasan Parameter:**
- `name`: Nama untuk RADIUS server (bebas, misal: "RADIUS-Auth")
- `address`: IP address RADIUS server (ganti dengan IP server Anda)
- `secret`: Secret key yang sama dengan yang dikonfigurasi di FreeRADIUS `clients.conf`
- `service=ppp`: Service untuk PPP (PPPoE, PPTP, L2TP)
- `authentication-port`: Port untuk authentication (default: 1812)
- `accounting-port`: Port untuk accounting (default: 1813)
- `timeout`: Waktu tunggu jawaban RADIUS (**maksimal 3s** di RouterOS). Jika habis tanpa jawaban, router mengirim ulang otomatis (statistik `resends` / `timeouts` di `/radius monitor 0`). **Tidak ada** parameter `retry=` di menu `/radius`.

### Step 2: Konfigurasi PPPoE Server

```bash
# Aktifkan PPPoE server pada interface tertentu (misal: ether1)
/interface pppoe-server server add service-name=pppoe interface=ether1 authentication=radius default-profile=default-pppoe one-session-per-host=yes

# Atau jika sudah ada PPPoE server, edit untuk menggunakan RADIUS
/interface pppoe-server server set [find service-name=pppoe] authentication=radius
```

**Penjelasan Parameter:**
- `service-name`: Nama service PPPoE (bebas, misal: "pppoe")
- `interface`: Interface fisik untuk PPPoE server (misal: ether1, bridge-local)
- `authentication=radius`: Gunakan RADIUS untuk autentikasi (BUKAN local)
- `default-profile`: Profile default jika RADIUS tidak mengembalikan profile
- `one-session-per-host=yes`: Hanya satu session per host (mencegah multiple login)

### Step 3: Konfigurasi PPPoE Profile (Opsional - untuk fallback)

Profile di Mikrotik hanya digunakan sebagai fallback jika RADIUS tidak mengembalikan profile. Profile utama harus dikonfigurasi di RADIUS database.

```bash
# Buat profile default (hanya untuk fallback)
/ppp profile add name=default-pppoe local-address=10.0.0.1 remote-address=pppoe-pool rate-limit=10M/10M

# Atau jika sudah ada, edit
/ppp profile set [find name=default-pppoe] local-address=10.0.0.1 remote-address=pppoe-pool rate-limit=10M/10M
```

**Catatan Penting:**
- Profile di Mikrotik hanya digunakan jika RADIUS tidak mengembalikan profile
- Profile utama harus dikonfigurasi di RADIUS database (tabel `radgroupreply`)
- Rate limit, IP pool, dan parameter lain dikontrol oleh RADIUS

### Step 4: Konfigurasi IP Pool (Opsional - untuk fallback)

IP pool di Mikrotik hanya digunakan sebagai fallback jika RADIUS tidak mengembalikan IP.

```bash
# Buat IP pool untuk PPPoE
/ip pool add name=pppoe-pool ranges=10.0.0.2-10.0.0.254

# Atau jika sudah ada, edit
/ip pool set [find name=pppoe-pool] ranges=10.0.0.2-10.0.0.254
```

**Catatan Penting:**
- IP pool di Mikrotik hanya digunakan jika RADIUS tidak mengembalikan IP
- IP address utama dikontrol oleh RADIUS (attribute `Framed-IP-Address` atau `MikroTik-Address-List`)

### Step 5: Verifikasi Konfigurasi PPPoE

```bash
# Cek RADIUS server
/radius print

# Cek PPPoE server
/interface pppoe-server server print

# Cek PPPoE profile
/ppp profile print

# Cek IP pool
/ip pool print

# Test koneksi RADIUS (jika ada user test di RADIUS)
# Login dengan username/password dari RADIUS database
```

---

## Konfigurasi Hotspot dengan RADIUS

### Step 1: Tambahkan RADIUS Server untuk Hotspot

```bash
# Tambahkan RADIUS server untuk Hotspot
/radius add name="RADIUS-Hotspot" address=192.168.1.100 secret=testing123 service=hotspot authentication-port=1812 accounting-port=1813 timeout=3s
```

**Catatan:**
- Bisa menggunakan RADIUS server yang sama dengan PPPoE (dengan `service=hotspot`)
- Atau buat RADIUS server terpisah khusus untuk Hotspot

### Step 2: Konfigurasi Hotspot Server

```bash
# Buat Hotspot server pada interface tertentu (misal: bridge-hotspot)
/ip hotspot add name=hotspot1 interface=bridge-hotspot address-pool=hotspot-pool profile=default-hotspot authentication=radius

# Atau jika sudah ada Hotspot server, edit untuk menggunakan RADIUS
/ip hotspot set [find name=hotspot1] authentication=radius
```

**Penjelasan Parameter:**
- `name`: Nama Hotspot server (bebas, misal: "hotspot1")
- `interface`: Interface untuk Hotspot (misal: bridge-hotspot, wlan1)
- `address-pool`: IP pool untuk Hotspot users
- `profile`: Profile default Hotspot (untuk fallback)
- `authentication=radius`: Gunakan RADIUS untuk autentikasi (BUKAN local)

### Step 3: Konfigurasi Hotspot Profile (Opsional - untuk fallback)

```bash
# Buat profile default Hotspot (hanya untuk fallback)
/ip hotspot user profile add name=default-hotspot rate-limit=5M/5M session-timeout=1h idle-timeout=30m shared-users=1

# Atau jika sudah ada, edit
/ip hotspot user profile set [find name=default-hotspot] rate-limit=5M/5M session-timeout=1h idle-timeout=30m shared-users=1
```

**Catatan Penting:**
- Profile di Mikrotik hanya digunakan sebagai fallback
- Profile utama harus dikonfigurasi di RADIUS database (tabel `radgroupreply`)
- Rate limit, session timeout, dan parameter lain dikontrol oleh RADIUS

### Step 4: Konfigurasi IP Pool untuk Hotspot

```bash
# Buat IP pool untuk Hotspot
/ip pool add name=hotspot-pool ranges=192.168.10.2-192.168.10.254

# Atau jika sudah ada, edit
/ip pool set [find name=hotspot-pool] ranges=192.168.10.2-192.168.10.254
```

### Step 5: Konfigurasi Hotspot Server Profile (RouterOS v6.49+)

Jika menggunakan RouterOS v6.49 atau lebih baru, Anda bisa menggunakan Server Profile:

```bash
# Buat Server Profile untuk Hotspot
/ip hotspot profile add name=hotspot-server-profile open-status-page=http-login

# Assign Server Profile ke Hotspot Server
/ip hotspot set [find name=hotspot1] profile=hotspot-server-profile
```

### Step 6: Verifikasi Konfigurasi Hotspot

```bash
# Cek RADIUS server
/radius print

# Cek Hotspot server
/ip hotspot print

# Cek Hotspot profile
/ip hotspot user profile print

# Cek IP pool
/ip pool print

# Test koneksi Hotspot (jika ada user test di RADIUS)
# Login dengan username/password dari RADIUS database
```

---

## Verifikasi Konfigurasi

### 1. Cek Status RADIUS Server

```bash
# Cek semua RADIUS server
/radius print

# Cek detail RADIUS server tertentu
/radius print detail where name="RADIUS-Auth"
```

**Output yang diharapkan:**
```
Flags: X - disabled
 0   name="RADIUS-Auth" address=192.168.1.100 secret="testing123" 
     service=ppp authentication-port=1812 accounting-port=1813 
     timeout=3s
```

### 2. Test Koneksi RADIUS

```bash
# Test authentication (jika ada user test di RADIUS)
# Login dengan username/password dari RADIUS database via PPPoE atau Hotspot
```

### 3. Monitor Log RADIUS

```bash
# Cek log RADIUS di Mikrotik
/log print where topics~"radius"

# Atau cek log di RADIUS server
# tail -f /var/log/freeradius/radius.log
```

### 4. Cek Active Connections

```bash
# Cek active PPPoE connections
/ppp active print

# Cek active Hotspot connections
/ip hotspot active print
```

---

## Troubleshooting

### Problem 1: User tidak bisa login (Authentication Failed)

**Kemungkinan Penyebab:**
1. RADIUS server tidak dapat diakses dari Mikrotik
2. Secret key tidak cocok antara Mikrotik dan RADIUS server
3. User tidak ada di RADIUS database
4. Port 1812/1813 terblokir firewall

**Solusi:**
```bash
# 1. Test koneksi ke RADIUS server
/ping 192.168.1.100

# 2. Cek RADIUS server configuration
/radius print detail

# 3. Cek log RADIUS di Mikrotik
/log print where topics~"radius"

# 4. Pastikan secret key sama dengan di FreeRADIUS clients.conf
# 5. Pastikan user ada di RADIUS database (tabel radcheck)
# 6. Pastikan firewall tidak block port 1812/1813
```

### Problem 2: User bisa login tapi tidak dapat akses internet

**Kemungkinan Penyebab:**
1. Profile tidak dikembalikan oleh RADIUS
2. IP address tidak dikembalikan oleh RADIUS
3. Route tidak dikonfigurasi dengan benar
4. NAT tidak dikonfigurasi

**Solusi:**
```bash
# 1. Cek profile yang digunakan user
/ppp active print detail

# 2. Cek IP address yang diberikan
/ppp active print

# 3. Pastikan RADIUS mengembalikan attribute:
#    - MikroTik-Rate-Limit (untuk rate limit)
#    - Framed-IP-Address (untuk IP address)
#    - Session-Timeout (untuk session timeout)

# 4. Cek route
/ip route print

# 5. Cek NAT
/ip firewall nat print
```

### Problem 3: Accounting tidak berjalan

**Kemungkinan Penyebab:**
1. Port 1813 terblokir
2. Accounting tidak dikonfigurasi di RADIUS server
3. RADIUS server tidak menerima accounting request

**Solusi:**
```bash
# 1. Cek log accounting di Mikrotik
/log print where topics~"radius" and message~"accounting"

# 2. Pastikan accounting-port benar (1813)
/radius print detail

# 3. Cek di RADIUS server apakah accounting request diterima
# tail -f /var/log/freeradius/radius.log | grep accounting
```

### Problem 4: Rate limit tidak bekerja

**Kemungkinan Penyebab:**
1. RADIUS tidak mengembalikan attribute `MikroTik-Rate-Limit`
2. Format rate limit salah di RADIUS
3. Profile fallback tidak memiliki rate limit

**Solusi:**
```bash
# 1. Cek attribute yang dikembalikan RADIUS
# Lihat di log RADIUS server atau cek di database radgroupreply

# 2. Pastikan format rate limit benar:
# Format: "10M/10M" (download/upload)
# Atau dengan burst: "10M/10M:20M/20M" (rate:burst)

# 3. Cek profile fallback
/ppp profile print detail
/ip hotspot user profile print detail
```

---

## Script Konfigurasi Lengkap

Untuk memudahkan, gunakan script konfigurasi yang tersedia di file:
- `MIKROTIK_RADIUS_PPPOE_CONFIG.rsc` - Konfigurasi untuk PPPoE
- `MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc` - Konfigurasi untuk Hotspot

Cara menggunakan:
1. Edit file `.rsc` dan sesuaikan IP address, secret, dan parameter lainnya
2. Copy script ke Mikrotik (via Winbox > Files, atau via terminal)
3. Jalankan: `/import file-name=MIKROTIK_RADIUS_PPPOE_CONFIG.rsc`

---

## Catatan Penting

1. **Mode RADIUS 100%**: Semua user, profile, dan konfigurasi dikelola di RADIUS database, BUKAN di Mikrotik
2. **Mikrotik sebagai NAS**: Mikrotik hanya berfungsi sebagai Network Access Server yang meneruskan request ke RADIUS
3. **Profile Fallback**: Profile di Mikrotik hanya digunakan jika RADIUS tidak mengembalikan profile
4. **IP Pool Fallback**: IP pool di Mikrotik hanya digunakan jika RADIUS tidak mengembalikan IP
5. **Secret Key**: Pastikan secret key di Mikrotik sama dengan yang dikonfigurasi di FreeRADIUS `clients.conf`
6. **Firewall**: Pastikan firewall tidak memblokir port 1812 (authentication) dan 1813 (accounting)

---

**Last Updated:** 2024-12-19
**Version:** 1.0

