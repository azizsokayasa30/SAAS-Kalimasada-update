const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { verifyToken } = require('./auth');

// Database connection
const dbPath = path.join(process.cwd(), 'data/billing.db');
const db = new sqlite3.Database(dbPath);

// API: GET /api/installations
router.get('/', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT ij.*, 
                   p.name as package_name,
                   t.name as technician_name
            FROM installation_jobs ij
            LEFT JOIN packages p ON ij.package_id = p.id
            LEFT JOIN technicians t ON ij.assigned_technician_id = t.id
            ORDER BY ij.created_at DESC
        `;
        
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, data: rows });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: PATCH /api/installations/:id/status
router.patch('/:id/status', verifyToken, async (req, res) => {
    try {
        const { status, note } = req.body;
        const jobId = req.params.id;

        db.get('SELECT status FROM installation_jobs WHERE id = ?', [jobId], (err, job) => {
            if (err || !job) return res.status(404).json({ success: false, message: 'Job not found' });

            const oldStatus = job.status;
            db.run(`UPDATE installation_jobs SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [status, jobId], function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });

                // Log history
                db.run(`
                    INSERT INTO installation_job_status_history (job_id, old_status, new_status, changed_by_type, changed_by_id, notes)
                    VALUES (?, ?, ?, 'mobile_api', ?, ?)
                `, [jobId, oldStatus, status, req.user.username, note || 'Updated via Mobile API'], (err) => {
                    res.json({ success: true, message: 'Status updated successfully' });
                });
            });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
