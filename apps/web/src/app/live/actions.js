'use server';

import { fetchAPI } from '@/lib/api';

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
    let model = process.env.WORKER_LIVE || 'models/gemini-2.0-flash-exp';
    if (model && !model.startsWith('models/')) {
        model = `models/${model}`;
    }
    return { model };
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
