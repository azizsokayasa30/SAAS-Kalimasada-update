# ============================================
# Konfigurasi Mikrotik untuk PPPoE dengan RADIUS
# ============================================
# 
# INSTRUKSI:
# 1. Edit bagian VARIABEL di bawah sesuai dengan konfigurasi Anda
# 2. Copy script ini ke Mikrotik (via Winbox > Files, atau via terminal)
# 3. Jalankan: /import file-name=MIKROTIK_RADIUS_PPPOE_CONFIG.rsc
#
# ============================================

# ============================================
# VARIABEL - EDIT SESUAI KONFIGURASI ANDA
# ============================================

# IP Address RADIUS Server
:local radiusServerIP "192.168.1.100"

# RADIUS Secret Key (harus sama dengan di FreeRADIUS clients.conf)
:local radiusSecret "testing123"

# Interface untuk PPPoE Server (misal: ether1, bridge-local)
:local pppoeInterface "ether1"

# Service Name untuk PPPoE
:local pppoeServiceName "pppoe"

# IP Pool untuk PPPoE (fallback jika RADIUS tidak mengembalikan IP)
:local pppoePoolName "pppoe-pool"
:local pppoePoolRange "10.0.0.2-10.0.0.254"

# Local IP untuk PPPoE Server (fallback)
:local pppoeLocalIP "10.0.0.1"

# Profile Default untuk PPPoE (fallback jika RADIUS tidak mengembalikan profile)
:local pppoeDefaultProfile "default-pppoe"
:local pppoeDefaultRateLimit "10M/10M"

# ============================================
# KONFIGURASI RADIUS SERVER
# ============================================

# Hapus RADIUS server lama jika ada (opsional)
/radius remove [find name="RADIUS-Auth"]

# Tambahkan RADIUS server untuk PPPoE
# RouterOS: timeout maks 3s; tidak ada parameter retry= (resend otomatis via timeout).
/radius add name="RADIUS-Auth" address=$radiusServerIP secret=$radiusSecret service=ppp authentication-port=1812 accounting-port=1813 timeout=3s

# ============================================
# KONFIGURASI IP POOL (FALLBACK)
# ============================================

# Hapus IP pool lama jika ada (opsional)
/ip pool remove [find name=$pppoePoolName]

# Buat IP pool untuk PPPoE
/ip pool add name=$pppoePoolName ranges=$pppoePoolRange

# ============================================
# KONFIGURASI PPPoE PROFILE (FALLBACK)
# ============================================

# Hapus profile lama jika ada (opsional)
/ppp profile remove [find name=$pppoeDefaultProfile]

# Buat profile default untuk PPPoE (hanya untuk fallback)
/ppp profile add name=$pppoeDefaultProfile local-address=$pppoeLocalIP remote-address=$pppoePoolName rate-limit=$pppoeDefaultRateLimit

# ============================================
# KONFIGURASI PPPoE SERVER
# ============================================

# Hapus PPPoE server lama jika ada (opsional)
/interface pppoe-server server remove [find service-name=$pppoeServiceName]

# Buat PPPoE server dengan autentikasi RADIUS
/interface pppoe-server server add service-name=$pppoeServiceName interface=$pppoeInterface authentication=radius default-profile=$pppoeDefaultProfile one-session-per-host=yes

# ============================================
# VERIFIKASI
# ============================================

# Tampilkan konfigurasi RADIUS
:put "============================================"
:put "Konfigurasi RADIUS Server:"
:put "============================================"
/radius print

# Tampilkan konfigurasi PPPoE Server
:put "============================================"
:put "Konfigurasi PPPoE Server:"
:put "============================================"
/interface pppoe-server server print

# Tampilkan konfigurasi PPPoE Profile
:put "============================================"
:put "Konfigurasi PPPoE Profile:"
:put "============================================"
/ppp profile print

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
:put "============================================"

