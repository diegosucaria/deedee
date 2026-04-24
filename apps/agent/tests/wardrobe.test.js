const { WardrobeService } = require('../src/services/wardrobe-service');
const { WardrobeExecutor } = require('../src/executors/wardrobe');
const fs = require('fs');

const mockAgent = {
    db: {
        addGarment: jest.fn().mockReturnValue('garment_123'),
        getGarment: jest.fn(),
        getGarments: jest.fn().mockReturnValue([]),
        updateGarment: jest.fn().mockReturnValue(true),
        deleteGarment: jest.fn().mockReturnValue(true),
        searchGarments: jest.fn().mockReturnValue([]),
        getUserProfile: jest.fn().mockReturnValue({ id: 1, preferred_brands: ['Lacoste', 'Lululemon'] }),
        updateUserProfile: jest.fn().mockReturnValue(true),
        logTokenUsage: jest.fn()
    },
    interface: { broadcast: jest.fn() },
    client: {
        models: {
            generateContent: jest.fn()
        }
    }
};

function mockDetectResponse(items) {
    return {
        text: () => JSON.stringify({ items, scene_notes: '' }),
        candidates: [{ content: { parts: [{ text: JSON.stringify({ items, scene_notes: '' }) }] } }]
    };
}

function mockAttrResponse(attrs) {
    return {
        text: () => JSON.stringify(attrs),
        candidates: [{ content: { parts: [{ text: JSON.stringify(attrs) }] } }]
    };
}

describe('WardrobeService detection + bbox normalization', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
    });

    test('_normalizeBbox converts Gemini [ymin,xmin,ymax,xmax] (0-1) to [x1,y1,x2,y2]', () => {
        // Input is ymin=0.2, xmin=0.1, ymax=0.9, xmax=0.8
        // Output should be x1=0.1, y1=0.2, x2=0.8, y2=0.9
        expect(service._normalizeBbox([0.2, 0.1, 0.9, 0.8])).toEqual([0.1, 0.2, 0.8, 0.9]);
    });

    test('_normalizeBbox converts Gemini [ymin,xmin,ymax,xmax] (0-1000) to [x1,y1,x2,y2] (0-1)', () => {
        // Input: ymin=200, xmin=100, ymax=900, xmax=800 (Gemini native)
        const r = service._normalizeBbox([200, 100, 900, 800]);
        expect(r[0]).toBeCloseTo(0.1, 5); // x1
        expect(r[1]).toBeCloseTo(0.2, 5); // y1
        expect(r[2]).toBeCloseTo(0.8, 5); // x2
        expect(r[3]).toBeCloseTo(0.9, 5); // y2
    });

    test('_normalizeBbox swaps reversed coords and clamps', () => {
        // Swapped: ymax first instead of ymin, etc. Result is still ordered x1<x2, y1<y2
        expect(service._normalizeBbox([0.9, 0.8, 0.2, 0.1])).toEqual([0.1, 0.2, 0.8, 0.9]);
        expect(service._normalizeBbox([-0.1, -0.1, 1.5, 1.5])).toEqual([0, 0, 1, 1]);
    });

    test('_normalizeBbox rejects malformed input', () => {
        expect(service._normalizeBbox(null)).toEqual([0, 0, 1, 1]);
        expect(service._normalizeBbox([1, 2, 3])).toEqual([0, 0, 1, 1]);
        expect(service._normalizeBbox(['a', 'b', 'c', 'd'])).toEqual([0, 0, 1, 1]);
    });

    test('_imageForGarment prefers generated → crop → source', () => {
        expect(service._imageForGarment(null)).toBeNull();
        expect(service._imageForGarment({})).toBeNull();
        expect(service._imageForGarment({ source_image_path: '/s.jpg' })).toBe('/s.jpg');
        expect(service._imageForGarment({ crop_image_path: '/c.jpg', source_image_path: '/s.jpg' })).toBe('/c.jpg');
        expect(service._imageForGarment({
            generated_image_path: '/g.jpg',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg'
        })).toBe('/g.jpg');
    });

    test('_detectItems falls back when client missing', async () => {
        const agentNoClient = { ...mockAgent, client: null };
        const s = new WardrobeService(agentNoClient);
        const r = await s._detectItems('AAAA');
        expect(r).toHaveLength(1);
        expect(r[0].bbox).toEqual([0, 0, 1, 1]);
    });

    test('_detectItems parses multi-item response and normalizes attrs', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockDetectResponse([
            { bbox: [0.1, 0.1, 0.4, 0.5], type: 'top', subtype: 'tshirt', primary_color: 'white', warmth: 2, formality: 3, detection_confidence: 0.9 },
            { bbox: [0.5, 0.5, 0.9, 0.95], type: 'shoes', primary_color: 'white', warmth: 10, detection_confidence: 0.8 }
        ]));
        const r = await service._detectItems('AAAA');
        expect(r).toHaveLength(2);
        expect(r[0].type).toBe('top');
        expect(r[0].warmth).toBe(2);
        expect(r[1].warmth).toBe(5); // clamped from 10
    });

    test('_detectItems falls back on API error', async () => {
        mockAgent.client.models.generateContent.mockRejectedValueOnce(new Error('boom'));
        const r = await service._detectItems('AAAA');
        expect(r).toHaveLength(1);
        expect(r[0].bbox).toEqual([0, 0, 1, 1]);
    });

    test('_detectItems prompt explicitly excludes phones, hands, mirrors and furniture', async () => {
        // Both pass-1 and pass-2 (the retry) will fire because pass-1 returns zero items.
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce(mockDetectResponse([]))
            .mockResolvedValueOnce(mockDetectResponse([]));
        await service._detectItems('AAAA');
        const promptText = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(promptText).toMatch(/phone/i);
        expect(promptText).toMatch(/hand/i);
        expect(promptText).toMatch(/mirror/i);
        expect(promptText).toMatch(/wearable accessory/);
    });

    test('_detectItems first-pass prompt covers both real-world photos and screenshots', async () => {
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce(mockDetectResponse([]))
            .mockResolvedValueOnce(mockDetectResponse([]));
        await service._detectItems('AAAA');
        const promptText = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        // Default prompt must cover both scenarios so the model doesn't bail on screenshots
        expect(promptText).toMatch(/real-world photo/i);
        expect(promptText).toMatch(/screenshot/i);
        expect(promptText).toMatch(/wardrobe inventory/i);
        expect(promptText).toMatch(/product card/i);
    });

    test('_detectItems retries with screenshot-explicit prompt when first pass returns zero items', async () => {
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce(mockDetectResponse([]))
            .mockResolvedValueOnce(mockDetectResponse([
                { box_2d: [50, 50, 500, 500], type: 'top', subtype: 'polo', primary_color: 'orange', distinguishing_features: 'Lululemon ShowZero Polo' }
            ]));

        const r = await service._detectItems('AAAA');

        expect(mockAgent.client.models.generateContent).toHaveBeenCalledTimes(2);
        // The retry prompt asserts the input IS a screenshot
        const retryPrompt = mockAgent.client.models.generateContent.mock.calls[1][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(retryPrompt).toMatch(/THE INPUT IMAGE IS A SCREENSHOT/);
        expect(retryPrompt).toMatch(/SCREENSHOT EXTRACTION RULES/);
        // And recovered items are returned (not the fallback)
        expect(r).toHaveLength(1);
        expect(r[0].type).toBe('top');
        expect(r[0]._fallback).toBeUndefined();
    });

    test('_detectItems falls back when both passes return zero items, and the second pass uses screenshot-mode prompt', async () => {
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce(mockDetectResponse([]))
            .mockResolvedValueOnce(mockDetectResponse([]));

        const r = await service._detectItems('AAAA');

        expect(mockAgent.client.models.generateContent).toHaveBeenCalledTimes(2);
        // Confirm the retry actually used the screenshot-explicit prompt — a future
        // refactor that calls the wrong prompt on retry should fail this test.
        const retryPrompt = mockAgent.client.models.generateContent.mock.calls[1][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(retryPrompt).toMatch(/THE INPUT IMAGE IS A SCREENSHOT/);
        expect(retryPrompt).toMatch(/SCREENSHOT EXTRACTION RULES/);
        expect(r).toHaveLength(1);
        expect(r[0]._fallback).toBe(true);
    });

    test('_isFallbackDetection identifies the placeholder', () => {
        expect(service._isFallbackDetection({ _fallback: true })).toBe(true);
        expect(service._isFallbackDetection({ type: 'top' })).toBe(false);
        expect(service._isFallbackDetection(null)).toBe(false);
    });
});

