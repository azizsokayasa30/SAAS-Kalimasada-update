'use strict';

const { getTenant, hasTenantContext } = require('./tenantContext');
const { getSetting } = require('../settingsManager');

/**
 * Tenant-scoped settings: tenants.settings JSON first, fallback global settings.json.
 */
function getTenantSetting(key, defaultValue = null) {
    if (hasTenantContext()) {
        const tenant = getTenant();
        if (tenant?.settings && tenant.settings[key] !== undefined && tenant.settings[key] !== null) {
            return tenant.settings[key];
        }
    }
    return getSetting(key, defaultValue);
}

function getTenantBranding() {
    const { pickCompanyHeaderFromSettings, DEFAULT_COMPANY_HEADER } = require('../companyBranding');
    const tenant = hasTenantContext() ? getTenant() : null;
    const header = pickCompanyHeaderFromSettings({
        company_header: getTenantSetting('company_header', ''),
        company_name: getTenantSetting('company_name', ''),
        app_name: getTenantSetting('app_name', ''),
        footer_info: getTenantSetting('footer_info', '')
    }, tenant);
    return {
        company_header: header || DEFAULT_COMPANY_HEADER,
        company_name: header || DEFAULT_COMPANY_HEADER,
        logo_filename: getTenantSetting('logo_filename', 'logo.png'),
        footer_info: getTenantSetting('footer_info', ''),
        contact_phone: getTenantSetting('contact_phone', ''),
    };
}

module.exports = {
    getTenantSetting,
    getTenantBranding,
};
