import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/guard';
import { passkeysEnabled } from '@/lib/auth/tls';
import { readStore } from '@/lib/auth/store';

export async function GET() {
    const session = await getSession();
    const store = readStore();
    return NextResponse.json({
        authenticated: !!session,
        method: session?.method || null,
        passwordSet: !!store.password,
        passkeysEnabled: passkeysEnabled(),
        passkeyCount: (store.passkeys || []).length,
    });
}
