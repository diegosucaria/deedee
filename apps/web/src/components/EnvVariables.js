'use client';

import { Terminal } from 'lucide-react';

export default function EnvVariables({ env }) {
    if (!env || Object.keys(env).length === 0) return null;

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-6 border-b border-zinc-800 flex items-center gap-3">
                <div className="p-2 bg-emerald-500/10 rounded-lg">
                    <Terminal className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                    <h2 className="text-lg font-semibold text-white">Environment Configuration</h2>
                    <p className="text-sm text-zinc-400">Read-only system variables.</p>
                </div>
            </div>

            <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {Object.entries(env).map(([key, value]) => (
                        <div key={key} className="flex flex-col gap-1 p-3 rounded bg-zinc-950/50 border border-zinc-800">
                            <span className="text-xs font-mono text-zinc-500 uppercase">{key}</span>
                            <span className={`text-sm font-mono truncate ${typeof value === 'boolean'
                                ? (value ? 'text-emerald-400' : 'text-red-400')
                                : 'text-zinc-300'
                                }`}>
                                {String(value)}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
