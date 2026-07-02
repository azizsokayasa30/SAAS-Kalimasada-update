# Pengembangan lokal di Windows (backend + Flutter)

Panduan menjalankan **billing Node.js** dan **app Flutter** di PC Windows agar debug lebih nyaman (hot reload, breakpoint, log di IDE).

## Prerequisites

| Komponen | Versi disarankan |
|----------|------------------|
| [Git](https://git-scm.com/download/win) | terbaru |
| [Node.js LTS](https://nodejs.org/) | ≥ 18 |
| [Flutter SDK](https://docs.flutter.dev/get-started/install/windows) | channel `stable` |
| Android Studio + SDK | untuk emulator / USB debugging |

Verifikasi:

```powershell
git --version
node -v
npm -v
flutter doctor -v
```

## 1. Clone dari GitHub

```powershell
cd C:\dev
git clone git@github.com:azizsokayasa30/billing-kalimasada.git internet-express
cd internet-express
git checkout kalimasada-billing-cursor
```

HTTPS (jika belum ada SSH key):

```powershell
git clone https://github.com/azizsokayasa30/billing-kalimasada.git internet-express
```

## 2. Backend billing (Node.js)

### Instal dependensi

```powershell
npm install
```

### Konfigurasi `.env`

```powershell
copy .env.example .env
```

Edit `.env` — contoh untuk dev lokal:

```env
PORT=4555
PUBLIC_APP_BASE_URL=http://127.0.0.1:4555
```

### Settings & database

1. Salin template settings (jika belum ada `settings.json` di root repo):

   ```powershell
   copy settings.server.template.json settings.json
   ```

2. **Database:** untuk data nyata, salin `data/billing.db` (dan bila perlu `data/radius.db`, `data/sessions.db`) dari server produksi ke folder `data\`. File ini tidak ada di Git.

   Atau inisialisasi kosong:

   ```powershell
   node scripts\init-database.js
   ```

### Jalankan server

Di **Command Prompt** (script `npm` memakai sintaks `set` Windows):

```cmd
npm run dev
```

Di **PowerShell**:

```powershell
$env:NODE_ENV="development"; npx nodemon app.js
```

Server listen di `0.0.0.0:4555`. Buka admin: [http://127.0.0.1:4555](http://127.0.0.1:4555)

> **Firewall Windows:** izinkan Node.js pada jaringan privat jika HP/emulator harus mengakses API dari LAN.

## 3. Flutter app (`billing_kalimasada_mobile`)

```powershell
cd billing_kalimasada_mobile
copy .env.example .env
flutter pub get
```

### `API_URL` menurut target debug

| Target | `API_URL` di `.env` Flutter |
|--------|----------------------------|
| **Android Emulator** | `http://10.0.2.2:4555` |
| **HP fisik (Wi‑Fi sama)** | `http://<IP-LAN-PC-Windows>:4555` |
| **Flutter Windows desktop** | `http://127.0.0.1:4555` |

Cari IP LAN PC: `ipconfig` → IPv4 Address (mis. `192.168.1.50`).

Contoh `.env` Flutter untuk emulator:

```env
API_URL=http://10.0.2.2:4555
```

### Jalankan dengan hot reload

```powershell
flutter devices
flutter run
```

Mode release (mirip produksi):

```powershell
flutter run --release
```

## 4. Alur debug yang disarankan

1. Terminal 1: `npm run dev` (backend, nodemon auto-restart).
2. Terminal 2: `cd billing_kalimasada_mobile` → `flutter run`.
3. Ubah kode Dart → simpan → hot reload (`r` di terminal Flutter).
4. Ubah route/API Node → nodemon restart otomatis → hot restart Flutter (`R`) bila perlu.

Log API: terminal backend. Log app: terminal Flutter / DevTools.

## 5. Sinkronisasi dengan GitHub

Setelah perubahan di Windows:

```powershell
git add .
git status
git commit -m "pesan commit"
git push origin kalimasada-billing-cursor
```

Branch aktif: `kalimasada-billing-cursor` (repo: `azizsokayasa30/billing-kalimasada`).

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| App Flutter “connection refused” | Pastikan backend jalan; `API_URL` benar (`10.0.2.2` untuk emulator, bukan `localhost`). |
| Port sudah dipakai | Ganti `PORT` di `.env` backend dan sesuaikan `API_URL` Flutter. |
| `npm run dev` gagal di PowerShell | Pakai CMD atau perintah PowerShell di atas. |
| Login gagal / data kosong | Salin `data/billing.db` dari server atau jalankan `init-database.js`. |
| Cleartext HTTP | Sudah diizinkan di `AndroidManifest.xml` untuk build dev. |

## Referensi

- Flutter mobile: [`billing_kalimasada_mobile/README.md`](../billing_kalimasada_mobile/README.md)
- URL publik / Android: [`.env.example`](../.env.example) → `PUBLIC_APP_BASE_URL`
- Build APK dari admin: [`public/mobile-app/README.md`](../public/mobile-app/README.md)
