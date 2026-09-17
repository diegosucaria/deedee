const { SmartContextManager } = require('../src/smart-context');

describe('SmartContextManager.ensureAlternation', () => {
    const ea = SmartContextManager.ensureAlternation;

    it('should return empty array for empty input', () => {
        expect(ea([])).toEqual([]);
        expect(ea(null)).toEqual([]);
        expect(ea(undefined)).toEqual([]);
    });

    it('should pass through properly alternating history unchanged', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi there' }] },
            { role: 'user', parts: [{ text: 'How are you?' }] },
            { role: 'model', parts: [{ text: 'Good!' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(4);
        expect(result.map(m => m.role)).toEqual(['user', 'model', 'user', 'model']);
    });

    it('should drop leading model messages', () => {
        const history = [
            { role: 'model', parts: [{ text: 'Orphan model response' }] },
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('user');
        expect(result[0].parts[0].text).toBe('Hello');
    });

    it('should merge consecutive same-role messages (the core bug fix)', () => {
        // This is the exact scenario: summary ack (model) + first history message (model)
        const history = [
            { role: 'user', parts: [{ text: 'Summary context' }] },
            { role: 'model', parts: [{ text: 'Acknowledged summary' }] },
            { role: 'model', parts: [{ text: 'Previous model response from history' }] },
            { role: 'user', parts: [{ text: 'New user message' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('user');
        expect(result[1].role).toBe('model');
        // Model parts should be merged
        expect(result[1].parts).toHaveLength(2);
        expect(result[1].parts[0].text).toBe('Acknowledged summary');
        expect(result[1].parts[1].text).toBe('Previous model response from history');
        expect(result[2].role).toBe('user');
    });

    it('should merge multiple consecutive user messages', () => {
        const history = [
            { role: 'user', parts: [{ text: 'First' }] },
            { role: 'user', parts: [{ text: 'Second' }] },
            { role: 'model', parts: [{ text: 'Reply' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('user');
        expect(result[0].parts).toHaveLength(2);
        expect(result[0].parts[0].text).toBe('First');
        expect(result[0].parts[1].text).toBe('Second');
    });

    it('should handle history that is all model messages (return empty)', () => {
        const history = [
            { role: 'model', parts: [{ text: 'A' }] },
            { role: 'model', parts: [{ text: 'B' }] },
        ];
        const result = ea(history);
        expect(result).toEqual([]);
    });

    it('should handle single user message', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Hello' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
    });

    it('should handle function call/response patterns (model with functionCall + user with functionResponse)', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Turn on the lights' }] },
            { role: 'model', parts: [{ functionCall: { name: 'toggleLight', args: { on: true } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'toggleLight', response: { success: true } } }] },
            { role: 'model', parts: [{ text: 'Done! Lights are on.' }] },
        ];
        const result = ea(history);
        expect(result).toHaveLength(4);
        expect(result.map(m => m.role)).toEqual(['user', 'model', 'user', 'model']);
    });

    it('should not mutate original messages', () => {
        const original = [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'user', parts: [{ text: 'World' }] },
        ];
        const originalParts0 = [...original[0].parts];
        ea(original);
        // Original should not be mutated
        expect(original[0].parts).toEqual(originalParts0);
        expect(original).toHaveLength(2);
    });

    it('should handle the full summary injection scenario with model-starting history', () => {
        // Simulate: summary user + summary ack(model) + history starts with model (the bug)
        const summaryUser = { role: 'user', parts: [{ text: '[SYSTEM: Context Summary]\nSome summary' }] };
        const summaryAck = { role: 'model', parts: [{ text: 'Understood.' }] };
        const historyStartingWithModel = [
            { role: 'model', parts: [{ text: 'Previous response' }] },
            { role: 'user', parts: [{ text: 'Follow up' }] },
            { role: 'model', parts: [{ text: 'Another response' }] },
        ];

        const combined = [summaryUser, summaryAck, ...historyStartingWithModel];
        const result = ea(combined);

        // Verify strict alternation
        for (let i = 1; i < result.length; i++) {
            expect(result[i].role).not.toBe(result[i - 1].role);
        }
        // Should start with user
        expect(result[0].role).toBe('user');
        // The two model messages (ack + first history) should be merged
        expect(result[1].role).toBe('model');
        expect(result[1].parts).toHaveLength(2);
    });

    it('should handle history with multiple parts per message', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Part 1' }, { text: 'Part 2' }] },
            { role: 'model', parts: [{ text: 'Response' }] },
        ];
        const result = ea(history);
        expect(result[0].parts).toHaveLength(2);
    });
});

describe('SmartContextManager.normalizeHistoryForModel', () => {
    const normalize = SmartContextManager.normalizeHistoryForModel;
    const user = (text) => ({ role: 'user', parts: [{ text }] });
    const model = (text) => ({ role: 'model', parts: [{ text }] });
    const call = (...names) => ({ role: 'model', parts: names.map(name => ({ functionCall: { name, args: {} } })) });
    const response = (...names) => ({ role: 'user', parts: names.map(name => ({ functionResponse: { name, response: { ok: true } } })) });
    const roles = (rows) => rows.map(r => r.role);
    const callNames = (row) => row.parts.filter(p => p.functionCall).map(p => p.functionCall.name);
    const responseNames = (row) => row.parts.filter(p => p.functionResponse).map(p => p.functionResponse.name);

    it('returns [] for empty or bad input', () => {
        expect(normalize([])).toEqual([]);
        expect(normalize(null)).toEqual([]);
        expect(normalize(undefined)).toEqual([]);
    });

    it('leaves plain text history unchanged', () => {
        const history = [user('Hello'), model('Hi'), user('How are you?'), model('Good!')];
        expect(normalize(history)).toEqual(history);
    });

    it('keeps matched call/response pairs, including several loops in a row', () => {
        const history = [
            user('Lights and weather'),
            call('toggleLight', 'getWeather'),
            response('toggleLight', 'getWeather'),
            call('getForecast'),
            response('getForecast'),
            model('Done.'),
            user('Thanks'),
        ];
        const out = normalize(history);
        expect(out).toEqual(history);
    });

    it('drops a window that starts with an orphan functionResponse', () => {
        const history = [
            response('getWeather'),
            model('It is sunny.'),
            user('Thanks'),
            model('Welcome.'),
        ];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model']);
        expect(out[0].parts[0].text).toBe('Thanks');
    });

    it('drops an orphan functionResponse in the middle of the window', () => {
        const history = [user('a'), model('b'), response('t'), user('c')];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model', 'user']);
        expect(out.some(r => r.parts.some(p => p.functionResponse))).toBe(false);
    });

    it('keeps only the calls that have a response when the agent dropped duplicates', () => {
        // The model asked for getWeather twice; the agent ran it once.
        const history = [
            user('Weather?'),
            call('getWeather', 'getWeather', 'getTime'),
            response('getWeather', 'getTime'),
            model('20 degrees at noon.'),
        ];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model', 'user', 'model']);
        expect(callNames(out[1])).toEqual(['getWeather', 'getTime']);
        expect(responseNames(out[2])).toEqual(['getWeather', 'getTime']);
    });

    it('drops responses that have no call and calls that have no response', () => {
        const history = [
            user('Go'),
            call('a', 'b'),
            response('b', 'zzz'),
            model('ok'),
        ];
        const out = normalize(history);
        expect(callNames(out[1])).toEqual(['b']);
        expect(responseNames(out[2])).toEqual(['b']);
    });

    it('drops the pair when no call has a response', () => {
        const history = [user('Go'), call('a'), response('b'), model('ok')];
        expect(roles(normalize(history))).toEqual(['user', 'model']);
        expect(normalize(history)[1].parts[0].text).toBe('ok');
    });

    it('drops a trailing functionCall with no response', () => {
        const history = [user('Weather?'), model('Checking'), call('getWeather')];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model']);
        expect(out[1].parts[0].text).toBe('Checking');
    });

    it('drops a functionCall row followed by a plain user row', () => {
        const history = [user('Weather?'), call('getWeather'), user('Never mind'), model('Ok')];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'user', 'model']);
        expect(out.some(r => r.parts.some(p => p.functionCall))).toBe(false);
    });

    it('keeps the model text next to a matched call', () => {
        const history = [
            user('Weather?'),
            { role: 'model', parts: [{ text: 'Let me check.' }, { functionCall: { name: 'getWeather', args: {} } }] },
            response('getWeather'),
            model('Sunny.'),
        ];
        const out = normalize(history);
        expect(out[1].parts).toHaveLength(2);
        expect(out[1].parts[0].text).toBe('Let me check.');
    });

    it('accepts response rows with the raw function role', () => {
        const history = [user('Go'), call('t'), { role: 'function', parts: [{ functionResponse: { name: 't', response: {} } }] }, model('ok')];
        expect(normalize(history)).toHaveLength(4);
    });

    it('drops leading rows until the first user row with text', () => {
        const history = [
            model('Orphan'),
            { role: 'user', parts: [{ text: '' }] },
            user('Hello'),
            model('Hi'),
        ];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model']);
        expect(out[0].parts[0].text).toBe('Hello');
    });

    it('drops rows with no parts and empty parts', () => {
        const history = [user('Hello'), { role: 'model', parts: [] }, { role: 'model', parts: [{}] }, model('Hi'), { role: 'user' }];
        const out = normalize(history);
        expect(roles(out)).toEqual(['user', 'model']);
    });

    it('replaces inlineData with a text marker by media type', () => {
        const history = [
            { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] },
            model('Nice photo.'),
            { role: 'user', parts: [{ text: 'Listen' }, { inlineData: { mimeType: 'audio/ogg', data: 'BBBB' } }] },
            model('Heard it.'),
            { role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'CCCC' } }, { text: 'Read this' }] },
        ];
        const out = normalize(history);
        expect(JSON.stringify(out)).not.toContain('inlineData');
        expect(out[0].parts).toEqual([{ text: '[image attached]' }]);
        expect(out[2].parts).toEqual([{ text: 'Listen [audio attached]' }]);
        expect(out[4].parts).toEqual([{ text: '[file attached]' }, { text: 'Read this' }]);
    });

    it('does not mutate the input rows', () => {
        const history = [
            { role: 'user', parts: [{ text: 'Hi' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] },
            call('a', 'a'),
            response('a'),
        ];
        const snapshot = JSON.parse(JSON.stringify(history));
        normalize(history);
        expect(history).toEqual(snapshot);
    });
});

