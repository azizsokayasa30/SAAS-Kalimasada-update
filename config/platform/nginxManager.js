'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getTenantBaseDomain } = require('./tenantUrls');

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(__dirname, '../../data/nginx');
const CONFIG_JSON = path.join(DATA_DIR, 'proxy-config.json');
const GENERATED_CONF = path.join(DATA_DIR, 'kalimasada-app.conf');
const APPLY_SCRIPT = path.join(__dirname, '../../scripts/nginx-apply.sh');

const DEFAULT_CONFIG = {
    enabled: true,
    base_domain: getTenantBaseDomain(),
    central_subdomain: process.env.KALIMASADA_CENTRAL_SUBDOMAIN || 'manage',
    upstream_host: '127.0.0.1',
    upstream_port: Number(process.env.PORT) || 4555,
    listen_port: 80,
    ssl_enabled: false,
    ssl_cert_path: '/etc/letsencrypt/live/kalimasada-app.com/fullchain.pem',
    ssl_key_path: '/etc/letsencrypt/live/kalimasada-app.com/privkey.pem',
    server_ip: process.env.KALIMASADA_SERVER_IP || '192.168.166.197',
    public_ip: process.env.KALIMASADA_PUBLIC_IP || '',
    lan_access_enabled: true,
    custom_hosts: [],
    manual_subdomains: [],
    custom_proxies: [],
    tenant_subdomains: [],
    auto_sync_on_tenant_change: true,
    last_synced_at: null,
    last_applied_at: null,
    last_apply_message: null,
    last_apply_ok: null,
};

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadConfig() {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_JSON)) {
        const cfg = { ...DEFAULT_CONFIG };
        fs.writeFileSync(CONFIG_JSON, JSON.stringify(cfg, null, 2), 'utf8');
        return cfg;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw };
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
}

function saveConfig(updates) {
    const current = loadConfig();
    const merged = { ...current, ...updates };
    if (Array.isArray(updates.custom_hosts)) {
        merged.custom_hosts = updates.custom_hosts;
    }
    if (Array.isArray(updates.manual_subdomains)) {
        merged.manual_subdomains = updates.manual_subdomains;
    }
    if (Array.isArray(updates.custom_proxies)) {
        merged.custom_proxies = updates.custom_proxies;
    }
    ensureDataDir();
    fs.writeFileSync(CONFIG_JSON, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

function sanitizeDomain(domain) {
    return String(domain || '')
        .toLowerCase()
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/[^a-z0-9.-]/g, '');
}

async function fetchActiveTenantSubdomains() {
    const tenantStore = require('./tenantStore');
    const tenants = await tenantStore.listTenants();
    return tenants
        .filter((t) => t.status === 'active' && t.subdomain && !String(t.subdomain).includes('__del_'))
        .map((t) => String(t.subdomain).toLowerCase().trim())
        .filter(Boolean);
}

function buildServerNames(cfg, tenantSubdomains = []) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const central = String(cfg.central_subdomain || 'manage').toLowerCase().trim();
    const names = new Set([base, `*.${base}`, `${central}.${base}`]);
    (tenantSubdomains || cfg.tenant_subdomains || []).forEach((sub) => {
        const s = String(sub || '').toLowerCase().trim();
        if (s) names.add(`${s}.${base}`);
    });
    (cfg.custom_hosts || []).forEach((h) => {
        const d = sanitizeDomain(h);
        if (d) names.add(d);
    });
    return Array.from(names);
}

function checkSslCertificates(cfg) {
    const certPath = String(cfg.ssl_cert_path || '').trim();
    const keyPath = String(cfg.ssl_key_path || '').trim();
    if (!certPath || !keyPath) {
        return { ok: false, error: 'Path sertifikat SSL belum diisi.' };
    }
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return { ok: true, certPath, keyPath };
    }
    try {
        const { execFileSync } = require('child_process');
        execFileSync('bash', [APPLY_SCRIPT, 'check-ssl', certPath, keyPath], {
            stdio: 'pipe',
            timeout: 10000,
        });
        return { ok: true, certPath, keyPath };
    } catch (_) {
        if (cfg.ssl_enabled && cfg.last_apply_ok && certPath && keyPath) {
            return { ok: true, certPath, keyPath, trusted: true };
        }
        return {
            ok: false,
            error: `Sertifikat belum ada: ${certPath}. Jalankan certbot terlebih dahulu.`,
        };
    }
}

