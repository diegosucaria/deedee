import { NextResponse } from 'next/server';

export async function GET(request, { params }) {
    const filename = params.filename;
    // Internal Agent URL
    const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';
    const imageUrl = `${AGENT_URL}/internal/dj/covers/${filename}`;

    try {
        const response = await fetch(imageUrl);

        if (!response.ok) {
            return new NextResponse('Image not found', { status: 404 });
        }

        const blob = await response.blob();
        const headers = new Headers();
        headers.set('Content-Type', response.headers.get('Content-Type') || 'image/jpeg');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');

        return new NextResponse(blob, { headers });
    } catch (error) {
        console.error('[VinylProxy] Error fetching image:', error);
        return new NextResponse('Internal Error', { status: 500 });
    }
}
