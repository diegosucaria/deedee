const express = require('express');

function createHealthRouter(agent) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        const health = {
            service: 'agent',
            status: 'ok',
            initialized: !!agent,
            timestamp: new Date().toISOString(),
            checks: {
                db: 'unknown',
                config: 'unknown'
            }
        };

        if (agent) {
            // Check DB with real integrity check
            try {
                if (agent.db && agent.db.healthCheck) {
                    const dbHealth = agent.db.healthCheck();
                    health.checks.db = dbHealth.ok ? 'ok' : dbHealth.details.status;
                    if (!dbHealth.ok) {
                        health.status = dbHealth.details.status === 'corrupt' ? 'corrupt' : 'degraded';
                        health.checks.dbDetails = dbHealth.details;
                    }
                } else if (agent.db && agent.db.db) {
                    health.checks.db = agent.db.db.open ? 'ok' : 'closed';
                    if (!agent.db.db.open) health.status = 'degraded';
                } else {
                    health.checks.db = 'missing';
                }
            } catch (e) {
                health.checks.db = 'error';
                health.checks.dbError = e.message;
                health.status = 'degraded';
            }

            // Check Config
            if (agent.configService) {
                health.checks.config = 'loaded';
            }
        }

        res.json(health);
    });

    return router;
}

module.exports = { createHealthRouter };
