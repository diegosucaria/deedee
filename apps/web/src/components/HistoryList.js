'use client';

import { useState } from 'react';
import { Trash2, User, Bot, Wrench, Terminal, Calendar } from 'lucide-react';
import { deleteHistory } from '@/app/actions';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';

export default function HistoryList({ history }) {
    const [filterSource, setFilterSource] = useState('all');

    // Get unique sources
    const sources = ['all', ...new Set(history.map(h => h.source || 'db'))];

    const filteredHistory = filterSource === 'all'
        ? history
        : history.filter(h => (h.source || 'db') === filterSource);

    // Group by Date
    const grouped = filteredHistory.reduce((acc, msg) => {
        const date = new Date(msg.timestamp).toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        if (!acc[date]) acc[date] = [];
        acc[date].push(msg);
        return acc;
    }, {});

    const handleDelete = async (id) => {
        if (confirm('Delete this message log?')) {
            await deleteHistory(id);
        }
    };

    return (
        <div className="space-y-8">
            <div className="flex justify-end mb-4">
                <label className="flex items-center gap-2 text-sm text-zinc-500">
                    Filter Source:
                    <select
                        value={filterSource}
                        onChange={(e) => setFilterSource(e.target.value)}
                        className="bg-zinc-900 border border-zinc-800 text-zinc-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                        {sources.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
                    </select>
                </label>
            </div>

            <div className="space-y-12">
                {Object.entries(grouped).map(([date, messages]) => (
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
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-sm font-semibold text-zinc-300 capitalize">
                                                    {msg.role}
                                                </span>
                                                <span className="text-xs text-zinc-600">
                                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                                </span>
                                                <span className="text-[10px] text-zinc-700 bg-zinc-900 border border-zinc-800 px-1.5 rounded uppercase">
                                                    {msg.source || 'db'}
                                                </span>
                                            </div>

                                            <div className="prose prose-invert prose-sm max-w-none text-zinc-400 bg-zinc-900/40 p-4 rounded-xl border border-zinc-800/50">
                                                {(() => {
                                                    let text = msg.content;
                                                    // Try parsing parts if content is empty or looks like JSON
                                                    if ((!text || text === '{}') && msg.parts) {
                                                        try {
                                                            const parts = typeof msg.parts === 'string' ? JSON.parse(msg.parts) : msg.parts;
                                                            if (Array.isArray(parts)) {
                                                                text = parts.map(p => p.text || (p.functionCall ? `Tool Call: ${p.functionCall.name}` : '') || (p.inlineData ? '[Media]' : '')).join('\n');
                                                            }
                                                        } catch (e) { }
                                                    }

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
