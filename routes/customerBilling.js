const express = require('express');
const router = express.Router();
const billingManager = require('../config/billing');
const logger = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const { attachTenantAppSettings } = require('../config/platform/tenantAppSettings');

// Middleware untuk memastikan session consistency
const ensureCustomerSession = async (req, res, next) => {
    console.log(`🔐 [ENSURE_SESSION] Middleware called for: ${req.url}`);
    console.log(`🔐 [ENSURE_SESSION] Initial session:`, {
        customer_username: req.session?.customer_username,
        customer_phone: req.session?.customer_phone,
        phone: req.session?.phone,
        is_member: req.session?.is_member,
        member_id: req.session?.member_id
    });
    
    try {
        // Prioritas 1: cek customer_username
        let username = req.session?.customer_username;
        const phone = req.session?.phone || req.session?.customer_phone;

        // Jika tidak ada customer_username tapi ada phone, ambil dari billing
        if (!username && phone) {
            console.log(`🔄 [SESSION_FIX] No customer_username but phone exists: ${phone}, fetching from billing`);
            try {
                // Check member first if session indicates member
                if (req.session.is_member) {
                    const member = await billingManager.getMemberByPhone(phone);
                    if (member) {
                        req.session.member_id = member.id;
                        req.session.member_phone = phone;
                        req.session.member_username = member.hotspot_username || member.username;
                        req.session.customer_username = member.hotspot_username || member.username;
                        req.session.customer_phone = phone;
                        req.session.is_member = true;
                        username = member.hotspot_username || member.username;
                        console.log(`✅ [SESSION_FIX] Set member_username: ${username} for phone: ${phone}`);
                    }
                } else {
                    // Try customer first
                    const customer = await billingManager.getCustomerByPhone(phone);
                    if (customer) {
                        req.session.customer_username = customer.username;
                        req.session.customer_phone = phone;
                        req.session.is_member = false;
                        username = customer.username;
                        console.log(`✅ [SESSION_FIX] Set customer_username: ${username} for phone: ${phone}`);
                    } else {
                    // Check if it's a member - try with phone variants
                    let member = null;
                    try {
                        member = await billingManager.getMemberByPhone(phone);
                    } catch (memberError) {
                        console.log(`⚠️ [SESSION_FIX] Error checking member: ${memberError.message}`);
                    }
                    
                    if (member) {
                        req.session.member_id = member.id;
                        req.session.member_phone = member.phone; // Use phone from database
                        req.session.member_username = member.hotspot_username || member.username;
                        req.session.customer_username = member.hotspot_username || member.username;
                        req.session.customer_phone = member.phone; // Use phone from database
                        req.session.is_member = true;
                        username = member.hotspot_username || member.username;
                        console.log(`✅ [SESSION_FIX] Set member_username: ${username} for phone: ${member.phone} (searched with: ${phone})`);
                    } else {
                            // Customer tidak ada di billing, buat temporary username
                            req.session.customer_username = `temp_${phone}`;
                            req.session.customer_phone = phone;
                            req.session.is_member = false;
                            username = `temp_${phone}`;
                            console.log(`⚠️ [SESSION_FIX] Customer/member not in billing, created temp username: ${username} for phone: ${phone}`);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ [SESSION_FIX] Error getting customer/member from billing:`, error);
                // Fallback ke temporary username
                req.session.customer_username = `temp_${phone}`;
                req.session.customer_phone = phone;
                req.session.is_member = false;
                username = `temp_${phone}`;
            }
        }

        // Jika session username masih temp_ tetapi ada phone, coba sinkronkan ulang ke username asli
        if (username && typeof username === 'string' && username.startsWith('temp_') && phone) {
            try {
                const customerFix = await billingManager.getCustomerByPhone(phone);
                if (customerFix && customerFix.username) {
                    req.session.customer_username = customerFix.username;
                    req.session.customer_phone = phone;
                    req.session.is_member = false;
                    username = customerFix.username;
                    console.log(`✅ [SESSION_FIX] Replaced temp username with real username: ${username} for phone: ${phone}`);
                } else {
                    // Check if it's a member - try with phone variants
                    let memberFix = null;
                    try {
                        memberFix = await billingManager.getMemberByPhone(phone);
                    } catch (memberError) {
                        console.log(`⚠️ [SESSION_FIX] Error checking member: ${memberError.message}`);
                    }
                    
                    if (memberFix && (memberFix.hotspot_username || memberFix.username)) {
                        req.session.member_id = memberFix.id;
                        req.session.member_phone = memberFix.phone; // Use phone from database
                        req.session.member_username = memberFix.hotspot_username || memberFix.username;
                        req.session.customer_username = memberFix.hotspot_username || memberFix.username;
                        req.session.customer_phone = memberFix.phone; // Use phone from database
                        req.session.is_member = true;
                        username = memberFix.hotspot_username || memberFix.username;
                        console.log(`✅ [SESSION_FIX] Replaced temp username with member username: ${username} for phone: ${memberFix.phone} (searched with: ${phone})`);
                    }
                }
            } catch (e) {
                console.warn(`⚠️ [SESSION_FIX] Retry getCustomerByPhone/getMemberByPhone failed: ${e.message}`);
            }
        }

        // Jika masih tidak ada customer_username atau phone, redirect ke login
        if (!username && !phone) {
            console.log(`❌ [SESSION_FIX] No session found, redirecting to login`);
            return res.redirect('/customer/login');
        }

        console.log(`✅ [ENSURE_SESSION] Session validated, proceeding to next middleware. Final username: ${username}, phone: ${phone}`);
        next();
    } catch (error) {
        console.error('Error in ensureCustomerSession middleware:', error);
        return res.redirect('/customer/login');
    }
};

// Middleware untuk mendapatkan pengaturan aplikasi dari tenant aktif.
// Bila request tidak memiliki tenant, detail rekening sengaja dikosongkan
// agar tidak membocorkan atau memakai rekening global host.
const getAppSettings = (req, res, next) => {
    const hasTenant = Boolean(req.tenantId || req.tenant?.id || req.session?.tenantId);

    attachTenantAppSettings(req, res, (err) => {
        if (err) return next(err);

        if (!hasTenant) {
            req.appSettings.payment_bank_name = '';
            req.appSettings.payment_account_number = '';
            req.appSettings.payment_account_holder = '';
            res.locals.appSettings = req.appSettings;
        }

        // Nomor admin tetap dipertahankan untuk kompatibilitas dashboard lama.
        const adminNumber = getSetting('admins.0', '6281368888498');
        const displayNumber = adminNumber.startsWith('62') ? '0' + adminNumber.slice(2) : adminNumber;
        req.appSettings.adminNumber = displayNumber;
        req.appSettings.adminNumberWA = adminNumber;
        res.locals.appSettings = req.appSettings;
        next();
    });
};

// Dashboard Billing Customer
router.get('/dashboard', ensureCustomerSession, getAppSettings, async (req, res) => {
    console.log(`🚀 [BILLING_DASHBOARD] Route hit! URL: ${req.url}`);
    console.log(`🚀 [BILLING_DASHBOARD] Session:`, {
        customer_username: req.session.customer_username,
        customer_phone: req.session.customer_phone,
        phone: req.session.phone,
        is_member: req.session.is_member,
        member_id: req.session.member_id
    });
    
    try {
        const username = req.session.customer_username;
        const phone = req.session.customer_phone || req.session.phone;
        
        console.log(`🚀 [BILLING_DASHBOARD] After middleware - username: ${username}, phone: ${phone}`);
        
        if (!username) {
            console.log(`❌ [BILLING_DASHBOARD] No username found, redirecting to login`);
            return res.redirect('/customer/login');
        }

        // Handle temporary customer (belum ada di billing)
        if (username.startsWith('temp_')) {
            console.log(`📋 [BILLING_DASHBOARD] Temporary customer detected: ${username}, phone: ${phone}`);
            
            // Render dashboard dengan data kosong untuk customer tanpa billing
            return res.render('customer/billing/dashboard', {
                title: 'Dashboard Billing',
                customer: null,
                invoices: [],
                payments: [],
                stats: {
                    totalInvoices: 0,
                    paidInvoices: 0,
                    unpaidInvoices: 0,
                    overdueInvoices: 0,
                    totalPaid: 0,
                    totalUnpaid: 0
                },
                appSettings: req.appSettings,
                phone: phone
            });
        }

        // Check if this is a member - check session first, then try to detect
        let isMember = req.session.is_member;
        let customer = null;
        let member = null;
        
        console.log(`🔍 [BILLING_DASHBOARD] Session check - is_member: ${isMember}, username: ${username}, phone: ${phone}`);
        console.log(`🔍 [BILLING_DASHBOARD] Session data:`, {
            member_id: req.session.member_id,
            member_username: req.session.member_username,
            customer_username: req.session.customer_username,
            customer_phone: req.session.customer_phone
        });
        
        // If not explicitly set, try to detect if it's a member
        if (!isMember && username && !username.startsWith('temp_')) {
            // Try to find as customer first
            customer = await billingManager.getCustomerByUsername(username);
            console.log(`🔍 [BILLING_DASHBOARD] Customer lookup result:`, customer ? `Found: ${customer.name}` : 'Not found');
            
            if (!customer && phone) {
                // If not found as customer, try as member
                member = await billingManager.getMemberByPhone(phone);
                console.log(`🔍 [BILLING_DASHBOARD] Member lookup by phone result:`, member ? `Found: ${member.name} (${member.hotspot_username})` : 'Not found');
                
                if (member) {
                    isMember = true;
                    req.session.is_member = true;
                    req.session.member_id = member.id;
                    req.session.member_username = member.hotspot_username || member.username;
                    req.session.customer_username = member.hotspot_username || member.username;
                    req.session.customer_phone = member.phone;
                    console.log(`✅ [BILLING_DASHBOARD] Set member session: ${member.name} (${member.hotspot_username})`);
                }
            }
        }
        
        if (isMember) {
            // Get member data
            if (req.session.member_id) {
                member = await billingManager.getMemberById(req.session.member_id);
            } else if (phone) {
                try {
                    member = await billingManager.getMemberByPhone(phone);
                    if (member) {
                        req.session.member_id = member.id;
                        req.session.member_phone = member.phone; // Use phone from database
                        req.session.member_username = member.hotspot_username || member.username;
                        req.session.customer_username = member.hotspot_username || member.username;
                        req.session.customer_phone = member.phone; // Use phone from database
                        console.log(`✅ [BILLING_DASHBOARD] Got member by phone: ${member.name} (${member.hotspot_username}) for phone: ${member.phone} (searched with: ${phone})`);
                    }
                } catch (memberError) {
                    console.log(`⚠️ [BILLING_DASHBOARD] Error getting member by phone: ${memberError.message}`);
                }
            } else if (username) {
                try {
                    member = await billingManager.getMemberByHotspotUsername(username);
                    if (member) {
                        req.session.member_id = member.id;
                        req.session.member_phone = member.phone; // Use phone from database
                        req.session.member_username = member.hotspot_username || member.username;
                        req.session.customer_username = member.hotspot_username || member.username;
                        req.session.customer_phone = member.phone; // Use phone from database
                        console.log(`✅ [BILLING_DASHBOARD] Got member by hotspot_username: ${member.name} (${member.hotspot_username})`);
                    }
                } catch (memberError) {
                    console.log(`⚠️ [BILLING_DASHBOARD] Error getting member by hotspot_username: ${memberError.message}`);
                }
            }
            
            if (!member) {
                console.log(`⚠️ [BILLING_DASHBOARD] Member not found for username: ${username} or phone: ${phone}`);
                return res.render('customer/billing/dashboard', {
                    title: 'Dashboard Billing',
                    customer: null,
                    member: null,
                    invoices: [],
                    payments: [],
                    stats: {
                        totalInvoices: 0,
                        paidInvoices: 0,
                        unpaidInvoices: 0,
                        overdueInvoices: 0,
                        totalPaid: 0,
                        totalUnpaid: 0
                    },
                    appSettings: req.appSettings,
                    phone: phone
                });
            }
            
            // Get member invoices using hotspot_username
            const memberUsername = member.hotspot_username || member.username;
            console.log(`📋 [BILLING_DASHBOARD] Fetching invoices for member: ${memberUsername} (ID: ${member.id}, Phone: ${member.phone})`);
            console.log(`📋 [BILLING_DASHBOARD] Member data:`, {
                id: member.id,
                name: member.name,
                hotspot_username: member.hotspot_username,
                username: member.username,
                phone: member.phone
            });
            
            // Try both hotspot_username and username for invoice lookup
            let invoices = await billingManager.getInvoices(memberUsername);
            console.log(`📋 [BILLING_DASHBOARD] Query result with hotspot_username '${memberUsername}': ${invoices.length} invoices`);
            
            // If no invoices found with hotspot_username, try with username
            if (invoices.length === 0 && member.username && member.username !== memberUsername) {
                console.log(`📋 [BILLING_DASHBOARD] No invoices found with hotspot_username, trying username: ${member.username}`);
                invoices = await billingManager.getInvoices(member.username);
                console.log(`📋 [BILLING_DASHBOARD] Query result with username '${member.username}': ${invoices.length} invoices`);
            }
            
            // If still no invoices, try querying by member_id directly
            if (invoices.length === 0) {
                console.log(`📋 [BILLING_DASHBOARD] Still no invoices found, trying direct query by member_id: ${member.id}`);
                try {
                    const directInvoices = await new Promise((resolve, reject) => {
                        const directQuery = `SELECT i.*, m.hotspot_username, m.name as member_name, m.phone as member_phone,
                                            mp.name as package_name, mp.speed as package_speed, mp.price as package_price
                                            FROM invoices i 
                                            LEFT JOIN members m ON i.member_id = m.id 
                                            LEFT JOIN member_packages mp ON i.package_id = mp.id
                                            WHERE i.member_id = ?`;
                        billingManager.db.all(directQuery, [member.id], (err, rows) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(rows || []);
                            }
                        });
                    });
                    
                    if (directInvoices && directInvoices.length > 0) {
                        console.log(`📋 [BILLING_DASHBOARD] Direct query found ${directInvoices.length} invoices by member_id`);
                        // Format invoices to match getInvoices() format
                        invoices = directInvoices.map(inv => ({
                            ...inv,
                            is_member: true,
                            display_name: inv.member_name,
                            display_username: inv.hotspot_username,
                            display_phone: inv.member_phone,
                            display_package_name: inv.package_name
                        }));
                    }
                } catch (directQueryError) {
                    console.log(`⚠️ [BILLING_DASHBOARD] Error in direct query: ${directQueryError.message}`);
                }
            }
            
            console.log(`📋 [BILLING_DASHBOARD] Final result: Found ${invoices.length} invoices for member ${memberUsername}`);
            const payments = await billingManager.getPayments();
            
            // Filter payments untuk member ini
            const memberPayments = payments.filter(payment => {
                return invoices.some(invoice => invoice.id === payment.invoice_id);
            });
            
            // Ambil riwayat laporan gangguan berdasarkan nomor telepon member
            let troubleReports = [];
            try {
                const { getTroubleReportsByPhone } = require('../config/troubleReport');
                troubleReports = getTroubleReportsByPhone(member.phone) || [];
            } catch (e) {
                logger.warn('Unable to load trouble reports for member dashboard:', e.message);
            }
            
            // Hitung statistik member
            const totalInvoices = invoices.length;
            const paidInvoices = invoices.filter(inv => inv.status === 'paid').length;
            const unpaidInvoices = invoices.filter(inv => inv.status === 'unpaid').length;
            const overdueInvoices = invoices.filter(inv => 
                inv.status === 'unpaid' && new Date(inv.due_date) < new Date()
            ).length;
            const totalPaid = invoices
                .filter(inv => inv.status === 'paid')
                .reduce((sum, inv) => sum + parseFloat(inv.amount), 0);
            const totalUnpaid = invoices
                .filter(inv => inv.status === 'unpaid')
                .reduce((sum, inv) => sum + parseFloat(inv.amount), 0);
            
            // Get member package details if package_id exists
            let packageName = null;
            let packagePrice = 0;
            if (member.package_id) {
                try {
                    const memberPackage = await billingManager.getMemberPackageById(member.package_id);
                    if (memberPackage) {
                        packageName = memberPackage.name;
                        packagePrice = memberPackage.price || 0;
                    }
                } catch (e) {
                    logger.warn('Unable to load member package:', e.message);
                }
            }
            
            // Format member data to match customer format for view compatibility
            const memberAsCustomer = {
                customer_id: null,
                name: member.name,
                username: member.hotspot_username || member.username,
                phone: member.phone,
                package_name: packageName || member.package_name || null,
                package_price: packagePrice || member.package_price || 0,
                status: member.status,
                payment_status: overdueInvoices > 0 ? 'overdue' : (unpaidInvoices > 0 ? 'unpaid' : 'paid'),
                is_member: true
            };
            
            res.render('customer/billing/dashboard', {
                title: 'Dashboard Billing',
                customer: memberAsCustomer,
                member: member,
                invoices: invoices.slice(0, 5), // 5 tagihan terbaru
                payments: memberPayments.slice(0, 5), // 5 pembayaran terbaru
                troubleReports: troubleReports.slice(-5), // 5 laporan terbaru
                stats: {
                    totalInvoices,
                    paidInvoices,
                    unpaidInvoices,
                    overdueInvoices,
                    totalPaid,
                    totalUnpaid
                },
                appSettings: req.appSettings
            });
        } else {
            // Get customer data
            customer = await billingManager.getCustomerByUsername(username);
            if (!customer) {
                // Jika tidak ditemukan berdasarkan username, coba cari berdasarkan phone
                if (phone) {
                    const customerByPhone = await billingManager.getCustomerByPhone(phone);
                    if (!customerByPhone) {
                        console.log(`⚠️ [BILLING_DASHBOARD] Customer not found for username: ${username} or phone: ${phone}, treating as no billing data`);
                        
                        // Render dashboard dengan data kosong
                        return res.render('customer/billing/dashboard', {
                            title: 'Dashboard Billing',
                            customer: null,
                            member: null,
                            invoices: [],
                            payments: [],
                            stats: {
                                totalInvoices: 0,
                                paidInvoices: 0,
                                unpaidInvoices: 0,
                                overdueInvoices: 0,
                                totalPaid: 0,
                                totalUnpaid: 0
                            },
                            appSettings: req.appSettings,
                            phone: phone
                        });
                    }
                    customer = customerByPhone;
                } else {
                    return res.status(404).render('error', {
                        message: 'Pelanggan tidak ditemukan',
                        error: 'Terjadi kesalahan. Silakan coba lagi.',
                        appSettings: req.appSettings,
                        req: req
                    });
                }
            }

            const invoices = await billingManager.getInvoices(username);
            const payments = await billingManager.getPayments();
            
            // Filter payments untuk customer ini
            const customerPayments = payments.filter(payment => {
                return invoices.some(invoice => invoice.id === payment.invoice_id);
            });

            // Ambil riwayat laporan gangguan berdasarkan nomor telepon customer
            let troubleReports = [];
            try {
                const { getTroubleReportsByPhone } = require('../config/troubleReport');
                troubleReports = getTroubleReportsByPhone(customer.phone) || [];
            } catch (e) {
                logger.warn('Unable to load trouble reports for customer dashboard:', e.message);
            }

            // Hitung statistik customer
            const totalInvoices = invoices.length;
            const paidInvoices = invoices.filter(inv => inv.status === 'paid').length;
            const unpaidInvoices = invoices.filter(inv => inv.status === 'unpaid').length;
            const overdueInvoices = invoices.filter(inv => 
                inv.status === 'unpaid' && new Date(inv.due_date) < new Date()
            ).length;
            const totalPaid = invoices
                .filter(inv => inv.status === 'paid')
                .reduce((sum, inv) => sum + parseFloat(inv.amount), 0);
            const totalUnpaid = invoices
                .filter(inv => inv.status === 'unpaid')
                .reduce((sum, inv) => sum + parseFloat(inv.amount), 0);

            res.render('customer/billing/dashboard', {
                title: 'Dashboard Billing',
                customer,
                member: null,
                invoices: invoices.slice(0, 5), // 5 tagihan terbaru
                payments: customerPayments.slice(0, 5), // 5 pembayaran terbaru
                troubleReports: troubleReports.slice(-5), // 5 laporan terbaru
                stats: {
                    totalInvoices,
                    paidInvoices,
                    unpaidInvoices,
                    overdueInvoices,
                    totalPaid,
                    totalUnpaid
                },
                appSettings: req.appSettings
            });
        }
    } catch (error) {
        logger.error('Error loading customer billing dashboard:', error);
        res.status(500).render('error', { 
            message: 'Error loading billing dashboard',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Halaman Tagihan Customer
router.get('/invoices', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).render('error', {
                message: 'Pelanggan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const invoices = await billingManager.getInvoices(username);
        
        res.render('customer/billing/invoices', {
            title: 'Tagihan Saya',
            customer,
            invoices,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading customer invoices:', error);
        res.status(500).render('error', { 
            message: 'Error loading invoices',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Detail Tagihan Customer
router.get('/invoices/:id', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice) {
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        // Check session access (removed debug logs for production)
        
        // Pastikan tagihan milik customer atau member yang login
        const isMember = req.session.is_member;
        if (isMember) {
            // For member, check member_username or hotspot_username
            const memberUsername = req.session.member_username || username;
            if (invoice.is_member && invoice.member_username !== memberUsername && invoice.customer_username !== memberUsername) {
                return res.status(403).render('error', {
                    message: 'Akses ditolak',
                    error: `Session username: "${memberUsername}" tidak cocok dengan invoice member username`,
                    appSettings: req.appSettings,
                    req: req
                });
            }
        } else {
            // For customer, check customer_username
            if (!invoice.is_member && invoice.customer_username !== username) {
                return res.status(403).render('error', {
                    message: 'Akses ditolak',
                    error: `Session username: "${username}" tidak cocok dengan invoice customer_username: "${invoice.customer_username}"`,
                    appSettings: req.appSettings,
                    req: req
                });
            }
        }

        const payments = await billingManager.getPayments(id);
        
        res.render('customer/billing/invoice-detail', {
            title: `Tagihan ${invoice.invoice_number}`,
            invoice,
            payments,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading invoice detail:', error);
        res.status(500).render('error', { 
            message: 'Error loading invoice detail',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Halaman Riwayat Pembayaran Customer
router.get('/payments', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).render('error', {
                message: 'Pelanggan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const invoices = await billingManager.getInvoices(username);
        const allPayments = await billingManager.getPayments();
        
        // Filter payments untuk customer ini
        const customerPayments = allPayments.filter(payment => {
            return invoices.some(invoice => invoice.id === payment.invoice_id);
        });

        res.render('customer/billing/payments', {
            title: 'Riwayat Pembayaran',
            customer,
            payments: customerPayments,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading customer payments:', error);
        res.status(500).render('error', { 
            message: 'Error loading payments',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Halaman Profil Customer
router.get('/profile', getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).render('error', {
                message: 'Pelanggan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const packages = await billingManager.getPackages();
        
        res.render('customer/billing/profile', {
            title: 'Profil Saya',
            customer,
            packages,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error loading customer profile:', error);
        res.status(500).render('error', { 
            message: 'Error loading profile',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// API Routes untuk AJAX
router.get('/api/invoices', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const invoices = await billingManager.getInvoices(username);
        res.json(invoices);
    } catch (error) {
        logger.error('Error getting customer invoices API:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/payments', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const invoices = await billingManager.getInvoices(username);
        const allPayments = await billingManager.getPayments();
        
        // Filter payments untuk customer ini
        const customerPayments = allPayments.filter(payment => {
            return invoices.some(invoice => invoice.id === payment.invoice_id);
        });

        res.json(customerPayments);
    } catch (error) {
        logger.error('Error getting customer payments API:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/profile', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const customer = await billingManager.getCustomerByUsername(username);
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found' });
        }

        res.json(customer);
    } catch (error) {
        logger.error('Error getting customer profile API:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download Invoice PDF (placeholder)
router.get('/invoices/:id/download', getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.redirect('/customer/login');
        }

        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        if (!invoice || invoice.customer_username !== username) {
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        // TODO: Implement PDF generation
        res.json({
            success: true,
            message: 'Fitur download PDF akan segera tersedia',
            invoice_number: invoice.invoice_number
        });
    } catch (error) {
        logger.error('Error downloading invoice:', error);
        res.status(500).json({ error: error.message });
    }
});

// Print Invoice
router.get('/invoices/:id/print', ensureCustomerSession, getAppSettings, async (req, res) => {
    try {
        const username = req.session.customer_username;
        console.log(`📄 [PRINT] Print request - username: ${username}, invoice_id: ${req.params.id}`);
        
        if (!username) {
            console.log(`❌ [PRINT] No customer_username in session`);
            return res.redirect('/customer/login');
        }

        const { id } = req.params;
        const invoice = await billingManager.getInvoiceById(id);
        
        console.log(`📄 [PRINT] Invoice found:`, invoice ? {
            id: invoice.id,
            customer_username: invoice.customer_username,
            invoice_number: invoice.invoice_number,
            status: invoice.status
        } : 'null');
        
        if (!invoice || invoice.customer_username !== username) {
            console.log(`❌ [PRINT] Access denied - invoice.customer_username: ${invoice?.customer_username}, session username: ${username}`);
            return res.status(404).render('error', {
                message: 'Tagihan tidak ditemukan',
                error: 'Terjadi kesalahan. Silakan coba lagi.',
                appSettings: req.appSettings,
                req: req
            });
        }

        const payments = await billingManager.getPayments(id);
        
        res.render('customer/billing/invoice-print', {
            title: `Print Tagihan ${invoice.invoice_number}`,
            invoice,
            payments,
            appSettings: req.appSettings
        });
    } catch (error) {
        logger.error('Error printing invoice:', error);
        res.status(500).render('error', { 
            message: 'Error printing invoice',
            error: error.message,
            appSettings: req.appSettings
        });
    }
});

// Get available payment methods for customer
router.get('/api/payment-methods', ensureCustomerSession, async (req, res) => {
    try {
        const PaymentGatewayManager = require('../config/paymentGateway');
        const manager = new PaymentGatewayManager();
        const methods = await manager.getAvailablePaymentMethods();
        
        // Group by gateway
        const methodsByGateway = {};
        methods.forEach(m => {
            if (!methodsByGateway[m.gateway]) {
                methodsByGateway[m.gateway] = [];
            }
            methodsByGateway[m.gateway].push(m);
        });
        
        res.json({ success: true, methodsByGateway });
    } catch (error) {
        logger.error('Error getting payment methods:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Create online payment for customer
router.post('/create-payment', async (req, res) => {
    try {
        const username = req.session.customer_username;
        if (!username) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const { invoice_id, gateway, method } = req.body;
        
        // Process customer payment request
        
        if (!invoice_id) {
            return res.status(400).json({
                success: false,
                message: 'Invoice ID is required'
            });
        }

        // Get invoice and verify ownership
        const invoice = await billingManager.getInvoiceById(invoice_id);
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        if (invoice.customer_username !== username) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                message: 'Invoice sudah dibayar'
            });
        }

        // Note: Tripay minimum amount validation removed for production
        // In production mode, Tripay doesn't have minimum amount restriction

        // Create online payment with specific method for Tripay
        const result = await billingManager.createOnlinePaymentWithMethod(invoice_id, gateway, method);
        
        logger.info(`Customer ${username} created payment for invoice ${invoice_id} using ${gateway}${method && method !== 'all' ? ' - ' + method : ''}`);
        
        res.json({
            success: true,
            message: 'Payment created successfully',
            data: result
        });
    } catch (error) {
        console.error(`[CUSTOMER_PAYMENT] Error:`, error);
        logger.error('Error creating customer payment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create payment'
        });
    }
});

module.exports = router; 