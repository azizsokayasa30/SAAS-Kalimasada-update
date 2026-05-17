const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { verifyToken } = require('./auth');

// Database helper
const getDB = () => new sqlite3.Database(path.join(__dirname, '../../data/billing.db'));

// API: GET /api/technicians/jobs
router.get('/jobs', verifyToken, async (req, res) => {
    const technicianId = Number(req.user.id);
    const db = getDB();
    const logger = require('../../config/logger');
    console.log(`[DEBUG-CONSOLE] Querying jobs for ID: ${technicianId}`);
    logger.info(`[DEBUG] Fetching jobs for technicianId: ${technicianId} (type: ${typeof technicianId})`);

    // 1. Get Installations from DB
    const installQuery = `
        SELECT ij.*, 'installation' as job_type, p.name as package_name
        FROM installation_jobs ij
        LEFT JOIN packages p ON ij.package_id = p.id
        WHERE (
            ij.assigned_technician_id = ?
            OR CAST(ij.assigned_technician_id AS TEXT) = ?
            OR IFNULL(TRIM(CAST(ij.assigned_technician_id AS TEXT)), '') IN ('', '0')
        )
        AND ij.status NOT IN ('completed', 'cancelled')
    `;

    const installParams = [technicianId, String(technicianId)];
    db.all(installQuery, installParams, async (err, installations) => {
        db.close();
        if (err) {
            logger.error(`[DEBUG] Error fetching installations: ${err.message}`);
            return res.status(500).json({ success: false, message: err.message });
        }

        logger.info(`[DEBUG] Found ${installations.length} installations for technicianId: ${technicianId}`);
        if (installations.length > 0) {
            logger.info(`[DEBUG] First installation sample: ${JSON.stringify(installations[0])}`);
        }

        // 2. Get Trouble Reports from Database
        try {
            const { getAllTroubleReports } = require('../../config/troubleReport');
            const allReports = await getAllTroubleReports();
            
            // Filter reports assigned to this technician and not resolved/closed
            const techIdStr = String(technicianId);
            const myReports = allReports.filter(r => {
                const aid = String(r.assigned_technician_id ?? r.assignedTechnicianId ?? '').trim();
                const openPool = aid === '' || aid === '0';
                return (String(r.assigned_technician_id ?? r.assignedTechnicianId) === techIdStr || openPool) &&
                    !['resolved', 'closed'].includes(r.status);
            }).map(r => ({
                ...r,
                job_type: 'repair'
            }));

            // Combine both
            const parsedInstallations = installations.map(i => {
                try {
                    return { ...i, notes: JSON.parse(i.notes || '[]') };
                } catch (e) {
                    return { ...i, notes: [] };
                }
            });

            const allJobs = [...parsedInstallations, ...myReports].sort((a, b) => 
                new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt)
            );

            res.json({ success: true, data: allJobs });
        } catch (e) {
            logger.error(`[DEBUG] Error fetching trouble reports: ${e.message}`);
            // Still return installations if trouble reports fail
            res.json({ success: true, data: installations });
        }
    });
});

