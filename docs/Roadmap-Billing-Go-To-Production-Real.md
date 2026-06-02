# Roadmap Billing Go To Production Real

| Field | Value |
|--------|--------|
| **Status** | Dokumen arsitektur & operasional (living document) |
| **Tanggal** | 2026-05-30 |
| **Scope** | Dedicated (1 VM = 1 ISP) + SaaS (multi-instance terisolasi) |
| **Patokan codebase** | `internet-express` (Gembok Bill / Kalimasada) — single-tenant per instance |

---

## 1. Ringkasan eksekutif

Billing ini **dirancang single-tenant**: satu instalasi = satu ISP, dengan:

- Satu `data/billing.db`
- Satu `settings.json` (branding, Mikrotik, RADIUS, WhatsApp, dll.)
- Satu `PUBLIC_APP_BASE_URL` (mobile, portal, link eksternal)
- Modul **Agen WiFi** untuk reseller voucher **di bawah ISP yang sama**, bukan ISP lain yang punya billing mandiri

**Kesimpulan operasional:**

| Kebutuhan | Solusi |
|-----------|--------|
| Pebisnis WiFi kelola pelanggan sendiri | **Instance billing terpisah** (bukan akun agen di billing Anda) |
| Dedicated 1 VM 1 pelanggan | Model yang sudah jalan — **otomatisasi provision** |
| SaaS ke depan | **1 tenant = 1 pod terisolasi** (container/VM), **bukan** 1 DB shared + `tenant_id` |
| Update & maintenance | **Satu codebase, satu Docker image**, deploy ke semua tenant |

---

## 2. Prinsip arsitektur (jangan dilanggar)

### 2.1 Yang dijaga

1. **Satu codebase** — tidak fork per pelanggan.
2. **Isolasi data lewat infra** — volume/VM terpisah, bukan campur di satu SQLite.
3. **Dedicated dan SaaS pakai image yang sama** — beda tier harga & ukuran resource, bukan beda kode.
4. **Control plane tipis** — registry tenant, provision, suspend, backup, update; bukan rewrite billing core.

### 2.2 Yang sengaja tidak dilakukan (fase awal)

| Hindari | Alasan |
|---------|--------|
| Multi-tenant 1 DB besar + `tenant_id` di semua query | Refactor besar, rawan bocor data, Mikrotik/RADIUS/WhatsApp rumit |
| Fork codebase per pelanggan | Update & bugfix menjadi mimpi buruk |
| Install manual tanpa template | Tidak scalable untuk SaaS |
| Campur SaaS & dedicated tanpa limit resource | Saling ganggu performa & keamanan |

---

## 3. Model layanan: dua paket, satu mesin deploy

```
                    ┌─────────────────────────┐
                    │   Control Plane (baru)   │
                    │  tenant registry, billing │
                    │  provision, update, backup│
                    └────────────┬────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           ▼                     ▼                     ▼
   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
   │ SaaS Pod A    │    │ SaaS Pod B    │    │ Dedicated VM  │
   │ (container)   │    │ (container)   │    │ (1 VM = 1 ISP)│
   │ billing image │    │ billing image │    │ billing image │
   │ volume sendiri│    │ volume sendiri│    │ volume sendiri│
   └───────────────┘    └───────────────┘    └───────────────┘
```

### 3.1 Paket SaaS Standard

| Aspek | Detail |
|-------|--------|
| Isolasi | Container + volume terpisah di server/hosting Anda |
| Target | ISP kecil–menengah |
| Domain | `isp-a.billinganda.com` (subdomain) |
| Resource | Shared CPU/RAM dengan limit per pod |
| Operasional | Fully managed oleh Anda |

### 3.2 Paket Dedicated

| Aspek | Detail |
|-------|--------|
| Isolasi | 1 VM/VPS penuh per pelanggan |
| Target | ISP besar / compliance / isolasi penuh |
| Domain | `billing.isp-a.com` (domain pelanggan) |
| Resource | Dedicated |
| Operasional | Self-hosted atau managed (premium) |