describe('WardrobeService ingest + background refinement', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        mockAgent.db.getGarment.mockImplementation((id) => ({
            id,
            type: null,
            primary_color: null,
            source_image_path: '/data/wardrobe/garments/g/original.jpg',
            crop_image_path: '/data/wardrobe/garments/g/crop_0.jpg',
            enrichment_status: 'enriching',
            meta: {}
        }));
        service._cropToFile = jest.fn().mockResolvedValue('/out/crop.jpg');
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);
    });

    // The ingest flow creates a refresh-safe placeholder row BEFORE running
    // Gemini detection. Detection fills the placeholder in with the first
    // matching detection and adds extra rows for any additional detections.
    // These helpers let each test assert behavior against the combined effect
    // of addGarment + updateGarment calls.
    const collectPersistedGarments = () => {
        const placeholderCalls = mockAgent.db.addGarment.mock.calls;
        const updateCalls = mockAgent.db.updateGarment.mock.calls;
        const results = [];
        // Additional detections get their own addGarment call with full data.
        for (let i = 1; i < placeholderCalls.length; i++) {
            results.push(placeholderCalls[i][0]);
        }
        // The first detection rewrites the placeholder via updateGarment. The
        // update we care about is the one that introduces detection-derived fields.
        const enrichingUpdate = updateCalls.find(c => c[1]?.enrichment_status === 'enriching' && c[1]?.source === 'manual_upload');
        if (enrichingUpdate) results.unshift(enrichingUpdate[1]);
        return results;
    };

    test('opens a detecting placeholder before running detection (refresh-safe)', async () => {
        service._detectItems = jest.fn().mockImplementation(async () => {
            // By the time detection runs, the placeholder must already exist.
            expect(mockAgent.db.addGarment).toHaveBeenCalledWith(expect.objectContaining({
                enrichment_status: 'detecting'
            }));
            return [
                { bbox: [0.05, 0.05, 0.45, 0.45], type: 'top', subtype: 'tshirt', primary_color: 'white', secondary_colors: [], season_tags: [], detection_confidence: 0.9 }
            ];
        });
        mockAgent.db.addGarment.mockReturnValue('placeholder_id');

        await service.ingestGarmentFromBase64('AAAA', 'image/jpeg');

        // Placeholder broadcast uses wardrobe:garment:detected so the grid
        // shows a skeleton card immediately.
        const firstBroadcast = mockAgent.interface.broadcast.mock.calls[0];
        expect(firstBroadcast[0]).toBe('wardrobe:garment:detected');
    });

    test('multi-item ingest produces one persisted row per detection', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.05, 0.05, 0.45, 0.45], type: 'top', subtype: 'tshirt', primary_color: 'white', secondary_colors: [], season_tags: [], detection_confidence: 0.9 },
            { bbox: [0.55, 0.05, 0.95, 0.45], type: 'bottom', subtype: 'chinos', primary_color: 'khaki', secondary_colors: [], season_tags: [], detection_confidence: 0.85 },
            { bbox: [0.3, 0.5, 0.7, 0.95], type: 'shoes', primary_color: 'white', secondary_colors: [], season_tags: [], detection_confidence: 0.88 }
        ]);
        mockAgent.db.addGarment
            .mockReturnValueOnce('placeholder_id')
            .mockReturnValueOnce('g2')
            .mockReturnValueOnce('g3');

        const result = await service.ingestGarmentFromBase64('AAAA', 'image/jpeg');

        expect(service._cropToFile).toHaveBeenCalledTimes(3);
        const persisted = collectPersistedGarments();
        expect(persisted).toHaveLength(3);
        expect(persisted.map(p => p.type)).toEqual(['top', 'bottom', 'shoes']);
        expect(service._runAttributePass).toHaveBeenCalledTimes(3);
        expect(result.garments).toHaveLength(3);
        expect(result.matched_existing).toEqual([]);
    });

    test('full-frame bbox reuses source image without cropping', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0, 0, 1, 1], type: null, secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        await service.ingestGarmentFromBase64('AAAA');

        expect(service._cropToFile).not.toHaveBeenCalled();
        // Placeholder is created with crop_image_path = source_image_path.
        const placeholderArgs = mockAgent.db.addGarment.mock.calls[0][0];
        expect(placeholderArgs.crop_image_path).toBe(placeholderArgs.source_image_path);
    });

    test('crop failure does not abort ingestion; row still created using source image', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.5, 0.5], type: 'top', secondary_colors: [], season_tags: [] }
        ]);
        service._cropToFile = jest.fn().mockRejectedValue(new Error('sharp error'));
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        const result = await service.ingestGarmentFromBase64('AAAA');

        // The detection-apply update falls back to source path when cropping fails.
        const updateCalls = mockAgent.db.updateGarment.mock.calls;
        const detectionUpdate = updateCalls.find(c => c[1]?.enrichment_status === 'enriching');
        expect(detectionUpdate[1].crop_image_path).toBe(detectionUpdate[1].source_image_path);
        expect(result.garments).toHaveLength(1);
    });

    test('empty image input throws', async () => {
        await expect(service.ingestGarmentFromBase64('')).rejects.toThrow('Missing image data');
    });

    test('skips detections that match existing wardrobe items (no silent duplicates)', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.4, 0.4], type: 'top', primary_color: 'white', secondary_colors: [], season_tags: [] },
            { bbox: [0.5, 0.1, 0.9, 0.4], type: 'shoes', primary_color: 'black', secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'existing_top', type: 'top', primary_color: 'white', crop_image_path: '/x/top.jpg' }
        ]);
        service._matchDetectionsToWardrobe = jest.fn().mockResolvedValue([
            { match: 'existing_top' },
            { match: 'NEW' }
        ]);
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        const result = await service.ingestGarmentFromBase64('AAAA');

        // Placeholder becomes the 'shoes' detection; no additional addGarment calls.
        expect(mockAgent.db.addGarment).toHaveBeenCalledTimes(1);
        const detectionUpdate = mockAgent.db.updateGarment.mock.calls
            .find(c => c[1]?.enrichment_status === 'enriching');
        expect(detectionUpdate[1].type).toBe('shoes');
        expect(result.garments).toHaveLength(1);
        expect(result.matched_existing).toEqual(['existing_top']);
    });

    test('deletes placeholder when every detection matched an existing garment', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.4, 0.4], type: 'top', primary_color: 'white', secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'existing_top', type: 'top', primary_color: 'white', crop_image_path: '/x/top.jpg' }
        ]);
        service._matchDetectionsToWardrobe = jest.fn().mockResolvedValue([{ match: 'existing_top' }]);
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');
        mockAgent.db.deleteGarment = jest.fn().mockReturnValue(true);

        const result = await service.ingestGarmentFromBase64('AAAA');

        expect(mockAgent.db.deleteGarment).toHaveBeenCalledWith('placeholder_id');
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:garment:delete', { id: 'placeholder_id' });
        expect(result.garments).toHaveLength(0);
        expect(result.matched_existing).toEqual(['existing_top']);
    });

    test('does NOT match the fallback placeholder against existing wardrobe', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { ...WardrobeService.FALLBACK_DETECTION, secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'existing_top', type: 'top', crop_image_path: '/x/top.jpg' }
        ]);
        service._matchDetectionsToWardrobe = jest.fn();
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        const result = await service.ingestGarmentFromBase64('AAAA');

        expect(service._matchDetectionsToWardrobe).not.toHaveBeenCalled();
        expect(result.matched_existing).toEqual([]);
        expect(result.garments).toHaveLength(1);
    });

    test('_fallback sentinel does not leak into the persisted garment meta', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { ...WardrobeService.FALLBACK_DETECTION, secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        await service.ingestGarmentFromBase64('AAAA');

        // The detection-apply update carries the persisted meta; the internal
        // _fallback sentinel must be stripped before it ever touches the DB.
        const detectionUpdate = mockAgent.db.updateGarment.mock.calls
            .find(c => c[1]?.enrichment_status === 'enriching');
        expect(detectionUpdate[1].meta).not.toHaveProperty('_fallback');
        expect(detectionUpdate[1].meta.detectionRaw).not.toHaveProperty('_fallback');
    });

    test('detection failure leaves placeholder in complete state for manual editing', async () => {
        service._detectItems = jest.fn().mockRejectedValue(new Error('model offline'));
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        await expect(service.ingestGarmentFromBase64('AAAA')).rejects.toThrow('model offline');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('placeholder_id', { enrichment_status: 'complete' });
    });

    test('zero detections leaves placeholder for manual classification instead of abandoning upload', async () => {
        service._detectItems = jest.fn().mockResolvedValue([]);
        mockAgent.db.addGarment.mockReturnValueOnce('placeholder_id');

        const result = await service.ingestGarmentFromBase64('AAAA');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('placeholder_id', { enrichment_status: 'complete' });
        expect(result.garments).toHaveLength(1);
    });
});

describe('WardrobeService._runAttributePass', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            type: null,
            crop_image_path: '/data/wardrobe/garments/g1/crop_0.jpg',
            source_image_path: '/data/wardrobe/garments/g1/original.jpg',
            enrichment_status: 'enriching',
            enrichment_confidence: 0.7,
            meta: {}
        });
    });

    test('updates row with refined attrs and emits attributes event', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'top', subtype: 'polo', primary_color: 'navy',
            secondary_colors: [], pattern: 'solid', material_guess: 'cotton',
            warmth: 3, formality: 3, season_tags: ['spring', 'summer'],
            distinguishing_features: 'small crocodile logo on chest', confidence: 0.92
        }));

        await service._runAttributePass('g1');

        // First updateGarment call carries the attribute patch (status still 'enriching' until brand pass finalizes)
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', expect.objectContaining({
            type: 'top',
            subtype: 'polo',
            primary_color: 'navy',
            warmth: 3,
            formality: 3,
            enrichment_status: 'enriching',
            enrichment_confidence: 0.92
        }));
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:garment:attributes',
            expect.objectContaining({ id: 'g1' })
        );
        // Brand pass finalizes (mock garment has no distinguishingFeatures → completes directly)
        const updateCalls = mockAgent.db.updateGarment.mock.calls.filter(c => c[0] === 'g1');
        expect(updateCalls.at(-1)[1]).toEqual({ enrichment_status: 'complete' });
    });

    test('marks failed on API error', async () => {
        mockAgent.client.models.generateContent.mockRejectedValueOnce(new Error('rate limit'));

        await service._runAttributePass('g1');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', { enrichment_status: 'failed' });
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:garment:update',
            expect.objectContaining({ id: 'g1' })
        );
    });

    test('noop when garment missing', async () => {
        mockAgent.db.getGarment.mockReturnValue(null);
        await service._runAttributePass('nonexistent');
        expect(mockAgent.db.updateGarment).not.toHaveBeenCalled();
    });
});

describe('WardrobeService._enrichBrand (P3)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            type: 'top',
            subtype: 'polo',
            primary_color: 'navy',
            crop_image_path: '/data/wardrobe/garments/g1/crop_0.jpg',
            source_image_path: '/data/wardrobe/garments/g1/original.jpg',
            enrichment_status: 'enriching',
            enrichment_confidence: 0.8,
            meta: { distinguishingFeatures: 'small crocodile logo on chest, contrasting collar' }
        });
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, preferred_brands: ['Lacoste', 'Lululemon'] });
    });

    test('auto-accepts when confidence >= 0.95 AND visual identifier cited', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            brand: 'Lacoste',
            model: 'L.12.12',
            visual_identifier_cited: 'Lacoste crocodile logo on left chest',
            confidence: 0.97
        }));

        await service._enrichBrand('g1');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', expect.objectContaining({
            brand: 'Lacoste',
            model: 'L.12.12',
            enrichment_status: 'complete'
        }));
        const emittedEvents = mockAgent.interface.broadcast.mock.calls.map(c => c[0]);
        expect(emittedEvents).toContain('wardrobe:garment:enriched');
    });

    test('surfaces needs_brand_confirm when confidence below 0.95', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            brand: 'Lacoste',
            model: null,
            visual_identifier_cited: 'possibly a crocodile logo',
            confidence: 0.82
        }));

        await service._enrichBrand('g1');

        const call = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1');
        expect(call[1].enrichment_status).toBe('needs_brand_confirm');
        expect(call[1].meta.brandCandidate.brand).toBe('Lacoste');
        expect(call[1].meta.brandCandidate.confidence).toBe(0.82);
        expect(call[1].brand).toBeUndefined(); // not applied yet
    });

    test('surfaces needs_brand_confirm when visual identifier missing even at high confidence', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            brand: 'Lacoste',
            model: null,
            visual_identifier_cited: null,
            confidence: 0.98
        }));

        await service._enrichBrand('g1');

        const call = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1');
        expect(call[1].enrichment_status).toBe('needs_brand_confirm');
    });

    test('completes with no brand when API returns null', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            brand: null,
            model: null,
            visual_identifier_cited: null,
            confidence: 0
        }));

        await service._enrichBrand('g1');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', { enrichment_status: 'complete' });
    });

    test('skips brand call when no distinguishing features', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g2',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            enrichment_status: 'enriching',
            meta: {}
        });

        await service._enrichBrand('g2');

        expect(mockAgent.client.models.generateContent).not.toHaveBeenCalled();
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g2', { enrichment_status: 'complete' });
    });

    test('prompt includes user preferred brands as bias', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            brand: null, confidence: 0
        }));

        await service._enrichBrand('g1');

        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const promptText = callArgs.contents[0].parts.find(p => p.text)?.text || '';
        expect(promptText).toMatch(/Lacoste/);
        expect(promptText).toMatch(/Lululemon/);
    });

    test('graceful on brand search exception', async () => {
        mockAgent.client.models.generateContent.mockRejectedValueOnce(new Error('quota exceeded'));

        await service._enrichBrand('g1');

        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', { enrichment_status: 'complete' });
    });
});

describe('WardrobeService.confirmBrand (P3)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
    });

    test('accept applies candidate brand/model and clears candidate', async () => {
        mockAgent.db.getGarment
            .mockReturnValueOnce({
                id: 'g1',
                enrichment_status: 'needs_brand_confirm',
                meta: { brandCandidate: { brand: 'Lululemon', model: 'ABC Jogger', confidence: 0.9, visualIdentifier: 'omega logo on thigh' } }
            })
            .mockReturnValue({
                id: 'g1',
                brand: 'Lululemon',
                model: 'ABC Jogger',
                enrichment_status: 'complete',
                meta: { brandCandidate: null, brandUserConfirmed: true }
            });

        await service.confirmBrand('g1', true);

        const call = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1');
        expect(call[1].brand).toBe('Lululemon');
        expect(call[1].model).toBe('ABC Jogger');
        expect(call[1].enrichment_status).toBe('complete');
        expect(call[1].meta.brandCandidate).toBeNull();
        expect(call[1].meta.brandUserConfirmed).toBe(true);
    });

    test('reject clears candidate without applying brand', async () => {
        mockAgent.db.getGarment
            .mockReturnValueOnce({
                id: 'g1',
                enrichment_status: 'needs_brand_confirm',
                meta: { brandCandidate: { brand: 'Lacoste', confidence: 0.7 } }
            })
            .mockReturnValue({ id: 'g1', enrichment_status: 'complete', meta: { brandCandidate: null } });

        await service.confirmBrand('g1', false);

        const call = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1');
        expect(call[1].brand).toBeUndefined();
        expect(call[1].enrichment_status).toBe('complete');
        expect(call[1].meta.brandCandidate).toBeNull();
        expect(call[1].meta.brandUserConfirmed).toBe(false);
    });

    test('throws for missing garment', async () => {
        mockAgent.db.getGarment.mockReturnValue(null);
        await expect(service.confirmBrand('bad_id', true)).rejects.toThrow('not found');
    });
});

