
require('dotenv').config({ path: '.env' });
const { DreamService } = require('../src/services/dream-service');

async function run() {
    console.log('--- Dreaming Feature Verification ---');

    // Mocks
    const mockInterface = {
        send: async (payload) => {
            console.log(`[MockInterface] Sent payload:`, JSON.stringify(payload, null, 2));
            return true;
        }
    };

    const mockDb = {
        getAllFacts: () => [
            { key: 'fact1', value: 'User likes jazz' },
            { key: 'fact2', value: 'User lives in Buenos Aires' },
            { key: 'fact3', value: 'The sky is blue' }
        ],
        getAgentSetting: (key) => {
            if (key === 'owner_phone') return { value: '1234567890' };
            if (key === 'voice') return { value: 'Kore' };
            return null;
        }
    };

    const mockConfigService = {
        getModel: (type) => 'mock-model'
    };

    const mockClient = {
        models: {
            generateContent: async (req) => {
                const prompt = req.contents[0].parts[0].text;
                console.log('[MockLLM] Received Prompt:', prompt.substring(0, 50) + '...');

                // Check if it's TTS request
                if (req.config && req.config.responseModalities && req.config.responseModalities.includes('AUDIO')) {
                    console.log('[MockLLM] TTS Request received.');
                    return {
                        candidates: [{
                            content: {
                                parts: [{
                                    inlineData: {
                                        mimeType: 'audio/wav',
                                        data: Buffer.from('mock-audio-data').toString('base64')
                                    }
                                }]
                            }
                        }]
                    };
                }

                // Default Dream Request
                return {
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    type: 'text',
                                    content: 'I dreamt of electric sheep jumping over a jazz band in Buenos Aires.',
                                    reasoning: 'Combined facts.'
                                })
                            }]
                        }
                    }]
                };
            }
        }
    };

    const mockJournal = {
        getParsedJournal: async (date) => ({
            interactions: [
                { timestamp: '10:00', content: 'User asked about the weather.' },
                { timestamp: '20:00', content: 'User is coding.' }
            ]
        })
    };

    const mockMCP = {
        getTools: async () => [
            { name: 'user_get_watch_history', serverName: 'plex' },
            { name: 'user_get_on_deck', serverName: 'plex' }
        ],
        callTool: async (name, args) => {
            console.log(`[MockMCP] Called ${name} with args:`, args);
            if (name === 'user_get_watch_history') {
                return {
                    output: JSON.stringify({
                        items: [
                            { title: 'The Matrix', type: 'movie' },
                            { title: 'Inception', type: 'movie' }
                        ]
                    })
                };
            }
            if (name === 'user_get_on_deck') {
                return {
                    output: JSON.stringify({
                        items: [
                            { title: 'Breaking Bad', type: 'show' }
                        ]
                    })
                };
            }
            return { output: '' };
        }
    };

    const mockAgent = {
        db: mockDb,
        interface: mockInterface,
        configService: mockConfigService,
        client: mockClient,
        journal: mockJournal,
        mcp: mockMCP,
        settings: { owner_phone: '1234567890' }
    };

    // Test
    const service = new DreamService(mockAgent);

    console.log('\n--- Test 1: Forced Dream (Text) ---');
    await service.dream(true);

    console.log('\n--- Test 2: Audio Dream Request ---');
    // Modify mock to return audio instruction
    mockClient.models.generateContent = async (req) => {
        // Check if it's TTS request
        if (req.config && req.config.responseModalities && req.config.responseModalities.includes('AUDIO')) {
            console.log('[MockLLM] TTS Request received.');
            return {
                candidates: [{
                    content: {
                        parts: [{
                            inlineData: {
                                mimeType: 'audio/wav',
                                data: Buffer.from('mock-audio-data').toString('base64')
                            }
                        }]
                    }
                }]
            };
        }

        return {
            candidates: [{
                content: {
                    parts: [{
                        text: JSON.stringify({
                            type: 'audio',
                            content: 'This is an audio dream about the cosmos.',
                            reasoning: 'Philosophy.'
                        })
                    }]
                }
            }]
        };
    };

    await service.dream(true);

    console.log('\n--- Done ---');
}

run().catch(console.error);
