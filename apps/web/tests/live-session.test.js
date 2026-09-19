// Pure helpers behind the /live page: endpoint choice and the setup message.
const {
    isEphemeralToken,
    liveWebSocketUrl,
    cleanSchema,
    buildLiveSetup,
    realtimeAudioMessage,
    messageSizeBytes,
    sessionCountdown,
    closeOutcome
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

describe('sessionCountdown', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');

    test('counts down and warns in the last five minutes', () => {
        expect(sessionCountdown('2026-09-16T12:29:30Z', now)).toMatchObject({
            known: true, expired: false, warn: false, label: '29:30'
        });
        expect(sessionCountdown('2026-09-16T12:04:05Z', now)).toMatchObject({
            known: true, expired: false, warn: true, label: '4:05'
        });
    });

    test('a past cut-off is expired, not negative', () => {
        const done = sessionCountdown('2026-09-16T11:59:00Z', now);
        expect(done).toMatchObject({ known: true, expired: true, warn: false, label: '0:00' });
        expect(done.remainingMs).toBe(0);
    });

    test('without a cut-off the page shows no clock', () => {
        expect(sessionCountdown(null, now).known).toBe(false);
        expect(sessionCountdown('not a date', now).known).toBe(false);
    });
});

describe('closeOutcome', () => {
    test('a socket that opened and then closed ended the session', () => {
        expect(closeOutcome({ code: 1000, reason: '' }, true)).toEqual({
            status: 'ended',
            message: 'Session ended (1000).'
        });
    });

    test('a refused handshake stays an error and keeps the close code', () => {
        expect(closeOutcome({ code: 1008, reason: 'Request contains an invalid argument.' }, false)).toEqual({
            status: 'error',
            message: 'Could not start the session (1008).'
        });
    });

    test('a close without a code still reads as plain words', () => {
        expect(closeOutcome({}, false).message).toBe('Could not start the session.');
        expect(closeOutcome(undefined, true).message).toBe('Session ended.');
    });
});

describe('messageShowsWebReading', () => {
    // The call's setup turns on Google's built-in search. Its results reach
    // the model without passing through our tool route, so only the page can
    // tell the agent that the call has read the web.
    const { messageShowsWebReading } = require('../src/app/live/live-session.js');

    test('a grounded turn is seen, in the shape the Live API sends', () => {
        expect(messageShowsWebReading({ serverContent: { modelTurn: { parts: [{ text: 'x' }] }, groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [{ web: { uri: 'https://example.com' } }] } } })).toBe(true);
        expect(messageShowsWebReading({ serverContent: { turnComplete: true, groundingMetadata: {} } })).toBe(true);
    });

    test('a renamed or nested field is still seen', () => {
        expect(messageShowsWebReading({ serverContent: { modelTurn: { parts: [{ grounding_metadata: {} }] } } })).toBe(true);
        expect(messageShowsWebReading({ serverContent: { searchEntryPoint: { renderedContent: '<div/>' } } })).toBe(true);
    });

    test('ordinary turns, audio and tool calls are not web reading', () => {
        expect(messageShowsWebReading({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] } } })).toBe(false);
        expect(messageShowsWebReading({ toolCall: { functionCalls: [{ name: 'getFact', args: { key: 'grounding' } }] } })).toBe(false);
        expect(messageShowsWebReading({ setupComplete: {} })).toBe(false);
        expect(messageShowsWebReading(null)).toBe(false);
    });
});