describe('WardrobeService.mergeGarments', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.getOutfits = jest.fn().mockReturnValue([]);
        mockAgent.db.updateOutfit = jest.fn().mockReturnValue(true);
        mockAgent.db.getTrips = jest.fn().mockReturnValue([]);
        mockAgent.db.updateTrip = jest.fn().mockReturnValue(true);
        mockAgent.db.listShoppingItems = jest.fn().mockReturnValue([]);
        mockAgent.db.updateShoppingItem = jest.fn().mockReturnValue(true);
        mockAgent.db.deleteGarment = jest.fn().mockReturnValue(true);
    });

    const garmentRow = (overrides = {}) => ({
        id: overrides.id,
        type: null, subtype: null, primary_color: null, pattern: null,
        material_guess: null, brand: null, model: null, size: null,
        fit_notes: null, warmth: null, formality: null, season_tags: [],
        times_worn: 0, last_worn_at: null,
        crop_image_path: '/x.jpg', source_image_path: '/x.jpg',
        meta: {},
        ...overrides
    });

    test('throws when no duplicate ids supplied', async () => {
        mockAgent.db.getGarment.mockReturnValue(garmentRow({ id: 'p1' }));
        await expect(service.mergeGarments('p1', [])).rejects.toThrow('at least one duplicate');
        await expect(service.mergeGarments('p1', null)).rejects.toThrow('at least one duplicate');
    });

    test('throws when primary or any duplicate is missing', async () => {
        mockAgent.db.getGarment.mockImplementation(id => id === 'p1' ? garmentRow({ id: 'p1' }) : null);
        await expect(service.mergeGarments('p1', ['ghost'])).rejects.toThrow('Duplicate garment ghost not found');

        mockAgent.db.getGarment.mockReturnValue(null);
        await expect(service.mergeGarments('missing_primary', ['d1'])).rejects.toThrow('Primary garment missing_primary not found');
    });

    test('only fills primary blanks — never overwrites existing primary fields', async () => {
        const primary = garmentRow({
            id: 'p1', type: 'top', subtype: 'tshirt', brand: 'CorrectBrand'
        });
        const dup = garmentRow({
            id: 'd1', type: 'bottom', subtype: 'wrong', primary_color: 'blue', brand: 'WrongBrand', model: 'NewModel'
        });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup }[id]));

        await service.mergeGarments('p1', ['d1']);

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'p1')[1];
        // Primary's existing values are preserved
        expect(patch.type).toBeUndefined();
        expect(patch.subtype).toBeUndefined();
        expect(patch.brand).toBeUndefined();
        // Primary's blanks are filled from the duplicate
        expect(patch.primary_color).toBe('blue');
        expect(patch.model).toBe('NewModel');
    });

    test('sums times_worn and takes the most recent last_worn_at', async () => {
        const primary = garmentRow({ id: 'p1', times_worn: 3, last_worn_at: '2026-01-01T00:00:00Z' });
        const dup1 = garmentRow({ id: 'd1', times_worn: 5, last_worn_at: '2026-04-22T00:00:00Z' });
        const dup2 = garmentRow({ id: 'd2', times_worn: 2, last_worn_at: '2026-02-15T00:00:00Z' });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup1, d2: dup2 }[id]));

        await service.mergeGarments('p1', ['d1', 'd2']);

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'p1')[1];
        expect(patch.times_worn).toBe(10);
        expect(patch.last_worn_at).toBe('2026-04-22T00:00:00Z');
    });

    test('unions season_tags across all rows without duplicates', async () => {
        const primary = garmentRow({ id: 'p1', season_tags: ['spring', 'summer'] });
        const dup = garmentRow({ id: 'd1', season_tags: ['summer', 'fall'] });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup }[id]));

        await service.mergeGarments('p1', ['d1']);

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'p1')[1];
        expect(patch.season_tags.sort()).toEqual(['fall', 'spring', 'summer']);
    });

    test('repoints outfits, trip capsules and shopping resolutions onto the primary', async () => {
        const primary = garmentRow({ id: 'p1' });
        const dup = garmentRow({ id: 'd1' });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup }[id]));
        mockAgent.db.getOutfits.mockReturnValue([
            { id: 'o1', garment_ids: ['d1', 'g_other'] },
            { id: 'o2', garment_ids: ['p1', 'd1'] }, // already has primary, dedup
            { id: 'o3', garment_ids: ['g_unrelated'] }
        ]);
        mockAgent.db.getTrips.mockReturnValue([
            { id: 't1', planned_capsule: ['d1', 'p1'], actual_capsule: ['d1', 'g_other'] },
            { id: 't2', planned_capsule: ['g_other'], actual_capsule: [] }
        ]);
        mockAgent.db.listShoppingItems.mockReturnValue([
            { id: 's1', resolved_garment_id: 'd1' },
            { id: 's2', resolved_garment_id: 'unrelated' }
        ]);

        await service.mergeGarments('p1', ['d1']);

        // Outfits: o1 swaps, o2 dedupes, o3 untouched
        expect(mockAgent.db.updateOutfit).toHaveBeenCalledWith('o1', { garment_ids: ['p1', 'g_other'] });
        expect(mockAgent.db.updateOutfit).toHaveBeenCalledWith('o2', { garment_ids: ['p1'] });
        expect(mockAgent.db.updateOutfit).not.toHaveBeenCalledWith('o3', expect.anything());

        // Trips: t1 both arrays change, t2 untouched
        expect(mockAgent.db.updateTrip).toHaveBeenCalledWith('t1', expect.objectContaining({
            planned_capsule: ['p1'],
            actual_capsule: ['p1', 'g_other']
        }));
        expect(mockAgent.db.updateTrip).not.toHaveBeenCalledWith('t2', expect.anything());

        // Shopping: only s1 swaps
        expect(mockAgent.db.updateShoppingItem).toHaveBeenCalledWith('s1', { resolved_garment_id: 'p1' });
        expect(mockAgent.db.updateShoppingItem).not.toHaveBeenCalledWith('s2', expect.anything());
    });

    test('deletes duplicate rows and broadcasts delete events', async () => {
        const primary = garmentRow({ id: 'p1' });
        const dup1 = garmentRow({ id: 'd1' });
        const dup2 = garmentRow({ id: 'd2' });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup1, d2: dup2 }[id]));

        await service.mergeGarments('p1', ['d1', 'd2']);

        expect(mockAgent.db.deleteGarment).toHaveBeenCalledWith('d1');
        expect(mockAgent.db.deleteGarment).toHaveBeenCalledWith('d2');
        const events = mockAgent.interface.broadcast.mock.calls.map(c => ({ event: c[0], payload: c[1] }));
        expect(events).toContainEqual({ event: 'wardrobe:garment:delete', payload: { id: 'd1' } });
        expect(events).toContainEqual({ event: 'wardrobe:garment:delete', payload: { id: 'd2' } });
        expect(events.some(e => e.event === 'wardrobe:garment:update')).toBe(true);
    });

    test('records the merge in primary meta.mergedFrom for audit', async () => {
        const primary = garmentRow({ id: 'p1', meta: { mergedFrom: ['old_x'] } });
        const dup = garmentRow({ id: 'd1' });
        mockAgent.db.getGarment.mockImplementation(id => ({ p1: primary, d1: dup }[id]));

        await service.mergeGarments('p1', ['d1']);

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'p1')[1];
        expect(patch.meta.mergedFrom).toEqual(['old_x', 'd1']);
        expect(patch.meta.lastMergedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    test('drops self-references in duplicateIds defensively', async () => {
        const primary = garmentRow({ id: 'p1' });
        mockAgent.db.getGarment.mockReturnValue(primary);

        await expect(service.mergeGarments('p1', ['p1'])).rejects.toThrow('at least one duplicate');
    });
});

