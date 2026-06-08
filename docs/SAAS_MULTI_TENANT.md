# Kalimasada Billing — SaaS Multi-Tenant (Shared DB)

## Model

- **1 aplikasi** Node.js/Express (`app.js`)
- **1 database** SQLite `data/billing.db` (+ `tenant_id` di tabel bisnis)
- **Isolasi** middleware `resolveTenant` + filter query `tenant_id`

## Management Portal

| URL | Fungsi |
|-----|--------|
| `/management/login` | Login Super Admin |
| `/management/dashboard` | Statistik global |
| `/management/tenants` | CRUD tenant |

**Super Admin default:** `management@kalimasada` / `kalimasada123`

## Tenant App

| URL | Fungsi |
|-----|--------|
| `{subdomain}.kalimasada-app.com` | Aplikasi billing tenant |
| `/login?tenant={subdomain}` | Fallback dev tanpa wildcard DNS |

## Init Platform

```bash
npm run platform:init
# atau tanpa npm:
python3 scripts/init-platform-python.py
```

## Env

```env
KALIMASADA_BASE_DOMAIN=kalimasada-app.com
KALIMASADA_CENTRAL_SUBDOMAIN=manage
```

## File Utama

- `config/platform/tenantStore.js` — registry & provisioning
- `config/platform/tenantContext.js` — AsyncLocalStorage tenant context
- `middleware/resolveTenant.js` — subdomain resolver
- `routes/managementPortal.js` — portal super admin
- `migrations/create_saas_platform_tables.sql`
- `migrations/add_tenant_id_core_tables.sql`
