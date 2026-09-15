const request = require('supertest');

describe('Interfaces - browser live view', () => {
    let originalEnv;
    let mockAxios;
    let logSpy;

    beforeAll(() => {
        originalEnv = process.env;
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv, DEEDEE_API_TOKEN: 'valid-token', TELEGRAM_TOKEN: '', ENABLE_WHATSAPP: 'false' };
        mockAxios = {
            get: jest.fn(() => Promise.resolve({ data: {} })),
            post: jest.fn(() => Promise.resolve({ data: {} })),
            put: jest.fn(() => Promise.resolve({ data: {} })),
            delete: jest.fn(() => Promise.resolve({ data: {} })),
            isAxiosError: jest.fn(() => false),
            defaults: { headers: { common: {} } },
            create: jest.fn(() => ({ get: jest.fn(), post: jest.fn(), interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } }))
        };
        jest.doMock('axios', () => mockAxios);
        logSpy.mockClear();
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    test('makeInputGate allows 60 events per second and drops the rest', () => {
        const { makeInputGate } = require('../src/server');
        const gate = makeInputGate();
        let allowed = 0;
        for (let i = 0; i < 100; i++) if (gate.allow(1000 + i)) allowed++;
        expect(allowed).toBe(60);
        // The next second opens a new window.
        expect(gate.allow(2000)).toBe(true);
        expect(gate.allow(2001)).toBe(true);
    });

    test('POST /broadcast does not log browser:frame events', async () => {
        const { app } = require('../src/server');
        await request(app).post('/broadcast').set('Authorization', 'Bearer valid-token').send({ event: 'browser:frame', data: { data: 'x' } });
        await request(app).post('/broadcast').set('Authorization', 'Bearer valid-token').send({ event: 'browser:status', data: { running: true } });
        const lines = logSpy.mock.calls.map(c => String(c[0]));
        expect(lines.some(l => l.includes('Broadcasting event: browser:frame'))).toBe(false);
        expect(lines.some(l => l.includes('Broadcasting event: browser:status'))).toBe(true);
    });
});
