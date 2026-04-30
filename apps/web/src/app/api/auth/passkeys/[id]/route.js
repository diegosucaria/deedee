import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { renamePasskey, deletePasskey } from '@/lib/auth/webauthn';

export async function PATCH(request, { params }) {
    const { session, response } = await requireSession();
    if (!session) return response;
    const { id } = await params;
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
    const ok = renamePasskey(id, body?.name);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}

export async function DELETE(request, { params }) {
    const { session, response } = await requireSession();
    if (!session) return response;
    const { id } = await params;
    const removed = deletePasskey(id);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
}
