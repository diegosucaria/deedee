const express = require('express');
const fs = require('fs');
const path = require('path');

const createWardrobeRouter = (agent) => {
    const router = express.Router();

    router.use(express.json({ limit: '15mb' }));

    // GET /garments
    router.get('/garments', (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 200;
            const offset = parseInt(req.query.offset) || 0;
            const type = req.query.type || null;
            res.json(agent.db.getGarments({ limit, offset, type }));
        } catch (error) {
            console.error('[WardrobeRouter] List error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/analyze-outfit (hybrid match + auto-add)
    router.post('/garments/analyze-outfit', async (req, res) => {
        try {
            const { image, mimeType, caption, trip_id } = req.body;
            if (!image) return res.status(400).json({ error: 'Missing image data (base64)' });
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const result = await agent.wardrobeService.analyzeOutfitPhoto(image, {
                mimeType: mimeType || 'image/jpeg',
                caption,
                tripId: trip_id
            });
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[WardrobeRouter] Analyze outfit error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/upload
    router.post('/garments/upload', async (req, res) => {
        try {
            const { image, mimeType } = req.body;
            if (!image) return res.status(400).json({ error: 'Missing image data (base64)' });
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });

            const result = await agent.wardrobeService.ingestGarmentFromBase64(image, mimeType || 'image/jpeg');
            res.json({ success: true, garments: result.garments, matched_existing: result.matched_existing });
        } catch (error) {
            console.error('[WardrobeRouter] Upload error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /garments/:id
    router.get('/garments/:id', (req, res) => {
        try {
            const g = agent.db.getGarment(req.params.id);
            if (!g) return res.status(404).json({ error: 'Not found' });
            res.json(g);
        } catch (error) {
            console.error('[WardrobeRouter] Get error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // PUT /garments/:id
    router.put('/garments/:id', (req, res) => {
        try {
            const { id } = req.params;
            if (!id || !id.trim()) return res.status(400).json({ error: 'Missing id' });
            const fields = req.body;
            if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
                return res.status(400).json({ error: 'Request body must contain fields to update' });
            }
            const updated = agent.db.updateGarment(id, fields);
            if (!updated) return res.status(404).json({ error: 'Garment not found or no updatable fields' });
            const garment = agent.db.getGarment(id);
            if (agent.interface && agent.interface.broadcast) {
                agent.interface.broadcast('wardrobe:garment:update', garment);
            }
            res.json({ success: true, garment });
        } catch (error) {
            console.error('[WardrobeRouter] Update error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // DELETE /garments/:id
    router.delete('/garments/:id', (req, res) => {
        try {
            const { id } = req.params;
            const ok = agent.db.deleteGarment(id);
            if (!ok) return res.status(404).json({ error: 'Garment not found' });
            if (agent.interface && agent.interface.broadcast) {
                agent.interface.broadcast('wardrobe:garment:delete', { id });
            }
            res.json({ success: true });
        } catch (error) {
            console.error('[WardrobeRouter] Delete error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/:id/confirm-brand { accept: bool }
    router.post('/garments/:id/confirm-brand', async (req, res) => {
        try {
            const { accept } = req.body || {};
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const updated = await agent.wardrobeService.confirmBrand(req.params.id, !!accept);
            res.json({ success: true, garment: updated });
        } catch (error) {
            console.error('[WardrobeRouter] Confirm brand error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/:id/merge { duplicate_ids: [...] }
    // Folds the listed duplicate garment rows into the path :id (the primary).
    router.post('/garments/:id/merge', async (req, res) => {
        try {
            const { duplicate_ids } = req.body || {};
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const updated = await agent.wardrobeService.mergeGarments(req.params.id, duplicate_ids);
            res.json({ success: true, garment: updated });
        } catch (error) {
            console.error('[WardrobeRouter] Merge error:', error);
            const status = /not found|requires/i.test(error.message) ? 400 : 500;
            res.status(status).json({ error: error.message });
        }
    });

    // POST /garments/:id/reenrich { hint?: string, extra_image?: base64, mimeType?: string }
    router.post('/garments/:id/reenrich', async (req, res) => {
        try {
            const { hint, extra_image, mimeType } = req.body || {};
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const updated = await agent.wardrobeService.reenrichGarment(req.params.id, {
                hint: hint || '',
                extraImageBase64: extra_image || null,
                mimeType: mimeType || 'image/jpeg'
            });
            res.json({ success: true, garment: updated });
        } catch (error) {
            console.error('[WardrobeRouter] Re-enrich error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/:id/duplicate
    // Body: { image: base64, mimeType?: string }
    // Creates a new garment inheriting brand/model/type/subtype/material/
    // warmth/formality/size/season_tags from :id, re-detecting color+pattern
    // from the supplied photo in the background.
    router.post('/garments/:id/duplicate', async (req, res) => {
        try {
            const { image, mimeType } = req.body || {};
            if (!image) return res.status(400).json({ error: 'Missing image data (base64)' });
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const garment = await agent.wardrobeService.duplicateGarment(
                req.params.id,
                image,
                mimeType || 'image/jpeg'
            );
            res.json({ success: true, garment });
        } catch (error) {
            console.error('[WardrobeRouter] Duplicate error:', error);
            const status = /not found|Missing/i.test(error.message) ? 400 : 500;
            res.status(status).json({ error: error.message });
        }
    });

    // POST /garments/:id/generate-image
    // Body (all optional):
    //   extra_image: base64 — additional photo of the same garment to fill in
    //                          details the original crop missed
    //   mimeType: string    — mime type of extra_image (default image/jpeg)
    //
    // Returns 202 immediately. The image render itself takes 10-30s and runs
    // in the background — awaiting it from a Next.js Server Action would hold
    // the React transition open and freeze client navigation. The service
    // synchronously sets meta.generatingImage + broadcasts wardrobe:garment:update
    // before its first await, then broadcasts again on completion (or failure,
    // which clears the flag). Connected clients see start → end via WebSocket.
    //
    // All preconditions that would cause the service to throw before the flag
    // is set (no Gemini client, missing crop file) MUST be validated
    // synchronously here. If they're not, the route would return 202 success,
    // the service would throw asynchronously, and the client would see no
    // spinner, no error, and no socket event — a silent failure.
    router.post('/garments/:id/generate-image', (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            if (!agent.client) return res.status(503).json({ error: 'Image model client not initialized' });
            const existing = agent.db.getGarment(req.params.id);
            if (!existing) return res.status(404).json({ error: 'Garment not found' });
            const cropPath = existing.crop_image_path || existing.source_image_path;
            if (!cropPath || !fs.existsSync(cropPath)) {
                return res.status(400).json({ error: 'Garment has no source image to reference' });
            }

            const { extra_image, mimeType } = req.body || {};
            const extraReferences = extra_image
                ? [{ data: extra_image, mimeType: mimeType || 'image/jpeg' }]
                : [];

            // Fire-and-forget — service runs its synchronous prefix (flag set +
            // broadcast) before suspending on the model call.
            agent.wardrobeService.generateGarmentImage(req.params.id, { extraReferences })
                .catch(err => console.error('[WardrobeRouter] Generate image background error:', err));

            // Re-read so the response reflects meta.generatingImage = true.
            const queued = agent.db.getGarment(req.params.id);
            res.status(202).json({ success: true, garment: queued, pending: true });
        } catch (error) {
            console.error('[WardrobeRouter] Generate image error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /garments/:id/outfits
    // Body: { count?: number }
    // Generates N complete outfits built around this garment.
    router.post('/garments/:id/outfits', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { count } = req.body || {};
            const result = await agent.wardrobeService.generateOutfitsForGarment(req.params.id, {
                count: typeof count === 'number' ? count : 4
            });
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[WardrobeRouter] Outfits for garment error:', error);
            const status = /not found|at least one|any outfits/i.test(error.message) ? 400 : 500;
            res.status(status).json({ error: error.message });
        }
    });

    // GET /profile
    router.get('/profile', (req, res) => {
        try {
            res.json(agent.db.getUserProfile() || {});
        } catch (error) {
            console.error('[WardrobeRouter] Profile get error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // PUT /profile
    router.put('/profile', (req, res) => {
        try {
            const fields = req.body;
            if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
                return res.status(400).json({ error: 'Request body must contain fields to update' });
            }
            agent.db.updateUserProfile(fields);
            res.json({ success: true, profile: agent.db.getUserProfile() });
        } catch (error) {
            console.error('[WardrobeRouter] Profile update error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // --- Outfits ---
    router.get('/outfits', (req, res) => {
        try {
            const liked = req.query.liked === undefined ? null : req.query.liked === 'true';
            res.json(agent.db.getOutfits({ liked, limit: 200 }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/outfits/recommend', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_ids, trip_id, context, count } = req.body || {};
            const result = await agent.wardrobeService.recommendOutfit({
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                tripId: trip_id || null,
                context: context || '',
                count: count || 4
            });
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/outfits/:id/like', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { liked = true } = req.body || {};
            const out = await agent.wardrobeService.likeOutfit(req.params.id, liked);
            if (!out) return res.status(404).json({ error: 'Not found' });
            res.json({ success: true, outfit: out });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Variations include a slow image render (10-30s). Return 202 immediately
    // and run the work in the background — the service emits
    // wardrobe:outfit:variations-pending up-front, then either
    // wardrobe:outfit:variations-rendered (on success) or
    // wardrobe:outfit:variations-failed (on error) so the client can update
    // its UI via WebSocket without holding a Server Action transition open.
    //
    // Pre-validate the cheap cases synchronously so the client gets a 4xx
    // immediately for malformed requests. The expensive
    // "<2 valid garments still in wardrobe" check stays in the service (it
    // requires loading the full garment pool) and the service's outer catch
    // emits variations-failed if it fires.
    router.post('/outfits/:id/variations', (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const existing = agent.db.getOutfit(req.params.id);
            if (!existing) return res.status(404).json({ error: 'Outfit not found' });
            const sourceIds = Array.isArray(existing.garment_ids) ? existing.garment_ids : [];
            if (sourceIds.length < 2) {
                return res.status(400).json({ error: 'Source outfit needs at least 2 items to build variations' });
            }

            const { count } = req.body || {};
            agent.wardrobeService.generateOutfitVariations(req.params.id, {
                count: typeof count === 'number' ? count : 3
            }).catch(err => console.error('[WardrobeRouter] Variations background error:', err));

            res.status(202).json({ success: true, outfit: existing, pending: true });
        } catch (e) {
            const status = /not found|too few|any variations/i.test(e.message) ? 400 : 500;
            res.status(status).json({ error: e.message });
        }
    });

    router.delete('/outfits/:id', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const ok = await agent.wardrobeService.deleteOutfit(req.params.id);
            if (!ok) return res.status(404).json({ error: 'Not found' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/outfits/:id', (req, res) => {
        try {
            const outfit = agent.db.getOutfit(req.params.id);
            if (!outfit) return res.status(404).json({ error: 'Not found' });
            res.json(outfit);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put('/outfits/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const fields = req.body || {};
            if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
                return res.status(400).json({ error: 'Request body must contain fields to update' });
            }
            const changed = agent.db.updateOutfit(id, fields);
            if (!changed) return res.status(404).json({ error: 'Not found or no updatable fields' });
            const outfit = agent.db.getOutfit(id);
            if (agent.interface && agent.interface.broadcast) {
                agent.interface.broadcast('wardrobe:outfit:update', outfit);
            }
            res.json({ success: true, outfit });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/outfits/visualize', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_ids_panels, layout, outfit_id } = req.body || {};
            const result = await agent.wardrobeService.visualizeOutfit({
                garmentIdsPanels: garment_ids_panels,
                layout: layout || 'auto',
                outfitId: outfit_id || null
            });
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/outfits/critique', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { image, mimeType, garment_ids, trip_id, question } = req.body || {};
            const result = await agent.wardrobeService.critiqueOutfit({
                imageBase64: image || null,
                mimeType: mimeType || 'image/jpeg',
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                tripId: trip_id || null,
                question: question || ''
            });
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Trips ---
    router.get('/trips', (req, res) => {
        try {
            const status = req.query.status || null;
            res.json(agent.db.getTrips({ status }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/trips/:id', (req, res) => {
        try {
            const t = agent.db.getTrip(req.params.id);
            if (!t) return res.status(404).json({ error: 'Not found' });
            res.json(t);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/pack', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { destination, start_date, end_date, activities, calendar_event_id } = req.body || {};
            const trip = await agent.wardrobeService.packForTrip({
                destination,
                startDate: start_date,
                endDate: end_date,
                activities: Array.isArray(activities) ? activities : [],
                calendarEventId: calendar_event_id || null
            });
            res.json({ success: true, trip });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/:id/start', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const t = await agent.wardrobeService.startTrip(req.params.id);
            res.json({ success: true, trip: t });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/:id/complete', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const t = await agent.wardrobeService.completeTrip(req.params.id);
            res.json({ success: true, trip: t });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/:id/render-daily', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const force = !!(req.body && req.body.force);
            const result = await agent.wardrobeService.renderTripDailyOutfits(req.params.id, { force });
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put('/trips/:id/capsule', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_ids } = req.body || {};
            const t = await agent.wardrobeService.setTripCapsule(req.params.id, Array.isArray(garment_ids) ? garment_ids : []);
            res.json({ success: true, trip: t });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/:id/capsule/add', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_ids, image, mimeType } = req.body || {};
            const t = await agent.wardrobeService.addToTripCapsule(req.params.id, {
                garmentIds: Array.isArray(garment_ids) ? garment_ids : null,
                imageBase64: image || null,
                mimeType: mimeType || 'image/jpeg'
            });
            res.json({ success: true, trip: t });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/trips/:id/capsule/remove', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_ids } = req.body || {};
            const t = await agent.wardrobeService.removeFromTripCapsule(req.params.id, Array.isArray(garment_ids) ? garment_ids : []);
            res.json({ success: true, trip: t });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Shopping list ---
    router.get('/shopping', (req, res) => {
        try {
            const status = req.query.status || null;
            res.json(agent.db.listShoppingItems({ status }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/shopping', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const item = await agent.wardrobeService.addToShoppingList(req.body || {});
            res.json({ success: true, item });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/shopping/:id/purchased', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const { garment_id } = req.body || {};
            const item = await agent.wardrobeService.markPurchased(req.params.id, garment_id || null);
            res.json({ success: true, item });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/shopping/:id/dismiss', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const item = await agent.wardrobeService.dismissShoppingItem(req.params.id);
            res.json({ success: true, item });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/shopping/:id/reference-image', async (req, res) => {
        try {
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const item = await agent.wardrobeService.generateShoppingReferenceImage(req.params.id);
            res.json({ success: true, item });
        } catch (e) {
            const status = /not found/i.test(e.message) ? 404 : 500;
            res.status(status).json({ error: e.message });
        }
    });

    // POST /profile/reference-selfie
    router.post('/profile/reference-selfie', async (req, res) => {
        try {
            const { image, mimeType } = req.body;
            if (!image) return res.status(400).json({ error: 'Missing image' });
            if (!agent.wardrobeService) return res.status(503).json({ error: 'Wardrobe service not available' });
            const profile = await agent.wardrobeService.setReferenceSelfie(image, mimeType || 'image/jpeg');
            res.json({ success: true, profile });
        } catch (error) {
            console.error('[WardrobeRouter] Reference selfie error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Serve wardrobe image files by relative path inside the wardrobe data dir
    // e.g. GET /internal/wardrobe/images/garments/<id>/original.jpg
    router.get('/images/*', (req, res) => {
        try {
            const relative = req.params[0];
            if (!relative || relative.includes('..')) return res.status(400).send('Invalid path');
            const baseDataDir = process.env.DATA_DIR
                || ((fs.existsSync('/app') && process.platform !== 'darwin') ? '/app/data' : path.join(process.cwd(), 'data'));
            const absolute = path.join(baseDataDir, 'wardrobe', relative);
            if (!absolute.startsWith(path.join(baseDataDir, 'wardrobe'))) return res.status(400).send('Invalid path');
            if (!fs.existsSync(absolute)) return res.status(404).send('Not found');
            const ext = path.extname(absolute).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            fs.createReadStream(absolute).pipe(res);
        } catch (error) {
            console.error('[WardrobeRouter] Image serve error:', error);
            res.status(500).send('Internal error');
        }
    });

    return router;
};

module.exports = { createWardrobeRouter };