function getSslCertPaths(cfg) {
    return checkSslCertificates(cfg);
}

function isSslReady(cfg) {
    return !!(cfg.ssl_enabled && getSslCertPaths(cfg).ok);
}

function sanitizeSubdomainSlug(raw) {
    return String(raw || '')
        .toLowerCase()
        .trim()
        .replace(/\.kalimasada-app\.com$/i, '')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^-+|-+$/g, '');
}

function parseManualSubdomains(raw) {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : String(raw).split(/[\n,]+/);
    return [...new Set(items.map(sanitizeSubdomainSlug).filter(Boolean))];
}

function getMergedSubdomainsForNginx(cfg, tenantSubs = []) {
    const manual = (cfg.manual_subdomains || []).map(sanitizeSubdomainSlug).filter(Boolean);
    const fromTenants = (tenantSubs || []).map(sanitizeSubdomainSlug).filter(Boolean);
    return [...new Set([...fromTenants, ...manual])];
}

function resolveProxyHostname(entry, base) {
    const rawHost = sanitizeDomain(entry?.hostname || '');
    if (rawHost && rawHost.includes('.')) return rawHost;
    const sub = sanitizeSubdomainSlug(entry?.subdomain || entry?.hostname || rawHost);
    if (sub && base) return `${sub}.${base}`;
    if (rawHost) return rawHost;
    return null;
}

function normalizeCustomProxy(raw, base) {
    if (!raw || typeof raw !== 'object') return null;
    const upstreamHost = String(raw.upstream_host || '').trim();
    const upstreamPort = Number(raw.upstream_port);
    if (!upstreamHost || !upstreamPort || upstreamPort < 1 || upstreamPort > 65535) return null;

    const hostname = resolveProxyHostname(raw, base);
    if (!hostname) return null;

    const slug = sanitizeSubdomainSlug(
        raw.id || raw.subdomain || hostname.split('.')[0]
    ) || `ext_${hostname.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;

    return {
        id: slug,
        label: String(raw.label || hostname).trim(),
        hostname,
        subdomain: hostname.endsWith(`.${base}`) ? hostname.slice(0, -(base.length + 1)) : '',
        upstream_host: upstreamHost,
        upstream_port: upstreamPort,
        enabled: raw.enabled !== false,
        preserve_host: raw.preserve_host === true,
        notes: String(raw.notes || '').trim(),
    };
}

function getActiveCustomProxies(cfg) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const seen = new Set();
    const out = [];
    for (const raw of cfg.custom_proxies || []) {
        const p = normalizeCustomProxy(raw, base);
        if (!p || p.enabled === false || seen.has(p.hostname)) continue;
        seen.add(p.hostname);
        out.push(p);
    }
    return out;
}

function customProxyUpstreamName(proxyId) {
    return `km_proxy_${sanitizeSubdomainSlug(proxyId) || 'external'}`;
}

function getCustomProxySslSubdomains(cfg, proxies = null) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const suffix = `.${base}`;
    return [...new Set((proxies || getActiveCustomProxies(cfg))
        .map((p) => {
            if (!p.hostname.endsWith(suffix)) return null;
            return sanitizeSubdomainSlug(p.hostname.slice(0, -suffix.length));
        })
        .filter(Boolean))];
}

const ACME_WEBROOT = '/var/www/certbot';

function buildAcmeChallengeBlock() {
    return `    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type "text/plain";
        try_files $uri =404;
    }`;
}

function buildLanIpServerBlock(cfg, upstreamName) {
    const lanIp = String(cfg.server_ip || '').trim();
    if (!lanIp || cfg.lan_access_enabled === false) return '';

    const lines = [];
    lines.push('# Akses LAN / IP langsung (HTTP port 80, tanpa domain)');
    lines.push('server {');
    lines.push('    listen 80 default_server;');
    lines.push('    listen [::]:80 default_server;');
    lines.push(`    server_name ${lanIp} _;`);
    lines.push('');
    lines.push(buildAcmeChallengeBlock());
    lines.push('');
    lines.push('    location / {');
    lines.push(buildProxyBlock(upstreamName));
    lines.push('    }');
    lines.push('}');
    lines.push('');
    return lines.join('\n');
}

function buildProxyBlock(upstreamName, opts = {}) {
    const hostLine = opts.preserveHost
        ? `        proxy_set_header Host ${opts.preserveHost};`
        : '        proxy_set_header Host $host;';
    return `        proxy_pass http://${upstreamName};
        proxy_http_version 1.1;
