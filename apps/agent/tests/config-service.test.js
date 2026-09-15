const path = require('path');

const MODULE = path.join(__dirname, '..', 'src', 'services', 'config-service');
const ENV_VARS = [
    'WORKER_FLASH', 'WORKER_LITE', 'WORKER_PRO', 'GEMINI_IMAGE_MODEL', 'GEMINI_TTS_MODEL',
    'ROUTER_MODEL', 'WORKER_GOOGLE_SEARCH', 'WORKER_LIVE', 'GEMINI_EMBEDDING_MODEL'
];

function loadWithEnv(overrides = {}) {
    const saved = {};
    for (const k of ENV_VARS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, overrides);
    let mod;
    jest.isolateModules(() => { mod = require(MODULE); });
    for (const k of ENV_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    return mod;
}

describe('ConfigService model roles', () => {
    test('defaults are the Gemini 3.x GA ids', () => {
        const { ConfigService } = loadWithEnv();
        const c = new ConfigService();
        expect(c.getModel('ROUTER')).toBe('gemini-3.1-flash-lite');
        expect(c.getModel('LITE')).toBe('gemini-3.1-flash-lite');
        expect(c.getModel('FLASH')).toBe('gemini-3.6-flash');
        expect(c.getModel('SEARCH')).toBe('gemini-3.6-flash');
        expect(c.getModel('PRO')).toBe('gemini-3.1-pro-preview');
        expect(c.getModel('IMAGE')).toBe('gemini-3.1-flash-image');
        expect(c.getModel('TTS')).toBe('gemini-2.5-flash-preview-tts');
        expect(c.getModel('LIVE')).toBe('gemini-3.8-live');
        expect(c.getModel('EMBEDDING')).toBe('gemini-embedding-2');
    });

    test('every default id has an exact pricing row', () => {
        const { ConfigService, CONSTANTS } = loadWithEnv();
        for (const [role, id] of Object.entries(CONSTANTS.MODELS)) {
            expect(CONSTANTS.PRICING[id]).toBeDefined();
            expect(new ConfigService().getPricing(id)).toBe(CONSTANTS.PRICING[id]);
            expect(CONSTANTS.MODEL_ENV_VARS[role]).toBeDefined();
        }
    });

    test('env vars override each role (Balena rollback path)', () => {
        const { ConfigService } = loadWithEnv({
            WORKER_FLASH: 'gemini-3-flash-preview',
            GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2-preview',
            WORKER_LIVE: 'gemini-2.5-flash-native-audio-preview-12-2025'
        });
        const c = new ConfigService();
        expect(c.getModel('FLASH')).toBe('gemini-3-flash-preview');
        expect(c.getModel('EMBEDDING')).toBe('gemini-embedding-2-preview');
        expect(c.getModel('LIVE')).toBe('gemini-2.5-flash-native-audio-preview-12-2025');
        expect(c.getModel('LITE')).toBe('gemini-3.1-flash-lite');
        expect(c.getModelEnvVar('FLASH')).toBe('WORKER_FLASH');
    });

    test('unknown role falls back to FLASH', () => {
        const { ConfigService } = loadWithEnv();
        expect(new ConfigService().getModel('NOPE')).toBe('gemini-3.6-flash');
    });
});

describe('ConfigService pricing', () => {
    const { ConfigService } = require(MODULE);
    const c = new ConfigService();
    const M = 1_000_000;

    test.each([
        ['gemini-3.6-flash', 0.75, 3.75],
        ['gemini-3.7-flash', 0.75, 3.75],
        ['gemini-3.8-flash', 0.75, 3.75],
        ['gemini-3.1-flash-lite', 0.25, 1.50],
        ['gemini-3.5-flash-lite', 0.30, 2.50],
        ['gemini-3.8-live', 3.00, 12.00],
        ['gemini-embedding-2', 0.20, 0],
        ['gemini-embedding-2-preview', 0.20, 0],
        ['gemini-2.5-flash-preview-tts', 0.50, 10.00],
    ])('%s bills %s in / %s out per 1M', (model, input, output) => {
        expect(c.calculateCost(model, M, 0)).toBeCloseTo(input, 6);
        expect(c.calculateCost(model, 0, M)).toBeCloseTo(output, 6);
    });

    test('cached input is 10% of the input rate (gemini-3.6-flash: 0.075)', () => {
        expect(c.calculateCost('gemini-3.6-flash', M, 0, M)).toBeCloseTo(0.075, 6);
    });

    test('thinking tokens bill at the output rate', () => {
        expect(c.calculateCost('gemini-3.6-flash', 0, 0, 0, M)).toBeCloseTo(3.75, 6);
    });

    test('Pro keeps the >200k tier', () => {
        expect(c.calculateCost('gemini-3.1-pro-preview', 200_000, 0)).toBeCloseTo(0.40, 6);
        expect(c.calculateCost('gemini-3.1-pro-preview', 200_001, 0)).toBeCloseTo(0.800004, 6);
    });

    test('image models: image tokens at the image rate, text tokens at the text rate', () => {
        // Without a modality split everything is billed as image output.
        expect(c.calculateCost('gemini-3.1-flash-image', 0, M)).toBeCloseTo(60, 6);
        expect(c.calculateCost('gemini-3-pro-image', 0, M)).toBeCloseTo(120, 6);
        expect(c.calculateCost('gemini-3.1-flash-image', M, 0)).toBeCloseTo(0.50, 6);
        expect(c.calculateCost('gemini-3-pro-image', M, 0)).toBeCloseTo(2.00, 6);
        // With the split: 1000 output tokens, 900 image + 100 text.
        expect(c.calculateCost('gemini-3.1-flash-image', 0, 1000, 0, 0, 900))
            .toBeCloseTo((900 / M) * 60 + (100 / M) * 3, 9);
        expect(c.calculateCost('gemini-3-pro-image', 0, 1000, 0, 0, 900))
            .toBeCloseTo((900 / M) * 120 + (100 / M) * 12, 9);
        // Image tokens cannot exceed output tokens.
        expect(c.calculateCost('gemini-3.1-flash-image', 0, 100, 0, 0, 500)).toBeCloseTo((100 / M) * 60, 9);
    });

    test('image split is ignored for models without a text output rate', () => {
        expect(c.calculateCost('gemini-3.6-flash', 0, 1000, 0, 0, 900)).toBeCloseTo((1000 / M) * 3.75, 9);
    });

    describe('name heuristics for ids not in the table', () => {
        test('a 3.x flash id is not priced as the old 0.50/3.00', () => {
            expect(c.calculateCost('gemini-3.9-flash', M, 0)).toBeCloseTo(0.75, 6);
            expect(c.calculateCost('gemini-3.9-flash', 0, M)).toBeCloseTo(3.75, 6);
        });
        test('a flash image id is not priced at the 120 pro image rate', () => {
            expect(c.calculateCost('gemini-4-flash-image', 0, M)).toBeCloseTo(60, 6);
            expect(c.calculateCost('gemini-4-flash-image', M, 0)).toBeCloseTo(0.50, 6);
        });
        test('a pro image id keeps the pro image rate', () => {
            expect(c.calculateCost('gemini-4-pro-image', 0, M)).toBeCloseTo(120, 6);
        });
        test('lite, pro, live, tts and embedding ids land on their family', () => {
            expect(c.calculateCost('gemini-4-flash-lite', 0, M)).toBeCloseTo(2.50, 6);
            expect(c.calculateCost('gemini-4-pro', 100_000, 0)).toBeCloseTo(0.20, 6);
            expect(c.calculateCost('gemini-4.2-live', M, 0)).toBeCloseTo(3.00, 6);
            expect(c.calculateCost('gemini-4-flash-tts', 0, M)).toBeCloseTo(10.00, 6);
            expect(c.calculateCost('gemini-embedding-3', M, M)).toBeCloseTo(0.20, 6);
        });
    });

    test('logUsageFromResponse splits image output from candidatesTokensDetails', () => {
        const db = { logTokenUsage: jest.fn() };
        const result = {
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 1300,
                totalTokenCount: 1400,
                candidatesTokensDetails: [
                    { modality: 'IMAGE', tokenCount: 1290 },
                    { modality: 'TEXT', tokenCount: 10 }
                ]
            }
        };
        const { cost, tokens } = c.logUsageFromResponse(db, 'gemini-3.1-flash-image', result, 'chat-1', 'image_gen');
        expect(tokens).toBe(1400);
        expect(cost).toBeCloseTo((100 / M) * 0.5 + (1290 / M) * 60 + (10 / M) * 3, 9);
        expect(db.logTokenUsage).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-3.1-flash-image', promptTokens: 100, candidateTokens: 1300, tag: 'image_gen', estimatedCost: cost
        }));
    });

    test('logUsageFromResponse without db or usage is a no-op', () => {
        expect(c.logUsageFromResponse(null, 'gemini-3.6-flash', { usageMetadata: {} })).toEqual({ cost: 0, tokens: 0 });
        expect(c.logUsageFromResponse({ logTokenUsage: jest.fn() }, 'gemini-3.6-flash', {})).toEqual({ cost: 0, tokens: 0 });
    });
});
