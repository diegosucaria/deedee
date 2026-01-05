'use client';

import { useFormState } from 'react-dom';
import { cancelTask, createTask, runTask } from '@/app/actions';
import { Trash2, Clock, PlayCircle, Plus, Pencil, Save, X, RefreshCw, CalendarOff } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const initialState = { success: false, error: null };

const PRESETS = {
    'custom': { label: 'Custom Schedule', cron: '' },
    'every_minute': { label: 'Every Minute (Test)', cron: '*/1 * * * *' },
    'hourly': { label: 'Hourly', cron: '0 * * * *' },
    'daily_morning': { label: 'Daily Morning (8 AM)', cron: '0 8 * * *' },
    'daily_evening': { label: 'Daily Evening (8 PM)', cron: '0 20 * * *' },
};

export default function TaskList({ tasks }) {
    const router = useRouter();
    const [state, formAction] = useFormState(createTask, initialState);
    const [editingTask, setEditingTask] = useState(null);
    const [scheduleType, setScheduleType] = useState('custom');
    const [customCron, setCustomCron] = useState('');
    const formRef = useRef(null);
    const internalFormRef = useRef(null);

    // Auto-refresh every 5 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            router.refresh();
        }, 5000);
        return () => clearInterval(interval);
    }, [router]);

    // Effect to detect preset when editing or creating
    useEffect(() => {
        const currentCron = editingTask ? editingTask.cron : customCron;

        // Find if it matches a preset
        const matchingPreset = Object.entries(PRESETS).find(([key, preset]) =>
            key !== 'custom' && preset.cron === currentCron
        );

        if (matchingPreset) {
            setScheduleType(matchingPreset[0]);
        } else {
            setScheduleType('custom');
        }

        if (editingTask) {
            setCustomCron(editingTask.cron);
        }
    }, [editingTask]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleEdit = (job) => {
        setEditingTask(job);
        // Scroll to form
        formRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const handleCancelEdit = () => {
        setEditingTask(null);
        setScheduleType('custom');
        setCustomCron('');
        setCustomCron('');
        internalFormRef.current?.reset();
    };

    const [activeTab, setActiveTab] = useState('recurring'); // recurring | oneoff | system

    // Filter jobs
    const systemTasks = tasks.filter(t => t.isSystem); // System jobs
    const reminders = tasks.filter(t => t.isOneOff && !t.isSystem); // Reminders
    const recurringTasks = tasks.filter(t => !t.isOneOff && !t.isSystem); // User schedules

    const handleRunNow = async (name) => {
        // Optimistic UI could be added here, but for now just run
        await runTask(name);
        // Refresh immediately to show update if any
        router.refresh();
    };

    const renderBadge = (count) => {
        if (count === 0) return null;
        return (
            <span className="ml-2 px-1.5 py-0.5 text-[10px] font-bold bg-indigo-500/20 text-indigo-300 rounded-full border border-indigo-500/30">
                {count}
            </span>
        );
    };

    return (
        <div className="space-y-8">
            {/* Tabs */}
            <div className="flex items-center gap-4 border-b border-zinc-800 pb-2 overflow-x-auto">
                <button
                    onClick={() => setActiveTab('recurring')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center ${activeTab === 'recurring' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Recurring Schedules
                    {renderBadge(recurringTasks.length)}
                    {activeTab === 'recurring' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('oneoff')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center ${activeTab === 'oneoff' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    Reminders & One-Offs
                    {renderBadge(reminders.length)}
                    {activeTab === 'oneoff' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>
                <button
                    onClick={() => setActiveTab('system')}
                    className={`pb-2 px-1 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center ${activeTab === 'system' ? 'text-indigo-400' : 'text-zinc-500 hover:text-zinc-300'}`}
                >
                    System Jobs
                    {renderBadge(systemTasks.length)}
                    {activeTab === 'system' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-indigo-500" />}
                </button>

                <div className="ml-auto">
                    <button onClick={() => router.refresh()} className="p-2 text-zinc-500 hover:text-white transition-colors" title="Refresh">
                        <RefreshCw className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {activeTab === 'recurring' && (
                <>
                    {/* Add/Edit Task Form */}
                    <div ref={formRef} className={`p-6 rounded-2xl border transition-all duration-300 ${editingTask ? 'bg-indigo-900/10 border-indigo-500/30 shadow-[0_0_30px_rgba(99,102,241,0.1)]' : 'bg-zinc-900/50 border-zinc-800'}`}>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-medium text-white flex items-center gap-2">
                                {editingTask ? <Pencil className="h-5 w-5 text-indigo-400" /> : <Plus className="h-5 w-5 text-indigo-400" />}
                                {editingTask ? 'Edit Schedule' : 'New Schedule'}
                            </h3>
                            {editingTask && (
                                <button onClick={handleCancelEdit} className="text-sm text-zinc-400 hover:text-white flex items-center gap-1">
                                    <X className="h-4 w-4" /> Cancel
                                </button>
                            )}
                        </div>

                        <form ref={internalFormRef} action={async (formData) => {
                            await formAction(formData);
                            setEditingTask(null);
                            setCustomCron('');
                            setScheduleType('custom');
                            internalFormRef.current?.reset();
                            // Refresh logic handled by revalidatePath in action
                        }} className="grid md:grid-cols-2 gap-4">
                            <input
                                type="text"
                                name="name"
                                placeholder="Job Name (e.g. daily_briefing)"
                                required
                                readOnly={!!editingTask}
                                defaultValue={editingTask?.name || ''}
                                className={`rounded-lg bg-black border px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${editingTask ? 'border-indigo-500/20 text-zinc-400 cursor-not-allowed' : 'border-zinc-800'}`}
                            />

                            {/* Frequency Selector */}
                            <div className="flex gap-2">
                                <select
                                    value={scheduleType}
                                    onChange={(e) => {
                                        const type = e.target.value;
                                        setScheduleType(type);
                                        if (type !== 'custom') {
                                            setCustomCron(PRESETS[type].cron);
                                        }
                                    }}
                                    className="rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm w-1/2"
                                >
                                    {Object.entries(PRESETS).map(([key, preset]) => (
                                        <option key={key} value={key}>{preset.label}</option>
                                    ))}
                                </select>

                                <div className="relative w-1/2">
                                    {(scheduleType === 'custom') ? (
                                        <input
                                            type="text"
                                            name="cron"
                                            placeholder="Cron (e.g. 0 8 * * *)"
                                            required
                                            value={customCron}
                                            onChange={(e) => setCustomCron(e.target.value)}
                                            className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                                        />
                                    ) : (
                                        <>
                                            <input type="hidden" name="cron" value={PRESETS[scheduleType].cron} />
                                            <div className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-zinc-400 font-mono text-sm cursor-not-allowed">
                                                {PRESETS[scheduleType].cron}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="md:col-span-2">
                                <textarea
                                    name="task"
                                    placeholder="Instruction (e.g. 'Summarize yesterday's logs')"
                                    required
                                    rows={2}
                                    defaultValue={editingTask?.task || ''}
                                    className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none"
                                />
                            </div>

                            <div className="md:col-span-2">
                                <label className="block text-xs text-zinc-500 mb-1 ml-1">Expiration (Optional)</label>
                                <input
                                    type="datetime-local"
                                    name="expiresAt"
                                    defaultValue={editingTask?.expiresAt ? new Date(editingTask.expiresAt).toISOString().slice(0, 16) : ''}
                                    className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                                />
                            </div>

                            <button
                                type="submit"
                                className="md:col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
                            >
                                {editingTask ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                                {editingTask ? 'Update Schedule' : 'Schedule Task'}
                            </button>
                        </form>
                        {state?.error && (
                            <p className="mt-4 text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20 animate-pulse">
                                {state.error}
                            </p>
                        )}
                    </div>

                    {/* Recurring List */}
                    <div className="grid gap-4 md:grid-cols-2">
                        {recurringTasks.length === 0 ? (
                            <div className="col-span-full text-zinc-500 text-center py-12 bg-zinc-900/30 rounded-2xl border border-zinc-800/50 border-dashed">
                                No recurring tasks active.
                            </div>
                        ) : (
                            recurringTasks.map((job) => (
                                <div
                                    key={job.name}
                                    className="group relative flex flex-col gap-4 rounded-xl border p-5 transition-all backdrop-blur-sm bg-zinc-900/80 border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 hover:shadow-xl hover:shadow-indigo-500/5"
                                >
                                    <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                        <span className="font-semibold text-white tracking-wide flex items-center gap-2">
                                            <Clock className="h-4 w-4 text-zinc-500" />
                                            {job.name}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <div className="font-mono text-xs text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
                                                {job.cron}
                                            </div>
                                            <button
                                                onClick={() => handleEdit(job)}
                                                className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                                                title="Edit"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>

                                    {job.expiresAt && (
                                        <div className="text-[10px] text-orange-400 bg-orange-400/10 px-2 py-1 -mt-2 rounded border border-orange-400/20 inline-flex items-center gap-1 self-start">
                                            <CalendarOff className="h-3 w-3" />
                                            Expires: {new Date(job.expiresAt).toLocaleString()}
                                        </div>
                                    )}

                                    <div className="text-sm text-zinc-300 leading-relaxed font-mono bg-black/20 p-3 rounded-lg border border-white/5 line-clamp-3">
                                        {job.task || <em className="text-zinc-600">No instruction visible</em>}
                                    </div>

                                    <div className="flex items-center justify-between text-xs text-zinc-500 mt-auto pt-2">
                                        <span className="flex items-center gap-1.5 ">
                                            <PlayCircle className="h-3.5 w-3.5 text-emerald-500/80" />
                                            Next: {new Date(job.nextInvocation).toLocaleString()}
                                        </span>

                                        <button
                                            onClick={() => handleRunNow(job.name)}
                                            className="text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 px-2 py-1 rounded transition-colors flex items-center gap-1"
                                            title="Run Now"
                                        >
                                            <PlayCircle className="h-3 w-3" /> Run
                                        </button>

                                        {!job.isSystem && (
                                            <button
                                                onClick={() => {
                                                    // Keep confirmation for delete as it is destructive
                                                    if (confirm(`Cancel schedule '${job.name}'?`)) cancelTask(job.name);
                                                }}
                                                className="text-zinc-500 hover:text-red-400 hover:bg-red-500/10 px-2 py-1 rounded transition-colors flex items-center gap-1"
                                            >
                                                <Trash2 className="h-3 w-3" /> Cancel
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}

            {activeTab === 'oneoff' && (
                <div className="grid gap-4">
                    {reminders.length === 0 ? (
                        <div className="col-span-full text-zinc-500 text-center py-12 bg-zinc-900/30 rounded-2xl border border-zinc-800/50 border-dashed">
                            No active reminders. Ask the agent to "Remind me to..."
                        </div>
                    ) : (
                        reminders.sort((a, b) => new Date(a.nextInvocation) - new Date(b.nextInvocation)).map((job) => (
                            <div key={job.name} className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-all hover:bg-zinc-800 hover:border-zinc-700">
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
                                    <Clock className="h-6 w-6" />
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <h4 className="text-base font-medium text-white truncate">
                                            {job.task.replace('Reminder: ', '')}
                                        </h4>
                                        {new Date(job.nextInvocation) < new Date(Date.now() + 24 * 60 * 60 * 1000) && (
                                            <span className="text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                                Due Soon
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-sm text-zinc-400 flex items-center gap-2">
                                        <span>Due:</span>
                                        <span className="text-indigo-400 font-medium">
                                            {new Date(job.nextInvocation).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                        </span>
                                        <span className="text-zinc-600 mx-1">•</span>
                                        <span className="text-zinc-500 text-xs font-mono">{job.name}</span>
                                        {job.expiresAt && (
                                            <>
                                                <span className="text-zinc-600 mx-1">•</span>
                                                <span className="text-orange-400 text-xs flex items-center gap-1">
                                                    <CalendarOff className="h-3 w-3" />
                                                    Expires: {new Date(job.expiresAt).toLocaleString()}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                <button
                                    onClick={() => handleRunNow(job.name)}
                                    className="p-2 text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                                    title="Run Now"
                                >
                                    <PlayCircle className="h-5 w-5" />
                                </button>

                                <button
                                    onClick={() => {
                                        if (confirm(`Delete reminder?`)) cancelTask(job.name);
                                    }}
                                    className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                    title="Delete Reminder"
                                >
                                    <Trash2 className="h-5 w-5" />
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {activeTab === 'system' && (
                <div className="grid gap-4 md:grid-cols-2">
                    {systemTasks.length === 0 ? (
                        <div className="col-span-full text-zinc-500 text-center py-12">
                            No system jobs found.
                        </div>
                    ) : (
                        systemTasks.map((job) => (
                            <div
                                key={job.name}
                                className="group relative flex flex-col gap-4 rounded-xl border p-5 transition-all backdrop-blur-sm bg-indigo-950/20 border-indigo-900/50 hover:bg-indigo-900/20"
                            >
                                <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                    <span className="font-semibold text-white tracking-wide flex items-center gap-2">
                                        <Clock className="h-4 w-4 text-indigo-400" />
                                        {job.name}
                                        <span className="text-[10px] uppercase font-bold bg-indigo-500 text-white px-1.5 py-0.5 rounded tracking-wider">
                                            System
                                        </span>
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <div className="font-mono text-xs text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
                                            {job.cron}
                                        </div>
                                    </div>
                                </div>

                                <div className="text-sm text-zinc-300 leading-relaxed font-mono bg-black/20 p-3 rounded-lg border border-white/5 line-clamp-3">
                                    {job.task || <em className="text-zinc-400">System maintenance task</em>}
                                </div>

                                <div className="flex items-center justify-between text-xs text-zinc-500 mt-auto pt-2">
                                    <span className="flex items-center gap-1.5 ">
                                        <PlayCircle className="h-3.5 w-3.5 text-emerald-500/80" />
                                        Next: {new Date(job.nextInvocation).toLocaleString()}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => handleRunNow(job.name)}
                                            className="text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 px-2 py-1 rounded transition-colors flex items-center gap-1"
                                            title="Run Now"
                                        >
                                            <PlayCircle className="h-3 w-3" /> Run
                                        </button>
                                        <span className="text-zinc-600 italic">Protected</span>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
