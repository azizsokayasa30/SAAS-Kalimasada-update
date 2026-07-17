'use strict';

const express = require('express');
const tenantStore = require('../config/platform/tenantStore');
const vpnService = require('../config/platform/vpnService');
const { platformAuth } = require('../middleware/platformAuth');

const router = express.Router();

router.use(platformAuth);

function safeAudit(payload) {
    return tenantStore.auditLog(payload).catch((err) => {
        console.warn('[management/vpn] audit:', err.message);
    });
}

function mikrotikScriptFilename(peer) {
    const safeName = String(peer.name || 'peer')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'peer';
    const prefix = vpnService.normalizeProtocol(peer.protocol) === 'l2tp' ? 'mikrotik-l2tp' : 'mikrotik-wg';
    return `${prefix}-${safeName}.rsc`;
}

// ── VPN Server settings (WireGuard + L2TP/IPsec) ──
router.get('/', async (req, res) => {
    try {
        const [server, peers, vps, vpsL2tp] = await Promise.all([
            vpnService.getServer(),
            vpnService.listPeers(),
            vpnService.getVpsSetupScript(),
            vpnService.getVpsL2tpSetupScript(),
        ]);
        const wgPeers = (peers || []).filter((p) => vpnService.normalizeProtocol(p.protocol) === 'wireguard');
        const l2tpPeers = (peers || []).filter((p) => vpnService.normalizeProtocol(p.protocol) === 'l2tp');
        res.render('platform/vpn/index', {
            title: 'VPN Server',
            active: 'vpn-server',
            vpnSection: 'server',
            server,
            peers,
            wgPeers,
            l2tpPeers,
            vpsScript: vps.script,
            vpsL2tpScript: vpsL2tp.script,
            wgReady: vpnService.isVpnServerReady(server),
            l2tpReady: vpnService.isL2tpServerReady(server),
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/vpn] server page:', err);
        res.status(500).send('Error loading VPN server settings');
    }
});

router.post('/', async (req, res) => {
    try {
        const server = await vpnService.saveServer(req.body);
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_server_updated',
            details: {
                id: server.id,
                public_endpoint: server.public_endpoint,
                listen_port: server.listen_port,
                tunnel_address: server.tunnel_address,
                interface_name: server.interface_name,
                l2tp_enabled: server.l2tp_enabled,
                has_ipsec_psk: !!server.ipsec_psk,
            },
            ip: req.ip,
        });
        res.redirect('/management/vpn?success=saved');
    } catch (err) {
        console.error('[management/vpn] save server:', err);
        res.redirect(`/management/vpn?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/generate-keys', async (req, res) => {
    try {
        const server = await vpnService.generateAndSaveKeys();
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_keys_generated',
            details: { id: server.id, has_public_key: !!server.server_public_key },
            ip: req.ip,
        });
        res.redirect('/management/vpn?success=keys');
    } catch (err) {
        console.error('[management/vpn] generate keys:', err);
        res.redirect(`/management/vpn?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/generate-ipsec-psk', async (req, res) => {
    try {
        const server = await vpnService.generateAndSaveIpsecPsk();
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_ipsec_psk_generated',
            details: { id: server.id, has_ipsec_psk: !!server.ipsec_psk },
            ip: req.ip,
        });
        res.redirect('/management/vpn?success=psk');
    } catch (err) {
        console.error('[management/vpn] generate ipsec psk:', err);
        res.redirect(`/management/vpn?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/vps-script', async (req, res) => {
    try {
        const { script, server } = await vpnService.getVpsSetupScript();
        const iface = server.interface_name || 'wg0';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="vps-wireguard-${iface}.sh"`);
        res.send(script);
    } catch (err) {
        console.error('[management/vpn] vps script:', err);
        res.status(500).send('Gagal generate script VPS');
    }
});

