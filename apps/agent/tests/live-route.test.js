const request = require('supertest');
const express = require('express');

// The Live socket rejects service-account OAuth tokens (close code 1008), so
// the route must not load google-auth-library any more. Loading it fails loudly.
jest.mock('google-auth-library', () => {
    throw new Error('google-auth-library must not be loaded by the live route');
});

const { createLiveRouter, TOKEN_TTL_MS, NEW_SESSION_WINDOW_MS } = require('../src/routes/live');
const { MAX_FACTS_CHARS, MAX_INSTRUCTION_CHARS } = require('../src/prompts/live');
const { FACTS_HEADER } = require('../src/prompts/system');

function makeAgent(overrides = {}) {
    return {
        client: { authTokens: { create: jest.fn().mockResolvedValue({ name: 'auth_tokens/test-token' }) } },
        configService: { getModel: jest.fn().mockReturnValue('gemini-3.8-live') },
        settings: { voice: 'Puck', communication_style: 'Dry and brief.', owner_name: 'Owner' },
        db: { getFactsFormatted: jest.fn().mockReturnValue('- favorite_color: "blue"\n- coffee: "black"') },
        ...overrides
    };
}

function makeApp(agent) {
    const app = express();
    app.use(express.json());
    app.use('/live', createLiveRouter(agent));
    return app;
}

describe('POST /live/token', () => {
    let logSpy;
    beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { logSpy.mockRestore(); });

    test('mints a single-use ephemeral token locked to the LIVE model and AUDIO only', async () => {
        const agent = makeAgent();
        const before = Date.now();
        const res = await request(makeApp(agent)).post('/live/token');

        expect(res.status).toBe(200);
        expect(res.body.token).toBe('auth_tokens/test-token');
        expect(res.body.model).toBe('models/gemini-3.8-live');
        expect(agent.configService.getModel).toHaveBeenCalledWith('LIVE');

        expect(agent.client.authTokens.create).toHaveBeenCalledTimes(1);
        const { config } = agent.client.authTokens.create.mock.calls[0][0];
        expect(config.uses).toBe(1);
        expect(config.liveConnectConstraints).toEqual({
            model: 'models/gemini-3.8-live',
            config: { responseModalities: ['AUDIO'] }
        });
        // Empty array: the SDK locks only the fields above. Without it the API
        // would take the whole setup from the token and drop the browser's tools.
        expect(config.lockAdditionalFields).toEqual([]);
        expect(config.httpOptions).toEqual({ apiVersion: 'v1alpha' });
        // The system instruction and the tools travel in the setup message.
        expect(config.liveConnectConstraints.config.systemInstruction).toBeUndefined();
        expect(config.liveConnectConstraints.config.tools).toBeUndefined();

        const expire = Date.parse(config.expireTime);
        const fresh = Date.parse(config.newSessionExpireTime);
        expect(expire - before).toBeGreaterThanOrEqual(TOKEN_TTL_MS - 5000);
        expect(expire - before).toBeLessThanOrEqual(TOKEN_TTL_MS + 5000);
        expect(fresh - before).toBeGreaterThanOrEqual(NEW_SESSION_WINDOW_MS - 5000);
        expect(fresh - before).toBeLessThanOrEqual(NEW_SESSION_WINDOW_MS + 5000);
        expect(res.body.expiresAt).toBe(config.expireTime);
        // Never log the token.
        for (const call of logSpy.mock.calls) expect(JSON.stringify(call)).not.toContain('test-token');
    });

    test('503 before the client exists, 502 on a token without a name, 500 on an SDK error', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect((await request(makeApp(null)).post('/live/token')).status).toBe(503);
        expect((await request(makeApp(makeAgent({ client: {} }))).post('/live/token')).status).toBe(503);

        const noName = makeAgent();
        noName.client.authTokens.create.mockResolvedValue({ name: 'not-a-token' });
        expect((await request(makeApp(noName)).post('/live/token')).status).toBe(502);

        const failing = makeAgent();
        failing.client.authTokens.create.mockRejectedValue(new Error('boom'));
        const res = await request(makeApp(failing)).post('/live/token');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Token generation failed' });

        errSpy.mockRestore();
    });
});

describe('GET /live/config', () => {
    let logSpy;
    beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { logSpy.mockRestore(); });

    test('returns the model, the voice and a system instruction built from the agent persona and facts', async () => {
        const res = await request(makeApp(makeAgent())).get('/live/config');

        expect(res.status).toBe(200);
        expect(res.body.model).toBe('models/gemini-3.8-live');
        expect(res.body.voice).toBe('Puck');

        const text = res.body.systemInstruction;
        expect(text).toContain('You are Deedee, a helpful and capable AI assistant.');
        expect(text).toContain('CONSTITUTION:');
        expect(text).toContain('**Privacy First**');
        expect(text).toContain('**Strict Matching**');
        expect(text).toContain(FACTS_HEADER);
        expect(text).toContain('- favorite_color: "blue"');
        expect(text).toContain('COMMUNICATION STYLE');
        expect(text).toContain('Dry and brief.');
        expect(text).toContain("Your owner's name is Owner.");
        expect(text).toContain('CURRENT_TIME:');
        // Chat-only material stays out.
        for (const marker of ['DEVELOPER PROTOCOL', 'SMART HOME RULES', 'GOALS PROTOCOL', 'BROWSER PROTOCOL', 'replyWithAudio', 'THINKING PROCESS']) {
            expect(text).not.toContain(marker);
        }
        // Size goes to the agent log.
        expect(logSpy.mock.calls.some(c => /system instruction \d+ chars/.test(c.join(' ')))).toBe(true);
    });

    test('caps the facts block and the whole instruction', async () => {
        const lines = Array.from({ length: 3000 }, (_, i) => `- fact_${i}: "${'x'.repeat(40)}"`);
        const agent = makeAgent({
            db: { getFactsFormatted: () => lines.join('\n') },
            settings: { communication_style: 'y'.repeat(20000) }
        });
        const res = await request(makeApp(agent)).get('/live/config');
        const text = res.body.systemInstruction;

        expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
        expect(text).toContain('more facts not shown');
        const factsStart = text.indexOf(FACTS_HEADER);
        const factsEnd = text.indexOf('COMMUNICATION STYLE');
        expect(factsEnd).toBeGreaterThan(factsStart);
        expect(factsEnd - factsStart).toBeLessThanOrEqual(MAX_FACTS_CHARS + 200);
        expect(logSpy.mock.calls.some(c => c.join(' ').includes('TRUNCATED'))).toBe(true);
    });

    test('falls back to defaults when the agent is not ready', async () => {
        const res = await request(makeApp(null)).get('/live/config');
        expect(res.status).toBe(200);
        expect(res.body.model.startsWith('models/')).toBe(true);
        expect(res.body.voice).toBe('Kore');
        expect(res.body.systemInstruction).toContain('No specific preferences stored.');
        expect(res.body.systemInstruction).not.toContain('COMMUNICATION STYLE');
    });
});
