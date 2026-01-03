'use client';

import { useFormState } from 'react-dom';
import { cancelTask, createTask } from '@/app/actions';
import { Trash2, Clock, PlayCircle, Plus } from 'lucide-react';

const initialState = { success: false, error: null };

export default function TaskList({ tasks }) {
    const [state, formAction] = useFormState(createTask, initialState);

    return (
        <div className="space-y-8">
            {/* Add Task Form */}
            <div className="bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800">
                <h3 className="text-lg font-medium text-white mb-4 flex items-center gap-2">
                    <Plus className="h-5 w-5 text-indigo-400" />
                    New Schedule
                </h3>
                <form action={formAction} className="grid md:grid-cols-2 gap-4">
                    <input
                        type="text"
                        name="name"
                        placeholder="Job Name (e.g. daily_briefing)"
                        required
                        className="rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                    />
                    <input
                        type="text"
                        name="cron"
                        placeholder="Cron (e.g. 0 8 * * *)"
                        required
                        className="rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                    />
                    <div className="md:col-span-2">
                        <input
                            type="text"
                            name="task"
                            placeholder="Instruction (e.g. 'Summarize yesterday's logs')"
                            required
                            className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                        />
                    </div>

                    <button
                        type="submit"
                        className="md:col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors"
                    >
                        Schedule Task
                    </button>
                </form>
                {state?.error && (
                    <p className="mt-4 text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20">
                        {state.error}
                    </p>
                )}
            </div>

            {/* List */}
            <div className="grid gap-4 md:grid-cols-2">
                {tasks.length === 0 ? (
                    <div className="col-span-full text-zinc-500 text-center py-8">No scheduled tasks active.</div>
                ) : (
                    tasks.map((job) => (
                        <div
                            key={job.name}
                            className="group relative flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-all hover:bg-zinc-800/50 hover:border-zinc-700 hover:shadow-xl"
                        >
                            <div className="flex items-center justify-between">
                                <span className="font-semibold text-white tracking-wide">{job.name}</span>
                                <div className="flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-400 border border-indigo-500/20 font-mono">
                                    <Clock className="h-3 w-3" />
                                    {job.cron}
                                </div>
                            </div>

                            <div className="text-sm text-zinc-400 flex items-center gap-2">
                                <PlayCircle className="h-4 w-4 text-emerald-500" />
                                Next: <span className="text-zinc-300">{new Date(job.nextInvocation).toLocaleString()}</span>
                            </div>

                            <button
                                onClick={() => {
                                    if (confirm(`Cancel schedule '${job.name}'?`)) cancelTask(job.name);
                                }}
                                className="absolute top-4 right-4 p-2 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                title="Cancel Schedule"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
