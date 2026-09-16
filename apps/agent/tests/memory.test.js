
const { AgentDB } = require('../src/db');
const { ToolExecutor } = require('../src/tool-executor');
const { JournalManager } = require('../src/journal');

// Mock dependencies
jest.mock('../src/db');
jest.mock('../src/journal');

describe('Memory Tools', () => {
    let db, journal, executor, client;

    beforeEach(() => {
        db = new AgentDB();
        journal = new JournalManager();
        client = {
            models: {
                generateContent: jest.fn().mockResolvedValue({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    summary: 'Summary of the day.',
                                    facts: [{ key: 'mock_key', value: 'mock_val', category: 'general' }]
                                })
                            }]
                        }
                    }]
                }),
                getAllAgentSettings: jest.fn().mockReturnValue({})
            }
        };

        executor = new ToolExecutor({
            local: {},
            journal,
            scheduler: {},
            gsuite: {},
            mcp: {},
            client,
            db,
            agent: {
                configService: {
                    getModel: jest.fn().mockReturnValue('gemini-mock')
                },
                ragService: {
                    ingestDocument: jest.fn().mockResolvedValue(true)
                }
            }
        });
    });

    afterAll(() => {
        if (db) db.close();
        try {
            if (fs.existsSync('data/agent.db')) {
                fs.unlinkSync('data/agent.db');
            }
        } catch (e) { }
    });

    test('searchMemory should query DB and RAG', async () => {
        db.searchMessages = jest.fn().mockReturnValue([{ content: 'found it' }]);

        const result = await executor.execute('searchMemory', { query: 'test' }, {});

        expect(db.searchMessages).toHaveBeenCalledWith('test', 10);
        expect(result.chat_history).toHaveLength(1);
        expect(result.knowledge).toBeDefined();
    });

    test('consolidateMemory should summarize messages', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' },
            { timestamp: '2023-01-01T10:01:00Z', role: 'model', content: 'Hello' }
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([{ key: 'mock', value: 'value' }]);
        db.getFact = jest.fn().mockReturnValue(null); // No existing fact (no contradiction)
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(db.getMessagesByDate).toHaveBeenCalledWith('2023-01-01');
        expect(client.models.generateContent).toHaveBeenCalled();
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('Summary of the day'));
        expect(result.success).toBe(true);
    });

    test('consolidateMemory should call setKey with metadata options', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' },
            { timestamp: '2023-01-01T10:01:00Z', role: 'model', content: 'Hello' }
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([]);
        db.getFact = jest.fn().mockReturnValue(null);
        db.setKey = jest.fn();
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');

        await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(db.setKey).toHaveBeenCalledWith('mock_key', 'mock_val', {
            category: 'general',
            confidence: 'consolidated',
            source: 'consolidation'
        });
    });

    test('consolidateMemory should detect contradictions and log to journal', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' },
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([]);
        db.getFact = jest.fn().mockReturnValue({ key: 'mock_key', value: 'old_val', pinned: 0 });
        db.setKey = jest.fn();
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');

        await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        // Should log the change to journal
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('Fact Updated'));
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('mock_key'));
        // Should still update the fact
        expect(db.setKey).toHaveBeenCalledWith('mock_key', 'mock_val', expect.any(Object));
    });

    test('consolidateMemory should block overwrite of pinned facts', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' },
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([]);
        db.getFact = jest.fn().mockReturnValue({ key: 'mock_key', value: 'old_val', pinned: 1 });
        db.setKey = jest.fn();
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');

        await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        // Should log the conflict
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('CONFLICT'));
        // Should NOT call setKey for the pinned fact
        expect(db.setKey).not.toHaveBeenCalled();
    });

    test('consolidateMemory should handle empty day', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([]);

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(result.info).toContain('No messages found');
        expect(client.models.generateContent).not.toHaveBeenCalled();
    });

    test('consolidateMemory asks for JSON through config, the key @google/genai reads', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' }
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([]);
        db.getFact = jest.fn().mockReturnValue(null);
        db.setKey = jest.fn();
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');

        await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        const call = client.models.generateContent.mock.calls[0][0];
        expect(call.model).toBe('gemini-mock');
        expect(call.config).toEqual({ responseMimeType: 'application/json' });
        expect(call).not.toHaveProperty('generationConfig');
    });

    test('consolidateMemory reads the SDK text getter and unwraps a fenced JSON block', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' }
        ]);
        db.getAllFacts = jest.fn().mockReturnValue([]);
        db.getFact = jest.fn().mockReturnValue(null);
        db.setKey = jest.fn();
        journal.log = jest.fn();
        journal.syncFactsToMemory = jest.fn().mockResolvedValue('path/to/memory.md');
        client.models.generateContent.mockResolvedValueOnce({
            text: '```json\n{"summary": "Fenced day.", "facts": [{"key": "fenced_key", "value": "v"}]}\n```',
            candidates: [{ content: { parts: [{ text: 'ignored when text is present' }] } }]
        });

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(result.success).toBe(true);
        expect(result.facts_learned).toBe(1);
        expect(db.setKey).toHaveBeenCalledWith('fenced_key', 'v', expect.any(Object));
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('Fenced day.'));
    });

    test('consolidateMemory returns an error when the reply holds no JSON', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' }
        ]);
        db.setKey = jest.fn();
        journal.log = jest.fn();
        client.models.generateContent.mockResolvedValueOnce({ candidates: [] });

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(result.error).toBe('Failed to generate valid summary JSON.');
        expect(db.setKey).not.toHaveBeenCalled();
    });
});

describe('parseJsonReply', () => {
    const { parseJsonReply, responseText } = require('../src/executors/memory');

    test('parses plain JSON', () => {
        expect(parseJsonReply('{"summary": "s", "facts": []}')).toEqual({ summary: 's', facts: [] });
    });

    test('parses JSON inside a fence, with or without a language tag', () => {
        expect(parseJsonReply('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
        expect(parseJsonReply('Here you go:\n```\n{"a": 2}\n```')).toEqual({ a: 2 });
    });

    test('parses the first brace block in prose', () => {
        expect(parseJsonReply('Sure. {"a": {"b": 3}} Done.')).toEqual({ a: { b: 3 } });
    });

    test('returns null for empty, non-string or non-JSON input', () => {
        expect(parseJsonReply('')).toBeNull();
        expect(parseJsonReply(undefined)).toBeNull();
        expect(parseJsonReply('no json here')).toBeNull();
        expect(parseJsonReply('42')).toBeNull();
    });

    test('responseText prefers the SDK text getter and falls back to candidate parts', () => {
        expect(responseText({ text: 'from getter', candidates: [{ content: { parts: [{ text: 'x' }] } }] })).toBe('from getter');
        expect(responseText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
        expect(responseText({ candidates: [] })).toBe('');
        expect(responseText(undefined)).toBe('');
    });
});
