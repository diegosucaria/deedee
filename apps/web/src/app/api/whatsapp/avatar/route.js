
import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const jid = searchParams.get('jid');
    const session = searchParams.get('session');
    const { DEEDEE_API_TOKEN } = process.env;

    if (!jid || !DEEDEE_API_TOKEN) {
        return new NextResponse('Bad Configuration', { status: 400 });
    }

    try {
        const url = new URL(`${API_URL}/v1/whatsapp/profile`);
        url.searchParams.set('jid', jid);
        url.searchParams.set('session', session || 'user');

        const res = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`
            },
            cache: 'no-store'
        });

        if (!res.ok) {
            return new NextResponse('Backend Unavailable', { status: 502 });
        }

        const data = await res.json();

        if (!data.url) {
            return new NextResponse('No Avatar', { status: 404 });
        }

        // Redirect to the public WhatsApp CDN URL
        // Using 307 Temporary Redirect to prevent browser caching of the redirect itself if URL changes
        return NextResponse.redirect(data.url, 307);

    } catch (error) {
        console.error('[Avatar Proxy] Error:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
