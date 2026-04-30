import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/guard';
import { passkeysEnabled } from '@/lib/auth/tls';
import { readStore } from '@/lib/auth/store';
import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }) {
    const session = await getSession();
    const params = await searchParams;
    const next = typeof params?.next === 'string' && params.next.startsWith('/') ? params.next : '/';
    if (session) redirect(next);

    const store = readStore();
    return (
        <div className="min-h-dvh flex items-center justify-center bg-black px-6 py-10 text-zinc-200">
            <LoginForm
                next={next}
                passkeysEnabled={passkeysEnabled()}
                hasPasskeys={(store.passkeys || []).length > 0}
                hasPassword={!!store.password}
            />
        </div>
    );
}
