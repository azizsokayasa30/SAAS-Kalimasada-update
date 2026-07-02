const cron = require('node-cron');
const OltRepository = require('./repositories/OltRepository');
const oltQueueWorker = require('./OltQueueWorker');
const logger = require('../../config/logger');
const { getServerTimezone } = require('../../config/settingsManager');

class OltSyncScheduler {
    constructor(repository = new OltRepository()) {
        this.repository = repository;
        this.started = false;
        this.task = null;
    }

    start() {
        if (this.started) return;
        this.started = true;
        oltQueueWorker.start();
        this.task = cron.schedule('* * * * *', async () => {
            try {
                const queued = await this.repository.enqueueDueJobs();
                if (queued > 0) {
                    logger.info(`[olt-scheduler] queued ${queued} OLT sync job(s)`);
                }
            } catch (error) {
                logger.error('[olt-scheduler] failed to enqueue jobs:', error);
            }
        }, {
            scheduled: true,
            timezone: getServerTimezone()
        });
        logger.info('[olt-scheduler] initialized for 1/5/10/15 minute polling intervals');
    }
}

module.exports = new OltSyncScheduler();
module.exports.OltSyncScheduler = OltSyncScheduler;
