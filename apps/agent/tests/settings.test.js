
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

    test('POST /internal/settings should broadcast update if interface exists', async () => {
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
            key: 'search_strategy',
            value: 123
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
