// Pure helpers behind the /live page: endpoint choice and the setup message.
const {
    isEphemeralToken,
    liveWebSocketUrl,
    cleanSchema,
    buildLiveSetup,
    realtimeAudioMessage,
    messageSizeBytes
} = require('../src/app/live/live-session.js');

describe('liveWebSocketUrl', () => {
    test('ephemeral tokens open the constrained v1beta method with access_token', () => {
        const url = liveWebSocketUrl('auth_tokens/abc123');
        expect(url).toBe('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/abc123');
        expect(isEphemeralToken('auth_tokens/abc123')).toBe(true);
    });

    test('anything else keeps the old v1alpha endpoint', () => {
        expect(liveWebSocketUrl('ya29-like-oauth')).toBe('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=ya29-like-oauth');
        expect(isEphemeralToken(undefined)).toBe(false);
        expect(isEphemeralToken('AUTH_TOKENS/x')).toBe(false);
    });
});

describe('buildLiveSetup', () => {
    const tools = [
        {
            name: 'getTime',
            description: 'Current time',
            parameters: {
                type: 'object',
                $schema: 'http://json-schema.org/draft-07/schema#',
                additionalProperties: false,
                properties: {
                    zone: { type: 'string', description: 'IANA zone', enum: ['UTC'], default: 'UTC' },
                    tags: { type: 'array', items: { type: 'string', minLength: 1 } }
                },
                required: ['zone']
            }
        },
        { name: '', description: 'nameless, dropped' }
    ];

    test('uses the SDK wire shape: camelCase, modalities and voice under generationConfig', () => {
        const msg = buildLiveSetup({ model: 'models/gemini-3.8-live', voice: 'Puck', systemInstruction: 'Be brief.', tools });
        expect(msg.setup.model).toBe('models/gemini-3.8-live');
        expect(msg.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
        expect(msg.setup.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } });
        expect(msg.setup.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
        expect(msg.setup.tools[0]).toEqual({ googleSearch: {} });
        expect(msg.setup.tools[1].functionDeclarations).toEqual([
            {
                name: 'getTime',
                description: 'Current time',
                parameters: {
                    type: 'object',
                    properties: {
                        zone: { type: 'string', description: 'IANA zone', enum: ['UTC'] },
                        tags: { type: 'array', items: { type: 'string' } }
                    },
                    required: ['zone']
                }
            }
        ]);
        const json = JSON.stringify(msg);
        for (const legacy of ['generation_config', 'response_modalities', 'speech_config', 'system_instruction', 'google_search', 'function_declarations']) {
            expect(json).not.toContain(legacy);
        }
        expect(messageSizeBytes(msg)).toBe(Buffer.byteLength(json));
    });

    test('leaves out the system instruction and the declarations when there are none', () => {
        const msg = buildLiveSetup({ model: 'models/x', voice: 'Kore' });
        expect(msg.setup.systemInstruction).toBeUndefined();
        expect(msg.setup.tools).toEqual([{ googleSearch: {} }]);
    });
});

describe('cleanSchema and realtimeAudioMessage', () => {
    test('cleanSchema strips unknown keys recursively', () => {
        const clean = cleanSchema({ type: 'object', additionalProperties: true, properties: { a: { type: 'number', minimum: 1 } } });
        expect(clean).toEqual({ type: 'object', properties: { a: { type: 'number' } } });
        expect(cleanSchema(undefined)).toBeUndefined();
    });

    test('audio chunks use the audio field, not the deprecated mediaChunks', () => {
        expect(realtimeAudioMessage('QUJD', 48000)).toEqual({
            realtimeInput: { audio: { mimeType: 'audio/pcm;rate=48000', data: 'QUJD' } }
        });
    });
});
