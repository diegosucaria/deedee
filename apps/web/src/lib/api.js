
// On Client: Use relative path (rewritten by Next.js to http://api:3001)
// On Server: Use env var or Docker DNS
const API_URL = typeof window === 'undefined'
    ? (process.env.API_URL || 'http://api:3001')
    : '/api';

export { API_URL };

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
        cache: 'no-store', // Be explicit for standard fetch
        next: { revalidate: 0 } // Be explicit for Next.js App Router cache
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Error ${res.status}: ${errorText}`);
    }

    return res.json();
}
