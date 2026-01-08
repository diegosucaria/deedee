'use server';

import { fetchAPI } from '@/lib/api';
import { revalidatePath } from 'next/cache';

// --- Tasks ---
export async function getTasks() {
    try {
        return await fetchAPI('/v1/tasks');
    } catch (error) {
        console.error('getTasks Error:', error);
        return { jobs: [] };
    }
}

export async function cancelTask(name) {
    try {
        const encodedName = encodeURIComponent(name);
        await fetchAPI(`/v1/tasks/${encodedName}/cancel`, { method: 'POST' });
        revalidatePath('/tasks');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function runTask(name) {
    try {
        const encodedName = encodeURIComponent(name);
        await fetchAPI(`/v1/tasks/${encodedName}/run`, { method: 'POST' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function createTask(prevState, formData) {
    try {
        const name = formData.get('name');
        const cron = formData.get('cron');
        const task = formData.get('task');
        const expiresAt = formData.get('expiresAt');
        const isOneOff = formData.get('isOneOff') === 'true';

        // Validation
        if (!name || !cron || !task) return { success: false, error: 'Missing required fields' };

        await fetchAPI('/v1/tasks', {
            method: 'POST',
            body: JSON.stringify({ name, cron, task, expiresAt, isOneOff })
        });
        revalidatePath('/tasks');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Goals ---
export async function addGoal(prevState, formData) {
    try {
        const description = formData.get('description');
        if (!description) return { success: false, error: 'Description required' };

        await fetchAPI('/v1/goals', {
            method: 'POST',
            body: JSON.stringify({ description, metadata: { source: 'web' } })
        });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function deleteGoal(id) {
    try {
        await fetchAPI(`/v1/goals/${id}`, { method: 'DELETE' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function updateGoal(id, status) {
    try {
        await fetchAPI(`/v1/goals/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Facts ---
export async function addFact(prevState, formData) {
    try {
        const key = formData.get('key');
        const value = formData.get('value');
        if (!key || !value) return { success: false, error: 'Key and Value required' };

        await fetchAPI('/v1/facts', { method: 'POST', body: JSON.stringify({ key, value }) });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function deleteFact(key) {
    try {
        await fetchAPI(`/v1/facts/${encodeURIComponent(key)}`, { method: 'DELETE' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Aliases ---
export async function addAlias(prevState, formData) {
    try {
        const alias = formData.get('alias');
        const entityId = formData.get('entityId');
        if (!alias || !entityId) return { success: false, error: 'Alias and Entity ID required' };

        await fetchAPI('/v1/aliases', { method: 'POST', body: JSON.stringify({ alias, entityId }) });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function deleteAlias(alias) {
    try {
        await fetchAPI(`/v1/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- History ---
export async function deleteHistory(id) {
    try {
        await fetchAPI(`/v1/history/${id}`, { method: 'DELETE' });
        revalidatePath('/history');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Journal ---
export async function deleteJournal(date) {
    try {
        await fetchAPI(`/v1/journal/${date}`, { method: 'DELETE' });
        revalidatePath('/journal');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function updateJournal(date, content) {
    try {
        await fetchAPI(`/v1/journal/${date}`, {
            method: 'PUT',
            body: JSON.stringify({ content })
        });
        revalidatePath('/journal');
        revalidatePath(`/journal/${date}`);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}
// --- Stats ---
export async function getStatsLatency() {
    try {
        return await fetchAPI('/v1/stats/latency');
    } catch (error) {
        console.error('getStatsLatency Error:', error);
        return [];
    }
}

export async function getStatsUsage() {
    try {
        return await fetchAPI('/v1/stats/usage');
    } catch (error) {
        console.error('getStatsUsage Error:', error);
        return null;
    }
}

export async function getStatsCostTrend() {
    try {
        return await fetchAPI('/v1/stats/cost-trend');
    } catch (error) {
        console.error('getStatsCostTrend Error:', error);
        return [];
    }
}

export async function getJobLogs(page = 1, limit = 50) {
    try {
        const offset = (page - 1) * limit;
        return await fetchAPI(`/v1/logs/jobs?limit=${limit}&offset=${offset}`);
    } catch (error) {
        console.error('getJobLogs Error:', error);
        return { logs: [] };
    }
}

export async function deleteJobLogs(ids) {
    try {
        await fetchAPI('/v1/logs/jobs/delete', {
            method: 'POST',
            body: JSON.stringify({ ids })
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function cleanupData() {
    try {
        await fetchAPI('/v1/cleanup', { method: 'POST' });
        revalidatePath('/stats');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}



// --- Configuration ---
export async function getEnvConfig() {
    try {
        const res = await fetchAPI('/v1/config/env');
        return res.env || {};
    } catch (error) {
        console.error('getEnvConfig Error:', error);
        return {};
    }
}

export async function getBackups() {
    try {
        const res = await fetchAPI('/v1/backups');
        return res.files || [];
    } catch (error) {
        console.error('getBackups Error:', error);
        return [];
    }
}

export async function triggerBackup() {
    try {
        const res = await fetchAPI('/v1/backups', { method: 'POST' });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getAgentConfig() {
    try {
        return await fetchAPI('/v1/config');
    } catch (error) {
        console.error('getAgentConfig Error:', error);
        return { searchStrategy: { mode: 'HYBRID' } };
    }
}

export async function updateAgentConfig(key, value) {
    try {
        await fetchAPI('/v1/config', {
            method: 'POST',
            body: JSON.stringify({ key, value })
        });
        revalidatePath('/settings');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getVoiceSettings() {
    try {
        const res = await fetchAPI('/v1/settings');
        // Expecting { settings: { key: value } } or array?
        // Server implementation of GET /internal/settings returns { key: value } object.
        return res?.voice || 'Kore';
    } catch (error) {
        console.error('getVoiceSettings Error:', error);
        return 'Kore';
    }
}

export async function saveVoiceSettings(voice) {
    try {
        await fetchAPI('/v1/settings', {
            method: 'POST',
            body: JSON.stringify({ key: 'voice', value: voice })
        });
        revalidatePath('/settings');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function previewVoice(voice, text) {
    try {
        const res = await fetchAPI('/v1/settings/tts/preview', {
            method: 'POST',
            body: JSON.stringify({ voice, text })
        });
        if (res.audio_base64) {
            return { success: true, audio_base64: res.audio_base64, mimeType: res.mimeType };
        }
        return { success: false, error: 'No audio returned' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- WhatsApp Actions ---

export async function getWhatsAppStatus() {
    try {
        return await fetchAPI('/v1/whatsapp/status');
    } catch (error) {
        console.warn('getWhatsAppStatus Error:', error.message);
        return { status: 'error', error: error.message };
    }
}

export async function connectWhatsApp(session) {
    try {
        const res = await fetchAPI('/v1/whatsapp/connect', {
            method: 'POST',
            body: JSON.stringify({ session })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function disconnectWhatsApp(session) {
    try {
        const res = await fetchAPI('/v1/whatsapp/disconnect', {
            method: 'POST',
            body: JSON.stringify({ session })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getWhatsAppContacts(session, query) {
    try {
        let url = `/v1/whatsapp/contacts?session=${session}`;
        if (query) url += `&query=${encodeURIComponent(query)}`;

        return await fetchAPI(url);
    } catch (error) {
        console.warn('getWhatsAppContacts Error:', error.message);
        return [];
    }
}


// --- MCP & Tools ---
export async function getMCPStatus() {
    try {
        const res = await fetchAPI('/v1/mcp/status');
        return res.servers || [];
    } catch (error) {
        console.error('getMCPStatus Error:', error);
        return [];
    }
}

export async function getTools() {
    try {
        const res = await fetchAPI('/v1/live/tools'); // Reuse live endpoint or create new /v1/tools?
        // Wait, I didn't create /v1/tools in dashboard.js but live.js has /tools.
        // live.js is mounted at /v1/live. So /v1/live/tools.
        // I can just use that.
        return res.tools || [];
    } catch (error) {
        console.error('getTools Error:', error);
        return [];
    }
}

// --- Chat Sessions ---

export async function createSession() {
    try {
        const session = await fetchAPI('/v1/sessions', {
            method: 'POST',
            body: JSON.stringify({ reuseEmpty: true })
        });
        revalidatePath('/sessions');
        return { success: true, session };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getSessions(limit = 50, offset = 0) {
    try {
        const res = await fetchAPI(`/v1/sessions?limit=${limit}&offset=${offset}`);
        return res.sessions || [];
    } catch (error) {
        console.error('getSessions Error:', error);
        return [];
    }
}

const LOCATION_CACHE = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

export async function getUserLocation() {
    try {
        const headersList = require('next/headers').headers();
        const ip = headersList.get('x-forwarded-for') || headersList.get('remote-addr') || '';
        const clientIp = ip.split(',')[0].trim();

        // 0. Check Cache
        const cached = LOCATION_CACHE.get(clientIp);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log(`[getUserLocation] Cache Hit for IP: ${clientIp}`);
            return { success: true, data: cached.data };
        }

        // 1. Define Providers with normalization logic
        // We use a simple array of async functions to try in order.
        const providers = [
            // Provider 1: ipapi.co (HTTPS, Rate Limit: 1000/day)
            async () => {
                console.log('[getUserLocation] Trying Provider 1 (ipapi.co)...');
                const url = clientIp ? `https://ipapi.co/${clientIp}/json/` : 'https://ipapi.co/json/';
                const res = await fetch(url, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(3000) // 3s Timeout
                });
                if (!res.ok) throw new Error(`Status ${res.status}`);
                const data = await res.json();
                if (data.error) throw new Error(data.reason || 'API Error');
                return {
                    city: data.city,
                    country: data.country_name,
                    lat: data.latitude,
                    lon: data.longitude,
                    ip: data.ip
                };
            },
            // Provider 2: ipwho.is (HTTPS, Rate Limit: 10k/month, No Auth)
            async () => {
                console.log('[getUserLocation] Trying Provider 2 (ipwho.is)...');
                const url = clientIp ? `https://ipwho.is/${clientIp}` : 'https://ipwho.is/';
                const res = await fetch(url, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(3000) // 3s Timeout
                });
                if (!res.ok) throw new Error(`Status ${res.status}`);
                const data = await res.json();
                if (!data.success) throw new Error(data.message || 'API Error');
                return {
                    city: data.city,
                    country: data.country,
                    lat: data.latitude,
                    lon: data.longitude,
                    ip: data.ip
                };
            },
            // Provider 3: ip-api.com (HTTP, Rate Limit: 45/min)
            // Note: HTTP only for free tier, might be an issue if strict mixed-content, but server-side is fine.
            async () => {
                console.log('[getUserLocation] Trying Provider 3 (ip-api.com)...');
                const url = clientIp ? `http://ip-api.com/json/${clientIp}` : 'http://ip-api.com/json/';
                const res = await fetch(url, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(3000) // 3s Timeout
                });
                if (!res.ok) throw new Error(`Status ${res.status}`);
                const data = await res.json();
                if (data.status === 'fail') throw new Error(data.message || 'API Error');
                return {
                    city: data.city,
                    country: data.country,
                    lat: data.lat,
                    lon: data.lon,
                    ip: data.query
                };
            }
        ];

        // 2. Iterate and Try
        for (const [index, provider] of providers.entries()) {
            try {
                const location = await provider();
                console.log(`[getUserLocation] Success with provider ${index + 1}`);

                // Cache Result
                LOCATION_CACHE.set(clientIp, {
                    data: location,
                    timestamp: Date.now()
                });

                return { success: true, data: location };
            } catch (error) {
                console.warn(`[getUserLocation] Provider ${index + 1} failed: ${error.message}`);
                // Continue to next provider
            }
        }

        throw new Error('All geolocation providers failed.');

    } catch (error) {
        console.error('getUserLocation Error:', error.message);
        return { success: false, error: error.message };
    }
}

export async function getSession(id) {
    try {
        return await fetchAPI(`/v1/sessions/${encodeURIComponent(id)}`);
    } catch (error) {
        console.error(`getSession(${id}) Error:`, error);
        return null;
    }
}

export async function updateSession(id, data) {
    try {
        await fetchAPI(`/v1/sessions/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
        revalidatePath('/sessions');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteSession(id) {
    try {
        await fetchAPI(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/sessions');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
// --- Life Vaults ---
export async function getVaults() {
    try {
        return await fetchAPI('/v1/vaults');
    } catch (error) {
        console.error('getVaults Error:', error);
        return [];
    }
}

export async function createVault(topic) {
    try {
        const res = await fetchAPI('/v1/vaults', {
            method: 'POST',
            body: JSON.stringify({ topic })
        });
        revalidatePath('/vaults');
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getVault(id) {
    try {
        return await fetchAPI(`/v1/vaults/${encodeURIComponent(id)}`);
    } catch (error) {
        console.error(`getVault(${id}) Error:`, error);
        return null; // or throw
    }
}

export async function updateVaultPage(id, content, page = 'index.md') {
    try {
        await fetchAPI(`/v1/vaults/${encodeURIComponent(id)}/wiki`, {
            method: 'POST',
            body: JSON.stringify({ content, page })
        });
        revalidatePath(`/vaults/${id}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteVault(id) {
    try {
        await fetchAPI(`/v1/vaults/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/vaults');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function uploadVaultFile(id, formData) {
    // Note: formData must contain 'file'
    // fetchAPI handles JSON usually. For Multipart, we might need a separate client-side logic OR use fetch directly inside this action.
    // However, Server Actions can accept FormData. But sending it to external API requires careful handling.
    // fetchAPI wrapper might set Content-Type: application/json automatically?
    // Let's look at `fetchAPI`. I assume it's in `src/lib/api.js`.
    // If fetchAPI doesn't support FormData, we use generic fetch with token if needed (but API token is server side).

    // Check if I can see `fetchAPI`.
    // Assuming generic approach:

    try {
        // We need to bypass fetchAPI if it enforces JSON. 
        // But assuming I can't check it right now. I'll take a safer path: use internal helper if possible, or replicate fetchAPI logic for FormData.
        // Actually user rule says: "Use Next.js Server Actions... to fetch data from the API."

        // Let's trust I can handle it here.
        // We need to construct a Request to the Agent API.

        // Re-implementing simplified generic fetch for FormData:
        // Use API_URL from lib/api to ensure consistency (e.g. Docker dns)
        const { API_URL } = require('@/lib/api');
        const { DEEDEE_API_TOKEN } = process.env;

        const res = await fetch(`${API_URL}/v1/vaults/${encodeURIComponent(id)}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`,
                // Do NOT set Content-Type for FormData, browser/node sets it with boundary
            },
            body: formData // in Server Action, this is native FormData
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || res.statusText);
        }

        revalidatePath(`/vaults/${id}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
// --- Chat Files ---
export async function uploadChatFile(chatId, formData) {
    // Note: formData must contain 'file'
    // This is for Generic Chat Uploads (files.js)
    try {
        const { API_URL } = require('@/lib/api');
        const { DEEDEE_API_TOKEN } = process.env;

        const res = await fetch(`${API_URL}/v1/chat/${encodeURIComponent(chatId)}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`,
            },
            body: formData
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        return { success: true, ...data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- People ---
export async function getPeople() {
    try {
        return await fetchAPI('/v1/people');
    } catch (error) {
        console.error('getPeople Error:', error);
        return [];
    }
}

export async function getPerson(id) {
    try {
        return await fetchAPI(`/v1/people/${encodeURIComponent(id)}`);
    } catch (error) {
        console.error(`getPerson(${id}) Error:`, error);
        return null;
    }
}

export async function createPerson(prevState, formData) {
    try {
        const name = formData.get('name');
        const phone = formData.get('phone');
        if (!name) return { success: false, error: 'Name is required' };

        const payload = {
            name,
            phone,
            relationship: formData.get('relationship'),
            notes: formData.get('notes'),
            source: 'web'
        };

        await fetchAPI('/v1/people', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        revalidatePath('/people');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updatePerson(id, data) {
    try {
        await fetchAPI(`/v1/people/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
        revalidatePath('/people');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deletePerson(id) {
    try {
        await fetchAPI(`/v1/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/people');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function triggerSmartLearn() {
    try {
        const res = await fetchAPI('/v1/people/learn', { method: 'POST' });
        return { success: true, candidates: res.candidates };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