${hostLine}
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        client_max_body_size 50m;`;
}

function buildCustomProxyUpstreamBlocks(proxies) {
    if (!proxies.length) return '';
    const lines = [];
    for (const p of proxies) {
        const upstreamName = customProxyUpstreamName(p.id);
        lines.push(`upstream ${upstreamName} {`);
        lines.push(`    server ${p.upstream_host}:${p.upstream_port};`);
        lines.push('    keepalive 16;');
        lines.push('}');
        lines.push('');
    }
    return lines.join('\n');
}

function buildCustomProxyServerBlocks(cfg, proxies, sslReady) {
    if (!proxies.length) return '';

    const lines = [];
    lines.push('# Proxy kustom — arahkan domain ke server/backend lain');
    for (const p of proxies) {
        const upstreamName = customProxyUpstreamName(p.id);
        const preserveHost = p.preserve_host
            ? `${p.upstream_host}${p.upstream_port === 80 ? '' : `:${p.upstream_port}`}`
            : null;
        const proxyOpts = preserveHost ? { preserveHost } : {};

        if (sslReady) {
            const sslCheck = getSslCertPaths(cfg);
            lines.push('server {');
            lines.push('    listen 443 ssl http2;');
            lines.push('    listen [::]:443 ssl http2;');
            lines.push(`    server_name ${p.hostname};`);
            lines.push(`    ssl_certificate ${sslCheck.certPath};`);
            lines.push(`    ssl_certificate_key ${sslCheck.keyPath};`);
            lines.push('    ssl_protocols TLSv1.2 TLSv1.3;');
            lines.push('    ssl_prefer_server_ciphers on;');
            lines.push('');
            lines.push(buildAcmeChallengeBlock());
            lines.push('');
            lines.push('    location / {');
            lines.push(buildProxyBlock(upstreamName, proxyOpts));
            lines.push('    }');
            lines.push('}');
            lines.push('');
            lines.push('server {');
            lines.push('    listen 80;');
            lines.push('    listen [::]:80;');
            lines.push(`    server_name ${p.hostname};`);
            lines.push('');
            lines.push(buildAcmeChallengeBlock());
            lines.push('');
            lines.push('    location / {');
            lines.push('        return 301 https://$host$request_uri;');
            lines.push('    }');
            lines.push('}');
            lines.push('');
        } else {
            const listen = Number(cfg.listen_port) || 80;
            lines.push('server {');
            lines.push(`    listen ${listen};`);
            lines.push(`    listen [::]:${listen};`);
            lines.push(`    server_name ${p.hostname};`);
            lines.push('');
            lines.push(buildAcmeChallengeBlock());
            lines.push('');
            lines.push('    location / {');
            lines.push(buildProxyBlock(upstreamName, proxyOpts));
            lines.push('    }');
            lines.push('}');
            lines.push('');
        }
        lines.push(`#   ${p.hostname} → ${p.upstream_host}:${p.upstream_port}${p.label ? ` (${p.label})` : ''}`);
    }
    return lines.join('\n');
}

