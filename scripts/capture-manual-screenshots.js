#!/usr/bin/env node
/**
 * Capture screenshots for Tenant Operation Manual.
 *
 * Env:
 *   MANUAL_BASE_URL   default http://127.0.0.1:4555
 *   MANUAL_TENANT     tenant subdomain (required for IP access)
 *   MANUAL_ADMIN_USER optional (default: from tenant settings or "admin")
 *   MANUAL_ADMIN_PASS optional (default: from tenant settings)
 *   MANUAL_OUT_DIR    default docs/manual/figures
 *
 * Optional field portals:
 *   MANUAL_TECH_USER / MANUAL_TECH_PASS
 *   MANUAL_COLLECTOR_USER / MANUAL_COLLECTOR_PASS
 *   MANUAL_AGENT_USER / MANUAL_AGENT_PASS
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = process.env.MANUAL_OUT_DIR
  || path.join(ROOT, 'docs/manual/figures');
const BASE = (process.env.MANUAL_BASE_URL || 'http://127.0.0.1:4555').replace(/\/$/, '');
const TENANT = (process.env.MANUAL_TENANT || 'skynet').trim();

function loadTenantCreds() {
  try {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(ROOT, 'data/billing.db');
    return new Promise((resolve) => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return resolve(null);
        db.get(
          `SELECT settings FROM tenants WHERE subdomain = ? AND status = 'active' LIMIT 1`,
          [TENANT],
          (e, row) => {
            db.close();
            if (e || !row) return resolve(null);
            try {
              const s = JSON.parse(row.settings || '{}');
              resolve({
                username: s.admin_username || 'admin',
                password: s.admin_password || '',
              });
            } catch {
              resolve(null);
            }
          }
        );
      });
    });
  } catch {
    return Promise.resolve(null);
  }
}

function withTenant(urlPath) {
  const u = new URL(urlPath.startsWith('http') ? urlPath : `${BASE}${urlPath}`);
  if (TENANT && !u.searchParams.get('tenant')) {
    u.searchParams.set('tenant', TENANT);
  }
  return u.toString();
}

// fullPage:false keeps PDF size manageable for long tables
const ADMIN_PAGES = [
  { file: 'fig-01-login.png', path: '/login', beforeLogin: true, fullPage: false },
  { file: 'fig-02-dashboard.png', path: '/admin/dashboard', fullPage: false },
  { file: 'fig-03-settings.png', path: '/admin/settings', fullPage: false },
  { file: 'fig-04-radius.png', path: '/admin/radius', fullPage: false },
  { file: 'fig-05-routers.png', path: '/admin/routers', fullPage: false },
  { file: 'fig-06-connection-settings.png', path: '/admin/connection-settings', fullPage: false },
  { file: 'fig-07-genieacs-setting.png', path: '/admin/genieacs-setting', fullPage: false },
  { file: 'fig-08-pppoe-profiles.png', path: '/admin/mikrotik/profiles', fullPage: false },
  { file: 'fig-09-packages.png', path: '/admin/billing/packages', fullPage: false },
  { file: 'fig-10-areas.png', path: '/admin/billing/areas', fullPage: false },
  { file: 'fig-11-whatsapp-settings.png', path: '/admin/billing/whatsapp-settings', fullPage: false },
  { file: 'fig-12-payment-settings.png', path: '/admin/billing/payment-settings', fullPage: false },
  { file: 'fig-13-service-suspension.png', path: '/admin/billing/service-suspension', fullPage: false },
  { file: 'fig-14-customers.png', path: '/admin/billing/customers', fullPage: false },
  { file: 'fig-15-mikrotik-users.png', path: '/admin/mikrotik', fullPage: false },
  { file: 'fig-16-auto-invoice.png', path: '/admin/billing/auto-invoice', fullPage: false },
  { file: 'fig-17-invoice-list.png', path: '/admin/billing/invoice-list', fullPage: false },
  { file: 'fig-18-collectors.png', path: '/admin/collectors', fullPage: false },
  { file: 'fig-19-financial-report.png', path: '/admin/billing/financial-report', fullPage: false },
  { file: 'fig-20-voucher.png', path: '/admin/hotspot/voucher', fullPage: false },
  { file: 'fig-21-agents.png', path: '/admin/agents', fullPage: false },
  { file: 'fig-22-warehouse-inbound.png', path: '/admin/warehouse/barang-masuk', fullPage: false },
  { file: 'fig-23-warehouse-items.png', path: '/admin/warehouse/nama-barang', fullPage: false },
  { file: 'fig-24-attendance.png', path: '/admin/employees/attendance', fullPage: false },
  { file: 'fig-25-employees.png', path: '/admin/employees', fullPage: false },
  { file: 'fig-26-technicians.png', path: '/admin/technicians', fullPage: false },
  { file: 'fig-27-installations.png', path: '/admin/installations', fullPage: false },
  { file: 'fig-28-trouble.png', path: '/admin/trouble', fullPage: false },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function settle(page, ms = 800) {
  await sleep(ms);
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 });
  } catch {
    /* ignore */
  }
}