describe('WardrobeService.reenrichGarment', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
    });

    test('stores hint in meta and kicks off background attribute pass with overwriteExisting flag', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            brand: 'Lululemon',
            model: null,
            enrichment_status: 'complete',
            meta: {}
        });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        const r = await service.reenrichGarment('g1', { hint: 'ABC Warpstreme Jogger Regular' });

        // Immediately-returned status change + broadcast
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', expect.objectContaining({
            enrichment_status: 'enriching',
            meta: expect.objectContaining({ userHint: 'ABC Warpstreme Jogger Regular' })
        }));
        // Background pass uses ONLY the user's typed hint — existing brand/model
        // are not injected (they may be the wrong values being corrected).
        const call = service._runAttributePass.mock.calls[0][1];
        expect(call.hint).toBe('ABC Warpstreme Jogger Regular');
        expect(call.hint).not.toMatch(/Lululemon/);
        expect(call.overwriteExisting).toBe(true);
        expect(r).toBeTruthy();
    });

    test('empty hint sends null hint to attribute pass (no biasing from stored data)', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            brand: 'Lacoste',
            model: 'L.12.12',
            meta: {}
        });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        await service.reenrichGarment('g1', { hint: '' });

        const patch = mockAgent.db.updateGarment.mock.calls[0][1];
        expect(patch.meta).not.toHaveProperty('userHint');
        const opts = service._runAttributePass.mock.calls[0][1];
        expect(opts.hint).toBeNull();
        expect(opts.overwriteExisting).toBe(true);
    });

    test('throws when garment does not exist', async () => {
        mockAgent.db.getGarment.mockReturnValue(null);
        await expect(service.reenrichGarment('ghost', {})).rejects.toThrow('not found');
    });

    test('replaces the garment crop and clears stale brand/model when an extra image is supplied', async () => {
        const oldCropPath = '/data/wardrobe/garments/src/crop_old.jpg';
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            // Stored brand/model that the user is trying to correct via re-upload
            brand: 'Nike',
            model: 'Wrong Model',
            crop_image_path: oldCropPath,
            source_image_path: '/data/wardrobe/garments/src/original.jpg',
            generated_image_path: null,
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        await service.reenrichGarment('g1', {
            hint: 'jogger',
            extraImageBase64: 'PHOTODATA',
            mimeType: 'image/png'
        });

        // Wrote the new crop to disk under the existing source dir
        expect(writeSpy).toHaveBeenCalledWith(
            expect.stringMatching(/crop_g1_\d+\.png$/),
            expect.any(Buffer)
        );
        const patch = mockAgent.db.updateGarment.mock.calls[0][1];
        // Crop swapped, stale generated image dropped
        expect(patch.crop_image_path).toMatch(/crop_g1_\d+\.png$/);
        expect(patch.generated_image_path).toBeNull();
        // Stored brand/model cleared so the upcoming pass starts from a clean slate
        expect(patch.brand).toBeNull();
        expect(patch.model).toBeNull();
        // Old crop file unlinked
        expect(unlinkSpy).toHaveBeenCalledWith(oldCropPath);
    });

    test('clears stale generated image when crop is replaced', async () => {
        const oldGenPath = '/data/wardrobe/garments/src/generated_g1_111.jpg';
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/data/wardrobe/garments/src/crop_old.jpg',
            source_image_path: '/data/wardrobe/garments/src/original.jpg',
            generated_image_path: oldGenPath,
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        await service.reenrichGarment('g1', { extraImageBase64: 'PHOTODATA' });

        expect(unlinkSpy).toHaveBeenCalledWith(oldGenPath);
    });

    test('does not delete the source image even when it equals crop_image_path (full-frame ingest)', async () => {
        const sharedPath = '/data/wardrobe/garments/src/original.jpg';
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: sharedPath,
            source_image_path: sharedPath,
            generated_image_path: null,
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        await service.reenrichGarment('g1', { extraImageBase64: 'PHOTODATA' });

        // Source image must survive — full-frame ingests share it across rows
        expect(unlinkSpy).not.toHaveBeenCalledWith(sharedPath);
    });

    test('runs attribute pass without extraReferences (the new image IS the new crop)', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', brand: null, model: null,
            crop_image_path: '/data/wardrobe/garments/src/crop_old.jpg',
            source_image_path: '/data/wardrobe/garments/src/original.jpg',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);

        await service.reenrichGarment('g1', { extraImageBase64: 'PHOTODATA' });

        const opts = service._runAttributePass.mock.calls[0][1];
        // No extraReferences anymore — the new image now lives at crop_image_path
        expect(opts.extraReferences).toBeUndefined();
    });

    test('_enrichBrand skips web search when user brand already set', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            brand: 'Lululemon',
            model: 'ABC Warpstreme Jogger',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            enrichment_status: 'enriching',
            meta: { distinguishingFeatures: 'omega logo on thigh' }
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        await service._enrichBrand('g1');

        expect(mockAgent.client.models.generateContent).not.toHaveBeenCalled();
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', { enrichment_status: 'complete' });
    });

    test('_enrichBrand skips web search when userHint is present', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            brand: null,
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            enrichment_status: 'enriching',
            meta: {
                distinguishingFeatures: 'logo on chest',
                userHint: 'ABC Warpstreme Jogger Regular'
            }
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        await service._enrichBrand('g1');

        expect(mockAgent.client.models.generateContent).not.toHaveBeenCalled();
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', { enrichment_status: 'complete' });
    });

    test('_runAttributePass passes extraReferences to the model alongside the crop', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            enrichment_status: 'enriching',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'top', confidence: 0.9
        }));

        await service._runAttributePass('g1', {
            extraReferences: [{ data: 'EXTRA', mimeType: 'image/png' }]
        });

        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const inlineParts = callArgs.contents[0].parts.filter(p => p.inlineData);
        expect(inlineParts).toHaveLength(2);
        expect(inlineParts[1].inlineData).toEqual({ data: 'EXTRA', mimeType: 'image/png' });
        const promptText = callArgs.contents[0].parts.find(p => p.text)?.text || '';
        expect(promptText).toMatch(/IMAGES PROVIDED: 2/);
    });

    test('_runAttributePass prompt includes the hint when provided', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            enrichment_status: 'enriching',
            enrichment_confidence: 0.5,
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'bottom', subtype: 'joggers', primary_color: 'black', confidence: 0.9
        }));

        await service._runAttributePass('g1', { hint: 'ABC Warpstreme Jogger · Lululemon' });

        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const promptText = callArgs.contents[0].parts.find(p => p.text)?.text || '';
        expect(promptText).toMatch(/USER-SUPPLIED IDENTITY/);
        expect(promptText).toMatch(/ABC Warpstreme Jogger/);
    });

    test('_runAttributePass fills brand/model from hint-parsed response when garment has none', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            brand: null,
            model: null,
            enrichment_status: 'enriching',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'bottom',
            subtype: 'joggers',
            brand: 'Lululemon',
            model: 'ABC Warpstreme Jogger Regular',
            confidence: 0.95
        }));

        await service._runAttributePass('g1', { hint: 'ABC Warpstreme Jogger Regular' });

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[1].subtype === 'joggers')[1];
        expect(patch.brand).toBe('Lululemon');
        expect(patch.model).toBe('ABC Warpstreme Jogger Regular');
    });

    test('_runAttributePass does not overwrite user-set brand/model on hint-only ingest', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            brand: 'MyBrand',
            model: 'MyModel',
            enrichment_status: 'enriching',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'bottom',
            brand: 'DifferentBrand',
            model: 'DifferentModel',
            confidence: 0.9
        }));

        await service._runAttributePass('g1', { hint: 'DifferentBrand DifferentModel' });

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[1].type === 'bottom')[1];
        expect(patch.brand).toBeUndefined();
        expect(patch.model).toBeUndefined();
    });

    test('_runAttributePass overwrites stale brand/model when overwriteExisting=true (re-enrich path)', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            brand: 'WrongBrand',
            model: 'WrongModel',
            enrichment_status: 'enriching',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'bottom',
            brand: 'CorrectBrand',
            model: 'CorrectModel',
            confidence: 0.9
        }));

        await service._runAttributePass('g1', { overwriteExisting: true });

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[1].type === 'bottom')[1];
        expect(patch.brand).toBe('CorrectBrand');
        expect(patch.model).toBe('CorrectModel');
    });

    test('_runAttributePass with overwriteExisting=true keeps existing brand when model returns null (no blanking on uncertainty)', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            brand: 'KeepThis',
            model: 'KeepThisToo',
            enrichment_status: 'enriching',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'bottom',
            brand: null,
            model: null,
            confidence: 0.9
        }));

        await service._runAttributePass('g1', { overwriteExisting: true });

        const patch = mockAgent.db.updateGarment.mock.calls.find(c => c[1].type === 'bottom')[1];
        expect(patch.brand).toBeUndefined();
        expect(patch.model).toBeUndefined();
    });

    test('_runAttributePass requests brand/model in schema when overwriteExisting=true even without a hint', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            crop_image_path: '/c.jpg',
            source_image_path: '/s.jpg',
            meta: {}
        });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'shoes', confidence: 0.9
        }));

        await service._runAttributePass('g1', { overwriteExisting: true });

        const promptText = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(promptText).toMatch(/"brand":/);
        expect(promptText).toMatch(/"model":/);
    });
});

describe('WardrobeService.generateGarmentImage', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1',
            type: 'bottom',
            subtype: 'joggers',
            primary_color: 'black',
            brand: 'Lululemon',
            model: 'ABC Warpstreme Jogger',
            crop_image_path: '/data/wardrobe/garments/src/crop_0.jpg',
            source_image_path: '/data/wardrobe/garments/src/original.jpg',
            meta: {}
        });
    });

    test('generates image, writes file, updates row with generated_image_path', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }
            ]}}]
        });

        const r = await service.generateGarmentImage('g1');

        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(mockAgent.db.updateGarment).toHaveBeenCalledWith('g1', expect.objectContaining({
            // Filename includes a timestamp so each regeneration gets a unique URL,
            // bypassing the immutable Cache-Control on the image route.
            generated_image_path: expect.stringMatching(/generated_g1_\d+\.jpg$/)
        }));
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:garment:update', expect.anything());
        expect(r).toBeTruthy();
    });

    test('prompt describes the garment using its attributes and brand', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }
            ]}}]
        });

        await service.generateGarmentImage('g1');

        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const prompt = callArgs.contents[0].parts.find(p => p.text)?.text || '';
        expect(prompt).toMatch(/joggers/);
        expect(prompt).toMatch(/Lululemon/);
        expect(prompt).toMatch(/ABC Warpstreme Jogger/);
    });

    test('throws when image model returns no image', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [{ text: 'text only' }] }}]
        });
        await expect(service.generateGarmentImage('g1')).rejects.toThrow('No image');
    });

    test('throws when garment has no source image', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', type: 'top',
            crop_image_path: null, source_image_path: null, meta: {}
        });
        await expect(service.generateGarmentImage('g1')).rejects.toThrow('source image');
    });

    test('throws when garment not found', async () => {
        mockAgent.db.getGarment.mockReturnValue(null);
        await expect(service.generateGarmentImage('ghost')).rejects.toThrow('not found');
    });

    test('regeneration deletes the previous generated file (no on-disk cruft)', async () => {
        const previousPath = '/data/wardrobe/garments/src/generated_g1_111.jpg';
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', type: 'top', subtype: 'tshirt',
            crop_image_path: '/data/wardrobe/garments/src/crop_0.jpg',
            source_image_path: '/data/wardrobe/garments/src/original.jpg',
            generated_image_path: previousPath,
            meta: {}
        });
        const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'NEW' } }
            ]}}]
        });

        await service.generateGarmentImage('g1');

        expect(unlinkSpy).toHaveBeenCalledWith(previousPath);
    });

    test('passes extra reference images to the model alongside the crop', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }
            ]}}]
        });

        await service.generateGarmentImage('g1', {
            extraReferences: [{ data: 'EXTRADATA', mimeType: 'image/png' }]
        });

        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const parts = callArgs.contents[0].parts;
        const inlineParts = parts.filter(p => p.inlineData);
        // crop + 1 extra reference
        expect(inlineParts).toHaveLength(2);
        expect(inlineParts[1].inlineData).toEqual({ data: 'EXTRADATA', mimeType: 'image/png' });
        const prompt = parts.find(p => p.text)?.text || '';
        expect(prompt).toMatch(/2 reference images/);
    });

    test('default mimeType for extra reference is image/jpeg', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }
            ]}}]
        });

        await service.generateGarmentImage('g1', {
            extraReferences: [{ data: 'EXTRADATA' }]
        });

        const inlineParts = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.filter(p => p.inlineData);
        expect(inlineParts[1].inlineData.mimeType).toBe('image/jpeg');
    });

    test('prompt embeds shoes-specific composition (pair, 3/4 angle) when garment is shoes', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', type: 'shoes', subtype: 'sneakers',
            primary_color: 'white', brand: 'Nike',
            crop_image_path: '/x.jpg', source_image_path: '/x.jpg', meta: {}
        });
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }
            ]}}]
        });

        await service.generateGarmentImage('g1');

        const prompt = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(prompt).toMatch(/BOTH shoes/);
        expect(prompt).toMatch(/3\/4 front angle/);
        expect(prompt).toMatch(/laces/i);
    });

    test('prompt embeds flat-lay composition for tops', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', type: 'top', subtype: 'polo',
            crop_image_path: '/x.jpg', source_image_path: '/x.jpg', meta: {}
        });
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }
            ]}}]
        });

        await service.generateGarmentImage('g1');

        const prompt = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(prompt).toMatch(/flat lay/);
        expect(prompt).toMatch(/collar/);
    });

    test('prompt embeds flat-lay composition for bottoms with drawcord hint for joggers', async () => {
        mockAgent.db.getGarment.mockReturnValue({
            id: 'g1', type: 'bottom', subtype: 'joggers',
            crop_image_path: '/x.jpg', source_image_path: '/x.jpg', meta: {}
        });
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }
            ]}}]
        });

        await service.generateGarmentImage('g1');

        const prompt = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.find(p => p.text)?.text || '';
        expect(prompt).toMatch(/flat lay/);
        expect(prompt).toMatch(/[Dd]rawcord/);
    });

    test('drops malformed extras (no data) silently', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }
            ]}}]
        });

        await service.generateGarmentImage('g1', {
            extraReferences: [null, {}, { mimeType: 'image/png' }, { data: '' }]
        });

        const inlineParts = mockAgent.client.models.generateContent.mock.calls[0][0]
            .contents[0].parts.filter(p => p.inlineData);
        // Only the crop, all extras filtered
        expect(inlineParts).toHaveLength(1);
    });
});

