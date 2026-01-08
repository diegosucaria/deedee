'use client';

import { useState, useEffect } from 'react';
import { Search, Loader2, X, User } from 'lucide-react';
import { getWhatsAppContacts } from '../app/actions';

export default function ContactList({ session, onClose }) {
    const [contacts, setContacts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => {
        let mounted = true;
        const fetchContacts = async () => {
            setLoading(true);
            try {
                const data = await getWhatsAppContacts(session, search);
                if (mounted) setContacts(data);
            } catch (e) {
                console.error(e);
            } finally {
                if (mounted) setLoading(false);
            }
        };

        const timer = setTimeout(() => {
            fetchContacts();
        }, 500); // 500ms debounce

        return () => {
            mounted = false;
            clearTimeout(timer);
        };
    }, [session, search]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl">

                {/* Header */}
                <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/50">
                    <h3 className="text-lg font-semibold text-white">Contacts ({session})</h3>
                    <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Search */}
                <div className="p-4 border-b border-zinc-800 bg-zinc-900/30">
                    <div className="relative">
                        <Search className="absolute left-3 top-2.5 w-4 h-4 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search contacts..."
                            className="w-full bg-zinc-800 border-zinc-700 text-white rounded-lg pl-9 pr-4 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all placeholder:text-zinc-600"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            autoFocus
                        />
                    </div>
                </div>

                {/* List */}
                <div className="overflow-y-auto flex-1 p-2 space-y-1">
                    {loading ? (
                        <div className="flex justify-center p-8 text-zinc-500">
                            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading...
                        </div>
                    ) : contacts.length === 0 ? (
                        <div className="text-center p-8 text-zinc-500 text-sm">
                            No contacts found.
                        </div>
                    ) : (
                        contacts.map((c) => (
                            <div key={c.id} className="p-3 hover:bg-zinc-800/50 rounded-lg flex items-center gap-3 transition-colors group">
                                <div className="w-10 h-10 bg-indigo-500/10 text-indigo-400 rounded-full flex items-center justify-center flex-shrink-0">
                                    <User className="w-5 h-5" />
                                </div>
                                <div className="overflow-hidden">
                                    <div className="font-medium text-zinc-200 truncate">
                                        {c.name || c.notify || 'Unknown'}
                                    </div>
                                    <div className="text-xs text-zinc-500 font-mono truncate">
                                        {c.phone} {c.notify && c.name && `• ${c.notify}`}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Footer */}
                <div className="p-3 border-t border-zinc-800 bg-zinc-900/50 text-xs text-center text-zinc-500">
                    {contacts.length} contacts found
                </div>
            </div>
        </div>
    );
}
