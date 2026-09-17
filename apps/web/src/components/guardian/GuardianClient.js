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

/**
 * @param {{ paramName?: string }} props - which query key holds the sub-tab.
 *   Inside the Brain page `tab` already names the Brain tab, so the guardian
 *   sub-tab travels as `view`.
 */
export default function GuardianClient({ paramName = 'tab' }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const current = searchParams.get(paramName);
    const tab = TABS.some(t => t.id === current) ? current : 'history';

    const setTab = useCallback((id) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set(paramName, id);
        router.push(`${pathname}?${params.toString()}`);
    }, [searchParams, pathname, router, paramName]);

    return (
        <div className="space-y-6">
            <ScrollableTabs tabs={TABS} activeTab={tab} onChange={setTab} variant="underline" />
            {tab === 'history' && <GuardianHistory />}
            {tab === 'stats' && <GuardianStats />}
            {tab === 'policy' && <GuardianPolicy />}
        </div>
    );
}
