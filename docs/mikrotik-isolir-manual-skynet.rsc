# ========================================
# BILLING ISOLIR WALLED GARDEN — MANUAL
# Tenant: Skynet (tenant_id=2)
# Server portal (IP publik server): 103.132.40.78
# Port halaman isolir: 8899
# Port DNS sinkhole: 5353
# Range PPPoE isolir: 192.168.200.0/24
# ========================================
# Target:
# 1) Internet pelanggan isolir DROP
# 2) Akses ke server billing BYPASS (allow)
# 3) Notif / halaman isolir otomatis saat WiFi connect
#
# Cara pakai:
# - Paste di Terminal Winbox/SSH MikroTik NAS PPPoE Skynet
# - Atau: /import file-name=mikrotik-isolir-manual-skynet.rsc
# - Pastikan router masih online IP publik server ke 103.132.40.78
# - Pelanggan tes harus punya IP 192.168.200.x (pool isolir) + reconnect
# ========================================

# --- 1) CLEANUP rule lama ---
/ip firewall filter remove [find where comment~"BILLING-ISOLIR"]
/ip firewall nat remove [find where comment~"BILLING-ISOLIR"]
/ip firewall address-list remove [find where comment~"BILLING-ISOLIR"]
/ip dns static remove [find where comment~"BILLING-ISOLIR"]
/ip firewall filter remove [find where comment~"Generate BILLING - Isolir"]
/ip firewall filter remove [find where comment~"isolir-allow"]
/ip firewall filter remove [find where comment~"isolir-block"]
/ip firewall nat remove [find where comment~"Generate BILLING - Isolir"]
/ip firewall nat remove [find where comment~"isolir-redirect"]
/ip firewall filter remove [find where comment="Block suspended customers (static IP)"]
/ip firewall filter remove [find where comment="Block suspended customers from accessing router (static IP)"]

/ip dns set allow-remote-requests=yes

# --- 2) Address list ---
/ip firewall address-list add list=isolir-users address=192.168.200.0/24 comment="BILLING-ISOLIR users range"
/ip firewall address-list add list=isolir-allowed-dst address=103.132.40.78 comment="BILLING-ISOLIR billing server"

# WhatsApp / Facebook (bukti bayar)
/ip firewall address-list add list=isolir-allowed-dst address=wa.me comment="BILLING-ISOLIR whatsapp wa.me"
/ip firewall address-list add list=isolir-allowed-dst address=whatsapp.com comment="BILLING-ISOLIR whatsapp whatsapp.com"
/ip firewall address-list add list=isolir-allowed-dst address=web.whatsapp.com comment="BILLING-ISOLIR whatsapp web.whatsapp.com"
/ip firewall address-list add list=isolir-allowed-dst address=api.whatsapp.com comment="BILLING-ISOLIR whatsapp api.whatsapp.com"
/ip firewall address-list add list=isolir-allowed-dst address=static.whatsapp.net comment="BILLING-ISOLIR whatsapp static.whatsapp.net"
/ip firewall address-list add list=isolir-allowed-dst address=whatsapp.net comment="BILLING-ISOLIR whatsapp whatsapp.net"
/ip firewall address-list add list=isolir-allowed-dst address=mmg.whatsapp.net comment="BILLING-ISOLIR whatsapp mmg.whatsapp.net"
/ip firewall address-list add list=isolir-allowed-dst address=media.whatsapp.net comment="BILLING-ISOLIR whatsapp media.whatsapp.net"
/ip firewall address-list add list=isolir-allowed-dst address=facebook.com comment="BILLING-ISOLIR whatsapp facebook.com"
/ip firewall address-list add list=isolir-allowed-dst address=fbcdn.net comment="BILLING-ISOLIR whatsapp fbcdn.net"
/ip firewall address-list add list=isolir-allowed-dst address=fbsbx.com comment="BILLING-ISOLIR whatsapp fbsbx.com"

# --- 3) Pool + PPP profile isolir ---
/ip pool remove [find where name="isolir-pool"]
/ip pool add name="isolir-pool" ranges=192.168.200.2-192.168.200.254 comment="BILLING-ISOLIR pool"

/ppp profile remove [find where name="isolir"]
/ppp profile add name="isolir" local-address=192.168.200.1 remote-address=isolir-pool dns-server=192.168.200.1 only-one=yes use-ipv6=no comment="BILLING-ISOLIR profile"

# --- 4) DNS static captive (bantu notif HP) ---
# Semua probe OS diarahkan ke IP portal billing lewat tunnel
/ip dns static add name=captive.apple.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive captive.apple.com"
/ip dns static add name=www.apple.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive www.apple.com"
/ip dns static add name=connectivitycheck.gstatic.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive connectivitycheck.gstatic.com"
/ip dns static add name=clients3.google.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive clients3.google.com"
/ip dns static add name=www.msftconnecttest.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive www.msftconnecttest.com"
/ip dns static add name=dns.msftncsi.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive dns.msftncsi.com"
/ip dns static add name=detectportal.firefox.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive detectportal.firefox.com"
/ip dns static add name=neverssl.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive neverssl.com"
/ip dns static add name=example.com address=103.132.40.78 ttl=30s comment="BILLING-ISOLIR captive example.com"

# --- 5) FILTER forward (urutan penting: drop dulu, lalu allow di ATAS-nya) ---
:local f [/ip firewall filter find where chain=forward]
:local t
:if ([:len $f] > 0) do={ :set t [:pick $f 0] }

