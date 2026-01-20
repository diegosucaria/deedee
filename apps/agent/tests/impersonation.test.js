const { Agent } = require('../src/agent');
const { ImpersonationService } = require('../src/services/impersonation');

describe('Impersonation Service Unit', () => {
    let service;
    let mockAgent;
    let mockDb;

    beforeEach(() => {
        mockDb = {
            getPerson: jest.fn(),
            db: {
                prepare: jest.fn().mockImplementation((query) => ({
                    run: jest.fn(),
                    all: jest.fn().mockReturnValue([]),
                    get: jest.fn().mockReturnValue(null)
                }))
            },
            updatePerson: jest.fn()
        };
        mockAgent = {
            client: {
                models: { generateContent: jest.fn() }
            },
            db: mockDb,
            interface: { broadcast: jest.fn() }
        };
        service = new ImpersonationService(mockAgent);
    });

    test('should transcribe audio using candidates fallback', async () => {
        const mockResponse = {
            candidates: [{ content: { parts: [{ text: 'Tra nscript' }] } }]
        };
        // Simulate SDK returning object without .response wrapper sometimes, or with it
        // The code handles result.response and result.candidates
        mockAgent.client.models.generateContent.mockResolvedValue({
            response: mockResponse
        });

        const text = await service.transcribeAudio({});
        expect(text).toBe('Tra nscript');
    });

    test('should resolve sender name from DB', async () => {
        const phone = '1234567890';
        mockDb.getPerson.mockReturnValue({ name: 'Papi', id: 'uuid' });

        // Mock generation
        mockAgent.client.models.generateContent.mockResolvedValue({
            response: { candidates: [{ content: { parts: [{ text: 'Draft reply' }] } }] }
        });

        // Setup buffer
        service.messageBuffers.set(phone, {
            content: ['Hello'],
            metadata: {},
            source: 'whatsapp'
        });

        await service.processBufferedMessage(phone, phone);

        // Verify generateDraft was called with Resolved Name
        expect(mockAgent.client.models.generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                contents: expect.arrayContaining([
                    expect.objectContaining({
                        parts: expect.arrayContaining([
                            expect.objectContaining({
                                text: expect.stringContaining('### Incoming Message(s) from Papi:')
                            })
                        ])
                    })
                ])
            })
        );
    });

    test('should resolve LID to Phone JID for history fetch', async () => {
        const lidChatId = '1234567890@lid';
        const contactIdentifier = '5491122334455';
        const expectedHistoryJid = '5491122334455@s.whatsapp.net';

        // Mock Remote History
        axios.get.mockResolvedValue({ data: [] });

        mockAgent.client.models.generateContent.mockResolvedValue({
            response: { candidates: [{ content: { parts: [{ text: 'Draft' }] } }] }
        });

        await service.generateDraft(lidChatId, { content: 'Hi' }, 'User', '', contactIdentifier);

        // Verify Axios Call uses resolved JID
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/whatsapp/history'), expect.objectContaining({
            params: expect.objectContaining({ jid: expectedHistoryJid })
        }));
    });

    test('should fetch history from remote for WhatsApp JID', async () => {
        const chatId = '1234567890@s.whatsapp.net';
        mockDb.getPerson.mockReturnValue({ name: 'Papi', id: 'uuid' });

        // Mock Remote History
        const remoteHistory = [
            { role: 'assistant', content: 'Msg 1', timestamp: 100 },
            { role: 'user', content: 'Msg 2', timestamp: 200 }
        ];
        // API returns [Newest, Oldest] usually? 
        // Logic says `history = res.data.reverse()`.
        // So if API returns [Msg 2, Msg 1], reverse makes it [Msg 1, Msg 2] (Chronological).
        axios.get.mockResolvedValue({ data: [remoteHistory[1], remoteHistory[0]] });

        // Mock Generative Model
        mockAgent.client.models.generateContent.mockResolvedValue({
            response: { candidates: [{ content: { parts: [{ text: 'Draft' }] } }] }
        });

        await service.generateDraft(chatId, { content: 'Hello' }, 'Papi');

        // Verify Axios Call
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/whatsapp/history'), expect.objectContaining({
            params: expect.objectContaining({ jid: chatId })
        }));

        // Verify fallback DB was NOT called for history (or history was populated)
        // Strictly speaking, if history is populated, fallback is skipped.
        // We can verify the prompt contains the content
        expect(mockAgent.client.models.generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                contents: expect.arrayContaining([
                    expect.objectContaining({
                        parts: expect.arrayContaining([
                            expect.objectContaining({ text: expect.stringContaining('Msg 1') }),
                            expect.objectContaining({ text: expect.stringContaining('Msg 2') })
                        ])
                    })
                ])
            })
        );
    });

    test('should generate draft with full conversation context', async () => {
        const chatId = '1234567890';
        mockDb.getPerson.mockReturnValue({ name: 'Papi', id: 'uuid' });

        // Mock History: 
        // 1. Assistant (Me)
        // 2. User (Papi)
        const mockHistory = [
            { role: 'assistant', content: 'Sup?' },
            { role: 'user', content: 'Not much' }
        ];

        // Mock DB prepare().all().reverse() logic
        // We need to support the .all() call and subsequent .reverse()
        const mockAll = jest.fn().mockReturnValue([...mockHistory]); // Return array that has .reverse
        mockDb.db.prepare.mockReturnValue({
            all: mockAll,
            run: jest.fn(),
            get: jest.fn()
        });

        // Mock generation
        mockAgent.client.models.generateContent.mockResolvedValue({
            response: { candidates: [{ content: { parts: [{ text: 'Cool' }] } }] }
        });

        await service.generateDraft(chatId, { content: 'Wanna hang?' }, 'Papi');

        // Verify Prompt
        expect(mockAgent.client.models.generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                contents: expect.arrayContaining([
                    expect.objectContaining({
                        parts: expect.arrayContaining([
                            expect.objectContaining({
                                text: expect.stringContaining('### Conversation History (Context):')
                            }),
                            // Since we mock getOwnerName() to return 'Diego' (default/mocked?)
                            // We need to check if 'Diego: Sup?' is in there.
                            // BUT wait, getOwnerName calls `this.agent.settings.owner_name` or 'Diego'.
                            // In test setup, `agent.settings` is undefined on mockAgent.
                            // Service.getOwnerName() handles this safely? 
                            // Let's verify service code on getOwnerName if needed, but safe to assume "Diego".
                            expect.objectContaining({
                                text: expect.stringContaining('Diego: Sup?')
                            }),
                            expect.objectContaining({
                                text: expect.stringContaining('Papi: Not much')
                            })
                        ])
                    })
                ])
            })
        );
    });
});

