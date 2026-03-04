const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

describe('Media Eager Extraction', () => {
    let agent;
    let db;
    let testDbPath = path.join(__dirname, 'test-media.db');

    beforeAll(async () => {
        process.env.GOOGLE_API_KEY = 'test_key';
        try {
            if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        } catch (e) { }
        db = new AgentDB(testDbPath);

        agent = new Agent({
            interface: {
                on: jest.fn(),
                send: jest.fn(),
                emit: jest.fn()
            },
            db: db,
            googleApiKey: 'test_key'
        });

        // Mock genAI behavior
        agent._loadClientLibrary = jest.fn().mockResolvedValue({
            GoogleGenAI: class {
                constructor() {
                    this.models = {
                        generateContent: jest.fn().mockResolvedValue({
                            text: "Simulated extracted text"
                        })
                    }
                }
            }
        });

        await agent.start();
    });

    afterAll(async () => {
        if (agent) await agent.stop();
        if (db) db.close();
        try {
            if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        } catch (e) { }
    });

    test('Should extract media semantics eagerly in passive 1:1 mode', async () => {
        agent.settings = { save_passive_messages: true };
        const chatId = require('crypto').randomUUID() + '@s.whatsapp.net';
        const message = {
            role: 'user',
            source: 'whatsapp:user', // Passive Mode
            content: '',
            metadata: { chatId }, // 1:1 chat, no groupName
            parts: [{
                inlineData: {
                    mimeType: 'audio/ogg',
                    data: 'base64data'
                }
            }]
        };

        const summary = await agent.processMessage(message, jest.fn());

        // Check DB for saved message
        const msgs = db.getHistory({ chatId });
        expect(msgs.length).toBe(1);

        const savedMsg = msgs[0];
        // Content should have been enriched
        expect(savedMsg.content).toContain('[Voice Transcript] Simulated extracted text');

        // Parts should have been stripped
        const savedParts = JSON.parse(savedMsg.parts);
        expect(savedParts[0].inlineData.data).toBe('[MEDIA_STRIPPED_PASSIVE]');
    });

    test('Should strip without extracting in group passive mode', async () => {
        agent.settings = { save_passive_messages: true };
        const chatId = require('crypto').randomUUID() + '@g.us';
        const message = {
            role: 'user',
            source: 'whatsapp:user', // Passive Mode
            content: '',
            metadata: {
                chatId,
                groupName: 'Test Group'
            },
            parts: [{
                inlineData: {
                    mimeType: 'audio/ogg',
                    data: 'base64data'
                }
            }]
        };

        await agent.processMessage(message, jest.fn());

        // Check DB for saved message
        const msgs = db.getHistory({ chatId });
        expect(msgs.length).toBe(1);

        const savedMsg = msgs[0];
        // Content should NOT have been enriched
        expect(savedMsg.content).not.toContain('[Voice Transcript]');

        // Parts should have been stripped still
        const savedParts = JSON.parse(savedMsg.parts);
        expect(savedParts[0].inlineData.data).toBe('[MEDIA_STRIPPED_PASSIVE]');
    });
});
