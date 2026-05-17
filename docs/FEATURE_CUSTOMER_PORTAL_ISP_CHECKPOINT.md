# Checkpoint: Customer Portal ISP (Web Pelanggan)

| Field | Value |
|--------|--------|
| **Status** | Spesifikasi & checkpoint fitur baru |
| **Tanggal checkpoint** | 2026-05-12 |
| **Tujuan** | Aplikasi web customer portal ISP: modern, responsive, mobile friendly |
| **Prinsip integrasi** | **WAJIB** terintegrasi dengan sistem billing ISP yang sudah ada — bukan billing baru dari nol |

---

## Ringkasan tujuan

Pelanggan ISP menggunakan portal untuk:

- Cek paket internet
- Cek tagihan
- Pembayaran
- Speedtest
- Komplain gangguan
- Request layanan
- Notifikasi pelanggan

### Konsep integrasi (wajib)

- Customer portal = **frontend / client area** atas data billing existing.
- Data pelanggan diambil dari **database billing yang sudah berjalan**.
- Koneksi ke billing: **API** atau **koneksi database langsung** (sesuai kebijakan keamanan).
- **Jangan menduplikasi** database pelanggan jika tidak perlu.
- **Sinkronisasi data realtime** (WebSocket + pola sync yang jelas).

---

## Tech stack

### Frontend

- React + Vite
- TailwindCSS
- Axios
- React Router
- Zustand atau Redux
- Chart.js atau Recharts

### Backend

- Node.js + Express
- JWT Authentication
- REST API
- WebSocket untuk notifikasi realtime

### Database

- MySQL / MariaDB
- Mendukung integrasi ke **database billing existing**

### Arsitektur

- Struktur proyek **scalable**
- **Clean architecture** (lapisan jelas: domain, application, infrastructure, presentation)

---

## Fitur customer portal (detail)

### 1. Login pelanggan

- Login dengan: **username pelanggan**, **nomor layanan**, atau **email**
- Password mengikuti **data billing existing**
- JWT Authentication
- Remember login
- Reset password

### 2. Dashboard pelanggan

Tampilkan (layout modern berbasis **card**):

- Nama pelanggan, ID pelanggan
- Status layanan: Aktif / Suspend / Isolir
- Paket internet aktif, kecepatan internet
- Tagihan aktif, tanggal jatuh tempo, status pembayaran
- Grafik penggunaan bandwidth
- Riwayat pemakaian internet

### 3. Cek paket internet

Halaman detail paket:

- Nama paket, download/upload speed, harga, FUP, status paket, masa aktif

Fitur:

- Request upgrade / downgrade paket
- Riwayat perubahan paket

### 4. Tagihan & pembayaran

- Daftar invoice pelanggan
- Status: lunas, belum bayar, overdue
- Detail invoice
- Download invoice PDF
- Upload bukti transfer
- Integrasi **payment gateway mockup**

Tambahan:

- Filter bulan, search invoice, pagination

### 5. Speedtest ISP (internal)

- Ping, download, upload
- Animasi realtime
- Simpan history speedtest
- UI mirip Ookla modern

### 6. Komplain / tiket gangguan

Kategori tiket (contoh):

- Internet down, lambat, LOS merah, WiFi bermasalah, request teknisi, lainnya

Status tiket:

- Open → Process → Onsite → Solved → Closed

Fitur:

- Chat realtime dengan admin
- Upload foto gangguan
- Tracking progress teknisi

### 7. Request layanan

Pelanggan dapat request:

- Upgrade / downgrade paket
- Isolir sementara
- Cabut layanan
- Pindah alamat
- Reset PPPoE
- Ganti password WiFi

**Workflow approval admin** wajib dirancang.

### 8. Notifikasi realtime

Jenis notifikasi:

- Tagihan jatuh tempo, pembayaran berhasil, maintenance ISP, tiket dibalas admin, gangguan area

Implementasi:

- WebSocket
- Toast notification
- **WhatsApp notification mockup**

### 9. Profile pelanggan

- Edit profile, upload foto, ganti password
- Informasi alamat
- Lokasi di Google Maps
- Informasi ONU/ONT pelanggan

### 10. Admin panel

- Kelola pelanggan, tiket, pembayaran, paket internet
- Broadcast notifikasi
- Statistik pelanggan
- Monitoring status pelanggan

---

## Integrasi billing existing

### Modul integrasi fleksibel

- REST API billing (jika tersedia)
- Direct MySQL connection (read/write sesuai kebutuhan & keamanan)
- MikroTik API
- FreeRADIUS database
- PPPoE session monitoring

### Abstraction layer

- **Billing adapters** + **provider adapters**

Struktur konsep (contoh folder/modul):

- `adapters/mikrotik`
- `adapters/freeradius`
- `adapters/mysqlbilling`

### Fitur integrasi

- Sync pelanggan, invoice, status pembayaran, paket internet
- Sync status PPPoE online/offline

---

## Database (schema portal)

Buat schema untuk (sesuai kebutuhan portal — **tanpa menduplikasi** tabel pelanggan utama billing jika sudah ada):

- `users` (akun portal / mapping ke billing — desain perlu jelas)
- `customer_profiles` (data tambahan yang tidak ada di billing, jika perlu)
- `tickets`, `ticket_messages`
- `service_requests`
- `notifications`
- `speedtests`
- `sessions`
- `activity_logs`

**Catatan:** Hindari duplikasi tabel pelanggan utama; gunakan **foreign key / mapping** ke ID billing atau view read-only jika memungkinkan.

---

## UI/UX

- Modern ISP dashboard, **dark mode**, responsive, **mobile first**
- Sidebar navigation + top navbar
- Statistik card, chart bandwidth, tabel elegan
- Loading skeleton, animasi halus
- **Lucide icons**, **Framer Motion**, layout profesional

---

## Security

- JWT auth, role-based access
- Rate limiting, input validation
- Proteksi SQL injection (parameterized queries / ORM)
- Helmet, secure API middleware

---

## Output yang diinginkan (deliverable checklist)

Saat implementasi, hasil akhir diharapkan mencakup:

1. Struktur folder project (clean architecture)
2. Source code frontend
3. Source code backend
4. SQL schema (portal + relasi ke billing)
5. Docker setup
6. Contoh endpoint API
7. Contoh integrasi billing (adapter)
8. Middleware auth
9. Dummy seed data
10. README instalasi lengkap
11. Konfigurasi environment (`.env.example`)
12. Arsitektur siap production (observability, error handling, deployment notes sesuai kebutuhan)

### Kualitas kode

- Clean code, arsitektur scalable
- Komponen reusable, service layer, repository pattern
- Struktur API modular

---

## Langkah berikutnya (opsional untuk tim)

1. Audit skema database billing existing (tabel pelanggan, invoice, paket, auth).
2. Pilih mode integrasi utama: **API-first** vs **DB read replica** (disarankan API + cache untuk portal publik).
3. Definisikan kontrak JWT (claims, refresh token, remember-me).
4. Proof-of-concept WebSocket + satu alur notifikasi (mis. pembayaran berhasil).
5. Scaffold monorepo atau repo terpisah (frontend/backend) sesuai standar tim.

---

## Referensi internal repo

Dokumen terkait billing / infrastruktur yang mungkin relevan saat implementasi:

- `docs/BILLING_SETUP.md`
- `docs/RADIUS_DATABASE_CONFIG.md`
- `docs/MIKROTIK_RADIUS_SETUP.md`
- `docs/ROADMAP.md`

*Checkpoint ini disimpan sebagai sumber kebenaran fitur hingga diganti versi berikutnya.*