router.get('/vps-l2tp-script', async (req, res) => {
    try {
        const { script } = await vpnService.getVpsL2tpSetupScript();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="vps-l2tp-ipsec.sh"');
        res.send(script);
    } catch (err) {
        console.error('[management/vpn] vps l2tp script:', err);
        res.status(500).send('Gagal generate script VPS L2TP');
    }
});

// ── Devices / peers ──
router.get('/devices', async (req, res) => {
    try {
        const [server, status, nextTunnelIp, tenants] = await Promise.all([
            vpnService.getServer(),
            vpnService.getDevicesStatus(),
            vpnService.allocateNextTunnelIp().catch(() => null),
            tenantStore.listOperationalTenants().catch(() => []),
        ]);
        res.render('platform/vpn/devices', {
            title: 'Perangkat VPN',
            active: 'vpn-devices',
            vpnSection: 'devices',
            server,
            status,
            devices: status.devices,
            nextTunnelIp,
            tenants: tenants || [],
            wgReady: vpnService.isVpnServerReady(server),
            l2tpReady: vpnService.isL2tpServerReady(server),
            adminName: req.session.platformAdminName,
            flash: req.query,
        });
    } catch (err) {
        console.error('[management/vpn] devices:', err);
        res.status(500).send('Error loading VPN devices');
    }
});

router.get('/api/status', async (req, res) => {
    try {
        const status = await vpnService.getDevicesStatus();
        res.json({ success: true, ...status });
    } catch (err) {
        console.error('[management/vpn] api status:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/api/next-ip', async (req, res) => {
    try {
        const tunnelIp = await vpnService.allocateNextTunnelIp();
        res.json({ success: true, tunnelIp });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

router.post('/api/generate-peer-keys', async (req, res) => {
    try {
        const keys = await vpnService.generateKeypair();
        res.json({ success: true, publicKey: keys.publicKey, privateKey: keys.privateKey });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/peers', async (req, res) => {
    try {
        const peer = await vpnService.createPeer(req.body);
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_peer_created',
            details: {
                id: peer.id,
                name: peer.name,
                tunnel_ip: peer.tunnel_ip,
                protocol: peer.protocol,
                routeros_version: peer.routeros_version,
            },
            ip: req.ip,
        });
        res.redirect('/management/vpn/devices?success=created');
    } catch (err) {
        console.error('[management/vpn] create peer:', err);
        res.redirect(`/management/vpn/devices?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/peers/:id', async (req, res) => {
    try {
        const peer = await vpnService.updatePeer(req.params.id, req.body);
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_peer_updated',
            details: {
                id: peer.id,
                name: peer.name,
                tunnel_ip: peer.tunnel_ip,
                protocol: peer.protocol,
            },
            ip: req.ip,
        });
        res.redirect('/management/vpn/devices?success=updated');
    } catch (err) {
        console.error('[management/vpn] update peer:', err);
        res.redirect(`/management/vpn/devices?error=${encodeURIComponent(err.message)}`);
    }
});

router.post('/peers/:id/delete', async (req, res) => {
    try {
        await vpnService.deletePeer(req.params.id);
        await safeAudit({
            actorType: 'SuperAdmin',
            actorId: req.session.platformAdminId,
            action: 'vpn_peer_deleted',
            details: { id: Number(req.params.id) },
            ip: req.ip,
        });
        res.redirect('/management/vpn/devices?success=deleted');
    } catch (err) {
        console.error('[management/vpn] delete peer:', err);
        res.redirect(`/management/vpn/devices?error=${encodeURIComponent(err.message)}`);
    }
});

router.get('/peers/:id/mikrotik-script', async (req, res) => {
    try {
        const { script, peer } = await vpnService.getMikrotikScript(req.params.id);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${mikrotikScriptFilename(peer)}"`);
        res.send(script);
    } catch (err) {
        console.error('[management/vpn] mikrotik script:', err);
        res.redirect(`/management/vpn/devices?error=${encodeURIComponent(err.message)}`);
    }
});

module.exports = router;
