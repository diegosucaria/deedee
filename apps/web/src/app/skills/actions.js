'use server';

import { fetchAPI } from '@/lib/api';
import { requireActionSession } from '@/lib/auth/guard';
import { revalidatePath } from 'next/cache';

export async function getSkills() {
    try {
        const skills = await fetchAPI('/v1/skills');
        return skills || [];
    } catch (e) {
        console.error('getSkills failed:', e);
        return [];
    }
}

export async function saveSkill(filename, content) {
    await requireActionSession();
    try {
        const res = await fetchAPI('/v1/skills', {
            method: 'POST',
            body: JSON.stringify({ filename, content })
        });
        revalidatePath('/skills');
        return { success: true, result: res };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function deleteSkill(filename) {
    await requireActionSession();
    try {
        // URL Safety: Encode component
        const safeName = encodeURIComponent(filename);
        await fetchAPI(`/v1/skills/${safeName}`, {
            method: 'DELETE'
        });
        revalidatePath('/skills');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function toggleSkill(name, enabled) {
    await requireActionSession();
    try {
        const action = enabled ? 'enable' : 'disable';
        await fetchAPI(`/v1/skills/${encodeURIComponent(name)}/${action}`, {
            method: 'POST'
        });
        revalidatePath('/skills');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function saveSkillSecrets(name, secrets) {
    await requireActionSession();
    try {
        await fetchAPI(`/v1/skills/${encodeURIComponent(name)}/secrets`, {
            method: 'POST',
            body: JSON.stringify({ secrets })
        });
        revalidatePath('/skills');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function getSkill(name) {
    await requireActionSession();
    try {
        const safeName = encodeURIComponent(name);
        const skill = await fetchAPI(`/v1/skills/${safeName}`);
        return skill;
    } catch (e) {
        console.error('getSkill failed:', e);
        throw e;
    }
}
