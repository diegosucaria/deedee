
const request = require('supertest');
const { WhatsAppService } = require('../src/whatsapp');
const fs = require('fs');

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

        // Silence console logs BEFORE instantiation
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });

        // Mock Env
        process.env.ALLOWED_WHATSAPP_NUMBERS = '123456';

        whatsapp = new WhatsAppService('http://mock-agent', 'test-session');

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

    test('should reconnect on 515 error even if status is scan_qr', async () => {
        await whatsapp.connect();

        // Simulate QR code generation first
        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];
        await qrCallback({ qr: 'mock-qr' });
        expect(whatsapp.status).toBe('scan_qr');

        // Spy on connect to ensure it is called again
        const connectSpy = jest.spyOn(whatsapp, 'connect');

        // Simulate 515 error
        jest.useFakeTimers();
        await qrCallback({
            connection: 'close',
            lastDisconnect: {
                error: { output: { statusCode: 515 } }
            }
        });

        // Current implementation stops auto-retry on scan_qr, so this expect might fail before the fix
        // We want to ensure it DOES verify the fix.
        // Fast-forward timer for the 5000ms delay
        jest.runAllTimers();

        expect(whatsapp.status).toBe('connecting');
        expect(connectSpy).toHaveBeenCalledTimes(1);


        jest.useRealTimers();
    });

    test('should clear session after N consecutive 515 errors', async () => {
        // We trigger it somewhat manually to verify the logic increment
        whatsapp.reconnectAttempts = 4;
        await whatsapp.connect();

        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];

        // 5th attempt (increment happens on error)
        jest.spyOn(whatsapp, 'disconnect');
        jest.spyOn(fs, 'rmSync');

        await qrCallback({
            connection: 'close',
            lastDisconnect: {
                error: { output: { statusCode: 515 } }
            }
        });

        // reconnectAttempts should be 5 now, trigger wipe
        expect(whatsapp.disconnect).toHaveBeenCalled();
        // Since disconnect calls rmSync, we verify that too
        expect(fs.rmSync).toHaveBeenCalledWith(whatsapp.authFolder, expect.anything());
    });

    test('should unwrap ephemeral message', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: {
                ephemeralMessage: {
                    message: {
                        conversation: 'Secret Hello'
                    }
                }
            }
        });

        expect(spyAxios).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                content: 'Secret Hello'
            })
        );
    });

    test('should unwrap viewOnce message', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: {
                viewOnceMessage: {
                    message: {
                        imageMessage: {
                            caption: 'Sneaky Image'
                        }
                    }
                }
            }
        });

        expect(spyAxios).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                content: 'Sneaky Image'
            })
        );
    });
    test('should handle LID remoteJid by checking participant or resolving', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});
        const spyWarn = jest.spyOn(console, 'warn');

        await whatsapp.handleMessage({
            key: {
                remoteJid: '999999999@lid',
                participant: '123456@s.whatsapp.net', // The real phone number
                fromMe: false
            },
            message: { conversation: 'Hello from LID' }
        });

        expect(spyAxios).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                content: 'Hello from LID'
            })
        );
        expect(spyWarn).not.toHaveBeenCalled();
    });

    test('should resolve LID via internal map if participant is missing (Fix Verification)', async () => {
        const lidJid = '987654321@lid';
        const realNumber = '987654321';

        whatsapp.allowedNumbers = new Set([realNumber]);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});
        const spyError = jest.spyOn(console, 'error');

        // 1. Simulate Contact Sync (Population of Map)
        // Access mock directly from the socket instance
        await whatsapp.connect();

        // Wait for async initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        if (!whatsapp.sock) throw new Error('Socket not initialized');

        const contactsListener = whatsapp.sock.ev.on.mock.calls.find(c => c[0] === 'contacts.upsert')[1];

        contactsListener([
            { id: `${realNumber}@s.whatsapp.net`, lid: lidJid }
        ]);

        // 2. Handle Message (Missing Participant)
        await whatsapp.handleMessage({
            key: {
                remoteJid: lidJid,
                // participant is undefined
                fromMe: false
            },
            message: { conversation: 'Hello' }
        });

        // 3. Verify Success
        expect(spyAxios).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ content: 'Hello' })
        );
        expect(spyError).not.toHaveBeenCalled();
    });

    test('should search contacts correctly', async () => {
        // Populate contacts manually
        whatsapp.contacts.set('123@s.whatsapp.net', { id: '123@s.whatsapp.net', name: 'Diego', notify: 'Diego S' });
        whatsapp.contacts.set('456@s.whatsapp.net', { id: '456@s.whatsapp.net', name: 'Mom', notify: 'Mami' });

        // Search by name
        const res1 = whatsapp.searchContacts('Diego');
        expect(res1).toHaveLength(1);
        expect(res1[0].phone).toBe('123');

        // Search by notify
        const res2 = whatsapp.searchContacts('Mami');
        expect(res2).toHaveLength(1);
        expect(res2[0].phone).toBe('456');

        // Search by phone
        const res3 = whatsapp.searchContacts('456');
        expect(res3).toHaveLength(1);

        // No match
        const res4 = whatsapp.searchContacts('Dad');
        expect(res4).toHaveLength(0);
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
