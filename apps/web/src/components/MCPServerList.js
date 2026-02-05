'use client';

import { useState } from 'react';
import { Server, Wifi, WifiOff, Plus, Trash2, X, Loader2, RotateCw } from 'lucide-react';
import clsx from 'clsx';
import { addMCPServer, deleteMCPServer, reloadMCPServers } from '@/app/actions';

export default function MCPServerList({ servers = {} }) {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isReloading, setIsReloading] = useState(false);

    const handleReload = async () => {
        setIsReloading(true);
        try {
            await reloadMCPServers();
        } catch (e) {
            console.error(e);
        } finally {
            setIsReloading(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold text-white">Connected Servers</h2>
                    <p className="text-zinc-400 text-sm">External tool providers and their connection status.</p>
                </div>
                <button
                    onClick={handleReload}
                    disabled={isReloading}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-800 text-sm font-medium disabled:opacity-50 transition-colors"
                >
                    {isReloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                    Reload
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {servers.map((server) => (
                    <ServerCard key={server.name} server={server} />
                ))}

                {/* Add New Button Card */}
                <button
                    onClick={() => setShowAdd(true)}
                    className="flex flex-col items-center justify-center gap-2 h-32 border border-zinc-800 border-dashed rounded-lg text-zinc-500 hover:text-indigo-400 hover:border-indigo-500/50 hover:bg-zinc-900/50 transition-all font-medium text-sm"
                >
                    <Plus className="h-6 w-6" />
                    Connect New Server
                </button>
            </div>

            {showAdd && <AddServerModal onClose={() => setShowAdd(false)} />}
        </div>
    );
}

function ServerCard({ server }) {
    const [deleting, setDeleting] = useState(false);

    const handleDelete = async () => {
        if (!confirm(`Remove server "${server.name}"?`)) return;
        setDeleting(true);
        await deleteMCPServer(server.name);
        setDeleting(false);
    };

    const isConnected = server.status === 'enabled' || server.status === 'connected'; // 'connected' maps to enabled in our simplified view

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col justify-between gap-3 group relative">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-indigo-400" />
                    <h3 className="font-medium text-white capitalize">{server.name}</h3>
                </div>
                <div className={clsx("flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border",
                    isConnected ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"
                )}>
                    {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {server.status}
                </div>
            </div>

            <div className="flex items-end justify-between">
                <div className="text-xs text-zinc-500 font-mono">
                    {server.type || 'SSE'}
                </div>

                <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                >
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
            </div>
        </div>
    );
}

function AddServerModal({ onClose }) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(null);

    const handleSubmit = async (formData) => {
        setPending(true);
        setError(null);

        const res = await addMCPServer(null, formData);

        if (res.success) {
            onClose();
        } else {
            setError(res.error);
            setPending(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md p-6 shadow-2xl space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-white">Connect MCP Server</h3>
                    <button onClick={onClose} className="text-zinc-500 hover:text-white">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <form action={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-1">Server Name</label>
                        <input
                            name="name"
                            type="text"
                            placeholder="e.g. MacBook Bridge"
                            required
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-1">SSE URL</label>
                        <input
                            name="url"
                            type="url"
                            placeholder="http://100.x.y.z:3000/sse"
                            required
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                        <p className="text-xs text-zinc-500 mt-1">
                            Your Tailscale IP address.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-1">Auth Token (Optional)</label>
                        <input
                            name="token"
                            type="password"
                            placeholder="Secret Token"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                    </div>

                    {error && (
                        <div className="text-sm text-red-400 bg-red-500/10 p-2 rounded border border-red-500/20">
                            {error}
                        </div>
                    )}

                    <div className="flex gap-3 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 px-4 py-2 rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-800 text-sm font-medium"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={pending}
                            className="flex-1 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium flex items-center justify-center gap-2"
                        >
                            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                            Connect
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