describe('WardrobeService.analyzeOutfitPhoto (P5)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        service._cropToFile = jest.fn().mockResolvedValue('/out/crop.jpg');
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);
    });

    test('matches some items and auto-adds unmatched', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.4, 0.5], type: 'top', primary_color: 'white', secondary_colors: [], season_tags: [], distinguishing_features: null },
            { bbox: [0.5, 0.1, 0.9, 0.5], type: 'bottom', primary_color: 'khaki', secondary_colors: [], season_tags: [], distinguishing_features: null },
            { bbox: [0.3, 0.5, 0.7, 0.95], type: 'shoes', primary_color: 'white', secondary_colors: [], season_tags: [], distinguishing_features: null }
        ]);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'existing_top', type: 'top', primary_color: 'white', crop_image_path: '/x/top.jpg' },
            { id: 'existing_sneak', type: 'shoes', primary_color: 'white', crop_image_path: '/x/sneak.jpg' }
        ]);
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ matches: [
                { detection_index: 0, match: 'existing_top' },
                { detection_index: 1, match: 'NEW' },
                { detection_index: 2, match: 'existing_sneak' }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: [
                { detection_index: 0, match: 'existing_top' },
                { detection_index: 1, match: 'NEW' },
                { detection_index: 2, match: 'existing_sneak' }
            ]}) }] } }]
        });
        mockAgent.db.addGarment.mockReturnValueOnce('new_bottom');
        mockAgent.db.getGarment.mockImplementation(id => ({ id, source: 'auto_from_chat' }));

        const result = await service.analyzeOutfitPhoto('AAAA', { caption: 'what do I wear?' });

        expect(result.matched).toEqual(['existing_top', 'existing_sneak']);
        expect(result.newly_added).toEqual(['new_bottom']);
        expect(mockAgent.db.addGarment).toHaveBeenCalledTimes(1);
        expect(mockAgent.db.addGarment).toHaveBeenCalledWith(expect.objectContaining({
            source: 'auto_from_chat',
            type: 'bottom'
        }));
        expect(service._runAttributePass).toHaveBeenCalledTimes(1);
    });

    test('falls back to all-NEW when client unavailable', async () => {
        const agentNoClient = { ...mockAgent, client: null };
        const s = new WardrobeService(agentNoClient);
        s._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.5, 0.5], type: 'top', primary_color: 'blue', secondary_colors: [], season_tags: [] }
        ]);
        s._cropToFile = jest.fn().mockResolvedValue('/out/crop.jpg');
        s._runAttributePass = jest.fn().mockResolvedValue(undefined);
        agentNoClient.db.getGarments.mockReturnValue([
            { id: 'existing_top', type: 'top' }
        ]);
        agentNoClient.db.addGarment.mockReturnValueOnce('new_1');
        agentNoClient.db.getGarment.mockReturnValue({ id: 'new_1', source: 'auto_from_chat' });

        const result = await s.analyzeOutfitPhoto('AAAA');

        expect(result.matched).toEqual([]);
        expect(result.newly_added).toEqual(['new_1']);
    });

    test('hallucinated match ids are treated as NEW', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.5, 0.5], type: 'top', primary_color: 'blue', secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'real_id', type: 'top', crop_image_path: '/x/real.jpg' }
        ]);
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ matches: [
                { detection_index: 0, match: 'hallucinated_id' }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: [{ detection_index: 0, match: 'hallucinated_id' }]}) }] } }]
        });
        mockAgent.db.addGarment.mockReturnValueOnce('new_from_halluc');
        mockAgent.db.getGarment.mockReturnValue({ id: 'new_from_halluc' });

        const result = await service.analyzeOutfitPhoto('AAAA');

        expect(result.matched).toEqual([]);
        expect(result.newly_added).toEqual(['new_from_halluc']);
    });

    test('empty detection returns empty result', async () => {
        service._detectItems = jest.fn().mockResolvedValue([]);
        const result = await service.analyzeOutfitPhoto('AAAA');
        expect(result).toEqual({ matched: [], newly_added: [], notes: 'No items detected' });
    });
});

describe('WardrobeService.recommendOutfit (P6)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'g1', type: 'top', primary_color: 'navy', warmth: 2, formality: 3 },
            { id: 'g2', type: 'bottom', primary_color: 'khaki', warmth: 2 },
            { id: 'g3', type: 'shoes', primary_color: 'white' }
        ]);
        mockAgent.db.getGarment.mockImplementation(id =>
            mockAgent.db.getGarments().find(g => g.id === id) || null);
        mockAgent.db.getOutfits = jest.fn().mockReturnValue([]);
        mockAgent.db.addOutfit = jest.fn().mockReturnValue('out_1');
        mockAgent.db.getOutfit = jest.fn().mockImplementation(id => ({ id, garment_ids: ['g1', 'g2', 'g3'] }));
        mockAgent.db.updateOutfit = jest.fn().mockReturnValue(true);
    });

    test('returns empty with note when wardrobe empty and no pool supplied', async () => {
        mockAgent.db.getGarments.mockReturnValue([]);
        const r = await service.recommendOutfit({ context: 'casual' });
        expect(r.proposals).toEqual([]);
        expect(r.notes).toMatch(/empty/i);
    });

    test('falls back to stub proposal when client missing', async () => {
        const agentNoClient = { ...mockAgent, client: null };
        const s = new WardrobeService(agentNoClient);
        agentNoClient.db.getGarments.mockReturnValue([
            { id: 'g1', type: 'top' }, { id: 'g2', type: 'bottom' }
        ]);
        agentNoClient.db.addOutfit = jest.fn().mockReturnValue('out_stub');
        agentNoClient.db.getOutfit = jest.fn().mockReturnValue({ id: 'out_stub', garment_ids: ['g1', 'g2'] });
        agentNoClient.db.getOutfits = jest.fn().mockReturnValue([]);

        const r = await s.recommendOutfit({ context: 'brunch' });

        expect(r.proposals).toHaveLength(1);
        expect(r.proposals[0].bucket).toBe('weather_anchored');
    });

    test('parses 4-bucket response and saves proposals', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ proposals: [
                { bucket: 'weather_anchored', garment_ids: ['g1', 'g2', 'g3'], rationale: 'light for warm weather' },
                { bucket: 'occasion_anchored', garment_ids: ['g1', 'g2'], rationale: 'casual dinner' },
                { bucket: 'safe_repeat', garment_ids: ['g1', 'g3'], rationale: 'variation on liked' }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ proposals: [
                { bucket: 'weather_anchored', garment_ids: ['g1', 'g2', 'g3'], rationale: 'light' }
            ]}) }] } }]
        });
        mockAgent.db.addOutfit.mockReturnValueOnce('o1').mockReturnValueOnce('o2').mockReturnValueOnce('o3');

        const r = await service.recommendOutfit({ context: 'brunch at 20C' });

        expect(r.proposals).toHaveLength(3);
        expect(mockAgent.db.addOutfit).toHaveBeenCalledTimes(3);
    });

    test('filters out garment_ids not in pool (anti-hallucination)', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ proposals: [
                { bucket: 'weather_anchored', garment_ids: ['g1', 'phantom_id', 'g2'], rationale: 'mixed' }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ proposals: [
                { bucket: 'weather_anchored', garment_ids: ['g1', 'phantom_id', 'g2'], rationale: 'x' }
            ]}) }] } }]
        });

        await service.recommendOutfit({ context: 'x' });

        const saved = mockAgent.db.addOutfit.mock.calls[0][0];
        expect(saved.garment_ids).toEqual(['g1', 'g2']);
    });

    test('saved outfit name is a human-readable date + pretty bucket label', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ proposals: [
                { bucket: 'weather_anchored', garment_ids: ['g1', 'g2'], rationale: 'light' },
                { bucket: 'occasion_anchored', garment_ids: ['g2', 'g3'], rationale: 'work' },
                { bucket: 'safe_repeat', garment_ids: ['g1'], rationale: 'tried and true' }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ proposals: [] }) }] } }]
        });

        await service.recommendOutfit({ context: 'today' });

        const saved = mockAgent.db.addOutfit.mock.calls.map(c => c[0]);
        // "Apr 23 · weather", "Apr 23 · occasion", "Apr 23 · safe repeat" — the
        // exact month abbreviation is locale-dependent on the host machine but
        // every title should share the same date prefix and end with the
        // pretty-printed bucket (never the raw "weather_anchored").
        const datePrefix = saved[0].name.split(' · ')[0];
        expect(datePrefix).toMatch(/^[A-Za-z]{3,} \d{1,2}$/);
        expect(saved.map(s => s.name.split(' · ')[1])).toEqual(['weather', 'occasion', 'safe repeat']);
        for (const s of saved) expect(s.name).not.toMatch(/_anchored/);
    });

    test('wants[] from proposal flow to shopping list when available', async () => {
        mockAgent.db.addShoppingItem = jest.fn().mockReturnValue('shop_1');
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ proposals: [
                {
                    bucket: 'weather_anchored',
                    garment_ids: ['g1', 'g2'],
                    rationale: 'close but missing a key piece',
                    wants: [{ description: 'army green crew-neck tee', type: 'top', primary_color: 'green' }]
                }
            ]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ proposals: [] }) }] } }]
        });

        await service.recommendOutfit({ context: 'style these pants' });

        expect(mockAgent.db.addShoppingItem).toHaveBeenCalledWith(expect.objectContaining({
            description: 'army green crew-neck tee',
            type: 'top',
            suggested_context: expect.objectContaining({ reason: 'completes outfit' })
        }));
    });
});

describe('WardrobeService.generateOutfitVariations', () => {
    let service;
    const sourceOutfit = {
        id: 'out1',
        garment_ids: ['top1', 'bot1', 'sho1', 'jkt1']
    };
    const wardrobe = [
        { id: 'top1', type: 'top', subtype: 'tshirt', primary_color: 'black', crop_image_path: '/c/top1.jpg' },
        { id: 'top2', type: 'top', subtype: 'tshirt', primary_color: 'white', crop_image_path: '/c/top2.jpg' },
        { id: 'top3', type: 'top', subtype: 'polo', primary_color: 'navy', crop_image_path: '/c/top3.jpg' },
        { id: 'bot1', type: 'bottom', subtype: 'chinos', primary_color: 'black', crop_image_path: '/c/bot1.jpg' },
        { id: 'bot2', type: 'bottom', subtype: 'jeans', primary_color: 'indigo', crop_image_path: '/c/bot2.jpg' },
        { id: 'sho1', type: 'shoes', subtype: 'sneakers', primary_color: 'white', crop_image_path: '/c/sho1.jpg' },
        { id: 'jkt1', type: 'outerwear', subtype: 'bomber', primary_color: 'tan', crop_image_path: '/c/jkt1.jpg' }
    ];

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, reference_image_path: '/data/wardrobe/profile/reference.jpg' });
        mockAgent.db.getOutfit = jest.fn().mockReturnValue(sourceOutfit);
        mockAgent.db.updateOutfit = jest.fn().mockReturnValue(true);
        mockAgent.db.addOutfit = jest.fn();
        mockAgent.db.getGarment.mockImplementation(id => wardrobe.find(g => g.id === id) || null);
        mockAgent.db.getGarments.mockReturnValue(wardrobe);
    });

    test('throws when outfit does not exist', async () => {
        mockAgent.db.getOutfit.mockReturnValue(null);
        await expect(service.generateOutfitVariations('missing')).rejects.toThrow(/not found/);
    });

    test('throws when source outfit has fewer than 2 items', async () => {
        mockAgent.db.getOutfit.mockReturnValue({ id: 'out1', garment_ids: ['top1'] });
        await expect(service.generateOutfitVariations('out1')).rejects.toThrow(/at least 2/);
    });

    test('LLM proposal renders as multi-panel and saves to variations_image_path', async () => {
        // LLM returns two variations; both swap exactly one piece.
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce({
                text: () => JSON.stringify({ variations: [
                    { garment_ids: ['top2', 'bot1', 'sho1', 'jkt1'], rationale: 'white tee instead of black' },
                    { garment_ids: ['top1', 'bot2', 'sho1', 'jkt1'], rationale: 'jeans instead of chinos' }
                ]}),
                candidates: [{ content: { parts: [{ text: JSON.stringify({ variations: [
                    { garment_ids: ['top2', 'bot1', 'sho1', 'jkt1'] },
                    { garment_ids: ['top1', 'bot2', 'sho1', 'jkt1'] }
                ]}) }] } }]
            })
            .mockResolvedValueOnce({
                candidates: [{ content: { parts: [
                    { inlineData: { mimeType: 'image/png', data: 'AAAAAA' } }
                ] } }]
            });

        const r = await service.generateOutfitVariations('out1', { count: 2 });

        expect(mockAgent.db.updateOutfit).toHaveBeenCalledWith('out1', expect.objectContaining({
            variations_image_path: expect.stringMatching(/variations\.jpg$/)
        }));
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:outfit:variations-rendered',
            expect.anything()
        );
        expect(r.panels).toBe(3); // source + 2 variations
    });

    test('rejects a proposed variation that is identical to the source', async () => {
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce({
                text: () => JSON.stringify({ variations: [
                    { garment_ids: ['top1', 'bot1', 'sho1', 'jkt1'] }, // exact source, order-independent
                    { garment_ids: ['top2', 'bot1', 'sho1', 'jkt1'] }
                ]}),
                candidates: [{ content: { parts: [{ text: JSON.stringify({ variations: [] }) }] } }]
            })
            .mockResolvedValueOnce({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA' } }] } }]
            });

        const r = await service.generateOutfitVariations('out1', { count: 2 });

        // Only the non-source variation should render → source + 1 = 2 panels.
        expect(r.panels).toBe(2);
    });

    test('rejects garment ids not present in the wardrobe', async () => {
        mockAgent.client.models.generateContent
            .mockResolvedValueOnce({
                text: () => JSON.stringify({ variations: [
                    { garment_ids: ['ghost1', 'ghost2', 'sho1', 'jkt1'] },
                    { garment_ids: ['top2', 'bot1', 'sho1', 'jkt1'] }
                ]}),
                candidates: [{ content: { parts: [{ text: JSON.stringify({ variations: [] }) }] } }]
            })
            .mockResolvedValueOnce({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA' } }] } }]
            });

        const r = await service.generateOutfitVariations('out1', { count: 2 });

        // Ghost-ids variation drops below 2 valid items → filtered out. Only the clean
        // variation survives → source + 1 = 2 panels.
        expect(r.panels).toBe(2);
    });

    test('falls back to deterministic same-type swap when LLM unavailable', async () => {
        const noClientAgent = { ...mockAgent, client: null };
        const s = new WardrobeService(noClientAgent);
        s.visualizeOutfit = jest.fn().mockResolvedValue({ outfit: { id: 'out1' }, panels: 3, layout: 'horizontal' });

        await s.generateOutfitVariations('out1', { count: 2 });

        const call = s.visualizeOutfit.mock.calls[0][0];
        expect(call.saveAs).toBe('variations');
        expect(call.outfitId).toBe('out1');
        // First panel = source, subsequent panels are variations that each share 3/4 items with source.
        const sourceSet = new Set(sourceOutfit.garment_ids);
        for (let i = 1; i < call.garmentIdsPanels.length; i++) {
            const shared = call.garmentIdsPanels[i].filter(id => sourceSet.has(id)).length;
            expect(shared).toBeGreaterThanOrEqual(3);
        }
    });
});

