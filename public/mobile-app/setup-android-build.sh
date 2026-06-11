#!/usr/bin/env bash
# Pasang dependensi build APK di server Ubuntu (headless, tanpa Android Studio).
# Jalankan: bash setup-android-build.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE_APP_DIR="$PROJECT_ROOT/public/mobile-app"
FLUTTER_BIN="$MOBILE_APP_DIR/flutter-sdk/bin/flutter"
ANDROID_SDK="$MOBILE_APP_DIR/android-sdk"
CMD_TOOLS_ZIP="$MOBILE_APP_DIR/cmdline-tools.zip"
CMD_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

echo "==> Project: $PROJECT_ROOT"
echo "==> Flutter: $FLUTTER_BIN"
echo "==> Android SDK: $ANDROID_SDK"

if [[ ! -x "$FLUTTER_BIN" ]]; then
  echo "ERROR: Flutter belum ada. Clone dulu:"
  echo "  cd $MOBILE_APP_DIR && rm -rf flutter-sdk"
  echo "  git clone https://github.com/flutter/flutter.git -b stable flutter-sdk"
  exit 1
fi

echo "==> Instal paket sistem (butuh sudo)..."
sudo apt-get update -qq
sudo apt-get install -y \
  openjdk-17-jdk \
  unzip zip wget curl \
  libc6 libstdc++6

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK/platform-tools:$ANDROID_SDK/cmdline-tools/latest/bin:$PATH"

if [[ ! -x "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "==> Unduh Android command-line tools..."
  mkdir -p "$ANDROID_SDK/cmdline-tools"
  wget -q -O "$CMD_TOOLS_ZIP" "$CMD_TOOLS_URL"
  rm -rf "$ANDROID_SDK/cmdline-tools/latest"
  unzip -q -o "$CMD_TOOLS_ZIP" -d "$ANDROID_SDK/cmdline-tools"
  mv "$ANDROID_SDK/cmdline-tools/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
  rm -f "$CMD_TOOLS_ZIP"
fi

# sdkmanager kadang memasang ke latest-2; Flutter mengharapkan .../latest/bin
if [[ -d "$ANDROID_SDK/cmdline-tools/latest-2" && ! -e "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" ]]; then
  rm -rf "$ANDROID_SDK/cmdline-tools/latest"
  ln -sfn "latest-2" "$ANDROID_SDK/cmdline-tools/latest"
fi

echo "==> Terima lisensi Android SDK..."
yes | sdkmanager --licenses >/dev/null || true

echo "==> Instal komponen Android SDK (lengkap — hindari unduh saat build pertama)..."
sdkmanager \
  "platform-tools" \
  "platforms;android-34" \
  "platforms;android-35" \
  "platforms;android-36" \
  "build-tools;28.0.3" \
  "build-tools;35.0.0" \
  "ndk;28.2.13676358" \
  "cmake;3.22.1" \
  "cmdline-tools;latest"

GRADLE_HOME="$MOBILE_APP_DIR/.gradle-home"
PUB_CACHE="$MOBILE_APP_DIR/.pub-cache"
mkdir -p "$GRADLE_HOME" "$PUB_CACHE"
export GRADLE_USER_HOME="$GRADLE_HOME"
export PUB_CACHE="$PUB_CACHE"

echo "==> Konfigurasi Flutter..."
"$FLUTTER_BIN" config --android-sdk "$ANDROID_SDK"

echo "==> Precache Flutter Android (sekali, mempercepat build berikutnya)..."
"$FLUTTER_BIN" precache --android

echo ""
echo "==> Selesai. Cek dengan:"
echo "  export JAVA_HOME=$JAVA_HOME"
echo "  export ANDROID_HOME=$ANDROID_SDK"
echo "  $FLUTTER_BIN doctor"
echo ""
echo "Tool Android di panel admin siap dipakai untuk Build APK Release."
