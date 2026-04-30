import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';

export async function GET(request, { params }) {
    const { session, response } = await requireSession();
    if (!session) return response;

    const { filename } = await params;
    const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';
    const INTERNAL_TOKEN = process.env.DEEDEE_INTERNAL_TOKEN;
    const imageUrl = `${AGENT_URL}/internal/dj/covers/${encodeURIComponent(filename)}`;

    try {
        const headers = INTERNAL_TOKEN ? { Authorization: `Bearer ${INTERNAL_TOKEN}` } : {};
        const upstream = await fetch(imageUrl, { headers });

        if (!upstream.ok) {
            return new NextResponse('Image not found', { status: 404 });
        }

        const blob = await upstream.blob();
        const out = new Headers();
        out.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
        out.set('Cache-Control', 'private, max-age=31536000, immutable');

        return new NextResponse(blob, { headers: out });
    } catch (error) {
        console.error('[VinylProxy] Error fetching image:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
