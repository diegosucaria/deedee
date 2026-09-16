import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { readStore, writeStore } from '@/lib/auth/store';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { rateLimitLogin, recordLoginFailure, clientIp } from '@/lib/auth/rate-limit';

export async function POST(request) {
    const { session, response } = await requireSession();
    if (!session) return response;

    // Re-use the login rate limit so a stolen session can't brute-force
    // the current password to clear the second-factor check.
    const limit = rateLimitLogin(clientIp(request));
    if (!limit.allowed) {
        return NextResponse.json(
            { error: 'Too many attempts. Try again later.' },
            { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
        );
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const { currentPassword, newPassword } = body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return NextResponse.json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }
    if (typeof currentPassword !== 'string' || !currentPassword) {
        return NextResponse.json({ error: 'Current password required' }, { status: 400 });
    }

    const store = readStore();
    if (!store.password) {
        return NextResponse.json({ error: 'No password configured' }, { status: 503 });
    }
    const ok = await verifyPassword(currentPassword, store.password);
    if (!ok) {
        recordLoginFailure();
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });
    }

    const record = await hashPassword(newPassword);
    store.password = record;
    writeStore(store);
    return NextResponse.json({ ok: true });
}
