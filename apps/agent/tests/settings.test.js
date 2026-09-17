
const request = require('supertest');
const express = require('express');
const { createSettingsRouter } = require('../src/routes/settings');

describe('Settings API', () => {
    let app;
    let mockAgent;
    let mockDb;

    beforeEach(() => {
        // Mock DB
        mockDb = {
            db: {
                prepare: jest.fn(),
                exec: jest.fn(),
                pragma: jest.fn(),
            },
            init: jest.fn()
        };

        // Mock Agent
        mockAgent = {
            db: mockDb
        };

        // Create a standalone app for testing the router
        app = express();
        app.use(express.json());
        app.use('/internal/settings', createSettingsRouter(mockAgent));
    });

    test('POST /internal/settings should save a setting', async () => {
        const mockRun = jest.fn();
        mockDb.db.prepare.mockReturnValue({ run: mockRun });

        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'voice_settings', value: 'Puck', category: 'voice' });

        expect(res.statusCode).toBe(200);
        expect(mockDb.db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_settings'));
        expect(mockRun).toHaveBeenCalledWith('voice_settings', '"Puck"', 'voice');
    });

    test('POST /internal/settings broadcasts the name, never the value', async () => {
        const mockRun = jest.fn();
        mockDb.db.prepare.mockReturnValue({ run: mockRun });

        mockAgent.interface = {
            broadcast: jest.fn().mockResolvedValue(true)
        };

        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'search_strategy', value: 123 });

        expect(res.statusCode).toBe(200);
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('entity:update', {
            type: 'setting',
            key: 'search_strategy'
        });
    });

    test('POST /internal/settings should reject missing key', async () => {
        const res = await request(app)
            .post('/internal/settings')
            .send({ value: 'Puck' });

        expect(res.statusCode).toBe(400);
    });

    test('POST /internal/settings should allow valid keys', async () => {
        const keys = ['owner_phone', 'owner_name', 'search_strategy', 'voice_settings'];

        mockDb.db.prepare.mockReturnValue({ run: jest.fn() });
        mockAgent.interface = { broadcast: jest.fn().mockResolvedValue(true) };

        for (const key of keys) {
            const res = await request(app)
                .post('/internal/settings')
                .send({ key, value: 'test' });
            expect(res.statusCode).toBe(200);
        }
    });

    test('POST /internal/settings should reject invalid keys', async () => {
        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'random_key', value: '123' });

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('Invalid config key');
    });

    test('POST /internal/settings/tts/preview should return audio and mimeType', async () => {
        // Mock Gemini client
        mockAgent.config = { googleApiKey: 'fake_key' };
        mockAgent.client = {
            models: {
                generateContent: jest.fn().mockResolvedValue({
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    data: 'SGVsbG8=',
                                    mimeType: 'audio/mp3'
                                }
                            }]
                        }
                    }]
                })
            }
        };

        const res = await request(app)
            .post('/internal/settings/tts/preview')
            .send({ text: 'Hello', voice: 'Puck' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        // Should start with RIFF (WAV header)
        expect(res.body.audio_base64).toMatch(/^UklGR/);
        expect(res.body.mimeType).toBe('audio/wav');
    });
});

describe('Settings API partner_greeting', () => {
    let app;
    let run;

    beforeEach(() => {
        run = jest.fn();
        const agent = { db: { db: { prepare: jest.fn().mockReturnValue({ run }) } } };
        app = express();
        app.use(express.json());
        app.use('/internal/settings', createSettingsRouter(agent));
    });

    test('stores a trimmed contact and name', async () => {
        const res = await request(app).post('/internal/settings')
            .send({ key: 'partner_greeting', value: { contact: ' 100000000000001@lid ', name: ' Alex ' }, category: 'communication' });
        expect(res.statusCode).toBe(200);
        expect(run).toHaveBeenCalledWith('partner_greeting', JSON.stringify({ contact: '100000000000001@lid', name: 'Alex', dryRun: false }), 'communication');
    });

    test('keeps dryRun only when it is exactly true', async () => {
        await request(app).post('/internal/settings').send({ key: 'partner_greeting', value: { contact: '5490000000000', dryRun: true } });
        await request(app).post('/internal/settings').send({ key: 'partner_greeting', value: { contact: '5490000000000', dryRun: 'yes' } });
        expect(run.mock.calls[0][1]).toBe(JSON.stringify({ contact: '5490000000000', dryRun: true }));
        expect(run.mock.calls[1][1]).toBe(JSON.stringify({ contact: '5490000000000', dryRun: false }));
    });

    test('rejects a value without a usable contact', async () => {
        for (const value of [{}, { contact: '' }, { contact: 'abc' }, 'not-an-object']) {
            const res = await request(app).post('/internal/settings').send({ key: 'partner_greeting', value });
            expect(res.statusCode).toBe(400);
        }
        expect(run).not.toHaveBeenCalled();
    });
});

