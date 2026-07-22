const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const billingManager = require('../config/billing');
const logger = require('../config/logger');
const { adminAuth } = require('./adminAuth');
const { addHotspotUserRadius, getHotspotProfilesRadius, getHotspotServerProfilesRadius } = require('../config/mikrotik');
const { getRadiusConfigValue } = require('../config/radiusConfig');
const { getSettingsWithCache } = require('../config/settingsManager');
const { getVersionInfo, getVersionBadge } = require('../config/version-utils');

// Configure multer for member photo uploads
const memberPhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../public/img/members/');
        // Create directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const phone = req.body.phone || req.params.phone || 'unknown';
        const type = file.fieldname === 'ktp_photo' ? 'ktp' : 'house';
        const ext = path.extname(file.originalname) || '.jpg';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `member-${phone}-${type}-${uniqueSuffix}${ext}`);
    }
});

const memberPhotoUpload = multer({ 
    storage: memberPhotoStorage,
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept only image files
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// ========== MEMBER PACKAGES ROUTES ==========

// GET: List Paket Member
router.get('/packages', adminAuth, async (req, res) => {
    try {
        const packages = await billingManager.getAllMemberPackages();
        
        // Get hotspot profiles from RADIUS/MikroTik
        let hotspotProfiles = [];
        try {
            const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
            if (userAuthMode === 'radius') {
                const profilesResult = await getHotspotProfilesRadius();
                if (profilesResult.success) {
                    hotspotProfiles = profilesResult.data || [];
                }
            } else {
                // MikroTik API mode - get from default router
                const { getHotspotProfiles } = require('../config/mikrotik');
                const profilesResult = await getHotspotProfiles();
                if (profilesResult.success) {
                    hotspotProfiles = profilesResult.data || [];
                }
            }
        } catch (e) {
            logger.warn('Error loading hotspot profiles for packages:', e.message);
        }
        
        const settings = getSettingsWithCache();
        const versionInfo = getVersionInfo();
        const versionBadge = getVersionBadge();

        res.render('admin/member/packages', {
            page: 'member-packages',
            packages: packages,
            hotspotProfiles: hotspotProfiles,
            settings: settings,
            versionInfo: versionInfo,
            versionBadge: versionBadge,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        logger.error(`Error loading member packages: ${error.message}`);
        res.render('admin/member/packages', {
            page: 'member-packages',
            packages: [],
            hotspotProfiles: [],
            settings: getSettingsWithCache(),
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge(),
            error: 'Gagal memuat data paket member: ' + error.message
        });
    }
});

// GET: API untuk mengambil daftar hotspot profiles dari RADIUS (untuk sync)
// PENTING: Selalu ambil dari RADIUS User Profile (radgroupreply/radusergroup), bukan dari MikroTik API
router.get('/packages/api/hotspot-profiles', adminAuth, async (req, res) => {
    try {
        // Selalu ambil dari RADIUS User Profile
        const profilesResult = await getHotspotProfilesRadius();
        let profiles = [];
        
        if (profilesResult.success) {
            profiles = profilesResult.data || [];
        }
        
        // Format untuk dropdown - pastikan groupname sebagai value utama
        const formattedProfiles = profiles.map(profile => {
            const groupname = profile.groupname || profile.id || 'default';
            const displayName = profile.name || groupname;
            return {
                name: displayName,
                groupname: groupname,
                id: groupname
            };
        });
        
        res.json({ success: true, profiles: formattedProfiles });
    } catch (error) {
        logger.error(`Error fetching hotspot profiles from RADIUS: ${error.message}`);
        res.json({ success: false, profiles: [], message: `Gagal mengambil profile dari RADIUS: ${error.message}` });
    }
});

// POST: Tambah Paket Member
router.post('/packages', adminAuth, async (req, res) => {
    try {
        const { 
            name, speed, price, tax_rate, description, hotspot_profile,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download,
            burst_threshold, burst_time
        } = req.body;

        if (!name || !speed || !price) {
            return res.redirect('/admin/member/packages?error=Nama,+kecepatan,+dan+harga+harus+diisi');
        }

        const packageData = {
            name: name.trim(),
            speed: speed.trim(),
            price: parseFloat(price),
            tax_rate: parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) : 11.00,
            description: description ? description.trim() : null,
            hotspot_profile: hotspot_profile ? hotspot_profile.trim() : 'default',
            upload_limit: upload_limit ? upload_limit.trim() : null,
            download_limit: download_limit ? download_limit.trim() : null,
            burst_limit_upload: burst_limit_upload ? burst_limit_upload.trim() : null,
            burst_limit_download: burst_limit_download ? burst_limit_download.trim() : null,
            burst_threshold: burst_threshold ? burst_threshold.trim() : null,
            burst_time: burst_time ? burst_time.trim() : null
        };

        await billingManager.createMemberPackage(packageData);
        logger.info(`Member package created: ${packageData.name}`);
        
        // PENTING: Pastikan rate limit dari hotspot profile metadata di-sync ke radgroupreply
        if (packageData.hotspot_profile && packageData.hotspot_profile !== 'default') {
            try {
                const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
                if (userAuthMode === 'radius') {
                    const { getHotspotProfileMetadata, getRadiusConnection } = require('../config/mikrotik');
                    const conn = await getRadiusConnection();
                    
                    try {
                        const metadata = await getHotspotProfileMetadata(conn, packageData.hotspot_profile);
                        if (metadata && metadata.rate_limit_value && metadata.rate_limit_unit) {
                            // Build rate limit string dari metadata
                            const rateValue = metadata.rate_limit_value;
                            const rateUnit = (metadata.rate_limit_unit || 'M').toUpperCase();
                            const rateLimitStr = `${rateValue}${rateUnit}/${rateValue}${rateUnit}`;
                            
                            // Cek apakah rate limit sudah ada di radgroupreply
                            const [existingRateLimit] = await conn.execute(
                                "SELECT value FROM radgroupreply WHERE groupname = ? AND attribute IN ('MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit') LIMIT 1",
                                [packageData.hotspot_profile]
                            );
                            
                            // Sync rate limit ke radgroupreply jika belum ada
                            if (existingRateLimit.length === 0) {
                                await conn.execute(
                                    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'MikroTik-Rate-Limit', ':=', ?) ON DUPLICATE KEY UPDATE value = ?",
                                    [packageData.hotspot_profile, rateLimitStr, rateLimitStr]
                                );
                                logger.info(`✅ Synced rate limit from metadata to radgroupreply for profile ${packageData.hotspot_profile}: ${rateLimitStr}`);
                            }
                        }
                        await conn.end();
                    } catch (syncError) {
                        await conn.end();
                        logger.warn(`Failed to sync rate limit for profile ${packageData.hotspot_profile}: ${syncError.message}`);
                    }
                }
            } catch (e) {
                logger.warn(`Error syncing rate limit for package ${packageData.name}: ${e.message}`);
            }
        }
        
        res.redirect('/admin/member/packages?success=Paket+Member+berhasil+ditambahkan');
    } catch (error) {
        logger.error(`Error creating member package: ${error.message}`);
        res.redirect('/admin/member/packages?error=' + encodeURIComponent('Gagal menambah paket: ' + error.message));
    }
});

// POST: Update Paket Member
router.post('/packages/:id/update', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, speed, price, tax_rate, description, hotspot_profile,
            upload_limit, download_limit, burst_limit_upload, burst_limit_download,
            burst_threshold, burst_time
        } = req.body;

        if (!name || !speed || !price) {
            return res.redirect('/admin/member/packages?error=Nama,+kecepatan,+dan+harga+harus+diisi');
        }

        // Get existing package to check if hotspot_profile changed
        const existingPackage = await billingManager.getMemberPackageById(id);
        const oldHotspotProfile = existingPackage?.hotspot_profile || 'default';
        const newHotspotProfile = hotspot_profile ? hotspot_profile.trim() : 'default';
        const hotspotProfileChanged = oldHotspotProfile !== newHotspotProfile;

        const packageData = {
            name: name.trim(),
            speed: speed.trim(),
            price: parseFloat(price),
            tax_rate: parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) : 11.00,
            description: description ? description.trim() : null,
            hotspot_profile: newHotspotProfile,
            upload_limit: upload_limit ? upload_limit.trim() : null,
            download_limit: download_limit ? download_limit.trim() : null,
            burst_limit_upload: burst_limit_upload ? burst_limit_upload.trim() : null,
            burst_limit_download: burst_limit_download ? burst_limit_download.trim() : null,
            burst_threshold: burst_threshold ? burst_threshold.trim() : null,
            burst_time: burst_time ? burst_time.trim() : null
        };

        await billingManager.updateMemberPackage(id, packageData);
        logger.info(`Member package updated: ${packageData.name}`);

        // PENTING: Pastikan rate limit dari hotspot profile metadata di-sync ke radgroupreply
        if (newHotspotProfile && newHotspotProfile !== 'default') {
            try {
                const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
                if (userAuthMode === 'radius') {
                    const { getHotspotProfileMetadata, getRadiusConnection } = require('../config/mikrotik');
                    const conn = await getRadiusConnection();
                    
                    try {
                        const metadata = await getHotspotProfileMetadata(conn, newHotspotProfile);
                        if (metadata && metadata.rate_limit_value && metadata.rate_limit_unit) {
                            // Build rate limit string dari metadata
                            const rateValue = metadata.rate_limit_value;
                            const rateUnit = (metadata.rate_limit_unit || 'M').toUpperCase();
                            const rateLimitStr = `${rateValue}${rateUnit}/${rateValue}${rateUnit}`;
                            
                            // Cek apakah rate limit sudah ada di radgroupreply
                            const [existingRateLimit] = await conn.execute(
                                "SELECT value FROM radgroupreply WHERE groupname = ? AND attribute IN ('MikroTik-Rate-Limit', 'Mikrotik-Rate-Limit') LIMIT 1",
                                [newHotspotProfile]
                            );
                            
                            // Sync rate limit ke radgroupreply jika belum ada atau berbeda
                            if (existingRateLimit.length === 0 || existingRateLimit[0].value !== rateLimitStr) {
                                await conn.execute(
                                    "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, 'MikroTik-Rate-Limit', ':=', ?) ON DUPLICATE KEY UPDATE value = ?",
                                    [newHotspotProfile, rateLimitStr, rateLimitStr]
                                );
                                logger.info(`✅ Synced rate limit from metadata to radgroupreply for profile ${newHotspotProfile}: ${rateLimitStr}`);
                            }
                        }
                        await conn.end();
                    } catch (syncError) {
                        await conn.end();
                        logger.warn(`Failed to sync rate limit for profile ${newHotspotProfile}: ${syncError.message}`);
                    }
                }
            } catch (e) {
                logger.warn(`Error syncing rate limit for package ${packageData.name}: ${e.message}`);
            }
        }

        // Jika hotspot_profile berubah, update semua member yang menggunakan paket ini di RADIUS
        if (hotspotProfileChanged) {
            try {
                const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
                if (userAuthMode === 'radius') {
                    // Get all members using this package
                    const members = await billingManager.getAllMembers({ package_id: id });
                    
                    logger.info(`Hotspot profile changed from "${oldHotspotProfile}" to "${newHotspotProfile}" for package ${packageData.name}`);
                    logger.info(`Updating ${members.length} members in RADIUS with new hotspot profile...`);

                    // Verifikasi bahwa hotspot profile baru memiliki rate limit di RADIUS
                    const { getHotspotProfileDetailRadius } = require('../config/mikrotik');
                    const profileDetail = await getHotspotProfileDetailRadius(newHotspotProfile);
                    const rateLimit = profileDetail.success && profileDetail.data ? profileDetail.data['rate-limit'] : null;
                    
                    logger.info(`New hotspot profile "${newHotspotProfile}" rate limit: ${rateLimit || 'Will use rate limit from radgroupreply'}`);

                    let updatedCount = 0;
                    let errorCount = 0;

                    for (const member of members) {
                        try {
                            const hotspotUsername = member.hotspot_username || member.username;
                            if (!hotspotUsername) {
                                logger.warn(`Member ${member.name} (ID: ${member.id}) has no hotspot_username, skipping`);
                                continue;
                            }

                            const server = member.server_hotspot && member.server_hotspot.trim() !== '' 
                                ? member.server_hotspot.trim() 
                                : null;
                            const serverMetadata = server ? { name: server } : null;

                            // Update member in RADIUS with new hotspot profile
                            await addHotspotUserRadius(
                                hotspotUsername,
                                hotspotUsername, // Default password sama dengan username
                                newHotspotProfile,
                                `Member: ${member.name}`,
                                server,
                                serverMetadata,
                                null
                            );

                            logger.info(`✅ Updated member ${member.name} (${hotspotUsername}) in RADIUS with new profile ${newHotspotProfile}`);
                            updatedCount++;
                        } catch (memberError) {
                            logger.error(`❌ Failed to update member ${member.name} in RADIUS: ${memberError.message}`);
                            errorCount++;
                        }
                    }

                    logger.info(`📊 Package update summary: ${updatedCount} members updated, ${errorCount} errors`);
                }
            } catch (syncError) {
                logger.error(`Error syncing members to RADIUS after package update: ${syncError.message}`);
                // Don't fail the package update if sync fails
            }
        }
        
        res.redirect('/admin/member/packages?success=Paket+Member+berhasil+diupdate');
    } catch (error) {
        logger.error(`Error updating member package: ${error.message}`);
        res.redirect('/admin/member/packages?error=' + encodeURIComponent('Gagal mengupdate paket: ' + error.message));
    }
});

