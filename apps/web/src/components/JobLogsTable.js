'use client';

import { useState, useEffect } from 'react';
import { fetchAPI } from '@/lib/api';
import { Clock, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

export default function JobLogsTable() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);

    const loadLogs = async () => {
        setLoading(true);
        try {
            const data = await fetchAPI('/v1/internal/logs/jobs?limit=50');
            setLogs(data.logs || []);
        } catch (err) {
            console.error('Failed to load job logs:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLogs();
        const interval = setInterval(loadLogs, 30000); // Poll every 30s
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-indigo-400" />
                    Recent Job Executions
                </h3>
                <button
                    onClick={loadLogs}
                    className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="overflow-x-auto max-h-[500px]">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs sticky top-0">
                        <tr>
                            <th className="px-6 py-3">Status</th>
                            <th className="px-6 py-3">Job Name</th>
                            <th className="px-6 py-3">Output</th>
                            <th className="px-6 py-3 text-right">Duration</th>
                            <th className="px-6 py-3 text-right">Time</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {logs.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-zinc-500">
                                    No job logs found.
                                </td>
                            </tr>
                        ) : (
                            logs.map((log) => (
                                <tr key={log.id} className="hover:bg-zinc-800/50 transition-colors">
                                    <td className="px-6 py-4">
                                        {log.status === 'success' ? (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500">
                                                <CheckCircle className="w-3 h-3" />
                                                Success
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-500">
                                                <XCircle className="w-3 h-3" />
                                                Failed
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-zinc-300">{log.job_name}</td>
                                    <td className="px-6 py-4 max-w-md">
                                        <div className="line-clamp-2 text-zinc-400 font-mono text-xs">
                                            {log.output || '-'}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right text-zinc-400 font-mono">
                                        {log.duration_ms}ms
                                    </td>
                                    <td className="px-6 py-4 text-right text-zinc-500 whitespace-nowrap">
                                        {new Date(log.timestamp).toLocaleString(undefined, {
                                            month: 'short', day: 'numeric',
                                            hour: '2-digit', minute: '2-digit'
                                        })}
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
