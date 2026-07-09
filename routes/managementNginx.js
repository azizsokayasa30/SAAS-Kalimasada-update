'use strict';

const express = require('express');
const nginxManager = require('../config/platform/nginxManager');
const tenantStore = require('../config/platform/tenantStore');

const router = express.Router();

function parseCustomHosts(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((h) => String(h).trim()).filter(Boolean);
    return String(raw)
        .split(/[\n,]+/)
        .map((h) => h.trim())
        .filter(Boolean);
}

router.get('/', async (req, res) => {
    try {
        const config = nginxManager.loadConfig();
        const status = await nginxManager.getNginxStatus();
        const tenants = await tenantStore.listTenants();
        const customProxies = nginxManager.getActiveCustomProxies(config);
        const tenantProxyRows = nginxManager.getTenantProxyRows(tenants, config);
        const diagnostics = await nginxManager.getConnectivityDiagnostics(config);
        const sslStatus = nginxManager.checkSslCertificates(config);
        res.render('platform/nginx/index', {
            title: 'Reverse Proxy',
            active: 'settings-reverse-proxy',
            settingsSection: 'reverse-proxy',
            config,
            status,
            customProxies,
            tenantProxyRows,
            diagnostics,
            sslStatus,
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/nginx] index:', err);
        res.status(500).send('Gagal memuat halaman reverse proxy');
    }
});

router.post('/save', async (req, res) => {
    try {
        const body = req.body;
        const updates = {
            enabled: body.enabled === 'on' || body.enabled === 'true' || body.enabled === true,
            base_domain: body.base_domain,
            central_subdomain: body.central_subdomain,
            upstream_host: body.upstream_host,
            upstream_port: Number(body.upstream_port) || 4555,
            listen_port: Number(body.listen_port) || 80,
            ssl_enabled: body.ssl_enabled === 'on' || body.ssl_enabled === 'true',
            ssl_cert_path: body.ssl_cert_path,
            ssl_key_path: body.ssl_key_path,
            server_ip: body.server_ip,
            public_ip: body.public_ip,
            custom_hosts: parseCustomHosts(body.custom_hosts),
            manual_subdomains: nginxManager.parseManualSubdomains(body.manual_subdomains),
            auto_sync_on_tenant_change: body.auto_sync_on_tenant_change !== 'off',
        };
        const result = await nginxManager.syncTenantsAndApply(updates);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'nginx_config_applied',
            details: {
                base_domain: updates.base_domain,
                tenantCount: result.tenantCount,
                ok: result.ok,
            },
            ip: req.ip,
        });
        if (!result.ok) {
            const q = result.sslMissing ? 'error=ssl_missing' : `error=${encodeURIComponent(result.message)}`;
            return res.redirect(`/management/settings/reverse-proxy?${q}`);
        }
        return res.redirect(`/management/settings/reverse-proxy?success=synced&count=${result.tenantCount || 0}`);
    } catch (err) {
        console.error('[management/nginx] save:', err);
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/sync', async (req, res) => {
    try {
        const result = await nginxManager.syncTenantsAndApply();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'nginx_tenants_synced',
            details: { tenantCount: result.tenantCount, ok: result.ok },
            ip: req.ip,
        });
        if (!result.ok) {
            return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(result.message)}`);
        }
        return res.redirect(`/management/settings/reverse-proxy?success=synced&count=${result.tenantCount || 0}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/test', async (req, res) => {
    try {
        const config = nginxManager.loadConfig();
        const result = await nginxManager.testConfig(config);
        const q = result.ok ? 'success=test_ok' : `error=${encodeURIComponent(result.message)}`;
        if (req.headers.accept?.includes('application/json')) {
            return res.json(result);
        }
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/apply', async (req, res) => {
    try {
        const config = nginxManager.loadConfig();
        const result = await nginxManager.applyConfig(config);
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'nginx_config_applied',
            details: { ok: result.ok },
            ip: req.ip,
        });
        const q = result.ok ? 'success=applied' : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/reload', async (req, res) => {
    try {
        const result = await nginxManager.reloadNginx();
        const q = result.ok ? 'success=reloaded' : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/subdomains/add', async (req, res) => {
    try {
        const slug = nginxManager.sanitizeSubdomainSlug(req.body.subdomain);
        if (!slug) {
            return res.redirect('/management/settings/reverse-proxy?error=Subdomain+tidak+valid');
        }
        const config = nginxManager.loadConfig();
        const manual = [...new Set([...(config.manual_subdomains || []), slug])];
        nginxManager.saveConfig({ manual_subdomains: manual });
        const result = await nginxManager.syncTenantsAndApply();
        const q = result.ok
            ? `success=subdomain_added&sub=${encodeURIComponent(slug)}`
            : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/proxies/add', async (req, res) => {
    try {
        const body = req.body;
        const config = nginxManager.loadConfig();
        nginxManager.addCustomProxy(config, {
            label: body.label,
            hostname: body.hostname || body.subdomain,
            subdomain: body.subdomain,
            upstream_host: body.upstream_host,
            upstream_port: Number(body.upstream_port),
            preserve_host: body.preserve_host === 'on' || body.preserve_host === 'true',
            notes: body.notes,
        });
        const result = await nginxManager.syncTenantsAndApply();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'nginx_custom_proxy_added',
            details: {
                hostname: body.hostname || body.subdomain,
                upstream: `${body.upstream_host}:${body.upstream_port}`,
                ok: result.ok,
            },
            ip: req.ip,
        });
        const host = encodeURIComponent(body.hostname || body.subdomain || '');
        const q = result.ok
            ? `success=proxy_added&host=${host}`
            : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/proxies/remove', async (req, res) => {
    try {
        const key = String(req.body.proxy_id || req.body.hostname || '').trim();
        if (!key) {
            return res.redirect('/management/settings/reverse-proxy?error=Proxy+tidak+ditemukan');
        }
        const config = nginxManager.loadConfig();
        nginxManager.removeCustomProxy(config, key);
        const result = await nginxManager.syncTenantsAndApply();
        await tenantStore.auditLog({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'nginx_custom_proxy_removed',
            details: { key, ok: result.ok },
            ip: req.ip,
        });
        const q = result.ok ? 'success=proxy_removed' : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/subdomains/remove', async (req, res) => {
    try {
        const slug = nginxManager.sanitizeSubdomainSlug(req.body.subdomain);
        const config = nginxManager.loadConfig();
        const manual = (config.manual_subdomains || []).filter((s) => s !== slug);
        nginxManager.saveConfig({ manual_subdomains: manual });
        const result = await nginxManager.syncTenantsAndApply();
        const q = result.ok ? 'success=subdomain_removed' : `error=${encodeURIComponent(result.message)}`;
        return res.redirect(`/management/settings/reverse-proxy?${q}`);
    } catch (err) {
        return res.redirect(`/management/settings/reverse-proxy?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/preview', (req, res) => {
    try {
        const config = nginxManager.loadConfig();
        const content = nginxManager.generateNginxConfig(
            config,
            nginxManager.getMergedSubdomainsForNginx(config, config.tenant_subdomains)
        );
        res.type('text/plain').send(content);
    } catch (err) {
        res.status(500).type('text/plain').send(`# Error: ${err.message}`);
    }
});

module.exports = router;