async function shot(page, file, opts = {}) {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    fullPage: opts.fullPage !== false,
    type: 'png',
  });
  const size = fs.statSync(out).size;
  console.log(`  ✓ ${file} (${Math.round(size / 1024)} KB)`);
  return out;
}

async function adminLogin(page, username, password) {
  const loginUrl = withTenant('/login');
  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  await settle(page, 500);

  // Capture login before submitting
  await shot(page, 'fig-01-login.png', { fullPage: false });

  const roleSelect = await page.$('select[name="role"], #role');
  if (roleSelect) {
    await page.select('select[name="role"], #role', 'admin').catch(() => {});
  }

  await page.type('#username, input[name="username"]', username, { delay: 20 });
  await page.type('#password, input[name="password"]', password, { delay: 20 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
    page.click('#btnLogin, button[type="submit"]'),
  ]);

  // Ensure we land on dashboard (session cookie set)
  const dash = withTenant('/admin/dashboard');
  await page.goto(dash, { waitUntil: 'networkidle2', timeout: 60000 });
  const html = await page.content();
  if (html.includes('Tenant Tidak Ditemukan') || page.url().includes('/login')) {
    throw new Error('Admin login failed — check MANUAL_TENANT / credentials');
  }
  console.log('  ✓ admin session OK →', page.url());
}

async function captureAdminPages(page) {
  for (const item of ADMIN_PAGES) {
    if (item.beforeLogin) continue; // already captured during login
    const url = withTenant(item.path);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await settle(page, 900);
      // Expand main content; hide toasts if any
      await page.evaluate(() => {
        document.querySelectorAll('.toast, .swal2-container').forEach((el) => el.remove());
      }).catch(() => {});
      await shot(page, item.file, { fullPage: item.fullPage !== false });
    } catch (err) {
      console.warn(`  ✗ ${item.file} — ${err.message}`);
      // Write a tiny placeholder so PDF still builds
      await page.setContent(`<html><body style="font-family:sans-serif;padding:40px">
        <h2>Halaman tidak tersedia</h2><p>${item.path}</p><p>${err.message}</p></body></html>`);
      await shot(page, item.file, { fullPage: false });
    }
  }
}

async function tryPortal(browser, label, loginPath, dashPath, user, pass, outFile) {
  if (!user || !pass) {
    console.log(`  · skip ${label} (no credentials)`);
    // Capture login page only
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 850, deviceScaleFactor: 1 });
    try {
      await page.goto(withTenant(loginPath), { waitUntil: 'networkidle2', timeout: 45000 });
      await settle(page, 600);
      await shot(page, outFile, { fullPage: false });
    } catch (e) {
      console.warn(`  ✗ ${label} login page: ${e.message}`);
    }
    await page.close();
    return;
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 850, deviceScaleFactor: 1 });
  try {
    await page.goto(withTenant(loginPath), { waitUntil: 'networkidle2', timeout: 45000 });
    await page.type('input[name="username"], input[name="phone"], #username, #phone', user, { delay: 15 });
    await page.type('input[name="password"], #password', pass, { delay: 15 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null),
      page.click('button[type="submit"], #btnLogin'),
    ]);
    if (dashPath) {
      await page.goto(withTenant(dashPath), { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
    }
    await settle(page, 800);
    await shot(page, outFile, { fullPage: false });
  } catch (e) {
    console.warn(`  ✗ ${label}: ${e.message}`);
  }
  await page.close();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const fromDb = await loadTenantCreds();
  const username = process.env.MANUAL_ADMIN_USER || fromDb?.username || 'admin';
  const password = process.env.MANUAL_ADMIN_PASS || fromDb?.password || '';
  if (!password) {
    console.error('Missing admin password. Set MANUAL_ADMIN_PASS or ensure tenant settings exist.');
    process.exit(1);
  }

  console.log(`Base: ${BASE}`);
  console.log(`Tenant: ${TENANT}`);
  console.log(`User: ${username}`);
  console.log(`Out: ${OUT_DIR}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  console.log('\n[1] Admin login + screenshots');
  await adminLogin(page, username, password);
  await captureAdminPages(page);
  await page.close();

  console.log('\n[2] Field portals');
  await tryPortal(
    browser,
    'technician',
    '/technician/login',
    '/technician/dashboard',
    process.env.MANUAL_TECH_USER,
    process.env.MANUAL_TECH_PASS,
    'fig-29-technician.png'
  );
  await tryPortal(
    browser,
    'collector',
    '/collector/login',
    '/collector/dashboard',
    process.env.MANUAL_COLLECTOR_USER,
    process.env.MANUAL_COLLECTOR_PASS,
    'fig-30-collector.png'
  );
  await tryPortal(
    browser,
    'agent',
    '/agent/login',
    '/agent/dashboard',
    process.env.MANUAL_AGENT_USER,
    process.env.MANUAL_AGENT_PASS,
    'fig-31-agent.png'
  );

  await browser.close();
  console.log('\nDone. Figures in', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
