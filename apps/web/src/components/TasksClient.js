'use client';

import { useCallback } from 'react';
import { RefreshCw, ClipboardList } from 'lucide-react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import JobLogsTable from '@/components/JobLogsTable';
import ActiveJobsTable from '@/components/ActiveJobsTable';
import WatchersTable from '@/components/WatchersTable';
import SubAgentsTable from '@/components/SubAgentsTable';

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
        <div className="space-y-8">
            <h1 className="text-3xl font-bold mb-8 flex items-center gap-3 text-white">
                <ClipboardList className="h-8 w-8 text-indigo-400" />
                Scheduler & Tasks
            </h1>

            {/* Tabs */}
            <div className="flex items-center gap-4 border-b border-zinc-800 pb-2 overflow-x-auto">
                <button
                    onClick={() => setActiveTab('active')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'active' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Active Scheduled Jobs
                    {activeTab === 'active' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('watchers')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'watchers' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Message Watchers
                    {activeTab === 'watchers' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('subagents')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'subagents' ? 'text-violet-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Sub-Agents
                    {activeTab === 'subagents' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-violet-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('system')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'system' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    System Jobs
                    {activeTab === 'system' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('manage')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'manage' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Job History
                    {activeTab === 'manage' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>

                <div className="ml-auto">
                    <button onClick={() => router.refresh()} className="p-2 text-zinc-500 hover:text-white transition-colors" title="Refresh">
                        <RefreshCw className="h-4 w-4" />
                    </button>
                </div>
            </div>

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
