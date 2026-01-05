'use client';

import { useFormState } from 'react-dom';
import { cancelTask, createTask } from '@/app/actions';
import { Trash2, Clock, PlayCircle, Plus, Pencil, Save, X } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

const initialState = { success: false, error: null };

const PRESETS = {
    'custom': { label: 'Custom Schedule', cron: '' },
    'every_minute': { label: 'Every Minute (Test)', cron: '*/1 * * * *' },
    'hourly': { label: 'Hourly', cron: '0 * * * *' },
    'daily_morning': { label: 'Daily Morning (8 AM)', cron: '0 8 * * *' },
    'daily_evening': { label: 'Daily Evening (8 PM)', cron: '0 20 * * *' },
};

export default function TaskList({ tasks }) {
    const [state, formAction] = useFormState(createTask, initialState);
    const [editingTask, setEditingTask] = useState(null);
    const [scheduleType, setScheduleType] = useState('custom');
    const [customCron, setCustomCron] = useState('');
    const formRef = useRef(null);

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
        formRef.current?.reset();
    };

    return (
        <div className="space-y-8">
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

                <form action={async (formData) => {
                    await formAction(formData);
                    // Reset edit state on submit (optimistic)
                    setEditingTask(null);
                    setCustomCron('');
                    setScheduleType('custom');
                    formRef.current?.reset();
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

                        {/* Hidden input for form submission if matched, or visible input if custom */}
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

            {/* List */}
            <div className="grid gap-4 md:grid-cols-2">
                {tasks.length === 0 ? (
                    <div className="col-span-full text-zinc-500 text-center py-12 bg-zinc-900/30 rounded-2xl border border-zinc-800/50 border-dashed">
                        No scheduled tasks active.
                    </div>
                ) : (
                    tasks.map((job) => (
                        <div
                            key={job.name}
                            className={`group relative flex flex-col gap-4 rounded-xl border p-5 transition-all backdrop-blur-sm ${job.isSystem
                                ? 'bg-indigo-950/20 border-indigo-900/50 hover:bg-indigo-900/20'
                                : 'bg-zinc-900/80 border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 hover:shadow-xl hover:shadow-indigo-500/5'}`}
                        >
                            <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                <span className="font-semibold text-white tracking-wide flex items-center gap-2">
                                    <Clock className={`h-4 w-4 ${job.isSystem ? 'text-indigo-400' : 'text-zinc-500'}`} />
                                    {job.name}
                                    {job.isSystem && (
                                        <span className="text-[10px] uppercase font-bold bg-indigo-500 text-white px-1.5 py-0.5 rounded tracking-wider">
                                            System
                                        </span>
                                    )}
                                </span>
                                <div className="flex items-center gap-2">
                                    <div className="font-mono text-xs text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
                                        {job.cron}
                                    </div>
                                    {!job.isSystem && (
                                        <button
                                            onClick={() => handleEdit(job)}
                                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-md transition-colors"
                                            title="Edit"
                                            aria-label="Edit task"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="text-sm text-zinc-300 leading-relaxed font-mono bg-black/20 p-3 rounded-lg border border-white/5 line-clamp-3">
                                {job.task || <em className="text-zinc-600">No instruction visible</em>}
                            </div>

                            <div className="flex items-center justify-between text-xs text-zinc-500 mt-auto pt-2">
                                <span className="flex items-center gap-1.5 ">
                                    <PlayCircle className="h-3.5 w-3.5 text-emerald-500/80" />
                                    Next: {new Date(job.nextInvocation).toLocaleString()}
                                </span>

                                {!job.isSystem && (
                                    <button
                                        onClick={() => {
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
        </div>
    );
}
