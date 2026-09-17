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
        expect(c.getModel('IMAGE')).toBe('gemini-3-pro-image');
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

    test('logUsageFromResponse passes prompt estimates through and leaves them out otherwise', () => {
        const db = { logTokenUsage: jest.fn() };
        const result = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } };
        c.logUsageFromResponse(db, 'gemini-3.6-flash', result, 'chat-1', 'chat', { sysTokensEst: 400, toolsTokensEst: 90, historyTokensEst: 12, declCount: 7, prefixHash: 'abc' });
        expect(db.logTokenUsage).toHaveBeenLastCalledWith(expect.objectContaining({
            tag: 'chat', sysTokensEst: 400, toolsTokensEst: 90, historyTokensEst: 12, declCount: 7
        }));
        expect(db.logTokenUsage.mock.calls[0][0]).not.toHaveProperty('prefixHash');

        c.logUsageFromResponse(db, 'gemini-3.6-flash', result, 'chat-1', 'title');
        const plain = db.logTokenUsage.mock.calls[1][0];
        expect(plain.tag).toBe('title');
        for (const k of ['sysTokensEst', 'toolsTokensEst', 'historyTokensEst', 'declCount']) expect(plain).not.toHaveProperty(k);
    });

    test('logUsageFromResponse without db or usage is a no-op', () => {
        expect(c.logUsageFromResponse(null, 'gemini-3.6-flash', { usageMetadata: {} })).toEqual({ cost: 0, tokens: 0 });
        expect(c.logUsageFromResponse({ logTokenUsage: jest.fn() }, 'gemini-3.6-flash', {})).toEqual({ cost: 0, tokens: 0 });
    });
});

