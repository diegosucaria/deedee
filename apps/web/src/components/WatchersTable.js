'use client';

import { useState, useEffect } from 'react';
import { getWatchers, deleteWatcher, toggleWatcher } from '@/app/actions';
import { Eye, Trash2, RefreshCw, Edit, Plus, Power, Activity } from 'lucide-react';
import CreateWatcherForm from './CreateWatcherForm';

export default function WatchersTable() {
    const [watchers, setWatchers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [editingWatcher, setEditingWatcher] = useState(null);

    const loadWatchers = async () => {
        setLoading(true);
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
        // Poll less frequently than tasks
        const interval = setInterval(loadWatchers, 30000);
        return () => clearInterval(interval);
    }, []);

    const handleDelete = async (id, name) => {
        if (!confirm(`Are you sure you want to delete watcher '${name}'?`)) return;
        setActionLoading(id);
        try {
            await deleteWatcher(id);
            await loadWatchers();
        } catch (err) {
            console.error('Failed to delete watcher:', err);
        } finally {
            setActionLoading(null);
        }
    };

    const handleToggle = async (watcher) => {
        const newStatus = watcher.status === 'active' ? 'paused' : 'active';
        setActionLoading(watcher.id);
        try {
            await toggleWatcher(watcher.id, newStatus);
            await loadWatchers();
        } catch (err) {
            console.error('Failed to toggle watcher:', err);
        } finally {
            setActionLoading(null);
        }
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden mt-8">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                        <Eye className="w-5 h-5 text-emerald-400" />
                        Message Watchers
                    </h3>
                    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">
                        Enhanced WhatsApp Intelligence
                    </span>
                </div>

                <div className="flex gap-2">
                    <button
                        onClick={() => setEditingWatcher({})}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        New Watcher
                    </button>
                    <button
                        onClick={loadWatchers}
                        className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {editingWatcher && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditingWatcher(null)}>
                    <div className="w-full max-w-2xl" onClick={e => e.stopPropagation()}>
                        <CreateWatcherForm
                            initialValues={editingWatcher.name ? editingWatcher : null}
                            onWatcherCreated={() => {
                                setEditingWatcher(null);
                                loadWatchers();
                            }}
                            onCancel={() => setEditingWatcher(null)}
                        />
                    </div>
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Target</th>
                            <th className="px-4 py-3">Condition</th>
                            <th className="px-4 py-3">Last Triggered</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {watchers.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                                    No active watchers found. Create one to monitor generic WhatsApp messages.
                                </td>
                            </tr>
                        ) : (
                            watchers.map((watcher) => (
                                <tr key={watcher.id} className="hover:bg-zinc-800/50 transition-colors">
                                    <td className="px-4 py-4">
                                        <button
                                            onClick={() => handleToggle(watcher)}
                                            disabled={actionLoading === watcher.id}
                                            className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] uppercase font-bold transition-all ${watcher.status === 'active'
                                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                                                    : 'bg-zinc-700/20 text-zinc-500 border border-zinc-700/30 hover:bg-zinc-700/30'
                                                }`}
                                        >
                                            <Power className="w-3 h-3" />
                                            {watcher.status}
                                        </button>
                                    </td>
                                    <td className="px-4 py-4 font-medium text-zinc-300">
                                        {watcher.name}
                                    </td>
                                    <td className="px-4 py-4 text-zinc-400 font-mono text-xs">
                                        {watcher.contact_string}
                                    </td>
                                    <td className="px-4 py-4 max-w-xs">
                                        <code className="text-xs bg-black px-1.5 py-0.5 rounded text-amber-500/90 border border-zinc-800">
                                            {watcher.condition}
                                        </code>
                                    </td>
                                    <td className="px-4 py-4 text-zinc-500 text-xs">
                                        {watcher.last_triggered_at ? (
                                            <span className="flex items-center gap-1.5 text-indigo-400">
                                                <Activity className="w-3 h-3" />
                                                {new Date(watcher.last_triggered_at).toLocaleString()}
                                            </span>
                                        ) : '-'}
                                    </td>
                                    <td className="px-4 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => setEditingWatcher(watcher)}
                                                disabled={actionLoading === watcher.id}
                                                className="p-1.5 hover:bg-zinc-700/50 rounded text-indigo-400 transition-colors disabled:opacity-50"
                                                title="Edit Watcher"
                                            >
                                                <Edit className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(watcher.id, watcher.name)}
                                                disabled={actionLoading === watcher.id}
                                                className="p-1.5 hover:bg-zinc-700/50 rounded text-red-400 transition-colors disabled:opacity-50"
                                                title="Delete Watcher"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
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
