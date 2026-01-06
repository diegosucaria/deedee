'use client';

import { useFormState } from 'react-dom';
import { createTask } from '@/app/actions';
import { Plus, Save, X, CalendarOff } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const initialState = { success: false, error: null };

const PRESETS = {
    'custom': { label: 'Custom Schedule', cron: '' },
    'every_minute': { label: 'Every Minute (Test)', cron: '*/1 * * * *' },
    'hourly': { label: 'Hourly', cron: '0 * * * *' },
    'daily_morning': { label: 'Daily Morning (8 AM)', cron: '0 8 * * *' },
    'daily_evening': { label: 'Daily Evening (8 PM)', cron: '0 20 * * *' },
    'one_time': { label: 'One-Time Task', cron: '' },
};

export default function CreateTaskForm({ onTaskCreated }) {
    const router = useRouter();
    const [state, formAction] = useFormState(createTask, initialState);
    const [scheduleType, setScheduleType] = useState('custom');
    const [customCron, setCustomCron] = useState('');
    const formRef = useRef(null);

    // Reset form on success if needed
    useEffect(() => {
        if (state?.success) {
            formRef.current?.reset();
            setCustomCron('');
            setScheduleType('custom');
            if (onTaskCreated) onTaskCreated();
        }
    }, [state, onTaskCreated]);

    return (
        <div className="p-6 rounded-2xl border bg-zinc-900/50 border-zinc-800">
            <h3 className="text-lg font-medium text-white flex items-center gap-2 mb-4">
                <Plus className="h-5 w-5 text-indigo-400" />
                New Schedule
            </h3>

            <form ref={formRef} action={async (formData) => {
                // Timezone Fix: Convert local input time to properly formatted ISO string (UTC)
                const expiresLocal = formData.get('expiresAt');
                if (expiresLocal) {
                    const dateObj = new Date(expiresLocal);
                    if (!isNaN(dateObj.getTime())) {
                        formData.set('expiresAt', dateObj.toISOString());
                    }
                }

                // Handle One-Time Task Date vs Cron
                if (scheduleType === 'one_time') {
                    const executionLocal = customCron;
                    if (executionLocal) {
                        const dateObj = new Date(executionLocal);
                        if (!isNaN(dateObj.getTime())) {
                            formData.set('cron', dateObj.toISOString());
                            formData.set('isOneOff', 'true');
                        }
                    }
                }

                await formAction(formData);
                // Refresh logic usually handled by action revalidate
            }} className="grid md:grid-cols-2 gap-4">
                <input
                    type="text"
                    name="name"
                    placeholder="Job Name (e.g. daily_briefing)"
                    required
                    className="rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
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
                        {scheduleType === 'one_time' ? (
                            <input
                                type="datetime-local"
                                name="cron_display"
                                required
                                value={customCron}
                                onChange={(e) => setCustomCron(e.target.value)}
                                className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                            />
                        ) : (scheduleType === 'custom') ? (
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
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none"
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Expiration (Optional)</label>
                    <input
                        type="datetime-local"
                        name="expiresAt"
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                    />
                </div>

                <button
                    type="submit"
                    className="md:col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
                >
                    <Plus className="h-4 w-4" />
                    Schedule Task
                </button>
            </form>
            {state?.error && (
                <p className="mt-4 text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20 animate-pulse">
                    {state.error}
                </p>
            )}
        </div>
    );
}
