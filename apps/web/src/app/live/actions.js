'use server';

import { fetchAPI } from '@/lib/api';
import { requireActionSession } from '@/lib/auth/guard';

// Used only when the agent's /v1/live/config call fails. Mirrors the agent's
// WORKER_LIVE default (apps/agent/src/services/config-service.js).
const DEFAULT_LIVE_MODEL = process.env.WORKER_LIVE || 'gemini-3.8-live';
const DEFAULT_VOICE = 'Kore';
// The agent builds the real prompt (apps/agent/src/prompts/live.js). This is
// the bare minimum for when that call fails.
const FALLBACK_SYSTEM_INSTRUCTION = 'You are Deedee, a helpful voice assistant. Keep replies short and speak the language the user speaks.';

function withModelsPrefix(model) {
    return model.startsWith('models/') ? model : `models/${model}`;
}

export async function getLiveToken() {
    await requireActionSession();
    try {
        const response = await fetchAPI('/v1/live/token', {
            method: 'POST',
        });
        return { success: true, token: response.token, model: response.model, expiresAt: response.expiresAt };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function executeLiveTool(name, args) {
    await requireActionSession();
    try {
        const response = await fetchAPI('/v1/live/tools/execute', {
            method: 'POST',
            body: JSON.stringify({ name, args })
        });
        return { success: true, result: response.result };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getLiveConfig() {
    await requireActionSession();
    try {
        const response = await fetchAPI('/v1/live/config');
        return {
            model: withModelsPrefix(response.model || DEFAULT_LIVE_MODEL),
            voice: response.voice || DEFAULT_VOICE,
            systemInstruction: response.systemInstruction || FALLBACK_SYSTEM_INSTRUCTION,
            // Present only on builds whose config route reports the session cut.
            expiresAt: response.expiresAt || null
        };
    } catch (error) {
        console.error('getLiveConfig Error:', error);
        return {
            model: withModelsPrefix(DEFAULT_LIVE_MODEL),
            voice: DEFAULT_VOICE,
            systemInstruction: FALLBACK_SYSTEM_INSTRUCTION,
            expiresAt: null
        };
    }
}

export async function getAgentTools() {
    await requireActionSession();
    try {
        const response = await fetchAPI('/v1/live/tools');
        return { success: true, tools: response.tools || [] };
    } catch (error) {
        console.error('getAgentTools Error:', error);
        return { success: false, error: error.message, tools: [] };
    }
}
