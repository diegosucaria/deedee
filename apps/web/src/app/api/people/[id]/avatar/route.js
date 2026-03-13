
import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

export async function GET(request, { params }) {
    const { id } = await params;
    const { DEEDEE_API_TOKEN } = process.env;

    if (!id || !DEEDEE_API_TOKEN) {
        return new NextResponse('Bad Configuration', { status: 500 });
    }

    try {
        // Fetch from Backend (Agent/API) — don't follow redirects so we can detect fallbacks
        const res = await fetch(`${API_URL}/v1/people/${encodeURIComponent(id)}/avatar`, {
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`
            },
            cache: 'no-store',
            redirect: 'manual' // Don't follow ui-avatars redirect
        });

        // Backend redirects to ui-avatars.com when no cached avatar exists.
        // Pass the redirect through with short cache so browser retries soon.
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('Location');
            if (location) {
                return NextResponse.redirect(location, {
                    headers: {
                        'Cache-Control': 'public, max-age=60' // Only 60s for fallbacks
                    }
                });
            }
        }

        if (!res.ok) {
            return new NextResponse(res.statusText, { status: res.status });
        }

        const blob = await res.blob();

        // Real cached avatar — cache for 1 hour
        const headers = new Headers();
        headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');

        return new NextResponse(blob, { headers });
    } catch (error) {
        console.error('[Avatar Proxy] Error:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
