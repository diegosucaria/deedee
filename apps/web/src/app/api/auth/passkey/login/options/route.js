import { NextResponse } from 'next/server';
import { buildAuthenticationOptions } from '@/lib/auth/webauthn';
import { rateLimitLogin } from '@/lib/auth/rate-limit';

function clientIp(req) {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    return req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request) {
    const limit = rateLimitLogin(clientIp(request));
    if (!limit.allowed) {
        return NextResponse.json({ error: 'Too many attempts' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
    }
    try {
        const options = await buildAuthenticationOptions();
        return NextResponse.json(options);
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ error: err.message }, { status });
    }
}
