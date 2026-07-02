# Keystore Android

File: `public/mobile-app/keystore/kalimasada.jks`

Keystore ini dipakai **otomatis setiap build** dari Tool Android. Setelah disalin ke server, tidak perlu diubah lagi kecuali pindah server.

## Setup awal (sekali)

Salin dari PC Windows tempat build APK produksi:

```bash
scp "$USERPROFILE/.android/debug.keystore" user@server:/path/internet-express/public/mobile-app/keystore/kalimasada.jks
```

Password default: `android` · Alias: `androiddebugkey`
