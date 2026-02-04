'use server';

import { getClientToken } from '../actions'; // Re-use existing token logic if available, or fetch fresh
// Actually, apps/web/src/app/actions.js seems to have `getAuthToken`. 
// Let's implement direct API calls here.

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/v1';

async function getAuthHeader() {
    // In a real app, we get the session token. For now, we reuse the pattern from main actions or env.
    // The user rule says: "The token should only exist in the server-side environment".
    // We assume DEEDEE_API_TOKEN is available in the Next.js server environment.
    return {
        'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}`,
        'Content-Type': 'application/json'
    };
}

export async function getSkills() {
    try {
        const headers = await getAuthHeader();
        const res = await fetch(`${API_URL}/skills`, { headers, cache: 'no-store' });
        if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
        return await res.json();
    } catch (e) {
        console.error('getSkills failed:', e);
        return [];
    }
}

export async function saveSkill(filename, content) {
    try {
        const headers = await getAuthHeader();
        const res = await fetch(`${API_URL}/skills`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename, content })
        });
        if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
        return { success: true, result: await res.json() };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function deleteSkill(filename) {
    try {
        const headers = await getAuthHeader();
        // URL Safety: Encode component
        const safeName = encodeURIComponent(filename);
        const res = await fetch(`${API_URL}/skills/${safeName}`, {
            method: 'DELETE',
            headers
        });
        if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}
