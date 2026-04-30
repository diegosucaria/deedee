import { NextResponse } from 'next/server';
import { readStore } from '@/lib/auth/store';
import { verifyPassword } from '@/lib/auth/password';
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
        return NextResponse.json(
            { error: 'Too many attempts. Try again later.' },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
        );
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { password } = body || {};
    if (typeof password !== 'string' || !password) {
        return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    const store = readStore();
    if (!store.password) {
        return NextResponse.json({ error: 'No password configured. Run `npm run auth:init` or set LOGIN_PASSWORD.' }, { status: 503 });
    }

    const ok = await verifyPassword(password, store.password);
    if (!ok) {
        return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    resetRateLimit(ip);
    const { token, ttl } = await issueSession({ extra: { method: 'password' } });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(buildSetCookie(token, ttl));
    return res;
}
