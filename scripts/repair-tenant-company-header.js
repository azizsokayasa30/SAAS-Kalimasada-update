#!/usr/bin/env node
'use strict';

/**
 * Perbaiki company_header tenant yang masih nama platform lama / tanpa "PT."
 * agar pesan WhatsApp memakai nama company yang benar.
 */
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const {
    DEFAULT_COMPANY_HEADER,
    pickCompanyHeaderFromSettings,
    sanitizeWhatsAppTemplateCompanyHeader
} = require('../config/companyBranding');

const DB_PATH = path.join(__dirname, '../data/billing.db');

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ changes: this.changes });
        });
    });
}

function parseSettings(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return {};
    }
}

async function repairTenants(db) {
    const rows = await dbAll(db, `SELECT id, name, subdomain, settings FROM tenants WHERE deleted_at IS NULL`);
    let updated = 0;
    for (const row of rows) {
        const settings = parseSettings(row.settings);
        const nextHeader = pickCompanyHeaderFromSettings(settings, row);
        let changed = false;

        if (String(settings.company_header || '').trim() !== nextHeader) {
            settings.company_header = nextHeader;
            changed = true;
        }
        if (!String(settings.company_name || '').trim()) {
            settings.company_name = nextHeader;
            changed = true;
        } else {
            const pickedName = pickCompanyHeaderFromSettings({
                company_name: settings.company_name,
                company_header: nextHeader
            }, row);
            if (pickedName !== settings.company_name && pickedName === DEFAULT_COMPANY_HEADER) {
                settings.company_name = pickedName;
                changed = true;
            }
        }

        if (settings.whatsapp_templates && typeof settings.whatsapp_templates === 'object') {
            Object.keys(settings.whatsapp_templates).forEach((key) => {
                const tpl = settings.whatsapp_templates[key];
                if (!tpl || typeof tpl.template !== 'string') return;
                const sanitized = sanitizeWhatsAppTemplateCompanyHeader(tpl.template);
                if (sanitized !== tpl.template) {
                    tpl.template = sanitized;
                    changed = true;
                }
            });
        }

        if (!changed) {
            console.log(`  tenant #${row.id} ${row.subdomain || ''} — already ok: ${nextHeader}`);
            continue;
        }
        await dbRun(db, `UPDATE tenants SET settings = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
            JSON.stringify(settings),
            row.id
        ]);
        updated += 1;
        console.log(`  tenant #${row.id} ${row.subdomain || row.name} → company_header="${settings.company_header}"`);
    }
    return updated;
}

async function repairPlatformProfile(db) {
    try {
        const rows = await dbAll(db, `SELECT value FROM platform_settings WHERE key = 'company_profile' LIMIT 1`);
        if (!rows.length) return false;
        let profile;
        try {
            profile = JSON.parse(rows[0].value);
        } catch (_) {
            return false;
        }
        if (!profile || typeof profile !== 'object') return false;
        const next = pickCompanyHeaderFromSettings(profile);
        if (profile.company_header === next && profile.company_name) return false;
        profile.company_header = next;
        if (!profile.company_name) profile.company_name = next;
        await dbRun(
            db,
            `UPDATE platform_settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = 'company_profile'`,
            [JSON.stringify(profile)]
        );
        console.log(`  platform company_profile.company_header → "${next}"`);
        return true;
    } catch (err) {
        if (String(err.message || '').includes('no such table')) return false;
        throw err;
    }
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.log('Skip: data/billing.db tidak ada');
        return;
    }
    const db = new sqlite3.Database(DB_PATH);
    try {
        console.log('Repair company_header tenant + platform...');
        const n = await repairTenants(db);
        await repairPlatformProfile(db);
        console.log(`Selesai. ${n} tenant diupdate.`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
