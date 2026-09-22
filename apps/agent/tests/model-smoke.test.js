const path = require('path');

const smoke = require(path.join(__dirname, '..', 'scripts', 'model-smoke.js'));
const { parseArgs, buildPlan, runSmoke, formatTable, main, DEFAULTS, ROLE_ORDER } = smoke;

const MODELS = {
    ROUTER: 'gemini-3.1-flash-lite', LITE: 'gemini-3.1-flash-lite', FLASH: 'gemini-3.6-flash',
    SEARCH: 'gemini-3.6-flash', PRO: 'gemini-3.1-pro-preview', TTS: 'gemini-2.5-flash-preview-tts',
    IMAGE: 'gemini-3-pro-image', EMBEDDING: 'gemini-embedding-2', LIVE: 'gemini-3.8-live'
};

const usage = (extra = {}) => ({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, ...extra });

function fakeClient(overrides = {}) {
    const client = {
        models: {
            get: jest.fn(async ({ model }) => ({ name: `models/${model}`, displayName: model, version: '001' })),
            generateContent: jest.fn(async ({ contents, config }) => {
                if (config?.responseModalities?.includes('AUDIO')) {
                    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: 'AAAA' } }] } }], usageMetadata: usage() };
                }
                if (config?.responseModalities?.includes('IMAGE')) {
                    return {
                        candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
                        usageMetadata: usage({ candidatesTokenCount: 1300, totalTokenCount: 1310, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 10 }] })
                    };
                }
                if (config?.tools) {
                    const answered = Array.isArray(contents) && contents.some(c => c.parts?.some(p => p.functionResponse));
                    if (!answered) {
                        const part = { functionCall: { name: 'getTime', args: {} }, thoughtSignature: 'sig-1' };
                        return { functionCalls: [part.functionCall], candidates: [{ content: { role: 'model', parts: [part] } }], usageMetadata: usage() };
                    }
                    return { text: 'It is noon.', candidates: [{ content: { parts: [{ text: 'It is noon.' }] } }], usageMetadata: usage() };
                }
                const level = config?.thinkingConfig?.thinkingLevel;
                return {
                    text: 'OK',
                    candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
                    usageMetadata: usage({ thoughtsTokenCount: level === 'HIGH' ? 50 : 2 })
                };
            }),
            embedContent: jest.fn(async () => ({ embeddings: [{ values: new Array(768).fill(0.1) }], usageMetadata: usage() }))
        },
        authTokens: { create: jest.fn(async () => ({ name: 'auth_tokens/abc123' })) }
    };
    Object.assign(client.models, overrides.models || {});
    if (overrides.authTokens) client.authTokens = overrides.authTokens;
    return client;
}

describe('model-smoke parseArgs', () => {
    test('defaults', () => {
        expect(parseArgs([])).toEqual({ ...DEFAULTS, skip: [] });
    });
    test('flags', () => {
        const o = parseArgs(['--with-image', '--only', 'lite,Flash', '--skip', 'live', '--checks', 'get,TEXT', '--timeout', '5000', '--max-tokens', '40', '--json']);
        expect(o.withImage).toBe(true);
        expect(o.only).toEqual(['LITE', 'FLASH']);
        expect(o.skip).toEqual(['LIVE']);
        expect(o.checks).toEqual(['get', 'text']);
        expect(o.timeout).toBe(5000);
        expect(o.maxTokens).toBe(40);
        expect(o.json).toBe(true);
    });
    test('help', () => {
        expect(parseArgs(['--help']).help).toBe(true);
        expect(parseArgs(['-h']).help).toBe(true);
    });
    test.each([
        [['--bogus']], [['--only']], [['--only', 'NOPE']], [['--checks', 'dance']], [['--timeout', 'x']], [['--timeout', '0']], [['--max-tokens', '-1']]
    ])('rejects %j', (argv) => {
        expect(() => parseArgs(argv)).toThrow();
    });
});

