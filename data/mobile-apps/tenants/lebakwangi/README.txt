Kalimasada Mobile — Tenant: lebakwangi
App: lebakwangi Mobile
API: https://lebakwangi.kalimasada-app.com

Struktur folder:
  .env              → salin ke billing_kalimasada_mobile/.env saat build
  app-config.json   → metadata build
  build.sh          → script build APK (butuh Flutter SDK)
  output/           → hasil APK
  logs/             → log build terakhir

Build manual:
  bash /var/www/billing-kalimasada/data/mobile-apps/tenants/lebakwangi/build.sh

Atau dari Management Portal: tombol "Build APK".