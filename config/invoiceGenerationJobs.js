const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JOBS_DIR = path.join(__dirname, '..', 'tmp', 'invoice-generation-jobs');
const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function ensureJobsDir() {
    if (!fs.existsSync(JOBS_DIR)) {
        fs.mkdirSync(JOBS_DIR, { recursive: true });
    }
}

function jobFilePath(jobId) {
    return path.join(JOBS_DIR, `${jobId}.json`);
}

function persistJob(job) {
    ensureJobsDir();
    fs.writeFileSync(jobFilePath(job.id), JSON.stringify(job), 'utf8');
}

function loadJob(jobId) {
    if (jobs.has(jobId)) return jobs.get(jobId);
    const fp = jobFilePath(jobId);
    if (!fs.existsSync(fp)) return null;
    try {
        const job = JSON.parse(fs.readFileSync(fp, 'utf8'));
        jobs.set(jobId, job);
        return job;
    } catch (_) {
        return null;
    }
}

function createInvoiceGenerationJob() {
    const id = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
        id,
        status: 'queued',
        created_at: new Date().toISOString(),
        progress: {
            phase: 'queued',
            processed: 0,
            total: 0,
            created: 0,
            skipped: 0,
            failed: 0
        },
        stats: null,
        error: null
    };
    jobs.set(id, job);
    persistJob(job);
    return job;
}

function updateInvoiceGenerationJob(jobId, patch = {}) {
    const base = jobs.get(jobId) || loadJob(jobId);
    if (!base) return null;
    const next = { ...base, ...patch };
    if (patch.progress) {
        next.progress = { ...base.progress, ...patch.progress };
    }
    jobs.set(jobId, next);
    persistJob(next);
    return next;
}

function getInvoiceGenerationJob(jobId) {
    return jobs.get(jobId) || loadJob(jobId);
}

function cleanupOldInvoiceJobs() {
    ensureJobsDir();
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const name of fs.readdirSync(JOBS_DIR)) {
        if (!name.endsWith('.json')) continue;
        const fp = path.join(JOBS_DIR, name);
        try {
            const st = fs.statSync(fp);
            if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch (_) { /* ignore */ }
    }
}

module.exports = {
    createInvoiceGenerationJob,
    updateInvoiceGenerationJob,
    getInvoiceGenerationJob,
    cleanupOldInvoiceJobs
};