describe('SmartContextManager summarization', () => {
    let db;
    let client;
    let manager;

    const textMsg = (id, role, text) => ({ id, role, parts: [{ text }], metadata: {}, timestamp: '2026-01-01T00:00:00.000Z' });
    const buildHistory = (n) => Array.from({ length: n }, (_, i) => textMsg(`m${i}`, i % 2 === 0 ? 'user' : 'model', `line ${i}`));

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        db = {
            getHistoryForChat: jest.fn().mockReturnValue([]),
            getLatestSummary: jest.fn().mockReturnValue(null),
            saveSummary: jest.fn(),
            countMessagesAfter: jest.fn().mockReturnValue(null),
            logTokenUsage: jest.fn(),
        };
        client = {
            models: {
                generateContent: jest.fn().mockResolvedValue({
                    candidates: [{ content: { parts: [{ text: 'A summary.' }] } }],
                    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
                })
            }
        };
        manager = new SmartContextManager(db, client);
        manager.config = { logUsageFromResponse: jest.fn(), getModel: () => 'flash', getThinkingConfig: () => null };
        manager.TOKEN_THRESHOLD = 1; // Any history is "too big".
    });

    afterEach(() => jest.restoreAllMocks());

    it('renders text parts and tool markers, never "undefined"', () => {
        const render = SmartContextManager.renderMessageText;
        expect(render({ parts: [{ text: 'It is ' }, { text: '20 degrees.' }] })).toBe('It is 20 degrees.');
        expect(render({ parts: [{ text: 'Checking' }, { functionCall: { name: 'getWeather', args: {} } }] })).toBe('Checking [tool: getWeather]');
        expect(render({ parts: [{ functionCall: { name: 'getWeather', args: {} } }] })).toBe('[tool: getWeather]');
        expect(render({ parts: [{ functionResponse: { name: 'getWeather', response: {} } }] })).toBe('[tool result: getWeather]');
        expect(render({ parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }] })).toBe('');
        expect(render({})).toBe('');
    });

    it('feeds the model text parts and tool markers only', async () => {
        const history = buildHistory(30);
        history[3] = { id: 'm3', role: 'model', parts: [{ functionCall: { name: 'getWeather', args: { city: 'X' } } }], metadata: {} };
        history[4] = { id: 'm4', role: 'user', parts: [{ functionResponse: { name: 'getWeather', response: { temp: 20 } } }], metadata: {} };
        history[5] = { id: 'm5', role: 'model', parts: [{ text: 'It is ' }, { text: '20 degrees.' }], metadata: {} };

        await manager.performSummarization('chat-1', history);

        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
        const prompt = client.models.generateContent.mock.calls[0][0].contents[0].parts[0].text;
        expect(prompt).not.toContain('undefined');
        expect(prompt).toContain('[MODEL]: [tool: getWeather]');
        expect(prompt).toContain('[USER]: [tool result: getWeather]');
        expect(prompt).toContain('[MODEL]: It is 20 degrees.');
        expect(prompt).not.toContain('line 25'); // last 10 stay out of the summary

        // range_start / range_end hold the first and last summarized message ids.
        expect(db.saveSummary).toHaveBeenCalledWith('chat-1', 'A summary.', 'm0', 'm19', 100, 10);
    });

    it('ignores base64 media when estimating tokens', async () => {
        manager.TOKEN_THRESHOLD = 50000;
        const history = buildHistory(30);
        // One photo: ~1 MB of base64 in a raw row. It counted as 250k tokens before.
        history[2] = {
            id: 'm2', role: 'user', metadata: {}, timestamp: '2026-01-01T00:00:00.000Z',
            parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/jpeg', data: 'A'.repeat(1024 * 1024) } }]
        };
        db.getHistoryForChat.mockReturnValue(history);

        expect(SmartContextManager.estimateTokens(history)).toBeLessThan(1000);
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).not.toHaveBeenCalled();
    });

    it('reads the summary window through getHistoryForSummary when the db offers it', async () => {
        db.getHistoryForSummary = jest.fn().mockReturnValue(buildHistory(40));
        await manager.checkAndSummarize('chat-1');
        expect(db.getHistoryForSummary).toHaveBeenCalledWith('chat-1', 100);
        expect(db.getHistoryForChat).not.toHaveBeenCalled();
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('summarizes when no summary exists yet', async () => {
        db.getHistoryForChat.mockReturnValue(buildHistory(40));
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('waits for 20 new messages after the last summary', async () => {
        const history = buildHistory(40);
        db.getHistoryForChat.mockReturnValue(history);

        // Last summary ended at m25: only 14 messages follow.
        db.getLatestSummary.mockReturnValue({ id: 1, chat_id: 'chat-1', content: 'old', range_end: 'm25' });
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).not.toHaveBeenCalled();

        // Ended at m19: 20 messages follow.
        db.getLatestSummary.mockReturnValue({ id: 1, chat_id: 'chat-1', content: 'old', range_end: 'm19' });
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('asks the db when the last summarized message left the window', async () => {
        db.getHistoryForChat.mockReturnValue(buildHistory(40));
        db.getLatestSummary.mockReturnValue({ id: 1, chat_id: 'chat-1', content: 'old', range_end: 'gone' });

        db.countMessagesAfter.mockReturnValue(5);
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).not.toHaveBeenCalled();

        db.countMessagesAfter.mockReturnValue(20);
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('allows one run when an old summary stored a timestamp instead of an id', async () => {
        db.getHistoryForChat.mockReturnValue(buildHistory(40));
        db.getLatestSummary.mockReturnValue({ id: 1, chat_id: 'chat-1', content: 'old', range_end: '2025-01-01T00:00:00.000Z' });
        db.countMessagesAfter.mockReturnValue(null);
        await manager.checkAndSummarize('chat-1');
        expect(client.models.generateContent).toHaveBeenCalledTimes(1);
    });

    it('normalizes the window before the summary pair goes in front', async () => {
        db.getLatestSummary.mockReturnValue({ id: 1, chat_id: 'chat-1', content: 'older stuff', range_end: 'm0' });
        db.getHistoryForChat.mockReturnValue([
            { id: 'f0', role: 'user', parts: [{ functionResponse: { name: 't', response: {} } }], metadata: {}, timestamp: '2026-03-04T10:00:00.000Z' },
            { id: 'a0', role: 'model', parts: [{ text: 'done' }], metadata: {}, timestamp: '2026-03-04T10:00:01.000Z' },
            { id: 'u1', role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }], metadata: {}, timestamp: '2026-03-04T10:00:02.000Z' },
            { id: 'm1', role: 'model', parts: [{ functionCall: { name: 't', args: {} } }], metadata: {}, timestamp: '2026-03-04T10:00:03.000Z' },
        ]);
        const ctx = await manager.getContext('chat-1', 'FLASH');
        expect(ctx.map(m => m.role)).toEqual(['user', 'model', 'user']);
        expect(ctx[0].parts[0].text).toContain('[SYSTEM: Context Summary');
        expect(ctx[2].parts[0].text).toMatch(/^\[\d\d\/\d\d \d\d:\d\d\] hi \[image attached\]$/);
        expect(JSON.stringify(ctx)).not.toContain('inlineData');
        expect(JSON.stringify(ctx)).not.toContain('functionResponse');
        expect(JSON.stringify(ctx)).not.toContain('functionCall');
    });

    it('prefixes timestamps and drops the row id from model history', async () => {
        db.getHistoryForChat.mockReturnValue([
            { id: 'u1', role: 'user', parts: [{ text: 'hi' }], metadata: {}, timestamp: '2026-03-04T10:00:00.000Z' },
            { id: 'm1', role: 'model', parts: [{ functionCall: { name: 't', args: {} } }], metadata: {}, timestamp: '2026-03-04T10:00:01.000Z' },
            { id: 'f1', role: 'user', parts: [{ functionResponse: { name: 't', response: {} } }], metadata: {}, timestamp: '2026-03-04T10:00:01.000Z' },
        ]);
        const ctx = await manager.getContext('chat-1', 'FLASH');
        expect(ctx).toHaveLength(3);
        expect(ctx[0].parts[0].text).toMatch(/^\[\d\d\/\d\d \d\d:\d\d\] hi$/);
        expect(ctx[1].parts[0].functionCall.name).toBe('t');
        expect(ctx[2].parts[0].functionResponse.name).toBe('t');
        for (const m of ctx) {
            expect(m.id).toBeUndefined();
            expect(m.timestamp).toBeDefined();
        }
    });
});
