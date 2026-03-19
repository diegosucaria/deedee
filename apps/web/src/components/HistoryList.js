'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Trash2, User, Bot, Wrench, Terminal, ArrowUpDown, Clock, Cpu, MessageSquare } from 'lucide-react';
import { deleteHistory } from '@/app/actions';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';

const SOURCE_OPTIONS = [
    { value: '', label: 'All Sources' },
    { value: 'web_chat', label: 'Web Chat' },
    { value: 'whatsapp', label: 'WhatsApp' },
    { value: 'subagent', label: 'Subagent' },
    { value: 'scheduled_job', label: 'Scheduled' },
    { value: 'system_job', label: 'System' },
];

export default function HistoryList({ history, subagent }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [timeOptions, setTimeOptions] = useState({ last24h: '', last7d: '' });

    useEffect(() => {
        const now = Date.now();
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTimeOptions({
            last24h: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            last7d: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
        });
    }, []);

    // Get current server params
    const currentOrder = searchParams.get('order') || 'desc';
    const currentSince = searchParams.get('since') || '';
    const currentSource = searchParams.get('source') || '';

    const updateParams = (key, value) => {
        const params = new URLSearchParams(searchParams);
        if (value) params.set(key, value);
        else params.delete(key);
        router.push(`${pathname}?${params.toString()}`);
    };

    // Group by Date using Map to preserve order
    const grouped = history.reduce((acc, msg) => {
        const date = new Date(msg.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        if (!acc.has(date)) acc.set(date, []);
        acc.get(date).push(msg);
        return acc;
    }, new Map());

    const handleDelete = async (id) => {
        if (confirm('Delete this message log?')) {
            await deleteHistory(id);
            router.refresh();
        }
    };

    return (
        <div className="space-y-6">
            {/* Subagent banner */}
            {subagent && (
                <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 flex items-start gap-3">
                    <Cpu className="w-5 h-5 text-indigo-400 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-semibold text-indigo-300">Subagent</span>
                            <span className={clsx(
                                "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase",
                                subagent.status === 'completed' && "bg-emerald-500/20 text-emerald-400",
                                subagent.status === 'running' && "bg-amber-500/20 text-amber-400",
                                subagent.status === 'failed' && "bg-red-500/20 text-red-400"
                            )}>
                                {subagent.status}
                            </span>
                            {subagent.model && (
                                <span className="text-[10px] text-zinc-500">{subagent.model}</span>
                            )}
                        </div>
                        <p className="text-sm text-zinc-300 line-clamp-3">{subagent.task}</p>
                        {subagent.parent_chat_id && (
                            <a
                                href={`/system/history?chatId=${encodeURIComponent(subagent.parent_chat_id)}`}
                                className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 inline-block"
                            >
                                View parent session
                            </a>
                        )}
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-col md:flex-row justify-between items-end md:items-center gap-4 border-b border-zinc-800 pb-4">
                <div className="flex items-center gap-3 flex-wrap">
                    {/* Time Filter */}
                    <label className="flex items-center gap-2 text-sm text-zinc-500">
                        <Clock className="w-4 h-4" />
                        <select
                            value={currentSince}
                            onChange={(e) => updateParams('since', e.target.value)}
                            className="bg-zinc-900 border border-zinc-800 text-zinc-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                            <option value="">All Time (Limit 100)</option>
                            <option value={timeOptions.last24h}>Last 24 Hours</option>
                            <option value={timeOptions.last7d}>Last 7 Days</option>
                        </select>
                    </label>

                    {/* Sort Order */}
                    <button
                        onClick={() => updateParams('order', currentOrder === 'desc' ? 'asc' : 'desc')}
                        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-lg transition-colors"
                    >
                        <ArrowUpDown className="w-4 h-4" />
                        {currentOrder === 'desc' ? 'Newest First' : 'Oldest First'}
                    </button>
                </div>

                {/* Source Filter (server-side) */}
                <label className="flex items-center gap-2 text-sm text-zinc-500">
                    Source:
                    <select
                        value={currentSource}
                        onChange={(e) => updateParams('source', e.target.value)}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                        {SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                </label>
            </div>

            {/* Messages */}
            <div className="space-y-12">
                {history.length === 0 && (
                    <div className="text-center text-zinc-500 py-12">
                        <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-50" />
                        <p>No messages found for this filter.</p>
                    </div>
                )}
                {Array.from(grouped.entries()).map(([date, messages]) => (
                    <div key={date}>
                        <div className="sticky top-0 z-10 flex justify-center mb-6">
                            <span className="bg-zinc-800 text-zinc-400 text-xs font-medium px-3 py-1 rounded-full border border-zinc-700 shadow-sm backdrop-blur-md">
                                {date}
                            </span>
                        </div>

                        <div className="space-y-6">
                            {messages.map((msg) => (
                                <div key={msg.id} className="relative group">
                                    <div className="flex gap-4 max-w-4xl mx-auto">
                                        {/* Avatar */}
                                        <div className={clsx(
                                            "flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center border",
                                            msg.role === 'user' && "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
                                            msg.role === 'assistant' && "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
                                            (msg.role === 'function' || msg.role === 'tool') && "bg-amber-500/10 border-amber-500/20 text-amber-400",
                                            msg.role === 'system' && "bg-zinc-800 border-zinc-700 text-zinc-500"
                                        )}>
                                            {msg.role === 'user' && <User className="w-5 h-5" />}
                                            {msg.role === 'assistant' && <Bot className="w-5 h-5" />}
                                            {(msg.role === 'function' || msg.role === 'tool') && <Wrench className="w-5 h-5" />}
                                            {msg.role === 'system' && <Terminal className="w-5 h-5" />}
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                <span className="text-sm font-semibold text-zinc-300 capitalize">
                                                    {msg.role}
                                                </span>
                                                <span className="text-xs text-zinc-600">
                                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                                </span>
                                                {msg.effective_source && (
                                                    <span className={clsx(
                                                        "text-[10px] px-1.5 py-0.5 rounded uppercase font-medium",
                                                        msg.effective_source === 'subagent' && "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20",
                                                        msg.effective_source === 'scheduled_job' && "bg-purple-500/10 text-purple-400 border border-purple-500/20",
                                                        msg.effective_source === 'system_job' && "bg-zinc-800 text-zinc-500 border border-zinc-700",
                                                        msg.effective_source === 'whatsapp' && "bg-green-500/10 text-green-400 border border-green-500/20",
                                                        msg.effective_source === 'web_chat' && "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                                    )}>
                                                        {msg.effective_source.replaceAll('_', ' ')}
                                                    </span>
                                                )}
                                                {msg.token_count > 0 && (
                                                    <span className="text-[10px] text-zinc-500 font-mono">
                                                        {msg.token_count}t {msg.cost ? `($${msg.cost.toFixed(4)})` : ''}
                                                    </span>
                                                )}
                                                {/* Session link */}
                                                {msg.session_title && msg.chat_id && (
                                                    <a href={`/chat/${encodeURIComponent(msg.chat_id)}`} className="text-[10px] text-zinc-500 hover:text-indigo-400 flex items-center gap-1 transition-colors" title={`Go to chat: ${msg.session_title}`}>
                                                        <span className='truncate max-w-[150px]'>{msg.session_title}</span>
                                                    </a>
                                                )}
                                                {msg.chat_id?.startsWith('subagent-') && !msg.session_title && (
                                                    <span className="text-[10px] text-zinc-600 font-mono truncate max-w-[200px]">
                                                        {msg.chat_id}
                                                    </span>
                                                )}
                                            </div>

                                            <div className="prose prose-invert prose-sm max-w-none text-zinc-400 bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
                                                {(() => {
                                                    // Try rendering structured parts (tool calls / responses)
                                                    if ((!msg.content || msg.content === '{}') && msg.parts) {
                                                        try {
                                                            const parts = typeof msg.parts === 'string' ? JSON.parse(msg.parts) : msg.parts;
                                                            if (Array.isArray(parts)) {
                                                                const hasToolParts = parts.some(p => p.functionCall || p.functionResponse);
                                                                if (hasToolParts) {
                                                                    return (
                                                                        <div className="space-y-3">
                                                                            {parts.map((p, i) => {
                                                                                if (p.functionCall) {
                                                                                    const argsStr = p.functionCall.args ? JSON.stringify(p.functionCall.args, null, 2) : null;
                                                                                    return (
                                                                                        <div key={i}>
                                                                                            <div className="text-xs font-medium text-amber-400/80">
                                                                                                Tool Call: <span className="text-amber-300 font-mono">{p.functionCall.name}</span>
                                                                                            </div>
                                                                                            {argsStr && argsStr !== '{}' && (
                                                                                                <details className="mt-1">
                                                                                                    <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400 select-none">
                                                                                                        Parameters
                                                                                                    </summary>
                                                                                                    <pre className="text-[11px] text-zinc-500 bg-zinc-950/60 p-2 rounded mt-1 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                                                                                                        {argsStr}
                                                                                                    </pre>
                                                                                                </details>
                                                                                            )}
                                                                                        </div>
                                                                                    );
                                                                                }
                                                                                if (p.functionResponse) {
                                                                                    const resp = p.functionResponse.response;
                                                                                    const respStr = resp ? JSON.stringify(resp, null, 2) : null;
                                                                                    return (
                                                                                        <div key={i}>
                                                                                            <div className="text-xs font-medium text-emerald-400/80">
                                                                                                Response: <span className="text-emerald-300 font-mono">{p.functionResponse.name}</span>
                                                                                            </div>
                                                                                            {respStr && (
                                                                                                <details className="mt-1">
                                                                                                    <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400 select-none">
                                                                                                        Result
                                                                                                    </summary>
                                                                                                    <pre className="text-[11px] text-zinc-500 bg-zinc-950/60 p-2 rounded mt-1 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                                                                                                        {respStr}
                                                                                                    </pre>
                                                                                                </details>
                                                                                            )}
                                                                                        </div>
                                                                                    );
                                                                                }
                                                                                if (p.text) return <ReactMarkdown key={i}>{p.text}</ReactMarkdown>;
                                                                                if (p.inlineData) return <span key={i} className="text-xs text-zinc-500">[Media]</span>;
                                                                                return null;
                                                                            })}
                                                                        </div>
                                                                    );
                                                                }
                                                                // Non-tool parts: extract text as before
                                                                const text = parts.map(p => p.text || (p.inlineData ? '[Media]' : '')).filter(Boolean).join('\n');
                                                                if (text) return <ReactMarkdown>{text}</ReactMarkdown>;
                                                            }
                                                        } catch (e) { }
                                                    }

                                                    const text = msg.content;
                                                    if (msg.role === 'tool' || msg.source === 'tool') {
                                                        return (
                                                            <pre className="text-xs bg-transparent p-0 m-0 overflow-x-auto whitespace-pre-wrap">
                                                                {text}
                                                            </pre>
                                                        );
                                                    }

                                                    return <ReactMarkdown>{text || '*(No content)*'}</ReactMarkdown>;
                                                })()}
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-start pt-2">
                                            <button
                                                onClick={() => handleDelete(msg.id)}
                                                className="p-2 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                                                title="Delete Message"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
