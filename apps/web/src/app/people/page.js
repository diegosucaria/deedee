'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Sparkles, UserPlus, RefreshCw } from 'lucide-react';
import { getPeople, createPerson, updatePerson, deletePerson, syncWhatsAppContacts } from '@/app/actions';
import { PersonCard } from '@/components/people/PersonCard';
import { SmartLearnModal } from '@/components/people/SmartLearnModal';

export default function PeoplePage() {
    const [people, setPeople] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [isSmartLearnOpen, setSmartLearnOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);

    // Edit/Create Modal State (Simplified inline or separate?)
    // Let's use a simple state for now.
    const [editingPerson, setEditingPerson] = useState(null); // null = none, {} = new, {id...} = edit
    const [isEditOpen, setEditOpen] = useState(false);

    useEffect(() => {
        loadPeople();
    }, []);

    const loadPeople = async () => {
        setLoading(true);
        const res = await getPeople();
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

    const filteredPeople = people.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        (p.relationship && p.relationship.toLowerCase().includes(query.toLowerCase())) ||
        (p.phone && p.phone.includes(query))
    );

    const handleSave = async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData);

        // Remove empty strings
        if (!data.phone) delete data.phone;
        if (!data.relationship) delete data.relationship;
        if (!data.notes) delete data.notes;

        if (editingPerson.id) {
            await updatePerson(editingPerson.id, data);
        } else {
            await createPerson(null, formData); // createPerson expects formData
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
        <div className="p-6 space-y-6 max-w-7xl mx-auto h-[calc(100vh-4rem)] overflow-y-auto">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">People</h1>
                    <p className="text-muted-foreground">Manage your contacts and relationships.</p>
                </div>
                <div className="flex bg-secondary/30 p-1 rounded-lg space-x-1">
                    <button
                        onClick={() => { setEditingPerson({}); setEditOpen(true); }}
                        className="btn-primary flex items-center space-x-2"
                    >
                        <Plus size={18} />
                        <span>Add Person</span>
                    </button>
                    <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="flex items-center space-x-2 px-4 py-2 rounded-md hover:bg-secondary/50 text-foreground transition-colors border border-transparent hover:border-primary/20 disabled:opacity-50"
                    >
                        <RefreshCw size={18} className={`text-green-500 ${syncing ? 'animate-spin' : ''}`} />
                        <span>{syncing ? 'Syncing...' : 'Sync WhatsApp'}</span>
                    </button>
                    <button
                        onClick={() => setSmartLearnOpen(true)}
                        className="flex items-center space-x-2 px-4 py-2 rounded-md hover:bg-secondary/50 text-foreground transition-colors border border-transparent hover:border-primary/20"
                    >
                        <Sparkles size={18} className="text-primary" />
                        <span>Smart Learn</span>
                    </button>
                </div>
            </div>

            {/* Search */}
            <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
                <input
                    type="text"
                    placeholder="Search people..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full bg-background border border-input pl-9 pr-4 py-2 rounded-lg focus:ring-1 focus:ring-primary outline-none"
                />
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                <AnimatePresence>
                    {filteredPeople.map(person => (
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
                    <span className="loading loading-dots loading-lg text-primary"></span>
                </div>
            )}

            {!loading && filteredPeople.length === 0 && (
                <div className="text-center py-20 opacity-50">
                    <UserPlus className="mx-auto w-12 h-12 mb-4" />
                    <p>No people found.</p>
                </div>
            )}

            {/* Create/Edit Modal */}
            <AnimatePresence>
                {isEditOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md overflow-hidden"
                        >
                            <form onSubmit={handleSave}>
                                <div className="p-4 border-b border-border">
                                    <h3 className="font-semibold">{editingPerson?.id ? 'Edit Person' : 'Add Person'}</h3>
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                                        <input name="name" defaultValue={editingPerson?.name} required className="input-field w-full" placeholder="John Doe" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium uppercase text-muted-foreground">Phone</label>
                                        <input name="phone" defaultValue={editingPerson?.phone} className="input-field w-full" placeholder="+1234567890" />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-xs font-medium uppercase text-muted-foreground">Relation</label>
                                            <input name="relationship" defaultValue={editingPerson?.relationship} className="input-field w-full" placeholder="Friend" />
                                        </div>
                                        <div className="space-y-2 col-span-2">
                                            <label className="text-xs font-medium uppercase text-muted-foreground">Notes</label>
                                            <textarea name="notes" defaultValue={editingPerson?.notes} className="input-field w-full min-h-[100px] py-2" placeholder="Met at..." />
                                        </div>
                                    </div>
                                </div>
                                <div className="p-4 border-t border-border bg-secondary/10 flex justify-end space-x-2">
                                    <button type="button" onClick={() => setEditOpen(false)} className="px-4 py-2 rounded-md hover:bg-secondary transition-colors text-sm">Cancel</button>
                                    <button type="submit" className="btn-primary">Save</button>
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
        </div>
    );
}
