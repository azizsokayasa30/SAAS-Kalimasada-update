'use strict';

const { getSettingsWithCache } = require('../settingsManager');

function pickSidebarSettings(settings = {}, tenant = null) {
    const name = settings.company_header
        || settings.company_name
        || settings.app_name
        || tenant?.name
        || 'KALIMASADA';
    return {
        logo_filename: settings.logo_filename || 'logo.png',
        company_header: name,
        company_name: settings.company_name || settings.company_header || tenant?.name || name,
        footer_info: settings.footer_info || '',
    };
}

/**
 * Middleware: isi req.appSettings dari pengaturan tenant (bukan settings.json global).
 */
async function attachTenantAppSettings(req, res, next) {
    try {
        const tenantId = req.tenantId || req.tenant?.id || req.session?.tenantId || null;
        let settings;
        if (tenantId) {
            const { getFullSettingsForTenantId } = require('./tenantSettingsManager');
            settings = await getFullSettingsForTenantId(tenantId);
        } else {
            settings = getSettingsWithCache();
        }
        req.tenantSettings = settings;
        const sidebarSettings = pickSidebarSettings(settings, req.tenant);
        res.locals.settings = sidebarSettings;
        req.appSettings = {
            companyHeader: sidebarSettings.company_header,
            footerInfo: settings.footer_info || '',
            logoFilename: sidebarSettings.logo_filename,
            company_slogan: settings.company_slogan || '',
            company_website: settings.company_website || '',
            invoice_notes: settings.invoice_notes || '',
            payment_bank_name: settings.payment_bank_name || '',
            payment_account_number: settings.payment_account_number || '',
            payment_account_holder: settings.payment_account_holder || '',
            payment_cash_address: settings.payment_cash_address || '',
            payment_cash_hours: settings.payment_cash_hours || '',
            contact_phone: settings.contact_phone || '',
            contact_email: settings.contact_email || '',
            contact_address: settings.contact_address || '',
            contact_whatsapp: settings.contact_whatsapp || '',
            suspension_grace_period_days: settings.suspension_grace_period_days || '3',
            isolir_profile: settings.isolir_profile || 'isolir',
        };
        res.locals.appSettings = req.appSettings;
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { attachTenantAppSettings, pickSidebarSettings };
