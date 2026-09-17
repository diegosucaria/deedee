import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import PageShell from '@/components/PageShell';
import ApprovalsSettings from '@/components/ApprovalsSettings';

export const dynamic = 'force-dynamic';

/**
 * Approvals queue on its own page. The same card as Settings > Approvals,
 * without the rules form: decide here, set the expiry times and the
 * deny-list over there.
 */
export default function ApprovalsPage() {
    return (
        <PageShell
            icon={ShieldCheck}
            title="Approvals"
            subtitle="Tool calls waiting for your yes or no. Decisions made on any channel show up here at once."
        >
            <ApprovalsSettings />
            <p className="mt-4 text-xs text-zinc-500">
                Expiry times and the deny-list live in{' '}
                <Link href="/settings?tab=approvals" className="text-indigo-400 hover:text-indigo-300">
                    Settings &gt; Approvals
                </Link>.
            </p>
        </PageShell>
    );
}
