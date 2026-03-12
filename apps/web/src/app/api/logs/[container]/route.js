import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

const ALLOWED_CONTAINERS = new Set(['all', 'agent', 'interfaces', 'api', 'web', 'supervisor']);

export async function GET(request, { params }) {
    const { container } = await params;
    const { DEEDEE_API_TOKEN } = process.env;

    if (!DEEDEE_API_TOKEN) {
        return new Response('Server misconfiguration', { status: 500 });
    }

    if (!ALLOWED_CONTAINERS.has(container)) {
        return new Response('Invalid container', { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const upstream = new URL(`${API_URL}/v1/logs/${encodeURIComponent(container)}`);

    for (const key of ['since', 'tail']) {
        if (searchParams.has(key)) {
            upstream.searchParams.set(key, searchParams.get(key));
        }
    }

    try {
        const res = await fetch(upstream.toString(), {
            headers: { 'Authorization': `Bearer ${DEEDEE_API_TOKEN}` },
            signal: request.signal,
            cache: 'no-store',
        });

        if (!res.ok) {
            return new Response(res.statusText || 'Upstream error', { status: res.status });
        }

        return new Response(res.body, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Transfer-Encoding': 'chunked',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            return new Response(null, { status: 499 });
        }
        console.error('[LogsProxy] Upstream error:', err.message);
        return new Response('Failed to connect to log service', { status: 502 });
    }
}
