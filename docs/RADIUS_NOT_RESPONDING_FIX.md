# 🔧 Fix: "RADIUS server is not responding"

## 📋 Masalah
Error: `login failed: RADIUS server is not responding` muncul di Mikrotik ketika client hotspot mencoba login.

## 🔍 Root Cause
Mikrotik tidak bisa berkomunikasi dengan FreeRADIUS server karena:
1. Konfigurasi RADIUS di Mikrotik tidak benar
2. Secret tidak match antara Mikrotik dan FreeRADIUS
3. IP RADIUS server yang dikonfigurasi di Mikrotik salah
4. Hotspot server tidak menggunakan RADIUS

## ✅ Solusi

### Step 1: Cek Konfigurasi FreeRADIUS

**RADIUS Server Info:**
- **IP Server**: `10.201.39.66`
- **Secret**: `testing123`
- **Port Auth**: `1812`
- **Port Accounting**: `1813`

**Mikrotik yang terdaftar:**
- IP: `10.201.39.18` ✅ (sudah terdaftar di `/etc/freeradius/3.0/clients.conf`)

### Step 2: Konfigurasi RADIUS di Mikrotik

#### Via Winbox/WebFig:

1. **Buka menu Radius** → Klik **+** untuk tambah server baru
2. **Isi form:**
   - **Name**: `freeradius-server` (atau nama lain)
   - **Service**: `hotspot` (untuk hotspot, bukan `login`)
   - **Address**: `10.201.39.66` (IP FreeRADIUS server)
   - **Secret**: `testing123` (harus sama dengan di FreeRADIUS)
   - **Timeout**: `3s` (default) atau `5s` (jika masih timeout)
   - **Accounting Port**: `1813`
   - **Authentication Port**: `1812`

3. **Buka menu IP → Hotspot → Servers**
4. **Edit server hotspot** yang sedang digunakan
5. **Di tab Authentication:**
   - **Use RADIUS**: ✅ **Enable** (centang)
   - **RADIUS Server**: Pilih `freeradius-server` yang sudah dibuat

#### Via Terminal (CLI):

```bash
# Tambah RADIUS server untuk hotspot
/radius
add name=freeradius-server address=10.201.39.66 secret=testing123 service=hotspot timeout=5s

# Edit Hotspot Server untuk menggunakan RADIUS
/ip hotspot
set [find name="hotspot1"] use-radius=yes radius-server=freeradius-server
```

**Catatan Penting:**
- Untuk **Hotspot**, gunakan `service=hotspot`
- Untuk **PPPoE**, gunakan `service=login`
- **Secret harus sama** dengan yang di FreeRADIUS (`testing123`)

### Step 3: Verifikasi Konfigurasi

#### Test dari Mikrotik:

```bash
# Test RADIUS connection dengan user voucher
/radius test freeradius-server user=wifi-SCEM password=<password_voucher>

# Harus muncul: "Access-Accept" jika user ada dan password benar
```

#### Test dari FreeRADIUS Server:

```bash
# Test langsung dari server
radtest wifi-SCEM <password> 10.201.39.18 0 testing123

# Atau test dari localhost
radtest wifi-SCEM <password> 127.0.0.1 0 testing123
```

### Step 4: Cek Log FreeRADIUS

```bash
# Monitor log real-time
sudo tail -f /var/log/freeradius/radius.log.1

# Atau cek log terakhir
sudo journalctl -u freeradius -n 50 --no-pager
```

### Step 5: Troubleshooting Checklist

Jika masih error, cek:

- [ ] **IP RADIUS server di Mikrotik benar** (`10.201.39.66`)
- [ ] **Secret sama** antara Mikrotik (`testing123`) dan FreeRADIUS (`testing123`)
- [ ] **Service di Mikrotik** adalah `hotspot` (bukan `login`)
- [ ] **Hotspot server menggunakan RADIUS** (`use-radius=yes`)
- [ ] **FreeRADIUS masih berjalan** (`systemctl status freeradius`)
- [ ] **Port 1812/1813 tidak diblokir** firewall
- [ ] **User voucher ada di database** (`SELECT * FROM radcheck WHERE username='wifi-SCEM';`)
- [ ] **User memiliki profile** (`SELECT * FROM radusergroup WHERE username='wifi-SCEM';`)

## 🔥 Quick Fix Commands

Untuk Mikrotik dengan IP `10.201.39.18` yang menghubungi RADIUS server `10.201.39.66`:

```bash
# 1. Hapus konfigurasi RADIUS lama (jika ada)
/radius remove [find name~"radius"]

# 2. Tambah RADIUS server baru untuk hotspot
/radius
add name=freeradius-server address=10.201.39.66 secret=testing123 service=hotspot timeout=5s

# 3. Enable RADIUS di semua hotspot server
/ip hotspot
set [find] use-radius=yes radius-server=freeradius-server

# 4. Test connection
/radius test freeradius-server user=wifi-SCEM password=<password>
```

## 📝 Catatan Penting

1. **Service yang berbeda:**
   - Hotspot → `service=hotspot`
   - PPPoE → `service=login`

2. **Secret harus sama:**
   - Secret di Mikrotik HARUS sama dengan secret di `/etc/freeradius/3.0/clients.conf`

3. **Multiple Hotspot Servers:**
   - Jika ada beberapa hotspot server, setiap server harus dikonfigurasi untuk menggunakan RADIUS

4. **Timeout:**
   - Di Mikrotik set timeout maksimal yang diizinkan RouterOS: `timeout=3s` (bukan 10s — RouterOS membatasi hingga 3 detik). Optimasi server FreeRADIUS wajib agar jawaban < 3s.

## 🐛 Error Messages

### "No response from RADIUS server"
- **Solusi**: Cek IP RADIUS server benar, secret match, dan FreeRADIUS berjalan

### "Access-Reject"
- **Solusi**: Cek user ada di database, password benar, dan profile sudah di-assign

### "Timeout"
- **Solusi**: Increase timeout di Mikrotik atau cek network latency

---

**Last Updated**: 2025-11-05
