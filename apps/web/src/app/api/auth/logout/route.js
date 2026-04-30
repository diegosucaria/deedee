import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, verifySession, revokeJti, buildClearCookie } from '@/lib/auth/session';

export async function POST() {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
        const payload = await verifySession(token);
        if (payload?.jti) revokeJti(payload.jti, payload.exp);
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(buildClearCookie());
    return res;
}
