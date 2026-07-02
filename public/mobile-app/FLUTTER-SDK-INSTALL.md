# Pasang Flutter + Android SDK (Tool Android)

Semua di dalam folder `internet-express`:

| Komponen | Lokasi |
|----------|--------|
| Flutter SDK | `public/mobile-app/flutter-sdk/bin/flutter` |
| Android SDK | `public/mobile-app/android-sdk/` |
| APK OTA | `public/mobile-app/*.apk` + `manifest.json` |

## 1. Flutter SDK

```bash
cd /home/ajizs/internet-express/public/mobile-app
rm -rf flutter-sdk
git clone https://github.com/flutter/flutter.git -b stable flutter-sdk
flutter-sdk/bin/flutter doctor
```

> Jika `git clone` gagal *already exists*: `rm -rf flutter-sdk` lalu ulangi.

## 2. Android SDK + Java (wajib untuk build APK)

Di server tanpa Android Studio, jalankan skrip ini (butuh `sudo`):

```bash
cd /home/ajizs/internet-express/public/mobile-app
bash setup-android-build.sh
```

Skrip memasang: OpenJDK 17, Android command-line tools, platform/build-tools, lalu `flutter config --android-sdk`.

## 3. Cek hasil

```bash
cd /home/ajizs/internet-express/public/mobile-app
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=/home/ajizs/internet-express/public/mobile-app/android-sdk
flutter-sdk/bin/flutter doctor
```

Yang **wajib hijau** untuk build APK:
- **Flutter** — sudah OK
- **Android toolchain** — harus ✓ (Flutter 3.44 butuh **SDK 36** + **Build-Tools 28.0.3**)

Jika doctor masih ✗ setelah skrip, pasang manual:

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=/home/ajizs/internet-express/public/mobile-app/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager "platforms;android-36" "build-tools;28.0.3"
flutter-sdk/bin/flutter doctor
```

Peringatan *flutter not on your path* **boleh diabaikan** — Tool Android memakai path lengkap, bukan PATH global.

Chrome / Linux desktop toolchain **tidak diperlukan** untuk build APK saja.

## 4. Build dari admin

**Admin → Settingan → Tool Android** → naikkan **Build (+)** → **Build APK Release**.

### Waktu build

| Situasi | Estimasi |
|---------|----------|
| **Build pertama** (unduh NDK/Gradle) | 10–20 menit |
| **Build berikutnya** (cache hangat) | **3–8 menit** |

APK **universal ~70 MB** (arm + arm64 + x86_64) — wajib agar bisa diinstal di semua perangkat Android. Build ditolak otomatis jika ukuran < 55 MB atau arsitektur tidak lengkap.
