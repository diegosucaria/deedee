'use client';

import { useState } from 'react';
import { RefreshCw, ClipboardList, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import CreateTaskForm from '@/components/CreateTaskForm';
import JobLogsTable from '@/components/JobLogsTable';
import ActiveJobsTable from '@/components/ActiveJobsTable';
import WatchersTable from '@/components/WatchersTable';

export default function TasksClient() {
    const router = useRouter();
    const [activeTab, setActiveTab] = useState('active'); // active | manage

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
                    onClick={() => setActiveTab('manage')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-2 ${activeTab === 'manage' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Execution Logs
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
                    <ActiveJobsTable />
                </div>
            )}

            {activeTab === 'watchers' && (
                <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                    <WatchersTable />
                </div>
            )}
        </div>
    );
}
