
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
});