// API: GET /api/technicians/stats
router.get('/stats', verifyToken, async (req, res) => {
    try {
        const technicianId = Number(req.user.id);
        const db = getDB();

        const [installCount, repairCount] = await Promise.all([
            new Promise((resolve) => {
                db.get(
                    `SELECT COUNT(*) as count FROM installation_jobs WHERE (
                        assigned_technician_id = ?
                        OR CAST(assigned_technician_id AS TEXT) = ?
                        OR IFNULL(TRIM(CAST(assigned_technician_id AS TEXT)), '') IN ('', '0')
                    ) AND status NOT IN ('completed', 'cancelled')`,
                    [technicianId, String(technicianId)],
                    (err, row) => resolve(row ? row.count : 0)
                );
            }),
            (async () => {
                const { getAllTroubleReports } = require('../../config/troubleReport');
                const reports = await getAllTroubleReports();
                const techIdStr = String(technicianId);
                return reports.filter((r) => {
                    const aid = String(r.assigned_technician_id ?? r.assignedTechnicianId ?? '').trim();
                    const openPool = aid === '' || aid === '0';
                    return (String(r.assigned_technician_id ?? r.assignedTechnicianId) === techIdStr || openPool) &&
                        !['resolved', 'closed'].includes(r.status);
                }).length;
            })()
        ]);

        db.close();
        res.json({
            success: true,
            data: {
                activeInstallations: installCount,
                activeRepairs: repairCount,
                totalJobs: installCount + repairCount
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: GET /api/technicians/history
router.get('/history', verifyToken, async (req, res) => {
    const technicianId = Number(req.user.id);
    const db = getDB();
    const logger = require('../../config/logger');

    try {
        // 1. Get Completed/Cancelled Installations
        const installQuery = `
            SELECT ij.*, 'installation' as job_type, p.name as package_name
            FROM installation_jobs ij
            LEFT JOIN packages p ON ij.package_id = p.id
            WHERE ij.assigned_technician_id = ? AND ij.status IN ('completed', 'cancelled')
            ORDER BY ij.updated_at DESC
        `;

        const installations = await new Promise((resolve, reject) => {
            db.all(installQuery, [technicianId], (err, rows) => err ? reject(err) : resolve(rows));
        });

        // 2. Get Resolved/Closed Trouble Reports
        const { getAllTroubleReports } = require('../../config/troubleReport');
        const allReports = await getAllTroubleReports();
        const techIdStr = String(technicianId);
        const historyReports = allReports.filter(r => 
            String(r.assigned_technician_id || r.assignedTechnicianId) === techIdStr && 
            ['resolved', 'closed'].includes(r.status)
        ).map(r => ({ ...r, job_type: 'repair' }));

        // Combine and Sort
        const parsedInstallations = installations.map(i => {
            try { return { ...i, notes: JSON.parse(i.notes || '[]') }; } catch (e) { return { ...i, notes: [] }; }
        });

        const history = [...parsedInstallations, ...historyReports].sort((a, b) => 
            new Date(b.updated_at || b.updatedAt) - new Date(a.updated_at || a.updatedAt)
        );

        res.json({ success: true, data: history });
    } catch (error) {
        logger.error(`[DEBUG] Error in GET /history: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        db.close();
    }
});

// API: GET /api/technicians/inventory
router.get('/inventory', verifyToken, async (req, res) => {
    const technicianId = Number(req.user.id);
    const db = getDB();
    const logger = require('../../config/logger');

    try {
        // Fetch ONU devices assigned to this technician or available
        const query = `
            SELECT o.*, p.name as package_name, c.name as customer_name
            FROM onu_devices o
            LEFT JOIN installation_jobs ij ON o.sn = ij.sn
            LEFT JOIN packages p ON ij.package_id = p.id
            LEFT JOIN customers c ON ij.customer_name = c.name
            WHERE o.assigned_technician_id = ? OR o.status = 'available'
            ORDER BY o.status ASC
        `;

        db.all(query, [technicianId], (err, rows) => {
            if (err) throw err;
            res.json({ success: true, data: rows });
        });
    } catch (error) {
        logger.error(`[DEBUG] Error in GET /inventory: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    } finally {
        db.close();
    }
});

// API: GET /api/technicians/customers
router.get('/customers', verifyToken, async (req, res) => {
    try {
        const billingManager = require('../../config/billing');
        const customers = await billingManager.getCustomers();
        // For simplicity, technicians see all active customers
        res.json({ success: true, data: (customers || []).filter(c => c.status === 'active') });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API: PATCH /api/technicians/jobs/:id
router.patch('/jobs/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { type, status, notes, odp, sn, signal_level } = req.body;
    const technicianId = Number(req.user.id);
    const db = getDB();
    const logger = require('../../config/logger');

    logger.info(`[DEBUG] Updating ${type} job ${id} to status ${status} by technician ${technicianId}`);

    try {
        if (type === 'installation') {
            // Get current notes first
            db.get("SELECT notes FROM installation_jobs WHERE id = ?", [id], (err, row) => {
                if (err) {
                    db.close();
                    return res.status(500).json({ success: false, message: err.message });
                }

                let currentNotes = [];
                try {
                    currentNotes = JSON.parse(row.notes || '[]');
                } catch (e) {
                    if (row.notes) currentNotes = [{ timestamp: new Date().toISOString(), content: row.notes, status: 'previous' }];
                }

                if (notes) {
                    currentNotes.push({
                        timestamp: new Date().toISOString(),
                        content: notes,
                        status: status
                    });
                }

                const updateSql = `UPDATE installation_jobs SET status = ?, notes = ?, odp = ?, sn = ?, signal_level = ?, updated_at = datetime('now','localtime') WHERE id = ? AND assigned_technician_id = ?`;
                db.run(updateSql, [status, JSON.stringify(currentNotes), odp, sn, signal_level, id, technicianId], function(err) {
                    db.close();
                    if (err) {
                        logger.error(`[DEBUG] Error updating installation status: ${err.message}`);
                        return res.status(500).json({ success: false, message: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ success: false, message: 'Pekerjaan tidak ditemukan atau bukan milik Anda' });
                    }
                    res.json({ success: true, message: 'Status instalasi diperbarui' });
                });
            });
        } else {
            // Repair / Trouble Report
            const { updateTroubleReportStatus } = require('../../config/troubleReport');
            const updated = await updateTroubleReportStatus(id, status, notes, { odp, sn, signal_level });
            db.close();
            if (!updated) {
                return res.status(404).json({ success: false, message: 'Laporan gangguan tidak ditemukan' });
            }
            res.json({ success: true, message: 'Status gangguan diperbarui', data: updated });
        }
    } catch (error) {
        if (db) db.close();
        logger.error(`[DEBUG] Error in PATCH /jobs/${id}: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
