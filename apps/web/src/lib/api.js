
const API_URL = process.env.API_URL || 'http://localhost:3001';

export async function fetchAPI(path, options = {}) {
    const url = `${API_URL}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}`,
        ...options.headers,
    };

    const res = await fetch(url, {
        ...options,
        headers,
        cache: 'no-store' // Ensure fresh data
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Error ${res.status}: ${errorText}`);
    }

    return res.json();
}
