
import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

export async function GET(request, { params }) {
    const { id } = params;
    const { DEEDEE_API_TOKEN } = process.env;

    if (!id || !DEEDEE_API_TOKEN) {
        return new NextResponse('Bad Configuration', { status: 500 });
    }

    try {
        // Fetch from Backend (Agent/API)
        const res = await fetch(`${API_URL}/v1/people/${id}/avatar`, {
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`
            },
            cache: 'no-store' // We handle caching in response
        });

        if (!res.ok) {
            // If 404, backend handles it. We just pass status.
            return new NextResponse(res.statusText, { status: res.status });
        }

        const blob = await res.blob();

        // Proxy headers
        const headers = new Headers();
        headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600'); // Cache for 1h

        return new NextResponse(blob, { headers });
    } catch (error) {
        console.error('[Avatar Proxy] Error:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