function generateNginxConfig(cfg, tenantSubdomains) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const central = String(cfg.central_subdomain || 'manage').toLowerCase().trim();
    const host = String(cfg.upstream_host || '127.0.0.1').trim();
    const port = Number(cfg.upstream_port) || 4555;
    const listen = Number(cfg.listen_port) || 80;
    const upstreamName = 'kalimasada_app';
    const subs = getMergedSubdomainsForNginx(cfg, tenantSubdomains || cfg.tenant_subdomains || []);
    const customProxies = getActiveCustomProxies(cfg);
    const serverNames = buildServerNames(cfg, subs);

    const lines = [];
    lines.push('# Kalimasada SaaS — Nginx reverse proxy (auto-generated)');
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push('# Jangan edit manual — gunakan Management Portal /management/reverse-proxy');
    const manual = (cfg.manual_subdomains || []).map(sanitizeSubdomainSlug).filter(Boolean);
    lines.push(`# Subdomain tenant (${subs.length}): ${subs.join(', ') || '-'}`);
    if (manual.length) {
        lines.push(`# Subdomain manual: ${manual.join(', ')}`);
    }
    if (customProxies.length) {
        lines.push(`# Proxy eksternal (${customProxies.length}): ${customProxies.map((p) => p.hostname).join(', ')}`);
    }
    lines.push('');
    const customUpstreamBlocks = buildCustomProxyUpstreamBlocks(customProxies);
    if (customUpstreamBlocks) {
        lines.push(customUpstreamBlocks.trimEnd());
        lines.push('');
    }
    lines.push(`upstream ${upstreamName} {`);
    lines.push(`    server ${host}:${port};`);
    lines.push('    keepalive 32;');
    lines.push('}');
    lines.push('');

    const sslReady = isSslReady(cfg);
    if (cfg.ssl_enabled && !sslReady) {
        lines.push('# SSL diminta tetapi sertifikat belum tersedia — hanya HTTP yang diaktifkan');
        lines.push(`# ${checkSslCertificates(cfg).error}`);
        lines.push('');
    }

    if (sslReady) {
        const sslCheck = getSslCertPaths(cfg);
        lines.push('server {');
        lines.push('    listen 443 ssl http2;');
        lines.push('    listen [::]:443 ssl http2;');
        lines.push(`    server_name ${serverNames.join(' ')};`);
        lines.push(`    ssl_certificate ${sslCheck.certPath};`);
        lines.push(`    ssl_certificate_key ${sslCheck.keyPath};`);
        lines.push('    ssl_protocols TLSv1.2 TLSv1.3;');
        lines.push('    ssl_prefer_server_ciphers on;');
        lines.push('');
        lines.push(buildAcmeChallengeBlock());
        lines.push('');
        lines.push('    location / {');
        lines.push(buildProxyBlock(upstreamName));
        lines.push('    }');
        lines.push('}');
        lines.push('');
        lines.push('server {');
        lines.push('    listen 80;');
        lines.push('    listen [::]:80;');
        lines.push(`    server_name ${serverNames.join(' ')};`);
        lines.push('');
        lines.push(buildAcmeChallengeBlock());
        lines.push('');
        lines.push('    location / {');
        lines.push('        return 301 https://$host$request_uri;');
        lines.push('    }');
        lines.push('}');
    } else {
        lines.push('server {');
        lines.push(`    listen ${listen};`);
        lines.push(`    listen [::]:${listen};`);
        lines.push(`    server_name ${serverNames.join(' ')};`);
        lines.push('');
        lines.push(buildAcmeChallengeBlock());
        lines.push('');
        lines.push('    location / {');
        lines.push(buildProxyBlock(upstreamName));
        lines.push('    }');
        lines.push('}');
    }

    lines.push('');
    lines.push('# Routing:');
    lines.push(`#   ${central}.${base}  → Management Portal`);
    subs.forEach((sub) => {
        lines.push(`#   ${sub}.${base}  → Tenant: ${sub} (lokal ${host}:${port})`);
    });
    customProxies.forEach((p) => {
        lines.push(`#   ${p.hostname}  → Eksternal ${p.upstream_host}:${p.upstream_port}`);
    });
    lines.push(`#   *.${base}         → Wildcard (tenant baru otomatis)`);
    lines.push(`#   ${base}           → Apex domain`);
    if (cfg.server_ip && cfg.lan_access_enabled !== false) {
        lines.push(`#   http://${cfg.server_ip}/     → Akses LAN (IP langsung)`);
        lines.push(`#   http://${cfg.server_ip}:${port}/  → Node langsung (tanpa nginx)`);
    }

    const customProxyBlocks = buildCustomProxyServerBlocks(cfg, customProxies, sslReady);
    if (customProxyBlocks) {
        lines.push('');
        lines.push(customProxyBlocks.trimEnd());
    }

    const lanBlock = buildLanIpServerBlock(cfg, upstreamName);
    if (lanBlock) {
        lines.push('');
        lines.push(lanBlock.trimEnd());
    }

    return lines.join('\n') + '\n';
}

function assertValidNginxConfig(content, cfg) {
    if (content.includes('listen 80 ssl') || content.includes('listen [::]:80 ssl')) {
        throw new Error('Konfigurasi nginx tidak valid: SSL tidak boleh di port 80.');
    }
    if (cfg.ssl_enabled && isSslReady(cfg) && !content.includes('listen 443 ssl')) {
        throw new Error('Konfigurasi nginx tidak valid: SSL aktif tetapi port 443 tidak ditemukan.');
    }
}

function writeGeneratedConfig(cfg, tenantSubdomains) {
    ensureDataDir();
    const content = generateNginxConfig(cfg, tenantSubdomains);
    assertValidNginxConfig(content, cfg);
    fs.writeFileSync(GENERATED_CONF, content, 'utf8');
    return { path: GENERATED_CONF, content };
}

