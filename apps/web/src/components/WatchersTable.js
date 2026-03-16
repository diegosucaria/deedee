'use client';

import { useState, useEffect } from 'react';
import { getWatchers, deleteWatcher, toggleWatcher } from '@/app/actions';
import { Eye, Trash2, RefreshCw, Edit, Plus, Power, Activity } from 'lucide-react';
import CreateWatcherForm from './CreateWatcherForm';
import { useSocket } from '@/hooks/useSocket';

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

    const { socket } = useSocket();

    useEffect(() => {
        loadWatchers();
        const interval = setInterval(loadWatchers, 30000);

        if (socket) {
            const handler = () => {
                console.log('Received watcher:update, refreshing list...');
                loadWatchers();
            };
            socket.on('watcher:update', handler);
            return () => {
                clearInterval(interval);
                socket.off('watcher:update', handler);
            };
        }

        return () => clearInterval(interval);
    }, [socket]);

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
        setActionLoading(watcher.id + '_toggle');
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
            <div className="p-3 md:p-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 md:gap-4 min-w-0">
                    <h3 className="text-base md:text-lg font-semibold text-zinc-300 flex items-center gap-2 whitespace-nowrap">
                        <Eye className="w-5 h-5 shrink-0 text-emerald-400" />
                        Message Watchers
                    </h3>
                    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full hidden sm:inline">
                        Enhanced WhatsApp Intelligence
                    </span>
                </div>

                <div className="flex gap-2">
                    <button
                        onClick={() => setEditingWatcher({})}
                        className="px-2 md:px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1 md:gap-2"
                    >
                        <Plus className="w-4 h-4" />
                        <span className="hidden sm:inline">New Watcher</span>
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
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) setEditingWatcher(null); }}>
                    <div className="w-full max-w-2xl">
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

            <div className="overflow-x-auto scrollbar-hide">
                <table className="w-full text-sm text-left min-w-[600px]">
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
                                    No watchers found. Create one to monitor WhatsApp messages.
                                </td>
                            </tr>
                        ) : (
                            watchers.map((watcher) => (
                                <tr key={watcher.id} className={`hover:bg-zinc-800/50 transition-colors ${watcher.status !== 'active' ? 'opacity-60 grayscale-[50%]' : ''}`}>
                                    <td className="px-4 py-4">
                                        <button
                                            onClick={() => handleToggle(watcher)}
                                            disabled={actionLoading === watcher.id + '_toggle'}
                                            className={`px-2 py-1 rounded transition-colors disabled:opacity-50 text-[10px] uppercase font-bold tracking-wider ${watcher.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20'}`}
                                            title={watcher.status === 'active' ? "Pause Watcher" : "Resume Watcher"}
                                        >
                                            {watcher.status === 'active' ? 'ON' : 'OFF'}
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
