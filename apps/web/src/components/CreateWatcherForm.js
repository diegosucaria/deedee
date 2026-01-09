'use client';

import { useState } from 'react';

import { createWatcher } from '@/app/actions';

export default function CreateWatcherForm({ onSuccess, onCancel }) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const formData = new FormData(e.target);
        const name = formData.get('name');
        const contactString = formData.get('contactString');
        const condition = formData.get('condition');
        const instruction = formData.get('instruction');

        try {
            const res = await createWatcher(name, contactString, condition, instruction);
            if (!res.success) throw new Error(res.error);

            onSuccess();
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
                <div className="p-3 bg-red-900/30 border border-red-800 text-red-200 text-sm rounded-lg">
                    {error}
                </div>
            )}

            <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Friendly Name</label>
                <input
                    name="name"
                    required
                    placeholder="e.g. Dinner Plans"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                />
            </div>

            <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Contact (Phone or Group Name)</label>
                <input
                    name="contactString"
                    required
                    placeholder="e.g. Mom or Football Group"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                />
                <p className="text-xs text-zinc-600 mt-1">Found in incoming message metadata.</p>
            </div>

            <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Trigger Condition</label>
                <input
                    name="condition"
                    required
                    defaultValue="contains"
                    placeholder="e.g. contains 'dinner'"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 outline-none font-mono text-sm"
                />
                <p className="text-xs text-zinc-600 mt-1">Simple string match. Use "contains 'text'".</p>
            </div>

            <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1">Instruction</label>
                <textarea
                    name="instruction"
                    required
                    rows={3}
                    placeholder="What should I do? e.g. Reply '8pm' or Notify me."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 outline-none"
                />
            </div>

            <div className="flex justify-end gap-3 pt-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
                >
                    {loading ? 'Saving...' : 'Create Watcher'}
                </button>
            </div>
        </form>
    );
}