describe('Settings API approvals', () => {
    let app;
    let run;

    beforeEach(() => {
        run = jest.fn();
        const mockDb = { db: { prepare: jest.fn().mockReturnValue({ run }) } };
        app = express();
        app.use(express.json());
        app.use('/internal/settings', createSettingsRouter({ db: mockDb, settings: {} }));
    });

    test('stores clamped TTLs and the deny list as an array', async () => {
        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'approvals', value: { ttlInteractiveMin: '45', ttlDeferredHours: 500, deny: 'commitAndPush\n# comment\nrunShellCommand:*rm -rf*' } });
        expect(res.statusCode).toBe(200);
        expect(run).toHaveBeenCalledWith('approvals', JSON.stringify({ ttlInteractiveMin: 45, ttlDeferredHours: 168, deny: ['commitAndPush', 'runShellCommand:*rm -rf*'] }), 'general');
    });

    test('rejects a non-object value', async () => {
        for (const value of ['x', 5, ['a']]) {
            const res = await request(app).post('/internal/settings').send({ key: 'approvals', value });
            expect(res.statusCode).toBe(400);
        }
        expect(run).not.toHaveBeenCalled();
    });
});

describe('Settings API keeps secrets on the server', () => {
    let app;
    let rows;
    let saved;

    // Minimal stand-in for the settings table.
    const makeAgent = () => ({
        db: {
            db: {
                prepare: (sql) => {
                    if (sql.includes('SELECT key, value')) return { all: () => rows };
                    if (sql.includes('SELECT value FROM agent_settings')) {
                        return { get: (key) => rows.find(r => r.key === key) };
                    }
                    return { run: (key, value, category) => { saved = { key, value, category }; } };
                }
            }
        },
        interface: { broadcast: jest.fn().mockResolvedValue(true) }
    });

    beforeEach(() => {
        saved = undefined;
        rows = [
            { key: 'provider:xai', value: JSON.stringify({ apiKey: 'xai-abc123', models: ['grok-4'] }) },
            { key: 'owner_name', value: JSON.stringify('Owner') }
        ];
        app = express();
        app.use(express.json());
        app.use('/internal/settings', createSettingsRouter(makeAgent()));
    });

    test('GET returns a set flag instead of the key', async () => {
        const res = await request(app).get('/internal/settings');

        expect(res.statusCode).toBe(200);
        expect(res.body['provider:xai']).toEqual({ apiKey: { __secret: true, set: true }, models: ['grok-4'] });
        expect(res.body.owner_name).toBe('Owner');
        expect(JSON.stringify(res.body)).not.toContain('xai-abc123');
    });

    test('a save that sends the marker back keeps the stored key', async () => {
        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'provider:xai', value: { apiKey: { __secret: true }, models: ['grok-4', 'grok-5'] } });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(saved.value)).toEqual({ apiKey: 'xai-abc123', models: ['grok-4', 'grok-5'] });
        expect(JSON.stringify(res.body)).not.toContain('xai-abc123');
        expect(res.body.value.apiKey).toEqual({ __secret: true, set: true });
    });

    test('a new value replaces the key and an empty string clears it', async () => {
        await request(app)
            .post('/internal/settings')
            .send({ key: 'provider:xai', value: { apiKey: 'xai-new', models: [] } });
        expect(JSON.parse(saved.value).apiKey).toBe('xai-new');

        await request(app)
            .post('/internal/settings')
            .send({ key: 'provider:xai', value: { apiKey: '', models: [] } });
        expect(JSON.parse(saved.value).apiKey).toBe('');
    });
});