async function expandSslForSubdomains(cfg, mergedSubdomains) {
    if (!isSslReady(cfg)) {
        return { ok: true, skipped: true, message: 'SSL tidak aktif, lewati expand.' };
    }
    const expandScript = path.join(__dirname, '../../scripts/expand-ssl-domains.sh');
    if (!fs.existsSync(expandScript)) {
        return { ok: true, skipped: true, message: 'Script expand SSL tidak ditemukan.' };
    }
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const central = String(cfg.central_subdomain || 'manage').toLowerCase();
    const subs = [...new Set([
        ...(mergedSubdomains || []).filter((s) => s && s !== central),
        ...getCustomProxySslSubdomains(cfg),
    ])];
    try {
        const { stdout, stderr } = await execFileAsync(expandScript, [
            base,
            central,
            'admin@' + base,
            ...subs,
        ], { timeout: 120000 });
        return { ok: true, message: (stdout || stderr || 'SSL diperluas.').trim() };
    } catch (e) {
        const msg = (e.stderr || e.message || '').trim();
        if (msg.includes('Certificate not yet due for renewal') || msg.includes('No renewals were attempted')) {
            return { ok: true, message: 'Sertifikat SSL sudah mencakup domain.' };
        }
        console.warn('[nginxManager] expandSsl:', msg);
        return { ok: false, message: msg };
    }
}

async function syncTenantSubdomainsToConfig() {
    const tenantSubs = await fetchActiveTenantSubdomains();
    const current = loadConfig();
    const merged = getMergedSubdomainsForNginx(current, tenantSubs);
    const config = saveConfig({
        tenant_subdomains: tenantSubs,
        last_synced_at: new Date().toISOString(),
    });
    writeGeneratedConfig(config, merged);
    return { config, tenantSubdomains: tenantSubs, mergedSubdomains: merged };
}

function validateConfigBeforeApply(cfg) {
    if (cfg.ssl_enabled && !isSslReady(cfg)) {
        const ssl = getSslCertPaths(cfg);
        return {
            ok: false,
            message: `${ssl.error} Setelah certbot selesai, aktifkan SSL lagi.`,
            sslMissing: true,
        };
    }
    if (cfg.ssl_enabled) {
        const preview = generateNginxConfig(cfg, getMergedSubdomainsForNginx(cfg, cfg.tenant_subdomains));
        if (!preview.includes('listen 443 ssl')) {
            return {
                ok: false,
                message: 'Konfigurasi SSL tidak valid (port 443 tidak ditemukan). Tidak diterapkan agar nginx tidak rusak.',
            };
        }
    }
    return { ok: true };
}

async function syncTenantsAndApply(updates = {}) {
    if (Object.keys(updates).length) saveConfig(updates);
    const { config, tenantSubdomains, mergedSubdomains } = await syncTenantSubdomainsToConfig();
    const validation = validateConfigBeforeApply(config);
    if (!validation.ok) {
        saveConfig({
            last_applied_at: new Date().toISOString(),
            last_apply_ok: false,
            last_apply_message: validation.message,
        });
        return {
            ok: false,
            message: validation.message,
            sslMissing: validation.sslMissing,
            tenantCount: tenantSubdomains.length,
            tenantSubdomains,
            mergedSubdomains,
        };
    }
    const result = await applyConfig(config);
    if (!result.ok) {
        return { ...result, tenantCount: tenantSubdomains.length, tenantSubdomains, mergedSubdomains };
    }
    let sslExpand = { ok: true, skipped: true };
    if (config.ssl_enabled) {
        sslExpand = await expandSslForSubdomains(config, mergedSubdomains);
        if (sslExpand.ok && !sslExpand.skipped) {
            await applyConfig(config);
        }
    }
    saveConfig({
        last_applied_at: new Date().toISOString(),
        last_apply_ok: true,
        last_apply_message: `${result.message} ${sslExpand.message || ''}`.trim(),
    });
    return {
        ...result,
        tenantCount: tenantSubdomains.length,
        tenantSubdomains,
        mergedSubdomains,
        sslExpand,
    };
}

