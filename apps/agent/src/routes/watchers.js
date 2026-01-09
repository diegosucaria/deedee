const express = require('express');

function createWatchersRouter(agent) {
    const router = express.Router();

    // GET / - List all watchers
    router.get('/', (req, res) => {
        try {
            const status = req.query.status || 'active';
            const watchers = agent.db.getWatchers(status);

            // Enrich with person details if possible?
            // Not strictly necessary for MVP, front-end can fetch people list or we do a join in SQL.
            // For now, raw list.
            res.json({ watchers });
        } catch (error) {
            console.error('[API] Failed to list watchers:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST / - Create a watcher
    router.post('/', (req, res) => {
        try {
            const { name, contactString, personId, condition, instruction } = req.body;
            if (!contactString || !condition || !instruction) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const result = agent.db.createWatcher({
                name, contactString, personId, condition, instruction, status: 'active'
            });
            res.json({ success: true, id: result.lastInsertRowid });
        } catch (error) {
            console.error('[API] Failed to create watcher:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // DELETE /:id - Delete watcher
    router.delete('/:id', (req, res) => {
        try {
            agent.db.deleteWatcher(req.params.id);
            res.json({ success: true });
        } catch (error) {
            console.error('[API] Failed to delete watcher:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createWatchersRouter };
