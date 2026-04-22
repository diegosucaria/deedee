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

    test('_normalizeBbox accepts 0-1 range unchanged', () => {
        expect(service._normalizeBbox([0.1, 0.2, 0.8, 0.9])).toEqual([0.1, 0.2, 0.8, 0.9]);
    });

    test('_normalizeBbox converts 0-1000 range to 0-1', () => {
        const r = service._normalizeBbox([100, 200, 800, 900]);
        expect(r[0]).toBeCloseTo(0.1, 5);
        expect(r[2]).toBeCloseTo(0.8, 5);
    });

    test('_normalizeBbox swaps reversed coords and clamps', () => {
        expect(service._normalizeBbox([0.8, 0.9, 0.1, 0.2])).toEqual([0.1, 0.2, 0.8, 0.9]);
        expect(service._normalizeBbox([-0.1, -0.1, 1.5, 1.5])).toEqual([0, 0, 1, 1]);
    });

    test('_normalizeBbox rejects malformed input', () => {
        expect(service._normalizeBbox(null)).toEqual([0, 0, 1, 1]);
        expect(service._normalizeBbox([1, 2, 3])).toEqual([0, 0, 1, 1]);
        expect(service._normalizeBbox(['a', 'b', 'c', 'd'])).toEqual([0, 0, 1, 1]);
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

    test('multi-item ingest creates one row per detection, each with its own crop', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.05, 0.05, 0.45, 0.45], type: 'top', subtype: 'tshirt', primary_color: 'white', secondary_colors: [], season_tags: [], detection_confidence: 0.9 },
            { bbox: [0.55, 0.05, 0.95, 0.45], type: 'bottom', subtype: 'chinos', primary_color: 'khaki', secondary_colors: [], season_tags: [], detection_confidence: 0.85 },
            { bbox: [0.3, 0.5, 0.7, 0.95], type: 'shoes', primary_color: 'white', secondary_colors: [], season_tags: [], detection_confidence: 0.88 }
        ]);
        mockAgent.db.addGarment
            .mockReturnValueOnce('g1')
            .mockReturnValueOnce('g2')
            .mockReturnValueOnce('g3');

        const created = await service.ingestGarmentFromBase64('AAAA', 'image/jpeg');

        expect(service._cropToFile).toHaveBeenCalledTimes(3);
        expect(mockAgent.db.addGarment).toHaveBeenCalledTimes(3);
        expect(mockAgent.db.addGarment).toHaveBeenNthCalledWith(1, expect.objectContaining({
            type: 'top', enrichment_status: 'enriching'
        }));
        const broadcastEvents = mockAgent.interface.broadcast.mock.calls.map(c => c[0]);
        expect(broadcastEvents.filter(e => e === 'wardrobe:garment:detected')).toHaveLength(3);
        expect(service._runAttributePass).toHaveBeenCalledTimes(3);
        expect(created).toHaveLength(3);
    });

    test('full-frame bbox reuses source image without cropping', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0, 0, 1, 1], type: null, secondary_colors: [], season_tags: [] }
        ]);
        mockAgent.db.addGarment.mockReturnValueOnce('gfull');

        await service.ingestGarmentFromBase64('AAAA');

        expect(service._cropToFile).not.toHaveBeenCalled();
        expect(mockAgent.db.addGarment).toHaveBeenCalledWith(expect.objectContaining({
            source_image_path: expect.any(String)
        }));
        const addArgs = mockAgent.db.addGarment.mock.calls[0][0];
        expect(addArgs.crop_image_path).toBe(addArgs.source_image_path);
    });

    test('crop failure does not abort ingestion; row still created using source image', async () => {
        service._detectItems = jest.fn().mockResolvedValue([
            { bbox: [0.1, 0.1, 0.5, 0.5], type: 'top', secondary_colors: [], season_tags: [] }
        ]);
        service._cropToFile = jest.fn().mockRejectedValue(new Error('sharp error'));
        mockAgent.db.addGarment.mockReturnValueOnce('gx');

        const created = await service.ingestGarmentFromBase64('AAAA');

        expect(mockAgent.db.addGarment).toHaveBeenCalled();
        const args = mockAgent.db.addGarment.mock.calls[0][0];
        expect(args.crop_image_path).toBe(args.source_image_path);
        expect(created).toHaveLength(1);
    });

    test('empty image input throws', async () => {
        await expect(service.ingestGarmentFromBase64('')).rejects.toThrow('Missing image data');
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
});

describe('WardrobeExecutor', () => {
    let executor;
    let service;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new WardrobeService(mockAgent);
        service.ingestGarmentFromBase64 = jest.fn().mockResolvedValue([
            { id: 'g1', type: 'shoes', subtype: 'sneakers', primary_color: 'white' }
        ]);
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
