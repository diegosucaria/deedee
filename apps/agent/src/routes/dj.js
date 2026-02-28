const express = require('express');

const createDjRouter = (agent) => {
    const router = express.Router();

    // Increase body size limit for image uploads (10MB)
    router.use(express.json({ limit: '10mb' }));

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

    // POST /vinyls/upload - Upload vinyl photo for analysis
    router.post('/vinyls/upload', async (req, res) => {
        try {
            const { image, mimeType } = req.body;
            if (!image) {
                return res.status(400).json({ error: 'Missing image data (base64)' });
            }

            if (!agent.djService) {
                return res.status(503).json({ error: 'DJ Service not available' });
            }

            console.log('[DJRouter] Processing vinyl upload...');
            const results = await agent.djService.ingestVinylFromBase64(image, mimeType || 'image/jpeg');
            res.json({ success: true, vinyls: results });
        } catch (error) {
            console.error('[DJRouter] Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // PUT /vinyls/:id - Update vinyl fields
    router.put('/vinyls/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const fields = req.body;
            const updated = agent.db.updateVinyl(id, fields);
            if (updated) {
                const vinyl = agent.db.getVinyl(id);
                if (agent.interface && agent.interface.broadcast) {
                    agent.interface.broadcast('dj:vinyl:update', vinyl);
                }
                res.json({ success: true, vinyl });
            } else {
                res.status(404).json({ error: 'Vinyl not found or no fields to update' });
            }
        } catch (error) {
            console.error('[DJRouter] Update error:', error);
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
