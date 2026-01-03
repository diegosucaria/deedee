'use client';

import { deleteHistory } from '@/app/actions';
import { Trash2, User, Bot, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

export default function HistoryList({ history }) {

    const getIcon = (role) => {
        if (role === 'user') return <User className="h-4 w-4" />;
        if (role === 'model' || role === 'assistant') return <Bot className="h-4 w-4" />;
        if (role === 'function' || role === 'system') return <Terminal className="h-4 w-4" />;
        return <Bot className="h-4 w-4" />;
    };

    const getColor = (role) => {
        if (role === 'user') return 'text-blue-400 bg-blue-400/10 border-blue-400/20';
        if (role === 'model' || role === 'assistant') return 'text-purple-400 bg-purple-400/10 border-purple-400/20';
        if (role === 'function') return 'text-orange-400 bg-orange-400/10 border-orange-400/20';
        return 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20';
    };

    return (
        <div className="space-y-4">
            {history.length === 0 ? (
                <div className="text-zinc-500 text-center py-8">No history loaded.</div>
            ) : (
                history.map((msg) => (
                    <div
                        key={msg.id || Math.random()}
                        className="group relative flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-all hover:bg-zinc-900 hover:border-zinc-700"
                    >
                        <div className="flex items-center justify-between mb-2">
                            <div className={`flex items-center gap-2 px-2 py-1 rounded text-xs font-medium border ${getColor(msg.role)}`}>
                                {getIcon(msg.role)}
                                <span className="uppercase">{msg.role}</span>
                            </div>
                            <span className="text-xs text-zinc-600 font-mono">
                                {new Date(msg.timestamp).toLocaleString()}
                            </span>
                        </div>

                        <div className="text-sm text-zinc-300 font-mono whitespace-pre-wrap pl-2 border-l-2 border-zinc-800">
                            {msg.content ? (
                                msg.content
                            ) : (
                                <span className="text-zinc-600 italic">No text content (JSON/Parts)</span>
                            )}
                        </div>

                        {/* JSON Parts Preview (if any) */}
                        {msg.parts && (
                            <details className="mt-2 text-xs text-zinc-500">
                                <summary className="cursor-pointer hover:text-zinc-400">View Parts JSON</summary>
                                <pre className="bg-black/30 p-2 rounded mt-1 overflow-x-auto">
                                    {msg.parts}
                                </pre>
                            </details>
                        )}

                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={() => {
                                    if (confirm('Permanently delete this message?')) deleteHistory(msg.id);
                                }}
                                title="Delete Message"
                                className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
