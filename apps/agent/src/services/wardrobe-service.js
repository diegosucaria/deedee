const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ConfigService } = require('./config-service');

class WardrobeService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
        this.config = new ConfigService();
    }

    async initialize() {
        const dir = this._baseDir();
        for (const sub of ['garments', 'outfits', 'profile']) {
            const p = path.join(dir, sub);
            if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        }
    }

    _baseDataDir() {
        if (process.env.DATA_DIR) return process.env.DATA_DIR;
        if (fs.existsSync('/app') && process.platform !== 'darwin') return '/app/data';
        return path.join(process.cwd(), 'data');
    }

    _baseDir() {
        return path.join(this._baseDataDir(), 'wardrobe');
    }

    /**
     * Detect garments in a photo via Gemini Flash. Returns an array of detections
     * (see spec Appendix A.1). On failure or empty response, returns a single
     * passthrough detection covering the full frame so ingestion still succeeds.
     */
    async _detectItems(base64Data, mimeType = 'image/jpeg') {
        const fallback = () => ([{
            bbox: [0, 0, 1, 1],
            type: null,
            subtype: null,
            primary_color: null,
            secondary_colors: [],
            pattern: null,
            material_guess: null,
            warmth: null,
            formality: null,
            season_tags: [],
            distinguishing_features: null,
            detection_confidence: 0
        }]);

        if (!this.agent.client) {
            console.warn('[WardrobeService] Gemini client not initialized — using fallback detection');
            return fallback();
        }

        const modelName = this.config.getModel('FLASH');
        const prompt = `Identify every distinguishable garment or accessory in this photo.
Return strict JSON with this shape:
{
  "items": [
    {
      "box_2d": [ymin, xmin, ymax, xmax],
      "type": "top|bottom|shoes|outerwear|accessory|underwear|other",
      "subtype": "tshirt|polo|hoodie|chinos|jeans|sneakers|...",
      "primary_color": "...",
      "secondary_colors": ["..."],
      "pattern": "solid|striped|plaid|graphic|...",
      "material_guess": "...",
      "warmth": 1-5,
      "formality": 1-5,
      "season_tags": ["spring","summer","fall","winter"],
      "distinguishing_features": "logos, stitching, named model, distinctive cut",
      "detection_confidence": 0..1
    }
  ],
  "scene_notes": "overall framing notes"
}

RULES:
- box_2d is [ymin, xmin, ymax, xmax] normalized to 0-1000 — this is Gemini's canonical bbox format; do not use any other ordering or range
- The box must tightly enclose the garment itself (no background padding beyond the edges of the fabric)
- Only include items clearly visible and identifiable; skip partial glimpses of background or furniture
- Omit fields you are uncertain about (do not fabricate)
- Never invent brands or models
Respond with JSON only.`;

        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { data: base64Data, mimeType } },
                        { text: prompt }
                    ]
                }],
                config: { responseMimeType: 'application/json' }
            });

            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_detect'); } catch (e) { /* ignore */ }

            const text = this._extractText(result);
            if (!text) {
                console.warn('[WardrobeService] Empty detection response — fallback');
                return fallback();
            }
            const data = this._safeParseJson(text);
            const items = Array.isArray(data?.items) ? data.items : [];
            if (items.length === 0) return fallback();
            return items.map(it => this._normalizeDetection(it)).filter(Boolean);
        } catch (e) {
            console.error('[WardrobeService] Detection failed:', e.message);
            return fallback();
        }
    }

    _normalizeDetection(item) {
        if (!item) return null;
        // Gemini returns box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000.
        // Accept legacy `bbox` field (same layout, sometimes 0-1) for backward compat.
        const raw = item.box_2d ?? item.bbox;
        const bbox = this._normalizeBbox(raw);
        return {
            bbox,
            type: item.type || null,
            subtype: item.subtype || null,
            primary_color: item.primary_color || null,
            secondary_colors: Array.isArray(item.secondary_colors) ? item.secondary_colors : [],
            pattern: item.pattern || null,
            material_guess: item.material_guess || null,
            warmth: this._clampInt(item.warmth, 1, 5),
            formality: this._clampInt(item.formality, 1, 5),
            season_tags: Array.isArray(item.season_tags) ? item.season_tags : [],
            distinguishing_features: item.distinguishing_features || null,
            detection_confidence: typeof item.detection_confidence === 'number' ? item.detection_confidence : 0
        };
    }

    /**
     * Accept Gemini's native bbox format [ymin, xmin, ymax, xmax] in 0-1000
     * and return [x1, y1, x2, y2] in 0-1 (what the rest of the code expects).
     *
     * Gemini trains on [ymin, xmin, ymax, xmax]; prompt overrides are unreliable,
     * so we parse the native ordering and flip it here. Values in the 0-1 range
     * are still accepted (some responses come back already normalized).
     */
    _normalizeBbox(bbox) {
        if (!Array.isArray(bbox) || bbox.length !== 4) return [0, 0, 1, 1];
        let nums = bbox.map(n => Number(n));
        if (nums.some(n => Number.isNaN(n))) return [0, 0, 1, 1];
        // Detect 0..1000 range (Gemini's canonical default) and normalize to 0..1.
        if (nums.some(n => n > 10)) nums = nums.map(n => n / 1000);
        let [ymin, xmin, ymax, xmax] = nums;
        if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
        if (ymax < ymin) [ymin, ymax] = [ymax, ymin];
        const clamp = n => Math.max(0, Math.min(1, n));
        return [clamp(xmin), clamp(ymin), clamp(xmax), clamp(ymax)];
    }

    _clampInt(v, min, max) {
        if (v === null || v === undefined || v === '') return null;
        const n = Math.round(Number(v));
        if (Number.isNaN(n)) return null;
        return Math.max(min, Math.min(max, n));
    }

    _extractText(result) {
        try {
            if (typeof result?.text === 'function') return result.text();
            if (result?.text) return result.text;
            const parts = result?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) return parts.map(p => p?.text).filter(Boolean).join('');
        } catch (e) { /* ignore */ }
        return '';
    }

    _safeParseJson(text) {
        try {
            const cleaned = String(text).replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleaned);
        } catch (e) {
            return null;
        }
    }

    /**
     * Crop sourcePath to outPath using a normalized [x1, y1, x2, y2] bbox.
     * Idempotent: given the same source and bbox, produces the same crop.
     *
     * Uses `jimp` (pure JS) rather than `sharp` — no native deps, no ARM/libvips
     * issues, no semver hoisting foot-guns in workspaces.
     */
    async _cropToFile(sourcePath, bbox, outPath) {
        const Jimp = require('jimp');
        const [x1, y1, x2, y2] = bbox;
        const image = await Jimp.read(sourcePath);
        const W = image.bitmap.width;
        const H = image.bitmap.height;
        if (!W || !H) throw new Error('Unable to read image dimensions');

        // Guard against zero-size crops; pad by 1% each side if needed
        const pad = 0.01;
        const px1 = Math.max(0, Math.floor((x1 - pad) * W));
        const py1 = Math.max(0, Math.floor((y1 - pad) * H));
        const px2 = Math.min(W, Math.ceil((x2 + pad) * W));
        const py2 = Math.min(H, Math.ceil((y2 + pad) * H));
        const width = Math.max(1, px2 - px1);
        const height = Math.max(1, py2 - py1);

        await image.crop(px1, py1, width, height).quality(90).writeAsync(outPath);
        return outPath;
    }

    /**
     * Re-extract attributes from a single garment's crop (cleaner signal than
     * the multi-item detection pass). Updates the row and broadcasts
     * wardrobe:garment:attributes when done.
     *
     * @param {string} garmentId
     * @param {Object} [options]
     * @param {string} [options.hint] - user-supplied known brand/model (e.g.
     *   "ABC Warpstreme Jogger Regular by Lululemon"). When present it biases
     *   the model toward that identity instead of guessing from scratch.
     * @param {Array<{ data: string, mimeType?: string }>} [options.extraReferences]
     *   Additional photos of the same garment (e.g. clearer angle the user
     *   uploaded for re-enrich). Sent alongside the existing crop so the model
     *   can resolve details the original photo missed.
     */
    async _runAttributePass(garmentId, { hint = null, extraReferences = [] } = {}) {
        const garment = this.db.getGarment(garmentId);
        if (!garment) return;
        if (!this.agent.client) {
            // No client available — mark complete with what we have
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            return;
        }

        const cropPath = garment.crop_image_path || garment.source_image_path;
        if (!cropPath || !fs.existsSync(cropPath)) {
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            return;
        }

        const extras = Array.isArray(extraReferences)
            ? extraReferences.filter(r => r && typeof r.data === 'string' && r.data.length > 0)
            : [];

        const modelName = this.config.getModel('FLASH');
        const prompt = `Analyze this single garment or accessory and return strict JSON:
{
  "type": "top|bottom|shoes|outerwear|accessory|underwear|other",
  "subtype": "...",
  "primary_color": "...",
  "secondary_colors": ["..."],
  "pattern": "solid|striped|plaid|graphic|...",
  "material_guess": "...",
  "warmth": 1-5,
  "formality": 1-5,
  "season_tags": ["spring","summer","fall","winter"],
  "distinguishing_features": "logos, stitching, named model, distinctive cut",${hint ? `
  "brand": "brand name parsed from the user hint, or null",
  "model": "specific model name parsed from the user hint, or null",` : ''}
  "confidence": 0..1
}

${extras.length ? `IMAGES PROVIDED: ${extras.length + 1} photos of the same garment — the first is the original wardrobe crop, the remainder are additional references the user supplied for clarity. Combine evidence from all of them; trust the clearer view when they disagree on a detail.
` : ''}${hint ? `USER-SUPPLIED IDENTITY: "${hint}".
Trust this hint as ground truth. Parse brand and model out of it (e.g. "ABC Warpstreme Jogger Regular · Lululemon" → brand: "Lululemon", model: "ABC Warpstreme Jogger Regular") and shape subtype/material/season_tags around that identity (e.g. "ABC Warpstreme Jogger" → subtype: "joggers", material: a synthetic blend). Only override the hint if the image is clearly inconsistent with it.
` : ''}Rules: omit fields you cannot confidently determine. Do not invent brands${hint ? ' beyond what the hint states' : ''}. Respond with JSON only.`;

        try {
            const base64 = fs.readFileSync(cropPath).toString('base64');
            const mimeType = cropPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
            const parts = [{ inlineData: { data: base64, mimeType } }];
            for (const ref of extras) {
                parts.push({
                    inlineData: {
                        data: ref.data,
                        mimeType: ref.mimeType || 'image/jpeg'
                    }
                });
            }
            parts.push({ text: prompt });
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts }],
                config: { responseMimeType: 'application/json' }
            });
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_attrs'); } catch (e) { /* ignore */ }

            const text = this._extractText(result);
            const data = this._safeParseJson(text) || {};

            const patch = {
                enrichment_status: 'complete',
                enrichment_confidence: typeof data.confidence === 'number' ? data.confidence : garment.enrichment_confidence
            };
            const overlay = (k, v) => { if (v !== null && v !== undefined && v !== '') patch[k] = v; };
            overlay('type', data.type);
            overlay('subtype', data.subtype);
            overlay('primary_color', data.primary_color);
            if (Array.isArray(data.secondary_colors)) patch.secondary_colors = data.secondary_colors;
            overlay('pattern', data.pattern);
            overlay('material_guess', data.material_guess);
            const w = this._clampInt(data.warmth, 1, 5);
            if (w !== null) patch.warmth = w;
            const f = this._clampInt(data.formality, 1, 5);
            if (f !== null) patch.formality = f;
            if (Array.isArray(data.season_tags)) patch.season_tags = data.season_tags;
            // When the user supplied a hint, the attribute pass is allowed to populate
            // brand/model from it. Only fill missing fields — never clobber a value
            // the user already typed in.
            if (hint) {
                if (data.brand && !garment.brand) patch.brand = data.brand;
                if (data.model && !garment.model) patch.model = data.model;
            }
            patch.meta = {
                ...(garment.meta || {}),
                distinguishingFeatures: data.distinguishing_features || garment.meta?.distinguishingFeatures || null,
                attributePassRaw: data
            };

            // Keep status='enriching' while brand pass runs; _enrichBrand finalizes.
            patch.enrichment_status = 'enriching';

            // Shopping-list crossref: if attributes match an open wanted item, annotate in meta.
            try {
                const speculative = { ...garment, ...patch };
                const hit = this._matchNewGarmentToShoppingList(speculative);
                if (hit) {
                    patch.meta = { ...(patch.meta || {}), shoppingMatch: hit };
                }
            } catch (e) { /* non-fatal */ }

            this.db.updateGarment(garmentId, patch);
            this._broadcast('wardrobe:garment:attributes', this.db.getGarment(garmentId));

            try {
                await this._enrichBrand(garmentId);
            } catch (brandErr) {
                console.warn(`[WardrobeService] Brand enrichment failed for ${garmentId}:`, brandErr.message);
                // If brand pass failed, still complete the garment with attributes we have
                this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
                this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            }
        } catch (e) {
            console.error(`[WardrobeService] Attribute pass failed for ${garmentId}:`, e.message);
            this.db.updateGarment(garmentId, { enrichment_status: 'failed' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
        }
    }

    /**
     * Grounded-search brand identification with strict confidence gate.
     * - Auto-accepts only when confidence >= 0.95 AND a visual identifier is cited
     * - Otherwise surfaces a candidate via enrichment_status='needs_brand_confirm'
     * - If no distinguishing features or no client, just completes
     * - If the user has already supplied a brand or hint, skip the search entirely
     *   (user input is authoritative)
     */
    async _enrichBrand(garmentId) {
        const garment = this.db.getGarment(garmentId);
        if (!garment) return;

        // Respect user input: if they set brand, confirmed one, or supplied a hint,
        // there's nothing for the search to add.
        if (garment.brand || garment.meta?.userHint || garment.meta?.brandUserConfirmed) {
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }

        const distinguishing = garment.meta?.distinguishingFeatures;
        const cropPath = garment.crop_image_path || garment.source_image_path;

        // Nothing to search on, or no client — just complete what we have.
        if (!distinguishing || !this.agent.client || !cropPath || !fs.existsSync(cropPath)) {
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }

        const profile = this.db.getUserProfile();
        const preferred = Array.isArray(profile?.preferred_brands) ? profile.preferred_brands : [];
        const modelName = this.config.getModel('FLASH');
        const prompt = `You are identifying the brand and optional model of a garment using web search.

Garment observations:
- type: ${garment.type || 'unknown'}${garment.subtype ? ` (${garment.subtype})` : ''}
- color: ${garment.primary_color || 'unknown'}
- pattern: ${garment.pattern || 'unknown'}
- distinguishing features: ${distinguishing}
${preferred.length ? `- user's preferred brands: ${preferred.join(', ')} (prioritize these IF and only IF a verbatim visual identifier matches)` : ''}

Search the web and return strict JSON:
{
  "brand": string | null,
  "model": string | null,
  "visual_identifier_cited": string | null,
  "confidence": 0..1
}

Hard rules:
- Only return a non-null brand when a specific visual identifier (logo text, signature mark, named model, stitching pattern) from the garment matches something named in the search result. Put that verbatim match in "visual_identifier_cited".
- If you cannot cite a visual identifier, return brand: null and confidence: 0.
- Never invent brands.
- Respond with JSON only (no prose, no markdown).`;

        const mimeType = cropPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const base64 = fs.readFileSync(cropPath).toString('base64');
        let data = {};
        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { data: base64, mimeType } },
                        { text: prompt }
                    ]
                }],
                config: { tools: [{ googleSearch: {} }] }
            });
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_brand'); } catch (e) { /* ignore */ }
            const text = this._extractText(result);
            data = this._safeParseJson(text) || {};
        } catch (e) {
            console.warn(`[WardrobeService] Brand search failed for ${garmentId}:`, e.message);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }

        const brand = (typeof data.brand === 'string' && data.brand.trim()) ? data.brand.trim() : null;
        const model = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : null;
        const confidence = Number(data.confidence) || 0;
        const visualCite = (typeof data.visual_identifier_cited === 'string' && data.visual_identifier_cited.trim())
            ? data.visual_identifier_cited.trim() : null;

        const THRESHOLD = 0.95;

        if (brand && confidence >= THRESHOLD && visualCite) {
            this.db.updateGarment(garmentId, {
                brand,
                model,
                enrichment_status: 'complete',
                enrichment_confidence: confidence,
                meta: {
                    ...(garment.meta || {}),
                    brandVisualIdentifier: visualCite,
                    brandAutoAccepted: true,
                    brandCandidate: null
                }
            });
        } else if (brand) {
            this.db.updateGarment(garmentId, {
                enrichment_status: 'needs_brand_confirm',
                meta: {
                    ...(garment.meta || {}),
                    brandCandidate: {
                        brand,
                        model,
                        confidence,
                        visualIdentifier: visualCite
                    }
                }
            });
        } else {
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
        }
        this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
    }

    /**
     * Resolve a pending brand candidate — either accept (apply the candidate brand/model)
     * or reject (discard and mark complete).
     */
    async confirmBrand(garmentId, accept) {
        const garment = this.db.getGarment(garmentId);
        if (!garment) throw new Error(`Garment ${garmentId} not found`);
        const candidate = garment.meta?.brandCandidate;
        if (!candidate) {
            // Nothing to confirm; just complete
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            return this.db.getGarment(garmentId);
        }
        const patch = {
            enrichment_status: 'complete',
            meta: { ...(garment.meta || {}), brandCandidate: null, brandUserConfirmed: !!accept }
        };
        if (accept) {
            patch.brand = candidate.brand || null;
            patch.model = candidate.model || null;
            if (candidate.visualIdentifier) patch.meta.brandVisualIdentifier = candidate.visualIdentifier;
        }
        this.db.updateGarment(garmentId, patch);
        this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
        return this.db.getGarment(garmentId);
    }

    /**
     * Re-run the attribute pass on an existing garment, optionally biased by a
     * user-supplied hint (e.g. "ABC Warpstreme Jogger Regular") and/or an extra
     * reference photo. The hint is combined with whatever brand/model the user
     * has already set so the model reshapes the subtype/material/season tags
     * around that identity instead of guessing from scratch. The extra photo
     * is sent to the model alongside the original crop so it can resolve
     * details the original missed.
     *
     * Returns the garment row immediately; the refinement runs in the background
     * and broadcasts wardrobe:garment:attributes / :enriched when complete.
     */
    async reenrichGarment(garmentId, { hint = '', extraImageBase64 = null, mimeType = 'image/jpeg' } = {}) {
        const garment = this.db.getGarment(garmentId);
        if (!garment) throw new Error(`Garment ${garmentId} not found`);

        const trimmed = (hint || '').trim();
        const effectiveParts = [trimmed, garment.brand, garment.model]
            .map(s => (s || '').trim())
            .filter(Boolean);
        // De-dupe so "ABC Warpstreme Jogger · ABC Warpstreme Jogger" doesn't happen
        const seen = new Set();
        const unique = [];
        for (const p of effectiveParts) {
            const k = p.toLowerCase();
            if (!seen.has(k)) { seen.add(k); unique.push(p); }
        }
        const effectiveHint = unique.length ? unique.join(' · ') : null;

        const metaPatch = { ...(garment.meta || {}) };
        if (trimmed) metaPatch.userHint = trimmed;
        // Clear any stale brand candidate — user-driven re-enrich supersedes it
        metaPatch.brandCandidate = null;

        this.db.updateGarment(garmentId, {
            enrichment_status: 'enriching',
            meta: metaPatch
        });
        this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));

        const extraReferences = extraImageBase64
            ? [{ data: extraImageBase64, mimeType: mimeType || 'image/jpeg' }]
            : [];

        // Background refinement — caller gets the "enriching" state immediately
        this._runAttributePass(garmentId, { hint: effectiveHint, extraReferences }).catch(err => {
            console.error(`[WardrobeService] reenrichGarment failed for ${garmentId}:`, err.message);
        });

        return this.db.getGarment(garmentId);
    }

    /**
     * Generate a clean product-catalog image of the garment using the Gemini
     * image model. The garment's existing crop is always the primary
     * reference; callers can pass `extraReferences` (e.g. a fresh photo the
     * user just took to fill in details the original crop missed).
     *
     * @param {string} garmentId
     * @param {Object} [opts]
     * @param {Array<{ data: string, mimeType?: string }>} [opts.extraReferences]
     *   Additional photos of the same garment encoded as base64.
     */
    async generateGarmentImage(garmentId, { extraReferences = [] } = {}) {
        const garment = this.db.getGarment(garmentId);
        if (!garment) throw new Error(`Garment ${garmentId} not found`);
        if (!this.agent.client) throw new Error('Gemini client not initialized');

        const cropPath = garment.crop_image_path || garment.source_image_path;
        if (!cropPath || !fs.existsSync(cropPath)) {
            throw new Error('Garment has no source image to reference');
        }

        const descriptorBits = [
            garment.type,
            garment.subtype,
            garment.primary_color,
            garment.pattern,
            garment.material_guess,
            garment.brand && `by ${garment.brand}`,
            garment.model && `(${garment.model})`
        ].filter(Boolean);
        const descriptor = descriptorBits.length ? descriptorBits.join(' ') : 'garment';

        const extras = Array.isArray(extraReferences)
            ? extraReferences.filter(r => r && typeof r.data === 'string' && r.data.length > 0)
            : [];

        const referenceClause = extras.length === 0
            ? 'Use the single reference image to render the item.'
            : `Use ALL ${extras.length + 1} reference images — they show the same physical garment from different angles or with different details. Preserve every visible feature across all of them (logos, stitching, hardware, prints) in the final render. Do not invent or omit details based on a single image when other references contradict.`;

        const prompt = `Generate a clean product-catalog photo of the exact ${descriptor}.
${referenceClause}
- Plain neutral off-white background
- Single garment centered, well-lit with soft diffuse lighting
- No human model, no mannequin, no hanger, no clutter
- Preserve color, pattern, fit, fabric texture, and any visible logos or stitching faithfully
- Full item visible in frame with small margin around the edges
- Studio e-commerce aesthetic
- No text overlays, no watermarks`;

        const cropMime = cropPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const cropBase64 = fs.readFileSync(cropPath).toString('base64');

        const parts = [{ inlineData: { data: cropBase64, mimeType: cropMime } }];
        for (const ref of extras) {
            parts.push({
                inlineData: {
                    data: ref.data,
                    mimeType: ref.mimeType || 'image/jpeg'
                }
            });
        }
        parts.push({ text: prompt });

        const modelName = this.config.getModel('IMAGE');
        const response = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts }],
            config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_generate_garment'); } catch (e) { /* ignore */ }

        const respParts = response?.candidates?.[0]?.content?.parts || [];
        const imagePart = respParts.find(p => p?.inlineData?.mimeType?.startsWith?.('image/'));
        if (!imagePart) throw new Error('No image returned from image model');

        const outDir = path.dirname(cropPath);
        const outPath = path.join(outDir, `generated_${garmentId}.jpg`);
        fs.writeFileSync(outPath, Buffer.from(imagePart.inlineData.data, 'base64'));

        this.db.updateGarment(garmentId, { generated_image_path: outPath });
        const updated = this.db.getGarment(garmentId);
        this._broadcast('wardrobe:garment:update', updated);
        return updated;
    }

    /**
     * Ingest garments from a base64 image. Detection runs synchronously and
     * returns placeholder rows; per-garment attribute refinement runs in the
     * background and broadcasts `wardrobe:garment:attributes` when complete.
     */
    async ingestGarmentFromBase64(base64Data, mimeType = 'image/jpeg') {
        if (!base64Data) throw new Error('Missing image data');

        const detections = await this._detectItems(base64Data, mimeType);
        if (!detections || detections.length === 0) return [];

        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const sourceId = crypto.randomUUID();
        const sourceDir = path.join(this._baseDir(), 'garments', sourceId);
        if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, `original.${ext}`);
        fs.writeFileSync(sourcePath, Buffer.from(base64Data, 'base64'));

        const created = [];
        for (let i = 0; i < detections.length; i++) {
            const det = detections[i];
            // Determine crop path: full-frame bboxes (≈ [0,0,1,1]) reuse the source;
            // otherwise crop to a per-garment file.
            const fullFrame = det.bbox[0] < 0.02 && det.bbox[1] < 0.02 && det.bbox[2] > 0.98 && det.bbox[3] > 0.98;
            let cropPath = sourcePath;
            if (!fullFrame) {
                const cropFile = path.join(sourceDir, `crop_${i}.jpg`);
                try {
                    await this._cropToFile(sourcePath, det.bbox, cropFile);
                    cropPath = cropFile;
                } catch (e) {
                    console.warn(`[WardrobeService] Crop failed for detection ${i}:`, e.message);
                }
            }

            const garment = {
                type: det.type,
                subtype: det.subtype,
                primary_color: det.primary_color,
                secondary_colors: det.secondary_colors || [],
                pattern: det.pattern,
                material_guess: det.material_guess,
                warmth: det.warmth,
                formality: det.formality,
                season_tags: det.season_tags || [],
                source_image_path: sourcePath,
                crop_image_path: cropPath,
                bbox: det.bbox,
                source: 'manual_upload',
                enrichment_status: 'enriching',
                enrichment_confidence: det.detection_confidence || 0,
                meta: {
                    distinguishingFeatures: det.distinguishing_features || null,
                    detectionRaw: det
                }
            };

            const id = this.db.addGarment(garment);
            const row = this.db.getGarment(id);
            this._broadcast('wardrobe:garment:detected', row);
            created.push(row);

            // Fire-and-forget attribute pass
            this._runAttributePass(id).catch(err => {
                console.error(`[WardrobeService] Background attribute pass failed for ${id}:`, err.message);
            });
        }
        return created;
    }

    /**
     * Hybrid primitive: given a photo of clothes, simultaneously match items to
     * the existing wardrobe AND auto-add any unmatched garments. Returns the
     * full set of garment ids for downstream reasoning.
     *
     * Scoping: if tripId is provided and the trip is active, prefers matching
     * against the trip's actual_capsule (then expands to the full wardrobe if
     * nothing matches).
     */
    async analyzeOutfitPhoto(base64Data, { caption, tripId, mimeType = 'image/jpeg' } = {}) {
        if (!base64Data) throw new Error('Missing image data');

        const detections = await this._detectItems(base64Data, mimeType);
        if (!detections || detections.length === 0) {
            return { matched: [], newly_added: [], notes: 'No items detected' };
        }

        // Build candidate shortlist. When on an active trip, prioritize capsule
        // items but ALWAYS include recent wardrobe items too — a photo during a
        // trip might contain pieces the user didn't formally pack, and those
        // should still match existing wardrobe records (not be duplicated).
        let activeTrip = null;
        if (tripId) {
            try { activeTrip = this.db.getTrip?.(tripId); } catch (e) { /* db method may not exist in older test mocks */ }
        }
        const CAPS_SHORTLIST = 25;
        const shortlist = [];
        const seen = new Set();
        if (activeTrip && activeTrip.status === 'active' && Array.isArray(activeTrip.actual_capsule)) {
            for (const id of activeTrip.actual_capsule) {
                const g = this.db.getGarment(id);
                if (g && !seen.has(g.id)) { shortlist.push(g); seen.add(g.id); }
                if (shortlist.length >= CAPS_SHORTLIST) break;
            }
        }
        if (shortlist.length < CAPS_SHORTLIST) {
            const rest = this.db.getGarments({ limit: CAPS_SHORTLIST });
            for (const g of rest) {
                if (!seen.has(g.id)) { shortlist.push(g); seen.add(g.id); }
                if (shortlist.length >= CAPS_SHORTLIST) break;
            }
        }

        // Try a single-call Pro match. If client missing, fall back to "all NEW".
        let matchPlan = null;
        if (this.agent.client && shortlist.length > 0) {
            matchPlan = await this._matchDetectionsToWardrobe(base64Data, mimeType, detections, shortlist);
        }

        const matched = [];
        const newly_added = [];
        const notes = [];

        // Save the source image once so NEW items can crop from it
        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const sourceId = crypto.randomUUID();
        const sourceDir = path.join(this._baseDir(), 'garments', sourceId);
        if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, `original.${ext}`);
        let sourceWritten = false;

        for (let i = 0; i < detections.length; i++) {
            const det = detections[i];
            const plan = matchPlan?.[i];
            if (plan && plan.match && plan.match !== 'NEW') {
                // Matched to existing wardrobe item
                if (shortlist.find(g => g.id === plan.match)) {
                    matched.push(plan.match);
                    continue;
                }
                // match id not in shortlist (hallucination) → treat as NEW
            }

            // NEW: write source once, crop, insert row with source='auto_from_chat'
            if (!sourceWritten) {
                fs.writeFileSync(sourcePath, Buffer.from(base64Data, 'base64'));
                sourceWritten = true;
            }
            const fullFrame = det.bbox[0] < 0.02 && det.bbox[1] < 0.02 && det.bbox[2] > 0.98 && det.bbox[3] > 0.98;
            let cropPath = sourcePath;
            if (!fullFrame) {
                const cropFile = path.join(sourceDir, `crop_${i}.jpg`);
                try {
                    await this._cropToFile(sourcePath, det.bbox, cropFile);
                    cropPath = cropFile;
                } catch (e) {
                    console.warn(`[WardrobeService] analyzeOutfit crop failed: ${e.message}`);
                }
            }
            const garment = {
                type: det.type,
                subtype: det.subtype,
                primary_color: det.primary_color,
                secondary_colors: det.secondary_colors || [],
                pattern: det.pattern,
                material_guess: det.material_guess,
                warmth: det.warmth,
                formality: det.formality,
                season_tags: det.season_tags || [],
                source_image_path: sourcePath,
                crop_image_path: cropPath,
                bbox: det.bbox,
                source: 'auto_from_chat',
                enrichment_status: 'enriching',
                enrichment_confidence: det.detection_confidence || 0,
                meta: {
                    distinguishingFeatures: det.distinguishing_features || null,
                    detectionRaw: det,
                    ingestSource: 'analyze_outfit_photo',
                    caption: caption || null
                }
            };
            const id = this.db.addGarment(garment);
            const row = this.db.getGarment(id);
            this._broadcast('wardrobe:garment:detected', row);
            newly_added.push(id);
            this._runAttributePass(id).catch(err => {
                console.error(`[WardrobeService] analyzeOutfit attribute pass failed for ${id}:`, err.message);
            });

            // Shopping-list crossref hook (P11 consumes this)
            try {
                const hit = this._matchNewGarmentToShoppingList(garment);
                if (hit) notes.push({ garment_id: id, shopping_list_hit: hit });
            } catch (e) { /* ignore */ }
        }

        // If user asked in the context of an active trip, append matched + newly_added to capsule
        if (activeTrip && activeTrip.status === 'active' && this.db.setTripCapsule) {
            const capsule = Array.isArray(activeTrip.actual_capsule) ? [...activeTrip.actual_capsule] : [];
            for (const id of [...matched, ...newly_added]) {
                if (!capsule.includes(id)) capsule.push(id);
            }
            this.db.setTripCapsule(activeTrip.id, capsule);
            this._broadcast('wardrobe:trip:update', this.db.getTrip(activeTrip.id));
        }

        return { matched, newly_added, notes };
    }

    async _matchDetectionsToWardrobe(base64Data, mimeType, detections, shortlist) {
        if (!this.agent.client) return null;
        const modelName = this.config.getModel('PRO');

        // Read shortlist crops for the Pro call
        const shortlistParts = [];
        for (const g of shortlist) {
            const p = g.crop_image_path || g.source_image_path;
            if (!p || !fs.existsSync(p)) continue;
            try {
                const data = fs.readFileSync(p).toString('base64');
                const mt = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
                shortlistParts.push({ id: g.id, inlineData: { data, mimeType: mt } });
            } catch (e) { /* skip unreadable */ }
        }

        const detectionSummary = detections.map((d, i) =>
            `  ${i}: type=${d.type || '?'}, color=${d.primary_color || '?'}, pattern=${d.pattern || '?'}, features=${d.distinguishing_features || 'none'}`
        ).join('\n');

        const shortlistSummary = shortlistParts.map((p, idx) => {
            const g = shortlist.find(s => s.id === p.id);
            return `  <item_${idx}> id=${g.id}, type=${g.type || '?'}, color=${g.primary_color || '?'}, brand=${g.brand || '?'}`;
        }).join('\n');

        const prompt = `You are matching garments detected in a user's photo against items in their existing wardrobe.

The user's photo contains these detections:
${detectionSummary}

The wardrobe shortlist (in order) contains:
${shortlistSummary}

The wardrobe item images follow below, labeled in the same order (item_0, item_1, ...).

For each detection index (0..${detections.length - 1}), output either:
  - the matching wardrobe id (e.g. "abc-123") if you are confident the item in the photo is the same physical piece, OR
  - "NEW" if the detection is not present in the wardrobe shortlist.

Be strict: only match when the same pattern, color shade, and distinguishing features (logo placement, stitching, named model) agree. Otherwise return NEW.

Respond with strict JSON:
{ "matches": [ { "detection_index": 0, "match": "<wardrobe_id>|NEW" }, ... ] }`;

        const parts = [
            { inlineData: { data: base64Data, mimeType } },
            ...shortlistParts.map(p => p.inlineData ? { inlineData: p.inlineData } : null).filter(Boolean),
            { text: prompt }
        ];

        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts }],
                config: { responseMimeType: 'application/json' }
            });
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_match'); } catch (e) { /* ignore */ }
            const text = this._extractText(result);
            const data = this._safeParseJson(text) || {};
            const matches = Array.isArray(data.matches) ? data.matches : [];
            // Build per-detection plan
            const plan = [];
            for (let i = 0; i < detections.length; i++) {
                const m = matches.find(x => x.detection_index === i) || { match: 'NEW' };
                plan.push({ match: m.match || 'NEW' });
            }
            return plan;
        } catch (e) {
            console.warn('[WardrobeService] Match call failed:', e.message);
            return null;
        }
    }

    /**
     * Compare a newly-ingested garment's attributes against open shopping list
     * items. Returns a shopping list entry if a likely match is found.
     * (Hooked into analyzeOutfitPhoto and ingest for P11 UX nudges.)
     */
    _matchNewGarmentToShoppingList(garment) {
        if (!this.db.listShoppingItems) return null;
        const open = this.db.listShoppingItems({ status: 'wanted' }) || [];
        if (open.length === 0) return null;
        const type = (garment.type || '').toLowerCase();
        const color = (garment.primary_color || '').toLowerCase();
        for (const item of open) {
            const wantType = (item.type || '').toLowerCase();
            const wantColor = (item.primary_color || '').toLowerCase();
            if (type && wantType && type === wantType && color && wantColor && color === wantColor) {
                return { id: item.id, description: item.description };
            }
        }
        return null;
    }

    /**
     * Generate outfit proposals across 4 buckets (weather/occasion/item/safe_repeat).
     * Saves each proposal as a wr_outfits row and returns the saved outfits.
     */
    async recommendOutfit({ garmentIds = null, tripId = null, context = '', count = 4 } = {}) {
        // Resolve candidate pool
        let pool = [];
        let trip = null;
        if (Array.isArray(garmentIds) && garmentIds.length > 0) {
            pool = garmentIds.map(id => this.db.getGarment(id)).filter(Boolean);
        } else if (tripId) {
            trip = this.db.getTrip?.(tripId) || null;
            if (trip?.status === 'active' && Array.isArray(trip.actual_capsule)) {
                pool = trip.actual_capsule.map(id => this.db.getGarment(id)).filter(Boolean);
            }
        }
        if (pool.length === 0) {
            pool = this.db.getGarments({ limit: 500 });
        }
        if (pool.length === 0) {
            return { proposals: [], notes: 'Wardrobe is empty' };
        }

        // Liked outfits for safe_repeat bias
        const liked = (this.db.getOutfits?.({ liked: true, limit: 5 }) || []);

        const poolSummary = pool.map(g => {
            const bits = [
                `id=${g.id}`,
                g.type && `type=${g.type}`,
                g.subtype && `subtype=${g.subtype}`,
                g.primary_color && `color=${g.primary_color}`,
                g.pattern && `pattern=${g.pattern}`,
                g.warmth && `warmth=${g.warmth}`,
                g.formality && `formality=${g.formality}`,
                g.brand && `brand=${g.brand}`,
                Array.isArray(g.season_tags) && g.season_tags.length ? `seasons=${g.season_tags.join(',')}` : null
            ].filter(Boolean);
            return `  - ${bits.join(', ')}`;
        }).join('\n');

        const likedSummary = liked.length > 0
            ? liked.map(o => `  - ${o.name || 'unnamed'} (${(o.garment_ids || []).join(', ')}): ${o.occasion || ''}`).join('\n')
            : '  (none yet)';

        if (!this.agent.client) {
            // Stub fallback: pick the first N garments as a single proposal per bucket
            const fallbackIds = pool.slice(0, Math.min(4, pool.length)).map(g => g.id);
            const stubProposal = {
                bucket: 'weather_anchored',
                garment_ids: fallbackIds,
                rationale: 'Stub proposal (Gemini client unavailable)'
            };
            return this._saveProposals([stubProposal], context);
        }

        const prompt = `You are a personal stylist choosing outfits from the user's wardrobe.

Context: ${context || '(no additional context provided)'}
${trip?.destination ? `Trip: ${trip.destination} (${trip.start_date} → ${trip.end_date})` : ''}

Available garments:
${poolSummary}

Previously liked outfits (bias toward variations of these where helpful):
${likedSummary}

Produce up to ${count} outfit proposals covering distinct angles:
  1. "weather_anchored" — best for the weather/temperature in context
  2. "occasion_anchored" — best for the stated occasion / dress code
  3. "item_anchored" — if context references a specific piece, build around it (else omit this bucket)
  4. "safe_repeat" — a variation on a previously-liked outfit (omit if no liked outfits)

Each proposal must include:
  - bucket: one of the 4 labels
  - garment_ids: array of ids from the pool (only ids above)
  - rationale: 1-2 sentences citing specific pieces
  - wants: OPTIONAL array of { description, type, primary_color } naming missing pieces that would meaningfully improve the combo (else omit)

Do not propose items outside the pool. Respond with strict JSON:
{ "proposals": [ { "bucket": "...", "garment_ids": [...], "rationale": "...", "wants": [...] } ] }`;

        const modelName = this.config.getModel('PRO');
        let data = {};
        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_recommend'); } catch (e) { /* ignore */ }
            const text = this._extractText(result);
            data = this._safeParseJson(text) || {};
        } catch (e) {
            console.error('[WardrobeService] recommendOutfit call failed:', e.message);
            return { proposals: [], notes: `Error: ${e.message}` };
        }

        const proposals = Array.isArray(data.proposals) ? data.proposals : [];
        const validIds = new Set(pool.map(g => g.id));
        const cleaned = proposals
            .map(p => ({
                bucket: p.bucket || 'weather_anchored',
                garment_ids: Array.isArray(p.garment_ids) ? p.garment_ids.filter(id => validIds.has(id)) : [],
                rationale: p.rationale || '',
                wants: Array.isArray(p.wants) ? p.wants : []
            }))
            .filter(p => p.garment_ids.length > 0);

        return this._saveProposals(cleaned, context);
    }

    _saveProposals(proposals, context) {
        const saved = [];
        const wantsAll = [];
        for (const p of proposals) {
            const id = this.db.addOutfit({
                name: `${p.bucket}`,
                occasion: context || null,
                garment_ids: p.garment_ids,
                weather_tags: [],
                liked: false
            });
            const outfit = this.db.getOutfit(id);
            saved.push({ outfit, bucket: p.bucket, rationale: p.rationale, wants: p.wants || [] });
            for (const w of (p.wants || [])) {
                wantsAll.push({ ...w, outfit_id: id });
            }
        }

        // Auto-insert wants into the shopping list (P11)
        if (wantsAll.length > 0 && this.db.addShoppingItem) {
            for (const w of wantsAll) {
                try {
                    this.db.addShoppingItem({
                        description: w.description,
                        type: w.type || null,
                        primary_color: w.primary_color || null,
                        suggested_context: { outfit_id: w.outfit_id, reason: 'completes outfit' },
                        priority: 'medium',
                        status: 'wanted'
                    });
                } catch (e) { /* ignore */ }
            }
        }

        return { proposals: saved, notes: '' };
    }

    /**
     * Render a virtual-mirror image of the user wearing one or more outfits.
     *
     * @param {Object} opts
     * @param {Array} opts.garmentIdsPanels - Accepts either:
     *   - ["g1","g2",...] → single outfit (wraps to one panel) [P7 shape]
     *   - [["g1","g2"], ["g3","g4"]] → N panels (multi-mirror) [P8 shape]
     * @param {string} [opts.layout] - auto|single|horizontal|grid (default auto)
     * @param {string} [opts.outfitId] - If provided and single panel, updates this outfit's rendered_image_path
     */
    async visualizeOutfit({ garmentIdsPanels, layout = 'auto', outfitId = null } = {}) {
        // Normalize to array-of-panels shape
        let panels;
        if (Array.isArray(garmentIdsPanels) && garmentIdsPanels.length > 0 && typeof garmentIdsPanels[0] === 'string') {
            panels = [garmentIdsPanels];
        } else if (Array.isArray(garmentIdsPanels)) {
            panels = garmentIdsPanels.filter(p => Array.isArray(p) && p.length > 0);
        } else {
            panels = [];
        }

        if (panels.length === 0) {
            throw new Error('visualizeOutfit requires at least one panel with garment ids');
        }
        if (panels.length > 4) {
            // Cap at 4 for readability
            panels = panels.slice(0, 4);
        }

        const profile = this.db.getUserProfile();
        const referencePath = profile?.reference_image_path;
        if (!referencePath || !fs.existsSync(referencePath)) {
            return { needs_reference: true };
        }
        if (!this.agent.client) {
            throw new Error('Gemini client not initialized');
        }

        // Build parts: reference selfie first, then all garment crops across all panels
        const parts = [];
        const refMime = referencePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        parts.push({ inlineData: { data: fs.readFileSync(referencePath).toString('base64'), mimeType: refMime } });

        const panelDescriptors = [];
        for (let p = 0; p < panels.length; p++) {
            const garments = panels[p].map(id => this.db.getGarment(id)).filter(Boolean);
            if (garments.length === 0) continue;
            const cropParts = [];
            for (const g of garments) {
                const cp = g.crop_image_path || g.source_image_path;
                if (!cp || !fs.existsSync(cp)) continue;
                const mt = cp.endsWith('.png') ? 'image/png' : 'image/jpeg';
                cropParts.push({ inlineData: { data: fs.readFileSync(cp).toString('base64'), mimeType: mt } });
            }
            parts.push(...cropParts);
            panelDescriptors.push({
                index: p + 1,
                garments: garments.map(g => `${g.type || ''}${g.subtype ? ` (${g.subtype})` : ''} ${g.primary_color || ''}${g.brand ? ` by ${g.brand}` : ''}`.trim())
            });
        }

        const N = panelDescriptors.length;
        const resolvedLayout = layout === 'auto'
            ? (N === 1 ? 'single' : N <= 3 ? 'horizontal' : 'grid')
            : layout;

        let prompt;
        if (N === 1) {
            prompt = `Generate a realistic mirror photo of the person shown in the reference image, wearing exactly the clothing items pictured in the subsequent reference crops.
- Full-body standing mirror-selfie framing
- Clean neutral setting, soft natural lighting
- Preserve the person's face, build, and proportions faithfully
- Garments must match color, pattern, fit, and visible detailing of the crops
- No text overlays, no watermarks
Outfit: ${panelDescriptors[0].garments.join(', ')}`;
        } else {
            prompt = `Generate a single wide photo containing ${N} vertical mirror panels side-by-side.
Each panel shows the reference person in a different outfit, numbered left to right.
${panelDescriptors.map(d => `  Panel ${d.index}: ${d.garments.join(', ')}`).join('\n')}
- Consistent lighting, background, and pose across panels
- Label the bottom of each panel with its number
- Preserve face, build, and proportions faithfully across all panels
- Thin gap between panels, uniform framing
- No text overlays other than the panel numbers
- Layout: ${resolvedLayout === 'grid' ? '2x2 grid' : 'horizontal row'}`;
        }

        parts.push({ text: prompt });

        const modelName = this.config.getModel('IMAGE');
        const response = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts }],
            config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_visualize'); } catch (e) { /* ignore */ }

        const respParts = response?.candidates?.[0]?.content?.parts || [];
        const imagePart = respParts.find(p => p?.inlineData?.mimeType?.startsWith?.('image/'));
        if (!imagePart) {
            throw new Error('No image returned from image model');
        }

        // Pick an outfit id to associate the render with. If the caller passed outfitId, use it.
        // Otherwise create a new wr_outfits row capturing the first panel.
        let targetOutfitId = outfitId;
        if (targetOutfitId) {
            const existing = this.db.getOutfit(targetOutfitId);
            if (!existing) throw new Error(`Outfit ${targetOutfitId} not found`);
        } else {
            targetOutfitId = this.db.addOutfit({
                name: N === 1 ? 'Rendered outfit' : `Rendered ${N}-panel preview`,
                garment_ids: panels[0],
                liked: false
            });
        }

        const outDir = path.join(this._baseDir(), 'outfits', targetOutfitId);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const renderPath = path.join(outDir, 'render.jpg');
        fs.writeFileSync(renderPath, Buffer.from(imagePart.inlineData.data, 'base64'));

        this.db.updateOutfit(targetOutfitId, { rendered_image_path: renderPath });
        const outfit = this.db.getOutfit(targetOutfitId);
        this._broadcast('wardrobe:outfit:rendered', outfit);

        return { outfit, panels: N, layout: resolvedLayout };
    }

    /**
     * Score an outfit, call out strengths/weaknesses, and propose a better
     * alternative using only pieces that exist in the wardrobe.
     *
     * @param {Object} opts
     * @param {string} [opts.imageBase64] - Photo to analyze (auto-runs analyzeOutfitPhoto first)
     * @param {string} [opts.mimeType]
     * @param {Array<string>} [opts.garmentIds] - Alternative: skip photo, use these ids directly
     * @param {string} [opts.tripId] - If active, prefer matching/alternatives within capsule
     * @param {string} [opts.question] - Free-text user question to anchor critique
     */
    async critiqueOutfit({ imageBase64 = null, mimeType = 'image/jpeg', garmentIds = null, tripId = null, question = '' } = {}) {
        let combo = [];
        let newlyAdded = [];

        if (Array.isArray(garmentIds) && garmentIds.length > 0) {
            combo = garmentIds.map(id => this.db.getGarment(id)).filter(Boolean);
        } else if (imageBase64) {
            const analysis = await this.analyzeOutfitPhoto(imageBase64, { tripId, mimeType });
            const ids = [...analysis.matched, ...analysis.newly_added];
            combo = ids.map(id => this.db.getGarment(id)).filter(Boolean);
            newlyAdded = analysis.newly_added;
        } else {
            throw new Error('critiqueOutfit needs either imageBase64 or garmentIds');
        }

        if (combo.length === 0) {
            return { score: 0, strengths: [], weaknesses: ['No garments recognized'], better_alternative: null };
        }

        // Pool for alternative: trip capsule if active, else full wardrobe
        let pool = [];
        if (tripId) {
            const trip = this.db.getTrip?.(tripId);
            if (trip?.status === 'active' && Array.isArray(trip.actual_capsule)) {
                pool = trip.actual_capsule.map(id => this.db.getGarment(id)).filter(Boolean);
            }
        }
        if (pool.length === 0) {
            pool = this.db.getGarments({ limit: 500 });
        }

        const comboIds = new Set(combo.map(g => g.id));
        const poolSummary = pool.map(g => {
            const bits = [
                `id=${g.id}`,
                g.type && `type=${g.type}`,
                g.subtype && `subtype=${g.subtype}`,
                g.primary_color && `color=${g.primary_color}`,
                g.pattern && `pattern=${g.pattern}`,
                g.brand && `brand=${g.brand}`
            ].filter(Boolean);
            return `  - ${bits.join(', ')}`;
        }).join('\n');

        const comboSummary = combo.map(g =>
            `  - id=${g.id}, type=${g.type || '?'}, color=${g.primary_color || '?'}, brand=${g.brand || '?'}`
        ).join('\n');

        if (!this.agent.client) {
            return {
                score: 0,
                strengths: [],
                weaknesses: ['Gemini client not available'],
                better_alternative: null,
                newly_added_from_photo: newlyAdded
            };
        }

        const prompt = `Evaluate this outfit. ${question ? `User's question: "${question}"` : ''}

Current outfit:
${comboSummary}

Full wardrobe available for alternatives (use ONLY these ids):
${poolSummary}

Return strict JSON:
{
  "score": 0-10,
  "strengths": ["specific bullet citing pieces", "..."] ,
  "weaknesses": ["specific bullet citing pieces", "..."] ,
  "better_alternative": {
    "garment_ids": ["id from wardrobe only"],
    "rationale": "1-2 sentences"
  }
}

Rules:
- The "better_alternative.garment_ids" MUST only contain ids from the wardrobe list above.
- Be specific; cite actual pieces by color/type/brand. Avoid generic fashion advice.
- If the current outfit is already great, return an empty better_alternative.garment_ids array.`;

        const modelName = this.config.getModel('PRO');
        let data = {};
        try {
            const result = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_critique'); } catch (e) { /* ignore */ }
            const text = this._extractText(result);
            data = this._safeParseJson(text) || {};
        } catch (e) {
            console.error('[WardrobeService] critique call failed:', e.message);
            return { score: 0, strengths: [], weaknesses: [`Error: ${e.message}`], better_alternative: null };
        }

        const validIds = new Set(pool.map(g => g.id));
        const altIds = Array.isArray(data.better_alternative?.garment_ids)
            ? data.better_alternative.garment_ids.filter(id => validIds.has(id))
            : [];

        return {
            score: Number(data.score) || 0,
            strengths: Array.isArray(data.strengths) ? data.strengths : [],
            weaknesses: Array.isArray(data.weaknesses) ? data.weaknesses : [],
            better_alternative: altIds.length > 0 ? {
                garment_ids: altIds,
                rationale: data.better_alternative?.rationale || ''
            } : null,
            combo_ids: combo.map(g => g.id),
            newly_added_from_photo: newlyAdded
        };
    }

    /**
     * Spawn a subagent to fetch a daily forecast via the weather skill.
     * Returns an array of { date, tempMin, tempMax, condition, precipitationMm } or null on failure.
     */
    async _getWeatherForecast({ destination, startDate, endDate }) {
        if (!this.agent.subAgentService) return null;
        const task = `Get a daily forecast for ${destination} from ${startDate} to ${endDate}.
Use the weather skill (wttr.in or Open-Meteo). Respond with JSON only:
{ "days": [ { "date": "YYYY-MM-DD", "tempMin": number_celsius, "tempMax": number_celsius, "condition": "short text", "precipitationMm": number } ] }`;
        try {
            const result = await this.agent.subAgentService.spawn({
                task,
                tools: ['runShellCommand'],
                waitForResult: true,
                lightweight: true
            });
            // Try common result shapes
            const text = result?.result || result?.output || result?.response || '';
            const data = this._safeParseJson(text);
            return Array.isArray(data?.days) ? data.days : null;
        } catch (e) {
            console.warn('[WardrobeService] Weather subagent failed:', e.message);
            return null;
        }
    }

    /**
     * Plan a trip: fetch weather, reason about a capsule wardrobe, persist as wr_trips row.
     */
    async packForTrip({ destination, startDate, endDate, activities = [], calendarEventId = null }) {
        if (!destination || !startDate || !endDate) {
            throw new Error('packForTrip requires destination, startDate, endDate');
        }

        const forecast = await this._getWeatherForecast({ destination, startDate, endDate });

        // Wardrobe summary (exclude auto_from_trip items from prior trips; those may have gone back)
        const all = this.db.getGarments({ limit: 500 });
        const pool = all.filter(g => g.source !== 'auto_from_trip');
        const poolSummary = pool.slice(0, 150).map(g => {
            const bits = [
                `id=${g.id}`,
                g.type && `type=${g.type}`,
                g.subtype && `subtype=${g.subtype}`,
                g.primary_color && `color=${g.primary_color}`,
                g.warmth && `warmth=${g.warmth}`,
                g.formality && `formality=${g.formality}`,
                Array.isArray(g.season_tags) && g.season_tags.length ? `seasons=${g.season_tags.join(',')}` : null,
                g.brand && `brand=${g.brand}`
            ].filter(Boolean);
            return `  - ${bits.join(', ')}`;
        }).join('\n');

        let planned = [];
        let dailyOutfits = [];
        let rationale = '';

        if (this.agent.client && pool.length > 0) {
            const prompt = `Plan a travel capsule wardrobe for this trip.

Destination: ${destination}
Dates: ${startDate} → ${endDate}
Activities: ${activities.length ? activities.join(', ') : '(not specified)'}

Daily forecast (if available):
${forecast ? forecast.map(d => `  ${d.date}: ${d.tempMin}-${d.tempMax}°C, ${d.condition}, ${d.precipitationMm}mm rain`).join('\n') : '  (forecast unavailable)'}

Wardrobe available (use only these ids):
${poolSummary}

Produce a capsule: the MINIMUM set of items that covers every planned day with layering/variety as needed. Then assign one outfit per day from within the capsule.

Return strict JSON:
{
  "capsule": ["id1", "id2", ...],
  "daily": [ { "date": "YYYY-MM-DD", "garment_ids": [...] } ],
  "rationale": "1-3 sentences about the capsule approach"
}

Rules: only use ids from the wardrobe list above. No external items.`;

            const modelName = this.config.getModel('PRO');
            try {
                const result = await this.agent.client.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    config: { responseMimeType: 'application/json' }
                });
                try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_pack'); } catch (e) { /* ignore */ }
                const text = this._extractText(result);
                const data = this._safeParseJson(text) || {};
                const validIds = new Set(pool.map(g => g.id));
                planned = Array.isArray(data.capsule) ? data.capsule.filter(id => validIds.has(id)) : [];
                dailyOutfits = Array.isArray(data.daily)
                    ? data.daily.map(d => ({
                        date: d.date,
                        garment_ids: Array.isArray(d.garment_ids) ? d.garment_ids.filter(id => planned.includes(id)) : []
                    }))
                    : [];
                rationale = data.rationale || '';
            } catch (e) {
                console.warn('[WardrobeService] packForTrip Pro call failed:', e.message);
            }
        }

        const tripId = this.db.addTrip({
            calendar_event_id: calendarEventId,
            destination,
            start_date: startDate,
            end_date: endDate,
            activities,
            weather_snapshot: forecast ? { days: forecast } : null,
            planned_capsule: planned,
            actual_capsule: null,
            status: 'planned'
        });
        const trip = this.db.getTrip(tripId);
        // Attach daily plan & rationale in a separate meta channel (stored in weather_snapshot for now)
        if (dailyOutfits.length || rationale) {
            this.db.updateTrip(tripId, {
                weather_snapshot: {
                    ...(trip.weather_snapshot || {}),
                    daily_plan: dailyOutfits,
                    pack_rationale: rationale
                }
            });
        }
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async startTrip(tripId) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        const actual = Array.isArray(trip.actual_capsule) && trip.actual_capsule.length > 0
            ? trip.actual_capsule
            : (Array.isArray(trip.planned_capsule) ? trip.planned_capsule : []);
        this.db.updateTrip(tripId, { status: 'active', actual_capsule: actual });
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async completeTrip(tripId) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        this.db.updateTrip(tripId, { status: 'completed' });
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async setTripCapsule(tripId, garmentIds) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        this.db.setTripCapsule(tripId, Array.isArray(garmentIds) ? garmentIds : []);
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async addToTripCapsule(tripId, { garmentIds = null, imageBase64 = null, mimeType = 'image/jpeg' } = {}) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        let ids = Array.isArray(trip.actual_capsule) ? [...trip.actual_capsule] : [];

        if (Array.isArray(garmentIds)) {
            for (const id of garmentIds) { if (!ids.includes(id)) ids.push(id); }
        }
        if (imageBase64) {
            const analysis = await this.analyzeOutfitPhoto(imageBase64, { tripId, mimeType });
            for (const id of [...analysis.matched, ...analysis.newly_added]) {
                if (!ids.includes(id)) ids.push(id);
            }
        }
        this.db.setTripCapsule(tripId, ids);
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async removeFromTripCapsule(tripId, garmentIds) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        const toRemove = new Set(Array.isArray(garmentIds) ? garmentIds : []);
        const next = (trip.actual_capsule || []).filter(id => !toRemove.has(id));
        this.db.setTripCapsule(tripId, next);
        const updated = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', updated);
        return updated;
    }

    async addToShoppingList({ description, type = null, primary_color = null, pattern = null, material_hint = null, context = null, priority = 'medium' } = {}) {
        if (!description) throw new Error('Shopping item needs a description');
        const id = this.db.addShoppingItem({
            description,
            type,
            primary_color,
            pattern,
            material_hint,
            suggested_context: context,
            priority,
            status: 'wanted'
        });
        const item = this.db.getShoppingItem(id);
        this._broadcast('wardrobe:shopping:update', item);
        return item;
    }

    async markPurchased(shoppingId, garmentId = null) {
        const item = this.db.getShoppingItem(shoppingId);
        if (!item) throw new Error(`Shopping item ${shoppingId} not found`);
        this.db.updateShoppingItem(shoppingId, {
            status: 'purchased',
            resolved_garment_id: garmentId || null,
            purchased_at: new Date().toISOString()
        });
        const updated = this.db.getShoppingItem(shoppingId);
        this._broadcast('wardrobe:shopping:update', updated);
        return updated;
    }

    async dismissShoppingItem(shoppingId) {
        const item = this.db.getShoppingItem(shoppingId);
        if (!item) throw new Error(`Shopping item ${shoppingId} not found`);
        this.db.updateShoppingItem(shoppingId, { status: 'dismissed' });
        const updated = this.db.getShoppingItem(shoppingId);
        this._broadcast('wardrobe:shopping:update', updated);
        return updated;
    }

    async likeOutfit(outfitId, liked = true) {
        if (!this.db.updateOutfit) return null;
        this.db.updateOutfit(outfitId, { liked });
        const out = this.db.getOutfit(outfitId);
        this._broadcast('wardrobe:outfit:update', out);
        return out;
    }

    /**
     * Wipe every wardrobe row AND every wardrobe file on disk.
     * Used by the `/clear_wardrobe` slash command for a full reset.
     *
     * @returns {{garments: number, outfits: number, trips: number, shopping: number, filesRemoved: number}}
     */
    async clearAll() {
        const counts = this.db.clearWardrobe();

        let filesRemoved = 0;
        const baseDir = this._baseDir();
        if (fs.existsSync(baseDir)) {
            try {
                const walk = (dir) => {
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const p = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            walk(p);
                            try { fs.rmdirSync(p); } catch (e) { /* ignore */ }
                        } else {
                            try { fs.unlinkSync(p); filesRemoved++; } catch (e) { /* ignore */ }
                        }
                    }
                };
                walk(baseDir);
            } catch (e) {
                console.warn('[WardrobeService] clearAll: file walk failed:', e.message);
            }
        }
        // Recreate the empty subdirs the service expects
        for (const sub of ['garments', 'outfits', 'profile']) {
            const p = path.join(baseDir, sub);
            if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        }

        this._broadcast('wardrobe:cleared', { counts, filesRemoved });

        return {
            garments: counts.wr_garments || 0,
            outfits: counts.wr_outfits || 0,
            trips: counts.wr_trips || 0,
            shopping: counts.wr_shopping_list || 0,
            filesRemoved
        };
    }

    async setReferenceSelfie(base64Data, mimeType = 'image/jpeg') {
        if (!base64Data) throw new Error('Missing image data');
        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const profileDir = path.join(this._baseDir(), 'profile');
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
        const filePath = path.join(profileDir, `reference.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        this.db.updateUserProfile({ reference_image_path: filePath });
        return this.db.getUserProfile();
    }

    _broadcast(event, payload) {
        if (this.agent.interface && this.agent.interface.broadcast) {
            this.agent.interface.broadcast(event, payload);
        }
    }
}

module.exports = { WardrobeService };
