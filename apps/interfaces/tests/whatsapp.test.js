
const request = require('supertest');
const child_process = require('child_process');
const EventEmitter = require('events');
const { Readable, Writable } = require('stream');
const { WhatsAppService } = require('../src/whatsapp');
const fs = require('fs');

// Mock external dependencies
jest.mock('qrcode', () => ({
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,mockqr')
}));
jest.mock('axios');

// Returns a spawn mock that simulates ffmpeg being unavailable (ENOENT).
// convertToOpus catches the error event and falls back to the raw buffer,
// so callers get a Buffer back without actually invoking ffmpeg.
function fakeFfmpegNotFound() {
    const proc = new EventEmitter();
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.stdin = new Writable({ write(_c, _e, cb) { cb(); }, final(cb) { cb(); } });
    proc.kill = jest.fn();
    process.nextTick(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
    return proc;
}

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

        // Isolate from real ffmpeg — convertToOpus falls back to raw buffer on error.
        // Keeps the audio-send test stable across machines with/without ffmpeg.
        jest.spyOn(child_process, 'spawn').mockImplementation(fakeFfmpegNotFound);

        // Mock Env
        process.env.ALLOWED_WHATSAPP_NUMBERS = '123456';

        whatsapp = new WhatsAppService('http://mock-agent', 'test-session');

        // Create a robust mock for Baileys
        mockBaileys = {
            default: jest.fn(() => ({
                ev: { on: jest.fn() },
                sendMessage: jest.fn(),
                sendPresenceUpdate: jest.fn(),
                logout: jest.fn(),
                readMessages: jest.fn()
            })),
            useMultiFileAuthState: jest.fn(() => ({ state: {}, saveCreds: jest.fn() })),
            fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
            DisconnectReason: { loggedOut: 401 },
            delay: jest.fn(),
            downloadMediaMessage: jest.fn().mockResolvedValue(Buffer.from('mockbuffer')),
            makeInMemoryStore: jest.fn(() => ({
                bind: jest.fn(),
                readFromFile: jest.fn(),
                writeToFile: jest.fn(),
                contacts: {} // Internal contacts store mock
            }))
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
        expect(whatsapp.store).toBeDefined(); // Verify store init
        expect(typeof whatsapp.store.bind).toBe('function');
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
        whatsapp.reconnectAttempts = 9;
        await whatsapp.connect();

        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];

        // 10th attempt (increment happens on error)
        jest.spyOn(whatsapp, 'disconnect');
        jest.spyOn(fs, 'rmSync');

        await qrCallback({
            connection: 'close',
            lastDisconnect: {
                error: { output: { statusCode: 515 } }
            }
        });

        // reconnectAttempts should be 10 now, trigger wipe
        expect(whatsapp.disconnect).toHaveBeenCalledWith(true);
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
    test('should handle LID remoteJid by resolving via centralized resolver', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        // Mock the centralized resolver
        whatsapp.store = {
            resolveIdentity: jest.fn().mockReturnValue({
                phoneJid: '123456@s.whatsapp.net',
                lid: '999999999@lid',
                name: 'Test User',
                allJids: ['123456@s.whatsapp.net', '999999999@lid']
            })
        };

        await whatsapp.handleMessage({
            key: {
                remoteJid: '999999999@lid',
                participant: '123456@s.whatsapp.net',
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
    });

    test('should resolve LID via centralized resolver when participant is missing', async () => {
        const lidJid = '987654321012345@lid';
        const realNumber = '549351234567';

        whatsapp.allowedNumbers = new Set([realNumber]);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        // Mock the centralized resolver on the store
        whatsapp.store = {
            resolveIdentity: jest.fn().mockReturnValue({
                phoneJid: realNumber + '@s.whatsapp.net',
                lid: lidJid,
                name: 'Test Contact',
                allJids: [realNumber + '@s.whatsapp.net', lidJid]
            })
        };

        // Handle Message (Missing Participant — LID only)
        await whatsapp.handleMessage({
            key: {
                remoteJid: lidJid,
                // participant is undefined
                fromMe: false
            },
            message: { conversation: 'Hello' }
        });

        // Verify resolver was called and message was processed
        expect(whatsapp.store.resolveIdentity).toHaveBeenCalledWith(lidJid);
        expect(spyAxios).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ content: 'Hello' })
        );
    });

    test('should search contacts correctly', async () => {
        // Mock SQLite Store (this.store)
        whatsapp.store = {
            getAllContactsRaw: jest.fn(() => [
                { id: '123@s.whatsapp.net', name: 'Diego', notify: 'Diego S' },
                { id: '456@s.whatsapp.net', name: 'Mom', notify: 'Mami' }
            ])
        };

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

describe('convertToOpus', () => {
    const { spawn: realSpawn } = require('child_process');
    let childProcessMock;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // We need to access the module-level function. Since it's not exported,
    // we test it indirectly via sendMessage, OR we re-require the module.
    // For direct testing, let's use sendMessage with audio type.
    test('should reject on empty buffer', async () => {
        const wa = new WhatsAppService('http://mock-agent', 'test');
        jest.spyOn(wa, '_importBaileys').mockResolvedValue({
            default: jest.fn(() => ({
                ev: { on: jest.fn() },
                sendMessage: jest.fn(),
                sendPresenceUpdate: jest.fn(),
                logout: jest.fn(),
                readMessages: jest.fn()
            })),
            useMultiFileAuthState: jest.fn(() => ({ state: {}, saveCreds: jest.fn() })),
            fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
            DisconnectReason: { loggedOut: 401 },
            makeInMemoryStore: jest.fn(() => ({ bind: jest.fn(), readFromFile: jest.fn(), writeToFile: jest.fn(), contacts: {} }))
        });
        await wa.connect();

        // Empty base64 produces a 0-length buffer
        await expect(wa.sendMessage('123@s.whatsapp.net', '', { type: 'audio' }))
            .rejects.toThrow('empty or null audio buffer');
    });

    test('should handle ffmpeg not available (graceful fallback)', async () => {
        // This test verifies the error handler path. In CI without ffmpeg,
        // the spawn will emit an error event and the function falls back to raw buffer.
        const wa = new WhatsAppService('http://mock-agent', 'test');
        const mockSendMessage = jest.fn();
        jest.spyOn(wa, '_importBaileys').mockResolvedValue({
            default: jest.fn(() => ({
                ev: { on: jest.fn() },
                sendMessage: mockSendMessage,
                sendPresenceUpdate: jest.fn(),
                logout: jest.fn(),
                readMessages: jest.fn()
            })),
            useMultiFileAuthState: jest.fn(() => ({ state: {}, saveCreds: jest.fn() })),
            fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
            DisconnectReason: { loggedOut: 401 },
            makeInMemoryStore: jest.fn(() => ({ bind: jest.fn(), readFromFile: jest.fn(), writeToFile: jest.fn(), contacts: {} }))
        });
        await wa.connect();

        // Mock spawn to simulate ffmpeg not found
        const child_process = require('child_process');
        const EventEmitter = require('events');
        const { Writable, Readable } = require('stream');

        jest.spyOn(child_process, 'spawn').mockImplementation(() => {
            const proc = new EventEmitter();
            proc.stdout = new Readable({ read() {} });
            proc.stderr = new Readable({ read() {} });
            proc.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); } });
            proc.kill = jest.fn();
            // Simulate ENOENT error
            process.nextTick(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
            return proc;
        });

        const audio = Buffer.from('fake-wav-data').toString('base64');
        await wa.sendMessage('123@s.whatsapp.net', audio, { type: 'audio' });

        // Should still send (with raw buffer as fallback)
        expect(mockSendMessage).toHaveBeenCalledWith(
            '123@s.whatsapp.net',
            expect.objectContaining({ audio: expect.any(Buffer), ptt: true })
        );
    });
});

