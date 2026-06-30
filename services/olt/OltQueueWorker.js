const os = require('os');
const OltRepository = require('./repositories/OltRepository');
const oltService = require('./OltService');
const logger = require('../../config/logger');

class OltQueueWorker {
    constructor(repository = new OltRepository()) {
        this.repository = repository;
        this.workerId = `${os.hostname()}-${process.pid}`;
        this.isRunning = false;
        this.interval = null;
    }

    start(intervalMs = 15000) {
        if (this.interval) return;
        this.interval = setInterval(() => {
            this.processOnce().catch((err) => logger.error('[olt-worker] loop error:', err));
        }, intervalMs);
        this.processOnce().catch((err) => logger.error('[olt-worker] initial error:', err));
        logger.info(`[olt-worker] started as ${this.workerId}`);
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
    }

    async processOnce() {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            for (let i = 0; i < 3; i++) {
                const job = await this.repository.claimNextJob(this.workerId);
                if (!job) break;
                try {
                    await oltService.syncOlt(job.olt_id, job.id);
                    await this.repository.completeJob(job.id);
                } catch (error) {
                    await this.repository.failJob(job, error.message);
                }
            }
        } finally {
            this.isRunning = false;
        }
    }
}

module.exports = new OltQueueWorker();
module.exports.OltQueueWorker = OltQueueWorker;
