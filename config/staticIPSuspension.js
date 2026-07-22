const logger = require('./logger');
const { getMikrotikConnectionForCustomer } = require('./mikrotik');
const { getSetting } = require('./settingsManager');
const { getPublicAppBaseUrl } = require('./public-endpoint');
const { getCustomerStaticIp } = require('./staticIPProvisioning');

/** Address-list Isolir static IP (redirect ke halaman isolir). Bukan static_pool_blocked. */
const ISOLIR_LIST = 'isolir_customer';
const LEGACY_ISOLIR_LIST = 'blocked_customers';

function isIpAddress(value) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}

function getBillingWalledGardenConfig() {
    let host = String(getSetting('server_host', '') || '').trim();
    let port = String(getSetting('server_port', process.env.PORT || 4555));
    try {
        const url = new URL(getPublicAppBaseUrl());
        host = url.hostname || host;
        port = url.port || (url.protocol === 'https:' ? '443' : '80');
    } catch (_) {}

    const billingServerIp =
        String(process.env.ISOLIR_BILLING_SERVER_IP || '').trim() ||
        String(getSetting('isolir_billing_server_ip', '') || '').trim() ||
        String(getSetting('billing_server_ip', '') || '').trim() ||
        (isIpAddress(host) ? host : '');

    return {
        billingServerIp,
        billingHost: host,
        billingPorts: Array.from(new Set([
            String(process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899)),
            String(port || ''),
            '80',
            '443'
        ].filter(Boolean))).join(','),
        whatsappHosts: [
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
        ]
    };
}

/**
 * Static IP Suspension Manager
 * Menangani isolir untuk pelanggan dengan IP statik (bukan PPPoE)
 */
class StaticIPSuspensionManager {
    constructor() {
        this.suspensionMethods = {
            ADDRESS_LIST: 'address_list',
            DHCP_BLOCK: 'dhcp_block', 
            BANDWIDTH_LIMIT: 'bandwidth_limit',
            FIREWALL_RULE: 'firewall_rule'
        };
    }

    /**
     * Suspend pelanggan dengan IP statik
     * @param {Object} customer - Data pelanggan
     * @param {string} reason - Alasan suspend
     * @param {string} method - Metode suspend (default: address_list)
     */
    async suspendStaticIPCustomer(customer, reason = 'Telat bayar', method = 'address_list') {
        try {
            logger.info(`Suspending static IP customer: ${customer.username} (${reason})`);

            const results = {
                mikrotik: false,
                method_used: null,
                customer_ip: null,
                mac_address: null
            };

            const customerIP = getCustomerStaticIp(customer) || customer.ip_address || null;
            const macAddress = customer.mac_address;

            if (!customerIP && !macAddress) {
                throw new Error('Customer tidak memiliki IP statik atau MAC address yang terdaftar');
            }

            results.customer_ip = customerIP;
            results.mac_address = macAddress;

            // Pilih metode suspend berdasarkan parameter
            switch (method) {
                case this.suspensionMethods.ADDRESS_LIST:
                    if (customerIP) {
                        const result = await this.suspendByAddressList(customer, reason);
                        results.mikrotik = result.success;
                        results.method_used = 'address_list';
                    }
                    break;

                case this.suspensionMethods.DHCP_BLOCK:
                    if (macAddress) {
                        const result = await this.suspendByDHCPBlock(customer, reason);
                        results.mikrotik = result.success;
                        results.method_used = 'dhcp_block';
                    }
                    break;

                case this.suspensionMethods.BANDWIDTH_LIMIT:
                    if (customerIP) {
                        const result = await this.suspendByBandwidthLimit(customer, reason);
                        results.mikrotik = result.success;
                        results.method_used = 'bandwidth_limit';
                    }
                    break;

                case this.suspensionMethods.FIREWALL_RULE:
                    if (customerIP) {
                        const result = await this.suspendByFirewallRule(customer, reason);
                        results.mikrotik = result.success;
                        results.method_used = 'firewall_rule';
                    }
                    break;

                default:
                    throw new Error(`Metode suspend tidak dikenal: ${method}`);
            }

            // Update status pelanggan di database billing
            if (results.mikrotik) {
                try {
                    const billingManager = require('./billing');
                    await billingManager.setCustomerStatusById(customer.id, 'suspended', { skipRadiusSync: true });
                    results.billing = true;
                    logger.info(`Customer ${customer.username} status updated to suspended in billing`);
                } catch (billingError) {
                    logger.error('Error updating customer status in billing:', billingError);
                }
            }

            return {
                success: results.mikrotik,
                results,
                message: results.mikrotik ? 
                    `Static IP customer suspended using ${results.method_used}` : 
                    'Failed to suspend static IP customer'
            };

        } catch (error) {
            logger.error('Error in suspendStaticIPCustomer:', error);
            return {
                success: false,
                error: error.message,
                results: null
            };
        }
    }

