'use client';

import { useState, useEffect } from 'react';
import { getWatchers, deleteWatcher } from '@/app/actions';
import { Eye, Trash2, RefreshCw, Plus } from 'lucide-react';
import CreateWatcherForm from './CreateWatcherForm';


import { io } from 'socket.io-client';

export default function WatchersTable() {
    const [watchers, setWatchers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [deletingId, setDeletingId] = useState(null);

    const loadWatchers = async () => {
        // Silent loading if we have data already
        if (watchers.length === 0) setLoading(true);
        try {
            const data = await getWatchers();
            setWatchers(data || []);
        } catch (err) {
            console.error('Failed to load watchers:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadWatchers();

        // Polling Fallback (every 30s)
        const interval = setInterval(loadWatchers, 30000);

        // Socket.IO Live Updates
        const socket = io({
            path: '/socket.io',
            reconnectionAttempts: 5,
            transports: ['polling']
        });

        socket.on('connect', () => {
            console.log('[WatchersTable] Socket connected');
        });

        socket.on('watcher:update', (data) => {
            console.log('[WatchersTable] Received update:', data);
            loadWatchers();
        });

        return () => {
            clearInterval(interval);
            socket.disconnect();
        };
    }, []);

    const handleDelete = async (id) => {
        if (!confirm('Delete this watcher?')) return;
        setDeletingId(id);
        try {
            const res = await deleteWatcher(id);
            if (!res.success) throw new Error(res.error);
            await loadWatchers();
        } catch (err) {
            console.error('Failed to delete watcher:', err);
            alert('Failed to delete: ' + err.message);
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Eye className="w-5 h-5 text-emerald-400" />
                    Message Watchers
                </h3>
                <div className="flex gap-2">
                    <button
                        onClick={() => setIsCreating(true)}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        New Watcher
                    </button>
                    <button
                        onClick={loadWatchers}
                        className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {isCreating && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setIsCreating(false)}>
                    <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-xl p-6" onClick={e => e.stopPropagation()}>
                        <h2 className="text-xl font-bold text-white mb-4">Create Message Watcher</h2>
                        <CreateWatcherForm
                            onSuccess={() => {
                                setIsCreating(false);
                                loadWatchers();
                            }}
                            onCancel={() => setIsCreating(false)}
                        />
                    </div>
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Matches Contact</th>
                            <th className="px-4 py-3">Condition</th>
                            <th className="px-4 py-3">Instructions</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {watchers.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                                    No active watchers.
                                </td>
                            </tr>
                        ) : (
                            watchers.map((w) => (
                                <tr key={w.id} className="hover:bg-zinc-800/50 transition-colors">
                                    <td className="px-4 py-4 font-medium text-zinc-300">
                                        {w.name}
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400 font-mono text-xs">
                                        {w.contact_string}
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400">
                                        <span className="px-2 py-1 bg-zinc-800 rounded text-xs">
                                            {w.condition}
                                        </span>
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400 max-w-xs truncate">
                                        {w.instruction}
                                    </td>
                                    <td className="px-4 py-4 text-right">
                                        <button
                                            onClick={() => handleDelete(w.id)}
                                            disabled={deletingId === w.id}
                                            className="p-2 hover:bg-zinc-700/50 rounded text-red-400 transition-colors disabled:opacity-50"
                                            title="Delete Watcher"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