async function autoSyncTenants() {
    const config = loadConfig();
    if (config.auto_sync_on_tenant_change === false) {
        return { ok: true, skipped: true, message: 'Auto-sync dinonaktifkan.' };
    }
    const status = await getNginxStatus();
    if (!status.nginx_installed) {
        return { ok: true, skipped: true, message: 'Nginx belum terinstall, lewati auto-sync.' };
    }
    try {
        return await syncTenantsAndApply();
    } catch (e) {
        console.warn('[nginxManager] autoSyncTenants:', e.message);
        return { ok: false, message: e.message };
    }
}

function getTenantProxyRows(tenants, cfg) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const scheme = isSslReady(cfg) ? 'https' : 'http';
    const inProxy = new Set(getMergedSubdomainsForNginx(cfg, cfg.tenant_subdomains || []));
    return (tenants || [])
        .filter((t) => t.subdomain && !String(t.subdomain).includes('__del_'))
        .map((t) => ({
            id: t.id,
            name: t.name,
            subdomain: t.subdomain,
            status: t.status,
            hostname: `${t.subdomain}.${base}`,
            url: `${scheme}://${t.subdomain}.${base}/login`,
            inProxy: inProxy.has(sanitizeSubdomainSlug(t.subdomain)),
            proxyActive: t.status === 'active' && inProxy.has(sanitizeSubdomainSlug(t.subdomain)),
        }));
}

function getTenantProxyEntries(tenants, cfg) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const scheme = isSslReady(cfg) ? 'https' : 'http';
    const central = String(cfg.central_subdomain || 'manage').toLowerCase();
    const entries = [
        {
            label: 'Management Portal',
            subdomain: central,
            hostname: `${central}.${base}`,
            url: `${scheme}://${central}.${base}/management`,
            type: 'central',
        },
    ];
    const seen = new Set([central]);
    (tenants || []).forEach((t) => {
        if (t.status !== 'active' || !t.subdomain) return;
        seen.add(t.subdomain);
        entries.push({
            label: t.name,
            subdomain: t.subdomain,
            hostname: `${t.subdomain}.${base}`,
            url: `${scheme}://${t.subdomain}.${base}/login`,
            type: 'tenant',
            tenantId: t.id,
            source: 'tenant',
        });
    });
    (cfg.manual_subdomains || []).forEach((sub) => {
        const slug = sanitizeSubdomainSlug(sub);
        if (!slug || seen.has(slug)) return;
        seen.add(slug);
        entries.push({
            label: `Manual: ${slug}`,
            subdomain: slug,
            hostname: `${slug}.${base}`,
            url: `${scheme}://${slug}.${base}/login`,
            type: 'manual',
            source: 'manual',
            upstream: `${cfg.upstream_host}:${cfg.upstream_port}`,
        });
    });
    getActiveCustomProxies(cfg).forEach((p) => {
        if (seen.has(p.hostname)) return;
        seen.add(p.hostname);
        entries.push({
            label: p.label || `Eksternal: ${p.hostname}`,
            subdomain: p.subdomain || p.id,
            hostname: p.hostname,
            url: `${scheme}://${p.hostname}/`,
            type: 'external',
            source: 'external',
            upstream: `${p.upstream_host}:${p.upstream_port}`,
            proxyId: p.id,
            notes: p.notes,
        });
    });
    return entries;
}

function addCustomProxy(cfg, raw) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const entry = normalizeCustomProxy(raw, base);
    if (!entry) {
        throw new Error('Data proxy tidak valid. Isi hostname/subdomain dan upstream host:port.');
    }
    const list = (cfg.custom_proxies || []).filter((p) => {
        const n = normalizeCustomProxy(p, base);
        return n && n.hostname !== entry.hostname && n.id !== entry.id;
    });
    list.push(entry);
    return saveConfig({ custom_proxies: list });
}

function removeCustomProxy(cfg, proxyIdOrHost) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const key = String(proxyIdOrHost || '').toLowerCase().trim();
    const list = (cfg.custom_proxies || []).filter((p) => {
        const n = normalizeCustomProxy(p, base);
        if (!n) return false;
        return n.id !== key && n.hostname !== key && n.subdomain !== key;
    });
    return saveConfig({ custom_proxies: list });
}

function getHostsFileSnippet(entries, serverIp) {
    const ip = serverIp || 'SERVER_IP';
    return (entries || [])
        .map((e) => `${ip}  ${e.hostname}`)
        .join('\n');
}

async function runScript(args = []) {
    if (!fs.existsSync(APPLY_SCRIPT)) {
        throw new Error('Script nginx-apply.sh tidak ditemukan.');
    }
    const { stdout, stderr } = await execFileAsync('bash', [APPLY_SCRIPT, ...args], {
        timeout: 30000,
        env: { ...process.env, KALIMASADA_NGINX_CONF: GENERATED_CONF },
    });
    return { stdout: stdout || '', stderr: stderr || '' };
}

