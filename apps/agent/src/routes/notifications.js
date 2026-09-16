const express = require('express');

function createNotificationsRouter(agent) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!agent) return res.status(503).json({ error: 'Agent not initialized' });
        next();
    });

    // GET /internal/notifications?limit=50&includeRead=false&includeDismissed=false
    router.get('/', (req, res) => {
        try {
            const { limit, includeRead, includeDismissed } = req.query;
            const notifications = agent.db.getNotifications({
                limit: parseInt(limit) || 50,
                includeRead: includeRead === 'true',
                includeDismissed: includeDismissed === 'true',
            });
            const unreadCount = agent.db.getUnreadNotificationCount();
            res.json({ notifications, unreadCount });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /internal/notifications/outbox?limit=50&status=failed
    // Delivery ledger: recent rows plus counts by status.
    router.get('/outbox', (req, res) => {
        try {
            const { limit, status } = req.query;
            const statusFilter = status && ['pending', 'sent', 'failed', 'dead'].includes(status) ? status : null;
            const rows = agent.delivery.listRecent(parseInt(limit) || 50, statusFilter);
            res.json({ rows, counts: agent.delivery.counts() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /internal/notifications/outbox/:id/retry
    // Puts a pending, failed or dead row back in line and tries at once.
    router.post('/outbox/:id/retry', async (req, res) => {
        try {
            const result = await agent.delivery.retryNow(req.params.id);
            if (!result) return res.status(404).json({ error: 'Row not found or already sent' });
            res.json({ success: true, delivered: !!result.delivered, status: result.status, via: result.via || null, row: result.row });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /internal/notifications/count
    router.get('/count', (req, res) => {
        try {
            res.json({ count: agent.db.getUnreadNotificationCount() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /internal/notifications/:id/read
    router.post('/:id/read', (req, res) => {
        try {
            agent.db.markNotificationRead(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /internal/notifications/read-all
    router.post('/read-all', (req, res) => {
        try {
            agent.db.markAllNotificationsRead();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /internal/notifications/:id/dismiss
    router.post('/:id/dismiss', (req, res) => {
        try {
            agent.db.dismissNotification(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /internal/notifications/dismiss-all
    router.post('/dismiss-all', (req, res) => {
        try {
            agent.db.dismissAllNotifications();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /internal/notifications/:id
    router.delete('/:id', (req, res) => {
        try {
            agent.db.deleteNotification(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createNotificationsRouter };