describe('model-smoke buildPlan', () => {
    test('every role gets models.get plus its own checks; image is skipped without the flag', () => {
        const plan = buildPlan(MODELS, parseArgs([]));
        const byRole = {};
        for (const p of plan) (byRole[p.role] ||= []).push(p.check);
        expect(Object.keys(byRole)).toEqual(ROLE_ORDER);
        expect(byRole.FLASH).toEqual(['get', 'text', 'tools', 'thinking']);
        expect(byRole.TTS).toEqual(['get', 'tts']);
        expect(byRole.EMBEDDING).toEqual(['get', 'embed']);
        expect(byRole.LIVE).toEqual(['get', 'live']);
        const image = plan.find(p => p.check === 'image');
        expect(image.skip).toMatch(/--with-image/);
        expect(buildPlan(MODELS, parseArgs(['--with-image'])).find(p => p.check === 'image').skip).toBeUndefined();
    });
    test('--only, --skip and --checks filter the plan', () => {
        expect(buildPlan(MODELS, parseArgs(['--only', 'PRO', '--checks', 'text'])))
            .toEqual([{ role: 'PRO', model: 'gemini-3.1-pro-preview', check: 'text' }]);
        expect(buildPlan(MODELS, parseArgs(['--skip', 'LIVE,IMAGE,TTS'])).map(p => p.role)).not.toEqual(expect.arrayContaining(['LIVE', 'IMAGE', 'TTS']));
    });
    test('roles without a model id are left out', () => {
        expect(buildPlan({ FLASH: 'x' }, parseArgs([])).every(p => p.role === 'FLASH')).toBe(true);
    });
});

