// Pure helpers for the Live voice page. No React and no server imports, so
// they run in jest as well as in the browser.

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage';

export function isEphemeralToken(token) {
    return typeof token === 'string' && token.startsWith('auth_tokens/');
}

// Ephemeral tokens (auth_tokens/...) only open the constrained v1beta method.
// Anything else keeps the old endpoint.
export function liveWebSocketUrl(token) {
    if (isEphemeralToken(token)) {
        return `${WS_BASE}.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
    }
    return `${WS_BASE}.v1alpha.GenerativeService.BidiGenerateContent?access_token=${token}`;
}

// The Live API rejects JSON Schema keys it does not know (additionalProperties,
// $schema, $ref, ...). Keep the handful it accepts, recursively.
export function cleanSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const { type, description, properties, required, items, enum: enumValues } = schema;

    const clean = {};
    if (type) clean.type = type;
    if (description) clean.description = description;
    if (enumValues) clean.enum = enumValues;

    if (properties) {
        clean.properties = {};
        for (const [key, value] of Object.entries(properties)) {
            clean.properties[key] = cleanSchema(value);
        }
    }

    if (required) clean.required = required;

    if (items) {
        clean.items = cleanSchema(items);
    }

    return clean;
}

export function cleanTools(tools) {
    return (tools || [])
        .filter(tool => tool && tool.name)
        .map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: cleanSchema(tool.parameters)
        }));
}

// The setup message in the shape the @google/genai SDK sends: camelCase, with
// responseModalities and speechConfig under generationConfig. The token locks
// model and responseModalities; the rest comes from here.
export function buildLiveSetup({ model, voice, systemInstruction, tools = [] }) {
    const declarations = cleanTools(tools);
    const setup = {
        model,
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice }
                }
            }
        },
        tools: [
            { googleSearch: {} },
            ...(declarations.length > 0 ? [{ functionDeclarations: declarations }] : [])
        ]
    };
    if (systemInstruction) {
        setup.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    return { setup };
}

// One chunk of microphone audio. `mediaChunks` is deprecated in the Live API;
// `audio` is the field the SDK's sendRealtimeInput uses.
export function realtimeAudioMessage(base64, sampleRate) {
    return {
        realtimeInput: {
            audio: { mimeType: `audio/pcm;rate=${sampleRate}`, data: base64 }
        }
    };
}

export function messageSizeBytes(message) {
    return new TextEncoder().encode(JSON.stringify(message)).length;
}
