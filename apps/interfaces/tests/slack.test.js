/**
 * SlackService Unit Tests
 * Tests: Lifecycle, credentials, message handling, search, history, encryption, edge cases.
 */

const crypto = require('crypto');
const fs = require('fs');

// Mock WebSocket before requiring SlackService
jest.mock('ws', () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        close: jest.fn(),
        send: jest.fn(),
    }));
});
jest.mock('axios');

describe('SlackService Unit Tests', () => {
    let SlackService;
    let slack;
    let mockFetch;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });

        process.env.DEEDEE_API_TOKEN = 'test-encryption-key-for-slack';
        process.env.DATA_DIR = '/tmp/test-slack-data';

        // Mock global fetch for Slack API calls
        mockFetch = jest.fn();
        global.fetch = mockFetch;

        // Re-require to get fresh instance
        jest.resetModules();
        ({ SlackService } = require('../src/slack'));
        slack = new SlackService('http://mock-agent:3000');
    });

    afterEach(() => {
        delete global.fetch;
        // Clean up any credential files
        try { fs.unlinkSync('/tmp/test-slack-data/slack-credentials.json'); } catch { }
    });

    // --- Constructor & Initial State ---

    test('should initialize with disconnected state', () => {
        expect(slack.connected).toBe(false);
        expect(slack.xoxc).toBeNull();
        expect(slack.xoxd).toBeNull();
        expect(slack.workspace).toBeNull();
        expect(slack.ws).toBeNull();
        expect(slack.pollInterval).toBeNull();
    });

    test('getStatus() should return disconnected when no tokens', () => {
        const status = slack.getStatus();
        expect(status.connected).toBe(false);
        expect(status.workspace).toBeNull();
        expect(status.user).toBeNull();
        expect(status.mode).toBe('disconnected');
        expect(status.tokenAge).toBeNull();
    });

    // --- Encryption / Decryption ---

    test('should encrypt and decrypt round-trip correctly', () => {
        const original = 'xoxc-super-secret-token-12345';
        const encrypted = slack._encrypt(original);

        expect(encrypted).toHaveProperty('iv');
        expect(encrypted).toHaveProperty('data');
        expect(encrypted).toHaveProperty('tag');
        expect(encrypted.data).not.toBe(original);

        const decrypted = slack._decrypt(encrypted);
        expect(decrypted).toBe(original);
    });

    test('should fail decryption with wrong key', () => {
        const original = 'xoxc-secret';
        const encrypted = slack._encrypt(original);

        // Change the key
        process.env.DEEDEE_API_TOKEN = 'wrong-key';
        expect(() => slack._decrypt(encrypted)).toThrow();
    });

    test('should fail decryption with tampered data', () => {
        const original = 'xoxc-secret';
        const encrypted = slack._encrypt(original);

        // Tamper with ciphertext
        encrypted.data = 'deadbeef' + encrypted.data.substring(8);
        expect(() => slack._decrypt(encrypted)).toThrow();
    });

    test('_getEncryptionKey should throw if no DEEDEE_API_TOKEN', () => {
        delete process.env.DEEDEE_API_TOKEN;
        expect(() => slack._getEncryptionKey()).toThrow('DEEDEE_API_TOKEN required');
    });

    // --- Credential Save/Load ---

    test('should save and load credentials', () => {
        slack._saveCredentials('xoxc-test', 'xoxd-test');

        expect(fs.existsSync('/tmp/test-slack-data/slack-credentials.json')).toBe(true);
        expect(slack.credentialsSavedAt).toBeDefined();

        const loaded = slack._loadCredentials();
        expect(loaded.xoxc).toBe('xoxc-test');
        expect(loaded.xoxd).toBe('xoxd-test');
        expect(loaded.savedAt).toBeDefined();
    });

    test('_loadCredentials should return null if no file', () => {
        const loaded = slack._loadCredentials();
        expect(loaded).toBeNull();
    });

    test('clearCredentials should wipe state and delete file', () => {
        slack._saveCredentials('xoxc-test', 'xoxd-test');
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';
        slack.connected = true;

        slack.clearCredentials();

        expect(slack.xoxc).toBeNull();
        expect(slack.xoxd).toBeNull();
        expect(slack.connected).toBe(false);
        expect(slack.workspace).toBeNull();
        expect(fs.existsSync('/tmp/test-slack-data/slack-credentials.json')).toBe(false);
    });

    // --- API Client ---

    test('_api should throw if no tokens configured', async () => {
        await expect(slack._api('auth.test')).rejects.toThrow('missing tokens');
    });

    test('_api should call fetch with correct auth headers', async () => {
        slack.xoxc = 'xoxc-my-token';
        slack.xoxd = 'xoxd-my-cookie';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, team: 'TestTeam' }),
        });

        const result = await slack._api('auth.test');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://slack.com/api/auth.test',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer xoxc-my-token',
                    'Cookie': 'd=xoxd-my-cookie',
                }),
            })
        );
        expect(result.team).toBe('TestTeam');
    });

    test('_api should throw on Slack API error response', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
        });

        await expect(slack._api('conversations.history')).rejects.toThrow('channel_not_found');
    });

    test('_api should notify on token_revoked error', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false, error: 'token_revoked' }),
        });

        await expect(slack._api('auth.test')).rejects.toThrow('token_revoked');
        // _notifyTokenExpired should have been called (posts to agent webhook)
        expect(axios.post).toHaveBeenCalledWith(
            'http://mock-agent:3000/webhook',
            expect.objectContaining({
                source: 'system',
                content: expect.stringContaining('Slack token has expired'),
            })
        );
    });

    // --- Credential Setting ---

    test('setCredentials should validate, save, and connect', async () => {
        mockFetch
            .mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, team: 'MyTeam', team_id: 'T123', user: 'diego', user_id: 'U456' }),
            })
            // RTM connect call
            .mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: false, error: 'not_allowed' }), // RTM won't be allowed for cookie auth
            });

        // RTM will fail, should fall back to polling
        const result = await slack.setCredentials('xoxc-new', 'xoxd-new');

        expect(result.team).toBe('MyTeam');
        expect(result.user).toBe('diego');
        expect(slack.workspace.team).toBe('MyTeam');
        expect(slack.workspace.userId).toBe('U456');
        // Should have saved credentials
        expect(slack.credentialsSavedAt).toBeDefined();
    });

    test('setCredentials should throw on invalid token', async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
        });

        await expect(slack.setCredentials('xoxc-bad', 'xoxd-bad')).rejects.toThrow('invalid_auth');
    });

    // --- getStatus ---

    test('getStatus should report correct mode when polling', () => {
        slack.connected = true;
        slack.pollInterval = setInterval(() => { }, 99999);
        slack.workspace = { team: 'TestCo', user: 'bot' };

        const status = slack.getStatus();
        expect(status.connected).toBe(true);
        expect(status.mode).toBe('polling');
        expect(status.workspace).toBe('TestCo');
        expect(status.user).toBe('bot');

        clearInterval(slack.pollInterval);
    });

    test('getStatus should compute tokenAge correctly', () => {
        slack.credentialsSavedAt = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago
        const status = slack.getStatus();
        expect(status.tokenAge).toBe('3 days');
    });

    // --- Resolution Caches ---

    test('_resolveUser should cache results', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                user: { profile: { display_name: 'Diego' }, real_name: 'Diego S', name: 'diego' },
            }),
        });

        const name1 = await slack._resolveUser('U123');
        expect(name1).toBe('Diego');

        // Second call should use cache (no additional fetch)
        const name2 = await slack._resolveUser('U123');
        expect(name2).toBe('Diego');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('_resolveUser should fallback to userId on error', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false, error: 'user_not_found' }),
        });

        const name = await slack._resolveUser('U999');
        expect(name).toBe('U999');
    });

    test('_resolveChannel should cache results', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                channel: { name: 'general', is_im: false, is_mpim: false },
            }),
        });

        const info1 = await slack._resolveChannel('C123');
        expect(info1.name).toBe('general');
        expect(info1.type).toBe('channel');

        // Cached
        const info2 = await slack._resolveChannel('C123');
        expect(info2.name).toBe('general');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('_resolveChannel should detect DM type', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                channel: { name: 'U456', is_im: true },
            }),
        });

        const info = await slack._resolveChannel('D789');
        expect(info.type).toBe('im');
    });

    // --- Message Handling ---

    test('_handleMessage should forward to agent webhook', async () => {
        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';
        slack.workspace = { userId: 'U001' };

        // Mock user/channel resolution
        slack.userCache.set('U123', 'Diego');
        slack.channelCache.set('C456', { name: 'general', type: 'channel' });

        await slack._handleMessage({ user: 'U123', channel: 'C456', text: 'Hello bot', ts: '1234567890.123' });

        expect(axios.post).toHaveBeenCalledWith(
            'http://mock-agent:3000/webhook',
            expect.objectContaining({
                source: 'slack',
                content: 'Hello bot',
                metadata: expect.objectContaining({
                    chatId: 'C456',
                    slackUserId: 'U123',
                    slackUserName: 'Diego',
                    channelName: 'general',
                    channelType: 'channel',
                }),
            })
        );
    });

    test('_handleMessage should format DM contact string differently from channel', async () => {
        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';
        slack.workspace = { userId: 'U001' };

        slack.userCache.set('U123', 'Diego');
        slack.channelCache.set('D789', { name: 'Diego', type: 'im' });

        await slack._handleMessage({ user: 'U123', channel: 'D789', text: 'DM test', ts: '123.456' });

        const call = axios.post.mock.calls[0][1];
        expect(call.metadata.phoneNumber).toBe('Diego'); // DM: just the name
    });

    test('_handleMessage should include thread_ts in metadata', async () => {
        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';
        slack.workspace = { userId: 'U001' };
        slack.userCache.set('U123', 'User');
        slack.channelCache.set('C100', { name: 'dev', type: 'channel' });

        await slack._handleMessage({
            user: 'U123', channel: 'C100',
            text: 'Thread reply', ts: '100.200', thread_ts: '100.100'
        });

        const meta = axios.post.mock.calls[0][1].metadata;
        expect(meta.thread_ts).toBe('100.100');
    });

    // --- sendMessage ---

    test('sendMessage should call chat.postMessage with correct params', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, ts: '123.456' }),
        });

        await slack.sendMessage('C123', 'Hello world');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://slack.com/api/chat.postMessage',
            expect.objectContaining({
                body: expect.stringContaining('"channel":"C123"'),
            })
        );
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.text).toBe('Hello world');
        expect(body.as_user).toBe(true);
    });

    test('sendMessage should pass thread_ts when provided', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true }),
        });

        await slack.sendMessage('C123', 'Thread reply', { thread_ts: '100.200' });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.thread_ts).toBe('100.200');
    });

    // --- Search ---

    test('search should limit results to max 50', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, messages: { matches: [] } }),
        });

        await slack.search('test', 200);

        const body = Object.fromEntries(new URLSearchParams(mockFetch.mock.calls[0][1].body));
        expect(body.count).toBe('50'); // Clamped at 50 (string from URLSearchParams)
    });

    test('search should return formatted results', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                messages: {
                    matches: [
                        { text: 'Found it', username: 'diego', channel: { name: 'general' }, ts: '123.456', permalink: 'https://slack.com/...' }
                    ],
                },
            }),
        });

        const results = await slack.search('test query');
        expect(results).toHaveLength(1);
        expect(results[0].text).toBe('Found it');
        expect(results[0].user).toBe('diego');
        expect(results[0].channel).toBe('general');
    });

    test('search should return empty array when no matches', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, messages: {} }),
        });

        const results = await slack.search('nothing here');
        expect(results).toEqual([]);
    });

    // --- getHistory ---

    test('getHistory should limit results to max 100', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, messages: [] }),
        });

        await slack.getHistory('C123', 500);

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.limit).toBe(100);
    });

    test('getHistory should resolve #channel-name to ID', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        // Mock channel resolution
        slack.channelNameToId.set('general', 'C123');

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                messages: [
                    { text: 'Hello', user: 'U1', ts: '100.1' }
                ],
            }),
        });
        // Resolve user
        slack.userCache.set('U1', 'Diego');

        const messages = await slack.getHistory('#general');
        expect(messages).toHaveLength(1);
        expect(messages[0].user).toBe('Diego');
    });

    test('getHistory should return error for unknown channel name', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        // Mock channel list API (no matching channel)
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, channels: [] }),
        });

        const result = await slack.getHistory('#nonexistent');
        expect(result).toEqual({ error: 'Channel "#nonexistent" not found' });
    });

    test('getHistory should accept channel IDs starting with C or D', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, messages: [] }),
        });

        const result = await slack.getHistory('C123ABCD');
        expect(result).toEqual([]); // No resolution needed, direct API call
    });

    test('getHistory should return messages in chronological order', async () => {
        slack.xoxc = 'xoxc-test';
        slack.xoxd = 'xoxd-test';

        slack.userCache.set('U1', 'Alice');
        slack.userCache.set('U2', 'Bob');

        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({
                ok: true,
                messages: [
                    { text: 'Newest', user: 'U2', ts: '100.3' },
                    { text: 'Middle', user: 'U1', ts: '100.2' },
                    { text: 'Oldest', user: 'U1', ts: '100.1' },
                ],
            }),
        });

        const messages = await slack.getHistory('C123');
        // reversed: oldest first
        expect(messages[0].text).toBe('Oldest');
        expect(messages[2].text).toBe('Newest');
    });

    // --- Lifecycle ---

    test('start() should skip when no credentials exist', async () => {
        await slack.start();
        expect(slack.connected).toBe(false);
        expect(slack.xoxc).toBeNull();
    });

    test('stop() should clear intervals and WebSocket', () => {
        slack.pollInterval = setInterval(() => { }, 99999);
        slack.connected = true;
        const mockWs = { close: jest.fn() };
        slack.ws = mockWs;

        slack.stop();

        expect(mockWs.close).toHaveBeenCalled();
        expect(slack.ws).toBeNull();
        expect(slack.pollInterval).toBeNull();
        expect(slack.connected).toBe(false);
    });

    test('_startPolling should not start duplicate intervals', () => {
        slack.pollInterval = setInterval(() => { }, 99999);
        const existing = slack.pollInterval;

        slack._startPolling();
        expect(slack.pollInterval).toBe(existing); // Same interval, no duplicate

        clearInterval(slack.pollInterval);
    });

    // --- Token Expiry Notification ---

    test('_notifyTokenExpired should post system alert to agent', async () => {
        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        await slack._notifyTokenExpired();

        expect(axios.post).toHaveBeenCalledWith(
            'http://mock-agent:3000/webhook',
            expect.objectContaining({
                source: 'system',
                content: expect.stringContaining('Slack token has expired'),
                metadata: expect.objectContaining({ internal_system_alert: true }),
            })
        );
    });
});