async function getNginxStatus() {
    const status = {
        nginx_installed: false,
        nginx_active: false,
        config_exists: fs.existsSync(GENERATED_CONF),
        config_json_exists: fs.existsSync(CONFIG_JSON),
        sites_enabled: false,
        version: null,
        message: '',
    };

    try {
        const { stdout } = await execFileAsync('nginx', ['-v'], { timeout: 5000 });
        status.nginx_installed = true;
        status.version = (stdout || '').trim() || 'installed';
    } catch (e) {
        status.message = (e.stderr || e.message || '').trim();
        try {
            const { stderr } = await execFileAsync('nginx', ['-v'], { timeout: 5000 });
            if (stderr) {
                status.nginx_installed = true;
                status.version = stderr.trim();
            }
        } catch (e2) {
            status.message = (e2.message || '').trim();
        }
    }

    try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', 'nginx'], { timeout: 5000 });
        status.nginx_active = stdout.trim() === 'active';
    } catch (_) {
        status.nginx_active = false;
    }

    if (fs.existsSync('/etc/nginx/sites-enabled/kalimasada-app.conf')) {
        status.sites_enabled = true;
    }

    return status;
}

async function testConfig(cfg) {
    writeGeneratedConfig(cfg);
    try {
        const result = await runScript(['test']);
        return { ok: true, message: result.stdout || 'Konfigurasi valid.', output: result.stdout };
    } catch (e) {
        return {
            ok: false,
            message: e.stderr || e.message || 'nginx -t gagal',
            output: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        };
    }
}

async function applyConfig(cfg) {
    writeGeneratedConfig(cfg);
    try {
        const result = await runScript(['apply']);
        const updated = saveConfig({
            last_applied_at: new Date().toISOString(),
            last_apply_ok: true,
            last_apply_message: result.stdout || 'Nginx berhasil diterapkan.',
        });
        return { ok: true, message: updated.last_apply_message, output: result.stdout };
    } catch (e) {
        const msg = (e.stderr || e.message || 'Gagal menerapkan konfigurasi').trim();
        saveConfig({
            last_applied_at: new Date().toISOString(),
            last_apply_ok: false,
            last_apply_message: msg,
        });
        return {
            ok: false,
            message: msg,
            output: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        };
    }
}

async function reloadNginx() {
    try {
        const result = await runScript(['reload']);
        return { ok: true, message: result.stdout || 'Nginx reload berhasil.', output: result.stdout };
    } catch (e) {
        return {
            ok: false,
            message: e.stderr || e.message || 'Reload gagal',
            output: `${e.stdout || ''}\n${e.stderr || ''}`.trim(),
        };
    }
}

function getDnsInstructions(cfg) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const publicIp = cfg.public_ip || cfg.server_ip || 'SERVER_IP';
    const lanIp = cfg.server_ip || 'LAN_IP';
    return [
        { type: 'A', host: '@', value: publicIp, note: `Apex ${base}` },
        { type: 'A', host: '*', value: publicIp, note: `Wildcard tenant (*.${base})` },
        { type: 'A', host: cfg.central_subdomain || 'manage', value: publicIp, note: 'Management portal' },
        { type: 'hosts', host: `*.${base}`, value: lanIp, note: 'Testing LAN (file hosts di PC)' },
    ];
}