// POST: Delete Paket Member
router.post('/packages/:id/delete', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await billingManager.deleteMemberPackage(id);
        logger.info(`Member package deleted: ${id}`);
        
        res.redirect('/admin/member/packages?success=Paket+Member+berhasil+dihapus');
    } catch (error) {
        logger.error(`Error deleting member package: ${error.message}`);
        res.redirect('/admin/member/packages?error=' + encodeURIComponent('Gagal menghapus paket: ' + error.message));
    }
});

// ========== MEMBER DATA ROUTES ==========

// GET: List Members
router.get('/data', adminAuth, async (req, res) => {
    try {
        const filters = {
            status: req.query.status || null,
            package_id: req.query.package_id || null,
            area: req.query.area || null,
            collector_id: req.query.collector_id || null,
            payment_status: req.query.payment_status || null,
            search: req.query.search || null
        };

        const members = await billingManager.getAllMembers(filters);
        const packages = await billingManager.getAllMemberPackages(true);
        
        // Get unique Areas for member filter
        const uniqueAreas = await new Promise((resolve) => {
            const db = require('../config/billing').db;
            db.all('SELECT DISTINCT area FROM members WHERE area IS NOT NULL AND area != "" ORDER BY area', (err, rows) => {
                resolve(rows ? rows.map(r => r.area) : []);
            });
        });

        // Get Collectors
        const collectors = await new Promise((resolve) => {
            const db = require('../config/billing').db;
            db.all('SELECT id, name FROM collectors WHERE status = "active" ORDER BY name', (err, rows) => {
                resolve(rows || []);
            });
        });
        
        // Get hotspot profiles and servers for form
        let hotspotProfiles = [];
        let hotspotServers = [];
        
        try {
            const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
            if (userAuthMode === 'radius') {
                const profilesResult = await getHotspotProfilesRadius();
                if (profilesResult.success) {
                    hotspotProfiles = profilesResult.data || [];
                }
                
                const serversResult = await getHotspotServerProfilesRadius();
                if (serversResult.success) {
                    hotspotServers = serversResult.data || [];
                }
            }
        } catch (e) {
            logger.warn('Error loading hotspot profiles/servers:', e.message);
        }

        const settings = getSettingsWithCache();
        const versionInfo = getVersionInfo();
        const versionBadge = getVersionBadge();

        res.render('admin/member/data', {
            page: 'member-data',
            members: members,
            packages: packages,
            hotspotProfiles: hotspotProfiles,
            hotspotServers: hotspotServers,
            uniqueAreas: uniqueAreas,
            collectors: collectors,
            filters: filters,
            settings: settings,
            versionInfo: versionInfo,
            versionBadge: versionBadge,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        logger.error(`Error loading members: ${error.message}`);
        res.render('admin/member/data', {
            page: 'member-data',
            members: [],
            packages: [],
            hotspotProfiles: [],
            hotspotServers: [],
            filters: {},
            settings: getSettingsWithCache(),
            versionInfo: getVersionInfo(),
            versionBadge: getVersionBadge(),
            error: 'Gagal memuat data member: ' + error.message
        });
    }
});

// POST: Tambah Member
router.post('/data', adminAuth, memberPhotoUpload.fields([
    { name: 'ktp_photo', maxCount: 1 },
    { name: 'house_photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { 
            name, username, phone, hotspot_username, password, email, address, area,
            package_id, hotspot_profile, server_hotspot, auto_suspension, billing_day,
            latitude, longitude
        } = req.body;
        
        // Handle file uploads
        const ktpPhotoPath = req.files && req.files['ktp_photo'] && req.files['ktp_photo'][0] 
            ? `/img/members/${req.files['ktp_photo'][0].filename}` 
            : null;
        const housePhotoPath = req.files && req.files['house_photo'] && req.files['house_photo'][0] 
            ? `/img/members/${req.files['house_photo'][0].filename}` 
            : null;

        if (!name || !phone || !package_id) {
            return res.redirect('/admin/member/data?error=Nama,+nomor+telepon,+dan+paket+harus+diisi');
        }

        // Check auth mode
        let userAuthMode = 'mikrotik';
        try {
            const mode = await getRadiusConfigValue('user_auth_mode', null);
            userAuthMode = mode !== null && mode !== undefined ? mode : 'mikrotik';
        } catch (e) {
            // Fallback
        }

        // Generate username dan hotspot_username jika tidak ada (untuk memastikan tidak null)
        // PENTING: Ini penting untuk suspension karena username tidak boleh null
        // Jika username null, akan menyebabkan error NOT NULL constraint saat update status ke isolir
        const finalUsername = username ? username.trim() : billingManager.generateUsername(phone);
        const finalHotspotUsername = hotspot_username ? hotspot_username.trim() : finalUsername;
        
        // Create member in database
        // PENTING: Pastikan semua field yang diperlukan untuk suspension sudah lengkap
        // - username: Harus ada (tidak null) untuk update status
        // - hotspot_username: Harus ada untuk disable di RADIUS
        // - auto_suspension: Default 1 (enabled) agar suspension otomatis bekerja
        // - status: Default 'active' untuk member baru
        const memberData = {
            name: name.trim(),
            username: finalUsername, // Pastikan tidak null untuk suspension
            phone: phone.trim(),
            hotspot_username: finalHotspotUsername, // Pastikan tidak null untuk suspension
            email: email ? email.trim() : null,
            address: address ? address.trim() : null,
            area: area ? area.trim() : null,
            package_id: parseInt(package_id),
            hotspot_profile: hotspot_profile ? hotspot_profile.trim() : null,
            server_hotspot: server_hotspot ? server_hotspot.trim() : null,
            status: 'active', // Default status active untuk member baru
            auto_suspension: auto_suspension !== undefined ? parseInt(auto_suspension) : 1, // Default 1 (enabled) untuk auto suspension
            billing_day: billing_day ? parseInt(billing_day) : 15,
            latitude: latitude ? parseFloat(latitude) : null,
            longitude: longitude ? parseFloat(longitude) : null,
            ktp_photo_path: ktpPhotoPath,
            house_photo_path: housePhotoPath
        };

        const newMember = await billingManager.createMember(memberData);
        
        // Get package info for hotspot profile
        const packageInfo = await billingManager.getMemberPackageById(package_id);
        const finalHotspotProfile = memberData.hotspot_profile || packageInfo?.hotspot_profile || 'default';
        const finalPassword = password || finalHotspotUsername; // Default password sama dengan username

        // Create hotspot user in RADIUS (100% RADIUS mode)
        // PENTING: Rate limit akan otomatis diterapkan dari radgroupreply berdasarkan groupname (hotspot_profile)
        if (userAuthMode === 'radius') {
            try {
                const server = memberData.server_hotspot && memberData.server_hotspot.trim() !== '' 
                    ? memberData.server_hotspot.trim() 
                    : null;
                const serverMetadata = server ? { name: server } : null;
                
                // Verifikasi bahwa hotspot profile memiliki rate limit di RADIUS
                const { getHotspotProfileDetailRadius } = require('../config/mikrotik');
                const profileDetail = await getHotspotProfileDetailRadius(finalHotspotProfile);
                const rateLimit = profileDetail.success && profileDetail.data ? profileDetail.data['rate-limit'] : null;
                
                logger.info(`Creating member ${memberData.name} with hotspot profile: ${finalHotspotProfile}${rateLimit ? ` (Rate Limit: ${rateLimit})` : ' (No rate limit configured)'}`);
                
                await addHotspotUserRadius(
                    finalHotspotUsername,
                    finalPassword,
                    finalHotspotProfile,
                    `Member: ${memberData.name}`,
                    server,
                    serverMetadata,
                    null
                );
                
                logger.info(`✅ Member ${memberData.name} created in RADIUS:`);
                logger.info(`   - Username: ${finalHotspotUsername}`);
                logger.info(`   - Password: ${finalPassword ? '***' : 'not set'}`);
                logger.info(`   - Hotspot Profile (groupname): ${finalHotspotProfile}`);
                logger.info(`   - Rate Limit: ${rateLimit || 'Will use rate limit from radgroupreply'}`);
            } catch (radiusError) {
                logger.error(`Error creating hotspot user in RADIUS for member ${memberData.name}: ${radiusError.message}`);
                // Continue even if RADIUS creation fails - member already created in DB
            }
        }

        logger.info(`Member created: ${memberData.name} (${memberData.phone})`);
        
        res.redirect('/admin/member/data?success=Member+berhasil+ditambahkan');
    } catch (error) {
        logger.error(`Error creating member: ${error.message}`);
        res.redirect('/admin/member/data?error=' + encodeURIComponent('Gagal menambah member: ' + error.message));
    }
});

// POST: Update Member
router.post('/data/:id/update', adminAuth, memberPhotoUpload.fields([
    { name: 'ktp_photo', maxCount: 1 },
    { name: 'house_photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, username, phone, hotspot_username, password, email, address, area,
            package_id, hotspot_profile, server_hotspot, status, auto_suspension, billing_day,
            latitude, longitude, existing_ktp_photo, existing_house_photo
        } = req.body;
        
        // Handle file uploads - keep existing if no new file uploaded
        let ktpPhotoPath = existing_ktp_photo || null;
        let housePhotoPath = existing_house_photo || null;
        
        if (req.files && req.files['ktp_photo'] && req.files['ktp_photo'][0]) {
            // Delete old file if exists
            if (existing_ktp_photo && existing_ktp_photo.startsWith('/img/members/')) {
                const oldFilePath = path.join(__dirname, '../public', existing_ktp_photo);
                if (fs.existsSync(oldFilePath)) {
                    fs.unlinkSync(oldFilePath);
                }
            }
            ktpPhotoPath = `/img/members/${req.files['ktp_photo'][0].filename}`;
        }
        
        if (req.files && req.files['house_photo'] && req.files['house_photo'][0]) {
            // Delete old file if exists
            if (existing_house_photo && existing_house_photo.startsWith('/img/members/')) {
                const oldFilePath = path.join(__dirname, '../public', existing_house_photo);
                if (fs.existsSync(oldFilePath)) {
                    fs.unlinkSync(oldFilePath);
                }
            }
            housePhotoPath = `/img/members/${req.files['house_photo'][0].filename}`;
        }

        if (!name || !phone || !package_id) {
            return res.redirect('/admin/member/data?error=Nama,+nomor+telepon,+dan+paket+harus+diisi');
        }

        // Get existing member
        const existingMember = await billingManager.getMemberById(id);
        if (!existingMember) {
            return res.redirect('/admin/member/data?error=Member+tidak+ditemukan');
        }

        const oldStatus = existingMember.status;
        const newStatus = status || 'active';

        // Update member in database
        const memberData = {
            name: name.trim(),
            username: username ? username.trim() : null,
            phone: phone.trim(),
            hotspot_username: hotspot_username ? hotspot_username.trim() : null,
            email: email ? email.trim() : null,
            address: address ? address.trim() : null,
            area: area ? area.trim() : null,
            package_id: parseInt(package_id),
            hotspot_profile: hotspot_profile ? hotspot_profile.trim() : null,
            server_hotspot: server_hotspot ? server_hotspot.trim() : null,
            status: newStatus,
            auto_suspension: auto_suspension !== undefined ? parseInt(auto_suspension) : 1,
            billing_day: billing_day ? parseInt(billing_day) : 15,
            latitude: latitude ? parseFloat(latitude) : null,
            longitude: longitude ? parseFloat(longitude) : null,
            ktp_photo_path: ktpPhotoPath,
            house_photo_path: housePhotoPath
        };

        await billingManager.updateMember(id, memberData);

        // Handle status change - disable/enable hotspot user in RADIUS
        const finalHotspotUsername = memberData.hotspot_username || existingMember.hotspot_username;
        if (finalHotspotUsername && oldStatus !== newStatus) {
            try {
                const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
                if (userAuthMode === 'radius') {
                    const { disableHotspotUserRadius, enableHotspotUserRadius, disconnectHotspotUser } = require('../config/mikrotik');
                    
                    // Jika status berubah ke suspend atau isolir, disable hotspot user
                    if (newStatus === 'suspend' || newStatus === 'isolir') {
                        logger.info(`Member ${finalHotspotUsername} status changed to ${newStatus}, disabling hotspot user...`);
                        
                        // Disconnect active session first
                        try {
                            await disconnectHotspotUser(finalHotspotUsername);
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch (disconnectError) {
                            logger.warn(`Failed to disconnect hotspot session: ${disconnectError.message}`);
                        }
                        
                        // Disable hotspot user in RADIUS
                        const disableResult = await disableHotspotUserRadius(finalHotspotUsername);
                        if (disableResult && disableResult.success) {
                            logger.info(`✅ Member ${finalHotspotUsername} disabled in RADIUS (status: ${newStatus})`);
                        } else {
                            logger.error(`❌ Failed to disable member ${finalHotspotUsername} in RADIUS`);
                        }
                    }
                    // Jika status berubah ke active, enable hotspot user
                    else if (newStatus === 'active') {
                        logger.info(`Member ${finalHotspotUsername} status changed to active, enabling hotspot user...`);
                        
                        const enableResult = await enableHotspotUserRadius(finalHotspotUsername);
                        if (enableResult && enableResult.success) {
                            logger.info(`✅ Member ${finalHotspotUsername} enabled in RADIUS (status: active)`);
                        } else {
                            logger.error(`❌ Failed to enable member ${finalHotspotUsername} in RADIUS`);
                        }
                    }
                } else {
                    logger.warn(`User auth mode is not RADIUS (${userAuthMode}), skipping RADIUS sync`);
                }
            } catch (statusSyncError) {
                logger.error(`Failed to sync status change for member ${finalHotspotUsername}:`, statusSyncError);
                // Jangan gagalkan update member jika error sync status
            }
        } else if (finalHotspotUsername && oldStatus === newStatus) {
            logger.info(`Member ${finalHotspotUsername} status unchanged (${newStatus}), skipping RADIUS sync`);
        } else if (!finalHotspotUsername) {
            logger.warn(`Member ${memberData.name} has no hotspot_username, skipping RADIUS sync`);
        }

        // Update hotspot user in RADIUS if password or profile changed
        // Note: finalHotspotUsername sudah dideklarasikan di atas (line 409)
        // PENTING: Jika hotspot_profile berubah, groupname di RADIUS akan di-update dan rate limit akan mengikuti profile baru
        if (finalHotspotUsername && (password || memberData.hotspot_profile)) {
            try {
                const userAuthMode = await getRadiusConfigValue('user_auth_mode', 'radius');
                if (userAuthMode === 'radius') {
                    const packageInfo = await billingManager.getMemberPackageById(package_id);
                    const finalHotspotProfile = memberData.hotspot_profile || packageInfo?.hotspot_profile || 'default';
                    const finalPassword = password || existingMember.hotspot_username; // Keep existing password if not changed
                    
                    // Verifikasi bahwa hotspot profile memiliki rate limit di RADIUS
                    const { getHotspotProfileDetailRadius } = require('../config/mikrotik');
                    const profileDetail = await getHotspotProfileDetailRadius(finalHotspotProfile);
                    const rateLimit = profileDetail.success && profileDetail.data ? profileDetail.data['rate-limit'] : null;
                    
                    logger.info(`Updating member ${memberData.name} hotspot user in RADIUS:`);
                    logger.info(`   - Username: ${finalHotspotUsername}`);
                    logger.info(`   - Hotspot Profile (groupname): ${finalHotspotProfile}${existingMember.hotspot_profile !== finalHotspotProfile ? ` (changed from ${existingMember.hotspot_profile || 'default'})` : ''}`);
                    logger.info(`   - Rate Limit: ${rateLimit || 'Will use rate limit from radgroupreply'}`);
                    
                    const server = memberData.server_hotspot && memberData.server_hotspot.trim() !== '' 
                        ? memberData.server_hotspot.trim() 
                        : null;
                    const serverMetadata = server ? { name: server } : null;
                    
                    await addHotspotUserRadius(
                        finalHotspotUsername,
                        finalPassword,
                        finalHotspotProfile,
                        `Member: ${memberData.name}`,
                        server,
                        serverMetadata,
                        null
                    );
                    
                    logger.info(`✅ Member ${memberData.name} hotspot user updated in RADIUS with profile ${finalHotspotProfile}`);
                }
            } catch (radiusError) {
                logger.error(`Error updating hotspot user in RADIUS for member ${memberData.name}: ${radiusError.message}`);
                // Continue even if RADIUS update fails
            }
        }

        logger.info(`Member updated: ${memberData.name} (${memberData.phone})`);
        
        res.redirect('/admin/member/data?success=Member+berhasil+diupdate');
    } catch (error) {
        logger.error(`Error updating member: ${error.message}`);
        res.redirect('/admin/member/data?error=' + encodeURIComponent('Gagal mengupdate member: ' + error.message));
    }
});

// POST: Delete Member
router.post('/data/:id/delete', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const member = await billingManager.getMemberById(id);
        
        if (member) {
            await billingManager.deleteMember(id);
            logger.info(`Member deleted: ${member.name} (${member.phone})`);
        }
        
        res.redirect('/admin/member/data?success=Member+berhasil+dihapus');
    } catch (error) {
        logger.error(`Error deleting member: ${error.message}`);
        res.redirect('/admin/member/data?error=' + encodeURIComponent('Gagal menghapus member: ' + error.message));
    }
});

// POST: Sync Member Status Based on Overdue Invoices
router.post('/data/sync-status', adminAuth, async (req, res) => {
    try {
        const { hotspot_username } = req.body;
        const serviceSuspension = require('../config/serviceSuspension');
        const { getSetting } = require('../config/settingsManager');
        
        let results = {
            checked: 0,
            updated: 0,
            errors: 0,
            details: []
        };
        
        if (hotspot_username) {
            // Sync specific member
            const member = await billingManager.getMemberByHotspotUsername(hotspot_username);
            if (!member) {
                return res.json({
                    success: false,
                    message: `Member dengan hotspot username "${hotspot_username}" tidak ditemukan`
                });
            }
            
            // Check overdue invoices for this member
            const overdueInvoices = await billingManager.getOverdueInvoices();
            const memberOverdueInvoices = overdueInvoices.filter(inv => 
                inv.member_id === member.id && inv.invoice_type_entity === 'member'
            );
            
            if (memberOverdueInvoices.length > 0) {
                const gracePeriodDays = parseInt(getSetting('suspension_grace_period_days', '7'));
                const today = new Date();
                
                for (const invoice of memberOverdueInvoices) {
                    const dueDate = new Date(invoice.due_date);
                    const dueDateStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
                    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                    const daysOverdue = Math.floor((todayStart - dueDateStart) / (1000 * 60 * 60 * 24));
                    
                    if (daysOverdue >= gracePeriodDays && member.status !== 'isolir' && member.auto_suspension !== 0) {
                        // Member should be isolir but status is still active
                        logger.info(`Syncing member ${member.hotspot_username} status: overdue ${daysOverdue} days, current status: ${member.status}`);
                        
                        const suspensionResult = await serviceSuspension.suspendMemberService(
                            member, 
                            `Sync status: Telat bayar ${daysOverdue} hari`
                        );
                        
                        if (suspensionResult.success) {
                            results.updated++;
                            results.details.push({
                                member: member.hotspot_username || member.name,
                                invoice: invoice.invoice_number,
                                daysOverdue,
                                action: 'isolir',
                                status: 'success'
                            });
                        } else {
                            results.errors++;
                            results.details.push({
                                member: member.hotspot_username || member.name,
                                invoice: invoice.invoice_number,
                                daysOverdue,
                                action: 'isolir',
                                status: 'failed',
                                error: suspensionResult.message
                            });
                        }
                    }
                }
            }
            
            results.checked = 1;
        } else {
            // Sync all members with overdue invoices
            const overdueInvoices = await billingManager.getOverdueInvoices();
            const memberInvoices = overdueInvoices.filter(inv => 
                inv.member_id && inv.invoice_type_entity === 'member'
            );
            
            const gracePeriodDays = parseInt(getSetting('suspension_grace_period_days', '7'));
            const today = new Date();
            const processedMembers = new Set();
            
            for (const invoice of memberInvoices) {
                if (processedMembers.has(invoice.member_id)) continue;
                
                try {
                    const member = await billingManager.getMemberById(invoice.member_id);
                    if (!member) continue;
                    
                    processedMembers.add(invoice.member_id);
                    results.checked++;
                    
                    // Check if member has overdue invoice beyond grace period
                    const dueDate = new Date(invoice.due_date);
                    const dueDateStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
                    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                    const daysOverdue = Math.floor((todayStart - dueDateStart) / (1000 * 60 * 60 * 24));
                    
                    if (daysOverdue >= gracePeriodDays && member.status !== 'isolir' && member.auto_suspension !== 0) {
                        logger.info(`Syncing member ${member.hotspot_username} status: overdue ${daysOverdue} days, current status: ${member.status}`);
                        
                        const suspensionResult = await serviceSuspension.suspendMemberService(
                            member, 
                            `Sync status: Telat bayar ${daysOverdue} hari`
                        );
                        
                        if (suspensionResult.success) {
                            results.updated++;
                            results.details.push({
                                member: member.hotspot_username || member.name,
                                invoice: invoice.invoice_number,
                                daysOverdue,
                                action: 'isolir',
                                status: 'success'
                            });
                        } else {
                            results.errors++;
                            results.details.push({
                                member: member.hotspot_username || member.name,
                                invoice: invoice.invoice_number,
                                daysOverdue,
                                action: 'isolir',
                                status: 'failed',
                                error: suspensionResult.message
                            });
                        }
                    }
                } catch (error) {
                    results.errors++;
                    logger.error(`Error syncing member for invoice ${invoice.invoice_number}:`, error);
                }
            }
        }
        
        res.json({
            success: true,
            message: `Sync selesai. Diperiksa: ${results.checked}, Diupdate: ${results.updated}, Error: ${results.errors}`,
            results
        });
    } catch (error) {
        logger.error('Error syncing member status:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal sync status member: ' + error.message
        });
    }
});

