
import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

export async function GET(request, { params }) {
    const { id, filename: filenameParam } = params;
    const filename = Array.isArray(filenameParam) ? filenameParam.join('/') : filenameParam;
    const { DEEDEE_API_TOKEN } = process.env;

    if (!DEEDEE_API_TOKEN) {
        return new NextResponse('Configuration Error: Token Missing', { status: 500 });
    }

    // Fetch from Agent API
    const url = new URL(`${API_URL}/v1/vaults/${id}/files/${encodeURIComponent(filename)}`);
    const inline = request.nextUrl.searchParams.get('inline');
    if (inline === 'true') {
        url.searchParams.set('inline', 'true');
    }

    try {
        const res = await fetch(url.toString(), {
            headers: {
                'Authorization': `Bearer ${DEEDEE_API_TOKEN}`
            }
        });

        if (!res.ok) {
            if (res.status === 404) return new NextResponse('File Not Found', { status: 404 });
            return new NextResponse('Upstream Error', { status: res.status });
        }

        // Pipe the body
        const headers = new Headers();
        const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
        headers.set('Content-Type', contentType);

        if (inline === 'true') {
            headers.set('Content-Disposition', 'inline');
        } else {
            headers.set('Content-Disposition', `attachment; filename="${filename}"`);
        }

        return new NextResponse(res.body, {
            status: 200,
            headers
        });

    } catch (err) {
        console.error("Proxy Error:", err);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
