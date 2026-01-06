'use client';

import { useState, useEffect } from 'react';
import { getTasks, runTask, cancelTask } from '@/app/actions';
import { Clock, Play, Trash2, RefreshCw, CalendarOff } from 'lucide-react';

export default function ActiveJobsTable() {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);

    const loadJobs = async () => {
        setLoading(true);
        try {
            const data = await getTasks();
            setJobs(data.jobs || []);
        } catch (err) {
            console.error('Failed to load tasks:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadJobs();
        const interval = setInterval(loadJobs, 15000); // Poll every 15s
        return () => clearInterval(interval);
    }, []);

    const handleRun = async (name) => {
        setActionLoading(name);
        try {
            await runTask(name);
            // Don't reload immediately, let the log table update eventually or just notify success
        } catch (err) {
            console.error('Failed to run job:', err);
        } finally {
            setActionLoading(null);
        }
    };

    const handleCancel = async (name) => {
        if (!confirm(`Are you sure you want to cancel job '${name}'?`)) return;
        setActionLoading(name);
        try {
            await cancelTask(name);
            await loadJobs();
        } catch (err) {
            console.error('Failed to cancel job:', err);
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-sky-400" />
                    Active Scheduled Jobs
                </h3>
                <button
                    onClick={loadJobs}
                    className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-6 py-3">Job Name</th>
                            <th className="px-6 py-3">Schedule / Type</th>
                            <th className="px-6 py-3">Task</th>
                            <th className="px-6 py-3">Next Run</th>
                            <th className="px-6 py-3">Expires At</th>
                            <th className="px-6 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {jobs.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-8 text-center text-zinc-500">
                                    No active jobs found.
                                </td>
                            </tr>
                        ) : (
                            jobs.map((job) => (
                                <tr key={job.name} className="hover:bg-zinc-800/50 transition-colors">
                                    <td className="px-6 py-4 font-mono text-zinc-300">
                                        {job.name}
                                        {job.isSystem && (
                                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-bold bg-zinc-800 text-zinc-500">
                                                System
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-zinc-400">
                                        <div className="flex flex-col">
                                            {job.isOneOff ? (
                                                <span className="text-amber-400 text-xs font-bold uppercase">One-Off</span>
                                            ) : (
                                                <span className="text-indigo-400 text-xs font-bold uppercase">Recurring</span>
                                            )}
                                            <span className="font-mono text-xs mt-1">{job.cron}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 max-w-xs">
                                        <div className="line-clamp-2 text-zinc-400 text-xs">
                                            {job.task || '-'}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-zinc-400 whitespace-nowrap">
                                        {job.nextInvocation ? new Date(job.nextInvocation).toLocaleString() : '-'}
                                    </td>
                                    <td className="px-6 py-4 text-zinc-400 whitespace-nowrap">
                                        {job.expiresAt ? (
                                            <span className="text-orange-400 flex items-center gap-1">
                                                <CalendarOff className="w-3 h-3" />
                                                {new Date(job.expiresAt).toLocaleString()}
                                            </span>
                                        ) : (
                                            <span className="text-zinc-600">-</span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => handleRun(job.name)}
                                                disabled={actionLoading === job.name}
                                                className="p-1.5 hover:bg-zinc-700/50 rounded text-emerald-400 transition-colors disabled:opacity-50"
                                                title="Run Now"
                                            >
                                                <Play className="w-4 h-4" />
                                            </button>
                                            {!job.isSystem && (
                                                <button
                                                    onClick={() => handleCancel(job.name)}
                                                    disabled={actionLoading === job.name}
                                                    className="p-1.5 hover:bg-zinc-700/50 rounded text-red-400 transition-colors disabled:opacity-50"
                                                    title="Cancel Job"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
