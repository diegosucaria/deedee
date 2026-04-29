import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { buildRegistrationOptions } from '@/lib/auth/webauthn';

export async function POST() {
    const { session, response } = await requireSession();
    if (!session) return response;
    try {
        const options = await buildRegistrationOptions();
        return NextResponse.json(options);
    } catch (err) {
        const status = err.status || 500;
        return NextResponse.json({ error: err.message }, { status });
    }
}
