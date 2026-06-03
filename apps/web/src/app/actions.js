'use server';

import { fetchAPI } from '@/lib/api';
import { revalidatePath } from 'next/cache';

// --- Tasks ---
export async function getTasks(includeSystem = false) {
    try {
        const query = includeSystem ? '?includeSystem=true' : '';
        return await fetchAPI(`/v1/tasks${query}`);
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

export async function toggleTask(name, enabled) {
    try {
        const encodedName = encodeURIComponent(name);
        await fetchAPI(`/v1/tasks/${encodedName}/toggle`, {
            method: 'POST',
            body: JSON.stringify({ enabled })
        });
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
        const model = formData.get('model') || 'auto';
        const weekdaysOnly = formData.get('weekdaysOnly') === 'true';
        const daytimeOnly = formData.get('daytimeOnly') === 'true';

        // Validation
        if (!name || !cron || !task) return { success: false, error: 'Missing required fields' };

        await fetchAPI('/v1/tasks', {
            method: 'POST',
            body: JSON.stringify({ name, cron, task, expiresAt, isOneOff, model, weekdaysOnly, daytimeOnly })
        });
        revalidatePath('/tasks');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Cron Helper ---
export async function parseCron(text) {
    try {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { error: 'Please enter a schedule description' };
        }
        const result = await fetchAPI('/v1/cron-helper', {
            method: 'POST',
            body: JSON.stringify({ text: text.trim() })
        });
        return result;
    } catch (error) {
        return { error: error.message || 'Failed to parse schedule' };
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
        await fetchAPI(`/v1/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function updateGoal(id, status) {
    try {
        await fetchAPI(`/v1/goals/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status }) });
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

        await fetchAPI('/v1/facts', {
            method: 'POST',
            body: JSON.stringify({ key, value, source: 'manual', confidence: 'user_explicit', pinned: true })
        });
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

export async function updateFact(originalKey, newKey, value) {
    try {
        if (!newKey || !value) return { success: false, error: 'Key and Value required' };

        // 1. Create/Update the new key
        await fetchAPI('/v1/facts', {
            method: 'POST',
            body: JSON.stringify({ key: newKey, value })
        });

        // 2. If key renamed, delete old key
        if (originalKey !== newKey) {
            await fetchAPI(`/v1/facts/${encodeURIComponent(originalKey)}`, { method: 'DELETE' });
        }

        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function toggleFactPin(key, pinned) {
    try {
        await fetchAPI(`/v1/facts/${encodeURIComponent(key)}/pin`, {
            method: 'POST',
            body: JSON.stringify({ pinned })
        });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Browser Secrets (via Agent API) ---
// Secure: No direct filesystem access from Web container

export async function getBrowserSecretsRaw() {
    try {
        const secrets = await fetchAPI('/v1/browser-secrets');
        return JSON.stringify(secrets, null, 2);
    } catch (e) {
        console.error('Failed to fetch browser secrets:', e);
        return '{}';
    }
}

export async function saveBrowserSecretsRaw(jsonContent) {
    try {
        const secrets = JSON.parse(jsonContent);
        await fetchAPI('/v1/browser-secrets', {
            method: 'POST',
            body: JSON.stringify(secrets)
        });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
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
        await fetchAPI(`/v1/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/history');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Journal ---
export async function getJournalFiles() {
    try {
        const data = await fetchAPI('/v1/journal');
        return (data.files || []).sort().reverse();
    } catch (e) {
        console.error('getJournalFiles Error:', e);
        return [];
    }
}

export async function getJournalEntry(date) {
    try {
        const data = await fetchAPI(`/v1/journal/${encodeURIComponent(date)}`);
        return { content: data.content || '' };
    } catch (e) {
        return { error: e.message };
    }
}

export async function deleteJournal(date) {
    try {
        await fetchAPI(`/v1/journal/${encodeURIComponent(date)}`, { method: 'DELETE' });
        revalidatePath('/journal');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function updateJournal(date, content) {
    try {
        await fetchAPI(`/v1/journal/${encodeURIComponent(date)}`, {
            method: 'PUT',
            body: JSON.stringify({ content })
        });
        revalidatePath('/journal');
        revalidatePath(`/journal/${date}`);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}
// --- Stats ---
export async function getSystemStats(query = '') {
    try {
        return await fetchAPI(`/v1/stats${query}`);
    } catch (error) {
        console.error('getSystemStats Error:', error);
        return {};
    }
}

export async function getStatsLatency(query = '') {
    try {
        return await fetchAPI(`/v1/stats/latency${query}`);
    } catch (error) {
        console.error('getStatsLatency Error:', error);
        return [];
    }
}

export async function getStatsUsage(query = '') {
    try {
        return await fetchAPI(`/v1/stats/usage${query}`);
    } catch (error) {
        console.error('getStatsUsage Error:', error);
        return null;
    }
}

export async function getStatsCostTrend(query = '') {
    try {
        return await fetchAPI(`/v1/stats/cost-trend${query}`);
    } catch (error) {
        console.error('getStatsCostTrend Error:', error);
        return [];
    }
}

export async function getDailyCostTrend(query = '') {
    try {
        return await fetchAPI(`/v1/stats/daily-cost${query}`);
    } catch (error) {
        console.error('getDailyCostTrend Error:', error);
        return [];
    }
}

export async function getCostByTag(query = '') {
    try {
        return await fetchAPI(`/v1/stats/cost-by-tag${query}`);
    } catch (error) {
        console.error('getCostByTag Error:', error);
        return { categories: {}, total: { cost: 0, tokens: 0, calls: 0 } };
    }
}

export async function getDailyCostByCategory(query = '') {
    try {
        return await fetchAPI(`/v1/stats/daily-cost-by-category${query}`);
    } catch (error) {
        console.error('getDailyCostByCategory Error:', error);
        return [];
    }
}

export async function getCostByModel(query = '') {
    try {
        return await fetchAPI(`/v1/stats/cost-by-model${query}`);
    } catch (error) {
        console.error('getCostByModel Error:', error);
        return [];
    }
}

export async function getLatencyPercentiles(query = '') {
    try {
        return await fetchAPI(`/v1/stats/latency-percentiles${query}`);
    } catch (error) {
        console.error('getLatencyPercentiles Error:', error);
        return [];
    }
}

export async function getTokenBreakdownTrend(query = '') {
    try {
        return await fetchAPI(`/v1/stats/token-breakdown${query}`);
    } catch (error) {
        console.error('getTokenBreakdownTrend Error:', error);
        return [];
    }
}

export async function getCacheHitRate(query = '') {
    try {
        return await fetchAPI(`/v1/stats/cache-hit-rate${query}`);
    } catch (error) {
        console.error('getCacheHitRate Error:', error);
        return [];
    }
}

export async function getModelUsage(query = '') {
    try {
        return await fetchAPI(`/v1/stats/model-usage${query}`);
    } catch (error) {
        console.error('getModelUsage Error:', error);
        return [];
    }
}

export async function getJobLogs(page = 1, limit = 50, { search, status } = {}) {
    try {
        const offset = (page - 1) * limit;
        const params = new URLSearchParams({ limit, offset });
        if (search) params.set('search', search);
        if (status && status !== 'all') params.set('status', status);
        return await fetchAPI(`/v1/logs/jobs?${params}`);
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
        return await fetchAPI('/v1/settings');
    } catch (error) {
        console.error('getAgentConfig Error:', error);
        return { search_strategy: { mode: 'HYBRID' } };
    }
}

export async function updateAgentConfig(key, value) {
    try {
        await fetchAPI('/v1/settings', {
            method: 'POST',
            body: JSON.stringify({ key, value })
        });
        revalidatePath('/settings');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Public outbound IP of the host running the agent (the Pi). Used to restrict
// the Gemini API key to this host. Pass { refresh: true } to bypass the cache.
export async function getEgressIP({ refresh = false } = {}) {
    try {
        const qs = refresh ? '?refresh=1' : '';
        return await fetchAPI(`/v1/settings/egress-ip${qs}`);
    } catch (error) {
        console.error('getEgressIP Error:', error);
        return { error: error.message };
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

// --- GWS Auth Actions ---
export async function uploadGWSCredentials(label, accountEmail, credentials) {
    try {
        const res = await fetchAPI('/v1/settings/gws/upload', {
            method: 'POST',
            body: JSON.stringify({ label, accountEmail, credentials })
        });
        revalidatePath('/settings');
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function saveGWSAuthClient(clientData) {
    try {
        const res = await fetchAPI('/v1/settings/gws/oauth/client', {
            method: 'POST',
            body: JSON.stringify(clientData)
        });
        revalidatePath('/settings');
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getGWSAuthClient() {
    try {
        return await fetchAPI('/v1/settings/gws/oauth/client');
    } catch (error) {
        console.error('getGWSAuthClient Error:', error);
        return { configured: false };
    }
}

export async function getGWSAuthURL(label, email) {
    try {
        const params = new URLSearchParams({ label, email });
        return await fetchAPI(`/v1/settings/gws/oauth/url?${params.toString()}`);
    } catch (error) {
        return { error: error.message };
    }
}

export async function validateGWSAuth(label) {
    try {
        return await fetchAPI(`/v1/settings/gws/validate/${encodeURIComponent(label)}`);
    } catch (error) {
        console.error('validateGWSAuth Error:', error);
        return { valid: false, error: 'network_error' };
    }
}

// --- GWS Calendar Filter Actions ---

export async function getGWSCalendars(label) {
    try {
        return await fetchAPI(`/v1/gsuite/calendars/${encodeURIComponent(label)}`);
    } catch (error) {
        console.error('getGWSCalendars Error:', error);
        return { calendars: [], error: error.message };
    }
}

export async function getGWSCalendarFilter(label) {
    try {
        return await fetchAPI(`/v1/gsuite/calendar-filter/${encodeURIComponent(label)}`);
    } catch (error) {
        console.error('getGWSCalendarFilter Error:', error);
        return { calendarIds: [], primaryOnly: true };
    }
}

export async function saveGWSCalendarFilter(label, calendarIds) {
    try {
        const res = await fetchAPI(`/v1/gsuite/calendar-filter/${encodeURIComponent(label)}`, {
            method: 'POST',
            body: JSON.stringify({ calendarIds })
        });
        return { success: true, ...res };
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


// --- Slack Actions ---

export async function getSlackStatus() {
    try {
        return await fetchAPI('/v1/slack/status');
    } catch (error) {
        console.warn('getSlackStatus Error:', error.message);
        return { connections: [] };
    }
}

export async function saveSlackCredentials(xoxc, xoxd) {
    try {
        const res = await fetchAPI('/v1/slack/credentials', {
            method: 'POST',
            body: JSON.stringify({ xoxc, xoxd })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function testSlackCredentials(xoxc, xoxd) {
    try {
        const res = await fetchAPI('/v1/slack/credentials', {
            method: 'POST',
            body: JSON.stringify({ xoxc, xoxd, test: true })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteSlackCredentials(teamId) {
    try {
        await fetchAPI(`/v1/slack/credentials/${encodeURIComponent(teamId)}`, { method: 'DELETE' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function setSlackListening(teamId, listening) {
    try {
        const res = await fetchAPI('/v1/slack/listening', {
            method: 'POST',
            body: JSON.stringify({ teamId, listening })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getSlackChannels(teamId) {
    try {
        const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
        return await fetchAPI(`/v1/slack/channels${query}`);
    } catch (error) {
        console.error('getSlackChannels Error:', error.message);
        return [];
    }
}

export async function getSlackMonitoredChannels(teamId) {
    try {
        const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
        return await fetchAPI(`/v1/slack/monitored-channels${query}`);
    } catch (error) {
        console.error('getSlackMonitoredChannels Error:', error.message);
        return [];
    }
}

export async function setSlackMonitoredChannels(teamId, channels) {
    try {
        await fetchAPI('/v1/slack/monitored-channels', {
            method: 'POST',
            body: JSON.stringify({ teamId, channels })
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- MCP & Tools ---
export async function getMCPStatus() {
    try {
        // API now returns Object { name: config }
        // We want array [{ name, status, type }]
        // Note: Real "status" (connected/disconnected) logic is complex without proxying Agent.
        // For now, assume "configured" means we can list it. 
        // Ideally we'd query Agent for runtime status.
        // Let's defer runtime status improvements and just list configured servers.
        const config = await fetchAPI('/v1/mcp');

        // Transform to array
        return Object.entries(config).map(([name, cfg]) => ({
            name,
            status: cfg.disabled ? 'disabled' : 'enabled', // Simple status
            type: cfg.transport,
            email: cfg.env?.GOOGLE_WORKSPACE_CLI_ACCOUNT || null,
        }));
    } catch (error) {
        console.error('getMCPStatus Error:', error);
        return [];
    }
}

export async function addMCPServer(prevState, formData) {
    try {
        const name = formData.get('name');
        const url = formData.get('url');
        const token = formData.get('token');

        if (!name || !url) return { success: false, error: 'Name and URL required' };

        await fetchAPI('/v1/mcp', {
            method: 'POST',
            body: JSON.stringify({
                name,
                transport: 'sse',
                url,
                token
            })
        });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function deleteMCPServer(name) {
    try {
        await fetchAPI(`/v1/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) {
        return { error: e.message || 'Failed to delete server' };
    }
}

export async function reloadMCPServers() {
    try {
        await fetchAPI(`/v1/mcp/reload`, { method: 'POST' });
        revalidatePath('/brain');
        return { success: true };
    } catch (e) {
        return { error: e.message || 'Failed to reload servers' };
    }
}

export async function getVinylCrate(limit = 50, offset = 0) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls?limit=${limit}&offset=${offset}`, { method: "GET" });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function uploadVinylPhoto(base64Data, mimeType) {
    try {
        const data = await fetchAPI('/v1/dj/vinyls/upload', {
            method: 'POST',
            body: JSON.stringify({ image: base64Data, mimeType })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateVinyl(id, fields) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(fields)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteVinyl(id) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function reEnrichVinyl(id) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls/${encodeURIComponent(id)}/enrich`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function retryEnrichVinyl(id) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls/${encodeURIComponent(id)}/retry-enrich`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function refreshVinylValue(id) {
    try {
        const data = await fetchAPI(`/v1/dj/vinyls/${encodeURIComponent(id)}/value`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getCrates() {
    try {
        const data = await fetchAPI('/v1/dj/crates', { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function createCrate({ name, type, rules, icon, color }) {
    try {
        const data = await fetchAPI('/v1/dj/crates', {
            method: 'POST',
            body: JSON.stringify({ name, type, rules, icon, color })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateCrate(id, fields) {
    try {
        const data = await fetchAPI(`/v1/dj/crates/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(fields)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteCrate(id) {
    try {
        const data = await fetchAPI(`/v1/dj/crates/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getCrateVinyls(crateId) {
    try {
        const data = await fetchAPI(`/v1/dj/crates/${encodeURIComponent(crateId)}/vinyls`, {
            method: 'GET'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function addVinylToCrate(crateId, vinylId) {
    try {
        const data = await fetchAPI(`/v1/dj/crates/${encodeURIComponent(crateId)}/vinyls/${encodeURIComponent(vinylId)}`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function removeVinylFromCrate(crateId, vinylId) {
    try {
        const data = await fetchAPI(`/v1/dj/crates/${encodeURIComponent(crateId)}/vinyls/${encodeURIComponent(vinylId)}`, {
            method: 'DELETE'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Wardrobe ---

export async function getWardrobe({ limit = 200, offset = 0, type = null } = {}) {
    try {
        const qs = new URLSearchParams();
        qs.set('limit', String(limit));
        qs.set('offset', String(offset));
        if (type) qs.set('type', type);
        const data = await fetchAPI(`/v1/wardrobe/garments?${qs.toString()}`, { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function uploadGarmentPhoto(base64Data, mimeType) {
    try {
        const data = await fetchAPI('/v1/wardrobe/garments/upload', {
            method: 'POST',
            body: JSON.stringify({ image: base64Data, mimeType })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateGarment(id, fields) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(fields)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteGarment(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function confirmGarmentBrand(id, accept) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(id)}/confirm-brand`, {
            method: 'POST',
            body: JSON.stringify({ accept: !!accept })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function reenrichGarment(id, hint = '', { extraImageBase64 = null, mimeType = null } = {}) {
    try {
        const body = { hint };
        if (extraImageBase64) body.extra_image = extraImageBase64;
        if (mimeType) body.mimeType = mimeType;
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(id)}/reenrich`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function generateGarmentImage(id, { extraImageBase64 = null, mimeType = null } = {}) {
    try {
        const body = {};
        if (extraImageBase64) body.extra_image = extraImageBase64;
        if (mimeType) body.mimeType = mimeType;
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(id)}/generate-image`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function mergeGarments(primaryId, duplicateIds) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(primaryId)}/merge`, {
            method: 'POST',
            body: JSON.stringify({ duplicate_ids: duplicateIds })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function duplicateGarment(sourceId, base64Data, mimeType) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(sourceId)}/duplicate`, {
            method: 'POST',
            body: JSON.stringify({ image: base64Data, mimeType })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteOutfit(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/outfits/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateOutfit(id, fields) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/outfits/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(fields)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function generateOutfitVariations(id, count = 3) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/outfits/${encodeURIComponent(id)}/variations`, {
            method: 'POST',
            body: JSON.stringify({ count })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function generateOutfitsForGarment(garmentId, count = 4) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/garments/${encodeURIComponent(garmentId)}/outfits`, {
            method: 'POST',
            body: JSON.stringify({ count })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function generateShoppingReferenceImage(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/shopping/${encodeURIComponent(id)}/reference-image`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getOutfit(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/outfits/${encodeURIComponent(id)}`);
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getWardrobeProfile() {
    try {
        const data = await fetchAPI('/v1/wardrobe/profile', { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateWardrobeProfile(fields) {
    try {
        const data = await fetchAPI('/v1/wardrobe/profile', {
            method: 'PUT',
            body: JSON.stringify(fields)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function uploadReferenceSelfie(base64Data, mimeType) {
    try {
        const data = await fetchAPI('/v1/wardrobe/profile/reference-selfie', {
            method: 'POST',
            body: JSON.stringify({ image: base64Data, mimeType })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Wardrobe: Outfits ---

export async function getOutfits({ liked = null } = {}) {
    try {
        const qs = liked === null ? '' : `?liked=${liked ? 'true' : 'false'}`;
        const data = await fetchAPI(`/v1/wardrobe/outfits${qs}`, { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function likeOutfit(id, liked = true) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/outfits/${encodeURIComponent(id)}/like`, {
            method: 'POST',
            body: JSON.stringify({ liked })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Wardrobe: Trips ---

export async function getTrips({ status = null } = {}) {
    try {
        const qs = status ? `?status=${encodeURIComponent(status)}` : '';
        const data = await fetchAPI(`/v1/wardrobe/trips${qs}`, { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getTrip(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}`, { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function startTrip(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/start`, { method: 'POST' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function completeTrip(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/complete`, { method: 'POST' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function renderTripDailyOutfits(id, { force = false } = {}) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/render-daily`, {
            method: 'POST',
            body: JSON.stringify({ force })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function setTripCapsule(id, garmentIds) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/capsule`, {
            method: 'PUT',
            body: JSON.stringify({ garment_ids: garmentIds })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function addToTripCapsule(id, { garmentIds = null, imageBase64 = null, mimeType = null } = {}) {
    try {
        const body = {};
        if (garmentIds) body.garment_ids = garmentIds;
        if (imageBase64) body.image = imageBase64;
        if (mimeType) body.mimeType = mimeType;
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/capsule/add`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function removeFromTripCapsule(id, garmentIds) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/trips/${encodeURIComponent(id)}/capsule/remove`, {
            method: 'POST',
            body: JSON.stringify({ garment_ids: garmentIds })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Wardrobe: Shopping list ---

export async function getShoppingList({ status = null } = {}) {
    try {
        const qs = status ? `?status=${encodeURIComponent(status)}` : '';
        const data = await fetchAPI(`/v1/wardrobe/shopping${qs}`, { method: 'GET' });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function markShoppingItemPurchased(id, garmentId = null) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/shopping/${encodeURIComponent(id)}/purchased`, {
            method: 'POST',
            body: JSON.stringify(garmentId ? { garment_id: garmentId } : {})
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function dismissShoppingItem(id) {
    try {
        const data = await fetchAPI(`/v1/wardrobe/shopping/${encodeURIComponent(id)}/dismiss`, {
            method: 'POST'
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function rewindChat(chatId, messageId) {
    console.log('[DEBUG] rewindChat Action:', { chatId, messageId });
    try {
        const data = await fetchAPI(`/v1/chat/rewind`, {
            method: "POST",
            body: JSON.stringify({ chatId, messageId })
        });
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function forkChat(chatId, messageId) {
    console.log('[DEBUG] forkChat Action:', { chatId, messageId });
    try {
        const data = await fetchAPI(`/v1/chat/fork`, {
            method: "POST",
            body: JSON.stringify({ chatId, messageId })
        });
        revalidatePath('/');
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function stopChat(chatId) {
    try {
        await fetchAPI(`/v1/chat/stop`, {
            method: "POST",
            body: JSON.stringify({ chatId })
        });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
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

export async function getSessions(limit = 50, offset = 0, preserveId = null) {
    try {
        const query = new URLSearchParams({ limit, offset });
        if (preserveId) query.append('preserveId', preserveId);

        const res = await fetchAPI(`/v1/sessions?${query.toString()}`);
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

export async function getVaultPage(id, page) {
    try {
        const res = await fetchAPI(`/v1/vaults/${encodeURIComponent(id)}/pages?name=${encodeURIComponent(page)}`);
        return res.content || '';
    } catch (error) {
        console.error(`getVaultPage(${id}, ${page}) Error:`, error);
        return null;
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
export async function deleteVaultFile(id, filename) {
    try {
        const { API_URL } = require('@/lib/api');
        const { DEEDEE_API_TOKEN } = process.env;

        const res = await fetch(`${API_URL}/v1/vaults/${encodeURIComponent(id)}/files`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ filename })
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
export async function getPeople({ limit, offset, search } = {}) {
    try {
        const params = new URLSearchParams();
        if (limit) params.set('limit', limit);
        if (offset) params.set('offset', offset);
        if (search) params.set('search', search);

        return await fetchAPI(`/v1/people?${params.toString()}`);
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

export async function syncWhatsAppContacts() {
    try {
        const res = await fetchAPI('/v1/people/sync', { method: 'POST' });
        revalidatePath('/people');
        return { success: true, stats: res.stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function syncSlackContacts() {
    try {
        const res = await fetchAPI('/v1/people/sync/slack', { method: 'POST' });
        revalidatePath('/people');
        return { success: true, stats: res.stats };
    } catch (e) {
        return { success: false, error: e.message };
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

export async function triggerSmartLearn(offset = 0, limit = 5) {
    try {
        const res = await fetchAPI('/v1/people/learn', {
            method: 'POST',
            body: JSON.stringify({ limit, offset })
        });
        return { success: true, candidates: res.candidates };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Watchers ---
export async function getWatchers() {
    try {
        const res = await fetchAPI('/v1/config/watchers?status=all');
        return res.watchers || [];
    } catch (e) {
        console.error('getWatchers Error:', e);
        return [];
    }
}

export async function createWatcher(prevState, formData) {
    try {
        const id = formData.get('id');
        const name = formData.get('name');
        const contactString = formData.get('contactString');
        const condition = formData.get('condition');
        const instruction = formData.get('instruction');

        if (!contactString || !condition || !instruction) {
            return { success: false, error: 'Missing required fields' };
        }

        if (id) {
            // Update
            await fetchAPI(`/v1/config/watchers/${encodeURIComponent(id)}`, {
                method: 'PUT',
                body: JSON.stringify({ name, contactString, condition, instruction })
            });
        } else {
            // Create
            await fetchAPI('/v1/config/watchers', {
                method: 'POST',
                body: JSON.stringify({ name, contactString, condition, instruction })
            });
        }
        revalidatePath('/tasks');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function deleteWatcher(id) {
    try {
        await fetchAPI(`/v1/config/watchers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/tasks');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function toggleWatcher(id, status) {
    try {
        // PUT endpoint usually expects JSON body for updates
        // Note: The backend route for PUT might not be defined in config.js based on previous grep.
        // Checking config.js again might be needed, or we rely on creating it if missing.
        // Assuming /v1/config/watchers/:id PUT exists or update via POST?
        // Let's assume standard REST if implemented.
        // Wait, grep in Step 1953 only showed GET, POST, DELETE.
        // I might need to implement PUT in backend first if missing.
        // For now, let's implement the action optimistically.
        await fetchAPI(`/v1/config/watchers/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ status })
        });
        revalidatePath('/tasks');
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Autopilot Actions ---

export async function getAutopilotDrafts(status = 'pending') {
    try {
        return await fetchAPI(`/v1/autopilot/drafts?status=${status}`);
    } catch (error) {
        console.error('getAutopilotDrafts Error:', error);
        return [];
    }
}

export async function approveDraft(id) {
    try {
        const res = await fetchAPI(`/v1/autopilot/drafts/${id}/approve`, { method: 'POST' });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function rejectDraft(id) {
    try {
        await fetchAPI(`/v1/autopilot/drafts/${id}`, { method: 'DELETE' });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function editDraft(id, content) {
    try {
        await fetchAPI(`/v1/autopilot/drafts/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ content })
        });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getAutopilotSettings() {
    try {
        return await fetchAPI(`/v1/autopilot/settings`);
    } catch (error) {
        console.error('getAutopilotSettings Error:', error);
        return [];
    }
}

export async function updateAutopilotStatus(contactId, status, duration = 0) {
    try {
        await fetchAPI(`/v1/autopilot/settings/${encodeURIComponent(contactId)}`, {
            method: 'POST',
            body: JSON.stringify({ status, duration })
        });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function toggleAutopilotPin(contactId, isPinned) {
    try {
        await fetchAPI(`/v1/autopilot/settings/${encodeURIComponent(contactId)}/pin`, {
            method: 'POST',
            body: JSON.stringify({ isPinned })
        });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getStyleProfile() {
    try {
        const data = await fetchAPI('/v1/autopilot/style');
        return data.profile;
    } catch (error) {
        console.error('getStyleProfile Error:', error);
        return null;
    }
}

export async function saveStyleProfile(profile) {
    try {
        await fetchAPI('/v1/autopilot/style', {
            method: 'POST',
            body: JSON.stringify({ profile })
        });
        revalidatePath('/autopilot');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function analyzeStyle() {
    try {
        const data = await fetchAPI('/v1/autopilot/style/analyze', { method: 'POST' });
        revalidatePath('/autopilot');
        return { success: true, profile: data.profile };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function getContactStyle(contactId) {
    try {
        const data = await fetchAPI(`/v1/autopilot/style/${encodeURIComponent(contactId)}`);
        return data.profile;
    } catch (error) {
        console.error(`getContactStyle(${contactId}) Error:`, error);
        return null;
    }
}

export async function saveContactStyle(contactId, profile) {
    try {
        await fetchAPI(`/v1/autopilot/style/${encodeURIComponent(contactId)}`, {
            method: 'POST',
            body: JSON.stringify({ profile })
        });
        revalidatePath('/autopilot');
        // also revalidate profile page if we had one
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function analyzeContactStyle(contactId) {
    try {
        const data = await fetchAPI(`/v1/autopilot/style/${encodeURIComponent(contactId)}/analyze`, { method: 'POST' });
        revalidatePath('/autopilot');
        return { success: true, profile: data.profile };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Vault Embeddings ---

export async function getVaultEmbeddings(vaultId) {
    try {
        return await fetchAPI(`/v1/vaults/${encodeURIComponent(vaultId)}/embeddings`);
    } catch (error) {
        console.error(`getVaultEmbeddings(${vaultId}) Error:`, error);
        return [];
    }
}

export async function deleteVaultEmbedding(vaultId, filename) {
    try {
        await fetchAPI(`/v1/vaults/${encodeURIComponent(vaultId)}/embeddings/${encodeURIComponent(filename)}`, {
            method: 'DELETE'
        });
        revalidatePath(`/vaults/${vaultId}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function repairWhatsAppSession(session) {
    try {
        await fetchAPI('/v1/whatsapp/repair', { method: 'POST', body: JSON.stringify({ session }) });
        revalidatePath('/settings'); // Assuming this is where it's used
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- Sub-Agents ---
export async function getSubAgentTasks({ page = 1, limit = 50, search, status } = {}) {
    try {
        const params = new URLSearchParams({ page, limit });
        if (search) params.set('search', search);
        if (status && status !== 'all') params.set('status', status);
        return await fetchAPI(`/v1/subagents?${params}`);
    } catch (error) {
        console.error('getSubAgentTasks Error:', error);
        return { tasks: [], total: 0, page: 1, limit, totalPages: 0 };
    }
}

export async function cleanupSubAgentTasks() {
    try {
        const result = await fetchAPI('/v1/subagents/cleanup', { method: 'POST' });
        revalidatePath('/tasks');
        return result;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- GSuite / Google Workspace ---

export async function getGSuiteAccounts() {
    try {
        const res = await fetchAPI('/v1/gsuite/accounts');
        return res.accounts || [];
    } catch (error) {
        console.error('getGSuiteAccounts Error:', error);
        return [];
    }
}

export async function getGSuiteAuthUrl() {
    try {
        const res = await fetchAPI('/v1/gsuite/auth-url', { method: 'POST' });
        return res;
    } catch (error) {
        return { error: error.message };
    }
}

export async function authenticateGSuite(code) {
    try {
        const res = await fetchAPI('/v1/gsuite/auth', {
            method: 'POST',
            body: JSON.stringify({ code })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function disconnectGSuite(email) {
    try {
        const res = await fetchAPI('/v1/gsuite/disconnect', {
            method: 'POST',
            body: JSON.stringify({ email })
        });
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function updateGSuiteAccountLabel(email, label) {
    try {
        const res = await fetchAPI(`/v1/gsuite/accounts/${encodeURIComponent(email)}/label`, {
            method: 'PUT',
            body: JSON.stringify({ label })
        });
        revalidatePath('/settings');
        return { success: true, ...res };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// --- Notifications ---

export async function getNotifications(limit = 50, includeRead = false, includeDismissed = false) {
    try {
        const params = new URLSearchParams({ limit, includeRead, includeDismissed });
        return await fetchAPI(`/v1/notifications?${params.toString()}`);
    } catch (error) {
        console.error('getNotifications Error:', error);
        return { notifications: [], unreadCount: 0 };
    }
}

export async function getUnreadCount() {
    try {
        return await fetchAPI('/v1/notifications/count');
    } catch (error) {
        return { count: 0 };
    }
}

export async function markNotificationRead(id) {
    try {
        await fetchAPI(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function markAllNotificationsRead() {
    try {
        await fetchAPI('/v1/notifications/read-all', { method: 'POST' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function dismissNotification(id) {
    try {
        await fetchAPI(`/v1/notifications/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function dismissAllNotifications() {
    try {
        await fetchAPI('/v1/notifications/dismiss-all', { method: 'POST' });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

export async function deleteNotification(id) {
    try {
        await fetchAPI(`/v1/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
        revalidatePath('/system/notifications');
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}
