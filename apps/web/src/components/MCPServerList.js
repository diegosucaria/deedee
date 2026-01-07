'use client';

import { Server, Wifi, WifiOff, AlertCircle } from 'lucide-react';
import clsx from 'clsx';

export default function MCPServerList({ servers = [] }) {
    if (!servers.length) {
        return <div className="text-zinc-500 italic">No MCP servers configured.</div>;
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {servers.map((server) => {
                const isConnected = server.status === 'connected';
                return (
                    <div key={server.name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Server className="h-5 w-5 text-indigo-400" />
                                <h3 className="font-medium text-white capitalize">{server.name}</h3>
                            </div>
                            <div className={clsx("flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border",
                                isConnected ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"
                            )}>
                                {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                                {server.status}
                            </div>
                        </div>
                        {server.type && (
                            <div className="text-xs text-zinc-500 font-mono">
                                Transport: {server.type}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
