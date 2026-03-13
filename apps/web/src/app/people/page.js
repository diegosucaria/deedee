'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Sparkles, UserPlus, RefreshCw, Users } from 'lucide-react';
import { getPeople, createPerson, updatePerson, deletePerson, syncWhatsAppContacts, syncSlackContacts } from '@/app/actions';
import { PersonCard } from '@/components/people/PersonCard';
import { SmartLearnModal } from '@/components/people/SmartLearnModal';
import PageShell from '@/components/PageShell';

export default function PeoplePage() {
    const [people, setPeople] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [page, setPage] = useState(0);
    const LIMIT = 24;

    const [isSmartLearnOpen, setSmartLearnOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncingSlack, setSyncingSlack] = useState(false);

    // Edit/Create Modal State
    const [editingPerson, setEditingPerson] = useState(null);
    const [isEditOpen, setEditOpen] = useState(false);

    // Debounce Query
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedQuery(query);
            setPage(0);
        }, 500);
        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        loadPeople();
    }, [debouncedQuery, page]);

    const loadPeople = async () => {
        setLoading(true);
        const res = await getPeople({
            limit: LIMIT,
            offset: page * LIMIT,
            search: debouncedQuery
        });
        setPeople(res || []);
        setLoading(false);
    };

    const handleSync = async () => {
        setSyncing(true);
        const res = await syncWhatsAppContacts();
        setSyncing(false);
        if (res.success) {
            alert(`Synced ${res.stats.added} contacts! (Skipped ${res.stats.skipped})`);
            loadPeople();
        } else {
            alert('Failed to sync: ' + res.error);
        }
    };

    const handleSlackSync = async () => {
        setSyncingSlack(true);
        const res = await syncSlackContacts();
        setSyncingSlack(false);
        if (res.success) {
            const parts = [`Added ${res.stats.added}`];
            if (res.stats.merged > 0) parts.push(`Merged ${res.stats.merged}`);
            parts.push(`Skipped ${res.stats.skipped}`);
            alert(`Slack Sync: ${parts.join(', ')}`);
            loadPeople();
        } else {
            alert('Failed to sync Slack: ' + res.error);
        }
    };

    const handleSave = async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData);

        if (!data.phone) delete data.phone;
        if (!data.relationship) delete data.relationship;
        if (!data.notes) delete data.notes;

        if (editingPerson.id) {
            await updatePerson(editingPerson.id, data);
        } else {
            await createPerson(null, formData);
        }
        setEditOpen(false);
        setEditingPerson(null);
        loadPeople();
    };

    const handleDelete = async (id) => {
        if (confirm('Are you sure you want to delete this person?')) {
            await deletePerson(id);
            loadPeople();
        }
    };

    return (
        <PageShell icon={Users} title="People" subtitle="Manage your contacts and relationships.">
            {/* Actions */}
            <div className="flex flex-wrap gap-2 mb-6">
                <button
                    onClick={() => { setEditingPerson({}); setEditOpen(true); }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                    <Plus size={18} />
                    <span>Add Person</span>
                </button>
                <button
                    onClick={handleSync}
                    disabled={syncing}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={18} className={`text-green-500 ${syncing ? 'animate-spin' : ''}`} />
                    <span>{syncing ? 'Syncing...' : 'Sync WhatsApp'}</span>
                </button>
                <button
                    onClick={handleSlackSync}
                    disabled={syncingSlack}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={18} className={`text-purple-500 ${syncingSlack ? 'animate-spin' : ''}`} />
                    <span>{syncingSlack ? 'Syncing...' : 'Sync Slack'}</span>
                </button>
                <button
                    onClick={() => setSmartLearnOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 transition-colors"
                >
                    <Sparkles size={18} className="text-indigo-400" />
                    <span>Smart Learn</span>
                </button>
            </div>

            {/* Search */}
            <div className="relative max-w-md mb-6">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 w-4 h-4" />
                <input
                    type="text"
                    placeholder="Search people..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 pl-9 pr-4 py-2 rounded-lg text-zinc-200 focus:ring-1 focus:ring-indigo-500/50 outline-none"
                />
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                <AnimatePresence>
                    {people.map(person => (
                        <PersonCard
                            key={person.id}
                            person={person}
                            onEdit={(p) => { setEditingPerson(p); setEditOpen(true); }}
                            onDelete={handleDelete}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {loading && (
                <div className="flex justify-center p-12">
                    <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
                </div>
            )}

            {!loading && people.length === 0 && (
                <div className="text-center py-20 opacity-50">
                    <UserPlus className="mx-auto w-12 h-12 mb-4" />
                    <p>{debouncedQuery ? "No matches found." : "No people found."}</p>
                </div>
            )}

            {/* Pagination Controls */}
            <div className="flex justify-center gap-4 mt-8">
                <button
                    disabled={page === 0 || loading}
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    className="px-4 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                    Previous
                </button>
                <span className="flex items-center text-sm font-mono text-zinc-500">
                    Page {page + 1}
                </span>
                <button
                    disabled={people.length < LIMIT || loading}
                    onClick={() => setPage(p => p + 1)}
                    className="px-4 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                    Next
                </button>
            </div>

            {/* Create/Edit Modal */}
            <AnimatePresence>
                {isEditOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-md overflow-hidden"
                        >
                            <form onSubmit={handleSave}>
                                <div className="p-4 border-b border-zinc-800">
                                    <h3 className="font-semibold text-white">{editingPerson?.id ? 'Edit Person' : 'Add Person'}</h3>
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase text-zinc-400">Name</label>
                                        <input name="name" defaultValue={editingPerson?.name} required className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none" placeholder="John Doe" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase text-zinc-400">Phone</label>
                                        <input name="phone" defaultValue={editingPerson?.phone} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none" placeholder="+1234567890" />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-xs font-medium uppercase text-zinc-400">Relation</label>
                                            <input name="relationship" defaultValue={editingPerson?.relationship} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none" placeholder="Friend" />
                                        </div>
                                        <div className="space-y-2 col-span-2">
                                            <label className="text-xs font-medium uppercase text-zinc-400">Notes</label>
                                            <textarea name="notes" defaultValue={editingPerson?.notes} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none min-h-[100px]" placeholder="Met at..." />
                                        </div>
                                    </div>
                                </div>
                                <div className="p-4 border-t border-zinc-800 bg-zinc-800/10 flex justify-end gap-2">
                                    <button type="button" onClick={() => setEditOpen(false)} className="px-4 py-2 rounded-lg text-sm text-zinc-300 hover:bg-zinc-800 transition-colors">Cancel</button>
                                    <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">Save</button>
                                </div>
                            </form>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Smart Learn Modal */}
            <SmartLearnModal
                isOpen={isSmartLearnOpen}
                onClose={() => setSmartLearnOpen(false)}
                onLearned={loadPeople}
            />
        </PageShell>
    );
}