:if ([:len $t] > 0) do={
    /ip firewall filter add chain=forward src-address=192.168.200.0/24 action=drop comment="BILLING-ISOLIR drop other" place-before=$t
} else={
    /ip firewall filter add chain=forward src-address=192.168.200.0/24 action=drop comment="BILLING-ISOLIR drop other"
}

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 protocol=tcp dst-port=853 action=reject reject-with=tcp-reset comment="BILLING-ISOLIR reject dot tcp" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 protocol=udp dst-port=853 action=drop comment="BILLING-ISOLIR drop dot udp" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 protocol=tcp dst-port=443 action=reject reject-with=tcp-reset comment="BILLING-ISOLIR reject https" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 dst-address-list=isolir-allowed-dst protocol=tcp dst-port=80,443,5222,5223,5228,4244 action=accept comment="BILLING-ISOLIR allow whatsapp" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 dst-address=103.132.40.78 protocol=tcp dst-port=8899,3003,4555,80,443,53 action=accept comment="BILLING-ISOLIR allow billing" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 dst-address=103.132.40.78 protocol=udp dst-port=53,5353 action=accept comment="BILLING-ISOLIR allow billing dns" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 protocol=tcp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns tcp fwd" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 protocol=udp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns udp fwd" place-before=$t

:set f [/ip firewall filter find where chain=forward]
:set t [:pick $f 0]
/ip firewall filter add chain=forward src-address=192.168.200.0/24 connection-state=established,related action=accept comment="BILLING-ISOLIR allow established" place-before=$t

# --- 6) FILTER input (DNS ke router OK, akses lain drop) ---
:local fi [/ip firewall filter find where chain=input]
:local ti
:if ([:len $fi] > 0) do={ :set ti [:pick $fi 0] }

:if ([:len $ti] > 0) do={
    /ip firewall filter add chain=input src-address=192.168.200.0/24 action=drop comment="BILLING-ISOLIR drop input" place-before=$ti
} else={
    /ip firewall filter add chain=input src-address=192.168.200.0/24 action=drop comment="BILLING-ISOLIR drop input"
}

:set fi [/ip firewall filter find where chain=input]
:set ti [:pick $fi 0]
/ip firewall filter add chain=input src-address=192.168.200.0/24 protocol=tcp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns tcp in" place-before=$ti

:set fi [/ip firewall filter find where chain=input]
:set ti [:pick $fi 0]
/ip firewall filter add chain=input src-address=192.168.200.0/24 protocol=udp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns udp in" place-before=$ti

# --- 7) NAT ---
# Masquerade ke server billing lewat tunnel
:local n [/ip firewall nat find where chain=srcnat]
:local nt
:if ([:len $n] > 0) do={ :set nt [:pick $n 0] }
:if ([:len $nt] > 0) do={
    /ip firewall nat add chain=srcnat src-address=192.168.200.0/24 dst-address=103.132.40.78 action=masquerade comment="BILLING-ISOLIR masquerade billing" place-before=$nt
} else={
    /ip firewall nat add chain=srcnat src-address=192.168.200.0/24 dst-address=103.132.40.78 action=masquerade comment="BILLING-ISOLIR masquerade billing"
}

# Bypass HTTPS/WA (JANGAN port 80 — biar HTTP captive tetap di-redirect)
:set n [/ip firewall nat find where chain=dstnat]
:if ([:len $n] > 0) do={ :set nt [:pick $n 0] } else={ :set nt "" }
:if ([:len $nt] > 0) do={
    /ip firewall nat add chain=dstnat src-address=192.168.200.0/24 dst-address-list=isolir-allowed-dst protocol=tcp dst-port=443,5222,5223,5228,4244 action=accept comment="BILLING-ISOLIR bypass allowed dst" place-before=$nt
} else={
    /ip firewall nat add chain=dstnat src-address=192.168.200.0/24 dst-address-list=isolir-allowed-dst protocol=tcp dst-port=443,5222,5223,5228,4244 action=accept comment="BILLING-ISOLIR bypass allowed dst"
}

# Redirect HTTP → portal isolir :8899 (ini yang memunculkan halaman + bantu notif)
:set n [/ip firewall nat find where chain=dstnat]
:set nt [:pick $n 0]
/ip firewall nat add chain=dstnat src-address=192.168.200.0/24 protocol=tcp dst-port=80,8080,8000,8888 action=dst-nat to-addresses=103.132.40.78 to-ports=8899 comment="BILLING-ISOLIR redirect http isolir" place-before=$nt

# Paksa DNS klien isolir ke sinkhole di server billing (udp/tcp 5353)
:set n [/ip firewall nat find where chain=dstnat]
:set nt [:pick $n 0]
/ip firewall nat add chain=dstnat src-address=192.168.200.0/24 protocol=tcp dst-port=53 action=dst-nat to-addresses=103.132.40.78 to-ports=5353 comment="BILLING-ISOLIR force dns tcp" place-before=$nt

:set n [/ip firewall nat find where chain=dstnat]
:set nt [:pick $n 0]
/ip firewall nat add chain=dstnat src-address=192.168.200.0/24 protocol=udp dst-port=53 action=dst-nat to-addresses=103.132.40.78 to-ports=5353 comment="BILLING-ISOLIR force dns udp" place-before=$nt

# --- 8) Verifikasi ---
:put "=== BILLING ISOLIR READY ==="
:put "Portal: http://103.132.40.78:8899/isolir?tenant=2"
:put "Tes dari HP isolir: http://neverssl.com  (bukan HTTPS)"
:put "Cek pool: /ip pool print where name=isolir-pool"
:put "Cek NAT : /ip firewall nat print where comment~\"BILLING-ISOLIR\""
:put "Cek filter: /ip firewall filter print where comment~\"BILLING-ISOLIR\""
:put "Cek ping server: /ping 103.132.40.78 count=3"
