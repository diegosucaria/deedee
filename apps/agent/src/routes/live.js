const express = require('express');
const { ConfigService } = require('../services/config-service');
const { getLiveSystemInstruction } = require('../prompts/live');

/** A Live session may run this long once connected. */
const TOKEN_TTL_MS = 30 * 60 * 1000;
/** The browser must open the WebSocket within this window after minting. */
const NEW_SESSION_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_VOICE = 'Kore';

function liveModel(agent) {
    const config = agent?.configService || new ConfigService();
    // The Live API wants the "models/" prefix; ConfigService returns the bare id.
    return `models/${config.getModel('LIVE')}`;
}

/** Same lookup as the replyWithAudio executor: agent_settings.voice, else Kore. */
function liveVoice(agent) {
    const settings = agent?.settings || {};
    const voice = settings.voice || settings.voice_settings;
    return typeof voice === 'string' && voice.trim() ? voice.trim() : DEFAULT_VOICE;
}

function timeString() {
    const timeZone = process.env.TZ || 'America/Argentina/Buenos_Aires';
    return new Date().toLocaleString('en-US', { timeZone, timeZoneName: 'short' }) + ` (${timeZone})`;
}

/** The agent's brain for a voice call: model, voice and system instruction. */
function buildLiveConfig(agent) {
    let facts = '';
    try {
        facts = typeof agent?.db?.getFactsFormatted === 'function' ? agent.db.getFactsFormatted('') : '';
    } catch (e) {
        console.warn('[Live] Could not load facts for the voice prompt:', e.message);
    }
    const { text, stats } = getLiveSystemInstruction({
        facts,
        communicationStyle: agent?.settings?.communication_style || '',
        ownerName: agent?.settings?.owner_name || '',
        dateString: timeString()
    });
    return { model: liveModel(agent), voice: liveVoice(agent), systemInstruction: text, stats };
}

function createLiveRouter(agent) {
    const router = express.Router();

    // --- GEMINI LIVE (Real-time) ---

    // 1. Ephemeral token for the browser.
    //
    // Google rejects OAuth tokens from a service account on the Live socket
    // (close code 1008, seen 2026-09-15), so the agent mints a single-use
    // token with its GOOGLE_API_KEY through client.authTokens.create instead.
    //
    // liveConnectConstraints lock the model and the AUDIO modality only.
    // Verified against the SDK (1.34 and 2.22 share this code) and the public
    // discovery document for AuthToken.fieldMask:
    // - constraints without lockAdditionalFields send no fieldMask, and the
    //   API then takes the whole setup from the token and ignores the
    //   browser's setup message: its tools, voice and system instruction
    //   would vanish;
    // - lockAdditionalFields: [] makes the SDK send a fieldMask with just the
    //   fields set here ("model,generationConfig.responseModalities"), so the
    //   browser's setup message fills in the rest.
    // LiveConnectConfig does accept systemInstruction and tools, but putting
    // them here would widen the mask to "systemInstruction.parts", a path this
    // change could not test against the API. The system instruction therefore
    // travels in the setup message (see GET /live/config) next to the tools.
    // Token creation is v1alpha only in the SDK; the model smoke on the device
    // proved this call shape with @google/genai 1.34.0.
    router.post('/token', async (req, res) => {
        const client = agent?.client;
        if (!client?.authTokens?.create) {
            return res.status(503).json({ error: 'Agent not ready' });
        }
        try {
            const model = liveModel(agent);
            const now = Date.now();
            const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
            const token = await client.authTokens.create({
                config: {
                    uses: 1,
                    expireTime: expiresAt,
                    newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
                    liveConnectConstraints: {
                        model,
                        config: { responseModalities: ['AUDIO'] }
                    },
                    lockAdditionalFields: [],
                    httpOptions: { apiVersion: 'v1alpha' }
                }
            });
            if (typeof token?.name !== 'string' || !token.name.startsWith('auth_tokens/')) {
                // Never log the token itself: it is a credential.
                console.error('[Live] Unexpected token response, keys:', Object.keys(token || {}).join(', ') || 'none');
                return res.status(502).json({ error: 'Token generation failed' });
            }
            console.log(`[Live] Ephemeral token minted for ${model}, session until ${expiresAt}.`);
            res.json({ token: token.name, model, expiresAt });
        } catch (error) {
            console.error('[Live] Failed to create the ephemeral token:', error.message);
            res.status(500).json({ error: 'Token generation failed' });
        }
    });

    // 2. Live config: the model, the voice and the agent's own system instruction.
    router.get('/config', (req, res) => {
        try {
            const { model, voice, systemInstruction, stats } = buildLiveConfig(agent);
            console.log(
                `[Live] Config for ${model}, voice ${voice}: system instruction ${stats.chars} chars ` +
                `(~${stats.approxTokens} tokens), facts ${stats.factsShown} shown / ${stats.factsHidden} hidden` +
                `${stats.truncated ? ', TRUNCATED' : ''}.`
            );
            res.json({ model, voice, systemInstruction });
        } catch (error) {
            console.error('[Live] Failed to build the live config:', error.message);
            res.status(500).json({ error: 'Config generation failed' });
        }
    });

    return router;
}

module.exports = { createLiveRouter, buildLiveConfig, TOKEN_TTL_MS, NEW_SESSION_WINDOW_MS };
