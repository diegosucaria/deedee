import { NextResponse } from 'next/server';

export async function GET(_request, { params }) {
    const segments = params.path || [];
    if (segments.some(s => s === '..' || s.includes('/'))) {
        return new NextResponse('Invalid path', { status: 400 });
    }
    const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';
    const imageUrl = `${AGENT_URL}/internal/wardrobe/images/${segments.map(encodeURIComponent).join('/')}`;

    try {
        const response = await fetch(imageUrl);
        if (!response.ok) return new NextResponse('Image not found', { status: 404 });
        const blob = await response.blob();
        const headers = new Headers();
        headers.set('Content-Type', response.headers.get('Content-Type') || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new NextResponse(blob, { headers });
    } catch (error) {
        console.error('[WardrobeProxy] Error fetching image:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
