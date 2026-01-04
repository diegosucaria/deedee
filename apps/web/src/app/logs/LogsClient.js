'use client';

import { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, Layers, Layout, AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { API_URL } from '@/lib/api';

const CONTAINERS = [
    'agent',
    'interfaces',
    'api',
    'web',
    'supervisor'
];

export default function LogsClient({ token }) {
    const [selectedContainer, setSelectedContainer] = useState('agent');
    const [logs, setLogs] = useState([]);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState(null);
    const [timeFilter, setTimeFilter] = useState('1h'); // 10m, 1h, 24h, all
    const [sortOrder, setSortOrder] = useState('desc'); // desc (newest top), asc (oldest top)
    const readerRef = useRef(null);
    const logsEndRef = useRef(null);

    useEffect(() => {
        // Clear logs on switch
        setLogs([]);
        setIsConnected(false);
        setError(null);
        if (readerRef.current) {
            readerRef.current.cancel();
            readerRef.current = null;
        }

        const fetchLogs = async () => {
            try {
                setIsConnected(true);
                let url = `${API_URL}/v1/logs/${selectedContainer}`;

                // Construct Query Params
                const params = new URLSearchParams();
                if (timeFilter !== 'all') {
                    params.append('since', timeFilter); // Docker supports "10m", "1h"
                } else {
                    params.append('tail', '1000'); // If all, limit tail to avoid crash
                }
                url += `?${params.toString()}`;

                console.log(`[LogsClient] Connecting to ${url}`);

                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                if (!response.ok) {
                    if (response.status === 404) throw new Error('Container not found or not running');
                    if (response.status === 401) throw new Error('Unauthorized: Invalid or missing token');
                    throw new Error(`Connection failed: ${response.statusText}`);
                }

                const reader = response.body.getReader();
                readerRef.current = reader;
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });

                    // Split by newline
                    const lines = chunk.split('\n');
                    setLogs((prev) => {
                        // Append new lines
                        // Limit total buffer to prevent browser crash
                        const newLogs = [...prev, ...lines].slice(-5000);
                        return newLogs;
                    });
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Log Stream Error:', err);
                    setError(err.message);
                    setIsConnected(false);
                }
            }
        };

        if (token) {
            fetchLogs();
        } else {
            setError('Missing API Token');
        }

        return () => {
            if (readerRef.current) {
                readerRef.current.cancel();
            }
        };
    }, [selectedContainer, token, timeFilter]);

    // Derived state for display
    const displayedLogs = [...logs];
    if (sortOrder === 'desc') {
        displayedLogs.reverse();
    }

    // Auto-scroll only if sorting is oldest-first (standard terminal behavior)
    useEffect(() => {
        if (sortOrder === 'asc' && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, sortOrder]);

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-green-500 font-mono overflow-hidden">
            {/* Header */}
            <header className="flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 shrink-0">
                <div className="flex items-center gap-3">
                    <Terminal className="h-5 w-5 text-indigo-500" />
                    <span className="font-bold text-zinc-100 tracking-wider hidden md:inline">SYSTEM_LOGS_V1</span>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-4">
                    <select
                        value={timeFilter}
                        onChange={(e) => setTimeFilter(e.target.value)}
                        className="bg-zinc-800 text-zinc-300 text-xs rounded px-2 py-1 border border-zinc-700 outline-none focus:border-indigo-500"
                    >
                        <option value="10m">Last 10m</option>
                        <option value="1h">Last 1h</option>
                        <option value="24h">Last 24h</option>
                        <option value="all">All (Tail 1000)</option>
                    </select>

                    <button
                        onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                        className="text-xs font-bold text-zinc-400 hover:text-white flex items-center gap-1"
                    >
                        {sortOrder === 'asc' ? '⬇️ Oldest' : '⬆️ Newest'}
                    </button>

                    <div className="h-4 w-px bg-zinc-700 mx-2" />

                    <div className="flex items-center gap-4 text-xs font-bold">
                        {error ? (
                            <span className="flex items-center gap-2 text-red-500 animate-pulse">
                                <AlertCircle className="w-4 h-4" /> <span className="hidden md:inline">CONNECTION_LOST: {error}</span>
                            </span>
                        ) : isConnected ? (
                            <span className="flex items-center gap-2 text-emerald-500">
                                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> <span className="hidden md:inline">LIVE</span>
                            </span>
                        ) : (
                            <span className="text-zinc-500">CONNECTING...</span>
                        )}
                    </div>
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar */}
                <aside className="w-48 border-r border-zinc-800 bg-zinc-900/50 flex flex-col p-2 space-y-1 shrink-0 overflow-y-auto hidden md:flex">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold px-2 py-2 mb-1 tracking-widest">Targets</span>
                    {CONTAINERS.map(c => (
                        <button
                            key={c}
                            onClick={() => setSelectedContainer(c)}
                            className={clsx(
                                "text-left px-3 py-2 text-xs uppercase font-bold rounded hover:bg-zinc-800 transition-colors flex items-center gap-2",
                                selectedContainer === c ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" : "text-zinc-400"
                            )}
                        >
                            <Layers className="w-3 h-3" />
                            {c}
                        </button>
                    ))}
                </aside>

                {/* Console Area */}
                <main className="flex-1 relative bg-black p-4 overflow-auto scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                    {error ? (
                        <div className="flex h-full items-center justify-center text-red-500 font-bold border border-red-900/30 bg-red-900/10 rounded-lg">
                            [ERROR] {error}
                        </div>
                    ) : (
                        <div className="space-y-1 text-xs md:text-sm font-mono">
                            {displayedLogs.map((line, i) => (
                                <div key={i} className="whitespace-pre-wrap break-all border-l-2 border-transparent hover:border-zinc-800 hover:bg-zinc-900/30 px-2 py-0.5 leading-relaxed text-zinc-300">
                                    {line || <span className="h-4 block" />}
                                </div>
                            ))}
                            {sortOrder === 'asc' && <div ref={logsEndRef} />}
                        </div>
                    )}

                    {/* Scanlines Effect Overlay (Subtle) */}
                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] opacity-20" />
                </main>
            </div>
        </div>
    );
}
