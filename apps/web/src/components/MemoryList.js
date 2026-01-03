'use client';

import { useFormState } from 'react-dom';
import { addFact, deleteFact } from '@/app/actions';
import { Trash2, Plus, Database, Search } from 'lucide-react';
import { useState } from 'react';

const initialState = { success: false, error: null };

export default function MemoryList({ facts }) {
    const [state, formAction] = useFormState(addFact, initialState);
    const [search, setSearch] = useState('');

    const filteredFacts = facts.filter(f =>
        f.key.toLowerCase().includes(search.toLowerCase()) ||
        JSON.stringify(f.value).toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="space-y-6">
            {/* Add Fact Form */}
            <form action={formAction} className="flex gap-2 flex-wrap sm:flex-nowrap bg-zinc-900/50 p-4 rounded-xl border border-zinc-800">
                <input
                    type="text"
                    name="key"
                    placeholder="Key (e.g. user_age)"
                    required
                    className="w-full sm:w-1/3 rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                />
                <input
                    type="text"
                    name="value"
                    placeholder="Value (e.g. 30)"
                    required
                    className="flex-1 rounded-lg bg-black border border-zinc-800 px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                />
                <button
                    type="submit"
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 active:bg-indigo-700 transition-colors whitespace-nowrap"
                >
                    <Plus className="h-4 w-4" />
                    Save
                </button>
            </form>
            {state?.error && (
                <p className="text-sm text-red-400 bg-red-400/10 p-2 rounded border border-red-400/20">
                    {state.error}
                </p>
            )}

            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                <input
                    type="text"
                    placeholder="Search memory..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full bg-zinc-950 border-b border-zinc-800 px-10 py-3 text-sm focus:outline-none focus:border-indigo-500 transition-colors placeholder-zinc-600"
                />
            </div>

            {/* List */}
            <div className="grid gap-4">
                {filteredFacts.length === 0 ? (
                    <div className="text-zinc-500 text-center py-8">No facts found.</div>
                ) : (
                    filteredFacts.map((fact) => (
                        <div
                            key={fact.key}
                            className="group relative flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4 transition-all hover:bg-zinc-800/50 hover:border-zinc-700"
                        >
                            <div className="flex items-center gap-2 text-indigo-400 font-medium font-mono text-sm">
                                <Database className="h-3 w-3" />
                                {fact.key}
                            </div>
                            <div className="text-sm text-zinc-300 font-mono break-all bg-black/30 p-3 rounded border border-zinc-800/50">
                                {typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value}
                            </div>
                            <div className="text-[10px] text-zinc-600">Updated: {new Date(fact.updated_at).toLocaleString()}</div>

                            <button
                                onClick={() => {
                                    if (confirm(`Delete fact '${fact.key}'?`)) deleteFact(fact.key);
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
