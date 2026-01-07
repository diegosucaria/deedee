'use client';

import { Wrench, Terminal } from 'lucide-react';

export default function ToolsList({ tools = [] }) {
    if (!tools.length) {
        return <div className="text-zinc-500 italic">No tools available.</div>;
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tools.map((tool) => (
                <div key={tool.name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-2 hover:border-zinc-700 transition-colors">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                            <Terminal className="h-4 w-4 text-amber-400" />
                            <code className="text-sm font-bold text-white">{tool.name}</code>
                        </div>
                        {tool.serverName && (
                            <span className="text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">
                                {tool.serverName}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-zinc-400 line-clamp-3">
                        {tool.description || 'No description provided.'}
                    </p>
                    {/* Optional: Show params count */}
                    {tool.parameters && (
                        <div className="mt-2 pt-2 border-t border-zinc-800/50 flex gap-2 overflow-x-auto">
                            {Object.keys(tool.parameters.properties || {}).map(param => (
                                <span key={param} className="text-[10px] px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-300 font-mono">
                                    {param}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