const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

// Mock Config
const config = {
    googleApiKey: 'test_key',
    interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn() }
};

// Mock Dependencies
jest.mock('axios');
const axios = require('axios');

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        close: jest.fn()
    }))
}));

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
            generateContent: jest.fn().mockResolvedValue({
                response: { text: () => "Mock Response" }
            })
        }
    }))
}), { virtual: true }); // virtual if module not found in test env

describe('Impersonation & Tone Matching', () => {
    let agent;
    let dbPath = path.join(__dirname, 'test_impersonation.db');

    beforeEach(() => {
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ ...config });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        agent.client = {
            models: { generateContent: jest.fn() },
            chats: {
                create: jest.fn().mockReturnValue({
                    sendMessage: jest.fn().mockResolvedValue({
                        response: {
                            candidates: [{ content: { parts: [{ text: "I'm pretending to be Diego." }] } }]
                        }
                    }),
                    sendMessageStream: jest.fn().mockResolvedValue({
                        stream: (async function* () {
                            yield { text: () => "I'm pretending to be Diego." };
                        })(),
                        response: Promise.resolve({
                            candidates: [{ content: { parts: [{ text: "I'm pretending to be Diego." }] } }]
                        })
                    })
                })
            }
        };
    });

    afterEach(() => {
        agent.db.close();
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
    });

    // Strategy: We want to spy on `getSystemInstruction` OR verify that the prompt passed to `generateContent` 
    // contains the "IMPERSONATION MODE" string.
    // Since `getSystemInstruction` is imported, mocking it is one way, but testing the side effect on the client call is better integration testing.

    test('should inject Impersonation Mode instruction for ANY message', async () => {
        const message = {
            content: 'Draft a reply to Mom',
            role: 'user',
            source: 'web',
            metadata: { chatId: 'web-session', replyMode: 'text' }
        };



        // Mock Router to return FLASH model (skipping router actual call)
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH', toolMode: 'NONE' });

        // Mock SmartContext
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);

        await agent.processMessage(message, jest.fn());

        // Check if chats.create was called
        expect(agent.client.chats.create).toHaveBeenCalled();
        const callArgs = agent.client.chats.create.mock.calls[0][0];
        const systemPrompt = callArgs.config.systemInstruction;

        // Verify the injected string exists
        expect(systemPrompt).toContain('=== IMPERSONATION & TONE MATCHING ===');
        expect(systemPrompt).toContain('IF you are asked to draft a message for the user');
    });


});
