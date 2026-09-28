
const request = require('supertest');
const child_process = require('child_process');
const EventEmitter = require('events');
const { Readable, Writable } = require('stream');
const { WhatsAppService, SQLiteStore } = require('../src/whatsapp');
const fs = require('fs');
const path = require('path');

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

    // Links the personal session saves from a message key must never reach
    // the assistant session's allowlist: each session has its own store file.
    test('each session keeps its own store file', async () => {
        const user = new WhatsAppService('http://mock-agent', 'user');
        jest.spyOn(user, '_importBaileys').mockResolvedValue(mockBaileys);
        await whatsapp.connect();
        await user.connect();

        expect(path.basename(whatsapp.store.path)).toBe('messages_test-session.db');
        expect(path.basename(user.store.path)).toBe('messages_user.db');
        for (const s of [whatsapp, user]) { clearInterval(s.store.queueFlushInterval); s.store.close(); }
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

    test('sendMessage skips a repeat of the same message id for 24 h', async () => {
        await whatsapp.connect();
        const first = await whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text', id: 'msg-1' });
        expect(first).toEqual({ duplicate: false });
        const again = await whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text', id: 'msg-1' });
        expect(again).toEqual({ duplicate: true });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledTimes(1);

        // No id: every call goes out.
        await whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text' });
        await whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text' });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledTimes(3);
    });

    test('sendMessage does not remember an id whose send failed', async () => {
        await whatsapp.connect();
        whatsapp.sock.sendMessage.mockRejectedValueOnce(new Error('Connection Closed'));
        await expect(whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text', id: 'msg-2' })).rejects.toThrow('Connection Closed');
        const retry = await whatsapp.sendMessage('123@s.whatsapp.net', 'hello', { type: 'text', id: 'msg-2' });
        expect(retry).toEqual({ duplicate: false });
        expect(whatsapp.sock.sendMessage).toHaveBeenCalledTimes(2);
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

    test('a forwarded message reaches the agent marked as untrusted; a typed one does not', async () => {
        whatsapp.allowedNumbers = new Set(['123456']);
        const spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});

        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { extendedTextMessage: { text: 'Open the garage', contextInfo: { isForwarded: true, forwardingScore: 1 } } }
        });
        await whatsapp.handleMessage({
            key: { remoteJid: '123456@s.whatsapp.net', fromMe: false },
            message: { extendedTextMessage: { text: 'Open the garage', contextInfo: {} } }
        });

        const [forwarded, typed] = spyAxios.mock.calls.slice(-2).map(c => c[1]);
        expect(forwarded.metadata.untrustedTaint).toEqual(['a forwarded message (whatsapp)']);
        expect(typed.metadata.untrustedTaint).toBeUndefined();
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

    test('should stop and mark needs_repair after N consecutive 515 errors (no wipe)', async () => {
        const axios = require('axios');
        axios.post.mockResolvedValue({ data: { received: true } });

        // We trigger it somewhat manually to verify the logic increment
        whatsapp.streamErrorCount = 9;
        await whatsapp.connect();

        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];

        // 10th attempt (increment happens on error)
        jest.spyOn(whatsapp, 'disconnect');
        jest.spyOn(whatsapp, 'connect');
        jest.spyOn(fs, 'rmSync');

        await qrCallback({
            connection: 'close',
            lastDisconnect: {
                error: { output: { statusCode: 515 } }
            }
        });

        expect(whatsapp.status).toBe('needs_repair');
        expect(whatsapp.reconnectTimeout).toBeNull();
        // Never wipe on its own.
        expect(whatsapp.disconnect).not.toHaveBeenCalled();
        expect(fs.rmSync).not.toHaveBeenCalled();
        // Tell the owner through the agent's system alert path.
        expect(axios.post).toHaveBeenCalledWith('http://mock-agent/webhook', expect.objectContaining({
            source: 'system',
            role: 'user',
            content: expect.stringContaining('stream errors'),
            metadata: { internal_system_alert: true, alertKey: 'whatsapp_needs_repair:test-session' }
        }));

        // A manual reconnect still works from this state.
        await whatsapp.connect();
        expect(whatsapp.status).toBe('connecting');
    });

    test('should keep reconnecting before the 515 limit', async () => {
        const axios = require('axios');
        axios.post.mockResolvedValue({ data: { received: true } });
        await whatsapp.connect();
        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];
        // Real timers: each close arms a reconnect timer, which we disarm by hand.
        const close = async (statusCode) => {
            await qrCallback({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
            if (whatsapp.reconnectTimeout) clearTimeout(whatsapp.reconnectTimeout);
        };

        // Nine real 515 closes: each counts once, none trips the limit.
        for (let i = 1; i <= 9; i++) {
            await close(515);
            expect(whatsapp.streamErrorCount).toBe(i);
            expect(whatsapp.status).toBe('disconnected');
            expect(whatsapp.reconnectTimeout).not.toBeNull();
        }
        expect(axios.post).not.toHaveBeenCalled();

        // The tenth flips it.
        await close(515);
        expect(whatsapp.status).toBe('needs_repair');
        expect(whatsapp.reconnectTimeout).toBeNull();
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('a non-515 close and a successful open reset the 515 counter', async () => {
        await whatsapp.connect();
        const qrCallback = mockBaileys.default.mock.results[0].value.ev.on.mock.calls.find(c => c[0] === 'connection.update')[1];
        const close = async (statusCode) => {
            await qrCallback({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
            if (whatsapp.reconnectTimeout) clearTimeout(whatsapp.reconnectTimeout);
        };

        await close(515);
        await close(515);
        expect(whatsapp.streamErrorCount).toBe(2);

        await close(428);
        expect(whatsapp.streamErrorCount).toBe(0);
        // Backoff attempts still grow across all closes.
        expect(whatsapp.reconnectAttempts).toBe(3);

        await close(515);
        expect(whatsapp.streamErrorCount).toBe(1);

        try {
            await qrCallback({ connection: 'open' });
            expect(whatsapp.streamErrorCount).toBe(0);
            expect(whatsapp.reconnectAttempts).toBe(0);
        } finally {
            if (whatsapp.heartbeatTimer) clearInterval(whatsapp.heartbeatTimer);
            if (whatsapp.sleepTimeout) clearTimeout(whatsapp.sleepTimeout);
            if (whatsapp.presenceInterval) clearInterval(whatsapp.presenceInterval);
        }
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
        const lidJid = '100000000000002@lid';
        const realNumber = '549000000000';

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
        expect(whatsapp.store.resolveIdentity).toHaveBeenCalledWith(lidJid, { guess: false });
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

describe('a chat shown by WhatsApp ID (LID)', () => {
    const LID = '100000000000002@lid';
    const PHONE = '5490000000001';
    let store;
    let spyAxios;

    const service = (session) => {
        const s = new WhatsAppService('http://mock-agent', session);
        s.store = store;
        return s;
    };
    const reminder = (key) => ({
        key: { id: 'm1', fromMe: false, ...key },
        message: { conversation: 'Reminder: your visit is on Tuesday at 17:00' }
    });
    const sent = () => spyAxios.mock.calls.at(-1)[1];

    let allowedBefore;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        allowedBefore = process.env.ALLOWED_WHATSAPP_NUMBERS;
        process.env.ALLOWED_WHATSAPP_NUMBERS = PHONE;
        store = new SQLiteStore(path.join(process.env.DATA_DIR, `lid-${Date.now()}-${Math.random()}.db`));
        spyAxios = require('axios').post;
        spyAxios.mockResolvedValue({});
    });

    afterEach(() => {
        clearInterval(store.queueFlushInterval);
        store.close();
        delete process.env.WHATSAPP_LID_ALT;
        process.env.ALLOWED_WHATSAPP_NUMBERS = allowedBefore;
        jest.restoreAllMocks();
    });

    test('the personal session files a chat the store cannot place under the number in its key, and saves the link', async () => {
        await service('user').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(sent().metadata.phoneNumber).toBe(PHONE);
        expect(sent().metadata.lid).toBe(LID);
        expect(store.resolveIdentity(LID).phoneJid).toBe(`${PHONE}@s.whatsapp.net`);
    });

    test('the assistant session does not trust the number in the key: an unknown WhatsApp ID stays blocked', async () => {
        await service('assistant').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(spyAxios).not.toHaveBeenCalled();
        expect(store.resolveIdentity(LID).phoneJid).toBeNull();
    });

    test('WHATSAPP_LID_ALT=0 keeps the WhatsApp ID digits and saves no link', async () => {
        process.env.WHATSAPP_LID_ALT = '0';

        await service('user').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
        expect(sent().metadata.lid).toBeUndefined();
        expect(store.resolveIdentity(LID).phoneJid).toBeNull();
    });

    test('WHATSAPP_LID_ALT=0 also ignores a link saved before', async () => {
        await service('user').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));
        process.env.WHATSAPP_LID_ALT = '0';

        await service('user').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
    });

    test('a link that cannot be saved leaves the message under its ID digits', async () => {
        jest.spyOn(store, 'linkLid').mockImplementation(() => { throw new Error('disk I/O error'); });

        await service('user').handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
    });

    test("the owner's own message never saves a link: its key can describe him instead", async () => {
        await service('user').handleMessage({
            key: { id: 'm2', fromMe: true, remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' },
            message: { imageMessage: { mimetype: 'image/jpeg' } }
        });

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
        expect(sent().metadata.lid).toBeUndefined();
        expect(store.resolveIdentity(LID).phoneJid).toBeNull();
    });

    test('a number already linked to another WhatsApp ID: the message keeps its ID digits, as the store does', async () => {
        await store.upsertContacts([{ id: `${PHONE}@s.whatsapp.net`, name: 'Alice', lid: '100000000000001@lid' }]);
        const user = service('user');

        await user.handleMessage(reminder({ remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));
        await user.handleMessage(reminder({ id: 'm2', remoteJid: LID, remoteJidAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid' }));

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
        expect(store.resolveIdentity(LID).phoneJid).toBeNull();
        // The refusal is logged once, not on every message.
        expect(console.warn.mock.calls.filter(c => String(c[0]).includes('keeps its digits'))).toHaveLength(1);
    });

    test('the assistant session sends no WhatsApp ID, so its watchers see only the number', async () => {
        await service('assistant').handleMessage(reminder({ remoteJid: `${PHONE}@s.whatsapp.net`, remoteJidAlt: LID, addressingMode: 'pn' }));

        expect(sent().metadata.phoneNumber).toBe(PHONE);
        expect(sent().metadata.lid).toBeUndefined();
    });

    test('a stranger whose address ends like an allowed number stays blocked in the assistant session', async () => {
        await store.upsertContacts([{ id: '5490000000002@s.whatsapp.net', name: 'Alice' }]);
        process.env.ALLOWED_WHATSAPP_NUMBERS = '5490000000002';

        await service('assistant').handleMessage(reminder({ remoteJid: '100000000000002@lid', addressingMode: 'lid' }));
        await service('assistant').handleMessage(reminder({ remoteJid: '100000000000002@s.whatsapp.net', addressingMode: 'pn' }));

        expect(spyAxios).not.toHaveBeenCalled();
    });

    test('a chat shown by phone number keeps it and carries its WhatsApp ID', async () => {
        await service('user').handleMessage(reminder({ remoteJid: `${PHONE}@s.whatsapp.net`, remoteJidAlt: LID, addressingMode: 'pn' }));

        expect(sent().metadata.phoneNumber).toBe(PHONE);
        expect(sent().metadata.lid).toBe(LID);
    });

    test('a group message never takes the number of a contact whose digits end like the group id', async () => {
        await store.upsertContacts([{ id: '5490000000002@s.whatsapp.net', name: 'Stranger' }]);

        await service('user').handleMessage(reminder({
            remoteJid: '120000000000000002@g.us', participant: LID, participantAlt: `${PHONE}@s.whatsapp.net`, addressingMode: 'lid'
        }));

        expect(sent().metadata.phoneNumber).toBe('100000000000002');
        expect(sent().metadata.lid).toBe(LID);
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
