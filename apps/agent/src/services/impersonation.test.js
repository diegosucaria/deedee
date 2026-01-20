const { ImpersonationService } = require('./impersonation');
const { AgentDB } = require('../db');
const Database = require('better-sqlite3');



// Mock Agent
const mockAgent = {
    db: {
        db: null, // Set in beforeEach
        getPerson: jest.fn().mockReturnValue(null), // Mock for getContactStyle
        updatePerson: jest.fn(), // Mock for saveContactStyle
    },
    client: {
        models: {
            generateContent: jest.fn().mockResolvedValue({
                response: { candidates: [{ content: { parts: [{ text: "Drafted Reply" }] } }] }
            })
        }
    }
};

describe('ImpersonationService', () => {
    let service;
    let db;

    beforeEach(() => {
        db = new Database(':memory:');
        mockAgent.db.db = db;

        // Setup Schema
        db.exec(`
            CREATE TABLE messages (id TEXT, chat_id TEXT, role TEXT, content TEXT, timestamp DATETIME);
            CREATE TABLE people (id TEXT, phone TEXT, autopilot_status TEXT, autopilot_expires_at DATETIME);
            CREATE TABLE autopilot_drafts (id INTEGER PRIMARY KEY, chat_id TEXT, contact_id TEXT, content TEXT, status TEXT);
            CREATE TABLE agent_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, category TEXT, updated_at DATETIME);
        `);

        service = new ImpersonationService(mockAgent);
    });

    afterEach(() => {
        if (db && db.open) {
            db.close();
        }
    });

    test('getAutopilotStatus returns correct status', () => {
        db.prepare("INSERT INTO people (id, phone, autopilot_status) VALUES (?, ?, ?)").run('123', '555-0100', 'assisted');

        expect(service.getAutopilotStatus('123')).toBe('assisted');
        expect(service.getAutopilotStatus('555-0100')).toBe('assisted');
        expect(service.getAutopilotStatus('999')).toBe('off');
    });

    test('saveDraft inserts into database', () => {
        service.saveDraft('chat1', 'contact1', 'Hello world');
        const draft = db.prepare('SELECT * FROM autopilot_drafts').get();
        expect(draft).toBeDefined();
        expect(draft.content).toBe('Hello world');
        expect(draft.status).toBe('pending');
    });

    test('generateDraft fetches history and calls LLM', async () => {
        // Seed history
        db.prepare("INSERT INTO messages (id, chat_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run('1', 'chat1', 'user', 'Past message 1', '2023-01-01');

        const draft = await service.generateDraft('chat1', { content: 'Hi' }, 'Mom');

        expect(draft).toBe('Drafted Reply');
        expect(mockAgent.client.models.generateContent).toHaveBeenCalled();
        const callArgs = mockAgent.client.models.generateContent.mock.calls[0][0];
        expect(callArgs.contents[0].parts[0].text).toContain('Past message 1');
    });
});
