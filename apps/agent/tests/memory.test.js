
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
                    candidates: [{ content: { parts: [{ text: 'Summary of the day.' }] } }]
                })
            }
        };

        executor = new ToolExecutor({
            local: {},
            journal,
            scheduler: {},
            gsuite: {},
            mcp: {},
            client,
            db // Inject mocked DB
        });
    });

    afterAll(() => {
        if (db) db.close();
        // Cleanup
        try {
            if (fs.existsSync('data/agent.db')) {
                fs.unlinkSync('data/agent.db');
            }
        } catch (e) { }
    });

    test('searchMemory should query DB', async () => {
        db.searchMessages = jest.fn().mockReturnValue([{ content: 'found it' }]);

        const result = await executor.execute('searchMemory', { query: 'test' }, {});

        expect(db.searchMessages).toHaveBeenCalledWith('test', 10);
        expect(result.results).toHaveLength(1);
    });

    test('consolidateMemory should summarize messages', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([
            { timestamp: '2023-01-01T10:00:00Z', role: 'user', content: 'Hi' },
            { timestamp: '2023-01-01T10:01:00Z', role: 'model', content: 'Hello' }
        ]);
        journal.log = jest.fn();

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(db.getMessagesByDate).toHaveBeenCalledWith('2023-01-01');
        expect(client.models.generateContent).toHaveBeenCalled();
        expect(journal.log).toHaveBeenCalledWith(expect.stringContaining('Summary of the day'));
        expect(result.success).toBe(true);
    });

    test('consolidateMemory should handle empty day', async () => {
        db.getMessagesByDate = jest.fn().mockReturnValue([]);

        const result = await executor.execute('consolidateMemory', { date: '2023-01-01' }, {});

        expect(result.info).toContain('No messages found');
        expect(client.models.generateContent).not.toHaveBeenCalled();
    });
});
