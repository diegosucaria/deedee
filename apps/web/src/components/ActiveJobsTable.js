'use client';

import { useState, useEffect } from 'react';
import { getTasks, runTask, cancelTask } from '@/app/actions';
import { Clock, Play, Trash2, RefreshCw, CalendarOff, Edit, Plus } from 'lucide-react';
import CreateTaskForm from './CreateTaskForm';
import cronstrue from 'cronstrue';

export default function ActiveJobsTable({ onViewHistory }) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [editingJob, setEditingJob] = useState(null);
    const [selectedNames, setSelectedNames] = useState(new Set());
    const [deleting, setDeleting] = useState(false);

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

    const toggleSelection = (name) => {
        const next = new Set(selectedNames);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        setSelectedNames(next);
    };

    const toggleAll = () => {
        if (selectedNames.size === jobs.length) {
            setSelectedNames(new Set());
        } else {
            setSelectedNames(new Set(jobs.map(j => j.name)));
        }
    };

    const handleRun = async (name) => {
        setActionLoading(name);
        try {
            await runTask(name);
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

    const handleBulkDelete = async () => {
        if (!confirm(`Are you sure you want to cancel ${selectedNames.size} jobs?`)) return;
        setDeleting(true);
        try {
            // Sequential for now, straightforward
            for (const name of selectedNames) {
                await cancelTask(name).catch(console.error);
            }
            setSelectedNames(new Set());
            await loadJobs();
        } finally {
            setDeleting(false);
        }
    };

    // Helper for relative time
    const getRelativeTime = (dateStr) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const diff = date - now;
        const diffSeconds = Math.round(diff / 1000);
        const diffMinutes = Math.round(diffSeconds / 60);
        const diffHours = Math.round(diffMinutes / 60);
        const diffDays = Math.round(diffHours / 24);

        const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });

        if (Math.abs(diffSeconds) < 60) return rtf.format(diffSeconds, 'second');
        if (Math.abs(diffMinutes) < 60) return rtf.format(diffMinutes, 'minute');
        if (Math.abs(diffHours) < 24) return rtf.format(diffHours, 'hour');
        return rtf.format(diffDays, 'day');
    };

    const getCronDescription = (cron) => {
        try {
            return cronstrue.toString(cron);
        } catch (e) {
            return '';
        }
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                        <Clock className="w-5 h-5 text-sky-400" />
                        Active Scheduled Jobs
                    </h3>
                    <button
                        onClick={onViewHistory}
                        className="text-xs text-indigo-400 hover:text-indigo-300 hover:bg-indigo-500/10 px-2 py-1 rounded transition-colors flex items-center gap-1"
                    >
                        <Clock className="w-3 h-3" />
                        View Past Tasks
                    </button>
                </div>

                <div className="flex gap-2">
                    {selectedNames.size > 0 && (
                        <button
                            onClick={handleBulkDelete}
                            disabled={deleting}
                            className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
                        >
                            <Trash2 className="w-4 h-4" />
                            Delete ({selectedNames.size})
                        </button>
                    )}
                    <button
                        onClick={() => setEditingJob({})}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        New Schedule
                    </button>
                    <button
                        onClick={loadJobs}
                        className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {editingJob && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditingJob(null)}>
                    <div className="w-full max-w-2xl" onClick={e => e.stopPropagation()}>
                        <CreateTaskForm
                            initialValues={editingJob.name ? editingJob : null}
                            onTaskCreated={() => {
                                setEditingJob(null);
                                loadJobs();
                            }}
                            onCancel={() => setEditingJob(null)}
                        />
                    </div>
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-4 py-3 w-[40px]">
                                <input
                                    type="checkbox"
                                    className="rounded border-zinc-700 bg-zinc-900"
                                    checked={jobs.length > 0 && selectedNames.size === jobs.length}
                                    onChange={toggleAll}
                                />
                            </th>
                            <th className="px-2 py-3">Job Name</th>
                            <th className="px-2 py-3">Schedule / Type</th>
                            <th className="px-2 py-3">Task</th>
                            <th className="px-2 py-3">Next Run</th>
                            <th className="px-2 py-3">Expires At</th>
                            <th className="px-3 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {jobs.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                                    No active jobs found.
                                </td>
                            </tr>
                        ) : (
                            jobs.map((job) => (
                                <tr key={job.name} className={`hover:bg-zinc-800/50 transition-colors group ${selectedNames.has(job.name) ? 'bg-indigo-500/5 hover:bg-indigo-500/10' : ''}`}>
                                    <td className="px-4 py-4">
                                        <input
                                            type="checkbox"
                                            className="rounded border-zinc-700 bg-zinc-900"
                                            checked={selectedNames.has(job.name)}
                                            onChange={() => toggleSelection(job.name)}
                                        />
                                    </td>
                                    <td className="px-4 py-4 font-mono text-zinc-300">
                                        {job.name}
                                        {job.isSystem && (
                                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-bold bg-zinc-800 text-zinc-500">
                                                System
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400">
                                        <div className="flex flex-col">
                                            {job.isOneOff ? (
                                                <span className="text-amber-400 text-xs font-bold uppercase">One-Off</span>
                                            ) : (
                                                <span className="text-indigo-400 text-xs font-bold uppercase">Recurring</span>
                                            )}
                                            <span className="font-mono text-xs mt-1">{job.cron}</span>
                                            {!job.isOneOff && (
                                                <span className="text-[10px] text-zinc-500 mt-0.5 max-w-[150px] leading-tight opacity-70">
                                                    {getCronDescription(job.cron)}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-4 max-w-xs">
                                        <div className="line-clamp-2 text-zinc-400 text-xs">
                                            {job.task || '-'}
                                        </div>
                                    </td>
                                    <td className="px-2 py-4 text-zinc-400 whitespace-nowrap">
                                        <div className="flex flex-col">
                                            <span>{job.nextInvocation ? new Date(job.nextInvocation).toLocaleString() : '-'}</span>
                                            {job.nextInvocation && (
                                                <span className="text-[10px] text-zinc-500 opacity-70">
                                                    {getRelativeTime(job.nextInvocation)}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400 whitespace-nowrap">
                                        {job.expiresAt ? (
                                            <div className="flex flex-col">
                                                <span className="text-orange-400 flex items-center gap-1">
                                                    <CalendarOff className="w-3 h-3" />
                                                    {new Date(job.expiresAt).toLocaleString()}
                                                </span>
                                                <span className="text-[10px] text-zinc-600 pl-4 opacity-70">
                                                    {getRelativeTime(job.expiresAt)}
                                                </span>
                                            </div>
                                        ) : (
                                            <span className="text-zinc-600">-</span>
                                        )}
                                    </td>
                                    <td className="px-3 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => handleRun(job.name)}
                                                disabled={actionLoading === job.name}
                                                className="p-1.5 hover:bg-zinc-700/50 rounded text-emerald-400 transition-colors disabled:opacity-50"
                                                title="Run Now"
                                            >
                                                <Play className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => setEditingJob(job)}
                                                disabled={actionLoading === job.name || job.isSystem}
                                                className="p-1.5 hover:bg-zinc-700/50 rounded text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                title={job.isSystem ? "Cannot edit system jobs" : "Edit Job"}
                                            >
                                                <Edit className="w-4 h-4" />
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
