'use client';

import { useFormState } from 'react-dom';
import { addFact, deleteFact } from '@/app/actions';
import { Trash2, Plus, Database, Search } from 'lucide-react';
import { useState } from 'react';

const initialState = { success: false, error: null };

export default function MemoryList({ facts }) {
    const [state, formAction] = useFormState(addFact, initialState);
    const [search, setSearch] = useState('');
    const [editingKey, setEditingKey] = useState(null);
    const [editValue, setEditValue] = useState('');

    const filteredFacts = facts.filter(f =>
        f.key.toLowerCase().includes(search.toLowerCase()) ||
        JSON.stringify(f.value).toLowerCase().includes(search.toLowerCase())
    );

    const handleEditClick = (fact) => {
        setEditingKey(fact.key);
        setEditValue(typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value);
    };

    const handleSaveEdit = async () => {
        // Optimistic update or wait for server action?
        // We'll trust the formAction to handle revalidation
        const formData = new FormData();
        formData.append('key', editingKey);
        formData.append('value', editValue);

        // We can interact with the server action directly or mock a form submission
        // Since useFormState wraps the action, we can try calling the original action directly if exported, 
        // or just use a hidden form submit. simpler is reuse the verified action.
        await addFact(null, formData);
        setEditingKey(null);
    };

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
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-indigo-400 font-medium font-mono text-sm">
                                    <Database className="h-3 w-3" />
                                    {fact.key}
                                </div>

                                <div className="flex opacity-0 group-hover:opacity-100 transition-opacity gap-2">
                                    <button
                                        onClick={() => handleEditClick(fact)}
                                        className="p-2 text-zinc-500 hover:bg-indigo-500/10 hover:text-indigo-400 rounded-lg transition-all"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></svg>
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (confirm(`Delete fact '${fact.key}'?`)) deleteFact(fact.key);
                                        }}
                                        className="p-2 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 rounded-lg transition-all"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>

                            {editingKey === fact.key ? (
                                <div className="flex gap-2 mt-2">
                                    <input
                                        type="text"
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        className="flex-1 bg-black border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                                    />
                                    <button onClick={handleSaveEdit} className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded">Save</button>
                                    <button onClick={() => setEditingKey(null)} className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1 rounded">Cancel</button>
                                </div>
                            ) : (
                                <>
                                    <div className="text-sm text-zinc-300 font-mono break-all bg-black/30 p-3 rounded border border-zinc-800/50">
                                        {typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value}
                                    </div>
                                    <div className="text-[10px] text-zinc-600">Updated: {new Date(fact.updated_at).toLocaleString()}</div>
                                </>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
