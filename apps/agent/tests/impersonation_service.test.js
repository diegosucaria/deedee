const { ImpersonationService } = require('../src/services/impersonation');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Mock Axios
jest.mock('axios');

describe('ImpersonationService', () => {
    let service;
    let db;
    let agentMock;
    let dbPath = path.join(__dirname, 'test_impersonation_service.db');

    beforeEach(() => {
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });

        db = new AgentDB(dbPath);
        db.init();

        agentMock = {
            db: db,
            client: {
                models: {
                    generateContent: jest.fn().mockResolvedValue({
                        response: {
                            candidates: [{ content: { parts: [{ text: "Mock Style Profile" }] } }]
                        }
                    })
                }
            }
        };

        service = new ImpersonationService(agentMock);
    });

    afterEach(() => {
        db.close();
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        jest.clearAllMocks();
    });

    test('should save and get global style profile', () => {
        const profile = "Be casual and use slang.";
        service.saveStyleProfile(profile);

        const retrieved = service.getStyleProfile();
        expect(retrieved).toBe(profile);
    });

    test('should save and get contact style profile', () => {
        const contactId = '1234567890';
        const profile = "Be formal.";

        // Create dummy person
        db.db.prepare("INSERT INTO people (id, name, phone) VALUES (?, ?, ?)").run(contactId, 'Test Person', '1234567890');

        service.saveContactStyle(contactId, profile);
        const retrieved = service.getContactStyle(contactId);

        expect(retrieved).toBe(profile);
    });

    test('analyzeContactStyle should resolve person ID to JID/Phone', async () => {
        // Setup person in DB using a long string to mimic UUID for our "length > 20" logic
        const uuid = 'user-uuid-12345678901234567890123456';
        const phone = '1234567890';
        db.db.prepare("INSERT INTO people (id, name, phone) VALUES (?, ?, ?)").run(uuid, 'Test Person', phone);

        // Mock Axios response
        axios.get.mockResolvedValue({
            data: [
                { role: 'assistant', content: 'Hi there' },
                { role: 'assistant', content: 'How are you?' },
                { role: 'assistant', content: 'Long time no see' },
                { role: 'assistant', content: 'Lets hang out' },
                { role: 'assistant', content: 'See ya' }
            ]
        });

        // Call analysis with UUID
        await service.analyzeContactStyle(uuid);

        // Expect axios to be called with resolved JID/Phone
        // Logic appends @s.whatsapp.net if digits only
        const expectedJid = `${phone}@s.whatsapp.net`;
        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining(`jid=${encodeURIComponent(expectedJid)}`),
            expect.any(Object)
        );

        // Verify style was saved
        const style = service.getContactStyle(uuid);
        expect(style).toBe("Mock Style Profile");
    });

    test('generateDraft should verify global and contact styles in prompt', async () => {
        const chatId = '1234567890@s.whatsapp.net';
        const contactId = 'contact-12345678901234567890123456';

        // Setup Data
        service.saveStyleProfile("Global Style");

        // Setup Person for contact style
        const phone = '1234567890';
        db.db.prepare("INSERT INTO people (id, name, phone) VALUES (?, ?, ?)").run(contactId, 'Test Contact', phone);
        service.saveContactStyle(phone, "Contact Style");

        // Insert some history
        db.db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, 'user', 'Past message')").run(chatId);

        await service.generateDraft(chatId, { content: "Hello" }, "Test Contact");

        const callArgs = agentMock.client.models.generateContent.mock.calls[0][0];
        const prompt = callArgs.contents[0].parts[0].text;

        expect(prompt).toContain('### GLOBAL STYLE GUIDE (Baseline):\nGlobal Style');
        // This confirms that getContactStyle successfully resolved the contact from the chatId
        expect(prompt).toContain('### CONTACT-SPECIFIC STYLE (Override/Nuance for this person):\nContact Style');
    });
});
