#!/usr/bin/env node

/**
 * Generator script Mikrotik untuk sistem isolir terpusat.
 *
 * Hasil script membuat walled garden:
 * - pelanggan isolir tetap bisa membuka halaman isolir di port 8899,
 * - pelanggan isolir tetap bisa membuka aplikasi billing utama,
 * - pelanggan isolir tetap bisa menghubungi WhatsApp,
 * - traffic lain diarahkan ke halaman isolir atau diblokir.
 */

const fs = require('fs');
const path = require('path');
const { getSetting } = require('../config/settingsManager');
const { getPublicAppBaseUrl } = require('../config/public-endpoint');

function stripProtocol(value) {
    return String(value || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

function isIpAddress(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function normalizeCidr(value, fallback = '192.168.200.0/24') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    if (raw.includes('/')) return raw;
    if (raw.includes('-')) {
        const first = raw.split('-')[0].trim();
        const parts = first.split('.');
        return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : fallback;
    }
    if (isIpAddress(raw)) {
        const parts = raw.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return fallback;
}

function cidrToPoolRange(cidrOrRange) {
    const raw = String(cidrOrRange || '').trim();
    if (raw.includes('-')) return raw;
    if (!raw.includes('/')) {
        const parts = raw.split('.');
        return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.2-${parts[0]}.${parts[1]}.${parts[2]}.254` : '192.168.200.2-192.168.200.254';
    }

    const [ip, prefixRaw] = raw.split('/');
    const prefix = parseInt(prefixRaw, 10);
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || !Number.isFinite(prefix) || prefix < 8 || prefix > 30) {
        return '192.168.200.2-192.168.200.254';
    }

    const hostCount = 2 ** (32 - prefix);
    const start = [...parts];
    const end = [...parts];
    start[3] = Math.min(start[3] + 2, 254);
    end[3] = Math.min(parts[3] + hostCount - 2, 254);
    return `${start.join('.')}-${end.join('.')}`;
}

function gatewayFromCidr(cidr) {
    const raw = String(cidr || '').split('/')[0];
    const parts = raw.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return '192.168.200.1';
    parts[3] = Math.min(parts[3] + 1, 254);
    return parts.join('.');
}

function parsePublicEndpoint() {
    const baseUrl = getPublicAppBaseUrl();
    try {
        const url = new URL(baseUrl);
        return {
            baseUrl,
            host: url.hostname,
            port: url.port || (url.protocol === 'https:' ? '443' : '80'),
            scheme: url.protocol.replace(':', '')
        };
    } catch (_) {
        return {
            baseUrl,
            host: stripProtocol(baseUrl) || String(getSetting('server_host', '192.168.1.2')),
            port: String(getSetting('server_port', process.env.PORT || 4555)),
            scheme: 'http'
        };
    }
}

class MikrotikIsolationScriptGenerator {
    constructor(options = {}) {
        const publicEndpoint = parsePublicEndpoint();
        const configuredServerIp =
            options.billingServerIp ||
            process.env.ISOLIR_BILLING_SERVER_IP ||
            getSetting('isolir_billing_server_ip', '') ||
            getSetting('billing_server_ip', '') ||
            (isIpAddress(publicEndpoint.host) ? publicEndpoint.host : '') ||
            (isIpAddress(getSetting('server_host', '')) ? getSetting('server_host', '') : '');

        this.config = {
            companyName: getSetting('company_header', 'Billing System'),
            isolirRange: normalizeCidr(options.isolirRange || getSetting('isolir_ip_range', getSetting('isolir_pool_range', '192.168.200.0/24'))),
            isolirPoolName: options.isolirPoolName || getSetting('isolir_pool', 'isolir-pool'),
            isolirProfile: options.isolirProfile || getSetting('isolir_profile', 'isolir'),
            isolirPagePort: String(options.isolirPagePort || process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899)),
            billingAppPort: String(options.billingAppPort || publicEndpoint.port || getSetting('server_port', process.env.PORT || 4555)),
            billingHost: options.billingHost || publicEndpoint.host || getSetting('server_host', 'billing.local'),
            billingBaseUrl: publicEndpoint.baseUrl,
            billingServerIp: configuredServerIp || 'GANTI_IP_SERVER_BILLING',
            includePppProfile: options.includePppProfile !== false
        };

        this.config.poolRange = cidrToPoolRange(this.config.isolirRange);
        this.config.localAddress = gatewayFromCidr(this.config.isolirRange);
        this.scriptContent = [];
    }

    add(...lines) {
        this.scriptContent.push(...lines);
    }

    filterTop(chain, params) {
        return [
            `:local firstFilter [/ip firewall filter find where chain=${chain}]`,
            ':if ([:len $firstFilter] > 0) do={',
            '    :local target [:pick $firstFilter 0]',
            `    /ip firewall filter add chain=${chain} ${params} place-before=$target`,
            '} else={',
            `    /ip firewall filter add chain=${chain} ${params}`,
            '}'
        ];
    }

    natTop(chain, params) {
        return [
            `:local firstNat [/ip firewall nat find where chain=${chain}]`,
            ':if ([:len $firstNat] > 0) do={',
            '    :local target [:pick $firstNat 0]',
            `    /ip firewall nat add chain=${chain} ${params} place-before=$target`,
            '} else={',
            `    /ip firewall nat add chain=${chain} ${params}`,
            '}'
        ];
    }

    addHeader() {
        const c = this.config;
        this.add(
            '# ========================================',
            '# BILLING ISOLIR WALLED GARDEN',
            '# Generated by Gembok Bill System',
            `# Provider: ${c.companyName}`,
            `# Generated: ${new Date().toISOString()}`,
            '# ========================================',
            '',
            '# Tujuan:',
            '# - Pelanggan isolir tetap bisa membuka portal billing dan halaman isolir.',
            '# - Pelanggan isolir tetap bisa membuka WhatsApp untuk kirim bukti bayar.',
            '# - Traffic lain dibatasi/diarahkan ke halaman isolir.',
            '',
            `# Range isolir       : ${c.isolirRange}`,
            `# Pool isolir        : ${c.isolirPoolName} (${c.poolRange})`,
            `# Profile PPP isolir : ${c.isolirProfile}`,
            `# IP server billing  : ${c.billingServerIp}`,
            `# Port halaman isolir: ${c.isolirPagePort}`,
            `# Port billing utama : ${c.billingAppPort}`,
            `# Host billing       : ${c.billingHost}`,
            '',
            '# PENTING: jika IP server billing masih GANTI_IP_SERVER_BILLING, edit dulu sebelum import.',
            ''
        );
    }

    addCleanup() {
        this.add(
            '# 1. Cleanup rule lama dari generator ini',
            '/ip firewall filter remove [find where comment~"BILLING-ISOLIR"]',
            '/ip firewall nat remove [find where comment~"BILLING-ISOLIR"]',
            '/ip firewall address-list remove [find where comment~"BILLING-ISOLIR"]',
            '/ip dns static remove [find where comment~"BILLING-ISOLIR"]',
            '# Cleanup rule isolir generator lama yang bisa mendrop sebelum rule baru.',
            '/ip firewall filter remove [find where comment~"Generate BILLING - Isolir"]',
            '/ip firewall filter remove [find where comment~"isolir-allow"]',
            '/ip firewall filter remove [find where comment~"isolir-block"]',
            '/ip firewall nat remove [find where comment~"Generate BILLING - Isolir"]',
            '/ip firewall nat remove [find where comment~"isolir-redirect"]',
            '',
            '/ip dns set allow-remote-requests=yes',
            ''
        );
    }

    addLists() {
        const c = this.config;
        const whatsappHosts = [
            'wa.me',
            'whatsapp.com',
            'web.whatsapp.com',
            'api.whatsapp.com',
            'static.whatsapp.net',
            'whatsapp.net',
            'graph.whatsapp.com',
            'mmg.whatsapp.net',
            'pps.whatsapp.net',
            'media.whatsapp.net',
            'mmg-fna.whatsapp.net',
            'g.whatsapp.net',
            'v.whatsapp.net',
            'scontent.whatsapp.net',
            'facebook.com',
            'fbcdn.net',
            'fbsbx.com'
        ];

        this.add(
            '# 2. Address-list pelanggan isolir dan tujuan yang boleh diakses',
            `/ip firewall address-list add list=isolir-users address=${c.isolirRange} comment="BILLING-ISOLIR users range"`,
            `/ip firewall address-list add list=isolir-allowed-dst address=${c.billingServerIp} comment="BILLING-ISOLIR billing server"`,
            ...(isIpAddress(c.billingHost)
                ? []
                : [`/ip firewall address-list add list=isolir-allowed-dst address=${c.billingHost} comment="BILLING-ISOLIR billing host DNS"`]),
            ...whatsappHosts.map((host) => `/ip firewall address-list add list=isolir-allowed-dst address=${host} comment="BILLING-ISOLIR whatsapp ${host}"`),
            ''
        );
    }

    addPppProfile() {
        if (!this.config.includePppProfile) return;
        const c = this.config;
        this.add(
            '# 3. Pool dan profile PPP isolir',
            `/ip pool remove [find where name="${c.isolirPoolName}"]`,
            `/ip pool add name="${c.isolirPoolName}" ranges=${c.poolRange} comment="BILLING-ISOLIR pool"`,
            `/ppp profile remove [find where name="${c.isolirProfile}" and comment~"BILLING-ISOLIR"]`,
            `/ppp profile add name="${c.isolirProfile}" local-address=${c.localAddress} remote-address=${c.isolirPoolName} dns-server=${c.localAddress} only-one=yes comment="BILLING-ISOLIR profile"`,
            ''
        );
    }

    addDnsRules() {
        const c = this.config;
        const captiveHosts = [
            'captive.apple.com',
            'www.apple.com',
            'connectivitycheck.gstatic.com',
            'clients3.google.com',
            'www.msftconnecttest.com',
            'dns.msftncsi.com',
            'detectportal.firefox.com',
            'neverssl.com',
            'example.com'
        ];
        this.add(
            '# 4. DNS captive portal + allow DNS ke router',
            '# Host deteksi captive portal diarahkan ke IP server billing agar HP memunculkan halaman isolir.',
            ...captiveHosts.map((host) => `/ip dns static add name=${host} address=${c.billingServerIp} ttl=30s comment="BILLING-ISOLIR captive ${host}"`),
            '',
            '# Urutan insert: drop dulu, lalu allow DNS/billing/WA/established di atasnya.',
            ...this.filterTop('forward', `src-address=${c.isolirRange} action=drop comment="BILLING-ISOLIR drop all other traffic"`),
            ...this.filterTop('forward', `src-address=${c.isolirRange} protocol=udp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns udp forward"`),
            ...this.filterTop('forward', `src-address=${c.isolirRange} protocol=tcp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns tcp forward"`),
            ...this.filterTop('input', `src-address=${c.isolirRange} protocol=udp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns udp to router"`),
            ...this.filterTop('input', `src-address=${c.isolirRange} protocol=tcp dst-port=53 action=accept comment="BILLING-ISOLIR allow dns tcp to router"`),
            ''
        );
    }

    addNatRules() {
        const c = this.config;
        this.add(
            '# 5. NAT: DNS dipaksa ke router; HTTP dipaksa ke portal isolir (di atas bypass)',
            ...this.natTop('srcnat', `src-address=${c.isolirRange} dst-address=${c.billingServerIp} action=masquerade comment="BILLING-ISOLIR masquerade to billing server"`),
            ...this.natTop('dstnat', `src-address=${c.isolirRange} dst-address-list=isolir-allowed-dst protocol=tcp action=accept comment="BILLING-ISOLIR bypass allowed destinations"`),
            ...this.natTop('dstnat', `src-address=${c.isolirRange} protocol=tcp dst-port=80,8080,8000,8888 action=dst-nat to-addresses=${c.billingServerIp} to-ports=${c.isolirPagePort} comment="BILLING-ISOLIR force http to isolir page"`),
            ...this.natTop('dstnat', `src-address=${c.isolirRange} protocol=udp dst-port=53 action=redirect to-ports=53 comment="BILLING-ISOLIR force dns udp to router"`),
            ...this.natTop('dstnat', `src-address=${c.isolirRange} protocol=tcp dst-port=53 action=redirect to-ports=53 comment="BILLING-ISOLIR force dns tcp to router"`),
            '# Catatan HTTPS: browser tidak bisa dipaksa menampilkan halaman HTTP tanpa sertifikat domain tujuan.',
            '# HTTPS non-whitelist di-drop; buka http://neverssl.com untuk tes halaman isolir.',
            ''
        );
    }

    addFilterRules() {
        const c = this.config;
        const billingPorts = Array.from(new Set([c.isolirPagePort, c.billingAppPort, '80', '443'].filter(Boolean))).join(',');
        this.add(
            '# 6. Firewall forward: allow yang dibutuhkan (di atas drop yang sudah dibuat di langkah DNS)',
            ...this.filterTop('forward', `src-address=${c.isolirRange} dst-address-list=isolir-allowed-dst protocol=tcp dst-port=80,443,5222,5223,5228,4244 action=accept comment="BILLING-ISOLIR allow whatsapp and allowed web"`),
            ...this.filterTop('forward', `src-address=${c.isolirRange} dst-address=${c.billingServerIp} protocol=tcp dst-port=${billingPorts} action=accept comment="BILLING-ISOLIR allow billing app and isolir page"`),
            ...this.filterTop('forward', 'connection-state=established,related action=accept comment="BILLING-ISOLIR allow established"'),
            '',
            '# Untuk isolir IP statik, pastikan rule allow di atas berada sebelum rule drop blocked_customers.',
            '# Jika memakai address-list blocked_customers, contoh rule drop yang aman:',
            '# /ip firewall filter add chain=forward src-address-list=blocked_customers action=drop comment="BILLING-ISOLIR blocked_customers drop after whitelist"',
            ''
        );
    }

    addVerification() {
        const c = this.config;
        this.add(
            '# 7. Verifikasi',
            ':put "=== BILLING ISOLIR WALLED GARDEN READY ==="',
            `:put "Halaman isolir: http://${c.billingServerIp}:${c.isolirPagePort}/isolir"`,
            `:put "Tes captive   : http://neverssl.com"`,
            `:put "Portal billing : ${c.billingBaseUrl}"`,
            ':put "Cek address-list: /ip firewall address-list print where comment~\\"BILLING-ISOLIR\\""',
            ':put "Cek filter      : /ip firewall filter print where comment~\\"BILLING-ISOLIR\\""',
            ':put "Cek nat         : /ip firewall nat print where comment~\\"BILLING-ISOLIR\\""',
            ''
        );
    }

    generateScript() {
        this.scriptContent = [];
        this.addHeader();
        this.addCleanup();
        this.addLists();
        this.addPppProfile();
        this.addDnsRules();
        this.addNatRules();
        this.addFilterRules();
        this.addVerification();
        return this.scriptContent.join('\n');
    }

    saveScript(filename = 'mikrotik-isolation-setup.rsc') {
        const script = this.generateScript();
        const filepath = path.join(__dirname, '..', filename);
        fs.writeFileSync(filepath, script, 'utf8');
        console.log(`Script Mikrotik berhasil dibuat: ${filepath}`);
        return filepath;
    }

    printScript() {
        console.log(this.generateScript());
    }
}

function generateScriptFromSettings() {
    const generator = new MikrotikIsolationScriptGenerator();
    const c = generator.config;
    console.log('Konfigurasi isolir:');
    console.log(`  Range isolir       : ${c.isolirRange}`);
    console.log(`  IP server billing  : ${c.billingServerIp}`);
    console.log(`  Port isolir        : ${c.isolirPagePort}`);
    console.log(`  Port billing utama : ${c.billingAppPort}`);
    console.log(`  Host billing       : ${c.billingHost}`);
    console.log('');
    return generator;
}

if (require.main === module) {
    try {
        console.log('Generating Mikrotik isolation walled-garden script...\n');
        const generator = generateScriptFromSettings();
        const filepath = generator.saveScript();
        console.log(`\nFile: ${filepath}`);
        console.log('\nCatatan: jika IP server billing belum benar, set setting isolir_billing_server_ip atau env ISOLIR_BILLING_SERVER_IP lalu generate ulang.');
        console.log('\nPreview:\n');
        generator.printScript();
    } catch (error) {
        console.error('Error generating script:', error.message);
        process.exit(1);
    }
}

module.exports = MikrotikIsolationScriptGenerator;
