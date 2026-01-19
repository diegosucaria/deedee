const express = require('express');

const createDjRouter = (agent) => {
    const router = express.Router();

    // GET /vinyls
    router.get('/vinyls', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;

            const vinyls = agent.db.getVinyls({ limit, offset });
            res.json(vinyls);
        } catch (error) {
            console.error('[DJRouter] Error fetching vinyls:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Serve Vinyl Covers (Internal)
    // Uses 'data' dir (volume)
    const dataDir = require('path').join(process.cwd(), 'data/vinyl_covers');
    if (!require('fs').existsSync(dataDir)) require('fs').mkdirSync(dataDir, { recursive: true });
    router.use('/covers', express.static(dataDir));

    return router;
};

module.exports = { createDjRouter };
