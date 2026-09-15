'use server';

import { fetchAPI } from '@/lib/api';

// Used only when the agent's /v1/live/config call fails. Mirrors the agent's
// WORKER_LIVE default (apps/agent/src/services/config-service.js).
const DEFAULT_LIVE_MODEL = process.env.WORKER_LIVE || 'gemini-3.8-live';

function withModelsPrefix(model) {
    return model.startsWith('models/') ? model : `models/${model}`;
}

export async function getLiveToken() {
    try {
        const response = await fetchAPI('/v1/live/token', {
            method: 'POST',
        });
        return { success: true, token: response.token };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function executeLiveTool(name, args) {
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
    try {
        const response = await fetchAPI('/v1/live/config');
        return { model: withModelsPrefix(response.model || DEFAULT_LIVE_MODEL) };
    } catch (error) {
        console.error('getLiveConfig Error:', error);
        return { model: withModelsPrefix(DEFAULT_LIVE_MODEL) };
    }
}

export async function getAgentTools() {
    try {
        const response = await fetchAPI('/v1/live/tools');
        return { success: true, tools: response.tools || [] };
    } catch (error) {
        console.error('getAgentTools Error:', error);
        return { success: false, error: error.message, tools: [] };
    }
}
