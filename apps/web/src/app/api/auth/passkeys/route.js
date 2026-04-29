import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/guard';
import { listPasskeys } from '@/lib/auth/webauthn';

export async function GET() {
    const { session, response } = await requireSession();
    if (!session) return response;
    return NextResponse.json({ passkeys: listPasskeys() });
}
