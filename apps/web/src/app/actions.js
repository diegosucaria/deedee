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
// removed extra brace

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

export async function getJobLogs(limit = 50) {
    try {
        return await fetchAPI(`/v1/logs/jobs?limit=${limit}`);
    } catch (error) {
        console.error('getJobLogs Error:', error);
        return { logs: [] };
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
