'use client';

import { useFormState } from 'react-dom';
import { createTask, parseCron } from '@/app/actions';
import { Plus, Save, X, Sparkles, ChevronDown, ChevronUp, Loader2, Check } from 'lucide-react';
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

const MODEL_OPTIONS = [
    { value: 'auto', label: 'Auto (Router)' },
    { value: 'FLASH', label: 'Flash' },
    { value: 'LITE', label: 'Lite' },
    { value: 'PRO', label: 'Pro' },
];

export default function CreateTaskForm({ onTaskCreated, initialValues = null, onCancel = null }) {
    const router = useRouter();
    const [state, formAction] = useFormState(createTask, initialState);

    // Determine initial schedule type
    const getInitialScheduleType = () => {
        if (!initialValues) return 'custom';
        if (initialValues.isOneOff) return 'one_time';
        // Check if cron matches any preset
        const preset = Object.entries(PRESETS).find(([_, p]) => p.cron === initialValues.cron);
        return preset ? preset[0] : 'custom';
    };

    const [scheduleType, setScheduleType] = useState(getInitialScheduleType());
    const [model, setModel] = useState(initialValues?.model || 'auto');
    const [weekdaysOnly, setWeekdaysOnly] = useState(initialValues?.weekdaysOnly || false);
    const [daytimeOnly, setDaytimeOnly] = useState(initialValues?.daytimeOnly || false);

    // Fix: For one-off jobs, use nextInvocation as the time, properly formatted
    const toLocalISOString = (dateStr) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
        return localDate.toISOString().slice(0, 16);
    };

    const getInitialCron = () => {
        if (!initialValues) return '';
        if (initialValues.isOneOff && initialValues.nextInvocation) {
            try {
                return toLocalISOString(initialValues.nextInvocation);
            } catch (e) {
                return initialValues.cron || '';
            }
        }
        return initialValues.cron || '';
    };

    const [customCron, setCustomCron] = useState(getInitialCron());
    const [cronHelperOpen, setCronHelperOpen] = useState(false);
    const [cronHelperInput, setCronHelperInput] = useState('');
    const [cronHelperLoading, setCronHelperLoading] = useState(false);
    const [cronHelperResult, setCronHelperResult] = useState(null);
    const [cronHelperError, setCronHelperError] = useState(null);
    const formRef = useRef(null);

    // Reset form on success — useFormState triggers re-render with success state,
    // and the form reset must happen in response to that state change.
    useEffect(() => {
        if (state?.success) {
            if (!initialValues) {
                formRef.current?.reset();
                // eslint-disable-next-line react-hooks/set-state-in-effect -- form reset on useFormState success
                setCustomCron('');
                setScheduleType('custom');
                setModel('auto');
                setWeekdaysOnly(false);
                setDaytimeOnly(false);
                setCronHelperOpen(false);
                setCronHelperInput('');
                setCronHelperResult(null);
                setCronHelperError(null);
            }
            if (onTaskCreated) onTaskCreated();
        }
    }, [state, onTaskCreated, initialValues]);

    const isEditing = !!initialValues;
    const isOneOff = scheduleType === 'one_time';

    // Determine if the schedule has an explicit hour (daytime toggle not useful)
    const hasExplicitHour = ['daily_morning', 'daily_evening'].includes(scheduleType);

    const handleCronHelper = async () => {
        if (!cronHelperInput.trim() || cronHelperLoading) return;
        setCronHelperLoading(true);
        setCronHelperResult(null);
        setCronHelperError(null);
        try {
            const result = await parseCron(cronHelperInput);
            if (result.error) {
                setCronHelperError(result.error);
            } else {
                setCronHelperResult(result);
            }
        } catch {
            setCronHelperError('Failed to parse schedule');
        } finally {
            setCronHelperLoading(false);
        }
    };

    const applyCronResult = () => {
        if (cronHelperResult?.cron) {
            setCustomCron(cronHelperResult.cron);
            setCronHelperResult(null);
            setCronHelperInput('');
            setCronHelperOpen(false);
        }
    };

    return (
        <div className="p-6 rounded-2xl border bg-zinc-900/50 border-zinc-800">
            <h3 className="text-lg font-medium text-white flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    {isEditing ? <Save className="h-5 w-5 text-indigo-400" /> : <Plus className="h-5 w-5 text-indigo-400" />}
                    {isEditing ? 'Edit Schedule' : 'New Schedule'}
                </div>
                {onCancel && (
                    <button
                        onClick={onCancel}
                        className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                )}
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
                } else {
                    // Apply weekdays/daytime transformations to the cron
                    let cronValue = formData.get('cron');
                    if (cronValue && !isOneOff) {
                        const parts = cronValue.split(/\s+/);
                        if (parts.length >= 5) {
                            // Weekdays only: set day-of-week to 1-5
                            if (weekdaysOnly) {
                                parts[4] = '1-5';
                            }
                            // Daytime only: restrict hour to 7-22 (only if hour is wildcard *)
                            if (daytimeOnly && parts[1] === '*') {
                                parts[1] = '7-22';
                            }
                            formData.set('cron', parts.join(' '));
                        }
                    }
                }

                // Pass model and toggles
                formData.set('model', model);
                formData.set('weekdaysOnly', weekdaysOnly ? 'true' : 'false');
                formData.set('daytimeOnly', daytimeOnly ? 'true' : 'false');

                await formAction(formData);
            }} className="grid md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Job Name {isEditing && '(Read Only)'}</label>
                    <input
                        type="text"
                        name="name"
                        placeholder="Job Name (e.g. daily_briefing)"
                        required
                        readOnly={isEditing}
                        defaultValue={initialValues?.name}
                        className={`w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${isEditing ? 'opacity-60 cursor-not-allowed' : ''}`}
                    />
                </div>

                {/* Frequency Selector */}
                <div className="md:col-span-2 flex gap-2">
                    <select
                        value={scheduleType}
                        onChange={(e) => {
                            const type = e.target.value;
                            setScheduleType(type);
                            if (type !== 'custom') {
                                setCustomCron(PRESETS[type].cron);
                            }
                        }}
                        className="rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm w-1/3"
                    >
                        {Object.entries(PRESETS).map(([key, preset]) => (
                            <option key={key} value={key}>{preset.label}</option>
                        ))}
                    </select>

                    <div className="relative w-2/3">
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

                {/* Cron AI Helper — only for custom schedule */}
                {scheduleType === 'custom' && (
                    <div className="md:col-span-2">
                        <button
                            type="button"
                            onClick={() => setCronHelperOpen(!cronHelperOpen)}
                            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-indigo-400 transition-colors py-1 px-1 -ml-1 rounded"
                        >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>Describe in plain English</span>
                            {cronHelperOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>

                        {cronHelperOpen && (
                            <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 space-y-2">
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        placeholder="e.g. every friday at 5pm"
                                        value={cronHelperInput}
                                        onChange={(e) => setCronHelperInput(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCronHelper(); } }}
                                        className="flex-1 rounded-lg bg-black border border-zinc-800 px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleCronHelper}
                                        disabled={cronHelperLoading || !cronHelperInput.trim()}
                                        className="rounded-lg bg-indigo-600/80 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1.5 text-sm text-white transition-colors flex items-center gap-1.5"
                                    >
                                        {cronHelperLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                        Parse
                                    </button>
                                </div>

                                {cronHelperError && (
                                    <p className="text-xs text-red-400">{cronHelperError}</p>
                                )}

                                {cronHelperResult && (
                                    <div className="flex items-center justify-between gap-2 rounded-lg bg-black/60 border border-zinc-700 px-3 py-2">
                                        <div className="min-w-0">
                                            <span className="font-mono text-sm text-indigo-300">{cronHelperResult.cron}</span>
                                            {cronHelperResult.description && (
                                                <p className="text-xs text-zinc-500 truncate">{cronHelperResult.description}</p>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={applyCronResult}
                                            className="shrink-0 flex items-center gap-1 rounded-md bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1 text-xs text-white transition-colors"
                                        >
                                            <Check className="w-3 h-3" />
                                            Use
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Schedule Modifiers: Weekdays + Daytime */}
                {!isOneOff && (
                    <div className="md:col-span-2 flex gap-4">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
                            <input
                                type="checkbox"
                                checked={weekdaysOnly}
                                onChange={(e) => setWeekdaysOnly(e.target.checked)}
                                className="w-4 h-4 rounded bg-black border-zinc-700 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                            />
                            Weekdays only
                        </label>
                        {!hasExplicitHour && (
                            <label className="flex items-center gap-2 cursor-pointer text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
                                <input
                                    type="checkbox"
                                    checked={daytimeOnly}
                                    onChange={(e) => setDaytimeOnly(e.target.checked)}
                                    className="w-4 h-4 rounded bg-black border-zinc-700 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                                />
                                Daytime only (7am-10pm)
                            </label>
                        )}
                    </div>
                )}

                {/* Model Selector */}
                <div className="md:col-span-1">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Model</label>
                    <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm"
                    >
                        {MODEL_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                {/* Expiration */}
                <div className="md:col-span-1">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Expiration (Optional)</label>
                    <input
                        type="datetime-local"
                        name="expiresAt"
                        defaultValue={initialValues?.expiresAt ? new Date(new Date(initialValues.expiresAt).getTime() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 16) : ''}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                    />
                </div>

                <div className="md:col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Instruction</label>
                    <textarea
                        name="task"
                        placeholder="Instruction (e.g. 'Summarize yesterday's logs')"
                        required
                        defaultValue={initialValues?.task}
                        rows={8}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-y"
                    />
                </div>

                <button
                    type="submit"
                    className="md:col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
                >
                    {isEditing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {isEditing ? 'Save Changes' : 'Schedule Task'}
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
