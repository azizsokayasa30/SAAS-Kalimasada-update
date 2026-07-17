#!/usr/bin/env node
/**
 * Smoke test: WhatsApp template isolation between two tenants.
 * Does not send messages; only load/save/resolve.
 */
'use strict';

async function main() {
    const wa = require('../config/whatsapp-notifications');
    const { getBuiltInWhatsAppTemplates } = require('../config/whatsapp-template-registry');

    const tenantA = 900001;
    const tenantB = 900002;
    const store = new Map();

    const tenantSettingsManager = require('../config/platform/tenantSettingsManager');
    const origGet = tenantSettingsManager.getFullSettingsForTenantId;
    const origSave = tenantSettingsManager.saveFullSettingsForTenantId;

    tenantSettingsManager.getFullSettingsForTenantId = async (id) => {
        return { ...(store.get(Number(id)) || {}) };
    };
    tenantSettingsManager.saveFullSettingsForTenantId = async (id, updates) => {
        const cur = store.get(Number(id)) || {};
        const next = { ...cur, ...updates };
        store.set(Number(id), next);
        return next;
    };

    try {
        wa.invalidateTenantTemplatesCache();

        const defaults = await wa.getResolvedTemplates(tenantA);
        const builtIn = getBuiltInWhatsAppTemplates();
        if (defaults.invoice_created.template !== builtIn.invoice_created.template) {
            throw new Error('Tenant A without overrides should get built-in templates, not global file');
        }

        await wa.updateTemplates({
            invoice_created: {
                title: 'Tagihan A',
                template: 'PESAN KHUSUS TENANT A {customer_name}',
                enabled: true
            }
        }, tenantA);

        await wa.updateTemplates({
            invoice_created: {
                title: 'Tagihan B',
                template: 'PESAN KHUSUS TENANT B {customer_name}',
                enabled: false
            }
        }, tenantB);

        wa.invalidateTenantTemplatesCache();

        const tplA = await wa.getResolvedTemplates(tenantA);
        const tplB = await wa.getResolvedTemplates(tenantB);

        if (tplA.invoice_created.template !== 'PESAN KHUSUS TENANT A {customer_name}') {
            throw new Error('Tenant A template not saved/loaded correctly');
        }
        if (tplB.invoice_created.template !== 'PESAN KHUSUS TENANT B {customer_name}') {
            throw new Error('Tenant B template not saved/loaded correctly');
        }
        if (tplA.invoice_created.template === tplB.invoice_created.template) {
            throw new Error('Tenant templates leaked across tenants');
        }
        if (wa.isTemplateEnabled('invoice_created', tplB) !== false) {
            throw new Error('Tenant B enabled flag not isolated');
        }
        if (wa.isTemplateEnabled('invoice_created', tplA) !== true) {
            throw new Error('Tenant A enabled flag lost');
        }

        console.log('OK: WhatsApp template isolation smoke test passed');
    } finally {
        tenantSettingsManager.getFullSettingsForTenantId = origGet;
        tenantSettingsManager.saveFullSettingsForTenantId = origSave;
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
