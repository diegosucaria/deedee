const express = require('express');

/**
 * /internal/approvals: pending confirmations for the settings card.
 * Behind DEEDEE_INTERNAL_TOKEN like every /internal route; the web app
 * reaches it through the API gateway at /v1/approvals.
 */
function createApprovalsRouter(agent) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!agent || !agent.approvals) return res.status(503).json({ error: 'Approvals not initialized' });
        next();
    });

    // GET /internal/approvals?limit=50 -> { pending, recent, counts, settings }
    router.get('/', (req, res) => {
        try {
            res.json(agent.approvals.list({ limit: parseInt(req.query.limit) || 50 }));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    const decide = (decision) => async (req, res) => {
        try {
            const result = await agent.approvals.decide(req.params.id, decision, { via: 'web' });
            if (result.error) {
                const code = result.status === 'missing' ? 404 : 409;
                return res.status(code).json({ error: result.error, status: result.status });
            }
            res.json({
                success: true,
                id: req.params.id,
                status: decision,
                result: result.result ?? null,
                row: agent.approvals.db.getPendingConfirmation(req.params.id)
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    };

    // POST /internal/approvals/:id/approve — runs the stored call and reports to the owner.
    router.post('/:id/approve', decide('approved'));
    // POST /internal/approvals/:id/deny
    router.post('/:id/deny', decide('denied'));

    return router;
}

module.exports = { createApprovalsRouter };
