/**
 * SlackExecutor Unit Tests
 * Tests: Tool routing, param handling, error handling, URL encoding.
 */

jest.mock('axios');
const axios = require('axios');
const { SlackExecutor } = require('../src/executors/slack');

describe('SlackExecutor', () => {
    let executor;
    let mockContext;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });

        process.env.INTERFACES_URL = 'http://interfaces:5000';
        process.env.DEEDEE_API_TOKEN = 'test-token';

        executor = new SlackExecutor({});
        mockContext = { message: { metadata: {} } };
    });

    // --- Unknown tools ---

    test('should return null for unknown tool names', async () => {
        const result = await executor.execute('unknownTool', {}, mockContext);
        expect(result).toBeNull();
    });

    test('should return null for other executor tools', async () => {
        const result = await executor.execute('sendMessage', { to: 'test' }, mockContext);
        expect(result).toBeNull();
    });

    // --- searchSlack ---

    test('searchSlack should call search endpoint with encoded params', async () => {
        axios.get.mockResolvedValueOnce({
            data: { results: [{ text: 'Found', user: 'diego', channel: 'general' }] },
        });

        const result = await executor.execute('searchSlack', { query: 'deploy #dev' }, mockContext);

        expect(axios.get).toHaveBeenCalledWith(
            'http://interfaces:5000/slack/search',
            expect.objectContaining({
                params: { query: encodeURIComponent('deploy #dev'), limit: 10 },
                headers: { Authorization: 'Bearer test-token' },
            })
        );
        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(1);
        expect(result.count).toBe(1);
    });

    test('searchSlack should respect limit param', async () => {
        axios.get.mockResolvedValueOnce({ data: { results: [] } });

        await executor.execute('searchSlack', { query: 'test', limit: 25 }, mockContext);

        expect(axios.get).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ params: expect.objectContaining({ limit: 25 }) })
        );
    });

    test('searchSlack should handle API errors gracefully', async () => {
        axios.get.mockRejectedValueOnce({
            response: { data: { error: 'Slack not connected' } },
        });

        const result = await executor.execute('searchSlack', { query: 'test' }, mockContext);
        expect(result.success).toBe(false);
        expect(result.error).toBe('Slack not connected');
    });

    test('searchSlack should handle network errors', async () => {
        axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await executor.execute('searchSlack', { query: 'test' }, mockContext);
        expect(result.success).toBe(false);
        expect(result.error).toBe('ECONNREFUSED');
    });

    // --- readSlackHistory ---

    test('readSlackHistory should call history endpoint with encoded channel', async () => {
        axios.get.mockResolvedValueOnce({
            data: { messages: [{ text: 'Hello', user: 'diego' }] },
        });

        const result = await executor.execute('readSlackHistory', { channel: '#general' }, mockContext);

        expect(axios.get).toHaveBeenCalledWith(
            'http://interfaces:5000/slack/history',
            expect.objectContaining({
                params: { channel: encodeURIComponent('#general'), limit: 20, days_back: 2 },
            })
        );
        expect(result.success).toBe(true);
        expect(result.messages).toHaveLength(1);
        expect(result.count).toBe(1);
    });

    test('readSlackHistory should handle API errors gracefully', async () => {
        axios.get.mockRejectedValueOnce({
            response: { data: { error: 'channel_not_found' } },
        });

        const result = await executor.execute('readSlackHistory', { channel: 'C123' }, mockContext);
        expect(result.success).toBe(false);
        expect(result.error).toBe('channel_not_found');
    });

    // --- sendSlackMessage ---

    test('sendSlackMessage should POST to /send with correct payload', async () => {
        axios.post.mockResolvedValueOnce({ data: { success: true } });

        const result = await executor.execute('sendSlackMessage', {
            channel: 'C123',
            text: 'Hello from bot',
        }, mockContext);

        expect(axios.post).toHaveBeenCalledWith(
            'http://interfaces:5000/send',
            {
                source: 'slack',
                content: 'Hello from bot',
                metadata: { chatId: 'C123', thread_ts: undefined },
            },
            { headers: { Authorization: 'Bearer test-token' } }
        );
        expect(result.success).toBe(true);
        expect(result.info).toContain('C123');
    });

    test('sendSlackMessage should pass thread_ts for threaded replies', async () => {
        axios.post.mockResolvedValueOnce({ data: { success: true } });

        await executor.execute('sendSlackMessage', {
            channel: 'C123',
            text: 'Thread reply',
            thread_ts: '100.200',
        }, mockContext);

        expect(axios.post).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                metadata: { chatId: 'C123', thread_ts: '100.200' },
            }),
            expect.any(Object)
        );
    });

    test('sendSlackMessage should handle send failure', async () => {
        axios.post.mockRejectedValueOnce({
            response: { data: { error: 'Slack not connected' } },
        });

        const result = await executor.execute('sendSlackMessage', {
            channel: 'C123',
            text: 'Fail test',
        }, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toBe('Slack not connected');
    });

    // --- Environment ---

    test('should use INTERFACES_URL from environment', async () => {
        process.env.INTERFACES_URL = 'http://custom-host:9000';
        executor = new SlackExecutor({});

        axios.get.mockResolvedValueOnce({ data: { results: [] } });
        await executor.execute('searchSlack', { query: 'test' }, mockContext);

        expect(axios.get).toHaveBeenCalledWith(
            'http://custom-host:9000/slack/search',
            expect.any(Object)
        );
    });
});
