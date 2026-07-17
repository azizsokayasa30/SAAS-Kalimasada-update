'use strict';

const { getSetting } = require('./settingsManager');

function trimTrailingSlashes(s) {
  return String(s || '').replace(/\/+$/, '');
}

/**
 * URL dasar aplikasi untuk klien eksternal (Android, callback, deeplink).
 * Prioritas: PUBLIC_APP_BASE_URL / PUBLIC_API_BASE_URL → PUBLIC_APP_* terpisah → server_host + server_port (settings.json).
 * Portal management biasanya di manage.{domain}.
 * @returns {string} Tanpa slash di akhir
 */
function getPublicAppBaseUrl() {
  const direct = trimTrailingSlashes(
    process.env.PUBLIC_APP_BASE_URL || process.env.PUBLIC_API_BASE_URL || ''
  );
  if (direct) {
    if (!/^https?:\/\//i.test(direct)) {
      return trimTrailingSlashes(`http://${direct.replace(/^\/+/, '')}`);
    }
    return direct;
  }

  let scheme = (process.env.PUBLIC_APP_SCHEME || 'http').toLowerCase().replace(/:?\/?$/, '');
  if (scheme !== 'https') scheme = 'http';

  const host =
    (process.env.PUBLIC_APP_HOST || '').trim() ||
    String(getSetting('server_host', 'localhost') || 'localhost').trim();

  const rawPort =
    (process.env.PUBLIC_APP_PORT || '').trim() ||
    String(getSetting('server_port', '') || '').trim();

  const portNum = parseInt(rawPort, 10);
  const omitPort =
    !rawPort ||
    Number.isNaN(portNum) ||
    (scheme === 'http' && portNum === 80) ||
    (scheme === 'https' && portNum === 443);
  const portSuffix = omitPort ? '' : `:${rawPort}`;

  return trimTrailingSlashes(`${scheme}://${host}${portSuffix}`);
}

/**
 * URL hub API aplikasi mobile unified (Flutter).
 * Prioritas: MOBILE_API_BASE_URL → https://{mobile_sub}.{base_domain} → fallback PUBLIC_APP_BASE_URL.
 * @returns {string} Tanpa slash di akhir
 */
function getMobileApiBaseUrl() {
  const direct = trimTrailingSlashes(process.env.MOBILE_API_BASE_URL || '');
  if (direct) {
    if (!/^https?:\/\//i.test(direct)) {
      return trimTrailingSlashes(`https://${direct.replace(/^\/+/, '')}`);
    }
    return direct;
  }

  try {
    const { getTenantBaseDomain, getTenantAppScheme } = require('./platform/tenantUrls');
    const mobileSub = String(process.env.KALIMASADA_MOBILE_API_SUBDOMAIN || 'mobile')
      .toLowerCase()
      .trim() || 'mobile';
    const base = getTenantBaseDomain();
    if (base) {
      return trimTrailingSlashes(`${getTenantAppScheme()}://${mobileSub}.${base}`);
    }
  } catch (_) { /* ignore */ }

  return getPublicAppBaseUrl();
}

/**
 * Objek aman untuk dikirim ke klien (tanpa rahasia).
 */
function getPublicEndpointConfig() {
  const publicAppBaseUrl = getPublicAppBaseUrl();
  const mobileApiBaseUrl = getMobileApiBaseUrl();
  let scheme = 'http';
  let host = '';
  let port = '';
  try {
    const u = new URL(mobileApiBaseUrl || publicAppBaseUrl);
    scheme = u.protocol.replace(':', '') || 'http';
    host = u.hostname || '';
    port = u.port || (scheme === 'https' ? '443' : '80');
  } catch (_) {
    host = mobileApiBaseUrl || publicAppBaseUrl;
    port = '';
  }
  return {
    publicAppBaseUrl,
    mobileApiBaseUrl,
    scheme,
    host,
    port: String(port),
    apiBasePath: '/api',
    authLoginPath: '/api/auth/login',
    dataAccessNote:
      'SQLite billing hanya di server; aplikasi Android harus memakai REST API (base URL mobile API), bukan koneksi langsung ke file database.',
  };
}

module.exports = {
  getPublicAppBaseUrl,
  getMobileApiBaseUrl,
  getPublicEndpointConfig,
};