describe('model-smoke runSmoke', () => {
    let savedDims;
    beforeAll(() => { savedDims = process.env.EMBEDDING_DIMENSIONS; process.env.EMBEDDING_DIMENSIONS = '768'; });
    afterAll(() => { if (savedDims === undefined) delete process.env.EMBEDDING_DIMENSIONS; else process.env.EMBEDDING_DIMENSIONS = savedDims; });

    test('all checks pass with a healthy client', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--with-image']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        const fails = res.rows.filter(r => r.status !== 'ok');
        expect(fails).toEqual([]);
        expect(res.exitCode).toBe(0);
        expect(res.failed).toBe(0);
        expect(res.cost).toBeGreaterThan(0);

        const pro = res.rows.find(r => r.role === 'PRO' && r.check === 'thinking');
        expect(pro.note).toBe('HIGH: thoughts=50');
        expect(pro.thoughts).toBe(50);
        const lite = res.rows.find(r => r.role === 'LITE' && r.check === 'thinking');
        expect(lite.note).toMatch(/MINIMAL: thoughts=/);

        const image = res.rows.find(r => r.check === 'image');
        expect(image.note).toMatch(/^image\/png/);
        expect(image.cost).toBeCloseTo((10 / 1e6) * 2.0 + (1290 / 1e6) * 120 + (10 / 1e6) * 12, 9); // gemini-3-pro-image rates

        expect(res.rows.find(r => r.check === 'tts').note).toMatch(/^audio\//);
        expect(res.rows.find(r => r.check === 'embed').note).toBe('768 dims');
        expect(res.rows.find(r => r.check === 'live').status).toBe('ok');
        expect(client.authTokens.create).toHaveBeenCalledWith({
            config: expect.objectContaining({
                uses: 1,
                liveConnectConstraints: { model: 'gemini-3.8-live', config: { responseModalities: ['AUDIO'] } },
                httpOptions: { apiVersion: 'v1alpha' }
            })
        });
    });

    test('roles that share a model id share the call', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'ROUTER,LITE', '--checks', 'text']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
        expect(res.rows).toHaveLength(2);
        expect(res.rows[1].status).toBe('ok');
        expect(res.rows[1].note).toMatch(/^same as ROUTER/);
        expect(res.rows[1].tokens).toBe(0); // not counted twice
    });

    test('thinking uses the role level; text uses the lowest level the model accepts', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'PRO,LITE', '--checks', 'text,thinking']);
        await runSmoke(client, buildPlan(MODELS, opts), opts);
        const levels = client.models.generateContent.mock.calls.map(([p]) => [p.model, p.config?.thinkingConfig?.thinkingLevel, p.config?.maxOutputTokens]);
        expect(levels).toEqual(expect.arrayContaining([
            ['gemini-3.1-flash-lite', 'MINIMAL', 20], ['gemini-3.1-flash-lite', 'MINIMAL', undefined],
            ['gemini-3.1-pro-preview', 'LOW', smoke.TEXT_THINKING_BUDGET], ['gemini-3.1-pro-preview', 'HIGH', undefined]
        ]));
    });

    test('non-3.x ids get no thinkingLevel and the thinking check is skipped', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'FLASH', '--checks', 'text,thinking']);
        const res = await runSmoke(client, buildPlan({ FLASH: 'gemini-2.5-flash' }, opts), opts);
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
        expect(client.models.generateContent.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
        expect(res.rows.find(r => r.check === 'thinking').status).toBe('skip');
        expect(res.exitCode).toBe(0);
    });

    test('the function-call round trip sends the model turn back whole', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'FLASH', '--checks', 'tools']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(res.rows[0].status).toBe('ok');
        const second = client.models.generateContent.mock.calls[1][0];
        expect(second.contents[1].parts[0].thoughtSignature).toBe('sig-1');
        expect(second.contents[2].parts[0].functionResponse.name).toBe('getTime');
    });

    test('failures set exit code 1 and carry the reason', async () => {
        const client = fakeClient({
            models: {
                embedContent: jest.fn(async () => ({ embeddings: [{ values: new Array(1536).fill(0.1) }] })),
                get: jest.fn(async () => { const e = new Error('404 Not Found'); throw e; })
            },
            authTokens: { create: jest.fn(async () => ({ name: 'nope' })) }
        });
        const opts = parseArgs(['--only', 'EMBEDDING,LIVE']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(res.exitCode).toBe(1);
        expect(res.rows.find(r => r.check === 'get').note).toMatch(/404/);
        expect(res.rows.find(r => r.check === 'embed').note).toMatch(/got 1536 dims, EMBEDDING_DIMENSIONS=768/);
        expect(res.rows.find(r => r.check === 'live').note).toMatch(/auth_tokens\//);
    });

    test('empty text is a failure that reports the finish reason', async () => {
        const client = fakeClient({
            models: { generateContent: jest.fn(async () => ({ text: '', candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }], usageMetadata: usage() })) }
        });
        const opts = parseArgs(['--only', 'FLASH', '--checks', 'text']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(res.rows[0].status).toBe('fail');
        expect(res.rows[0].note).toMatch(/MAX_TOKENS/);
    });

    test('the text check gives room to think to models without MINIMAL', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'PRO,LITE', '--checks', 'text']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(res.rows.filter(r => r.status !== 'ok')).toEqual([]);
        const calls = client.models.generateContent.mock.calls.map(([args]) => args);
        const pro = calls.find(a => /pro/.test(a.model));
        const lite = calls.find(a => /lite/.test(a.model));
        expect(pro.config.maxOutputTokens).toBe(smoke.TEXT_THINKING_BUDGET);
        expect(pro.config.thinkingConfig.thinkingLevel).toBe('LOW');
        expect(lite.config.maxOutputTokens).toBe(DEFAULTS.maxTokens);
        expect(lite.config.thinkingConfig.thinkingLevel).toBe('MINIMAL');
    });

    test('a hanging call times out', async () => {
        const client = fakeClient({ models: { get: jest.fn(() => new Promise(() => { })) } });
        const opts = parseArgs(['--only', 'TTS', '--checks', 'get', '--timeout', '20']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        expect(res.rows[0].status).toBe('fail');
        expect(res.rows[0].note).toMatch(/timed out after 20 ms/);
    });

    test('formatTable lists every row with the role, model and result', async () => {
        const client = fakeClient();
        const opts = parseArgs(['--only', 'FLASH,EMBEDDING']);
        const res = await runSmoke(client, buildPlan(MODELS, opts), opts);
        const table = formatTable(res.rows);
        expect(table.split('\n')[0]).toMatch(/^Role\s+Model\s+Check\s+Result/);
        expect(table).toMatch(/FLASH\s+gemini-3\.6-flash\s+text\s+OK/);
        expect(table).toMatch(/EMBEDDING\s+gemini-embedding-2\s+embed\s+OK/);
    });
});

describe('model-smoke main', () => {
    const out = () => ({ log: jest.fn(), error: jest.fn() });

    test('--help prints usage and exits 0', async () => {
        const o = out();
        expect(await main(['--help'], o)).toBe(0);
        expect(o.log.mock.calls[0][0]).toMatch(/^Usage:/);
    });
    test('bad flag exits 2 with usage', async () => {
        const o = out();
        expect(await main(['--nope'], o)).toBe(2);
        expect(o.error.mock.calls[0][0]).toMatch(/unknown option --nope/);
    });
    test('missing GOOGLE_API_KEY exits 2 before any call', async () => {
        const saved = process.env.GOOGLE_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        try {
            const o = out();
            expect(await main(['--only', 'LITE', '--checks', 'get'], o)).toBe(2);
            expect(o.error.mock.calls.some(([m]) => /GOOGLE_API_KEY/.test(m))).toBe(true);
        } finally {
            if (saved !== undefined) process.env.GOOGLE_API_KEY = saved;
        }
    });
});

