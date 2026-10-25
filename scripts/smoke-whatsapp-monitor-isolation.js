#!/usr/bin/env node
/**
 * Smoke test: WhatsApp notification toggle isolation between two tenants.
 * Does not send messages and does not write the real tenant database.
 */
'use strict';

async function main() {
    const mon = require('../config/whatsappMonitoringSettings');
    const tenantStore = require('../config/platform/tenantStore');
    const tenantSettingsManager = require('../config/platform/tenantSettingsManager');

    const tenantA = 910001;
    const tenantB = 910002;
    const store = new Map();

    const origGetTenant = tenantStore.getTenantById;
    const origSave = tenantSettingsManager.saveFullSettingsForTenantId;

    tenantStore.getTenantById = async (id) => {
        const tid = Number(id);
        return { id: tid, settings: { ...(store.get(tid) || {}) } };
    };
    tenantSettingsManager.saveFullSettingsForTenantId = async (id, updates) => {
        const tid = Number(id);
        const cur = { ...(store.get(tid) || {}) };
        Object.keys(updates || {}).forEach((key) => {
            const val = updates[key];
            if (val && typeof val === 'object' && !Array.isArray(val) && cur[key] && typeof cur[key] === 'object') {
                cur[key] = { ...cur[key], ...val };
            } else {
                cur[key] = val;
            }
        });
        store.set(tid, cur);
        return cur;
    };

    try {
        mon.invalidateTenantMonitorCache();

        const defaultsA = await mon.getMergedMonitorsForTenant(tenantA);
        if (defaultsA.customer_welcome_wa !== true || defaultsA.pppoe_login_logout_wa !== true) {
            throw new Error('Tenant without saved monitors should default every toggle on');
        }

        await mon.setMonitorsPartialForTenant(tenantA, {
            customer_welcome_wa: false,
            isolir_suspension_wa: false,
            pppoe_login_logout_wa: true
        });
        await mon.setMonitorsPartialForTenant(tenantB, {
            customer_welcome_wa: true,
            isolir_suspension_wa: true,
            pppoe_login_logout_wa: false
        });

        mon.invalidateTenantMonitorCache();

        const switchesA = await mon.getMergedMonitorsForTenant(tenantA);
        const switchesB = await mon.getMergedMonitorsForTenant(tenantB);

        if (switchesA.customer_welcome_wa !== false) throw new Error('Tenant A welcome toggle not saved');
        if (switchesB.customer_welcome_wa !== true) throw new Error('Tenant B welcome toggle leaked from A');
        if (switchesA.isolir_suspension_wa !== false) throw new Error('Tenant A isolir toggle not saved');
        if (switchesB.isolir_suspension_wa !== true) throw new Error('Tenant B isolir toggle leaked from A');
        if (switchesA.pppoe_login_logout_wa !== true) throw new Error('Tenant A PPPoE toggle lost');
        if (switchesB.pppoe_login_logout_wa !== false) throw new Error('Tenant B PPPoE toggle not saved');
        if (await mon.isWaSystemMonitorEnabled('customer_welcome_wa', tenantA) !== false) {
            throw new Error('Runtime check for tenant A did not see welcome off');
        }
        if (await mon.isWaSystemMonitorEnabled('customer_welcome_wa', tenantB) !== true) {
            throw new Error('Runtime check for tenant B leaked tenant A welcome off');
        }

        const rawA = store.get(tenantA);
        const rawB = store.get(tenantB);
        if (!rawA.whatsapp_system_monitors || !rawB.whatsapp_system_monitors) {
            throw new Error('Monitors were not stored on the tenant settings object');
        }
        if (rawA.whatsapp_system_monitors.customer_welcome_wa === rawB.whatsapp_system_monitors.customer_welcome_wa) {
            throw new Error('Stored monitor objects are not isolated');
        }

        await mon.writeMonitorFieldValues(tenantA, [
            { key: 'rx_power_warning', type: 'number', defaultValue: '-35' },
            { key: 'pppoe_monitor_interval_minutes', type: 'number', defaultValue: '5' }
        ], {
            rx_power_warning: '-40',
            pppoe_monitor_interval_minutes: '9'
        });
        await mon.writeMonitorFieldValues(tenantB, [
            { key: 'rx_power_warning', type: 'number', defaultValue: '-35' }
        ], {
            rx_power_warning: '-28'
        });

        const fieldsA = await mon.readMonitorFieldValues(tenantA, [
            { key: 'rx_power_warning', defaultValue: '-35' },
            { key: 'pppoe_monitor_interval_minutes', defaultValue: '5' }
        ]);
        const fieldsB = await mon.readMonitorFieldValues(tenantB, [
            { key: 'rx_power_warning', defaultValue: '-35' },
            { key: 'pppoe_monitor_interval_minutes', defaultValue: '5' }
        ]);
        if (fieldsA.rx_power_warning !== '-40') throw new Error('Tenant A threshold not saved');
        if (fieldsB.rx_power_warning !== '-28') throw new Error('Tenant B threshold leaked or missing');
        if (fieldsA.pppoe_monitor_interval_minutes !== '9') throw new Error('Tenant A interval not saved');
        if (fieldsB.pppoe_monitor_interval_minutes !== '5') throw new Error('Tenant B inherited tenant A interval');

        const untouched = mon.mergeMonitorsFromRaw({});
        if (Object.values(untouched).some((v) => v !== true)) {
            throw new Error('Empty settings must not inherit a shared off switch');
        }

        console.log('OK: WhatsApp notification toggle isolation smoke test passed');
    } finally {
        tenantStore.getTenantById = origGetTenant;
        tenantSettingsManager.saveFullSettingsForTenantId = origSave;
        mon.invalidateTenantMonitorCache();
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
