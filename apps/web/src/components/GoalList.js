'use client';

import { useFormState } from 'react-dom';
import { addGoal, deleteGoal, updateGoal } from '@/app/actions';
import { Trash2, CheckCircle, Circle, Plus } from 'lucide-react';

const initialState = { success: false, error: null };

export default function GoalList({ goals }) {
    const [state, formAction] = useFormState(addGoal, initialState);

    return (
        <div className="space-y-6">
            {/* Add Goal Form */}
            <form action={formAction} className="flex gap-2">
                <input
                    type="text"
                    name="description"
                    placeholder="New Goal..."
                    required
                    className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
                <button
                    type="submit"
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors"
                >
                    <Plus className="h-4 w-4" />
                    Add
                </button>
            </form>
            {state?.error && (
                <p className="text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20">
                    {state.error}
                </p>
            )}

            {/* Goals List */}
            <div className="grid gap-4">
                {goals.length === 0 ? (
                    <div className="text-zinc-500 text-center py-8">No pending goals.</div>
                ) : (
                    goals.map((goal) => (
                        <div
                            key={goal.id}
                            className="group flex items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-all hover:bg-zinc-800/50 hover:border-zinc-700"
                        >
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => updateGoal(goal.id, goal.status === 'completed' ? 'pending' : 'completed')}
                                    className="text-zinc-500 hover:text-indigo-400 transition-colors"
                                >
                                    {goal.status === 'completed' ? (
                                        <CheckCircle className="h-5 w-5 text-green-500" />
                                    ) : (
                                        <Circle className="h-5 w-5" />
                                    )}
                                </button>
                                <div>
                                    <p className={`font-medium text-zinc-200 ${goal.status === 'completed' ? 'line-through text-zinc-500' : ''}`}>
                                        {goal.description}
                                    </p>
                                    <p className="text-xs text-zinc-500">
                                        Created: {new Date(goal.created_at).toLocaleDateString()}
                                    </p>
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    if (confirm('Delete this goal?')) deleteGoal(goal.id);
                                }}
                                className="p-2 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
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
