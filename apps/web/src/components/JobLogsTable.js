'use client';

import { useState, useEffect } from 'react';
import { fetchAPI } from '@/lib/api';
import { Clock, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

const LogContent = ({ content }) => {
    const [expanded, setExpanded] = useState(false);

    if (!content) return <span className="text-zinc-500">-</span>;

    // Try parsing as JSON
    let jsonString = null;
    try {
        const parsed = JSON.parse(content);
        // Only treat as JSON if it's an object or array, not just a number/boolean
        if (typeof parsed === 'object' && parsed !== null) {
            jsonString = JSON.stringify(parsed, null, 2);
        }
    } catch (e) { }

    if (jsonString) {
        return (
            <details className="group">
                <summary className="cursor-pointer text-xs text-indigo-400 hover:text-indigo-300 font-mono list-none flex items-center gap-2 select-none">
                    <span className="bg-indigo-500/10 border border-indigo-500/20 px-1 rounded text-[10px] font-bold">JSON</span>
                    <span className="opacity-50 truncate max-w-[200px]">{content.substring(0, 50)}...</span>
                </summary>
                <div className="mt-2 relative">
                    <pre className="p-3 bg-black/50 rounded-lg border border-white/10 text-[10px] text-zinc-300 overflow-x-auto whitespace-pre font-mono shadow-inner">
                        {jsonString}
                    </pre>
                </div>
            </details>
        );
    }

    return (
        <div
            onClick={() => setExpanded(!expanded)}
            className={`text-zinc-400 font-mono text-xs cursor-pointer hover:bg-white/5 p-1.5 -m-1.5 rounded transition-colors break-words whitespace-pre-wrap ${expanded ? '' : 'line-clamp-2'}`}
            title={expanded ? "Click to collapse" : "Click to expand"}
        >
            {content}
        </div>
    );
};

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

            <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-sm text-left relative">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs sticky top-0 z-10 shadow-sm border-b border-zinc-800">
                        <tr>
                            <th className="px-6 py-3 w-[120px]">Status</th>
                            <th className="px-6 py-3 w-[200px]">Job Name</th>
                            <th className="px-6 py-3 min-w-[300px]">Output</th>
                            <th className="px-6 py-3 w-[100px] text-right">Duration</th>
                            <th className="px-6 py-3 w-[180px] text-right">Time</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
                        {logs.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-zinc-500">
                                    No job logs found.
                                </td>
                            </tr>
                        ) : (
                            logs.map((log) => (
                                <tr key={log.id} className="hover:bg-zinc-800/50 transition-colors group">
                                    <td className="px-6 py-4 align-top">
                                        {log.status === 'success' ? (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/10">
                                                <CheckCircle className="w-3 h-3" />
                                                Success
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/10">
                                                <XCircle className="w-3 h-3" />
                                                Failed
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 align-top font-mono text-zinc-300 text-xs">
                                        {log.job_name}
                                    </td>
                                    <td className="px-6 py-4 align-top max-w-xl">
                                        <LogContent content={log.output} />
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-400 font-mono text-xs">
                                        {log.duration_ms}ms
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-500 text-xs whitespace-nowrap">
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
