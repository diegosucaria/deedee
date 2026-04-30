import { NextResponse } from 'next/server';
import { finishAuthentication } from '@/lib/auth/webauthn';
import { issueSession, buildSetCookie } from '@/lib/auth/session';
import { rateLimitLogin, resetRateLimit } from '@/lib/auth/rate-limit';

function clientIp(req) {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
    return req.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request) {
    const ip = clientIp(request);
    const limit = rateLimitLogin(ip);
    if (!limit.allowed) {
        return NextResponse.json({ error: 'Too many attempts' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } });
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }

    try {
        const credential = await finishAuthentication(body);
        resetRateLimit(ip);
        const { token, ttl } = await issueSession({ extra: { method: 'passkey', credentialId: credential.id } });
        const res = NextResponse.json({ ok: true });
        res.cookies.set(buildSetCookie(token, ttl));
        return res;
    } catch (err) {
        const status = err.status || 401;
        return NextResponse.json({ error: err.message }, { status });
    }
}
