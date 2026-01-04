'use client';

import { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, Layers, Layout, AlertCircle, ChevronLeft, ChevronRight, ArrowUpCircle, ArrowDownCircle, PauseCircle, PlayCircle, Clock } from 'lucide-react';
import clsx from 'clsx';
import { API_URL } from '@/lib/api';

const CONTAINERS = [
    'agent',
    'interfaces',
    'api',
    'web',
    'supervisor',
    'all'
];

const CONTAINER_COLORS = {
    agent: 'text-green-500',
    interfaces: 'text-yellow-500',
    api: 'text-blue-500',
    web: 'text-pink-500',
    supervisor: 'text-purple-500'
};

export default function LogsClient({ token }) {
    const [selectedContainer, setSelectedContainer] = useState('agent');
    const [logs, setLogs] = useState([]);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState(null);
    const [timeFilter, setTimeFilter] = useState('1h'); // 10m, 1h, 24h, all
    const [sortOrder, setSortOrder] = useState('asc'); // asc (standard terminal: oldest top, newest bottom)
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [autoScroll, setAutoScroll] = useState(true);
    const [showTimestamps, setShowTimestamps] = useState(false);
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

    // Auto-scroll logic
    useEffect(() => {
        // Scroll to bottom if autoScroll is enabled AND we are sorting ascending (newest at bottom)
        if (autoScroll && sortOrder === 'asc' && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs, sortOrder, autoScroll]);

    // Force scroll to bottom on mount/container switch if autoScroll is on
    useEffect(() => {
        if (autoScroll && sortOrder === 'asc' && logsEndRef.current) {
            // Small timeout to ensure DOM is ready
            setTimeout(() => {
                logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
            }, 100);
        }
    }, [selectedContainer]);

    // Handle manual scroll to disable auto-scroll (optional, but good UX)
    // For now, let's keep it manual toggle only to be simple/robust.

    const scrollToTop = () => {
        setAutoScroll(false);
        const main = document.querySelector('main.overflow-auto');
        if (main) main.scrollTop = 0;
    };

    const scrollToBottom = () => {
        setAutoScroll(true);
        if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    };

    const clearLogs = () => {
        setLogs([]);
    };

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
                        onClick={clearLogs}
                        className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white px-2 py-1 rounded border border-zinc-700 transition-colors"
                        title="Clear Local Logs"
                    >
                        Clear
                    </button>

                    <div className="h-4 w-px bg-zinc-700 mx-2" />

                    {/* Scroll Controls */}
                    <button onClick={scrollToTop} title="Scroll to Top" className="text-zinc-500 hover:text-white">
                        <ArrowUpCircle className="w-4 h-4" />
                    </button>
                    <button onClick={scrollToBottom} title="Scroll to Bottom" className="text-zinc-500 hover:text-white">
                        <ArrowDownCircle className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setAutoScroll(!autoScroll)}
                        title={autoScroll ? "Disable Auto-Scroll" : "Enable Auto-Scroll"}
                        className={clsx("transition-colors", autoScroll ? "text-green-500" : "text-zinc-600 hover:text-zinc-400")}
                    >
                        {autoScroll ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
                    </button>

                    <div className="h-4 w-px bg-zinc-700 mx-2" />

                    <button
                        onClick={() => setShowTimestamps(!showTimestamps)}
                        title="Toggle Timestamps"
                        className={clsx("transition-colors", showTimestamps ? "text-indigo-400" : "text-zinc-600 hover:text-zinc-400")}
                    >
                        <Clock className="w-4 h-4" />
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
                <aside className={clsx(
                    "border-r border-zinc-800 bg-zinc-900/50 flex flex-col transition-all duration-300 ease-in-out shrink-0 overflow-y-auto hidden md:flex",
                    isSidebarCollapsed ? "w-12 items-center py-2" : "w-48 p-2"
                )}>
                    <div className={clsx("flex items-center mb-2 px-2", isSidebarCollapsed ? "justify-center" : "justify-start")}>
                        <span className={clsx("text-[10px] text-zinc-500 uppercase font-bold tracking-widest", isSidebarCollapsed ? "hidden" : "block")}>Targets</span>
                    </div>

                    <div className={clsx("flex flex-col space-y-1", isSidebarCollapsed ? "w-full px-1" : "w-full")}>
                        {CONTAINERS.map(c => (
                            <button
                                key={c}
                                onClick={() => setSelectedContainer(c)}
                                title={c}
                                className={clsx(
                                    "text-xs uppercase font-bold rounded hover:bg-zinc-800 transition-colors flex items-center", // Removed justify-center from base
                                    isSidebarCollapsed ? "justify-center h-8 w-8 mx-auto" : "justify-start text-left px-3 py-2 gap-2 w-full",
                                    selectedContainer === c ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20" : "text-zinc-400"
                                )}
                            >
                                {isSidebarCollapsed ? (
                                    <span className="text-sm font-bold">{c.charAt(0).toUpperCase()}</span>
                                ) : (
                                    <>
                                        <Layers className="w-3 h-3 shrink-0" />
                                        <span>{c}</span>
                                    </>
                                )}
                            </button>
                        ))}
                    </div>
                    <div className="mt-auto pt-2 border-t border-zinc-800/50 flex justify-end px-2">
                        <button
                            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                            className="text-zinc-600 hover:text-zinc-300 p-1"
                        >
                            {isSidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
                        </button>
                    </div>
                </aside>

                {/* Console Area */}
                <main className="flex-1 relative bg-black p-4 overflow-auto scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                    {error ? (
                        <div className="flex h-full items-center justify-center text-red-500 font-bold border border-red-900/30 bg-red-900/10 rounded-lg">
                            [ERROR] {error}
                        </div>
                    ) : (
                        <div className="space-y-1 text-xs md:text-sm font-mono">
                            {displayedLogs.map((line, i) => {
                                // Parse line for prefix [name]
                                const match = line.match(/^\[(agent|api|web|interfaces|supervisor)\] (.*)/);
                                let prefix = null;
                                let content = line;
                                let colorClass = 'text-zinc-300';

                                if (match) {
                                    prefix = match[1];
                                    content = match[2];
                                    colorClass = CONTAINER_COLORS[prefix] || 'text-zinc-300';
                                }

                                return (
                                    <div key={i} className="flex gap-2 whitespace-pre-wrap break-all border-l-2 border-transparent hover:border-zinc-800 hover:bg-zinc-900/30 px-2 py-[1px] leading-tight group">
                                        {showTimestamps && (
                                            <span className="text-zinc-600 shrink-0 select-none text-[10px] pt-[2px]">
                                                {new Date().toLocaleTimeString()}
                                            </span>
                                        )}
                                        {prefix && (
                                            <span className={clsx("shrink-0 font-bold w-20 text-right uppercase select-none opacity-80 group-hover:opacity-100 transition-opacity", colorClass)}>
                                                {prefix}
                                            </span>
                                        )}
                                        <span className={clsx(prefix ? colorClass : "text-zinc-300")}>{content || <span className="h-4 block" />}</span>
                                    </div>
                                );
                            })}
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
