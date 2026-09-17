import { Suspense } from 'react';
import Link from 'next/link';
import { ShieldHalf } from 'lucide-react';
import PageShell from '@/components/PageShell';
import GuardianClient from '@/components/guardian/GuardianClient';

export const dynamic = 'force-dynamic';

/**
 * The approval guardian: what it decided and why, how often it asks, and
 * the policy it follows. Pending calls stay on the Approvals page.
 */
export default function GuardianPage() {
    return (
        <PageShell
            icon={ShieldHalf}
            title="Guardian"
            subtitle="The model that allows, denies or asks you about paused tool calls."
        >
            <Suspense fallback={<div className="p-4 text-zinc-500 animate-pulse">Loading...</div>}>
                <GuardianClient />
            </Suspense>
            <p className="mt-6 text-xs text-zinc-500">
                Calls waiting for you are on{' '}
                <Link href="/approvals" className="text-indigo-400 hover:text-indigo-300">Approvals</Link>.
            </p>
        </PageShell>
    );
}
