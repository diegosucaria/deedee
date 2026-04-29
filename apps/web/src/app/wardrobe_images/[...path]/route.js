import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';

export async function GET(_request, { params }) {
    const { session, response } = await requireSession();
    if (!session) return response;

    const { path: rawSegments } = await params;
    const segments = rawSegments || [];
    if (segments.some(s => s === '..' || s.includes('/'))) {
        return new NextResponse('Invalid path', { status: 400 });
    }
    const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';
    const INTERNAL_TOKEN = process.env.DEEDEE_INTERNAL_TOKEN;
    const imageUrl = `${AGENT_URL}/internal/wardrobe/images/${segments.map(encodeURIComponent).join('/')}`;

    try {
        const headers = INTERNAL_TOKEN ? { Authorization: `Bearer ${INTERNAL_TOKEN}` } : {};
        const response = await fetch(imageUrl, { headers });
        if (!response.ok) return new NextResponse('Image not found', { status: 404 });
        const blob = await response.blob();
        const out = new Headers();
        out.set('Content-Type', response.headers.get('Content-Type') || 'image/jpeg');
        // Private cache only — these are user images.
        out.set('Cache-Control', 'private, max-age=31536000, immutable');
        return new NextResponse(blob, { headers: out });
    } catch (error) {
        console.error('[WardrobeProxy] Error fetching image:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
