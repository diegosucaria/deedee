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
            if (!id || id.trim().length === 0) {
                return res.status(400).json({ error: 'Missing vinyl ID' });
            }
            const fields = req.body;
            if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
                return res.status(400).json({ error: 'Request body must contain fields to update' });
            }
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

    // DELETE /vinyls/:id - Delete vinyl and its cover image
    router.delete('/vinyls/:id', async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || id.trim().length === 0) {
                return res.status(400).json({ error: 'Missing vinyl ID' });
            }
            const deleted = agent.db.deleteVinyl(id);
            if (deleted) {
                if (agent.interface && agent.interface.broadcast) {
                    agent.interface.broadcast('dj:vinyl:delete', { id });
                }
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'Vinyl not found' });
            }
        } catch (error) {
            console.error('[DJRouter] Delete error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /vinyls/:id/enrich - Re-enrich vinyl metadata
    router.post('/vinyls/:id/enrich', async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || id.trim().length === 0) {
                return res.status(400).json({ error: 'Missing vinyl ID' });
            }
            if (!agent.djService) {
                return res.status(503).json({ error: 'DJ Service not available' });
            }
            console.log(`[DJRouter] Re-enriching vinyl: ${id}`);
            const updated = await agent.djService.reEnrich(id);
            res.json({ success: true, vinyl: updated });
        } catch (error) {
            console.error('[DJRouter] Re-enrich error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /vinyls/:id/value - Refresh price guide + history only
    router.post('/vinyls/:id/value', async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || id.trim().length === 0) {
                return res.status(400).json({ error: 'Missing vinyl ID' });
            }
            if (!agent.djService) {
                return res.status(503).json({ error: 'DJ Service not available' });
            }
            const updated = await agent.djService.refreshValue(id);
            res.json({ success: true, vinyl: updated });
        } catch (error) {
            console.error('[DJRouter] Refresh value error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /vinyls/:id/retry-enrich - Retry failed enrichment (non-blocking)
    router.post('/vinyls/:id/retry-enrich', async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || id.trim().length === 0) {
                return res.status(400).json({ error: 'Missing vinyl ID' });
            }
            if (!agent.djService) {
                return res.status(503).json({ error: 'DJ Service not available' });
            }
            const result = await agent.djService.retryEnrich(id);
            res.json(result);
        } catch (error) {
            console.error('[DJRouter] Retry enrich error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // --- Crate Routes ---

    // GET /crates
    router.get('/crates', (req, res) => {
        try {
            res.json(agent.db.getCrates());
        } catch (error) {
            console.error('[DJRouter] Error fetching crates:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /crates
    router.post('/crates', (req, res) => {
        try {
            const { name, type, rules, icon, color } = req.body;
            if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
            if (name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
            const validTypes = ['manual', 'smart'];
            const crateType = validTypes.includes(type) ? type : 'manual';
            if (rules && typeof rules !== 'object') return res.status(400).json({ error: 'Rules must be an object' });
            const id = agent.db.addCrate({ name: name.trim(), type: crateType, rules, icon: icon ? String(icon).slice(0, 10) : null, color: color ? String(color).slice(0, 20) : null });
            res.json({ success: true, crate: agent.db.getCrate(id) });
        } catch (error) {
            console.error('[DJRouter] Create crate error:', error);
            res.status(500).json({ error: 'Failed to create crate' });
        }
    });

    // PUT /crates/:id
    router.put('/crates/:id', (req, res) => {
        try {
            const { name, type, rules, icon, color } = req.body;
            const fields = {};
            if (name !== undefined) {
                if (typeof name !== 'string' || name.length > 100) return res.status(400).json({ error: 'Invalid name' });
                fields.name = name.trim();
            }
            if (type !== undefined) {
                const validTypes = ['manual', 'smart'];
                if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type' });
                fields.type = type;
            }
            if (rules !== undefined) fields.rules = rules;
            if (icon !== undefined) fields.icon = icon ? String(icon).slice(0, 10) : null;
            if (color !== undefined) fields.color = color ? String(color).slice(0, 20) : null;
            agent.db.updateCrate(req.params.id, fields);
            res.json({ success: true, crate: agent.db.getCrate(req.params.id) });
        } catch (error) {
            console.error('[DJRouter] Update crate error:', error);
            res.status(500).json({ error: 'Failed to update crate' });
        }
    });

    // DELETE /crates/:id
    router.delete('/crates/:id', (req, res) => {
        try {
            agent.db.deleteCrate(req.params.id);
            res.json({ success: true });
        } catch (error) {
            console.error('[DJRouter] Delete crate error:', error);
            res.status(500).json({ error: 'Failed to delete crate' });
        }
    });

    // GET /crates/:id/vinyls
    router.get('/crates/:id/vinyls', (req, res) => {
        try {
            const vinyls = agent.db.getCrateVinyls(req.params.id);
            res.json(vinyls);
        } catch (error) {
            console.error('[DJRouter] Get crate vinyls error:', error);
            res.status(500).json({ error: 'Failed to get crate vinyls' });
        }
    });

    // POST /crates/:id/vinyls/:vinylId
    router.post('/crates/:id/vinyls/:vinylId', (req, res) => {
        try {
            agent.db.addVinylToCrate(req.params.id, req.params.vinylId);
            res.json({ success: true });
        } catch (error) {
            console.error('[DJRouter] Add to crate error:', error);
            res.status(500).json({ error: 'Failed to add vinyl to crate' });
        }
    });

    // DELETE /crates/:id/vinyls/:vinylId
    router.delete('/crates/:id/vinyls/:vinylId', (req, res) => {
        try {
            agent.db.removeVinylFromCrate(req.params.id, req.params.vinylId);
            res.json({ success: true });
        } catch (error) {
            console.error('[DJRouter] Remove from crate error:', error);
            res.status(500).json({ error: 'Failed to remove vinyl from crate' });
        }
    });

    // Serve Vinyl Covers (Internal)
    // Uses 'data' dir (volume)
    let baseDataDir = process.env.DATA_DIR;
    if (!baseDataDir) {
        if (require('fs').existsSync('/app') && process.platform !== 'darwin') {
            baseDataDir = '/app/data';
        } else {
            baseDataDir = require('path').join(process.cwd(), 'data');
        }
    }
    const dataDir = require('path').join(baseDataDir, 'vinyl_covers');
    if (!require('fs').existsSync(dataDir)) require('fs').mkdirSync(dataDir, { recursive: true });
    router.use('/covers', express.static(dataDir));

    return router;
};

module.exports = { createDjRouter };
