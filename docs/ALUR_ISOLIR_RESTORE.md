# Alur Isolir dan Restore Pelanggan

## Proses Isolir (Suspend)

1. **Pelanggan diisolir** (manual atau otomatis)
2. **Sistem membaca group/profil saat ini** dari `radusergroup`:
   - Jika ada group (selain 'isolir'), simpan sebagai previous group
   - Jika tidak ada group, cari di billing database untuk mendapatkan package/profil yang seharusnya digunakan
3. **Simpan previous group** di `radcheck` dengan format:
   - Attribute: `NT-Password`
   - Value: `PREVGROUP:{groupname}`
   - Contoh: `PREVGROUP:sample-profil-pppoe`
4. **Hapus semua group assignment** dari `radusergroup`
5. **Tambahkan group 'isolir'** ke `radusergroup`
6. **Disconnect PPPoE session** (jika ada) agar user reconnect dengan profil isolir

## Proses Restore

1. **Pelanggan direstore** (manual atau otomatis setelah bayar)
2. **Baca previous group** dari `radcheck`:
   - Query: `SELECT value FROM radcheck WHERE username = ? AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%'`
   - Extract group name dari format `PREVGROUP:{groupname}`
3. **Jika tidak ada previous group** di `radcheck`:
   - Cari customer di billing database berdasarkan `pppoe_username` atau `username`
   - Ambil profil dari:
     - Prioritas 1: `customer.pppoe_profile`
     - Prioritas 2: `package.pppoe_profile`
     - Prioritas 3: `package.name` (dikonversi ke lowercase dengan dash)
     - Prioritas 4: `package.name` (langsung)
     - Fallback: `'default'`
4. **Hapus semua group assignment** dari `radusergroup` (termasuk 'isolir')
5. **Tambahkan previous group** ke `radusergroup`
6. **Hapus record previous group** dari `radcheck`
7. **Disconnect PPPoE session di Mikrotik** (jika ada) **setelah** group/profil aktif — agar reconnect langsung dapat IP paket normal (jangan disconnect dulu saat masih isolir)

## Catatan Penting

- **Previous group HARUS selalu disimpan** saat suspend, bahkan jika user tidak ada di billing database
- **Jika user tidak ada di billing**, previous group akan menjadi 'default' (ini normal untuk user yang tidak terdaftar di billing)
- **Restore:** ubah group/profil aktif **dulu**, sync SQLite → MySQL FreeRADIUS, lalu kick sesi PPPoE di **semua** router NAS
- **Isolir:** pindah ke group/profil isolir **dulu**, sync MySQL, lalu kick sesi di semua router
- Halaman `/admin/mikrotik` membaca SQLite; FreeRADIUS memakai MySQL — tanpa sync, profil di UI bisa sudah 10mbps tetapi auth masih isolir
- **Format previous group**: `PREVGROUP:{groupname}` di `radcheck` dengan attribute `NT-Password`

## Troubleshooting

Jika restore selalu kembali ke 'default':

1. Cek apakah previous group tersimpan di `radcheck`:
   ```sql
   SELECT * FROM radcheck WHERE username = 'username' AND attribute = 'NT-Password' AND value LIKE 'PREVGROUP:%';
   ```

2. Cek apakah customer ada di billing database:
   ```sql
   SELECT c.*, p.name as package_name, p.pppoe_profile 
   FROM customers c 
   LEFT JOIN packages p ON c.package_id = p.id 
   WHERE c.pppoe_username = 'username' OR c.username = 'username';
   ```

3. Cek group saat ini di `radusergroup`:
   ```sql
   SELECT * FROM radusergroup WHERE username = 'username';
   ```

4. Jalankan script debug:
   ```bash
   node scripts/debug-restore-user.js username
   ```

