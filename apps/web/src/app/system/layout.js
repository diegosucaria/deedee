'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Activity, Bell, Clock, Terminal } from 'lucide-react';
import PageShell from '@/components/PageShell';
import ScrollableTabs from '@/components/ScrollableTabs';

export default function SystemLayout({ children }) {
    const pathname = usePathname();
    const router = useRouter();

    const tabs = [
        { id: '/system/stats', label: 'Stats', icon: Activity },
        { id: '/system/history', label: 'History', icon: Clock },
        { id: '/system/notifications', label: 'Notifications', icon: Bell },
        { id: '/system/logs', label: 'Logs', icon: Terminal },
    ];

    const activeTab = tabs.find(t => pathname.startsWith(t.id))?.id || '/system/stats';

    return (
        <PageShell icon={Terminal} title="System Internals" subtitle="Monitor and debug the agent's brain and operations.">
            <ScrollableTabs
                tabs={tabs}
                activeTab={activeTab}
                onChange={(id) => router.push(id)}
                variant="pill"
                className="mb-8"
            />
            {children}
        </PageShell>
    );
}
