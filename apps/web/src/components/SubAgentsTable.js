'use client';

import { useState, useEffect, Fragment } from 'react';
import { getSubAgentTasks, cleanupSubAgentTasks } from '@/app/actions';
import { RefreshCw, Bot, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';

const STATUS_STYLES = {
    running: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20',
    timeout: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

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

export default function SubAgentsTable() {
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState(null);
    const [cleaning, setCleaning] = useState(false);
    const { socket } = useSocket();

    const loadTasks = async () => {
        setLoading(true);
        try {
            const data = await getSubAgentTasks();
            setTasks(data.tasks || []);
        } catch (err) {
            console.error('Failed to load sub-agent tasks:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTasks();
        const interval = setInterval(loadTasks, 10000);
        return () => clearInterval(interval);
    }, []);

    // Live update: refresh when agent emits sub-agent status change
    useEffect(() => {
        if (!socket) return;
        const handler = () => loadTasks();
        socket.on('subagent:update', handler);
        return () => socket.off('subagent:update', handler);
    }, [socket]);

    const handleCleanup = async () => {
        setCleaning(true);
        try {
            await cleanupSubAgentTasks();
            await loadTasks();
        } catch (err) {
            console.error('Failed to cleanup:', err);
        } finally {
            setCleaning(false);
        }
    };

    const hasCompleted = tasks.some(t => t.status !== 'running');

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-zinc-300 flex items-center gap-2">
                    <Bot className="w-5 h-5 text-violet-400" />
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

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-xs">
                        <tr>
                            <th className="px-4 py-3">Task</th>
                            <th className="px-4 py-3 w-[100px]">Status</th>
                            <th className="px-4 py-3 w-[80px]">Model</th>
                            <th className="px-4 py-3 w-[90px]">Duration</th>
                            <th className="px-4 py-3 w-[40px]"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                        {tasks.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                                    No sub-agent tasks found. Sub-agents are spawned by the main agent during complex tasks.
                                </td>
                            </tr>
                        ) : (
                            tasks.map((task) => (
                                <Fragment key={task.id}>
                                    <tr
                                        className="hover:bg-zinc-800/50 transition-colors cursor-pointer group"
                                        onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex flex-col">
                                                <span className="text-zinc-300 line-clamp-1">{task.task}</span>
                                                <span className="text-[10px] text-zinc-600 font-mono mt-0.5">
                                                    {task.id} • {formatTriggerSource(task.parent_chat_id)} • Started: {task.created_at ? new Date(task.created_at).toLocaleTimeString() : '-'}
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
                                            <td colSpan={5} className="px-4 py-3 bg-zinc-950">
                                                <div className="space-y-4">
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
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
