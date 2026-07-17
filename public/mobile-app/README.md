# Mobile App — Build & OTA

Panel: **Management → Mobile App** (`/management/mobile-app`)

Satu APK Flutter unified (`billing_kalimasada_mobile`) untuk semua tenant. Pengguna memilih tenant saat login.

## URL

| Host | Peran |
|------|--------|
| `https://mobile.kalimasada-app.com` | Hub API mobile + OTA (`X-Tenant`) |
| `https://manage.kalimasada-app.com` | Portal Super Admin |
| `https://{tenant}.kalimasada-app.com` | Web login per tenant |

## Alur singkat

1. Pastikan status **Server Siap**.
2. Isi `API_URL` = `https://mobile.kalimasada-app.com`, nama app, versi, catatan rilis.
3. **Simpan konfigurasi** lalu **Build APK Release**.
4. Setelah sukses, unduh APK atau biarkan pengguna update OTA dari dalam app.

## OTA

- Manifest: `https://mobile.kalimasada-app.com/api/mobile-adapter/app-update/manifest`
- File: `public/mobile-app/manifest.json` + `*.apk`

## Setup server (sekali)

Lihat `FLUTTER-SDK-INSTALL.md` dan `setup-android-build.sh`.
