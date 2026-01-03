'use client';

import { useFormState } from 'react-dom';
import { addAlias, deleteAlias } from '@/app/actions';
import { Trash2, Plus, Tag } from 'lucide-react';

const initialState = { success: false, error: null };

export default function AliasList({ aliases }) {
    const [state, formAction] = useFormState(addAlias, initialState);

    return (
        <div className="space-y-6">
            {/* Add Alias Form */}
            <form action={formAction} className="flex gap-2 flex-wrap sm:flex-nowrap">
                <input
                    type="text"
                    name="alias"
                    placeholder="Alias (e.g. 'office light')"
                    required
                    className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
                <input
                    type="text"
                    name="entityId"
                    placeholder="Entity ID (e.g. light.office_1)"
                    required
                    className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                />
                <button
                    type="submit"
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors whitespace-nowrap"
                >
                    <Plus className="h-4 w-4" />
                    Add Alias
                </button>
            </form>
            {state?.error && (
                <p className="text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20">
                    {state.error}
                </p>
            )}

            {/* List */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {aliases.length === 0 ? (
                    <div className="col-span-full text-zinc-500 text-center py-8">No aliases found.</div>
                ) : (
                    aliases.map((item) => (
                        <div
                            key={item.alias}
                            className="group relative flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-all hover:bg-zinc-800/50 hover:border-zinc-700"
                        >
                            <div className="flex items-center gap-2 text-indigo-400 font-medium">
                                <Tag className="h-4 w-4" />
                                {item.alias}
                            </div>
                            <div className="text-xs text-zinc-500 font-mono break-all bg-black/20 p-2 rounded">
                                {item.entity_id}
                            </div>

                            <button
                                onClick={() => {
                                    if (confirm(`Delete alias '${item.alias}'?`)) deleteAlias(item.alias);
                                }}
                                className="absolute top-2 right-2 p-2 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
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