    /**
     * Metode 1: Suspend menggunakan Address List (Paling Efektif)
     */
    async suspendByAddressList(customer, reason) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const customerIP = getCustomerStaticIp(customer);
            if (!customerIP) {
                return { success: false, error: 'No static IP' };
            }

            await this.ensureIsolirCustomerSetup(customer);

            const existingEntries = await mikrotik.write('/ip/firewall/address-list/print', [
                `?list=${ISOLIR_LIST}`,
                `?address=${customerIP}`
            ]);

            if (existingEntries && existingEntries.length > 0) {
                logger.warn(`IP ${customerIP} already in ${ISOLIR_LIST}`);
                return { success: true, message: 'Already isolir' };
            }

            await mikrotik.write('/ip/firewall/address-list/add', [
                `=list=${ISOLIR_LIST}`,
                `=address=${customerIP}`,
                `=comment=SUSPENDED - ${reason} - ${new Date().toISOString()}`
            ]);

            // Bersihkan entry legacy jika ada
            try {
                const legacy = await mikrotik.write('/ip/firewall/address-list/print', [
                    `?list=${LEGACY_ISOLIR_LIST}`,
                    `?address=${customerIP}`
                ]);
                for (const row of legacy || []) {
                    await mikrotik.write('/ip/firewall/address-list/remove', [`=.id=${row['.id']}`]);
                }
            } catch (_) {}

