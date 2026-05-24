# ============================================
# Konfigurasi Mikrotik untuk Hotspot dengan RADIUS
# ============================================
# 
# INSTRUKSI:
# 1. Edit bagian VARIABEL di bawah sesuai dengan konfigurasi Anda
# 2. Copy script ini ke Mikrotik (via Winbox > Files, atau via terminal)
# 3. Jalankan: /import file-name=MIKROTIK_RADIUS_HOTSPOT_CONFIG.rsc
#
# ============================================

# ============================================
# VARIABEL - EDIT SESUAI KONFIGURASI ANDA
# ============================================

# IP Address RADIUS Server
:local radiusServerIP "192.168.1.100"

# RADIUS Secret Key (harus sama dengan di FreeRADIUS clients.conf)
:local radiusSecret "testing123"

# Interface untuk Hotspot Server (misal: bridge-hotspot, wlan1)
:local hotspotInterface "bridge-hotspot"

# Nama Hotspot Server
:local hotspotName "hotspot1"

# IP Pool untuk Hotspot
:local hotspotPoolName "hotspot-pool"
:local hotspotPoolRange "192.168.10.2-192.168.10.254"

# Profile Default untuk Hotspot (fallback)
:local hotspotDefaultProfile "default-hotspot"
:local hotspotDefaultRateLimit "5M/5M"
:local hotspotDefaultSessionTimeout "1h"
:local hotspotDefaultIdleTimeout "30m"
:local hotspotDefaultSharedUsers "1"

# Server Profile untuk Hotspot (RouterOS v6.49+)
:local hotspotServerProfileName "hotspot-server-profile"

# ============================================
# KONFIGURASI RADIUS SERVER
# ============================================

# Hapus RADIUS server lama jika ada (opsional)
/radius remove [find name="RADIUS-Hotspot"]

# Tambahkan RADIUS server untuk Hotspot
# RouterOS: timeout maks 3s; tidak ada parameter retry=
/radius add name="RADIUS-Hotspot" address=$radiusServerIP secret=$radiusSecret service=hotspot authentication-port=1812 accounting-port=1813 timeout=3s

# ============================================
# KONFIGURASI IP POOL
# ============================================

# Hapus IP pool lama jika ada (opsional)
/ip pool remove [find name=$hotspotPoolName]

# Buat IP pool untuk Hotspot
/ip pool add name=$hotspotPoolName ranges=$hotspotPoolRange

# ============================================
# KONFIGURASI HOTSPOT PROFILE (FALLBACK)
# ============================================

# Hapus profile lama jika ada (opsional)
/ip hotspot user profile remove [find name=$hotspotDefaultProfile]

# Buat profile default untuk Hotspot (hanya untuk fallback)
/ip hotspot user profile add name=$hotspotDefaultProfile rate-limit=$hotspotDefaultRateLimit session-timeout=$hotspotDefaultSessionTimeout idle-timeout=$hotspotDefaultIdleTimeout shared-users=$hotspotDefaultSharedUsers

# ============================================
# KONFIGURASI HOTSPOT SERVER PROFILE (RouterOS v6.49+)
# ============================================

# Hapus server profile lama jika ada (opsional)
/ip hotspot profile remove [find name=$hotspotServerProfileName]

# Buat Server Profile untuk Hotspot
/ip hotspot profile add name=$hotspotServerProfileName open-status-page=http-login

# ============================================
# KONFIGURASI HOTSPOT SERVER
# ============================================

# Hapus Hotspot server lama jika ada (opsional)
/ip hotspot remove [find name=$hotspotName]

# Buat Hotspot server dengan autentikasi RADIUS
/ip hotspot add name=$hotspotName interface=$hotspotInterface address-pool=$hotspotPoolName profile=$hotspotDefaultProfile authentication=radius

# Assign Server Profile ke Hotspot Server (RouterOS v6.49+)
/ip hotspot set [find name=$hotspotName] profile=$hotspotServerProfileName

# ============================================
# KONFIGURASI DNS (OPSIONAL)
# ============================================

# Set DNS server untuk Hotspot users (opsional)
# /ip hotspot set [find name=$hotspotName] dns-name=""

# ============================================
# VERIFIKASI
# ============================================

# Tampilkan konfigurasi RADIUS
:put "============================================"
:put "Konfigurasi RADIUS Server:"
:put "============================================"
/radius print

# Tampilkan konfigurasi Hotspot Server
:put "============================================"
:put "Konfigurasi Hotspot Server:"
:put "============================================"
/ip hotspot print

# Tampilkan konfigurasi Hotspot Profile
:put "============================================"
:put "Konfigurasi Hotspot Profile:"
:put "============================================"
/ip hotspot user profile print

# Tampilkan konfigurasi Hotspot Server Profile
:put "============================================"
:put "Konfigurasi Hotspot Server Profile:"
:put "============================================"
/ip hotspot profile print

# Tampilkan konfigurasi IP Pool
:put "============================================"
:put "Konfigurasi IP Pool:"
:put "============================================"
/ip pool print

:put "============================================"
:put "Konfigurasi selesai!"
:put "============================================"
:put "Pastikan:"
:put "1. IP RADIUS Server: $radiusServerIP"
:put "2. Secret Key sama dengan di FreeRADIUS clients.conf"
:put "3. User sudah ada di RADIUS database"
:put "4. Firewall tidak memblokir port 1812 dan 1813"
:put "5. Interface $hotspotInterface sudah dikonfigurasi dengan benar"
:put "============================================"