// The run is written to DATA_DIR/model-smoke.json so GET /internal/models can
// show it. The faults guarded against: a role that failed one check reported
// as ok, and an unwritable folder taking the smoke check itself down.
const fs = require('fs');
const os = require('os');
const { summarizeByRole, writeResult, resultPath } = smoke;

describe('model-smoke result file', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-smoke-write-'));
        delete process.env.MODEL_SMOKE_WRITE;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const rows = [
        { role: 'LITE', model: 'a', check: 'get', status: 'ok', ms: 100, note: '' },
        { role: 'LITE', model: 'a', check: 'text', status: 'ok', ms: 200, note: '"OK"' },
        { role: 'PRO', model: 'b', check: 'get', status: 'ok', ms: 50, note: '' },
        { role: 'PRO', model: 'b', check: 'text', status: 'fail', ms: 60000, note: 'timed out after 60000 ms' },
        { role: 'IMAGE', model: 'c', check: 'image', status: 'skip', ms: 0, note: 'pass --with-image to run' }
    ];

    test('one row per role: any failed check fails the role', () => {
        const byRole = summarizeByRole(rows);
        expect(byRole.map(r => [r.role, r.status, r.ms])).toEqual([
            ['LITE', 'ok', 300], ['PRO', 'fail', 60050], ['IMAGE', 'skip', 0]
        ]);
        expect(byRole.find(r => r.role === 'PRO').error).toBe('timed out after 60000 ms');
        expect(byRole.find(r => r.role === 'LITE').error).toBeNull();
        expect(byRole.find(r => r.role === 'LITE').checks).toHaveLength(2);
    });

    test('a role whose checks were all skipped is not called ok', () => {
        expect(summarizeByRole([{ role: 'IMAGE', model: 'c', check: 'image', status: 'skip', ms: 0, note: '' }])[0].status).toBe('skip');
    });

    test('the file holds the roles, the counts and a timestamp', () => {
        const file = writeResult({ rows, ok: 3, failed: 1, skipped: 1, cost: 0.002 }, { LITE: 'a', PRO: 'b', IMAGE: 'c' }, dir);
        expect(file).toBe(resultPath(dir));
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(Date.parse(saved.at)).not.toBeNaN();
        expect([saved.ok, saved.failed, saved.skipped]).toEqual([3, 1, 1]);
        expect(saved.roles.map(r => r.role)).toEqual(['LITE', 'PRO', 'IMAGE']);
        expect(saved.roles.find(r => r.role === 'PRO').model).toBe('b');
    });

    test('a key quoted in an error never reaches the file', () => {
        // Built at run time so no key-shaped string sits in the source.
        const fakeKey = 'AIza' + 'x'.repeat(30);
        const rows = [
            { role: 'LITE', model: 'a', check: 'text', status: 'fail', ms: 5, note: `403 https://example.invalid/v1/models?key=${fakeKey} Bearer ${'y'.repeat(24)}` },
        ];
        const file = writeResult({ rows, ok: 0, failed: 1, skipped: 0, cost: 0 }, { LITE: 'a' }, dir);
        const text = fs.readFileSync(file, 'utf8');
        expect(text).not.toContain(fakeKey);
        expect(text).not.toContain('y'.repeat(24));
        expect(text).toContain('[redacted]');
        expect(smoke.scrubSecrets(`key=${fakeKey}&x=1`)).toBe('key=[redacted]&x=1');
    });

    test('MODEL_SMOKE_WRITE=0 writes nothing', () => {
        process.env.MODEL_SMOKE_WRITE = '0';
        try {
            expect(writeResult({ rows, ok: 3, failed: 1, skipped: 1, cost: 0 }, {}, dir)).toBeNull();
            expect(fs.existsSync(resultPath(dir))).toBe(false);
        } finally {
            delete process.env.MODEL_SMOKE_WRITE;
        }
    });

    test('a folder that cannot be written only warns; the check still reports', () => {
        const o = { log: jest.fn(), error: jest.fn() };
        const blocked = path.join(dir, 'a-file');
        fs.writeFileSync(blocked, 'not a folder');
        expect(writeResult({ rows, ok: 0, failed: 0, skipped: 0, cost: 0 }, {}, path.join(blocked, 'nested'), o)).toBeNull();
        expect(o.error).toHaveBeenCalled();
    });
});
