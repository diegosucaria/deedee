const schedule = require('node-schedule');

class Scheduler {
    constructor(agent) {
        this.agent = agent;
        this.jobs = {}; // Store job references
        console.log('[Scheduler] Initialized.');
    }

    /**
     * Schedule a recurring job.
     * @param {string} name - Unique job name
     * @param {string} cronExpression - Cron rule (e.g., '0 8 * * *')
     * @param {function} callback - Async function to run
     */
    scheduleJob(name, cronExpression, callback) {
        if (this.jobs[name]) {
            this.jobs[name].cancel();
        }

        const job = schedule.scheduleJob(cronExpression, async () => {
            console.log(`[Scheduler] Running job: ${name}`);
            try {
                await callback();
            } catch (err) {
                console.error(`[Scheduler] Job ${name} failed:`, err);
            }
        });

        this.jobs[name] = job;
        // Attach metadata to the job object for retrieval
        this.jobs[name].metadata = {
            name,
            cronExpression,
            createdAt: new Date()
        };
        console.log(`[Scheduler] Job '${name}' scheduled with rule: ${cronExpression}`);
    }

    cancelJob(name) {
        if (this.jobs[name]) {
            this.jobs[name].cancel();
            delete this.jobs[name];
            console.log(`[Scheduler] Job '${name}' cancelled.`);
        }
    }
}

module.exports = { Scheduler };
