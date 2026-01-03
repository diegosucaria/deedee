'use server';

import { fetchAPI } from '@/lib/api';
import { revalidatePath } from 'next/cache';

export async function cancelTask(name) {
    try {
        const encodedName = encodeURIComponent(name);
        // Call existing API endpoint via helper (which now adds Bearer token)
        // Note: fetchAPI uses process.env.API_URL (server to server)
        await fetchAPI(`/v1/tasks/${encodedName}/cancel`, {
            method: 'POST',
        });

        // Revalidate the tasks page to show updated list
        revalidatePath('/tasks');
        return { success: true };
    } catch (error) {
        console.error('Cancel Task Error:', error);
        return { success: false, error: error.message };
    }
}
