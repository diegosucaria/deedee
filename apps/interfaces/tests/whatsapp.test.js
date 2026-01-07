const { WhatsAppService } = require('../src/whatsapp');
const { app } = require('../src/server');
const request = require('supertest');

// Mocks
jest.mock('@whiskeysockets/baileys', () => ({
    default: jest.fn(() => ({
        ev: { on: jest.fn() },
        sendMessage: jest.fn(),
        logout: jest.fn(),
        readMessages: jest.fn()
    })),
    useMultiFileAuthState: jest.fn(() => ({ state: {}, saveCreds: jest.fn() })),
    DisconnectReason: { loggedOut: 401 },
    delay: jest.fn(),
    downloadMediaMessage: jest.fn().mockResolvedValue(Buffer.from('mockbuffer'))
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
        jest.spyOn(console, 'warn').mockImplementation(() => { });
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

    test('sendMessage should handle audio', async () => {
        await whatsapp.start(); // Init sock
        await whatsapp.sendMessage('123@s.whatsapp.net', 'base64audio', { type: 'audio' });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledWith(
            '123@s.whatsapp.net',
            expect.objectContaining({ audio: expect.any(Buffer), ptt: true })
        );
    });

    test('sendMessage should handle image', async () => {
        await whatsapp.start(); // Init sock
        await whatsapp.sendMessage('123@s.whatsapp.net', 'base64image', { type: 'image' });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledWith(
            '123@s.whatsapp.net',
            expect.objectContaining({ image: expect.any(Buffer) })
        );
    });
});

describe('WhatsApp API Endpoints', () => {
    test('GET /whatsapp/status should return status', async () => {
        const res = await request(app).get('/whatsapp/status');
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('status');
    });
});
