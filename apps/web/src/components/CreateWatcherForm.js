'use client';

import { useFormState } from 'react-dom';
import { createWatcher } from '@/app/actions';
import { Plus, Save, X } from 'lucide-react';
import { useRef, useEffect } from 'react';

const initialState = { success: false, error: null };

export default function CreateWatcherForm({ onWatcherCreated, initialValues = null, onCancel = null }) {
    const [state, formAction] = useFormState(createWatcher, initialState);
    const formRef = useRef(null);

    // Reset form on success
    useEffect(() => {
        if (state?.success) {
            if (!initialValues) {
                formRef.current?.reset();
            }
            if (onWatcherCreated) onWatcherCreated();
        }
    }, [state, onWatcherCreated, initialValues]);

    const isEditing = !!initialValues;

    return (
        <div className="p-6 rounded-2xl border bg-zinc-900/50 border-zinc-800">
            <h3 className="text-lg font-medium text-white flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    {isEditing ? <Save className="h-5 w-5 text-emerald-400" /> : <Plus className="h-5 w-5 text-emerald-400" />}
                    {isEditing ? 'Edit Watcher' : 'New Watcher'}
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

            <form ref={formRef} action={formAction} className="grid md:grid-cols-2 gap-4">
                {/* Watcher Name */}
                <div className="md:col-span-1">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Watcher Name</label>
                    <input
                        type="text"
                        name="name"
                        placeholder="e.g. Dinner Plans"
                        required
                        defaultValue={initialValues?.name}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                    />
                </div>

                {/* Contact String */}
                <div className="md:col-span-1">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Target Contact / Group</label>
                    <input
                        type="text"
                        name="contactString"
                        placeholder="Name or Phone (e.g. 'Diego' or 'Family Group')"
                        required
                        defaultValue={initialValues?.contactString}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all"
                    />
                </div>

                {/* Condition */}
                <div className="md:col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Trigger Condition</label>
                    <input
                        type="text"
                        name="condition"
                        placeholder="e.g. contains 'dinner' OR 'emergency'"
                        required
                        defaultValue={initialValues?.condition}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all font-mono text-sm"
                    />
                    <p className="text-[10px] text-zinc-600 mt-1 ml-1">
                        Simple text match. Use "contains 'text'" logic. The agent checks if the incoming message matches this.
                    </p>
                </div>

                {/* Instruction */}
                <div className="md:col-span-2">
                    <label className="block text-xs text-zinc-500 mb-1 ml-1">Instruction (What to do)</label>
                    <textarea
                        name="instruction"
                        placeholder="e.g. Reply 'I usually eat at 8pm', or 'Log this to tasks'"
                        required
                        defaultValue={initialValues?.instruction}
                        rows={4}
                        className="w-full rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all resize-y"
                    />
                </div>

                <button
                    type="submit"
                    className="md:col-span-2 flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white hover:bg-emerald-500 active:bg-emerald-700 transition-colors shadow-lg shadow-emerald-500/20"
                >
                    {isEditing ? <Save className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {isEditing ? 'Save Watcher' : 'Create Watcher'}
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
