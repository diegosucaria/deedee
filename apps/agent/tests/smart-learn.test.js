
const { PeopleService } = require('../src/services/people-service');
const axios = require('axios');

jest.mock('axios');

describe('PeopleService Smart Learn', () => {
    let service;
    let mockAgent;
    let mockDb;

    beforeEach(() => {
        jest.clearAllMocks();

        mockDb = {
            listPeople: jest.fn()
        };

        mockAgent = {
            db: mockDb,
            client: {
                models: {
                    generateContent: jest.fn()
                }
            }
        };

        service = new PeopleService(mockAgent);
        service.interfacesUrl = 'http://mock';
    });

    test('should pre-filter candidates ensuring NO duplicates are sent to LLM', async () => {
        // 1. Setup DB: One contact exists with phone, one with identifier
        // IMPORTANT: listPeople returns parsed identifiers (Objects), NOT strings.
        mockDb.listPeople.mockReturnValue([
            { phone: '1111111111', identifiers: {} },
            { phone: null, identifiers: { whatsapp: '2222222222' } }
        ]);

        // 2. Setup Recent Chats (Recent returns 3, 2 are known)
        axios.get.mockImplementation((url) => {
            if (url.includes('recent')) {
                return Promise.resolve({
                    data: [
                        { jid: '1111111111@s.whatsapp.net' }, // Skip (Phone match)
                        { jid: '2222222222@s.whatsapp.net' }, // Skip (Identifier match)
                        { jid: '3333333333@s.whatsapp.net' }  // Keep
                    ]
                });
            }
            if (url.includes('history')) {
                // Return just enough messages to pass the 'messages.length < 5' check
                return Promise.resolve({
                    data: Array(6).fill({ role: 'user', content: 'hello' })
                });
            }
            return Promise.resolve({ data: [] });
        });

        // 3. Mock LLM - Should receive only ONE candidate
        mockAgent.client.models.generateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ text: '[]' }] } }]
        });

        await service.suggestPeopleFromHistory();

        // 4. Verify LLM Call
        expect(mockAgent.client.models.generateContent).toHaveBeenCalledTimes(1);
        const prompt = mockAgent.client.models.generateContent.mock.calls[0][0].contents;

        expect(prompt).toContain('3333333333');
        expect(prompt).not.toContain('1111111111');
        expect(prompt).not.toContain('2222222222');
    });

    test('should extract real name and identifiers from LLM response', async () => {
        // Setup: No existing contacts
        mockDb.listPeople.mockReturnValue([]);

        // Mock Recent: 1 new person
        axios.get.mockImplementation((url) => {
            if (url.includes('recent')) return Promise.resolve({ data: [{ jid: '99999@s.whatsapp.net' }] });
            if (url.includes('history')) return Promise.resolve({ data: Array(6).fill({ role: 'user', content: 'hi' }) });
            return Promise.resolve({ data: [] });
        });

        // Mock LLM Response
        const mockAnalysis = [
            {
                phone: "99999",
                suggestedName: "Real Name",
                relationship: "Friend",
                identifiers: { email: "real@test.com" },
                reason: "Context",
                confidence: 1.0
            }
        ];

        mockAgent.client.models.generateContent.mockResolvedValue({
            candidates: [{ content: { parts: [{ text: JSON.stringify(mockAnalysis) }] } }]
        });

        const results = await service.suggestPeopleFromHistory();

        expect(results).toHaveLength(1);
        const res = results[0];
        expect(res.phone).toBe('99999');
        expect(res.suggestedName).toBe('Real Name');
        // Check identifiers merging
        expect(res.identifiers).toBeDefined();
        expect(res.identifiers.whatsapp).toBe('99999');
        expect(res.identifiers.email).toBe('real@test.com');
    });
});
