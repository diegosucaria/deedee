'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getJobLogs, deleteJobLogs } from '@/app/actions';
import { Clock, CheckCircle, XCircle, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import LogContent from './LogContent';
import { useSocket } from '@/hooks/useSocket';



function formatDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

export default function JobLogsTable() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [totalCount, setTotalCount] = useState(0);
    const [pageSize, setPageSize] = useState(25);

    // Filters & Sorting
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [filterName, setFilterName] = useState('');
    const [filterStatus, setFilterStatus] = useState('all'); // all, success, failure
    const [sortConfig, setSortConfig] = useState({ key: 'timestamp', direction: 'desc' });

    const loadLogs = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getJobLogs(page, pageSize, {
                search: filterName || undefined,
                status: filterStatus,
            });
            setLogs(data.logs || []);
            setTotalCount(data.total || 0);
        } catch (err) {
            console.error('Failed to load job logs:', err);
        } finally {
            setLoading(false);
        }
    }, [page, pageSize, filterName, filterStatus]);

    const { socket } = useSocket();

    // Debounce filter changes to avoid firing on every keystroke
    const debounceRef = useRef(null);
    useEffect(() => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            loadLogs();
        }, filterName ? 300 : 0); // instant for non-search changes
        const interval = setInterval(loadLogs, 30000);
        return () => { clearInterval(interval); clearTimeout(debounceRef.current); };
    }, [loadLogs]);

    // Live update: refresh when scheduler emits job completion
    useEffect(() => {
        if (!socket) return;
        const handler = () => loadLogs();
        socket.on('joblog:update', handler);
        return () => socket.off('joblog:update', handler);
    }, [socket]);

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
        if (selectedIds.size === sortedLogs.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(sortedLogs.map(l => l.id)));
        }
    };

    const handleSort = (key) => {
        setSortConfig(current => ({
            key,
            direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc'
        }));
    };

    // Sort (filtering is now server-side)
    const sortedLogs = [...logs].sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
            <div className="p-3 md:p-4 border-b border-zinc-800 flex flex-col gap-3 md:gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-base md:text-lg font-semibold text-zinc-300 flex items-center gap-2">
                        <Clock className="w-5 h-5 shrink-0 text-indigo-400" />
                        Recent Job Executions
                    </h3>
                    <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                            <button
                                onClick={handleDeleteSelected}
                                className="px-2 md:px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 md:gap-2"
                            >
                                <XCircle className="w-4 h-4" />
                                ({selectedIds.size})
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
                <div className="flex flex-wrap gap-2">
                    <input
                        type="text"
                        placeholder="Search by Job Name"
                        value={filterName}
                        onChange={(e) => { setFilterName(e.target.value); setPage(1); }}
                        className="bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 min-w-0 flex-1 sm:flex-none"
                    />
                    <select
                        value={filterStatus}
                        onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
                        className="bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500/50"
                    >
                        <option value="all">All Status</option>
                        <option value="success">Success</option>
                        <option value="failure">Failed</option>
                    </select>
                </div>
            </div>

            <div className="overflow-x-auto scrollbar-hide max-h-[600px]">
                <table className="w-full text-sm text-left relative min-w-[800px]">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs sticky top-0 z-10 shadow-sm border-b border-zinc-800">
                        <tr>
                            <th className="px-4 py-3 w-[40px]">
                                <input
                                    type="checkbox"
                                    className="rounded border-zinc-700 bg-zinc-900"
                                    checked={sortedLogs.length > 0 && selectedIds.size === sortedLogs.length}
                                    onChange={toggleAll}
                                />
                            </th>
                            <th className="px-6 py-3 w-[120px] cursor-pointer hover:text-zinc-300" onClick={() => handleSort('status')}>Status</th>
                            <th className="px-6 py-3 w-[200px] cursor-pointer hover:text-zinc-300" onClick={() => handleSort('job_name')}>Job Name</th>
                            <th className="px-6 py-3 min-w-[300px]">Output</th>
                            <th className="px-6 py-3 w-[80px] text-right cursor-pointer hover:text-zinc-300" onClick={() => handleSort('cost')}>Cost</th>
                            <th className="px-6 py-3 w-[100px] text-right cursor-pointer hover:text-zinc-300" onClick={() => handleSort('duration_ms')}>Duration</th>
                            <th className="px-6 py-3 w-[180px] text-right cursor-pointer hover:text-zinc-300" onClick={() => handleSort('timestamp')}>Time</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 bg-zinc-900/50">
                        {sortedLogs.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center text-zinc-500">
                                    No job logs found.
                                </td>
                            </tr>
                        ) : (
                            sortedLogs.map((log) => (
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
                                    <td className="px-6 py-4 align-top text-right font-mono text-xs">
                                        {log.cost > 0 ? (
                                            <span className="text-red-400">${Number(log.cost).toFixed(4)}</span>
                                        ) : (
                                            <span className="text-zinc-600">-</span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-400 font-mono text-xs">
                                        {formatDuration(log.duration_ms)}
                                    </td>
                                    <td className="px-6 py-4 align-top text-right text-zinc-500 text-xs whitespace-nowrap">
                                        {new Date(log.timestamp.endsWith('Z') ? log.timestamp : log.timestamp + 'Z').toLocaleString(undefined, {
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

            {/* Pagination */}
            {totalCount > 0 && (
                <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                        <span>{totalCount} total</span>
                        <select
                            value={pageSize}
                            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                            className="bg-black border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-400 focus:outline-none focus:border-indigo-500/50"
                        >
                            <option value={10}>10 / page</option>
                            <option value={25}>25 / page</option>
                            <option value={50}>50 / page</option>
                            <option value={100}>100 / page</option>
                        </select>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-500">
                            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount}
                        </span>
                        <button
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={page === 1 || loading}
                            className="p-1.5 hover:bg-zinc-800 rounded disabled:opacity-50 text-zinc-400 transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setPage(p => Math.min(Math.ceil(totalCount / pageSize), p + 1))}
                            disabled={page >= Math.ceil(totalCount / pageSize) || loading}
                            className="p-1.5 hover:bg-zinc-800 rounded disabled:opacity-50 text-zinc-400 transition-colors"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
