import { Suspense } from 'react';
import PageShell from '@/components/PageShell';
import { ShieldCheck } from 'lucide-react';
import SecurityClient from './SecurityClient';
import { passkeysEnabled } from '@/lib/auth/tls';

export const dynamic = 'force-dynamic';

export default function SecurityPage() {
    return (
        <PageShell icon={ShieldCheck} title="Security" subtitle="Manage how you sign in to DeeDee.">
            <Suspense fallback={<div className="p-6 text-zinc-500">Loading…</div>}>
                <SecurityClient passkeysEnabled={passkeysEnabled()} />
            </Suspense>
        </PageShell>
    );
}
