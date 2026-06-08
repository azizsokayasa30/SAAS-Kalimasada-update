#!/usr/bin/env bash
# Build APK tenant: lebakwangi
# Jalankan di server yang sudah terinstall Flutter SDK
set -euo pipefail

ROOT="/var/www/billing-kalimasada"
MOBILE="/var/www/billing-kalimasada/billing_kalimasada_mobile"
WS="/var/www/billing-kalimasada/data/mobile-apps/tenants/lebakwangi"
MANIFEST_DIR="$ROOT/public/mobile-app/lebakwangi"

if ! command -v flutter >/dev/null 2>&1; then
  echo "ERROR: Flutter SDK belum terinstall. Install Flutter lalu jalankan ulang."
  exit 1
fi

if [ ! -d "$MOBILE" ]; then
  echo "ERROR: Proyek Flutter tidak ditemukan: $MOBILE"
  exit 1
fi

MANIFEST_SRC="$MOBILE/android/app/src/main/AndroidManifest.xml"
MANIFEST_BAK="$WS/AndroidManifest.xml.bak"

mkdir -p "$WS/output" "$WS/logs" "$MANIFEST_DIR"

cp "$WS/.env" "$MOBILE/.env"
cp "$MANIFEST_SRC" "$MANIFEST_BAK"
sed -i 's/android:label="[^"]*"/android:label="lebakwangi Mobile"/' "$MANIFEST_SRC"

cd "$MOBILE"
flutter pub get
flutter build apk --release 2>&1 | tee "$WS/logs/last-build.log"

APK_NAME="lebakwangi-mobile-$(date +%Y%m%d-%H%M).apk"
cp build/app/outputs/flutter-apk/app-release.apk "$WS/output/$APK_NAME"
cp "$WS/output/$APK_NAME" "$ROOT/public/mobile-app/lebakwangi/$APK_NAME"

mv "$MANIFEST_BAK" "$MANIFEST_SRC"

echo "OK: APK → $WS/output/$APK_NAME"
