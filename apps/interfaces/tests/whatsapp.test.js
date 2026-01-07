const { WhatsAppService } = require('../src/whatsapp');
const { app } = require('../src/server');
const request = require('supertest');

// Mocks
jest.mock('@whiskeysockets/baileys', () => ({
    default: jest.fn(() => ({
        ev: { on: jest.fn() },
        sendMessage: jest.fn(),
        logout: jest.fn()
    })),
    useMultiFileAuthState: jest.fn(() => ({ state: {}, saveCreds: jest.fn() })),
    DisconnectReason: { loggedOut: 401 },
    delay: jest.fn()
}));

jest.mock('qrcode', () => ({
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,mockqr')
}));

describe('WhatsAppService', () => {
    let whatsapp;

    beforeEach(() => {
        whatsapp = new WhatsAppService('http://mock-agent');
        // Silence console logs
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    test('should initialize with status disconnected', () => {
        expect(whatsapp.status).toBe('disconnected');
    });

    test('start() should initialize socket', async () => {
        await whatsapp.start();
        expect(whatsapp.sock).toBeDefined();
    });

    test('getStatus() should return initial status', () => {
        const status = whatsapp.getStatus();
        expect(status.status).toBe('disconnected');
        expect(status.qr).toBeNull();
    });
});

describe('WhatsApp API Endpoints', () => {
    test('GET /whatsapp/status should return status', async () => {
        const res = await request(app).get('/whatsapp/status');
        // Might be disabled or enabled depending on env in test run, but should return json
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('status');
    });
});
