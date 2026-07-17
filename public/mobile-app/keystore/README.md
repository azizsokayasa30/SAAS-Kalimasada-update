# Keystore Android

File: `public/mobile-app/keystore/kalimasada.jks`

Keystore ini dipakai **otomatis setiap build** dari **Management → Mobile App**. Setelah ada di server, tidak perlu diubah lagi kecuali pindah sertifikat.

## Setup awal (sekali)

### Opsi A — dari panel (disarankan untuk server baru)

Buka **Management → Mobile App** → **Buat keystore**.

### Opsi B — salin dari PC Windows (kontinuitas OTA APK lama)

```bash
scp "$USERPROFILE/.android/debug.keystore" user@server:/path/to/project/public/mobile-app/keystore/kalimasada.jks
```

Lalu di panel klik **Adopsi keystore ini** jika SHA berbeda dari baseline lama.

Password default: `android` · Alias: `androiddebugkey`

> Catatan: perangkat yang sudah terpasang APK dengan sertifikat berbeda **tidak bisa** update OTA — harus uninstall lalu install APK baru.