describe('WardrobeService.generateOutfitsForGarment', () => {
    let service;
    const wardrobe = [
        { id: 'top1', type: 'top', subtype: 'tshirt', primary_color: 'black' },
        { id: 'top2', type: 'top', subtype: 'polo', primary_color: 'navy' },
        { id: 'bot1', type: 'bottom', subtype: 'chinos', primary_color: 'khaki' },
        { id: 'bot2', type: 'bottom', subtype: 'jeans', primary_color: 'indigo' },
        { id: 'sho1', type: 'shoes', subtype: 'sneakers', primary_color: 'white' },
        { id: 'sho2', type: 'shoes', subtype: 'loafers', primary_color: 'brown' }
    ];

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.getGarment.mockImplementation(id => wardrobe.find(g => g.id === id) || null);
        mockAgent.db.getGarments.mockReturnValue(wardrobe);
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, preferred_brands: [] });
        mockAgent.db.addOutfit = jest.fn().mockImplementation(o => `out_${Math.random().toString(36).slice(2, 7)}`);
        mockAgent.db.getOutfit = jest.fn().mockImplementation(id => ({ id, garment_ids: [] }));
    });

    test('throws when pinned garment does not exist', async () => {
        mockAgent.db.getGarment.mockReturnValueOnce(null);
        await expect(service.generateOutfitsForGarment('missing')).rejects.toThrow(/not found/);
    });

    test('throws when wardrobe has no other garments to combine', async () => {
        mockAgent.db.getGarments.mockReturnValueOnce([{ id: 'top1', type: 'top' }]);
        mockAgent.db.getGarment.mockImplementation(id => id === 'top1' ? { id: 'top1', type: 'top' } : null);
        await expect(service.generateOutfitsForGarment('top1')).rejects.toThrow(/at least one/);
    });

    test('every saved outfit contains the pinned garment, and it sits first', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ outfits: [
                { garment_ids: ['bot1', 'top1', 'sho1'] }, // pinned provided out of order
                { garment_ids: ['top1', 'bot2', 'sho2'] }
            ] }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ outfits: [] }) }] } }]
        });

        const r = await service.generateOutfitsForGarment('top1', { count: 2 });

        expect(r.proposals).toHaveLength(2);
        const savedOutfits = mockAgent.db.addOutfit.mock.calls.map(c => c[0]);
        for (const o of savedOutfits) {
            expect(o.garment_ids[0]).toBe('top1'); // pinned first
            expect(o.garment_ids.includes('top1')).toBe(true);
        }
        // Broadcasts a create event per outfit so the outfits grid refreshes.
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:outfit:create', expect.anything());
    });

    test('rejects proposals that drop the pinned garment', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ outfits: [
                { garment_ids: ['bot1', 'sho1'] }, // missing pinned top1 → invalid
                { garment_ids: ['top1', 'bot2', 'sho2'] }
            ] }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ outfits: [] }) }] } }]
        });

        const r = await service.generateOutfitsForGarment('top1', { count: 4 });

        // Only the valid proposal survives; no hallucination fallback on LLM success path.
        expect(r.proposals).toHaveLength(1);
    });

    test('fallback builds outfits without the LLM by swapping one slot', async () => {
        const noClient = { ...mockAgent, client: null };
        const s = new WardrobeService(noClient);

        const r = await s.generateOutfitsForGarment('top1', { count: 3 });

        const savedOutfits = noClient.db.addOutfit.mock.calls.map(c => c[0]);
        expect(savedOutfits.length).toBeGreaterThan(0);
        for (const o of savedOutfits) {
            expect(o.garment_ids[0]).toBe('top1');
            // Minimum viable outfit: pinned + bottom + shoes.
            expect(o.garment_ids.length).toBeGreaterThanOrEqual(2);
        }
        expect(r.proposals.length).toBe(savedOutfits.length);
    });

    test('outfit name is prefixed with today\'s date and the pinned garment descriptor', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ outfits: [
                { garment_ids: ['top1', 'bot1', 'sho1'] }
            ] }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ outfits: [] }) }] } }]
        });

        await service.generateOutfitsForGarment('top1', { count: 1 });

        const saved = mockAgent.db.addOutfit.mock.calls[0][0];
        // "Apr 23 · with top tshirt black #1" — date prefix, the word "with", and
        // something identifying the pinned garment so users can tell at a glance.
        expect(saved.name).toMatch(/^[A-Za-z]{3,} \d{1,2} · with .+ #1$/);
    });
});

describe('WardrobeService._formatProfileForPrompt', () => {
    let service;
    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
    });

    test('returns empty string when profile has no configured prefs', () => {
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, preferred_brands: [] });
        expect(service._formatProfileForPrompt()).toBe('');
    });

    test('formats sizing, fit, formality bias, and color lists into the prompt block', () => {
        mockAgent.db.getUserProfile.mockReturnValue({
            id: 1,
            preferred_brands: ['Lacoste'],
            sizing: { tops: 'M', shoes: '10' },
            style_preferences: {
                fit: 'slim',
                formality_bias: 'smart_casual',
                colors_loved: ['navy', 'olive'],
                colors_avoided: ['neon']
            }
        });

        const block = service._formatProfileForPrompt();
        expect(block).toMatch(/preferred fit: slim/);
        expect(block).toMatch(/formality bias: smart_casual/);
        expect(block).toMatch(/loves these colors: navy, olive/);
        expect(block).toMatch(/avoids these colors.*neon/);
        expect(block).toMatch(/preferred brands: Lacoste/);
        expect(block).toMatch(/tops M/);
        expect(block).toMatch(/shoes 10/);
    });

    test('recommendOutfit prompt includes profile block when configured', async () => {
        mockAgent.db.getUserProfile.mockReturnValue({
            id: 1,
            preferred_brands: [],
            style_preferences: { colors_avoided: ['hot pink'] }
        });
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'g1', type: 'top' }, { id: 'g2', type: 'bottom' }
        ]);
        mockAgent.db.getOutfits = jest.fn().mockReturnValue([]);
        mockAgent.db.addOutfit = jest.fn().mockReturnValue('o1');
        mockAgent.db.getOutfit = jest.fn().mockReturnValue({ id: 'o1', garment_ids: ['g1'] });

        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ proposals: [] }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ proposals: [] }) }] } }]
        });

        await service.recommendOutfit({ context: 'testing' });

        const prompt = mockAgent.client.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
        expect(prompt).toMatch(/avoids these colors.*hot pink/);
    });
});

describe('WardrobeService.visualizeOutfit (P7/P8)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('bytes'));
        mockAgent.db.getUserProfile.mockReturnValue({
            id: 1,
            reference_image_path: '/data/wardrobe/profile/reference.jpg',
            preferred_brands: []
        });
        mockAgent.db.getGarment.mockImplementation(id => ({
            id,
            type: 'top',
            primary_color: 'navy',
            crop_image_path: `/data/wardrobe/garments/${id}/crop.jpg`
        }));
        mockAgent.db.addOutfit = jest.fn().mockReturnValue('out_new');
        mockAgent.db.updateOutfit = jest.fn().mockReturnValue(true);
        mockAgent.db.getOutfit = jest.fn().mockImplementation(id => ({ id, garment_ids: ['g1'], rendered_image_path: '/render.jpg' }));
    });

    test('returns needs_reference when no reference selfie set', async () => {
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, reference_image_path: null });
        const r = await service.visualizeOutfit({ garmentIdsPanels: ['g1', 'g2'] });
        expect(r).toEqual({ needs_reference: true });
    });

    test('single panel call produces a render and attaches to a new outfit by default', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { text: 'ok' },
                { inlineData: { mimeType: 'image/png', data: 'AAAAAA' } }
            ] } }]
        });

        const r = await service.visualizeOutfit({ garmentIdsPanels: ['g1', 'g2'] });

        expect(mockAgent.db.addOutfit).toHaveBeenCalled();
        expect(mockAgent.db.updateOutfit).toHaveBeenCalledWith('out_new', expect.objectContaining({
            rendered_image_path: expect.any(String)
        }));
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(r.panels).toBe(1);
        expect(r.layout).toBe('single');
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:outfit:rendered', expect.anything());
    });

    test('multi-panel (P8) produces one image and selects horizontal layout for N=3', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
            ] } }]
        });

        const r = await service.visualizeOutfit({
            garmentIdsPanels: [['g1'], ['g2'], ['g3']]
        });

        expect(r.panels).toBe(3);
        expect(r.layout).toBe('horizontal');
        // prompt should request multi-panel rendering
        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        const promptText = callArgs.contents[0].parts.at(-1)?.text || '';
        expect(promptText).toMatch(/3 vertical mirror panels/);
    });

    test('N=4 panels uses 2x2 grid layout', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
            ] } }]
        });
        const r = await service.visualizeOutfit({
            garmentIdsPanels: [['g1'], ['g2'], ['g3'], ['g4']]
        });
        expect(r.panels).toBe(4);
        expect(r.layout).toBe('grid');
    });

    test('attaches render to supplied outfit_id instead of creating new outfit', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
            ] } }]
        });

        await service.visualizeOutfit({ garmentIdsPanels: ['g1'], outfitId: 'existing_outfit' });

        expect(mockAgent.db.addOutfit).not.toHaveBeenCalled();
        expect(mockAgent.db.updateOutfit).toHaveBeenCalledWith('existing_outfit', expect.objectContaining({
            rendered_image_path: expect.any(String)
        }));
    });

    test('throws when image model returns no image', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [{ text: 'no image' }] } }]
        });
        await expect(service.visualizeOutfit({ garmentIdsPanels: ['g1'] })).rejects.toThrow('No image');
    });

    test('throws when no panels provided', async () => {
        await expect(service.visualizeOutfit({ garmentIdsPanels: [] })).rejects.toThrow('at least one panel');
    });

    test('throws when supplied outfit_id does not exist (no silent no-op)', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            candidates: [{ content: { parts: [
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
            ] } }]
        });
        mockAgent.db.getOutfit = jest.fn().mockReturnValue(null); // outfit doesn't exist

        await expect(service.visualizeOutfit({ garmentIdsPanels: ['g1'], outfitId: 'ghost' }))
            .rejects.toThrow('Outfit ghost not found');
        expect(mockAgent.db.updateOutfit).not.toHaveBeenCalled();
    });
});