### 3.3 Modul Agen (bukan pengganti instance baru)

- **Cukup** jika rekan bisnis hanya **jual voucher** di bawah jaringan Anda → buat akun **Agen** (`/agent/login`).
- **Tidak cukup** jika punya **pelanggan PPPoE/hotspot + tagihan + teknisi sendiri** → wajib **instance billing terpisah**.

---

## 4. Roadmap implementasi (fase)

### Fase 1 — Standarisasi dedicated (prioritas pertama)

**Tujuan:** Dedicated 1 VM 1 pelanggan jalan otomatis; fondasi SaaS siap tanpa ubah core app.

**Deliverable:**

- [ ] Template tenant (`deploy/tenant-compose.template.yml` atau setara)
- [ ] Script provision (`deploy/provision-tenant.sh` atau Node)
  - Input: `tenant_slug`, `company_name`, `plan`, `mode=saas|dedicated`
  - Output: instance jalan, admin default, `.env`, backup schedule
- [ ] Reverse proxy terpusat (Traefik / Nginx / Caddy)
  - Subdomain → container/port
  - SSL otomatis (Let's Encrypt)
- [ ] Backup per tenant (`data/billing.db`, `settings.json`, `whatsapp-session/`)
- [ ] Update terpusat: satu Docker image → rolling update semua instance dedicated

**Script existing yang dipakai:**

```bash
node scripts/fresh-server-installation.js   # konfirmasi: FRESH INSTALL
```

**Referensi repo:**

- `docs/DOCKER_GUIDE.md`
- `scripts/README-SERVER-INSTALLATION.md`
- `docker-compose.yml` (basis template per tenant)

**Estimasi:** 1–2 minggu operasional (infra + script, tanpa refactor app).

---

### Fase 2 — Control plane ringan

**Tujuan:** Onboarding SaaS otomatis; registry tenant terpusat.

**Deliverable:**

- [ ] Service control plane (repo/folder terpisah, Express kecil + DB registry PostgreSQL/MySQL)
- [ ] Skema tenant registry (minimal):

```sql
-- Contoh field (implementasi detail saat coding)
tenant_id, slug, company_name, plan, status, mode,  -- mode: saas | dedicated
public_url, container_name_or_vm_id, image_version,
max_customers, max_technicians,
created_at, expires_at, suspended_at
```

- [ ] API: create / suspend / delete / health tenant
- [ ] Integrasi provision: panggil script Fase 1
- [ ] Monitoring health per instance (`GET /health`)
- [ ] Log versi image per tenant (rollback per tenant jika perlu)

**Estimasi:** 2–4 minggu (tergantung UI admin control plane).

---

### Fase 3 — SaaS production-ready

**Tujuan:** Operasional SaaS matang (bukan hanya bisa spin container).

**Deliverable:**

- [ ] Limit resource per pod (CPU/RAM/disk)
- [ ] Suspend otomatis jika langganan platform expired
- [ ] Backup & restore per tenant (terjadwal + on-demand)
- [ ] Rolling update SaaS pods dari CI/CD
- [ ] Runbook incident (pod down, disk penuh, WhatsApp session invalid)
- [ ] Billing langganan **platform** (Midtrans/Stripe recurring) di control plane — terpisah dari invoice pelanggan ISP di dalam pod

**Alur onboarding tenant SaaS baru:**

```
Control plane → spin container → fresh-server-installation → set subdomain → aktif
```

**Estimasi:** 2–3 minggu setelah Fase 2 stabil.

---

### Fase 4 — Mobile app multi-deployment

**Tujuan:** Satu strategi mobile untuk dedicated + SaaS.

**Kondisi saat ini:**

- URL API di-build ke APK via `billing_kalimasada_mobile/.env` (`API_URL`)
- Branding (nama/logo) diambil dari server (`settings.json` / API)
- Update APK: `public/mobile-app/manifest.json` + file APK di server tenant

**Deliverable jangka pendek:**

- [ ] SOP build APK per tenant (subdomain/domain tetap)
- [ ] Dokumentasi deploy APK per instance

**Deliverable jangka menengah (opsional, kurangi ribet):**

- [ ] Layar setup URL server saat pertama buka app, **atau**
- [ ] Resolver: `GET /api/public/client?tenant=slug` via control plane → arahkan ke URL pod
- [ ] Satu APK generic untuk banyak subdomain SaaS

**Referensi:**

- `billing_kalimasada_mobile/.env.example`
- `public/mobile-app/README.md`
- `routes/api/public-endpoint.js`

---

### Fase 5 — RADIUS & Mikrotik per tenant (infra)

**Tujuan:** Integrasi jaringan aman per ISP, konsisten di SaaS dan dedicated.

**Rekomendasi struktur pod:**

```
[pod tenant-a]
  ├── billing-app (Node)
  ├── freeradius (sidecar, opsional)
  └── volume: data/, settings.json, whatsapp-session/
```

**Deliverable:**

- [ ] Template NAS/clients RADIUS per tenant
- [ ] Dokumentasi onboarding Mikrotik per tenant (NAS secret, profile)
- [ ] Dedicated: RADIUS di VM yang sama atau sidecar
- [ ] SaaS: sidecar RADIUS per pod atau VM RADIUS terpisah per tenant besar

**Referensi:**

- `docs/MIKROTIK_RADIUS_SETUP.md`
- `docs/RADIUS_DATABASE_CONFIG.md`
- `.env.example` (`RADIUS_SQLITE_PATH`, `PUBLIC_APP_BASE_URL`)

---

### Fase 6 — (Opsional jauh) Multi-tenant DB

**Hanya jika benar-benar perlu** — misalnya fitur analytics/platform ringan. **Bukan** untuk core billing, invoice, pelanggan, Mikrotik sync.

Default: **tetap pod-per-tenant**.

---

## 5. Struktur repo yang disarankan

```
internet-express/              ← app billing (tetap, 1 Docker image)
deploy/
  tenant-compose.template.yml
  provision-tenant.sh
  update-all-tenants.sh
  backup-tenant.sh
control-plane/                 ← baru: registry + API provision
  (Express + DB registry)
docs/
  Roadmap-Billing-Go-To-Production-Real.md   ← dokumen ini
  SAAS_OPERATIONS.md           ← (buat saat Fase 3)
```

**CI/CD (target):**

1. Build image `billing-app:vX.Y.Z`
2. Push registry
3. Control plane / script update semua tenant (SaaS rolling, dedicated per jadwal maintenance)

---

## 6. Checklist deploy per pelanggan (dedicated atau SaaS pod)

### 6.1 Infrastruktur

- [ ] VM/container + volume terpisah
- [ ] Domain/subdomain + HTTPS
- [ ] Reverse proxy route ke instance
- [ ] Firewall & backup schedule

### 6.2 Aplikasi billing

- [ ] Clone/deploy image versi terbaru
- [ ] `npm install` (jika non-Docker) / `docker compose up -d`
- [ ] `node scripts/fresh-server-installation.js` (instance baru)
- [ ] Salin `.env` dari `.env.example`:
  - `PUBLIC_APP_BASE_URL=https://billing.pelanggan.com`
  - `PORT`, `ISOLIR_PORT`, RADIUS path jika dipakai
- [ ] Konfigurasi `settings.json` (company, admin, Mikrotik, WhatsApp)
- [ ] `npm run build:customer-portal` (portal pelanggan)
- [ ] Restart PM2 / container

### 6.3 Jaringan ISP pelanggan

- [ ] Mikrotik NAS → RADIUS
- [ ] Profile PPPoE / hotspot
- [ ] Walled garden isolir (`ISOLIR_PORT` / `PUBLIC_APP_BASE_URL`)

### 6.4 Mobile

- [ ] Set `API_URL` di `billing_kalimasada_mobile/.env`
- [ ] `flutter build apk --release`
- [ ] Upload APK + `manifest.json` ke `public/mobile-app/` instance tenant
- [ ] Restart proses Node agar static file aktif

### 6.5 Operasional

- [ ] Buat akun admin, teknisi, kolektor untuk tim pelanggan
- [ ] Backup awal `data/billing.db`
- [ ] Uji login admin, teknisi mobile, portal pelanggan, isolir/restore

---

## 7. Model bisnis (referensi)

| Model | Deskripsi |
|-------|-----------|
| **Hosted by you** | Anda sewakan VM/container; maintenance & backup Anda; pelanggan dapat admin sendiri |
| **Self-hosted** | Pelanggan punya server; Anda jual jasa setup + support |
| **Hybrid tier** | SaaS (murah, shared host) vs Dedicated (premium, 1 VM) — **satu pipeline deploy** |

---

## 8. Timeline ringkas

| Fase | Deliverable utama | Hasil bisnis |
|------|-------------------|--------------|
| **1** | Template + provision + proxy + backup | Dedicated otomatis, siap jual |
| **2** | Control plane + tenant registry | Onboarding SaaS otomatis |
| **3** | Monitoring, suspend, billing langganan platform | SaaS operasional |
| **4** | Mobile multi-URL / satu APK | Kurangi biaya build per tenant |
| **5** | RADIUS/Mikrotik template per tenant | Onboarding jaringan konsisten |
| **6** | (Opsional) Multi-tenant DB fitur ringan | Hanya jika terbukti perlu |

---

## 9. Keputusan arsitektur (ADR singkat)

| Keputusan | Pilihan | Alasan |
|-----------|---------|--------|
| SaaS isolation | Pod-per-tenant | Sesuai desain single-tenant app; Mikrotik/RADIUS/WhatsApp terisolasi |
| Shared DB multi-tenant | **Ditolak** (core billing) | Risiko data leak; refactor masif |
| Dedicated | 1 VM = 1 instance | Sudah proven; tinggal otomatisasi |
| Codebase | Monorepo `internet-express` | Mobile + portal + billing satu release train |
| Update | Satu image, rolling per tenant | Konsisten versi, rollback per tenant |

---

## 10. Langkah berikutnya (action items)

1. **Segera:** Buat `deploy/tenant-compose.template.yml` dari `docker-compose.yml` existing.
2. **Segera:** Buat `deploy/provision-tenant.sh` (slug, company, mode, port/subdomain).
3. **Paralel:** Setup reverse proxy + SSL wildcard `*.billinganda.com`.
4. **Setelah 3 tenant dedicated stabil:** Mulai control plane Fase 2.
5. **Jangan mulai:** Refactor multi-tenant DB untuk tabel `customers` / `invoices`.

---

## 11. Referensi dokumen terkait

| Dokumen | Isi |
|---------|-----|
| `docs/DOCKER_GUIDE.md` | Deploy Docker single instance |
| `docs/DEPLOY_CHECKLIST.md` | Checklist deploy GitHub |
| `docs/DEPLOYMENT.md` | Panduan deployment umum |
| `scripts/README-SERVER-INSTALLATION.md` | Fresh install & reset data |
| `docs/ANALISIS_SKALABILITAS_BILLING.md` | Optimasi skala 5k–10k pelanggan **per instance** |
| `docs/routes_documentation.md` | Role Admin, Agen, Kolektor, Teknisi |
| `.env.example` | URL publik, RADIUS, portal |

---

*Dokumen ini merangkum arsitektur produksi realistis: **Dedicated now, SaaS via pod-per-tenant, satu codebase, control plane tipis.** Revisi berikutnya: tambah link ke script deploy setelah Fase 1 selesai diimplementasi.*
