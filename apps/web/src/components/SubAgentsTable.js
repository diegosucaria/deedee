'use client';

import { useState, useEffect, Fragment, useMemo } from 'react';
import { getSubAgentTasks, cleanupSubAgentTasks } from '@/app/actions';
import { RefreshCw, Bot, Trash2, ChevronDown, ChevronUp, ChevronRight, ChevronLeft } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';

const STATUS_STYLES = {
    running: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
    timeout: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

const GROUP_COLORS = [
    'border-violet-500/60',
    'border-sky-500/60',
    'border-amber-500/60',
    'border-emerald-500/60',
    'border-rose-500/60',
    'border-teal-500/60',
    'border-orange-500/60',
    'border-indigo-500/60',
];

const GROUP_DOT_COLORS = [
    'bg-violet-500',
    'bg-sky-500',
    'bg-amber-500',
    'bg-emerald-500',
    'bg-rose-500',
    'bg-teal-500',
    'bg-orange-500',
    'bg-indigo-500',
];

function StatusBadge({ status }) {
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase border ${STATUS_STYLES[status] || 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
            {status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse mr-1.5" />}
            {status}
        </span>
    );
}

function getDuration(createdAt, completedAt) {
    if (!createdAt) return '-';
    const start = new Date(createdAt);
    const end = completedAt ? new Date(completedAt) : new Date();
    const diffMs = end - start;
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSec = seconds % 60;
    return `${minutes}m ${remainingSec}s`;
}

function formatTriggerSource(parentId) {
    if (!parentId) return 'Unknown';
    if (parentId.startsWith('system_')) {
        const parts = parentId.split('_');
        parts.shift();
        parts.pop();
        return `System Job: ${parts.join('_')}`;
    }
    if (parentId.startsWith('scheduled_')) {
        const parts = parentId.split('_');
        parts.shift();
        parts.pop();
        return `Scheduled Job: ${parts.join('_')}`;
    }
    if (parentId.includes('@')) return `Chat: ${parentId.split('@')[0]}`;
    if (parentId.length > 15) return `Chat: ${parentId.slice(0, 8)}…`;
    return `Chat: ${parentId}`;
}

function getJobName(parentId) {
    if (!parentId) return 'unknown';
    if (parentId.startsWith('system_') || parentId.startsWith('scheduled_')) {
        const parts = parentId.split('_');
        parts.shift();
        parts.pop();
        return parts.join('_');
    }
    return parentId;
}

function groupTasks(tasks) {
    const groups = [];
    const groupMap = new Map();

    for (const task of tasks) {
        const key = task.parent_chat_id || 'unknown';
        if (!groupMap.has(key)) {
            const group = { key, label: formatTriggerSource(key), jobName: getJobName(key), tasks: [] };
            groupMap.set(key, group);
            groups.push(group);
        }
        groupMap.get(key).tasks.push(task);
    }

    return groups;
}

function getGroupTotals(group) {
    const totalCost = group.tasks.reduce((sum, t) => sum + (t.cost || 0), 0);
    const timestamps = group.tasks
        .filter(t => t.created_at)
        .map(t => ({
            start: new Date(t.created_at),
            end: t.completed_at ? new Date(t.completed_at) : new Date(),
        }));
    let wallDurationMs = 0;
    if (timestamps.length > 0) {
        const earliest = Math.min(...timestamps.map(t => t.start.getTime()));
        const latest = Math.max(...timestamps.map(t => t.end.getTime()));
        wallDurationMs = latest - earliest;
    }
    return { totalCost, wallDurationMs };
}

function formatDurationMs(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSec = seconds % 60;
    return `${minutes}m ${remainingSec}s`;
}

function GroupStatusSummary({ group }) {
    const running = group.tasks.filter(t => t.status === 'running').length;
    const completed = group.tasks.filter(t => t.status === 'completed').length;
    const failed = group.tasks.filter(t => t.status === 'failed' || t.status === 'timeout').length;
    const parts = [];
    if (running > 0) parts.push(<span key="r" className="text-sky-400">{running} running</span>);
    if (completed > 0) parts.push(<span key="c" className="text-emerald-400">{completed} done</span>);
    if (failed > 0) parts.push(<span key="f" className="text-red-400">{failed} failed</span>);
    return (
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            {parts.reduce((acc, el, i) => {
                if (i > 0) acc.push(<span key={`sep-${i}`} className="text-zinc-700">·</span>);
                acc.push(el);
                return acc;
            }, [])}
        </span>
    );
}

export default function SubAgentsTable() {
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState(null);
    const [expandedGroups, setExpandedGroups] = useState(new Set());
    const [cleaning, setCleaning] = useState(false);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(0);
    const [total, setTotal] = useState(0);
    const PAGE_SIZE = 50;
    const { socket } = useSocket();

    const loadTasks = async (p = page) => {
        setLoading(true);
        try {
            const data = await getSubAgentTasks({ page: p, limit: PAGE_SIZE });
            setTasks(data.tasks || []);
            setTotalPages(data.totalPages || 0);
            setTotal(data.total || 0);
        } catch (err) {
            console.error('Failed to load sub-agent tasks:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTasks(page);
        const interval = setInterval(() => loadTasks(page), 30000);
        return () => clearInterval(interval);
    }, [page]);

    // Live update: refresh when agent emits sub-agent status change
    useEffect(() => {
        if (!socket) return;
        const handler = () => loadTasks(page);
        socket.on('subagent:update', handler);
        return () => socket.off('subagent:update', handler);
    }, [socket, page]);

    const handleCleanup = async () => {
        setCleaning(true);
        try {
            await cleanupSubAgentTasks();
            setPage(1);
            await loadTasks(1);
        } catch (err) {
            console.error('Failed to cleanup:', err);
        } finally {
            setCleaning(false);
        }
    };

    const toggleGroup = (key) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const groups = useMemo(() => groupTasks(tasks), [tasks]);
    const hasMultipleGroups = groups.length > 1;
    const hasCompleted = tasks.some(t => t.status !== 'running');

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-3 md:p-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base md:text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Bot className="w-5 h-5 shrink-0 text-violet-400" />
                    Sub-Agent Tasks
                    {tasks.filter(t => t.status === 'running').length > 0 && (
                        <span className="text-xs bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded-full font-bold">
                            {tasks.filter(t => t.status === 'running').length} running
                        </span>
                    )}
                </h3>
                <div className="flex gap-2">
                    {hasCompleted && (
                        <button
                            onClick={handleCleanup}
                            disabled={cleaning}
                            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Cleanup
                        </button>
                    )}
                    <button
                        onClick={loadTasks}
                        className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto scrollbar-hide">
                <table className="w-full text-sm text-left min-w-[600px]">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-4 py-3">Task</th>
                            <th className="px-4 py-3 w-[100px]">Status</th>
                            <th className="px-4 py-3 w-[80px]">Model</th>
                            <th className="px-4 py-3 w-[80px]">Cost</th>
                            <th className="px-4 py-3 w-[90px]">Duration</th>
                            <th className="px-4 py-3 w-[40px]"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {tasks.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                                    No sub-agent tasks found. Sub-agents are spawned by the main agent during complex tasks.
                                </td>
                            </tr>
                        ) : (
                            groups.map((group, groupIdx) => {
                                const colorIdx = groupIdx % GROUP_COLORS.length;
                                const borderColor = GROUP_COLORS[colorIdx];
                                const dotColor = GROUP_DOT_COLORS[colorIdx];
                                const isCollapsed = !expandedGroups.has(group.key);
                                const isSingleTask = group.tasks.length === 1;
                                const showGroupHeader = (hasMultipleGroups || groups.length === 1) && !isSingleTask;
                                const { totalCost, wallDurationMs } = showGroupHeader ? getGroupTotals(group) : { totalCost: 0, wallDurationMs: 0 };

                                return (
                                    <Fragment key={group.key}>
                                        {/* Group header row — uses individual cells to align with column headers */}
                                        {showGroupHeader && (
                                            <tr
                                                className={`bg-zinc-950/80 hover:bg-zinc-800/40 transition-colors cursor-pointer border-l-2 ${borderColor}`}
                                                onClick={() => toggleGroup(group.key)}
                                            >
                                                <td className="px-4 py-2">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-zinc-500 transition-transform duration-150" style={{ transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
                                                            <ChevronRight className="w-3.5 h-3.5" />
                                                        </span>
                                                        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                                                        <span className="text-xs font-semibold text-zinc-400">{group.label}</span>
                                                        <span className="text-[11px] text-zinc-600 font-mono">{group.tasks.length} tasks</span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-2">
                                                    <GroupStatusSummary group={group} />
                                                </td>
                                                <td className="px-4 py-2"></td>
                                                <td className="px-4 py-2">
                                                    {totalCost > 0 && (
                                                        <span className="text-xs font-mono text-red-400">${totalCost.toFixed(4)}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2">
                                                    {wallDurationMs > 0 && (
                                                        <span className="text-xs font-mono text-zinc-400">{formatDurationMs(wallDurationMs)}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2"></td>
                                            </tr>
                                        )}
                                        {/* Task rows */}
                                        {(!isCollapsed || isSingleTask) && group.tasks.map((task) => (
                                            <Fragment key={task.id}>
                                                <tr
                                                    className={`hover:bg-zinc-800/50 transition-colors cursor-pointer group ${!isSingleTask ? `border-l-2 ${borderColor}` : ''}`}
                                                    onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                                                >
                                                    <td className="px-4 py-3">
                                                        <div className="flex flex-col">
                                                            <span className="text-zinc-300 line-clamp-1">{task.task}</span>
                                                            <span className="text-[10px] text-zinc-600 font-mono mt-0.5">
                                                                {task.id} • {isSingleTask ? formatTriggerSource(task.parent_chat_id) + ' • ' : ''}Started: {task.created_at ? new Date(task.created_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + new Date(task.created_at).toLocaleTimeString() : '-'}
                                                            </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <StatusBadge status={task.status} />
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className={`text-xs font-mono ${task.model === 'PRO' ? 'text-amber-400' : 'text-zinc-400'}`}>
                                                            {task.model || 'FLASH'}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        {task.cost > 0 ? (
                                                            <span className="text-xs font-mono text-red-400">${task.cost.toFixed(4)}</span>
                                                        ) : (
                                                            <span className="text-xs font-mono text-zinc-600">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3 text-zinc-400 text-xs font-mono">
                                                        {getDuration(task.created_at, task.completed_at)}
                                                    </td>
                                                    <td className="px-4 py-3 text-zinc-500 w-[48px] text-center">
                                                        <div className="flex items-center justify-center">
                                                            {expandedId === task.id
                                                                ? <ChevronUp className="w-4 h-4" />
                                                                : <ChevronDown className="w-4 h-4" />
                                                            }
                                                        </div>
                                                    </td>
                                                </tr>
                                                {expandedId === task.id && (
                                                    <tr key={`${task.id}-detail`}>
                                                        <td colSpan={6} className={`px-4 py-3 bg-zinc-950 ${!isSingleTask ? `border-l-2 ${borderColor}` : ''}`}>
                                                            <div className="space-y-4">
                                                                {(task.cost > 0 || task.tokens > 0) && (
                                                                    <div className="flex gap-4">
                                                                        <div className="px-3 py-2 rounded bg-zinc-900 border border-zinc-800">
                                                                            <span className="text-[10px] uppercase text-zinc-500 font-bold block">Cost</span>
                                                                            <span className="text-sm font-mono text-red-400">${task.cost?.toFixed(4) || '0.0000'}</span>
                                                                        </div>
                                                                        <div className="px-3 py-2 rounded bg-zinc-900 border border-zinc-800">
                                                                            <span className="text-[10px] uppercase text-zinc-500 font-bold block">Tokens</span>
                                                                            <span className="text-sm font-mono text-sky-400">{task.tokens?.toLocaleString() || 0}</span>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-[10px] uppercase text-zinc-500 font-bold">Triggered by</span>
                                                                    <span className="text-xs text-zinc-300 font-mono">{formatTriggerSource(task.parent_chat_id)}</span>
                                                                </div>
                                                                <div>
                                                                    <span className="text-[10px] uppercase text-zinc-500 font-bold">Task</span>
                                                                    <pre className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900/80 p-3 rounded-lg border border-zinc-800/80 overflow-y-auto max-h-32">
                                                                        {task.task}
                                                                    </pre>
                                                                </div>
                                                                {task.result && (
                                                                    <div>
                                                                        <span className="text-[10px] uppercase text-zinc-500 font-bold">Result</span>
                                                                        <pre className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-900 p-3 rounded-lg border border-zinc-800 max-h-48 overflow-y-auto">
                                                                            {task.result}
                                                                        </pre>
                                                                    </div>
                                                                )}
                                                                {task.error && (
                                                                    <div>
                                                                        <span className="text-[10px] uppercase text-red-500 font-bold">Error</span>
                                                                        <pre className="mt-1 text-xs text-red-400 whitespace-pre-wrap bg-red-950/20 p-3 rounded-lg border border-red-900/30">
                                                                            {task.error}
                                                                        </pre>
                                                                    </div>
                                                                )}
                                                                <div className="flex gap-4 text-[10px] text-zinc-600">
                                                                    <span>Created: {task.created_at ? new Date(task.created_at).toLocaleString() : '-'}</span>
                                                                    <span>Completed: {task.completed_at ? new Date(task.completed_at).toLocaleString() : '-'}</span>
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        ))}
                                    </Fragment>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
                    <span className="text-xs text-zinc-500">
                        {total} total · Page {page} of {totalPages}
                    </span>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={page <= 1}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
