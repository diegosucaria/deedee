import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, verifySession, revokeSession, buildClearCookie } from '@/lib/auth/session';

export async function POST() {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
        const payload = await verifySession(token);
        // By session, not by token: a refresh mints a new token id.
        if (payload) revokeSession(payload);
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(buildClearCookie());
    return res;
}
