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
            // Check DB
            try {
                // Determine if DB is connected by running a simple query
                if (agent.db && agent.db.db) {
                    // Check connection
                    if (agent.db.db.open) {
                        health.checks.db = 'ok';
                    } else {
                        health.checks.db = 'closed';
                        health.status = 'degraded';
                    }
                } else {
                    health.checks.db = 'missing';
                }
            } catch (e) {
                health.checks.db = 'error';
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
