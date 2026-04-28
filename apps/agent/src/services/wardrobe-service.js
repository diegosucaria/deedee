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
    /**
     * Sentinel returned by _detectItems when nothing usable came back. The
     * single placeholder item lets ingest still create one row the user can
     * manually classify, but callers can spot it and skip downstream work
     * (matching against existing wardrobe, brand search, etc.) that would only
     * make sense on real detections.
     */
    static FALLBACK_DETECTION = Object.freeze({
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
        detection_confidence: 0,
        _fallback: true
    });

    _isFallbackDetection(d) {
        return !!(d && d._fallback === true);
    }

    /**
     * Strip the internal `_fallback` sentinel before persisting a detection
     * into the DB row's meta.detectionRaw — that flag is for service-internal
     * routing decisions only and shouldn't appear in API responses or socket
     * broadcasts.
     */
    _detectionForPersist(det) {
        if (!det) return det;
        const { _fallback, ...rest } = det;
        return rest;
    }

    /**
     * Build the detection prompt. We have two flavors:
     *   - default: handles both real-world photos and product-card screenshots
     *   - screenshotMode: explicitly tells the model the input IS a screenshot
     *     and to return one item per product card. Used as a retry when the
     *     default returned zero items.
     */
    _detectionPrompt({ screenshotMode = false } = {}) {
        const intro = screenshotMode
            ? `THE INPUT IMAGE IS A SCREENSHOT of a clothing retailer / order history / lookbook page that the user took to inventory their wardrobe. Every visible product card / product photo represents one garment they own. Your job is to extract one item per product card.`
            : `Extract every wearable garment or accessory from this image so it can be added to the user's personal wardrobe inventory.

The input is one of two scenarios — handle BOTH, never refuse either:
  (A) A real-world photo: clothes laid on a bed, on a hanger, in a closet, or being worn.
  (B) A screenshot of the user's clothes on a website or app: a retailer order history page (Lululemon, Nike, Zara, Uniqlo …), a "My Closet" / "My Orders" view, a lookbook, an outfit board, or a product catalog page. The screenshot ITSELF is the wardrobe inventory — extract one item per visible product card or product photo.`;

        return `${intro}

Return strict JSON:
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
      "distinguishing_features": "logos, stitching, named model, distinctive cut, OR the product title text from a screenshot product card verbatim",
      "detection_confidence": 0..1
    }
  ],
  "scene_notes": "overall framing notes (mention if this is a real-world photo or a website screenshot)"
}

BBOX RULES:
- box_2d is [ymin, xmin, ymax, xmax] normalized to 0-1000 — Gemini's canonical bbox format
- Box tightly encloses the garment itself (or the product photo within a screenshot card) — no extra background padding

${screenshotMode ? `SCREENSHOT EXTRACTION RULES:
- Return ONE item per product card visible in the screenshot, even if the layout is dense
- box_2d should enclose the product PHOTO (not the whole card with title and buttons)
- Quote the product title verbatim into distinguishing_features (e.g. "ABC Warpstreme Jogger Regular", "Men's ShowZero Slim-Fit Polo Shirt")
- Ignore UI chrome ("MY CLOSET", "VIEW PURCHASE DETAILS", prices, dates, navigation) — these are NOT items
- Even if the screenshot has 6+ products tightly packed, return all of them
- "scene_notes" should describe this is a website screenshot
` : `HARD EXCLUDE — never return any of the following as items:
  · the phone or camera taking the photo, including its case, lens, and on-screen reflection
  · hands, fingers, arms, legs, faces, hair, skin, or any other body part
  · mirrors, mirror frames, or anything visible only as a reflection
  · room contents in the scene (bed, sofa, desk, hangers, walls, floor, doors, plants, lamps)
  · packaging, tags, receipts, paper
  · UI chrome from a screenshot ("MY CLOSET" / "VIEW DETAILS" buttons, prices, dates, navigation, search bars)
  · physical screens or monitors visible IN a real-world scene that show unrelated content (this rule does NOT apply when the input itself is a screenshot of clothing — that's scenario B above; extract from it)
  An "accessory" means a wearable accessory the user owns (belt, bag, hat, watch, jewelry, sunglasses, scarf) — not anything else that happens to look small or rectangular
`}
GENERAL RULES:
- Omit fields you cannot confidently determine (do not fabricate)
- Never invent brands — but if a screenshot card has a visible product title, quote it verbatim into distinguishing_features
Respond with JSON only.`;
    }

    /**
     * Single Gemini call for detection. Returns { ok, items, sceneNotes,
     * elapsedMs, errorReason } so the caller can decide whether to retry.
     */
    async _detectionCall(base64Data, mimeType, { screenshotMode = false } = {}) {
        const modelName = this.config.getModel('FLASH');
        const prompt = this._detectionPrompt({ screenshotMode });
        const startedAt = Date.now();
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
            const elapsedMs = Date.now() - startedAt;
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_detect'); } catch (e) { /* ignore */ }

            const text = this._extractText(result);
            if (!text) {
                const finishReason = result?.candidates?.[0]?.finishReason || 'unknown';
                return { ok: false, items: [], sceneNotes: '', elapsedMs, modelName, errorReason: `empty text (finishReason=${finishReason})` };
            }
            let data;
            try {
                const cleaned = String(text).replace(/```json/g, '').replace(/```/g, '').trim();
                data = JSON.parse(cleaned);
            } catch (parseErr) {
                return { ok: false, items: [], sceneNotes: '', elapsedMs, modelName, errorReason: `JSON parse failed: ${parseErr.message} | snippet="${text.slice(0, 200).replace(/\s+/g, ' ')}"` };
            }
            const items = Array.isArray(data?.items) ? data.items : [];
            const sceneNotes = (data?.scene_notes || '').toString().slice(0, 200);
            return { ok: true, items, sceneNotes, elapsedMs, modelName };
        } catch (e) {
            const elapsedMs = Date.now() - startedAt;
            return { ok: false, items: [], sceneNotes: '', elapsedMs, modelName, errorReason: `API error: ${e.message}` };
        }
    }

    async _detectItems(base64Data, mimeType = 'image/jpeg') {
        const TAG = '[wardrobe.detect]';
        const overallStartedAt = Date.now();
        const fallback = (reason) => {
            console.warn(`${TAG} → returning fallback (single full-frame, all attrs null) | reason=${reason} | totalElapsedMs=${Date.now() - overallStartedAt}`);
            return [{ ...WardrobeService.FALLBACK_DETECTION, secondary_colors: [], season_tags: [] }];
        };

        const imgBytes = base64Data ? Math.floor(base64Data.length * 0.75) : 0;
        console.log(`${TAG} start | mimeType=${mimeType} | imageBytes≈${imgBytes}`);

        if (!this.agent.client) {
            return fallback('no Gemini client');
        }

        // First pass: default prompt (handles both real photos and screenshots).
        let res = await this._detectionCall(base64Data, mimeType);
        let usedScreenshotRetry = false;
        if (!res.ok) {
            console.warn(`${TAG} pass-1 failed | model=${res.modelName} | elapsedMs=${res.elapsedMs} | ${res.errorReason}`);
            return fallback(res.errorReason);
        }
        if (res.items.length === 0) {
            // Models often misread retailer screenshots as "browsing" rather than
            // "inventorying" and bail. Retry once with a prompt that asserts the
            // input IS a screenshot and demands per-card extraction.
            console.warn(`${TAG} pass-1 returned zero items | model=${res.modelName} | elapsedMs=${res.elapsedMs} | scene_notes="${res.sceneNotes}" → retrying in screenshot mode`);
            const retry = await this._detectionCall(base64Data, mimeType, { screenshotMode: true });
            if (!retry.ok) {
                console.warn(`${TAG} pass-2 (screenshot mode) failed | ${retry.errorReason}`);
                return fallback(`zero items, retry: ${retry.errorReason}`);
            }
            if (retry.items.length === 0) {
                console.warn(`${TAG} pass-2 (screenshot mode) also returned zero items | scene_notes="${retry.sceneNotes}"`);
                return fallback('zero items in both passes');
            }
            console.log(`${TAG} pass-2 (screenshot mode) recovered | items=${retry.items.length} | elapsedMs=${retry.elapsedMs}`);
            res = retry;
            usedScreenshotRetry = true;
        }

        const normalized = res.items.map(it => this._normalizeDetection(it)).filter(Boolean);
        const dropped = res.items.length - normalized.length;
        const totalElapsedMs = Date.now() - overallStartedAt;
        console.log(`${TAG} ok | model=${res.modelName} | totalElapsedMs=${totalElapsedMs} | passes=${usedScreenshotRetry ? 2 : 1} | rawItems=${res.items.length} | normalized=${normalized.length}${dropped > 0 ? ` | dropped=${dropped}` : ''} | scene_notes="${res.sceneNotes}"`);
        normalized.forEach((det, i) => {
            const conf = typeof det.detection_confidence === 'number' ? det.detection_confidence.toFixed(2) : '?';
            const bbox = det.bbox.map(n => n.toFixed(2)).join(',');
            console.log(`${TAG}   item[${i}] type=${det.type || '?'} subtype=${det.subtype || '?'} color=${det.primary_color || '?'} conf=${conf} bbox=[${bbox}]`);
        });
        return normalized;
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
     * Pick the best image to show / send to a model for a garment.
     *
     * Generated catalog images are preferred when present because they're the
     * canonical clean view (uniform composition, no clutter, no human model).
     * Falls back to the crop, then the source. Used wherever we display a
     * garment OR send it to another model call as a reference.
     *
     * Exception: methods that derive a NEW image FROM the garment's true
     * appearance (re-enrich's attribute pass on a new crop, image regeneration)
     * deliberately read crop_image_path directly so they don't drift through
     * generations.
     */
    _imageForGarment(g) {
        if (!g) return null;
        return g.generated_image_path || g.crop_image_path || g.source_image_path || null;
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
     * @param {boolean} [options.overwriteExisting=false] - When true, brand/model
     *   from the analysis overwrite existing values (used by user-initiated
     *   re-enrich, where stale wrong data should be corrected). When false (the
     *   default for ingest), they only fill empty fields.
     */
    async _runAttributePass(garmentId, { hint = null, extraReferences = [], overwriteExisting = false, preserveFields = [] } = {}) {
        const TAG = '[wardrobe.attr]';
        const garment = this.db.getGarment(garmentId);
        if (!garment) {
            console.warn(`${TAG} skip — garment not found | garmentId=${garmentId}`);
            return;
        }
        if (!this.agent.client) {
            console.warn(`${TAG} skip — no Gemini client | garmentId=${garmentId} → marking complete`);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            return;
        }

        const cropPath = garment.crop_image_path || garment.source_image_path;
        if (!cropPath || !fs.existsSync(cropPath)) {
            console.warn(`${TAG} skip — no readable crop | garmentId=${garmentId} | cropPath=${cropPath || '(null)'} → marking complete`);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            return;
        }

        const extras = Array.isArray(extraReferences)
            ? extraReferences.filter(r => r && typeof r.data === 'string' && r.data.length > 0)
            : [];

        console.log(`${TAG} start | garmentId=${garmentId} | hint=${hint ? `"${hint.slice(0, 80)}"` : '(none)'} | extraRefs=${extras.length} | cropPath=${cropPath}`);

        // We ask the model to populate brand/model whenever the user explicitly
        // initiated this pass (hint typed, or `overwriteExisting` set by re-enrich)
        // — that's the user saying "redo this," and they want the new analysis to
        // potentially correct stale stored values.
        const wantBrandModel = !!hint || overwriteExisting;

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
  "distinguishing_features": "logos, stitching, named model, distinctive cut",${wantBrandModel ? `
  "brand": "brand name${hint ? ' parsed from the user hint or' : ''} visible in the image, or null if unsure",
  "model": "specific model name${hint ? ' parsed from the user hint or' : ''} identifiable in the image, or null if unsure",` : ''}
  "confidence": 0..1
}

${extras.length ? `IMAGES PROVIDED: ${extras.length + 1} photos of the same garment — the first is the original wardrobe crop, the remainder are additional references the user supplied for clarity. Combine evidence from all of them; trust the clearer view when they disagree on a detail.
` : ''}${hint ? `USER-SUPPLIED IDENTITY: "${hint}".
Trust this hint as ground truth. Parse brand and model out of it (e.g. "ABC Warpstreme Jogger Regular · Lululemon" → brand: "Lululemon", model: "ABC Warpstreme Jogger Regular") and shape subtype/material/season_tags around that identity (e.g. "ABC Warpstreme Jogger" → subtype: "joggers", material: a synthetic blend). Only override the hint if the image is clearly inconsistent with it.
` : ''}Rules: omit fields you cannot confidently determine. Do not invent brands${hint ? ' beyond what the hint states' : ''}. Respond with JSON only.`;

        const startedAt = Date.now();
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
            const elapsedMs = Date.now() - startedAt;
            try { this.config.logUsageFromResponse(this.db, modelName, result, null, 'wardrobe_attrs'); } catch (e) { /* ignore */ }

            const text = this._extractText(result);
            let data;
            if (!text) {
                const finishReason = result?.candidates?.[0]?.finishReason || 'unknown';
                console.warn(`${TAG} empty text response | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | finishReason=${finishReason}`);
                data = {};
            } else {
                try {
                    const cleaned = String(text).replace(/```json/g, '').replace(/```/g, '').trim();
                    data = JSON.parse(cleaned);
                } catch (parseErr) {
                    console.warn(`${TAG} JSON parse failed | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | err=${parseErr.message} | snippet="${text.slice(0, 200).replace(/\s+/g, ' ')}"`);
                    data = {};
                }
            }
            console.log(`${TAG} model returned | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | type=${data.type || '?'} subtype=${data.subtype || '?'} color=${data.primary_color || '?'} confidence=${data.confidence ?? '?'}${data.brand ? ` brand=${data.brand}` : ''}${data.model ? ` model=${data.model}` : ''}`);

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
            // Brand/model overlay rules:
            //   - On user-initiated re-enrich (`overwriteExisting`), overwrite
            //     stale stored values when the model returns something. Only
            //     overwrite with non-null values — if the model is unsure we'd
            //     rather keep the user's old data than blank it out.
            //   - With just a typed hint (no overwrite), only fill empties so we
            //     don't clobber values the user already curated by hand.
            if (overwriteExisting) {
                if (data.brand) patch.brand = data.brand;
                if (data.model) patch.model = data.model;
            } else if (hint) {
                if (data.brand && !garment.brand) patch.brand = data.brand;
                if (data.model && !garment.model) patch.model = data.model;
            }
            patch.meta = {
                ...(garment.meta || {}),
                distinguishingFeatures: data.distinguishing_features || garment.meta?.distinguishingFeatures || null,
                attributePassRaw: data
            };

            // Respect explicit preserveFields (caller says "don't touch these"), and
            // any field the user edited in the DB while this pass was running. This
            // prevents the attribute pass from silently overwriting hand-curated data.
            const current = this.db.getGarment(garmentId) || garment;
            const protectedFields = new Set(preserveFields);
            for (const key of ['type', 'subtype', 'primary_color', 'secondary_colors', 'pattern', 'material_guess', 'warmth', 'formality', 'season_tags', 'brand', 'model']) {
                const before = garment[key];
                const after = current[key];
                const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
                if (changed) protectedFields.add(key);
            }
            for (const key of protectedFields) {
                if (key in patch) delete patch[key];
            }
            if (protectedFields.size > 0) {
                console.log(`${TAG} skipped fields (user-edited or explicitly preserved) | garmentId=${garmentId} | fields=${[...protectedFields].join(',')}`);
            }

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
                console.warn(`${TAG} brand enrichment failed | garmentId=${garmentId} | err=${brandErr.message} → marking complete with attrs only`);
                this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
                this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            }
        } catch (e) {
            const elapsedMs = Date.now() - startedAt;
            console.error(`${TAG} pass crashed | garmentId=${garmentId} | elapsedMs=${elapsedMs} | err=${e.message}`);
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
        const TAG = '[wardrobe.brand]';
        const garment = this.db.getGarment(garmentId);
        if (!garment) {
            console.warn(`${TAG} skip — garment not found | garmentId=${garmentId}`);
            return;
        }

        // Respect user input: if they set brand, confirmed one, or supplied a hint,
        // there's nothing for the search to add.
        if (garment.brand || garment.meta?.userHint || garment.meta?.brandUserConfirmed) {
            const reason = garment.brand ? 'brand already set' : garment.meta?.userHint ? 'user hint present' : 'brand user-confirmed';
            console.log(`${TAG} skip — ${reason} | garmentId=${garmentId}`);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }

        const distinguishing = garment.meta?.distinguishingFeatures;
        const cropPath = garment.crop_image_path || garment.source_image_path;

        // Nothing to search on, or no client — just complete what we have.
        if (!distinguishing || !this.agent.client || !cropPath || !fs.existsSync(cropPath)) {
            const reason = !distinguishing ? 'no distinguishing features'
                : !this.agent.client ? 'no Gemini client'
                : 'crop unreadable';
            console.log(`${TAG} skip — ${reason} | garmentId=${garmentId}`);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }

        console.log(`${TAG} start | garmentId=${garmentId} | distinguishing="${(distinguishing || '').slice(0, 100)}"`);

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
        const startedAt = Date.now();
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
            const elapsedMs = Date.now() - startedAt;
            console.warn(`${TAG} search threw | garmentId=${garmentId} | elapsedMs=${elapsedMs} | err=${e.message} → marking complete with no brand`);
            this.db.updateGarment(garmentId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:enriched', this.db.getGarment(garmentId));
            return;
        }
        const elapsedMs = Date.now() - startedAt;

        const brand = (typeof data.brand === 'string' && data.brand.trim()) ? data.brand.trim() : null;
        const model = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : null;
        const confidence = Number(data.confidence) || 0;
        const visualCite = (typeof data.visual_identifier_cited === 'string' && data.visual_identifier_cited.trim())
            ? data.visual_identifier_cited.trim() : null;

        const THRESHOLD = 0.95;

        if (brand && confidence >= THRESHOLD && visualCite) {
            console.log(`${TAG} auto-accept | garmentId=${garmentId} | elapsedMs=${elapsedMs} | brand="${brand}" model="${model || ''}" confidence=${confidence.toFixed(2)} cite="${visualCite.slice(0, 80)}"`);
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
            console.log(`${TAG} needs confirm | garmentId=${garmentId} | elapsedMs=${elapsedMs} | brand="${brand}" confidence=${confidence.toFixed(2)} below threshold ${THRESHOLD}${visualCite ? '' : ' (no visual identifier cited)'}`);
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
            console.log(`${TAG} no brand identified | garmentId=${garmentId} | elapsedMs=${elapsedMs} | confidence=${confidence.toFixed(2)}`);
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
     * Fold one or more duplicate garment rows into a primary one. Used when the
     * automatic match-against-existing didn't catch a duplicate at ingest time
     * (e.g. the user uploaded the same shoes twice from different angles).
     *
     * Behavior:
     * - Primary keeps its own image (crop / generated). Duplicates' image files
     *   are deleted via deleteGarment.
     * - Empty primary fields are filled in from the first duplicate that has a
     *   value. Non-empty primary fields are never overwritten — primary wins.
     * - times_worn is summed across all rows.
     * - Every outfit / trip capsule / shopping resolution that referenced a
     *   duplicate is rewritten to point at the primary (deduped per row).
     * - Duplicates are then deleted.
     *
     * @param {string} primaryId
     * @param {string[]} duplicateIds
     * @returns {Object} the updated primary garment row
     */
    async mergeGarments(primaryId, duplicateIds) {
        const TAG = '[wardrobe.merge]';
        if (!primaryId) throw new Error('mergeGarments requires a primary id');
        const dupIds = Array.isArray(duplicateIds)
            ? duplicateIds.filter(id => typeof id === 'string' && id && id !== primaryId)
            : [];
        if (dupIds.length === 0) throw new Error('mergeGarments requires at least one duplicate id');

        const primary = this.db.getGarment(primaryId);
        if (!primary) throw new Error(`Primary garment ${primaryId} not found`);

        const duplicates = [];
        for (const id of dupIds) {
            const g = this.db.getGarment(id);
            if (!g) throw new Error(`Duplicate garment ${id} not found`);
            duplicates.push(g);
        }

        console.log(`${TAG} start | primaryId=${primaryId} | duplicates=${dupIds.join(',')}`);

        // Field merge: only fill primary blanks. Primary always wins on conflicts.
        const TEXT_FIELDS = ['type', 'subtype', 'primary_color', 'pattern', 'material_guess',
            'brand', 'model', 'size', 'fit_notes'];
        const NUMERIC_FIELDS = ['warmth', 'formality'];
        const isBlank = v => v === null || v === undefined || v === '';

        const patch = {};
        for (const field of TEXT_FIELDS) {
            if (!isBlank(primary[field])) continue;
            const filler = duplicates.find(d => !isBlank(d[field]));
            if (filler) patch[field] = filler[field];
        }
        for (const field of NUMERIC_FIELDS) {
            if (primary[field] !== null && primary[field] !== undefined) continue;
            const filler = duplicates.find(d => d[field] !== null && d[field] !== undefined);
            if (filler) patch[field] = filler[field];
        }
        // Union of season tags
        if (Array.isArray(primary.season_tags)) {
            const set = new Set(primary.season_tags);
            for (const d of duplicates) {
                if (Array.isArray(d.season_tags)) for (const t of d.season_tags) set.add(t);
            }
            patch.season_tags = Array.from(set);
        }
        // Sum times_worn across all rows
        const totalWorn = (primary.times_worn || 0) + duplicates.reduce((s, d) => s + (d.times_worn || 0), 0);
        if (totalWorn !== (primary.times_worn || 0)) patch.times_worn = totalWorn;
        // Most recent last_worn_at across all rows
        const allWornAt = [primary.last_worn_at, ...duplicates.map(d => d.last_worn_at)].filter(Boolean);
        if (allWornAt.length > 0) {
            const newest = allWornAt.sort().at(-1);
            if (newest && newest !== primary.last_worn_at) patch.last_worn_at = newest;
        }
        // Track the merge in meta for audit
        patch.meta = {
            ...(primary.meta || {}),
            mergedFrom: [...(primary.meta?.mergedFrom || []), ...dupIds],
            lastMergedAt: new Date().toISOString()
        };

        if (Object.keys(patch).length > 0) {
            this.db.updateGarment(primaryId, patch);
        }

        // Rewrite all references in outfits, trips, shopping list.
        const idMap = new Map(dupIds.map(id => [id, primaryId]));
        const rewriteIds = (arr) => {
            if (!Array.isArray(arr)) return { changed: false, value: arr };
            const next = [];
            const seen = new Set();
            let changed = false;
            for (const id of arr) {
                const mapped = idMap.has(id) ? primaryId : id;
                if (mapped !== id) changed = true;
                if (seen.has(mapped)) { changed = true; continue; }
                seen.add(mapped);
                next.push(mapped);
            }
            return { changed, value: next };
        };

        let outfitsRewritten = 0;
        if (this.db.getOutfits && this.db.updateOutfit) {
            const outfits = this.db.getOutfits({ limit: 10000 }) || [];
            for (const o of outfits) {
                const r = rewriteIds(o.garment_ids);
                if (r.changed) {
                    this.db.updateOutfit(o.id, { garment_ids: r.value });
                    outfitsRewritten++;
                }
            }
        }

        let tripsRewritten = 0;
        if (this.db.getTrips && this.db.updateTrip) {
            const trips = this.db.getTrips({}) || [];
            for (const t of trips) {
                const update = {};
                const planned = rewriteIds(t.planned_capsule);
                if (planned.changed) update.planned_capsule = planned.value;
                const actual = rewriteIds(t.actual_capsule);
                if (actual.changed) update.actual_capsule = actual.value;
                if (Object.keys(update).length > 0) {
                    this.db.updateTrip(t.id, update);
                    tripsRewritten++;
                }
            }
        }

        let shoppingRewritten = 0;
        if (this.db.listShoppingItems && this.db.updateShoppingItem) {
            const items = this.db.listShoppingItems({}) || [];
            for (const item of items) {
                if (item.resolved_garment_id && idMap.has(item.resolved_garment_id)) {
                    this.db.updateShoppingItem(item.id, { resolved_garment_id: primaryId });
                    shoppingRewritten++;
                }
            }
        }

        // Finally, drop the duplicate rows. deleteGarment handles file cleanup.
        for (const id of dupIds) {
            this.db.deleteGarment(id);
            this._broadcast('wardrobe:garment:delete', { id });
        }

        const updated = this.db.getGarment(primaryId);
        this._broadcast('wardrobe:garment:update', updated);

        console.log(`${TAG} done | primaryId=${primaryId} | merged=${dupIds.length} | outfitsRewritten=${outfitsRewritten} | tripsRewritten=${tripsRewritten} | shoppingRewritten=${shoppingRewritten}`);
        return updated;
    }

    /**
     * Re-run the attribute pass on an existing garment, optionally biased by a
     * user-supplied hint (e.g. "ABC Warpstreme Jogger Regular") and/or a new
     * reference photo. The hint is combined with whatever brand/model the user
     * has already set so the model reshapes the subtype/material/season tags
     * around that identity.
     *
     * If `extraImageBase64` is provided it REPLACES the garment's crop — the
     * user is saying "this is a better photo of this item." The previous crop
     * file and any stale generated image are unlinked so we don't leak storage
     * or serve a cached old image.
     *
     * Returns the garment row immediately; the refinement runs in the background
     * and broadcasts wardrobe:garment:attributes / :enriched when complete.
     */
    async reenrichGarment(garmentId, { hint = '', extraImageBase64 = null, mimeType = 'image/jpeg' } = {}) {
        const TAG = '[wardrobe.reenrich]';
        const garment = this.db.getGarment(garmentId);
        if (!garment) throw new Error(`Garment ${garmentId} not found`);

        // Re-enrich is the user explicitly saying "redo the analysis." Don't bias
        // the prompt with the existing brand/model — those may well be the wrong
        // values the user is trying to correct. Only the typed hint goes in.
        const trimmed = (hint || '').trim();
        const effectiveHint = trimmed || null;

        console.log(`${TAG} start | garmentId=${garmentId} | hint=${trimmed ? `"${trimmed.slice(0, 80)}"` : '(none)'} | replacingCrop=${!!extraImageBase64} | existingBrand=${garment.brand || '(none)'} model=${garment.model || '(none)'}`);

        const metaPatch = { ...(garment.meta || {}) };
        if (trimmed) metaPatch.userHint = trimmed;
        // Clear any stale brand candidate — user-driven re-enrich supersedes it
        metaPatch.brandCandidate = null;

        const patch = {
            enrichment_status: 'enriching',
            meta: metaPatch
        };

        // If the user uploaded a new image, swap the garment's crop for it. This
        // is what makes the wardrobe tile actually update — without this we'd
        // only refresh attributes and the user would think "nothing changed."
        if (extraImageBase64) {
            const ext = (mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
            const oldCropPath = garment.crop_image_path;
            const oldGenPath = garment.generated_image_path;
            const sourceDirRef = oldCropPath || garment.source_image_path;
            const sourceDir = sourceDirRef ? path.dirname(sourceDirRef) : path.join(this._baseDir(), 'garments', crypto.randomUUID());
            if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
            const ts = Date.now();
            const newCropPath = path.join(sourceDir, `crop_${garmentId}_${ts}.${ext}`);
            fs.writeFileSync(newCropPath, Buffer.from(extraImageBase64, 'base64'));

            patch.crop_image_path = newCropPath;
            // The previous generated image was rendered from the OLD crop — it no
            // longer reflects what this garment looks like, so drop it.
            patch.generated_image_path = null;
            // Replacing the photo is the strongest signal that the previous
            // analysis is suspect. Clear brand/model so the upcoming attribute
            // pass and brand-search start from a clean slate. (If the user typed
            // a matching hint, the pass will re-set them to the correct value.)
            patch.brand = null;
            patch.model = null;

            // Cleanup: drop the old crop file unless it's the shared multi-garment
            // source image (full-frame ingests reuse source as crop).
            if (oldCropPath && oldCropPath !== garment.source_image_path && fs.existsSync(oldCropPath)) {
                try { fs.unlinkSync(oldCropPath); } catch (e) { /* ignore — cosmetic cleanup */ }
            }
            if (oldGenPath && fs.existsSync(oldGenPath)) {
                try { fs.unlinkSync(oldGenPath); } catch (e) { /* ignore */ }
            }

            console.log(`${TAG} crop replaced | garmentId=${garmentId} | newCrop=${newCropPath}${oldGenPath ? ' | cleared stale generated image' : ''} | brand/model cleared for fresh analysis`);
        }

        this.db.updateGarment(garmentId, patch);
        this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));

        // Background refinement — the attribute pass reads the (possibly new)
        // crop_image_path from the row, so we don't need to forward extras.
        // Pass overwriteExisting so brand/model from the new analysis can replace
        // wrong stored values (the whole point of a user-initiated re-enrich).
        // Also clear the brand_search_done flag so the brand pass re-runs against
        // the new image even if it ran before.
        this._runAttributePass(garmentId, {
            hint: effectiveHint,
            overwriteExisting: true
        }).catch(err => {
            console.error(`${TAG} background attribute pass crashed | garmentId=${garmentId} | err=${err.message}`);
        });

        return this.db.getGarment(garmentId);
    }

    /**
     * Per-type framing/composition prescription for product image generation.
     * The whole point is consistency across the grid: every shoe should look
     * the same way (3/4 angle, pair, gum-sole-down) so two side-by-side tiles
     * read as the same kind of object instead of two different photo styles.
     */
    _styleForType(type, subtype) {
        const t = (type || '').toLowerCase();
        const s = (subtype || '').toLowerCase();
        if (t === 'shoes') {
            return [
                '- Render BOTH shoes of the pair, framed together — never a single shoe alone',
                '- 3/4 front angle viewed from a slightly elevated viewpoint (camera roughly waist-height)',
                '- Toes pointing toward camera-left at ~30° off-axis, heels toward camera-right',
                '- Shoes overlap slightly with the right shoe set just behind and to the right of the left shoe',
                '- Soles fully visible from this angle, ground line implied by a soft contact shadow',
                '- Laces fully laced and tidy; tongue upright'
            ].join('\n');
        }
        if (t === 'top') {
            return [
                '- Lay the garment flat as if photographed from directly above on a neutral surface (flat lay)',
                '- Front of the garment facing the camera, fully visible from collar to hem',
                '- Shoulders squared at the top of the frame, sleeves laid straight along the sides slightly outward',
                s.includes('button') || s.includes('shirt') || s.includes('polo') ? '- Top button done up, collar laid flat and symmetrical' : null
            ].filter(Boolean).join('\n');
        }
        if (t === 'bottom') {
            return [
                '- Lay the garment flat as if photographed from directly above on a neutral surface (flat lay)',
                '- Front of the garment facing the camera, full length visible from waistband to hem',
                '- Waistband at the top of the frame, legs straight and parallel, no folds or bunching',
                s.includes('jogger') || s.includes('sweat') ? '- Drawcord centered and tied in a small symmetric bow' : null
            ].filter(Boolean).join('\n');
        }
        if (t === 'outerwear') {
            return [
                '- Lay the garment flat front-up, fully buttoned/zipped (only if it has closures), on a neutral surface',
                '- Shoulders squared at the top of the frame, sleeves laid straight along the sides slightly outward',
                '- Collar/lapels symmetric, hood (if any) laid flat behind the shoulders'
            ].join('\n');
        }
        if (t === 'accessory') {
            if (s.includes('bag') || s.includes('backpack')) {
                return [
                    '- 3/4 front angle, item upright on its base, straps/handles visible and arranged neatly',
                    '- Camera roughly at the item\'s mid-height'
                ].join('\n');
            }
            if (s.includes('hat') || s.includes('cap') || s.includes('beanie')) {
                return [
                    '- 3/4 front angle, brim/visor pointing slightly toward camera-left, crown facing up',
                    '- Item resting on the surface as if worn-side-up'
                ].join('\n');
            }
            if (s.includes('belt')) {
                return [
                    '- Belt coiled in a neat single loop, buckle at top center facing camera',
                    '- Top-down view'
                ].join('\n');
            }
            if (s.includes('watch') || s.includes('jewelry') || s.includes('sunglass')) {
                return [
                    '- Top-down view, item centered and laid flat',
                    '- Symmetric arrangement, all details (face, lenses, clasps) clearly visible'
                ].join('\n');
            }
            return '- Top-down flat-lay view, item centered and laid out symmetrically with all features visible';
        }
        // Fallback for unknown / underwear / other
        return '- Lay the garment flat front-up on a neutral surface (flat lay), centered and symmetric, all features visible';
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
        const TAG = '[wardrobe.imagegen]';
        const garment = this.db.getGarment(garmentId);
        if (!garment) throw new Error(`Garment ${garmentId} not found`);
        if (!this.agent.client) throw new Error('Gemini client not initialized');

        const cropPath = garment.crop_image_path || garment.source_image_path;
        if (!cropPath || !fs.existsSync(cropPath)) {
            throw new Error('Garment has no source image to reference');
        }

        const extras = Array.isArray(extraReferences)
            ? extraReferences.filter(r => r && typeof r.data === 'string' && r.data.length > 0)
            : [];

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

        console.log(`${TAG} start | garmentId=${garmentId} | descriptor="${descriptor}" | extraRefs=${extras.length} | hasExisting=${!!garment.generated_image_path}`);

        // Mark the garment as generating so every connected client can show a
        // spinner on the grid card. Cleared in the finally-block below.
        this.db.updateGarment(garmentId, {
            meta: { ...(garment.meta || {}), generatingImage: true, generatingImageStartedAt: Date.now() }
        });
        this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));

        const referenceClause = extras.length === 0
            ? 'Use the single reference image to render the item.'
            : `Use ALL ${extras.length + 1} reference images — they show the same physical garment from different angles or with different details. Preserve every visible feature across all of them (logos, stitching, hardware, prints) in the final render. Do not invent or omit details based on a single image when other references contradict.`;

        const styleClause = this._styleForType(garment.type, garment.subtype);

        const prompt = `Generate a clean product-catalog photo of the exact ${descriptor}.
${referenceClause}

COMPOSITION (mandatory — every garment of this type must look the same way so the wardrobe grid is uniform):
${styleClause}

GENERAL RULES:
- Plain neutral off-white background (#F4F2EE), no gradient, no shadows beyond a soft contact shadow
- Square 1:1 aspect ratio, item fills 75-85% of the frame, centered, small uniform margin
- Soft diffuse studio lighting, no harsh highlights, no colored tints
- No human model, no mannequin, no hanger, no clutter, no props
- Preserve color, pattern, fit, fabric texture, and any visible logos or stitching faithfully
- Studio e-commerce aesthetic (think Nike/SSENSE/MR PORTER product page)
- No text overlays, no watermarks, no borders`;

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
        const startedAt = Date.now();
        try {
            let response;
            try {
                response = await this.agent.client.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts }],
                    config: { responseModalities: ['TEXT', 'IMAGE'] }
                });
            } catch (apiErr) {
                const elapsedMs = Date.now() - startedAt;
                console.error(`${TAG} API call threw | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | err=${apiErr.message}`);
                throw apiErr;
            }
            const elapsedMs = Date.now() - startedAt;
            try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_generate_garment'); } catch (e) { /* ignore */ }

            const respParts = response?.candidates?.[0]?.content?.parts || [];
            const imagePart = respParts.find(p => p?.inlineData?.mimeType?.startsWith?.('image/'));
            if (!imagePart) {
                const finishReason = response?.candidates?.[0]?.finishReason || 'unknown';
                const textParts = respParts.filter(p => p?.text).map(p => p.text).join(' ').slice(0, 200);
                console.error(`${TAG} no image in response | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | finishReason=${finishReason}${textParts ? ` | text="${textParts}"` : ''}`);
                throw new Error('No image returned from image model');
            }

            // Write to a unique filename per regeneration so the browser can't serve a
            // stale cached copy — image route uses Cache-Control: immutable. Delete the
            // previous generated file (if any) so we don't leave cruft on disk.
            const previousPath = garment.generated_image_path;
            const outDir = path.dirname(cropPath);
            const ts = Date.now();
            const outPath = path.join(outDir, `generated_${garmentId}_${ts}.jpg`);
            const bytes = Buffer.from(imagePart.inlineData.data, 'base64');
            fs.writeFileSync(outPath, bytes);

            if (previousPath && previousPath !== outPath && fs.existsSync(previousPath)) {
                try { fs.unlinkSync(previousPath); } catch (e) { /* ignore — cosmetic cleanup */ }
            }

            // Clear the generatingImage flag alongside the new path in one write so the
            // client sees a consistent "done" state.
            const currentMeta = this.db.getGarment(garmentId)?.meta || {};
            const clearedMeta = { ...currentMeta };
            delete clearedMeta.generatingImage;
            delete clearedMeta.generatingImageStartedAt;
            this.db.updateGarment(garmentId, { generated_image_path: outPath, meta: clearedMeta });
            const updated = this.db.getGarment(garmentId);
            this._broadcast('wardrobe:garment:update', updated);

            console.log(`${TAG} done | garmentId=${garmentId} | model=${modelName} | elapsedMs=${elapsedMs} | bytes=${bytes.length} | path=${outPath}${previousPath ? ` (replaced ${path.basename(previousPath)})` : ''}`);
            return updated;
        } catch (err) {
            // Always clear the generating flag — otherwise a crashed/abandoned
            // generation leaves the grid spinning forever.
            try {
                const currentMeta = this.db.getGarment(garmentId)?.meta || {};
                const clearedMeta = { ...currentMeta };
                delete clearedMeta.generatingImage;
                delete clearedMeta.generatingImageStartedAt;
                this.db.updateGarment(garmentId, { meta: clearedMeta });
                this._broadcast('wardrobe:garment:update', this.db.getGarment(garmentId));
            } catch (cleanupErr) {
                console.warn(`${TAG} cleanup failed after error | garmentId=${garmentId} | err=${cleanupErr.message}`);
            }
            throw err;
        }
    }

    /**
     * Ingest garments from a base64 image. Detection runs synchronously and
     * returns placeholder rows; per-garment attribute refinement runs in the
     * background and broadcasts `wardrobe:garment:attributes` when complete.
     */
    async ingestGarmentFromBase64(base64Data, mimeType = 'image/jpeg') {
        const TAG = '[wardrobe.ingest]';
        if (!base64Data) throw new Error('Missing image data');

        console.log(`${TAG} start | mimeType=${mimeType} | imageBytes≈${Math.floor(base64Data.length * 0.75)}`);

        // Write the source image + create a "detecting" placeholder row BEFORE
        // the slow Gemini detection call. A page refresh during detection will
        // now see a skeleton card for the upload in progress instead of losing
        // track of it entirely.
        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const sourceId = crypto.randomUUID();
        const sourceDir = path.join(this._baseDir(), 'garments', sourceId);
        if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, `original.${ext}`);
        fs.writeFileSync(sourcePath, Buffer.from(base64Data, 'base64'));
        console.log(`${TAG} wrote source image | sourceId=${sourceId} | path=${sourcePath}`);

        const placeholderId = this.db.addGarment({
            source_image_path: sourcePath,
            crop_image_path: sourcePath,
            source: 'manual_upload',
            enrichment_status: 'detecting',
            enrichment_confidence: 0,
            meta: {}
        });
        this._broadcast('wardrobe:garment:detected', this.db.getGarment(placeholderId));

        let detections;
        try {
            detections = await this._detectItems(base64Data, mimeType);
        } catch (detectErr) {
            // Detection failed entirely — leave a complete (empty) row the user
            // can classify by hand rather than abandoning the upload.
            this.db.updateGarment(placeholderId, { enrichment_status: 'complete' });
            this._broadcast('wardrobe:garment:update', this.db.getGarment(placeholderId));
            throw detectErr;
        }

        if (!detections || detections.length === 0) {
            console.warn(`${TAG} no detections returned — keeping placeholder for manual classification`);
            this.db.updateGarment(placeholderId, { enrichment_status: 'complete' });
            const row = this.db.getGarment(placeholderId);
            this._broadcast('wardrobe:garment:update', row);
            return { garments: [row], matched_existing: [] };
        }

        // Match against existing wardrobe to avoid duplicates when the user
        // re-uploads a photo of something they already cataloged. This mirrors
        // the matching already done by analyzeOutfitPhoto — every ingest path
        // should respect "we might already have this."
        //
        // Skip matching when ALL we got is the fallback placeholder (detection
        // failed). Asking the matcher to compare a generic "[0,0,1,1] all-null"
        // detection against the wardrobe just produces spurious matches.
        const allFallback = detections.every(d => this._isFallbackDetection(d));
        const CAPS_SHORTLIST = 25;
        // Exclude our own placeholder from the matcher — it's not a real item.
        const shortlist = (this.db.getGarments({ limit: CAPS_SHORTLIST }) || []).filter(g => g.id !== placeholderId);
        let matchPlan = null;
        if (!allFallback && this.agent.client && shortlist.length > 0) {
            matchPlan = await this._matchDetectionsToWardrobe(base64Data, mimeType, detections, shortlist);
        } else if (allFallback) {
            console.log(`${TAG} skipping wardrobe match — detection fell back to placeholder (no real items to match)`);
        }

        const created = [];
        const matched_existing = [];
        let cropped = 0;
        let fullFrameCount = 0;
        let placeholderUsed = false;
        for (let i = 0; i < detections.length; i++) {
            const det = detections[i];

            // Skip if the model matched this detection to an existing wardrobe item
            const plan = matchPlan?.[i];
            if (plan && plan.match && plan.match !== 'NEW') {
                if (shortlist.find(g => g.id === plan.match)) {
                    matched_existing.push(plan.match);
                    continue;
                }
                // hallucinated id → fall through and treat as NEW
            }

            const fullFrame = det.bbox[0] < 0.02 && det.bbox[1] < 0.02 && det.bbox[2] > 0.98 && det.bbox[3] > 0.98;
            let cropPath = sourcePath;
            if (fullFrame) {
                fullFrameCount++;
            } else {
                const cropFile = path.join(sourceDir, `crop_${i}.jpg`);
                try {
                    await this._cropToFile(sourcePath, det.bbox, cropFile);
                    cropPath = cropFile;
                    cropped++;
                } catch (e) {
                    console.warn(`${TAG} crop failed for detection[${i}] bbox=[${det.bbox.join(',')}] | err=${e.message} — falling back to source image`);
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
                    detectionRaw: this._detectionForPersist(det)
                }
            };

            // Reuse the placeholder for the first new detection so the refresh-
            // safe card created up-front transitions smoothly into the real row.
            // Additional detections get their own rows.
            let id;
            if (!placeholderUsed) {
                this.db.updateGarment(placeholderId, garment);
                id = placeholderId;
                placeholderUsed = true;
                this._broadcast('wardrobe:garment:update', this.db.getGarment(id));
            } else {
                id = this.db.addGarment(garment);
                this._broadcast('wardrobe:garment:detected', this.db.getGarment(id));
            }
            const row = this.db.getGarment(id);
            created.push(row);

            // Fire-and-forget attribute pass
            this._runAttributePass(id).catch(err => {
                console.error(`[wardrobe.attr] background pass crashed | garmentId=${id} | err=${err.message}`);
            });
        }

        // Every detection matched an existing garment — drop the placeholder so
        // the grid doesn't keep a ghost "complete/empty" row.
        if (!placeholderUsed) {
            this.db.deleteGarment(placeholderId);
            this._broadcast('wardrobe:garment:delete', { id: placeholderId });
        }

        console.log(`${TAG} done | created=${created.length} | matched_existing=${matched_existing.length} | cropped=${cropped} | fullFrame=${fullFrameCount}${fullFrameCount > 0 ? ' (= detection failed to localize, see [wardrobe.detect] logs above)' : ''}`);
        return { garments: created, matched_existing };
    }

    /**
     * "Add another like this." Given a source garment and a new photo (typically
     * a folded-shirt flat-lay of the same product in a different color), create
     * a new garment inheriting identity/size/material attributes from the source
     * and re-detecting color/pattern from the new image in the background.
     *
     * We deliberately skip the usual multi-item detection pipeline — the photo
     * already depicts a single known garment, so cropping or matching against
     * existing wardrobe items would just add noise.
     */
    async duplicateGarment(sourceId, base64Data, mimeType = 'image/jpeg') {
        const TAG = '[wardrobe.duplicate]';
        if (!sourceId) throw new Error('Missing source garment id');
        if (!base64Data) throw new Error('Missing image data');

        const source = this.db.getGarment(sourceId);
        if (!source) throw new Error(`Source garment "${sourceId}" not found`);

        const ext = mimeType.includes('png') ? 'png' : 'jpg';
        const newId = crypto.randomUUID();
        const garmentDir = path.join(this._baseDir(), 'garments', newId);
        if (!fs.existsSync(garmentDir)) fs.mkdirSync(garmentDir, { recursive: true });
        const imagePath = path.join(garmentDir, `original.${ext}`);
        fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
        console.log(`${TAG} wrote image | sourceId=${sourceId} | newId=${newId} | path=${imagePath}`);

        const garment = {
            id: newId,
            type: source.type || null,
            subtype: source.subtype || null,
            brand: source.brand || null,
            model: source.model || null,
            material_guess: source.material_guess || null,
            warmth: source.warmth || null,
            formality: source.formality || null,
            size: source.size || null,
            season_tags: Array.isArray(source.season_tags) ? source.season_tags : [],
            fit_notes: source.fit_notes || null,
            source_image_path: imagePath,
            crop_image_path: imagePath,
            source: 'duplicated',
            enrichment_status: 'enriching',
            enrichment_confidence: 0,
            meta: { duplicatedFrom: sourceId }
        };

        this.db.addGarment(garment);
        const row = this.db.getGarment(newId);
        this._broadcast('wardrobe:garment:detected', row);

        // Background attribute pass. The hint tells the model brand/model/type
        // are ground truth — it should spend its effort on color/pattern here.
        const hintParts = [];
        if (source.brand) hintParts.push(source.brand);
        if (source.model) hintParts.push(source.model);
        const typeBit = source.subtype ? `${source.type || 'item'} / ${source.subtype}` : (source.type || '');
        if (typeBit) hintParts.push(`(${typeBit})`);
        const hint = hintParts.length > 0
            ? `${hintParts.join(' ')} — same product as an existing wardrobe item in a different color. Brand, model, type, and material are already known; focus the analysis on detecting primary_color, secondary_colors, and pattern from this photo.`
            : null;

        // Inherited fields are ground truth; the attribute pass should only fill in
        // the re-detected color/pattern/secondary_colors. preserveFields makes this
        // contract enforceable instead of relying on the model to follow the hint.
        const preserveFields = [
            'type', 'subtype', 'brand', 'model', 'material_guess',
            'warmth', 'formality', 'season_tags'
        ];
        this._runAttributePass(newId, { hint, overwriteExisting: false, preserveFields }).catch(err => {
            console.error(`${TAG} attribute pass crashed | newId=${newId} | err=${err.message}`);
        });

        return row;
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
        // Skip when detection is the placeholder fallback — see ingestGarmentFromBase64.
        const allFallback = detections.every(d => this._isFallbackDetection(d));
        let matchPlan = null;
        if (!allFallback && this.agent.client && shortlist.length > 0) {
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
                    detectionRaw: this._detectionForPersist(det),
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

        // Read shortlist images for the Pro call. Prefer the clean generated
        // catalog shot when available — it's a much better visual match signal
        // than the cluttered original crop.
        const shortlistParts = [];
        for (const g of shortlist) {
            const p = this._imageForGarment(g);
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
    async recommendOutfit({ garmentIds = null, tripId = null, context = '', count = 4, render = true } = {}) {
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

        const profileSummary = this._formatProfileForPrompt();

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

${profileSummary}
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

        const saved = this._saveProposals(cleaned, context);
        if (render && saved.proposals.length > 0) {
            await this._renderProposals(saved.proposals);
        }
        return saved;
    }

    /**
     * Render every saved proposal into a virtual-mirror image, in parallel.
     * If the user has no reference selfie, skips entirely (the daily job will
     * still send a text-only WhatsApp message).
     * Per-proposal failures are logged and swallowed so one bad render does
     * not nuke the whole batch.
     */
    async _renderProposals(proposalsRefs) {
        const profile = this.db.getUserProfile();
        if (!profile?.reference_image_path || !fs.existsSync(profile.reference_image_path)) {
            return;
        }
        await Promise.all(proposalsRefs.map(async (p) => {
            try {
                await this.visualizeOutfit({
                    garmentIdsPanels: p.outfit.garment_ids,
                    outfitId: p.outfit.id,
                    saveAs: 'render'
                });
                const refreshed = this.db.getOutfit(p.outfit.id);
                if (refreshed) p.outfit = refreshed;
            } catch (e) {
                console.warn(`[WardrobeService] proposal render failed for ${p.outfit.id}: ${e.message}`);
            }
        }));
    }

    // Turn internal bucket labels ("weather_anchored") into something that
    // reads naturally next to the date prefix in an outfit title.
    _prettyBucket(bucket) {
        const map = {
            weather_anchored: 'weather',
            occasion_anchored: 'occasion',
            safe_repeat: 'safe repeat',
            experimental: 'bolder pick'
        };
        return map[bucket] || (bucket || 'outfit').replace(/_/g, ' ');
    }

    _saveProposals(proposals, context) {
        const saved = [];
        const wantsAll = [];
        // Human-readable creation date like "Apr 23" gives the outfits list a
        // chronological spine — the raw bucket names ("weather_anchored") all
        // look the same when scanning back through a week of suggestions.
        const datePart = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        for (const p of proposals) {
            const id = this.db.addOutfit({
                name: `${datePart} · ${this._prettyBucket(p.bucket)}`,
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
     * @param {'render'|'variations'} [opts.saveAs] - Which slot to save under.
     *   'render' (default) writes render.jpg + rendered_image_path.
     *   'variations' writes variations.jpg + variations_image_path (for the
     *    multi-panel "Generate variations" feature — keeps the original
     *    single-panel render intact).
     */
    async visualizeOutfit({ garmentIdsPanels, layout = 'auto', outfitId = null, saveAs = 'render' } = {}) {
        if (saveAs === 'variations' && !outfitId) {
            throw new Error('visualizeOutfit with saveAs="variations" requires outfitId');
        }
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
                // Prefer the clean generated catalog shot — it's a much cleaner
                // reference for the virtual-mirror render than the original
                // photo (which may have folds, hands, background clutter).
                const cp = this._imageForGarment(g);
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

        // Fitting-room backdrop gives the render a "I'm actually trying this on"
        // feel vs. the old studio-neutral look, which the user felt was flat.
        const FITTING_ROOM_BACKDROP = `Fitting-room setting: warm boutique lighting, a full-length mirror visible in the background, a light natural wood floor, subtle fabric or curtain detail on one side. Clean but textured — not a sterile studio.`;

        let prompt;
        if (N === 1) {
            prompt = `Generate a realistic mirror photo of the person shown in the reference image, wearing exactly the clothing items pictured in the subsequent reference crops.
- Full-body standing mirror-selfie framing
- ${FITTING_ROOM_BACKDROP}
- Preserve the person's face, build, and proportions faithfully
- Garments must match color, pattern, fit, and visible detailing of the crops
- No text overlays, no watermarks
Outfit: ${panelDescriptors[0].garments.join(', ')}`;
        } else {
            prompt = `Generate a single wide photo containing ${N} vertical mirror panels side-by-side.
Each panel shows the reference person in a different outfit, numbered left to right.
${panelDescriptors.map(d => `  Panel ${d.index}: ${d.garments.join(', ')}`).join('\n')}
- ${FITTING_ROOM_BACKDROP}
- Consistent lighting, pose, and mirror framing across panels
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
        const filename = saveAs === 'variations' ? 'variations.jpg' : 'render.jpg';
        const savePath = path.join(outDir, filename);
        const renderBuffer = Buffer.from(imagePart.inlineData.data, 'base64');

        // Post-process: overlay a caption listing the garments so the image is
        // self-describing (useful when shared on WhatsApp where the caption isn't
        // attached to the photo in a forward). Caption text is drawn
        // programmatically rather than asked of the image model — the model tends
        // to garble or stylize text instead of rendering it cleanly.
        const captionLines = N === 1
            ? this._captionFromPanel(panelDescriptors[0])
            : panelDescriptors.map(d => `${d.index}. ${d.garments.slice(0, 3).join(', ')}`);
        try {
            const captioned = await this._addCaptionToImage(renderBuffer, captionLines);
            fs.writeFileSync(savePath, captioned);
        } catch (captionErr) {
            console.warn(`[wardrobe.visualize] caption overlay failed, falling back to raw render | err=${captionErr.message}`);
            fs.writeFileSync(savePath, renderBuffer);
        }

        const updateField = saveAs === 'variations' ? 'variations_image_path' : 'rendered_image_path';
        this.db.updateOutfit(targetOutfitId, { [updateField]: savePath });
        const outfit = this.db.getOutfit(targetOutfitId);
        const eventName = saveAs === 'variations' ? 'wardrobe:outfit:variations-rendered' : 'wardrobe:outfit:rendered';
        this._broadcast(eventName, outfit);

        return { outfit, panels: N, layout: resolvedLayout };
    }

    /**
     * Generate N variation outfits off a source, render them all side-by-side
     * in one multi-panel mirror image, and store under variations_image_path.
     *
     * Variations share 2+ items with the source (so they feel like "small
     * swaps, same vibe"). The LLM picks the swaps from the user's wardrobe;
     * a deterministic fallback swaps one same-type item if the LLM is
     * unavailable or returns nothing usable.
     */
    async generateOutfitVariations(outfitId, { count = 3 } = {}) {
        const TAG = '[wardrobe.variations]';
        const source = this.db.getOutfit(outfitId);
        if (!source) throw new Error(`Outfit ${outfitId} not found`);

        const sourceIds = Array.isArray(source.garment_ids) ? source.garment_ids : [];
        if (sourceIds.length < 2) {
            throw new Error('Source outfit needs at least 2 items to build variations');
        }

        const pool = this.db.getGarments({ limit: 500 }) || [];
        const poolById = Object.fromEntries(pool.map(g => [g.id, g]));
        // Drop panels we can't build (ids no longer in wardrobe) so the LLM
        // doesn't anchor on ghosts.
        const validSourceIds = sourceIds.filter(id => poolById[id]);
        if (validSourceIds.length < 2) {
            throw new Error('Source outfit has too few garments still in the wardrobe');
        }

        // Outfits don't have a meta column we can flip a flag on, so emit a
        // dedicated pending event before the slow LLM + render begins. The web
        // client uses this to show a spinner without holding a Server Action
        // transition open. We always emit a terminal event afterward
        // (variations-rendered on success, variations-failed on error) so the
        // client can clear the spinner reliably.
        this._broadcast('wardrobe:outfit:variations-pending', { id: outfitId });

        try {
            let variations = [];
            if (this.agent.client) {
                try {
                    variations = await this._proposeOutfitVariations(source, validSourceIds, pool, count);
                } catch (e) {
                    console.warn(`${TAG} LLM proposer failed, falling back | err=${e.message}`);
                }
            }
            if (variations.length === 0) {
                variations = this._fallbackOutfitVariations(validSourceIds, pool, count);
            }

            // Cap at 3 variations so the final strip stays at 4 panels (source + 3).
            variations = variations.slice(0, 3);

            if (variations.length === 0) {
                throw new Error('Could not build any variations — not enough alternatives in the wardrobe');
            }

            const panels = [validSourceIds, ...variations];
            console.log(`${TAG} rendering | outfitId=${outfitId} | panels=${panels.length}`);
            return await this.visualizeOutfit({
                garmentIdsPanels: panels,
                layout: panels.length === 4 ? 'grid' : 'horizontal',
                outfitId,
                saveAs: 'variations'
            });
        } catch (err) {
            this._broadcast('wardrobe:outfit:variations-failed', { id: outfitId, error: err.message });
            throw err;
        }
    }

    async _proposeOutfitVariations(source, validSourceIds, pool, count) {
        const g = (id) => pool.find(x => x.id === id);
        const describe = (garment) => {
            if (!garment) return '';
            const bits = [garment.type, garment.subtype, garment.primary_color, garment.brand].filter(Boolean);
            return bits.join(' ');
        };

        const sourceSummary = validSourceIds.map(id => {
            const row = g(id);
            return `- ${id}: ${describe(row)}${row?.formality ? ` [formality ${row.formality}/5]` : ''}`;
        }).join('\n');

        const poolSummary = pool
            .filter(row => !validSourceIds.includes(row.id))
            .slice(0, 80) // keep prompt tight
            .map(row => `- ${row.id}: ${describe(row)}${row.formality ? ` [formality ${row.formality}/5]` : ''}`)
            .join('\n');

        const prompt = `You are a personal stylist. Propose ${count} outfit variations off a source outfit.

SOURCE OUTFIT:
${sourceSummary}

AVAILABLE WARDROBE (other items, same user):
${poolSummary}

RULES:
- Each variation must be a complete outfit (top + bottom + shoes at minimum; outerwear optional).
- Each variation must share AT LEAST half of the source items (e.g. same shoes + same pants, change the top).
- Use ONLY garment ids that appear in the SOURCE or AVAILABLE lists above — never invent ids.
- Do NOT return the source outfit verbatim.
- Keep formality within ±1 of the source's average formality.

Return STRICT JSON:
{
  "variations": [
    { "garment_ids": ["id1","id2",...], "rationale": "same shoes + pants, swapped top for a pattern variation" }
  ]
}`;

        const modelName = this.config.getModel('FLASH');
        const response = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { responseMimeType: 'application/json' }
        });
        try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_variations'); } catch (e) { /* ignore */ }

        const text = this._extractText(response);
        if (!text) return [];
        let data;
        try {
            data = JSON.parse(String(text).replace(/```json|```/g, '').trim());
        } catch (e) {
            console.warn(`[wardrobe.variations] JSON parse failed | snippet="${String(text).slice(0, 200).replace(/\s+/g, ' ')}"`);
            return [];
        }

        const rawList = Array.isArray(data?.variations) ? data.variations : [];
        const validIds = new Set(pool.map(p => p.id));
        const source_serialized = JSON.stringify([...validSourceIds].sort());
        const seen = new Set([source_serialized]);
        // A variation needs to be a believable outfit — at least 3 items if the
        // source had 4+, else at least 2. Anything smaller is the model
        // hallucinating garment ids that got filtered out.
        const minItems = validSourceIds.length >= 4 ? 3 : 2;
        const out = [];
        for (const item of rawList) {
            const ids = Array.isArray(item?.garment_ids) ? item.garment_ids.filter(id => validIds.has(id)) : [];
            if (ids.length < minItems) continue;
            const serialized = JSON.stringify([...ids].sort());
            if (seen.has(serialized)) continue; // dedupe + skip exact source
            seen.add(serialized);
            out.push(ids);
            if (out.length >= count) break;
        }
        return out;
    }

    /**
     * Render the user's profile preferences as a compact block for the
     * proposer prompt. Kept ≤10 lines so it doesn't crowd out the garment
     * pool when the wardrobe is large. Returns '' if nothing is configured.
     */
    _formatProfileForPrompt() {
        let profile;
        try { profile = this.db.getUserProfile?.(); } catch { profile = null; }
        if (!profile) return '';
        const prefs = profile.style_preferences || {};
        const sizing = profile.sizing || {};
        const brands = Array.isArray(profile.preferred_brands) ? profile.preferred_brands : [];
        const lines = [];
        if (prefs.fit) lines.push(`  - preferred fit: ${prefs.fit}`);
        if (prefs.formality_bias) lines.push(`  - formality bias: ${prefs.formality_bias}`);
        if (Array.isArray(prefs.colors_loved) && prefs.colors_loved.length) {
            lines.push(`  - loves these colors: ${prefs.colors_loved.join(', ')}`);
        }
        if (Array.isArray(prefs.colors_avoided) && prefs.colors_avoided.length) {
            lines.push(`  - avoids these colors (do NOT feature as the dominant piece): ${prefs.colors_avoided.join(', ')}`);
        }
        if (brands.length) lines.push(`  - preferred brands: ${brands.join(', ')}`);
        const sizeEntries = Object.entries(sizing).filter(([, v]) => v && String(v).trim() !== '');
        if (sizeEntries.length) {
            lines.push(`  - sizing: ${sizeEntries.map(([k, v]) => `${k} ${v}`).join(', ')}`);
        }
        if (profile.style_notes && String(profile.style_notes).trim()) {
            lines.push(`  - free-form notes: ${String(profile.style_notes).trim()}`);
        }
        if (lines.length === 0) return '';
        return `User style profile (use as soft guidance, not hard filter):\n${lines.join('\n')}\n`;
    }

    /**
     * Generate N complete outfit proposals built around a specific pinned
     * garment. Each saved outfit includes the pinned garment; other pieces
     * come from the rest of the wardrobe. Used by the "Generate outfits with
     * this" button on a garment.
     */
    async generateOutfitsForGarment(garmentId, { count = 4 } = {}) {
        const TAG = '[wardrobe.outfitsForGarment]';
        const pinned = this.db.getGarment(garmentId);
        if (!pinned) throw new Error(`Garment ${garmentId} not found`);

        const pool = this.db.getGarments({ limit: 500 }) || [];
        const others = pool.filter(g => g.id !== garmentId);
        if (others.length < 1) {
            throw new Error('Need at least one other garment in the wardrobe to build outfits');
        }

        let proposals = [];
        if (this.agent.client) {
            try {
                proposals = await this._proposeOutfitsForGarment(pinned, others, count);
            } catch (e) {
                console.warn(`${TAG} LLM proposer failed, falling back | err=${e.message}`);
            }
        }
        if (proposals.length === 0) {
            proposals = this._fallbackOutfitsForGarment(pinned, others, count);
        }
        // Guarantee the pinned garment sits first in each outfit so it's
        // visually obvious which piece was anchored.
        proposals = proposals
            .slice(0, count)
            .map(ids => {
                const deduped = Array.from(new Set(ids));
                const withoutPinned = deduped.filter(id => id !== pinned.id);
                return [pinned.id, ...withoutPinned];
            })
            .filter(ids => ids.length >= 2);

        if (proposals.length === 0) {
            throw new Error('Could not build any outfits — not enough complementary pieces in the wardrobe');
        }

        const describe = (g) => [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean).join(' ');
        const pinnedLabel = describe(pinned) || 'item';
        const datePart = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const saved = [];
        proposals.forEach((ids, idx) => {
            const id = this.db.addOutfit({
                name: `${datePart} · with ${pinnedLabel} #${idx + 1}`,
                occasion: null,
                garment_ids: ids,
                weather_tags: [],
                liked: false
            });
            const outfit = this.db.getOutfit(id);
            saved.push({ outfit, bucket: 'item_anchored', rationale: `Built around ${pinnedLabel}`, wants: [] });
            if (this.agent.interface?.broadcast) {
                this.agent.interface.broadcast('wardrobe:outfit:create', outfit);
            }
        });

        console.log(`${TAG} created | garmentId=${garmentId} | count=${saved.length}`);
        return { proposals: saved, notes: '' };
    }

    async _proposeOutfitsForGarment(pinned, others, count) {
        const describe = (g) => [g.type, g.subtype, g.primary_color, g.brand].filter(Boolean).join(' ');
        const profileSummary = this._formatProfileForPrompt();
        const pinnedLine = `- ${pinned.id}: ${describe(pinned)}${pinned.formality ? ` [formality ${pinned.formality}/5]` : ''}`;
        const poolSummary = others
            .slice(0, 120)
            .map(g => `- ${g.id}: ${describe(g)}${g.formality ? ` [formality ${g.formality}/5]` : ''}`)
            .join('\n');

        const prompt = `You are a personal stylist. Build ${count} distinct complete outfits, each anchored around a specific PINNED garment.

${profileSummary}PINNED GARMENT (must appear in every outfit):
${pinnedLine}

OTHER WARDROBE ITEMS:
${poolSummary}

RULES:
- Every outfit MUST include the pinned garment id (${pinned.id}).
- Each outfit must be complete: top + bottom + shoes at minimum; outerwear optional.
- Use ONLY ids listed above (pinned or other). Never invent ids.
- Make the ${count} outfits meaningfully different (e.g. vary formality, weather, or color story).
- Keep each outfit's formality self-consistent (±1 across pieces).

Return STRICT JSON:
{
  "outfits": [
    { "garment_ids": ["${pinned.id}", "otherId1", "otherId2", ...], "rationale": "short sentence citing specific pieces" }
  ]
}`;

        const modelName = this.config.getModel('FLASH');
        const response = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { responseMimeType: 'application/json' }
        });
        try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_outfits_for_garment'); } catch (e) { /* ignore */ }

        const text = this._extractText(response);
        if (!text) return [];
        let data;
        try {
            data = JSON.parse(String(text).replace(/```json|```/g, '').trim());
        } catch (e) {
            console.warn(`[wardrobe.outfitsForGarment] JSON parse failed | snippet="${String(text).slice(0, 200).replace(/\s+/g, ' ')}"`);
            return [];
        }

        const rawList = Array.isArray(data?.outfits) ? data.outfits : [];
        const validIds = new Set([pinned.id, ...others.map(o => o.id)]);
        const seen = new Set();
        const out = [];
        for (const item of rawList) {
            const ids = Array.isArray(item?.garment_ids) ? item.garment_ids.filter(id => validIds.has(id)) : [];
            if (!ids.includes(pinned.id)) continue;
            if (ids.length < 2) continue;
            const serialized = JSON.stringify([...ids].sort());
            if (seen.has(serialized)) continue;
            seen.add(serialized);
            out.push(ids);
            if (out.length >= count) break;
        }
        return out;
    }

    /**
     * Deterministic fallback: pair the pinned garment with one piece per
     * missing slot (top/bottom/shoes/outerwear) — vary one slot across
     * outfits so they don't all look identical.
     */
    _fallbackOutfitsForGarment(pinned, others, count) {
        const byType = (type) => others.filter(g => g.type === type);
        const pinnedType = pinned.type;
        const slots = ['top', 'bottom', 'shoes'].filter(t => t !== pinnedType);
        const outfits = [];
        const seen = new Set();

        const base = {};
        for (const slot of slots) {
            const picks = byType(slot);
            if (picks.length === 0) return [];
            base[slot] = picks[0].id;
        }

        // Vary whichever non-pinned slot has the most alternatives.
        const varySlot = slots
            .map(s => ({ slot: s, alts: byType(s) }))
            .sort((a, b) => b.alts.length - a.alts.length)[0];

        for (const alt of varySlot.alts.slice(0, count)) {
            const ids = [pinned.id, ...slots.map(s => s === varySlot.slot ? alt.id : base[s])];
            const serialized = JSON.stringify([...ids].sort());
            if (seen.has(serialized)) continue;
            seen.add(serialized);
            outfits.push(ids);
        }
        return outfits;
    }

    _fallbackOutfitVariations(sourceIds, pool, count) {
        // Build variations by swapping ONE garment per variation for a same-type
        // alternative from the wardrobe. Simple, deterministic, and good enough
        // when the LLM call can't run (tests, offline, quota exhausted).
        const byId = Object.fromEntries(pool.map(g => [g.id, g]));
        const sourceSet = new Set(sourceIds);
        const variations = [];
        const usedSerializations = new Set([JSON.stringify([...sourceIds].sort())]);

        for (let swapIdx = 0; swapIdx < sourceIds.length && variations.length < count; swapIdx++) {
            const original = byId[sourceIds[swapIdx]];
            if (!original?.type) continue;
            const alternatives = pool.filter(p => p.type === original.type && !sourceSet.has(p.id));
            for (const alt of alternatives) {
                const varIds = [...sourceIds];
                varIds[swapIdx] = alt.id;
                const serialized = JSON.stringify([...varIds].sort());
                if (usedSerializations.has(serialized)) continue;
                usedSerializations.add(serialized);
                variations.push(varIds);
                if (variations.length >= count) break;
            }
        }
        return variations;
    }

    /**
     * Produce a short caption describing the garments in a single-outfit panel.
     * Returns an array of ≤2 lines so the overlay stays compact.
     */
    _captionFromPanel(panel) {
        const garments = panel.garments || [];
        const joined = garments.join(' · ');
        if (joined.length <= 60) return [joined];
        // Split across two lines on a separator boundary.
        const half = Math.ceil(garments.length / 2);
        const line1 = garments.slice(0, half).join(' · ');
        const line2 = garments.slice(half).join(' · ');
        return [line1, line2];
    }

    /**
     * Overlay a dark translucent strip + white caption text on the bottom of
     * an image buffer. Uses Jimp (already a wardrobe dep for cropping).
     */
    async _addCaptionToImage(imageBuffer, lines) {
        // Skip overlay for obviously-non-image buffers (e.g. test stubs). Jimp's
        // font/image loaders don't throw here — they trip a V8 assertion when the
        // mock module graph in Jest holds a non-string argument, crashing the
        // whole process. Guarding on size keeps the prod path untouched.
        if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 1024) {
            throw new Error('caption overlay skipped — buffer too small to be a real image');
        }
        const Jimp = require('jimp');
        const image = await Jimp.read(imageBuffer);
        const W = image.bitmap.width;
        const H = image.bitmap.height;
        const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
        const padding = 14;
        const lineHeight = 22;
        const effectiveLines = lines.slice(0, 3);
        const stripHeight = padding * 2 + lineHeight * effectiveLines.length;
        const stripY = H - stripHeight;
        // Semi-transparent dark strip: 70% black.
        const strip = new Jimp(W, stripHeight, 0x000000B2);
        image.composite(strip, 0, stripY);
        for (let i = 0; i < effectiveLines.length; i++) {
            image.print(
                font,
                padding,
                stripY + padding + i * lineHeight,
                { text: effectiveLines[i], alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT, alignmentY: Jimp.VERTICAL_ALIGN_TOP },
                W - padding * 2,
                lineHeight
            );
        }
        return image.quality(90).getBufferAsync(Jimp.MIME_JPEG);
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

    /**
     * Materialize one Outfit entity per day in the trip's daily_plan and render
     * a virtual-mirror image for each. The outfit_id is written back onto
     * weather_snapshot.daily_plan[i] so the UI can look up the render.
     *
     * Idempotent by default: days that already have a rendered_image_path are
     * skipped. Pass { force: true } to re-render everything.
     */
    async renderTripDailyOutfits(tripId, { force = false } = {}) {
        const trip = this.db.getTrip(tripId);
        if (!trip) throw new Error(`Trip ${tripId} not found`);
        const snapshot = trip.weather_snapshot || {};
        const daily = Array.isArray(snapshot.daily_plan) ? snapshot.daily_plan : [];
        if (daily.length === 0) {
            return { trip, rendered: 0, skipped: 0, needs_reference: false };
        }

        const profile = this.db.getUserProfile();
        if (!profile?.reference_image_path || !fs.existsSync(profile.reference_image_path)) {
            return { trip, rendered: 0, skipped: 0, needs_reference: true };
        }

        const label = `trip:${tripId}`;
        const updatedDaily = [];
        let rendered = 0;
        let skipped = 0;
        for (const day of daily) {
            const entry = { ...day };
            const garmentIds = Array.isArray(day.garment_ids) ? day.garment_ids : [];
            if (garmentIds.length === 0) {
                updatedDaily.push(entry);
                continue;
            }

            let outfitId = day.outfit_id || null;
            if (outfitId && !this.db.getOutfit(outfitId)) outfitId = null;

            if (!outfitId) {
                const dateLabel = this._formatDailyOutfitDate(day.date);
                outfitId = this.db.addOutfit({
                    name: `${dateLabel} · ${trip.destination || 'Trip'}`,
                    occasion: trip.destination || null,
                    garment_ids: garmentIds,
                    labels: [label],
                    liked: false
                });
            } else {
                const existing = this.db.getOutfit(outfitId);
                const sameIds = Array.isArray(existing?.garment_ids)
                    && existing.garment_ids.length === garmentIds.length
                    && existing.garment_ids.every((id, i) => id === garmentIds[i]);
                if (!sameIds) this.db.updateOutfit(outfitId, { garment_ids: garmentIds });
            }

            const outfit = this.db.getOutfit(outfitId);
            const hasRender = outfit?.rendered_image_path && fs.existsSync(outfit.rendered_image_path);
            if (force || !hasRender) {
                try {
                    await this.visualizeOutfit({
                        garmentIdsPanels: garmentIds,
                        outfitId,
                        saveAs: 'render'
                    });
                    rendered += 1;
                } catch (e) {
                    console.warn(`[WardrobeService] renderTripDailyOutfits: visualize failed for ${day.date}: ${e.message}`);
                }
            } else {
                skipped += 1;
            }

            entry.outfit_id = outfitId;
            updatedDaily.push(entry);
        }

        this.db.updateTrip(tripId, {
            weather_snapshot: { ...snapshot, daily_plan: updatedDaily }
        });
        const refreshed = this.db.getTrip(tripId);
        this._broadcast('wardrobe:trip:update', refreshed);
        return { trip: refreshed, rendered, skipped, needs_reference: false };
    }

    _formatDailyOutfitDate(dateStr) {
        if (!dateStr) return new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const d = new Date(`${dateStr}T00:00:00`);
        if (Number.isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

    /**
     * Generate a reference photo for a wanted shopping item using the stored
     * description + type + color + pattern. Handy when the user is about to go
     * buy the item and wants a visual they can show or match against in-store.
     */
    async generateShoppingReferenceImage(shoppingId) {
        const TAG = '[wardrobe.shopref]';
        const item = this.db.getShoppingItem(shoppingId);
        if (!item) throw new Error(`Shopping item ${shoppingId} not found`);
        if (!this.agent.client) throw new Error('Gemini client not initialized');

        const descriptorBits = [
            item.primary_color,
            item.pattern && item.pattern !== 'solid' ? item.pattern : null,
            item.material_hint,
            item.type,
            item.description
        ].filter(Boolean);
        const descriptor = descriptorBits.join(' ');

        const prompt = `Generate a clean product-catalog photo of: ${descriptor}.

COMPOSITION:
- Plain off-white background (#F4F2EE), no gradient, no shadows beyond a soft contact shadow
- Square 1:1 aspect ratio, item fills 70-85% of the frame, centered
- Soft diffuse studio lighting, no harsh highlights, no colored tints
- No human model, no mannequin, no hanger, no clutter, no props
- Studio e-commerce aesthetic (Nike / SSENSE / MR PORTER product page)
- No text overlays, no watermarks, no borders`;

        const modelName = this.config.getModel('IMAGE');
        const startedAt = Date.now();
        console.log(`${TAG} start | shoppingId=${shoppingId} | descriptor="${descriptor}"`);

        const response = await this.agent.client.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { responseModalities: ['TEXT', 'IMAGE'] }
        });
        try { this.config.logUsageFromResponse(this.db, modelName, response, null, 'wardrobe_shopping_ref'); } catch (e) { /* ignore */ }

        const respParts = response?.candidates?.[0]?.content?.parts || [];
        const imagePart = respParts.find(p => p?.inlineData?.mimeType?.startsWith?.('image/'));
        if (!imagePart) {
            const finishReason = response?.candidates?.[0]?.finishReason || 'unknown';
            console.error(`${TAG} no image returned | shoppingId=${shoppingId} | finishReason=${finishReason}`);
            throw new Error('No image returned from image model');
        }

        const outDir = path.join(this._baseDir(), 'shopping', shoppingId);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `reference_${Date.now()}.jpg`);
        fs.writeFileSync(outPath, Buffer.from(imagePart.inlineData.data, 'base64'));

        // Replace any prior reference so we don't leave cruft on disk.
        if (item.reference_image_path && item.reference_image_path !== outPath && fs.existsSync(item.reference_image_path)) {
            try { fs.unlinkSync(item.reference_image_path); } catch (e) { /* ignore */ }
        }

        this.db.updateShoppingItem(shoppingId, { reference_image_path: outPath });
        const updated = this.db.getShoppingItem(shoppingId);
        this._broadcast('wardrobe:shopping:update', updated);
        console.log(`${TAG} done | shoppingId=${shoppingId} | elapsedMs=${Date.now() - startedAt} | path=${outPath}`);
        return updated;
    }

    async likeOutfit(outfitId, liked = true) {
        if (!this.db.updateOutfit) return null;
        this.db.updateOutfit(outfitId, { liked });
        const out = this.db.getOutfit(outfitId);
        this._broadcast('wardrobe:outfit:update', out);
        return out;
    }

    async deleteOutfit(outfitId) {
        const out = this.db.getOutfit(outfitId);
        if (!out) return false;
        // Remove the render directory (and its contents) before dropping the row so a
        // retry stays idempotent even if the DB delete succeeds and the FS cleanup races.
        const outDir = path.join(this._baseDir(), 'outfits', outfitId);
        if (fs.existsSync(outDir)) {
            try {
                for (const entry of fs.readdirSync(outDir)) {
                    try { fs.unlinkSync(path.join(outDir, entry)); } catch (e) { /* ignore */ }
                }
                fs.rmdirSync(outDir);
            } catch (e) {
                console.warn(`[wardrobe] outfit render cleanup failed | outfitId=${outfitId} | err=${e.message}`);
            }
        }
        this.db.deleteOutfit(outfitId);
        this._broadcast('wardrobe:outfit:delete', { id: outfitId });
        return true;
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
