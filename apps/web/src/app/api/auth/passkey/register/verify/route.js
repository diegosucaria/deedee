import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { finishRegistration } from '@/lib/auth/webauthn';

export async function POST(request) {
    const { session, response } = await requireSession();
    if (!session) return response;
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    try {
        const record = await finishRegistration(body.attestation, body.name);
        return NextResponse.json({
            ok: true,
            passkey: { id: record.id, name: record.name, deviceType: record.deviceType, backedUp: record.backedUp, created: record.created },
        });
    } catch (err) {
        const status = err.status || 400;
        return NextResponse.json({ error: err.message }, { status });
    }
}
