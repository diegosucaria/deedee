'use client';

import { useState, useEffect } from 'react';
import { getJobLogs, deleteJobLogs } from '@/app/actions';
import { Clock, CheckCircle, XCircle, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import LogContent from './LogContent';



export default function JobLogsTable() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const LIMIT = 50;

    // Filters & Sorting
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [filterName, setFilterName] = useState('');
    const [filterStatus, setFilterStatus] = useState('all'); // all, success, failure
    const [sortConfig, setSortConfig] = useState({ key: 'timestamp', direction: 'desc' });

    const loadLogs = async () => {
        setLoading(true);
        try {
            // Note: Server-side pagination means we only get one page.
            // Client-side filtering/sorting ON TOP OF server-side pagination is tricky/broken
            // without full server-side support for filters/sorts.
            // For now, I will assume basic pagination for the raw stream,
            // AND client-side filtering limited to the CURRENT page (which is standard for simple MVPs),
            // OR I should fetch *all* for client-side ops?
            // "Add pagination" usually implies server-side to handle large datasets.
            // But if I do server-side pagination, my client-side filters (filterName) only filter the current page!
            // Given the constraints and the user request, I will implement pagination fetching.

            const data = await getJobLogs(page, LIMIT);
            setLogs(data.logs || []);
            setTotalPages(Math.ceil((data.total || 0) / LIMIT));
        } catch (err) {
            console.error('Failed to load job logs:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLogs();
        const interval = setInterval(loadLogs, 10000); // Poll every 10s
        return () => clearInterval(interval);
    }, [page]); // Reload when page changes

    const handleDeleteSelected = async () => {
        if (!confirm(`Delete ${selectedIds.size} logs?`)) return;
        setLoading(true); // Re-use loading state or add specific one
        try {
            await deleteJobLogs(Array.from(selectedIds));
            setSelectedIds(new Set());
            await loadLogs();
        } catch (err) {
            console.error('Failed to delete logs:', err);
        } finally {
            setLoading(false);
        }
    };

    const toggleSelection = (id) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedIds(next);
    };

    const toggleAll = () => {
        if (selectedIds.size === filteredLogs.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredLogs.map(l => l.id)));
        }
    };

    const handleSort = (key) => {
        setSortConfig(current => ({
            key,
            direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc'
        }));
    };

    // Filter & Sort Logic
    const filteredLogs = logs.filter(log => {
        const matchesName = log.job_name.toLowerCase().includes(filterName.toLowerCase());
        const matchesStatus = filterStatus === 'all' || log.status === filterStatus;
        return matchesName && matchesStatus;
    }).sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-zinc-800 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                        <Clock className="w-5 h-5 text-indigo-400" />
                        Recent Job Executions
                    </h3>
                    <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                            <button
                                onClick={handleDeleteSelected}
                                className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
                            >
                                <XCircle className="w-4 h-4" />
                                Delete ({selectedIds.size})
                            </button>
                        )}
                        <button
                            onClick={loadLogs}
                            className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder="Filter by Job Name"
                        value={filterName}
                        onChange={(e) => setFilterName(e.target.value)}
                        className="bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50"
                    />
                    <select
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        className="bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500/50"
                    >
                        <option value="all">All Status</option>
                        <option value="success">Success</option>
                        <option value="failure">Failed</option>
                    </select>
                </div>
            </div>

            {/* Pagination Controls */}
            <div className="p-4 border-t border-zinc-800 flex items-center justify-between">
                <div className="text-xs text-zinc-500">
                    Page {page} of {totalPages}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1 || loading}
                        className="p-1.5 hover:bg-zinc-800 rounded disabled:opacity-50 text-zinc-400"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages || loading}
                        className="p-1.5 hover:bg-zinc-800 rounded disabled:opacity-50 text-zinc-400"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-sm text-left relative">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs sticky top-0 z-10 shadow-sm border-b border-zinc-800">
                        <tr>
                            <th className="px-4 py-3 w-[40px]">
                                <input
                                    type="checkbox"
                                    className="rounded border-zinc-700 bg-zinc-900"
                                    checked={filteredLogs.length > 0 && selectedIds.size === filteredLogs.length}
                                    onChange={toggleAll}
                                />
                            </th>
                            <th className="px-6 py-3 w-[120px] cursor-pointer hover:text-zinc-300" onClick={() => handleSort('status')}>Status</th>
                            <th className="px-6 py-3 w-[200px] cursor-pointer hover:text-zinc-300" onClick={() => handleSort('job_name')}>Job Name</th>
                            <th className="px-6 py-3 min-w-[300px]">Output</th>
                            <th className="px-6 py-3 w-[100px] text-right cursor-pointer hover:text-zinc-300" onClick={() => handleSort('duration_ms')}>Duration</th>
                            <th className="px-6 py-3 w-[180px] text-right cursor-pointer hover:text-zinc-300" onClick={() => handleSort('timestamp')}>Time</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
                        {filteredLogs.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-12 text-center text-zinc-500">
                                    No job logs found.
                                </td>
                            </tr>
                        ) : (
                            filteredLogs.map((log) => (
                                <tr key={log.id} className={`hover:bg-zinc-800/50 transition-colors group ${selectedIds.has(log.id) ? 'bg-indigo-500/5 hover:bg-indigo-500/10' : ''}`}>
                                    <td className="px-4 py-4 align-top">
                                        <input
                                            type="checkbox"
                                            className="rounded border-zinc-700 bg-zinc-900"
                                            checked={selectedIds.has(log.id)}
                                            onChange={() => toggleSelection(log.id)}
                                        />
                                    </td>
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
