# Pasang Flutter + Android SDK (Management → Mobile App)

Semua di dalam folder project:

| Komponen | Lokasi |
|----------|--------|
| Flutter SDK | `public/mobile-app/flutter-sdk/bin/flutter` |
| Android SDK | `public/mobile-app/android-sdk/` |
| Keystore | `public/mobile-app/keystore/kalimasada.jks` |
| APK OTA | `public/mobile-app/*.apk` + `manifest.json` |

## 1. Flutter SDK

```bash
cd /path/to/Saas-Kalimasada_Inti_Sarana/public/mobile-app
rm -rf flutter-sdk
git clone https://github.com/flutter/flutter.git -b stable flutter-sdk
flutter-sdk/bin/flutter doctor
```

> Jika `git clone` gagal *already exists*: `rm -rf flutter-sdk` lalu ulangi.

## 2. Android SDK + Java (wajib untuk build APK)

Di server tanpa Android Studio, jalankan skrip ini (butuh `sudo`):

```bash
cd /path/to/Saas-Kalimasada_Inti_Sarana/public/mobile-app
bash setup-android-build.sh
```

Skrip memasang: OpenJDK 17, Android command-line tools, platform/build-tools, lalu `flutter config --android-sdk`.

## 3. Keystore

Dari panel **Management → Mobile App** klik **Buat keystore**, atau salin keystore produksi ke:

`public/mobile-app/keystore/kalimasada.jks`

Password default: `android` · Alias: `androiddebugkey`

## 4. Cek hasil

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=/path/to/Saas-Kalimasada_Inti_Sarana/public/mobile-app/android-sdk
flutter-sdk/bin/flutter doctor
```

Yang **wajib hijau** untuk build APK:
- **Flutter**
- **Android toolchain**

## 5. Build & OTA dari panel

**Management → Mobile App** → set **API_URL** ke `https://mobile.kalimasada-app.com` → naikkan **Build (+)** → **Simpan konfigurasi** → **Build APK Release**.

Portal management tetap di `https://manage.kalimasada-app.com` (bukan untuk API mobile).

Setelah sukses, `manifest.json` + APK dipublish ke `public/mobile-app/` dan endpoint OTA:

`GET /api/mobile-adapter/app-update/manifest`

### Waktu build

| Situasi | Estimasi |
|---------|----------|
| **Build pertama** (unduh NDK/Gradle) | 10–20 menit |
| **Build berikutnya** (cache hangat) | **3–8 menit** |

APK **universal ~70 MB** (arm + arm64 + x86_64) — wajib agar bisa diinstal di semua perangkat Android.
