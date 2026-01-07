
const request = require('supertest');
const { WhatsAppService } = require('../src/whatsapp');

// Mock external dependencies
jest.mock('qrcode', () => ({
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,mockqr')
}));
jest.mock('axios');

describe('WhatsAppService Unit Tests', () => {
    let whatsapp;
    let mockBaileys;

    beforeEach(() => {
        // Reset mocks and instances
        jest.clearAllMocks();

        whatsapp = new WhatsAppService('http://mock-agent', 'test-session');

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

    test('should initialize with status disconnected', () => {
        expect(whatsapp.status).toBe('disconnected');
        expect(whatsapp.sessionId).toBe('test-session');
    });

    test('start() should stay disconnected if no credentials', async () => {
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
        expect(status.session).toBe('test-session');
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
        whatsapp.allowedNumbers = new Set();
        const spyWarn = jest.spyOn(console, 'warn');
        const spyAxios = require('axios').post;

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
        const spyAxios = require('axios').post;

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' }
        });

        expect(spyWarn).toHaveBeenCalledWith(expect.stringContaining('Blocked message from unauthorized number'));
        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('should allow authorized number', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello' }
        });

        expect(spyAxios).toHaveBeenCalled();
    });
});

describe('WhatsApp API Integration Tests', () => {
    let app;
    let mockStart;
    let mockConnect;

    beforeAll(() => {
        jest.resetModules(); // Reset cache to reload server.js

        // Configure Env for this test suite
        process.env.ENABLE_WHATSAPP = 'true';
        process.env.TELEGRAM_TOKEN = '';
        process.env.DEEDEE_API_TOKEN = 'test-token';
        process.env.ALLOWED_WHATSAPP_NUMBERS = '123,456';

        // Re-require WhatsAppService to get the FRESH class definition that server.js will use
        // This is crucial because resetModules() creates a new instance of the module registry
        const { WhatsAppService: FreshWhatsAppService } = require('../src/whatsapp');

        // Spy on the FRESH prototype
        mockStart = jest.spyOn(FreshWhatsAppService.prototype, 'start').mockResolvedValue();
        mockConnect = jest.spyOn(FreshWhatsAppService.prototype, 'connect').mockResolvedValue();

        // Now require server
        const serverModule = require('../src/server');
        app = serverModule.app;
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    test('GET /whatsapp/status should return status for both sessions', async () => {
        const res = await request(app)
            .get('/whatsapp/status')
            .set('Authorization', 'Bearer test-token');

        expect(res.statusCode).toBe(200);
        // Should contain both keys
        expect(res.body).toHaveProperty('assistant');
        expect(res.body).toHaveProperty('user');

        // Check structure
        expect(res.body.assistant).toHaveProperty('status');
        expect(res.body.assistant).toHaveProperty('session', 'assistant');
        expect(res.body.user).toHaveProperty('session', 'user');

        // Confirm start() was called for both
        expect(mockStart).toHaveBeenCalledTimes(2);
    });

    test('POST /whatsapp/connect should trigger connect on correct session', async () => {
        const res = await request(app)
            .post('/whatsapp/connect')
            .set('Authorization', 'Bearer test-token')
            .send({ session: 'user' });

        expect(res.statusCode).toBe(200);
        expect(mockConnect).toHaveBeenCalled();
    });
});
