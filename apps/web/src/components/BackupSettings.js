'use client';

import { useState } from 'react';
import { Archive, Download, Clock, Database, RefreshCw, AlertCircle } from 'lucide-react';
import { triggerBackup } from '@/app/actions';
import { useRouter } from 'next/navigation';

export default function BackupSettings({ backups = [] }) {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null);
    const router = useRouter();

    const handleBackup = async () => {
        setLoading(true);
        setMessage(null);
        try {
            const res = await triggerBackup();
            if (res.success) {
                setMessage({ type: 'success', text: `Backup created: ${res.file}` });
                router.refresh();
            } else {
                setMessage({ type: 'error', text: res.error || 'Backup failed' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: e.message });
        } finally {
            setLoading(false);
        }
    };

    const formatSize = (bytes) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-500/10 rounded-lg">
                        <Database className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold text-white">System Backups</h2>
                        <p className="text-sm text-zinc-400">
                            {backups.length > 0 ? `Last backup: ${new Date(backups[0].updated).toLocaleString()}` : 'No backups found'}
                        </p>
                    </div>
                </div>
                <button
                    onClick={handleBackup}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                    {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                    {loading ? 'Backing up...' : 'Backup Now'}
                </button>
            </div>

            {message && (
                <div className={`p-4 text-sm flex items-center gap-2 border-b border-zinc-800 ${message.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                    <AlertCircle className="w-4 h-4" />
                    {message.text}
                </div>
            )}

            <div className="p-0">
                {backups.length === 0 ? (
                    <div className="p-8 text-center text-zinc-500 text-sm">
                        No backups available. Configure GCS credentials to enable cloud backups.
                    </div>
                ) : (
                    <div className="divide-y divide-zinc-800 max-h-60 overflow-y-auto">
                        {backups.map((backup) => (
                            <div key={backup.name} className="flex items-center justify-between p-4 hover:bg-zinc-800/50 transition-colors">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-zinc-800 rounded text-zinc-400">
                                        <Clock className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium text-zinc-200">{backup.name}</div>
                                        <div className="text-xs text-zinc-500">{new Date(backup.updated).toLocaleString()}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <span className="text-xs font-mono text-zinc-500">{formatSize(backup.size)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
