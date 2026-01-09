
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
        // Fetch URL from Backend (Interfaces Service)
        const res = await fetch(`${API_URL}/whatsapp/profile?jid=${encodeURIComponent(jid)}&session=${encodeURIComponent(session || 'user')}`, {
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