// GET: List Member dengan Status Online/Offline
router.get('/list', adminAuth, async (req, res) => {
    try {
        const { getUserAuthModeAsync, getMembersWithStatusRadius } = require('../config/mikrotik');
        const authMode = await getUserAuthModeAsync();
        
        logger.info(`Loading members list in ${authMode} mode`);
        
        let members = [];
        
        if (authMode === 'radius') {
            // RADIUS mode: Get members from billing database with online/offline status from RADIUS
            try {
                members = await getMembersWithStatusRadius();
                logger.info(`Found ${members.length} members with status`);
            } catch (error) {
                logger.error(`Error loading members: ${error.message}`);
                members = [];
            }
        } else {
            // Mikrotik API mode: Not supported for members (members use RADIUS)
            logger.warn('Member list only supports RADIUS mode');
            members = [];
        }
        
        // Calculate statistics
        const totalMembers = members.length;
        const activeMembers = members.filter(m => m.active).length;
        const offlineMembers = totalMembers - activeMembers;
        
        const settings = getSettingsWithCache();
        const versionInfo = getVersionInfo();
        const versionBadge = getVersionBadge();
        
        res.render('admin/member/list', {
            page: 'member-list',
            members: members,
            authMode: authMode,
            stats: {
                total: totalMembers,
                active: activeMembers,
                offline: offlineMembers
            },
            settings: settings,
            versionInfo: versionInfo,
            versionBadge: versionBadge,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (error) {
        logger.error('Error loading members list:', error);
        const settings = getSettingsWithCache();
        const versionInfo = getVersionInfo();
        const versionBadge = getVersionBadge();
        res.render('admin/member/list', {
            page: 'member-list',
            members: [],
            authMode: 'radius',
            stats: {
                total: 0,
                active: 0,
                offline: 0
            },
            settings: settings,
            versionInfo: versionInfo,
            versionBadge: versionBadge,
            error: `Gagal memuat data member: ${error.message}`
        });
    }
});

// POST: Disconnect Member Session
router.post('/disconnect', adminAuth, async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!username) {
            return res.json({
                success: false,
                message: 'Username tidak ditemukan'
            });
        }
        
        const { disconnectHotspotUser } = require('../config/mikrotik');
        const result = await disconnectHotspotUser(username);
        
        if (result.success) {
            logger.info(`Member session disconnected: ${username}`);
            res.json({
                success: true,
                message: 'Sesi berhasil diputuskan'
            });
        } else {
            res.json({
                success: false,
                message: result.message || 'Gagal memutuskan sesi'
            });
        }
    } catch (error) {
        logger.error('Error disconnecting member session:', error);
        res.json({
            success: false,
            message: 'Gagal memutuskan sesi: ' + error.message
        });
    }
});

module.exports = router;
