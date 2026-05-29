/**
 * SlackManager Unit Tests
 * Tests: Lifecycle, credentials, message handling, search, history, encryption, edge cases.
 */

const crypto = require('crypto');
const fs = require('fs');

// Mock WebSocket before requiring SlackManager
jest.mock('ws', () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        close: jest.fn(),
        send: jest.fn(),
    }));
});
jest.mock('axios');

describe('SlackManager Unit Tests', () => {
    let SlackManager;
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
        const imported = require('../src/slack');
        SlackManager = imported.SlackManager;
        slack = new SlackManager('http://mock-agent:3000');
    });

    afterEach(() => {
        delete global.fetch;
        try { fs.unlinkSync('/tmp/test-slack-data/slack-credentials.json'); } catch { }
    });

    // --- Constructor & Initial State ---

    test('should initialize with no connections', () => {
        expect(slack.connections.size).toBe(0);
    });

    test('start() should skip when no credentials exist', async () => {
        await slack.start();
        expect(slack.connections.size).toBe(0);
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

        process.env.DEEDEE_API_TOKEN = 'wrong-key';
        expect(() => slack._decrypt(encrypted)).toThrow();
    });

    test('_getEncryptionKey should throw if no DEEDEE_API_TOKEN', () => {
        delete process.env.DEEDEE_API_TOKEN;
        expect(() => slack._getEncryptionKey()).toThrow('DEEDEE_API_TOKEN required');
    });

    // --- Credential Save/Load ---

    test('should save and load credentials', async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, team: 'MyTeam', team_id: 'T123', user: 'diego', user_id: 'U456' }),
        }).mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false, error: 'not_allowed' }), // RTM fail
        });

        await slack.addConnection('xoxc-test', 'xoxd-test');
        expect(fs.existsSync('/tmp/test-slack-data/slack-credentials.json')).toBe(true);

        const loaded = slack._loadCredentials();
        expect(loaded.length).toBe(1);
        expect(loaded[0].xoxc).toBe('xoxc-test');
        expect(loaded[0].xoxd).toBe('xoxd-test');
    });

    // --- Connection resolution ---
    test('resolveConnection should auto-resolve if 1 connection', async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, team: 'T1', team_id: 'T123' })
        }).mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false })
        });

        await slack.addConnection('xoxc-a', 'xoxc-b');
        const conn = slack.resolveConnection(null);
        expect(conn.workspace.teamId).toBe('T123');
    });

    test('resolveConnection should throw if multiple connections and missing teamId', async () => {
        mockFetch.mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, team: 'T1', team_id: 'T1' })
        }).mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false })
        }).mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: true, team: 'T2', team_id: 'T2' })
        }).mockResolvedValueOnce({
            json: () => Promise.resolve({ ok: false })
        });

        await slack.addConnection('xoxc-1', 'xoxd-1');
        await slack.addConnection('xoxc-2', 'xoxd-2');

        expect(() => slack.resolveConnection(null)).toThrow('Multiple workspaces connected. Please specify teamId.');
    });

    // --- Token Expiry Notification ---

    test('_notifyTokenExpired should post system alert to agent', async () => {
        const axios = require('axios');
        axios.post = jest.fn().mockResolvedValue({});

        await slack._notifyTokenExpired('T123');

        expect(axios.post).toHaveBeenCalledWith(
            'http://mock-agent:3000/webhook',
            expect.objectContaining({
                source: 'system',
                content: expect.stringContaining('Slack token for team T123 has expired'),
                metadata: expect.objectContaining({
                    internal_system_alert: true,
                    alertKey: 'slack_token_expired:T123',
                }),
            })
        );
    });

    // Regression for the 2026-05-27 storm: a dead token re-fired the expiry
    // path on every failed poll AND every failed agent tool call, so the owner
    // got dozens of reworded WhatsApp alerts. The latch must fire onTokenExpired
    // exactly once and then short-circuit further API calls without re-firing.
    test('token-expiry latch fires onTokenExpired once and short-circuits further _api calls', async () => {
        const { SlackConnection } = require('../src/slack');
        const onExpired = jest.fn();
        const conn = new SlackConnection('http://mock-agent:3000', {
            xoxc: 'xoxc-dead',
            xoxd: 'xoxd-dead',
            workspace: { team: 'MyTeam', teamId: 'T999' },
        }, onExpired);

        // Every Slack call returns invalid_auth.
        mockFetch.mockResolvedValue({
            json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
        });

        // First failing call detects expiry, latches, and notifies once.
        await expect(conn._api('conversations.list')).rejects.toThrow(/invalid_auth/);
        expect(conn.tokenExpired).toBe(true);
        expect(onExpired).toHaveBeenCalledTimes(1);
        expect(onExpired).toHaveBeenCalledWith('T999');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Subsequent calls (e.g. proactive-loop tools) short-circuit: no network,
        // no re-fire of the expiry notification.
        await expect(conn._api('conversations.history')).rejects.toThrow(/token_expired_latched/);
        await expect(conn._api('users.info')).rejects.toThrow(/token_expired_latched/);
        expect(onExpired).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // --- API & Connections (SlackConnection tests) ---
    describe('SlackConnection', () => {
        let conn;
        beforeEach(async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, team: 'MyTeam', team_id: 'T123', user: 'diego', user_id: 'U456' }),
            }).mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: false }) // RTM fails
            });
            await slack.addConnection('xoxc-test', 'xoxd-test');
            conn = slack.connections.get('T123');
            mockFetch.mockClear();
        });

        test('_api should call fetch with correct auth headers', async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, team: 'TestTeam' }),
            });

            await conn._api('auth.test');

            expect(mockFetch).toHaveBeenCalledWith(
                'https://slack.com/api/auth.test',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer xoxc-test',
                        'Cookie': 'd=xoxd-test',
                    }),
                })
            );
        });

        // Regression: a connection created via addConnection (UI re-login) must
        // wire the expiry handler, so a later token expiry still alerts the
        // owner — not just connections built at startup via _initConnection.
        test('a connection added via addConnection notifies the owner on token expiry', async () => {
            const axios = require('axios');
            axios.post = jest.fn().mockResolvedValue({});

            mockFetch.mockResolvedValue({
                json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
            });

            await expect(conn._api('conversations.list')).rejects.toThrow();

            expect(conn.tokenExpired).toBe(true);
            expect(axios.post).toHaveBeenCalledWith(
                'http://mock-agent:3000/webhook',
                expect.objectContaining({
                    metadata: expect.objectContaining({ alertKey: 'slack_token_expired:T123' }),
                })
            );
        });

        test('search should limit results to max 50', async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, messages: { matches: [] } }),
            });

            await slack.search('test', 200);

            const body = Object.fromEntries(new URLSearchParams(mockFetch.mock.calls[0][1].body));
            expect(body.count).toBe('50'); // Clamped at 50 (string from URLSearchParams)
        });

        test('search should return formatted results', async () => {
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

        test('sendMessage should pass thread_ts when provided', async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true }),
            });

            await slack.sendMessage('C123', 'Thread reply', { thread_ts: '100.200' });

            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.thread_ts).toBe('100.200');
        });

        test('_handleMessage should forward to agent webhook with team data', async () => {
            const axios = require('axios');
            axios.post = jest.fn().mockResolvedValue({});

            conn.userCache.set('U123', 'Diego');
            conn.channelCache.set('C456', { name: 'general', type: 'channel' });

            await conn._handleMessage({ user: 'U123', channel: 'C456', text: 'Hello bot', ts: '1234567890.123' });

            expect(axios.post).toHaveBeenCalledWith(
                'http://mock-agent:3000/webhook',
                expect.objectContaining({
                    source: 'slack',
                    content: 'Hello bot',
                    metadata: expect.objectContaining({
                        chatId: 'C456',
                        teamId: 'T123',
                        slackUserName: 'Diego',
                    }),
                })
            );
        });

        test('getHistory should return messages in chronological order', async () => {
            conn.userCache.set('U1', 'Alice');
            conn.userCache.set('U2', 'Bob');

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

        test('getHistory should resolve #channel-name to ID', async () => {
            conn.channelNameToId.set('general', 'C123');

            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({
                    ok: true,
                    messages: [
                        { text: 'Hello', user: 'U1', ts: '100.1' }
                    ],
                }),
            });
            conn.userCache.set('U1', 'Diego');

            const messages = await slack.getHistory('#general');
            expect(messages).toHaveLength(1);
            expect(messages[0].user).toBe('Diego');
        });

        test('getHistory should return error for unknown channel name', async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, channels: [] }),
            });

            const result = await slack.getHistory('#nonexistent');
            expect(result.error).toContain('Channel "#nonexistent" not found');
        });

        test('getHistory should limit results to max 100', async () => {
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({ ok: true, messages: [] }),
            });

            await slack.getHistory('C123', 500);

            let body;
            const parseCalls = mockFetch.mock.calls;
            body = JSON.parse(parseCalls[0][1].body);
            expect(body.limit).toBe(100);
        });
    });
});