            logger.info(`Static IP ${customerIP} added to ${ISOLIR_LIST}`);
            return { success: true, message: 'Added to isolir_customer' };

        } catch (error) {
            logger.error('Error in suspendByAddressList:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Metode 2: Suspend menggunakan DHCP Block
     */
    async suspendByDHCPBlock(customer, reason) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);

            // Cari DHCP lease berdasarkan MAC address
            const leases = await mikrotik.write('/ip/dhcp-server/lease/print', [
                `?mac-address=${customer.mac_address}`
            ]);

            if (!leases || leases.length === 0) {
                throw new Error(`DHCP lease not found for MAC ${customer.mac_address}`);
            }

            const lease = leases[0];

            // Block DHCP lease
            await mikrotik.write('/ip/dhcp-server/lease/set', [
                `=.id=${lease['.id']}`,
                '=blocked=yes',
                `=comment=SUSPENDED - ${reason} - ${new Date().toISOString()}`
            ]);

            logger.info(`DHCP lease blocked for MAC ${customer.mac_address}`);
            return { success: true, message: 'DHCP lease blocked' };

        } catch (error) {
            logger.error('Error in suspendByDHCPBlock:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Metode 3: Suspend menggunakan Bandwidth Limit (Soft Isolation)
     * Prefer existing package queue cust_<id>; fallback suspended_<ip> for legacy.
     */
    async suspendByBandwidthLimit(customer, reason) {
        try {
            const customerIP = customer.static_ip || customer.ip_address || customer.assigned_ip;
            if (!customerIP) {
                return { success: false, error: 'No static IP' };
            }

            const limitSpeed = getSetting('suspension_bandwidth_limit', '1k/1k'); // Default 1KB/s

            // Prefer package-speed queue cust_<id> if present
            if (customer.id != null) {
                try {
                    const { applySuspensionBandwidthToPackageQueue } = require('./staticIPProvisioning');
                    const applied = await applySuspensionBandwidthToPackageQueue(customer, limitSpeed, reason);
                    if (applied && applied.success) {
                        return { success: true, message: 'Bandwidth limited via package queue', queue: applied.queue };
                    }
                } catch (e) {
                    logger.warn(`Soft-isolir via cust_* queue failed, fallback suspended_*: ${e.message}`);
                }
            }

            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const queueName = `suspended_${String(customerIP).replace(/\./g, '_')}`;

            // Cek apakah queue sudah ada
            const existingQueues = await mikrotik.write('/queue/simple/print', [
                `?name=${queueName}`
            ]);

            if (existingQueues && existingQueues.length > 0) {
                await mikrotik.write('/queue/simple/set', [
                    `=.id=${existingQueues[0]['.id']}`,
                    `=max-limit=${limitSpeed}`,
                    `=comment=SUSPENDED - ${reason} - ${new Date().toISOString()}`,
                    '=disabled=no'
                ]);
                logger.info(`Updated suspension queue ${queueName} to ${limitSpeed}`);
                return { success: true, message: 'Queue updated' };
            }

            // Buat queue untuk limit bandwidth
            await mikrotik.write('/queue/simple/add', [
                `=name=${queueName}`,
                `=target=${customerIP}`,
                `=max-limit=${limitSpeed}`,
                `=comment=SUSPENDED - ${reason} - ${new Date().toISOString()}`,
                '=disabled=no'
            ]);

            logger.info(`Bandwidth limited for IP ${customerIP} to ${limitSpeed}`);
            return { success: true, message: 'Bandwidth limited' };

        } catch (error) {
            logger.error('Error in suspendByBandwidthLimit:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Metode 4: Suspend menggunakan Firewall Rule Individual
     */
    async suspendByFirewallRule(customer, reason) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);

            const ruleName = `block_${customer.static_ip.replace(/\./g, '_')}`;

            // Cek apakah rule sudah ada
            const existingRules = await mikrotik.write('/ip/firewall/filter/print', [
                `?src-address=${customer.static_ip}`,
                '?action=drop'
            ]);

            if (existingRules && existingRules.length > 0) {
                logger.warn(`Firewall rule for ${customer.static_ip} already exists`);
                return { success: true, message: 'Rule already exists' };
            }

            // Buat firewall rule untuk block IP spesifik
            await mikrotik.write('/ip/firewall/filter/add', [
                '=chain=forward',
                `=src-address=${customer.static_ip}`,
                '=action=drop',
                `=comment=SUSPENDED ${ruleName} - ${reason} - ${new Date().toISOString()}`
            ]);

            logger.info(`Firewall rule created to block IP ${customer.static_ip}`);
            return { success: true, message: 'Firewall rule created' };

        } catch (error) {
            logger.error('Error in suspendByFirewallRule:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Restore pelanggan dengan IP statik
     */
    async restoreStaticIPCustomer(customer, reason = 'Manual restore') {
        try {
            logger.info(`Restoring static IP customer: ${customer.username} (${reason})`);

            const results = {
                mikrotik: false,
                methods_tried: []
            };

            const customerIP = customer.static_ip || customer.ip_address || customer.assigned_ip;
            const macAddress = customer.mac_address;

            if (!customerIP && !macAddress) {
                throw new Error('Customer tidak memiliki IP statik atau MAC address yang terdaftar');
            }

            // Coba semua metode restore
            if (customerIP) {
                // 1. Remove dari address list
                const addressListResult = await this.restoreFromAddressList(customer);
                if (addressListResult.success) {
                    results.mikrotik = true;
                    results.methods_tried.push('address_list_removed');
                }

                // 2. Remove bandwidth limit
                const bandwidthResult = await this.restoreFromBandwidthLimit(customer);
                if (bandwidthResult.success) {
                    results.mikrotik = true;
                    results.methods_tried.push('bandwidth_limit_removed');
                }

                // 3. Remove firewall rule
                const firewallResult = await this.restoreFromFirewallRule(customer);
                if (firewallResult.success) {
                    results.mikrotik = true;
                    results.methods_tried.push('firewall_rule_removed');
                }
            }

            if (macAddress) {
                // 4. Unblock DHCP lease
                const dhcpResult = await this.restoreFromDHCPBlock(customer);
                if (dhcpResult.success) {
                    results.mikrotik = true;
                    results.methods_tried.push('dhcp_unblocked');
                }
            }

            // Update status pelanggan di database billing
            if (results.mikrotik) {
                try {
                    const billingManager = require('./billing');
                    await billingManager.setCustomerStatusById(customer.id, 'active', { skipRadiusSync: true });
                    results.billing = true;
                    logger.info(`Customer ${customer.username} status updated to active in billing`);
                } catch (billingError) {
                    logger.error('Error updating customer status in billing:', billingError);
                }
            }

            return {
                success: results.mikrotik,
                results,
                message: results.mikrotik ? 
                    `Static IP customer restored. Methods: ${results.methods_tried.join(', ')}` : 
                    'No suspension found for this customer'
            };

        } catch (error) {
            logger.error('Error in restoreStaticIPCustomer:', error);
            return {
                success: false,
                error: error.message,
                results: null
            };
        }
    }

    /**
     * Restore methods
     */
    async restoreFromAddressList(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const customerIP = getCustomerStaticIp(customer) || customer.static_ip;
            if (!customerIP) {
                return { success: false, message: 'No static IP' };
            }

            let removed = false;
            for (const listName of [ISOLIR_LIST, LEGACY_ISOLIR_LIST]) {
                const entries = await mikrotik.write('/ip/firewall/address-list/print', [
                    `?list=${listName}`,
                    `?address=${customerIP}`
                ]);
                if (entries && entries.length > 0) {
                    for (const entry of entries) {
                        await mikrotik.write('/ip/firewall/address-list/remove', [
                            `=.id=${entry['.id']}`
                        ]);
                    }
                    logger.info(`Removed ${customerIP} from ${listName}`);
                    removed = true;
                }
            }

            return removed
                ? { success: true }
                : { success: false, message: 'Not found in address list' };

        } catch (error) {
            logger.error('Error in restoreFromAddressList:', error);
            return { success: false, error: error.message };
        }
    }

    async restoreFromBandwidthLimit(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const customerIP = customer.static_ip || customer.ip_address || customer.assigned_ip;
            let removed = false;

            // Remove legacy suspended_* queue if present
            if (customerIP) {
                const queueName = `suspended_${String(customerIP).replace(/\./g, '_')}`;
                const queues = await mikrotik.write('/queue/simple/print', [
                    `?name=${queueName}`
                ]);

                if (queues && queues.length > 0) {
                    await mikrotik.write('/queue/simple/remove', [
                        `=.id=${queues[0]['.id']}`
                    ]);
                    logger.info(`Removed bandwidth limit queue for ${customerIP}`);
                    removed = true;
                }
            }

            // cust_* package queue is re-provisioned by serviceSuspension after restore
            return removed
                ? { success: true }
                : { success: false, message: 'No legacy suspension queue found' };

        } catch (error) {
            logger.error('Error in restoreFromBandwidthLimit:', error);
            return { success: false, error: error.message };
        }
    }

    async restoreFromFirewallRule(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);

            const rules = await mikrotik.write('/ip/firewall/filter/print', [
                `?src-address=${customer.static_ip}`,
                '?action=drop'
            ]);

            if (rules && rules.length > 0) {
                for (const rule of rules) {
                    await mikrotik.write('/ip/firewall/filter/remove', [
                        `=.id=${rule['.id']}`
                    ]);
                }
                logger.info(`Removed firewall rule for ${customer.static_ip}`);
                return { success: true };
            }

            return { success: false, message: 'No firewall rule found' };

        } catch (error) {
            logger.error('Error in restoreFromFirewallRule:', error);
            return { success: false, error: error.message };
        }
    }

    async restoreFromDHCPBlock(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);

            const leases = await mikrotik.write('/ip/dhcp-server/lease/print', [
                `?mac-address=${customer.mac_address}`,
                '?blocked=yes'
            ]);

            if (leases && leases.length > 0) {
                for (const lease of leases) {
                    await mikrotik.write('/ip/dhcp-server/lease/set', [
                        `=.id=${lease['.id']}`,
                        '=blocked=no',
                        '=comment=RESTORED'
                    ]);
                }
                logger.info(`Unblocked DHCP lease for MAC ${customer.mac_address}`);
                return { success: true };
            }

            return { success: false, message: 'No blocked DHCP lease found' };

        } catch (error) {
            logger.error('Error in restoreFromDHCPBlock:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Setup infrastruktur untuk blocked customers (address list + firewall rule)
     */
    async ensureIsolirCustomerSetup(customer) {
        try {
            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const access = getBillingWalledGardenConfig();

            // Migrasi entry lama blocked_customers → isolir_customer (sekali jalan per setup)
            try {
                const legacy = await mikrotik.write('/ip/firewall/address-list/print', [
                    `?list=${LEGACY_ISOLIR_LIST}`
                ]);
                for (const row of legacy || []) {
                    const addr = String(row.address || '').trim();
                    if (!addr || addr === '0.0.0.0') continue;
                    const exists = await mikrotik.write('/ip/firewall/address-list/print', [
                        `?list=${ISOLIR_LIST}`,
                        `?address=${addr}`
                    ]);
                    if (!exists || exists.length === 0) {
                        await mikrotik.write('/ip/firewall/address-list/add', [
                            `=list=${ISOLIR_LIST}`,
                            `=address=${addr}`,
                            `=comment=${row.comment || 'migrated from blocked_customers'}`
                        ]);
                    }
                    try {
                        await mikrotik.write('/ip/firewall/address-list/remove', [`=.id=${row['.id']}`]);
                    } catch (_) {}
                }
            } catch (migErr) {
                logger.warn(`Legacy isolir list migrate: ${migErr.message}`);
            }

            const addAddressListIfMissing = async (list, address, comment) => {
                if (!address || address === 'GANTI_IP_SERVER_BILLING') return;
                try {
                    const existing = await mikrotik.write('/ip/firewall/address-list/print', [
                        `?list=${list}`,
                        `?address=${address}`
                    ]);
                    if (!existing || existing.length === 0) {
                        await mikrotik.write('/ip/firewall/address-list/add', [
                            `=list=${list}`,
                            `=address=${address}`,
                            `=comment=${comment}`
                        ]);
                    }
                } catch (error) {
                    logger.warn(`Failed to add walled-garden address ${address}: ${error.message}`);
                }
            };

            const addFilterIfMissing = async (comment, params) => {
                try {
                    const existing = await mikrotik.write('/ip/firewall/filter/print', [
                        `?comment=${comment}`
                    ]);
                    if (!existing || existing.length === 0) {
                        const firstRules = await mikrotik.write('/ip/firewall/filter/print', []);
                        const firstId = firstRules && firstRules[0] && firstRules[0]['.id'];
                        await mikrotik.write('/ip/firewall/filter/add', [
                            ...params,
                            `=comment=${comment}`,
                            ...(firstId ? [`=place-before=${firstId}`] : [])
                        ]);
                    }
                } catch (error) {
                    logger.warn(`Failed to add firewall allow rule "${comment}": ${error.message}`);
                }
            };

            await addAddressListIfMissing('isolir-allowed-dst', access.billingServerIp, 'BILLING-ISOLIR billing server');
            if (access.billingHost && !isIpAddress(access.billingHost)) {
                await addAddressListIfMissing('isolir-allowed-dst', access.billingHost, 'BILLING-ISOLIR billing host');
            }
            for (const host of access.whatsappHosts) {
                await addAddressListIfMissing('isolir-allowed-dst', host, `BILLING-ISOLIR whatsapp ${host}`);
            }

            // Whitelist ini harus berada sebelum drop isolir_customer supaya pelanggan isolir
            // tetap bisa bayar di portal dan mengirim bukti lewat WhatsApp.
            await addFilterIfMissing('BILLING-ISOLIR static allow established', [
                '=chain=forward',
                '=connection-state=established,related',
                '=action=accept'
            ]);
            await addFilterIfMissing('BILLING-ISOLIR static allow dns udp', [
                '=chain=forward',
                '=src-address-list=isolir_customer',
                '=protocol=udp',
                '=dst-port=53',
                '=action=accept'
            ]);
            await addFilterIfMissing('BILLING-ISOLIR static allow dns tcp', [
                '=chain=forward',
                '=src-address-list=isolir_customer',
                '=protocol=tcp',
                '=dst-port=53',
                '=action=accept'
            ]);
            if (access.billingServerIp) {
                await addFilterIfMissing('BILLING-ISOLIR static allow billing app', [
                    '=chain=forward',
                    '=src-address-list=isolir_customer',
                    `=dst-address=${access.billingServerIp}`,
                    '=protocol=tcp',
                    `=dst-port=${access.billingPorts}`,
                    '=action=accept'
                ]);
            }
            await addFilterIfMissing('BILLING-ISOLIR static allow whatsapp', [
                '=chain=forward',
                '=src-address-list=isolir_customer',
                '=dst-address-list=isolir-allowed-dst',
                '=protocol=tcp',
                '=dst-port=80,443,5222,5223,5228,4244',
                '=action=accept'
            ]);

            const addNatIfMissing = async (comment, params) => {
                try {
                    const existing = await mikrotik.write('/ip/firewall/nat/print', [
                        `?comment=${comment}`
                    ]);
                    if (!existing || existing.length === 0) {
                        const firstRules = await mikrotik.write('/ip/firewall/nat/print', []);
                        const firstId = firstRules && firstRules[0] && firstRules[0]['.id'];
                        await mikrotik.write('/ip/firewall/nat/add', [
                            ...params,
                            `=comment=${comment}`,
                            ...(firstId ? [`=place-before=${firstId}`] : [])
                        ]);
                    }
                } catch (error) {
                    logger.warn(`Failed to add NAT redirect "${comment}": ${error.message}`);
                }
            };

            if (access.billingServerIp) {
                await addNatIfMissing('BILLING-ISOLIR static bypass allowed destinations', [
                    '=chain=dstnat',
                    '=src-address-list=isolir_customer',
                    '=dst-address-list=isolir-allowed-dst',
                    '=protocol=tcp',
                    '=action=accept'
                ]);
                await addNatIfMissing('BILLING-ISOLIR static force http to isolir page', [
                    '=chain=dstnat',
                    '=src-address-list=isolir_customer',
                    '=protocol=tcp',
                    '=dst-port=80,8080,8000,8888',
                    '=action=dst-nat',
                    `=to-addresses=${access.billingServerIp}`,
                    `=to-ports=${String(process.env.ISOLIR_PORT || getSetting('isolir_page_port', 8899))}`
                ]);
                await addNatIfMissing('BILLING-ISOLIR static masquerade to billing server', [
                    '=chain=srcnat',
                    '=src-address-list=isolir_customer',
                    `=dst-address=${access.billingServerIp}`,
                    '=action=masquerade'
                ]);
            }

            // 1. Pastikan firewall rule untuk block address list ada
            const existingRules = await mikrotik.write('/ip/firewall/filter/print', [
                '?src-address-list=isolir_customer',
                '?action=drop'
            ]);

            if (!existingRules || existingRules.length === 0) {
                const firstRules = await mikrotik.write('/ip/firewall/filter/print', []);
                const firstId = firstRules && firstRules[0] && firstRules[0]['.id'];
                await mikrotik.write('/ip/firewall/filter/add', [
                    '=chain=forward',
                    '=src-address-list=isolir_customer',
                    '=action=drop',
                    '=comment=Block suspended customers (static IP)',
                    ...(firstId ? [`=place-before=${firstId}`] : [])
                ]);
                logger.info('Created firewall rule for isolir_customer address list');
            }

            // 2. Tambahkan rule untuk block dari internal juga (jika diperlukan)
            const internalRules = await mikrotik.write('/ip/firewall/filter/print', [
                '?chain=input',
                '?src-address-list=isolir_customer',
                '?action=drop'
            ]);

            if (!internalRules || internalRules.length === 0) {
                await mikrotik.write('/ip/firewall/filter/add', [
                    '=chain=input',
                    '=src-address-list=isolir_customer',
                    '=action=drop',
                    '=comment=Block suspended customers from accessing router (static IP)'
                ]);
                logger.info('Created input chain rule for isolir_customer address list');
            }

        } catch (error) {
            logger.error('Error in ensureIsolirCustomerSetup:', error);
            throw error;
        }
    }

    /**
     * Get suspension status untuk IP statik
     */
    async getStaticIPSuspensionStatus(customer) {
        try {
            const customerIP = getCustomerStaticIp(customer) || customer.ip_address || null;
            const macAddress = customer.mac_address;

            if (!customerIP && !macAddress) {
                return { suspended: false, methods: [] };
            }

            const mikrotik = await getMikrotikConnectionForCustomer(customer);
            const suspensionMethods = [];

            // Cek address list isolir (+ legacy)
            if (customerIP) {
                for (const listName of [ISOLIR_LIST, LEGACY_ISOLIR_LIST]) {
                    const addressListEntries = await mikrotik.write('/ip/firewall/address-list/print', [
                        `?list=${listName}`,
                        `?address=${customerIP}`
                    ]);
                    if (addressListEntries && addressListEntries.length > 0) {
                        suspensionMethods.push('address_list');
                        break;
                    }
                }

                // Cek bandwidth limit
                const queueName = `suspended_${customerIP.replace(/\./g, '_')}`;
                const queues = await mikrotik.write('/queue/simple/print', [
                    `?name=${queueName}`
                ]);
                if (queues && queues.length > 0) {
                    suspensionMethods.push('bandwidth_limit');
                }

                // Cek firewall rule
                const firewallRules = await mikrotik.write('/ip/firewall/filter/print', [
                    `?src-address=${customerIP}`,
                    '?action=drop'
                ]);
                if (firewallRules && firewallRules.length > 0) {
                    suspensionMethods.push('firewall_rule');
                }
            }

            // Cek DHCP block
            if (macAddress) {
                const blockedLeases = await mikrotik.write('/ip/dhcp-server/lease/print', [
                    `?mac-address=${macAddress}`,
                    '?blocked=yes'
                ]);
                if (blockedLeases && blockedLeases.length > 0) {
                    suspensionMethods.push('dhcp_block');
                }
            }

            return {
                suspended: suspensionMethods.length > 0,
                methods: suspensionMethods,
                customer_ip: customerIP,
                mac_address: macAddress
            };

        } catch (error) {
            logger.error('Error in getStaticIPSuspensionStatus:', error);
            return { suspended: false, methods: [], error: error.message };
        }
    }
}

module.exports = new StaticIPSuspensionManager();
