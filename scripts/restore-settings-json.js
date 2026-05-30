#!/usr/bin/env node
/**
 * Pulihkan settings.json dari template + sumber server (DB, .env, whatsapp aktif).
 * Jalankan: node scripts/restore-settings-json.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const root = path.join(__dirname, '..');
const settingsPath = path.join(root, 'settings.json');
const templatePath = path.join(root, 'settings.server.template.json');
const backupPath = path.join(root, 'data', `settings.json.bak-${Date.now()}`);

function readJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return { ...fallback };
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`Skip ${filePath}: ${e.message}`);
        return { ...fallback };
    }
}

function dbGet(sql, params = []) {
    const dbPath = path.join(root, 'data/billing.db');
    const db = new sqlite3.Database(dbPath);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            db.close();
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function dbAll(sql, params = []) {
    const dbPath = path.join(root, 'data/billing.db');
    const db = new sqlite3.Database(dbPath);
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

(async () => {
    const template = readJson(templatePath);
    const current = readJson(settingsPath);
    const restored = { ...template, ...current };

    const appRows = await dbAll('SELECT key, value FROM app_settings');
    const appMap = Object.fromEntries(appRows.map((r) => [r.key, r.value]));

    const router = await dbGet('SELECT * FROM routers ORDER BY id LIMIT 1');

    restored.company_header = 'KALIMASADA INTI SARANA';
    restored.app_name = appMap.company_name || 'KALIMASADA INTI SARANA';
    restored.contact_phone = appMap.company_phone || '0816411615';
    restored.contact_email = appMap.company_email || 'info@alijaya.com';
    restored.contact_address = appMap.company_address || restored.contact_address || '';
    restored.contact_whatsapp = restored.contact_phone;
    restored.footer_info = `Info Hubungi : ${restored.contact_phone}`;

    restored.server_port = String(process.env.PORT || restored.server_port || '3003');
    const pub = process.env.PUBLIC_APP_BASE_URL || '';
    if (pub) {
        try {
            const u = new URL(pub);
            restored.server_host = u.hostname;
            if (u.port) restored.server_port = u.port;
        } catch (_) {}
    }
    if (!restored.server_host || restored.server_host === 'billing.jobnation.id') {
        restored.server_host = '103.132.40.18';
    }

    if (router) {
        restored.mikrotik_host = router.nas_ip || restored.mikrotik_host;
        restored.mikrotik_port = String(router.api_port || router.port || restored.mikrotik_port || '8728');
        restored.mikrotik_user = router.api_user || router.username || restored.mikrotik_user;
        restored.mikrotik_password = router.api_password || router.password || restored.mikrotik_password;
    }

    restored.auto_suspension_enabled = restored.auto_suspension_enabled !== false;
    restored.isolir_profile = restored.isolir_profile || 'isolir';
    restored.default_pppoe_profile = restored.default_pppoe_profile || 'default';
    restored.logo_filename = restored.logo_filename || 'logo.png';
    restored.admin_session_timeout_minutes = restored.admin_session_timeout_minutes || 60;

    if (!restored.admins || !restored['admins.0']) {
        restored['admins.0'] = restored['admins.0'] || '62816411615';
    }

    delete restored.user_auth_mode;

    if (fs.existsSync(settingsPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(settingsPath, backupPath);
        console.log('Backup lama:', backupPath);
    }

    fs.writeFileSync(settingsPath, JSON.stringify(restored, null, 2), 'utf8');
    console.log('settings.json dipulihkan —', Object.keys(restored).length, 'keys');
    console.log('server:', restored.server_host + ':' + restored.server_port);
    console.log('company:', restored.company_header);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
