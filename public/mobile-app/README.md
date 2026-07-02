# Pembaruan aplikasi Flutter (Kalimasada Mobile)

Aplikasi memeriksa `GET {API_URL}/api/mobile-adapter/app-update/manifest` (tanpa JWT). Respons memakai `data.version`, `data.build_number`, `data.apk_url`, `data.release_notes`.

## Build dari panel admin (disarankan)

1. Pasang Flutter SDK di `public/mobile-app/flutter-sdk/` (lihat `FLUTTER-SDK-INSTALL.md`).
2. Buka **Admin → Settingan → Tool Android**, sesuaikan `.env`, versi, nama app.
3. Klik **Build APK Release** — APK dan `manifest.json` di folder ini diperbarui otomatis untuk OTA.

## Cara deploy manual setelah `git pull`

1. **Bangun APK** (di mesin dev, dari folder `billing_kalimasada_mobile`):

   ```bash
   flutter build apk --release
   ```

2. **Salin APK** ke folder ini dengan nama yang sama dengan `apk_url` di manifest (mis. `kalimasada-mobile-5.8.6.apk`).

3. **Tulis `manifest.json`** di folder ini (file ini di-ignore Git; salin dari `manifest.example.json` lalu sesuaikan versi dan catatan rilis). Contoh `apk_url` relatif ke origin API:

   - `"apk_url": "/mobile-app/kalimasada-mobile-5.8.6.apk"`  
     → unduhan dari `https://<host-billing>/mobile-app/kalimasada-mobile-5.8.6.apk`

4. **Restart** proses Node / PM2 agar rute statis `public/` ikut melayani file baru.

Alternatif: isi pengaturan `mobile_app_version`, `mobile_app_build`, `mobile_app_apk_url`, `mobile_app_release_notes` di `settings.json` server — manifest dari file akan dipakai hanya jika `public/mobile-app/manifest.json` tidak valid / kosong (lihat `routes/api/mobileAdapter.js`).
