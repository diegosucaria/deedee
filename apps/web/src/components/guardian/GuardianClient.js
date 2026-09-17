'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import ScrollableTabs from '@/components/ScrollableTabs';
import GuardianHistory from './GuardianHistory';
import GuardianStats from './GuardianStats';
import GuardianPolicy from './GuardianPolicy';

const TABS = [
    { id: 'history', label: 'History' },
    { id: 'stats', label: 'Stats' },
    { id: 'policy', label: 'Policy' },
];

export default function GuardianClient() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const tab = TABS.some(t => t.id === searchParams.get('tab')) ? searchParams.get('tab') : 'history';

    const setTab = useCallback((id) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', id);
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, pathname, router]);

    return (
        <div className="space-y-6">
            <ScrollableTabs tabs={TABS} activeTab={tab} onChange={setTab} variant="underline" />
            {tab === 'history' && <GuardianHistory />}
            {tab === 'stats' && <GuardianStats />}
            {tab === 'policy' && <GuardianPolicy />}
        </div>
    );
}