describe('WardrobeService.analyzeOutfitPhoto trip-scoped shortlist (review fix)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        service._cropToFile = jest.fn().mockResolvedValue('/out/crop.jpg');
        service._runAttributePass = jest.fn().mockResolvedValue(undefined);
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.5, 0.5], type: 'top', primary_color: 'navy', secondary_colors: [], season_tags: [] }
        ]);
    });

    test('active trip prepends capsule items but still includes non-capsule wardrobe items in shortlist', async () => {
        mockAgent.db.getTrip = jest.fn().mockReturnValue({
            id: 't1', status: 'active', actual_capsule: ['capsule_item_1']
        });
        mockAgent.db.getGarment.mockImplementation(id => {
            if (id === 'capsule_item_1') return { id, type: 'top', crop_image_path: '/c.jpg' };
            if (id === 'wardrobe_other') return { id, type: 'bottom', crop_image_path: '/w.jpg' };
            return null;
        });
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'wardrobe_other', type: 'bottom', crop_image_path: '/w.jpg' }
        ]);
        mockAgent.db.setTripCapsule = jest.fn().mockReturnValue(true);
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({ matches: [{ detection_index: 0, match: 'wardrobe_other' }]}),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: [{ detection_index: 0, match: 'wardrobe_other' }] }) }] } }]
        });

        const result = await service.analyzeOutfitPhoto('AAAA', { tripId: 't1' });

        // Item matched against a non-capsule wardrobe piece (proof that shortlist
        // now includes items beyond the capsule).
        expect(result.matched).toEqual(['wardrobe_other']);
        expect(result.newly_added).toEqual([]);
    });
});

describe('WardrobeService.critiqueOutfit (P9)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'a', type: 'top', primary_color: 'navy' },
            { id: 'b', type: 'bottom', primary_color: 'khaki' },
            { id: 'c', type: 'shoes', primary_color: 'white' },
            { id: 'alt_top', type: 'top', primary_color: 'white', brand: 'Lacoste' }
        ]);
        mockAgent.db.getGarment.mockImplementation(id =>
            mockAgent.db.getGarments().find(g => g.id === id) || null);
    });

    test('throws when neither photo nor ids provided', async () => {
        await expect(service.critiqueOutfit({})).rejects.toThrow('imageBase64 or garmentIds');
    });

    test('returns score + strengths/weaknesses + valid alternative', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({
                score: 7,
                strengths: ['navy top contrasts well with khaki'],
                weaknesses: ['monochrome shoes blend in'],
                better_alternative: {
                    garment_ids: ['alt_top', 'b', 'c'],
                    rationale: 'Swap to a brighter top for contrast'
                }
            }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 7, strengths: [], weaknesses: [], better_alternative: { garment_ids: ['alt_top','b','c'], rationale: 'x' } }) }] } }]
        });

        const r = await service.critiqueOutfit({ garmentIds: ['a', 'b', 'c'], question: 'good for date?' });

        expect(r.score).toBe(7);
        expect(r.strengths.length).toBe(1);
        expect(r.weaknesses.length).toBe(1);
        expect(r.better_alternative.garment_ids).toEqual(['alt_top', 'b', 'c']);
    });

    test('filters alternative ids to wardrobe only (anti-hallucination)', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({
                score: 5,
                strengths: [],
                weaknesses: [],
                better_alternative: { garment_ids: ['phantom', 'alt_top', 'ghost'], rationale: 'x' }
            }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({
                score: 5,
                better_alternative: { garment_ids: ['phantom', 'alt_top'] }
            }) }] } }]
        });

        const r = await service.critiqueOutfit({ garmentIds: ['a', 'b'] });
        expect(r.better_alternative.garment_ids).toEqual(['alt_top']);
    });

    test('null better_alternative when model returns empty array', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({
                score: 9, strengths: ['already great'], weaknesses: [],
                better_alternative: { garment_ids: [], rationale: '' }
            }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 9, better_alternative: { garment_ids: [] } }) }] } }]
        });

        const r = await service.critiqueOutfit({ garmentIds: ['a', 'b'] });
        expect(r.better_alternative).toBeNull();
    });
});

describe('WardrobeService trips (P10a/P10b)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'g1', type: 'top', primary_color: 'navy', season_tags: ['spring'], source: 'manual_upload' },
            { id: 'g2', type: 'bottom', primary_color: 'khaki', source: 'manual_upload' },
            { id: 'g3', type: 'shoes', primary_color: 'white', source: 'manual_upload' },
            { id: 'old_trip_item', type: 'top', source: 'auto_from_trip' }
        ]);
        mockAgent.db.getGarment.mockImplementation(id => mockAgent.db.getGarments().find(g => g.id === id) || null);
        mockAgent.db.addTrip = jest.fn().mockReturnValue('trip_1');
        mockAgent.db.updateTrip = jest.fn().mockReturnValue(true);
        mockAgent.db.setTripCapsule = jest.fn().mockReturnValue(true);
        mockAgent.db.getTrip = jest.fn();
        mockAgent.db.getTrips = jest.fn().mockReturnValue([]);
        mockAgent.subAgentService = {
            spawn: jest.fn().mockResolvedValue({
                result: JSON.stringify({
                    days: [
                        { date: '2026-05-01', tempMin: 12, tempMax: 18, condition: 'cloudy', precipitationMm: 2 },
                        { date: '2026-05-02', tempMin: 10, tempMax: 16, condition: 'rainy', precipitationMm: 8 }
                    ]
                })
            })
        };
    });

    test('packForTrip calls weather subagent and persists planned trip', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({
                capsule: ['g1', 'g2', 'g3'],
                daily: [
                    { date: '2026-05-01', garment_ids: ['g1', 'g2'] },
                    { date: '2026-05-02', garment_ids: ['g1', 'g3'] }
                ],
                rationale: '3-piece minimal capsule covers both days with layering'
            }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ capsule: ['g1', 'g2', 'g3'], daily: [], rationale: 'x' }) }] } }]
        });
        mockAgent.db.getTrip
            .mockReturnValueOnce({ id: 'trip_1', weather_snapshot: null, planned_capsule: ['g1', 'g2', 'g3'] })
            .mockReturnValue({ id: 'trip_1', status: 'planned', planned_capsule: ['g1', 'g2', 'g3'], weather_snapshot: { days: [], daily_plan: [], pack_rationale: '3-piece minimal capsule covers both days with layering' }});

        const trip = await service.packForTrip({
            destination: 'Porto',
            startDate: '2026-05-01',
            endDate: '2026-05-02',
            activities: ['walking tour']
        });

        expect(mockAgent.subAgentService.spawn).toHaveBeenCalled();
        expect(mockAgent.db.addTrip).toHaveBeenCalledWith(expect.objectContaining({
            destination: 'Porto',
            status: 'planned',
            planned_capsule: ['g1', 'g2', 'g3']
        }));
        expect(trip.weather_snapshot.pack_rationale).toMatch(/3-piece/);
    });

    test('packForTrip filters hallucinated ids from capsule', async () => {
        mockAgent.client.models.generateContent.mockResolvedValueOnce({
            text: () => JSON.stringify({
                capsule: ['g1', 'ghost', 'g2'],
                daily: [],
                rationale: 'x'
            }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ capsule: ['g1', 'ghost', 'g2'], daily: [] }) }] } }]
        });
        mockAgent.db.getTrip
            .mockReturnValueOnce({ id: 'trip_1', planned_capsule: ['g1', 'g2'] })
            .mockReturnValue({ id: 'trip_1', planned_capsule: ['g1', 'g2'], weather_snapshot: { days: [], daily_plan: [], pack_rationale: 'x' }});

        await service.packForTrip({ destination: 'Porto', startDate: '2026-05-01', endDate: '2026-05-02' });

        const addCall = mockAgent.db.addTrip.mock.calls[0][0];
        expect(addCall.planned_capsule).toEqual(['g1', 'g2']);
    });

    test('packForTrip requires destination and dates', async () => {
        await expect(service.packForTrip({ destination: 'X' })).rejects.toThrow(/requires/);
    });

    test('startTrip copies planned_capsule into actual_capsule if empty', async () => {
        mockAgent.db.getTrip
            .mockReturnValueOnce({ id: 't1', status: 'planned', planned_capsule: ['g1', 'g2'], actual_capsule: [] })
            .mockReturnValueOnce({ id: 't1', status: 'active', planned_capsule: ['g1', 'g2'], actual_capsule: ['g1', 'g2'] });

        await service.startTrip('t1');

        expect(mockAgent.db.updateTrip).toHaveBeenCalledWith('t1', {
            status: 'active',
            actual_capsule: ['g1', 'g2']
        });
    });

    test('setTripCapsule overwrites', async () => {
        mockAgent.db.getTrip.mockReturnValue({ id: 't1', status: 'active', actual_capsule: ['g1'] });
        await service.setTripCapsule('t1', ['g2', 'g3']);
        expect(mockAgent.db.setTripCapsule).toHaveBeenCalledWith('t1', ['g2', 'g3']);
    });

    test('addToTripCapsule with garment_ids appends unique', async () => {
        mockAgent.db.getTrip.mockReturnValue({ id: 't1', status: 'active', actual_capsule: ['g1'] });
        await service.addToTripCapsule('t1', { garmentIds: ['g1', 'g2', 'g3'] });
        expect(mockAgent.db.setTripCapsule).toHaveBeenCalledWith('t1', ['g1', 'g2', 'g3']);
    });

    test('removeFromTripCapsule strips ids', async () => {
        mockAgent.db.getTrip.mockReturnValue({ id: 't1', status: 'active', actual_capsule: ['g1', 'g2', 'g3'] });
        await service.removeFromTripCapsule('t1', ['g2']);
        expect(mockAgent.db.setTripCapsule).toHaveBeenCalledWith('t1', ['g1', 'g3']);
    });

    test('completeTrip sets status', async () => {
        mockAgent.db.getTrip.mockReturnValue({ id: 't1', status: 'active' });
        await service.completeTrip('t1');
        expect(mockAgent.db.updateTrip).toHaveBeenCalledWith('t1', { status: 'completed' });
    });
});

describe('WardrobeService shopping list (P11)', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        mockAgent.db.addShoppingItem = jest.fn().mockReturnValue('shop_1');
        mockAgent.db.getShoppingItem = jest.fn().mockImplementation(id => ({
            id, description: 'army green crew-neck tee', type: 'top', primary_color: 'green', status: 'wanted', priority: 'medium'
        }));
        mockAgent.db.listShoppingItems = jest.fn().mockReturnValue([]);
        mockAgent.db.updateShoppingItem = jest.fn().mockReturnValue(true);
    });

    test('addToShoppingList inserts and broadcasts', async () => {
        const item = await service.addToShoppingList({
            description: 'army green crew-neck tee',
            type: 'top',
            primary_color: 'green',
            context: { outfit_id: 'o1', reason: 'completes outfit' }
        });
        expect(mockAgent.db.addShoppingItem).toHaveBeenCalledWith(expect.objectContaining({
            description: 'army green crew-neck tee',
            status: 'wanted',
            suggested_context: { outfit_id: 'o1', reason: 'completes outfit' }
        }));
        expect(item.id).toBe('shop_1');
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:shopping:update', expect.anything());
    });

    test('markPurchased sets status and links garment', async () => {
        await service.markPurchased('shop_1', 'new_garment_id');
        expect(mockAgent.db.updateShoppingItem).toHaveBeenCalledWith('shop_1', expect.objectContaining({
            status: 'purchased',
            resolved_garment_id: 'new_garment_id'
        }));
    });

    test('dismissShoppingItem sets status', async () => {
        await service.dismissShoppingItem('shop_1');
        expect(mockAgent.db.updateShoppingItem).toHaveBeenCalledWith('shop_1', { status: 'dismissed' });
    });

    test('_matchNewGarmentToShoppingList returns hit when type + color match', () => {
        mockAgent.db.listShoppingItems.mockReturnValue([
            { id: 'sl1', description: 'army green crew-neck tee', type: 'top', primary_color: 'green' }
        ]);
        const hit = service._matchNewGarmentToShoppingList({ type: 'top', primary_color: 'green' });
        expect(hit).toEqual({ id: 'sl1', description: 'army green crew-neck tee' });
    });

    test('_matchNewGarmentToShoppingList returns null on mismatch', () => {
        mockAgent.db.listShoppingItems.mockReturnValue([
            { id: 'sl1', description: 'army green tee', type: 'top', primary_color: 'green' }
        ]);
        const hit = service._matchNewGarmentToShoppingList({ type: 'bottom', primary_color: 'green' });
        expect(hit).toBeNull();
    });
});