describe('ConfigService thinking levels', () => {
    const THINKING_ENV = Object.keys(process.env).filter(k => k.startsWith('THINKING_'));
    let saved;
    beforeEach(() => {
        saved = {};
        for (const k of THINKING_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
        for (const k of Object.keys(process.env)) if (k.startsWith('THINKING_')) delete process.env[k];
        Object.assign(process.env, saved);
    });

    test.each([
        ['ROUTER', 'router', 'MINIMAL'],
        ['LITE', 'cron_helper', 'MINIMAL'],
        ['LITE', 'eager_extract', 'MINIMAL'],
        ['SEARCH', 'search', 'LOW'],
        ['FLASH', 'chat', 'LOW'],
        ['FLASH', 'tool_loop', 'LOW'],
        ['FLASH', 'job', 'LOW'],
        ['FLASH', 'subagent', 'LOW'],
        ['FLASH', 'watcher', 'LOW'],
        ['FLASH', 'summarization', 'MINIMAL'],
        ['FLASH', 'title', 'MINIMAL'],
        ['FLASH', 'scoper', 'MINIMAL'],
        ['FLASH', 'people_enrich', 'MINIMAL'],
        ['FLASH', 'cron_helper', 'MINIMAL'],
        ['FLASH', 'analysis', 'MINIMAL'],
        ['FLASH', 'transcribe', 'MINIMAL'],
        ['FLASH', 'partner_greeting', 'MINIMAL'],
        ['FLASH', 'dj', 'MINIMAL'],
        ['FLASH', 'wardrobe', 'LOW'],
        ['PRO', 'chat', 'MEDIUM'],
        ['PRO', 'tool_loop', 'LOW'],
        ['PRO', 'dream', 'LOW'],
        ['PRO', 'pruning', 'LOW'],
        ['PRO', 'job', 'MEDIUM'],
        ['PRO', 'subagent', 'MEDIUM'],
        ['PRO', 'consolidation', 'MEDIUM'],
        ['PRO', 'wardrobe', 'MEDIUM'],
        ['PRO', 'coding', 'HIGH'],
        ['PRO', 'dj', 'LOW'],
    ])('%s %s -> %s', (role, cls, level) => {
        const { ConfigService } = loadWithEnv();
        expect(new ConfigService().getThinking(role, cls).thinkingLevel).toBe(level);
    });

    test('class names are case-insensitive and default to chat', () => {
        const { ConfigService } = loadWithEnv();
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'JOB').thinkingLevel).toBe('MEDIUM');
        expect(c.getThinking('PRO').thinkingLevel).toBe('MEDIUM');
        expect(c.getThinking('pro', 'chat').thinkingLevel).toBe('MEDIUM');
        expect(c.getThinking('PRO', 'dream').thinkingLevel).toBe('LOW');
    });

    test('THINKING_<ROLE> sets every class of the role, THINKING_<ROLE>_<CLASS> one class', () => {
        const { ConfigService } = loadWithEnv();
        Object.assign(process.env, { THINKING_PRO: 'HIGH', THINKING_PRO_CHAT: 'medium', THINKING_FLASH_TITLE: 'LOW' });
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'chat').thinkingLevel).toBe('MEDIUM');
        expect(c.getThinking('PRO', 'job').thinkingLevel).toBe('HIGH');
        expect(c.getThinking('PRO', 'tool_loop').thinkingLevel).toBe('HIGH');
        // Every listed class, not only the ones missing from the table.
        expect(c.getThinking('PRO', 'pruning').thinkingLevel).toBe('HIGH');
        expect(c.getThinking('FLASH', 'title').thinkingLevel).toBe('LOW');
        expect(c.getThinking('FLASH', 'chat').thinkingLevel).toBe('LOW');
    });

    test('THINKING_PRO_TOOL_LOOP raises the loop without touching chat', () => {
        const { ConfigService } = loadWithEnv();
        process.env.THINKING_PRO_TOOL_LOOP = 'MEDIUM';
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'chat').thinkingLevel).toBe('MEDIUM');
        expect(c.getThinking('PRO', 'tool_loop').thinkingLevel).toBe('MEDIUM');
    });

    test('a bad env value is ignored and warned once', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const { ConfigService } = loadWithEnv();
        process.env.THINKING_ROUTER = 'TURBO';
        const c = new ConfigService();
        expect(c.getThinking('ROUTER', 'router').thinkingLevel).toBe('MINIMAL');
        expect(c.getThinking('ROUTER', 'router').thinkingLevel).toBe('MINIMAL');
        expect(warn.mock.calls.filter(([m]) => String(m).includes('THINKING_ROUTER')).length).toBe(1);
        warn.mockRestore();
    });

    test('guard: Pro never gets MINIMAL, even by env', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const { ConfigService } = loadWithEnv();
        process.env.THINKING_PRO = 'MINIMAL';
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'chat').thinkingLevel).toBe('LOW');
        expect(c.getThinking('PRO', 'title').thinkingLevel).toBe('LOW');
        expect(c.getThinking('PRO', 'chat', { model: 'gemini-3-pro-preview' }).thinkingLevel).toBe('LOW');
        expect(c.getThinking('PRO', 'chat', { model: 'gemini-3.9-pro-something' }).thinkingLevel).toBe('LOW');
        warn.mockRestore();
    });

    test('guard: gemini-3.8-flash and 3.7-flash raise MINIMAL to LOW and log once per model', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const { ConfigService } = loadWithEnv({ WORKER_FLASH: 'gemini-3.8-flash' });
        const c = new ConfigService();
        expect(c.getThinking('FLASH', 'title').thinkingLevel).toBe('LOW');
        expect(c.getThinking('FLASH', 'summarization').thinkingLevel).toBe('LOW');
        expect(c.getThinking('FLASH', 'chat').thinkingLevel).toBe('LOW');
        expect(c.getThinking('FLASH', 'title', { model: 'gemini-3.7-flash' }).thinkingLevel).toBe('LOW');
        const raised = warn.mock.calls.filter(([m]) => String(m).includes('does not accept thinkingLevel MINIMAL'));
        expect(raised.length).toBe(2); // once for 3.8-flash, once for 3.7-flash
        warn.mockRestore();
    });

    test('guard: models that accept every level keep MINIMAL', () => {
        const { ConfigService } = loadWithEnv();
        const c = new ConfigService();
        for (const model of ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview']) {
            expect(c.getThinking('FLASH', 'title', { model }).thinkingLevel).toBe('MINIMAL');
        }
        expect(c.getModelThinkingLevels('gemini-3.1-pro-preview')).toEqual(['LOW', 'MEDIUM', 'HIGH']);
        expect(c.getModelThinkingLevels('gemini-3.6-flash')).toEqual(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
    });

    test('non-3.x ids never get a thinkingLevel', () => {
        const { ConfigService } = loadWithEnv({ WORKER_PRO: 'gemini-2.5-pro' });
        process.env.THINKING_PRO = 'HIGH';
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'chat').thinkingLevel).toBeNull();
        expect(c.getThinking('FLASH', 'chat', { model: 'gemini-2.5-flash' }).thinkingLevel).toBeNull();
        expect(c.getThinkingConfig('PRO', 'chat', { source: 'whatsapp' })).toBeNull();
        expect(c.getThinkingConfig('PRO', 'chat', { source: 'web' })).toEqual({ includeThoughts: true });
        expect(c.getModelThinkingLevels('gemini-2.5-flash')).toBeNull();
    });

    test('includeThoughts only for web and live', () => {
        const { ConfigService } = loadWithEnv();
        const c = new ConfigService();
        expect(c.getThinking('PRO', 'chat', { source: 'web' }).includeThoughts).toBe(true);
        expect(c.getThinking('PRO', 'chat', { source: 'live' }).includeThoughts).toBe(true);
        for (const source of ['whatsapp', 'whatsapp_group', 'telegram', 'slack', 'ios', 'scheduler', 'subagent', 'system', 'http', undefined]) {
            expect(c.getThinking('PRO', 'chat', { source }).includeThoughts).toBe(false);
        }
    });

    test('getThinkingConfig never carries thinkingBudget and omits a false includeThoughts', () => {
        const { ConfigService } = loadWithEnv();
        const c = new ConfigService();
        expect(c.getThinkingConfig('PRO', 'chat', { source: 'web' })).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true });
        expect(c.getThinkingConfig('PRO', 'chat', { source: 'whatsapp' })).toEqual({ thinkingLevel: 'MEDIUM' });
        expect(c.getThinkingConfig('FLASH', 'title')).toEqual({ thinkingLevel: 'MINIMAL' });
        expect(Object.keys(c.getThinkingConfig('PRO', 'coding'))).not.toContain('thinkingBudget');
    });
});