async function getConnectivityDiagnostics(cfg) {
    const base = sanitizeDomain(cfg.base_domain) || 'kalimasada-app.com';
    const sampleSub = (cfg.tenant_subdomains && cfg.tenant_subdomains[0]) || 'lebakwangi';
    const hostname = `${sampleSub}.${base}`;
    const lanIp = cfg.server_ip || '192.168.166.197';
    const scheme = cfg.ssl_enabled ? 'https' : 'http';
    const port = cfg.ssl_enabled ? 443 : 80;

    const result = {
        hostname,
        sampleUrl: `${scheme}://${hostname}/login`,
        lanUrl: `http://${lanIp}/login`,
        lanUrlWithHost: `${scheme}://${hostname}/login`,
        sslEnabled: !!cfg.ssl_enabled,
        nginxPort: port,
        dnsResolved: null,
        dnsMatchesPublic: null,
        publicIp: cfg.public_ip || null,
        lanIp,
        localProxyOk: false,
        publicReachable: false,
        issues: [],
        fixes: [],
    };

    try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('getent', ['hosts', hostname], { timeout: 5000 });
        const resolved = stdout.trim().split(/\s+/)[0];
        result.dnsResolved = resolved;
        if (cfg.public_ip && resolved !== cfg.public_ip) {
            result.dnsMatchesPublic = false;
            result.issues.push(`DNS ${hostname} → ${resolved}, seharusnya → ${cfg.public_ip}`);
        } else if (cfg.public_ip) {
            result.dnsMatchesPublic = true;
        }
        if (resolved === cfg.public_ip && resolved !== lanIp) {
            result.issues.push('DNS mengarah ke IP publik. Dari jaringan LAN, akses bisa gagal tanpa port-forward atau entri hosts file.');
            result.fixes.push(`Tambah di hosts file PC: ${lanIp}  ${hostname}`);
        }
        // Cek apex domain untuk certbot
        try {
            const { stdout: apexOut } = await execFileAsync('getent', ['hosts', base], { timeout: 5000 });
            const apexIp = apexOut.trim().split(/\s+/)[0];
            if (cfg.public_ip && apexIp && apexIp !== cfg.public_ip) {
                result.issues.push(`DNS apex ${base} → ${apexIp} (SALAH, harusnya ${cfg.public_ip}). Certbot akan gagal!`);
                result.fixes.push(`Ubah record A @ ${base} → ${cfg.public_ip} di panel DNS domain`);
            }
        } catch (_) { /* ignore */ }
    } catch (_) {
        result.issues.push(`DNS ${hostname} belum ter-resolve.`);
        result.fixes.push(`Buat record A *.${base} → IP publik server, atau hosts file → ${lanIp}`);
    }

    if (!cfg.ssl_enabled) {
        result.issues.push('HTTPS belum aktif — nginx hanya listen port 80. Gunakan http:// bukan https://');
        result.fixes.push(`Akses: http://${hostname}/login`);
    }

    try {
        const http = require('http');
        const localOk = await new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: 80,
                path: '/login',
                method: 'GET',
                headers: { Host: hostname },
                timeout: 3000,
            }, (res) => {
                resolve(res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
        result.localProxyOk = localOk;
        if (!localOk) {
            result.issues.push('Nginx proxy lokal gagal — pastikan nginx aktif dan config sudah di-apply.');
        }
    } catch (_) { /* ignore */ }

    if (result.dnsResolved && cfg.public_ip && result.dnsResolved === cfg.public_ip) {
        try {
            const net = require('net');
            const reachable = await new Promise((resolve) => {
                const sock = net.connect({ host: cfg.public_ip, port: 80, timeout: 3000 }, () => {
                    sock.destroy();
                    resolve(true);
                });
                sock.on('error', () => resolve(false));
                sock.on('timeout', () => { sock.destroy(); resolve(false); });
            });
            result.publicReachable = reachable;
            if (!reachable) {
                result.issues.push(`Port 80 di IP publik ${cfg.public_ip} tidak bisa diakses (connection refused).`);
                result.fixes.push(`Forward port 80 (dan 443 untuk SSL) di router/firewall → ${lanIp}`);
                result.fixes.push(`Testing LAN: tambah hosts file ${lanIp}  ${hostname} lalu buka http://${hostname}/login`);
            }
        } catch (_) { /* ignore */ }
    }

    return result;
}

module.exports = {
    loadConfig,
    saveConfig,
    generateNginxConfig,
    writeGeneratedConfig,
    fetchActiveTenantSubdomains,
    syncTenantSubdomainsToConfig,
    syncTenantsAndApply,
    autoSyncTenants,
    getTenantProxyEntries,
    getTenantProxyRows,
    expandSslForSubdomains,
    assertValidNginxConfig,
    getHostsFileSnippet,
    getNginxStatus,
    testConfig,
    applyConfig,
    reloadNginx,
    getDnsInstructions,
    getConnectivityDiagnostics,
    checkSslCertificates,
    getSslCertPaths,
    isSslReady,
    sanitizeSubdomainSlug,
    parseManualSubdomains,
    getMergedSubdomainsForNginx,
    getActiveCustomProxies,
    normalizeCustomProxy,
    addCustomProxy,
    removeCustomProxy,
    validateConfigBeforeApply,
    GENERATED_CONF,
    CONFIG_JSON,
};
