'use client';

import { useCallback } from 'react';
import { RefreshCw, ClipboardList } from 'lucide-react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import JobLogsTable from '@/components/JobLogsTable';
import ActiveJobsTable from '@/components/ActiveJobsTable';
import WatchersTable from '@/components/WatchersTable';
import SubAgentsTable from '@/components/SubAgentsTable';
import ScrollableTabs from '@/components/ScrollableTabs';

export default function TasksClient() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();

    const activeTab = searchParams.get('tab') || 'active';

    const setActiveTab = useCallback((tab) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', tab);
        router.push(pathname + '?' + params.toString());
    }, [searchParams, pathname, router]);

    return (
        <div className="space-y-6 md:space-y-8">
            <h1 className="text-2xl md:text-3xl font-bold mb-6 md:mb-8 flex items-center gap-3 text-white">
                <ClipboardList className="h-7 w-7 md:h-8 md:w-8 text-indigo-400" />
                Scheduler & Tasks
            </h1>

            {/* Tabs */}
            <ScrollableTabs
                tabs={[
                    { id: 'active', label: 'Active Scheduled Jobs' },
                    { id: 'watchers', label: 'Message Watchers' },
                    { id: 'subagents', label: 'Sub-Agents' },
                    { id: 'system', label: 'System Jobs' },
                    { id: 'manage', label: 'Job History' },
                ]}
                activeTab={activeTab}
                onChange={setActiveTab}
                variant="underline"
                trailing={
                    <button onClick={() => router.refresh()} className="p-2 text-zinc-500 hover:text-white transition-colors" title="Refresh">
                        <RefreshCw className="h-4 w-4" />
                    </button>
                }
            />

            {/* Tab Content */}
            {activeTab === 'manage' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <JobLogsTable />
                </div>
            )}

            {activeTab === 'active' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <ActiveJobsTable onViewHistory={() => setActiveTab('manage')} />
                </div>
            )}

            {activeTab === 'system' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <ActiveJobsTable onViewHistory={() => setActiveTab('manage')} systemOnly={true} />
                </div>
            )}

            {activeTab === 'watchers' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <WatchersTable />
                </div>
            )}

            {activeTab === 'subagents' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <SubAgentsTable />
                </div>
            )}
        </div>
    );
}
