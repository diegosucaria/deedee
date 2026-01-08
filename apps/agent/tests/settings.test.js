
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
            .send({ key: 'test_voice', value: 'Puck', category: 'voice' });

        expect(res.statusCode).toBe(200);
        expect(mockDb.db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agent_settings'));
        expect(mockRun).toHaveBeenCalledWith('test_voice', '"Puck"', 'voice');
    });

    test('GET /internal/settings should retrieve settings', async () => {
        const mockAll = jest.fn().mockReturnValue([
            { key: 'test_voice', value: '"Puck"', category: 'voice' },
            { key: 'theme', value: '{"dark":true}', category: 'ui' }
        ]);
        mockDb.db.prepare.mockReturnValue({ all: mockAll });

        const res = await request(app).get('/internal/settings');

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            test_voice: 'Puck',
            theme: { dark: true }
        });
    });

    test('POST /internal/settings should broadcast update if interface exists', async () => {
        const mockRun = jest.fn();
        mockDb.db.prepare.mockReturnValue({ run: mockRun });

        mockAgent.interface = {
            broadcast: jest.fn().mockResolvedValue(true)
        };

        const res = await request(app)
            .post('/internal/settings')
            .send({ key: 'broadcast_test', value: 123 });

        expect(res.statusCode).toBe(200);
        expect(mockAgent.interface.broadcast).toHaveBeenCalledWith('entity:update', {
            type: 'setting',
            key: 'broadcast_test',
            value: 123
        });
    });

    test('POST /internal/settings should reject missing key', async () => {
        const res = await request(app)
            .post('/internal/settings')
            .send({ value: 'Puck' });

        expect(res.statusCode).toBe(400);
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
        expect(res.body.audio_base64).toBe('SGVsbG8=');
        expect(res.body.mimeType).toBe('audio/mp3');
    });
});