describe('WardrobeService._runAttributePass concurrency safety', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
    });

    test('preserveFields prevents model output from overwriting inherited attrs', async () => {
        const snapshot = {
            id: 'g1',
            type: 'bottom',
            subtype: 'chinos',
            brand: 'Lululemon',
            model: 'ABC Trouser',
            primary_color: null,
            crop_image_path: '/data/crop.jpg',
            enrichment_status: 'enriching',
            meta: {}
        };
        mockAgent.db.getGarment.mockReturnValue(snapshot);
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'top',           // model tries to change type
            subtype: 'tshirt',     // model tries to change subtype
            primary_color: 'black', // model re-detects color (this SHOULD apply)
            pattern: 'solid',
            material_guess: 'linen', // model tries to change material
            warmth: 4,             // model tries to change warmth
            confidence: 0.9
        }));

        await service._runAttributePass('g1', { preserveFields: ['type', 'subtype', 'material_guess', 'warmth'] });

        const firstUpdate = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1' && c[1].primary_color)[1];
        expect(firstUpdate.primary_color).toBe('black');
        expect(firstUpdate).not.toHaveProperty('type');
        expect(firstUpdate).not.toHaveProperty('subtype');
        expect(firstUpdate).not.toHaveProperty('material_guess');
        expect(firstUpdate).not.toHaveProperty('warmth');
    });

    test('concurrent user edit during pass is detected and preserved', async () => {
        const start = {
            id: 'g1',
            type: 'top',
            subtype: 'tshirt',
            primary_color: 'red',
            crop_image_path: '/data/crop.jpg',
            enrichment_status: 'enriching',
            meta: {}
        };
        const afterUserEdit = { ...start, primary_color: 'hot pink' }; // user saved while pass was running
        // First getGarment() call = snapshot at start; second = current state at patch time
        mockAgent.db.getGarment
            .mockReturnValueOnce(start)
            .mockReturnValueOnce(afterUserEdit)
            .mockReturnValue(afterUserEdit);
        mockAgent.client.models.generateContent.mockResolvedValueOnce(mockAttrResponse({
            type: 'top',
            primary_color: 'red',  // model returns stale color
            confidence: 0.8
        }));

        await service._runAttributePass('g1');

        const attributePatch = mockAgent.db.updateGarment.mock.calls.find(c => c[0] === 'g1' && 'enrichment_confidence' in c[1])[1];
        expect(attributePatch).not.toHaveProperty('primary_color');
    });
});

describe('WardrobeService.duplicateGarment', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('cropbytes'));
        // duplicateGarment kicks off _runAttributePass in the background — stub out
        // the model call so it resolves quickly and doesn't leak into later assertions.
        mockAgent.client.models.generateContent.mockResolvedValue(mockAttrResponse({
            primary_color: 'pink', pattern: 'graphic', confidence: 0.9
        }));
    });

    test('throws when source garment is missing', async () => {
        mockAgent.db.getGarment.mockReturnValue(null);
        await expect(service.duplicateGarment('missing', 'AAAA', 'image/jpeg')).rejects.toThrow(/not found/);
    });

    test('throws on missing image data', async () => {
        await expect(service.duplicateGarment('g1', null, 'image/jpeg')).rejects.toThrow(/image data/);
    });

    test('creates new garment inheriting brand/model/type and broadcasts detected', async () => {
        const source = {
            id: 'src1', type: 'top', subtype: 'tshirt',
            brand: 'Lacoste', model: 'Club Lacoste Relaxed',
            material_guess: 'cotton', warmth: 2, formality: 1,
            size: 'M', season_tags: ['spring', 'summer'], fit_notes: null,
            primary_color: 'black', secondary_colors: [], pattern: 'solid'
        };
        const created = { ...source, id: 'new1', primary_color: null, pattern: null, source: 'duplicated', enrichment_status: 'enriching' };
        mockAgent.db.getGarment
            .mockReturnValueOnce(source)       // lookup in duplicateGarment
            .mockReturnValue(created);         // subsequent reads

        const row = await service.duplicateGarment('src1', 'AAAA', 'image/jpeg');

        const addCall = mockAgent.db.addGarment.mock.calls[0][0];
        expect(addCall.type).toBe('top');
        expect(addCall.subtype).toBe('tshirt');
        expect(addCall.brand).toBe('Lacoste');
        expect(addCall.model).toBe('Club Lacoste Relaxed');
        expect(addCall.material_guess).toBe('cotton');
        expect(addCall.warmth).toBe(2);
        expect(addCall.source).toBe('duplicated');
        expect(addCall.enrichment_status).toBe('enriching');
        expect(addCall).not.toHaveProperty('primary_color');
        expect(addCall).not.toHaveProperty('pattern');
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('wardrobe:garment:detected', expect.any(Object));
        expect(row).toBe(created);
    });
});

describe('WardrobeService misc', () => {
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        mockAgent.db.getUserProfile.mockReturnValue({ id: 1, preferred_brands: ['Lacoste', 'Lululemon'] });
    });

    test('setReferenceSelfie writes file and updates profile', async () => {
        const result = await service.setReferenceSelfie('AAAA', 'image/jpeg');
        expect(fs.writeFileSync).toHaveBeenCalled();
        expect(mockAgent.db.updateUserProfile).toHaveBeenCalledWith(
            expect.objectContaining({ reference_image_path: expect.any(String) })
        );
        expect(result.preferred_brands).toEqual(['Lacoste', 'Lululemon']);
    });

    test('clearAll wipes tables, removes files, and broadcasts', async () => {
        mockAgent.db.clearWardrobe = jest.fn().mockReturnValue({
            wr_garments: 5, wr_outfits: 2, wr_trips: 1, wr_shopping_list: 3
        });
        jest.spyOn(fs, 'readdirSync').mockImplementation((_dir) => [
            { name: 'file-a.jpg', isDirectory: () => false },
            { name: 'subdir', isDirectory: () => true }
        ]).mockImplementationOnce((_dir) => [
            { name: 'file-a.jpg', isDirectory: () => false },
            { name: 'subdir', isDirectory: () => true }
        ]).mockImplementation(() => []);
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => { });
        jest.spyOn(fs, 'rmdirSync').mockImplementation(() => { });

        const r = await service.clearAll();

        expect(mockAgent.db.clearWardrobe).toHaveBeenCalled();
        expect(r.garments).toBe(5);
        expect(r.outfits).toBe(2);
        expect(r.trips).toBe(1);
        expect(r.shopping).toBe(3);
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:cleared',
            expect.objectContaining({ counts: expect.any(Object) })
        );
    });
});

describe('WardrobeExecutor', () => {
    let executor;
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        service.ingestGarmentFromBase64 = jest.fn().mockResolvedValue({
            garments: [{ id: 'g1', type: 'shoes', subtype: 'sneakers', primary_color: 'white' }],
            matched_existing: []
        });
        executor = new WardrobeExecutor({ wardrobe: service });
    });

    test('add_garment requires image_base64', async () => {
        const r = await executor.execute('add_garment', {}, {}, { wardrobe: service });
        expect(r).toMatch(/base64/i);
    });

    test('add_garment ingests and returns summary', async () => {
        const r = await executor.execute('add_garment', { image_base64: 'AAAA' }, {}, { wardrobe: service });
        expect(service.ingestGarmentFromBase64).toHaveBeenCalledWith('AAAA', 'image/jpeg');
        expect(r).toMatch(/Added 1/);
    });

    test('list_garments empty message', async () => {
        mockAgent.db.getGarments.mockReturnValue([]);
        const r = await executor.execute('list_garments', {}, {}, { wardrobe: service });
        expect(r).toMatch(/empty/i);
    });

    test('list_garments populated list', async () => {
        mockAgent.db.getGarments.mockReturnValue([
            { id: 'g1', type: 'top', primary_color: 'navy' },
            { id: 'g2', type: 'bottom', primary_color: 'khaki', brand: 'Lululemon' }
        ]);
        const r = await executor.execute('list_garments', {}, {}, { wardrobe: service });
        expect(r).toMatch(/Found 2/);
    });

    test('update_garment broadcasts', async () => {
        mockAgent.db.getGarment.mockReturnValue({ id: 'g1', type: 'top' });
        const r = await executor.execute(
            'update_garment',
            { id: 'g1', patch: { primary_color: 'green' } },
            {}, { wardrobe: service }
        );
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:garment:update',
            expect.objectContaining({ id: 'g1' })
        );
        expect(r).toMatch(/Updated/);
    });

    test('delete_garment broadcasts', async () => {
        const r = await executor.execute('delete_garment', { id: 'g1' }, {}, { wardrobe: service });
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith(
            'wardrobe:garment:delete',
            { id: 'g1' }
        );
        expect(r).toMatch(/Deleted/);
    });

    test('unknown tool returns null', async () => {
        const r = await executor.execute('totally_unknown', {}, {}, { wardrobe: service });
        expect(r).toBeNull();
    });

    test('get_wardrobe_profile shows brands and selfie status', async () => {
        mockAgent.db.getUserProfile.mockReturnValue({
            id: 1,
            preferred_brands: ['Lacoste', 'Lululemon'],
            reference_image_path: '/x.jpg'
        });
        const r = await executor.execute('get_wardrobe_profile', {}, {}, { wardrobe: service });
        expect(r).toMatch(/Lacoste/);
        expect(r).toMatch(/Reference selfie: set/);
    });

    test('update_wardrobe_profile applies patch', async () => {
        mockAgent.db.getUserProfile.mockReturnValueOnce({ preferred_brands: ['Lacoste', 'Lululemon', 'Aesop'] });
        const r = await executor.execute(
            'update_wardrobe_profile',
            { patch: { preferred_brands: ['Lacoste', 'Lululemon', 'Aesop'] } },
            {}, { wardrobe: service }
        );
        expect(mockAgent.db.updateUserProfile).toHaveBeenCalledWith({
            preferred_brands: ['Lacoste', 'Lululemon', 'Aesop']
        });
        expect(r).toMatch(/Aesop/);
    });

    test('update_wardrobe_profile rejects empty patch', async () => {
        const r = await executor.execute('update_wardrobe_profile', { patch: {} }, {}, { wardrobe: service });
        expect(r).toMatch(/Missing patch/);
    });

    test('renamed trip tools resolve through executor', async () => {
        mockAgent.db.getTrips = jest.fn().mockReturnValue([]);
        const r = await executor.execute('list_wardrobe_trips', {}, {}, { wardrobe: service });
        expect(r).toMatch(/No trips/);
        expect(mockAgent.db.getTrips).toHaveBeenCalled();
    });

    test('renamed mark_wardrobe_item_purchased resolves through executor', async () => {
        service.markPurchased = jest.fn().mockResolvedValue({ id: 'shop_1', status: 'purchased' });
        const r = await executor.execute(
            'mark_wardrobe_item_purchased',
            { id: 'shop_1', garment_id: 'g1' },
            {}, { wardrobe: service }
        );
        expect(service.markPurchased).toHaveBeenCalledWith('shop_1', 'g1');
        expect(r).toMatch(/Marked shop_1 purchased/);
    });
});
