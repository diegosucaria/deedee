// Disable background services for this test file
process.env.ENABLE_WHATSAPP = 'false';
process.env.TELEGRAM_TOKEN = ''; // Ensure Telegram doesn't start either

const { WhatsAppService } = require('../src/whatsapp');
const { app } = require('../src/server');
const request = require('supertest');

jest.mock('qrcode', () => ({
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,mockqr')
}));

jest.mock('axios');


describe('WhatsAppService', () => {
    let whatsapp;
    let mockBaileys;

    beforeEach(() => {
        whatsapp = new WhatsAppService('http://mock-agent');

        // Silence console logs
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });

        // Create a robust mock for Baileys
        mockBaileys = {
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
        };

        // Spy on the helper method to inject our mock
        jest.spyOn(whatsapp, '_importBaileys').mockResolvedValue(mockBaileys);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('should initialize with status disconnected', () => {
        expect(whatsapp.status).toBe('disconnected');
    });

    test('start() should stay disconnected if no credentials', async () => {
        // Ensure no creds exist (mocked or implicitly via temp dir)
        await whatsapp.start();
        expect(whatsapp.sock).toBeNull();
        expect(whatsapp.status).toBe('disconnected');
    });

    test('connect() should initialize socket', async () => {
        await whatsapp.connect();
        expect(whatsapp._importBaileys).toHaveBeenCalled();
        expect(whatsapp.sock).toBeDefined();
    });

    test('getStatus() should return initial status', () => {
        const status = whatsapp.getStatus();
        expect(status.status).toBe('disconnected');
        expect(status.qr).toBeNull();
    });

    test('sendMessage should handle audio', async () => {
        await whatsapp.connect();
        await whatsapp.sendMessage('123@s.whatsapp.net', 'base64audio', { type: 'audio' });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledWith(
            '123@s.whatsapp.net',
            expect.objectContaining({ audio: expect.any(Buffer), ptt: true })
        );
    });

    test('sendMessage should handle image', async () => {
        await whatsapp.connect();
        await whatsapp.sendMessage('123@s.whatsapp.net', 'base64image', { type: 'image' });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledWith(
            '123@s.whatsapp.net',
            expect.objectContaining({ image: expect.any(Buffer) })
        );
    });

    test('should ignore message if allowed list is empty (Secure Default)', async () => {
        // Mock allowed list as empty (default in test env)
        whatsapp.allowedNumbers = new Set();
        const spyWarn = jest.spyOn(console, 'warn');
        const spyAxios = jest.spyOn(require('axios'), 'post'); // We need to mock axios requirement at top

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' }
        });

        expect(spyWarn).toHaveBeenCalledWith(expect.stringContaining('ALLOWED_WHATSAPP_NUMBERS is empty'));
        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('should block unauthorized number', async () => {
        whatsapp.allowedNumbers = new Set(['999999']);
        const spyWarn = jest.spyOn(console, 'warn');
        const spyAxios = jest.spyOn(require('axios'), 'post');

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' }
        });

        expect(spyWarn).toHaveBeenCalledWith(expect.stringContaining('Blocked message from unauthorized number'));
        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('should allow authorized number', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = jest.spyOn(require('axios'), 'post').mockResolvedValue({});

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' }
        });

        expect(spyAxios).toHaveBeenCalled();
    });
});

describe('WhatsApp API Endpoints', () => {
    // We need to inject the mock into the `whatsapp` instance created inside server.js
    // BUT server.js creates its own instance. 
    // This is a limitation of the current test setup: we probably can't easily mock the internal instance in server.js 
    // without dependency injection or module mocking.
    // However, the previous tests didn't seem to crash on this.
    // Let's rely on the fact that if we can't mock the one in server.js easily without module mocking,
    // we should at least ensure it doesn't crash.
    // Actually, server.js logic: `if (telegramToken)` -> starts telegram.
    // `whatsapp` is started by default.
    // If we want to test /whatsapp/status, we hit the real instance.
    // The real instance will try to connect (and fail/retry).
    // For unit testing endpoints, it is better if we could mock the service.
    // But for now, let's keep the simple status test.

    beforeAll(() => {
        process.env.DEEDEE_API_TOKEN = 'test-token';
    });

    test('GET /whatsapp/status should return status', async () => {
        const res = await request(app)
            .get('/whatsapp/status')
            .set('Authorization', 'Bearer test-token');
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('status');
    });
});
