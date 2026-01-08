
import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

export async function GET(request, { params }) {
    const { id, filename } = params;
    const { DEEDEE_API_TOKEN } = process.env;

    if (!DEEDEE_API_TOKEN) {
        return new NextResponse('Configuration Error: Token Missing', { status: 500 });
    }

    // Fetch from Agent API
    // Note: Agent API returns the file stream.
    const apiUrl = `${API_URL}/v1/vaults/${id}/files/${filename}`;

    try {
        const res = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`
            }
        });

        if (!res.ok) {
            if (res.status === 404) return new NextResponse('File Not Found', { status: 404 });
            return new NextResponse('Upstream Error', { status: res.status });
        }

        // Pipe the body
        // Next.js (App Router) allows returning the response directly if it's a stream

        const headers = new Headers();
        headers.set('Content-Type', res.headers.get('Content-Type') || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);

        return new NextResponse(res.body, {
            status: 200,
            headers
        });

    } catch (err) {
        console.error("Proxy Error:", err);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