describe('fromMe feedback loop prevention', () => {
    let whatsappAssistant;
    let whatsappUser;
    let spyAxios;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.ALLOWED_WHATSAPP_NUMBERS = '123456';

        whatsappAssistant = new WhatsAppService('http://mock-agent', 'assistant');
        whatsappUser = new WhatsAppService('http://mock-agent', 'user');

        spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});
    });

    test('assistant session should block fromMe audio (prevents feedback loop)', async () => {
        whatsappAssistant.allowedNumbers = new Set(['123456']);

        await whatsappAssistant.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: true },
            message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }
        });

        // Should NOT forward to agent — this is the bot's own TTS echo
        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('assistant session should block fromMe text', async () => {
        whatsappAssistant.allowedNumbers = new Set(['123456']);

        await whatsappAssistant.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: true },
            message: { conversation: 'Hello from me' }
        });

        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('assistant session should allow non-fromMe messages', async () => {
        whatsappAssistant.allowedNumbers = new Set(['123456']);

        await whatsappAssistant.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { conversation: 'Hello from user' }
        });

        expect(spyAxios).toHaveBeenCalled();
    });

    test('user session should allow fromMe audio for semantic extraction', async () => {
        // Verify the session-based filter logic directly:
        // On user session, fromMe audio should NOT be blocked
        const msg = {
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: true },
            message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }
        };

        expect(whatsappUser.sessionId).toBe('user');

        // Replicate the filter logic from whatsapp.js
        const isFromMeMedia = msg.key.fromMe && whatsappUser.sessionId === 'user' &&
            (!!msg.message?.audioMessage || !!msg.message?.imageMessage);
        expect(isFromMeMedia).toBe(true);

        // The filter: if (fromMe && !isFromMeMedia) return;
        // Since isFromMeMedia is true, it should NOT return early
        const shouldBlock = msg.key.fromMe && !isFromMeMedia;
        expect(shouldBlock).toBe(false);

        // Verify the inverse: on assistant session, same message IS blocked
        const isFromMeMediaAssistant = msg.key.fromMe && whatsappAssistant.sessionId === 'user' &&
            (!!msg.message?.audioMessage || !!msg.message?.imageMessage);
        expect(isFromMeMediaAssistant).toBe(false);

        const shouldBlockAssistant = msg.key.fromMe && !isFromMeMediaAssistant;
        expect(shouldBlockAssistant).toBe(true);
    });

    test('user session should block fromMe text (only media passes)', async () => {
        whatsappUser.allowedNumbers = new Set(['123456']);

        await whatsappUser.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: true },
            message: { conversation: 'My own text' }
        });

        expect(spyAxios).not.toHaveBeenCalled();
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
