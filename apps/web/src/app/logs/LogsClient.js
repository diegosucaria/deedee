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
                const response = await fetch(`${API_URL}/v1/logs/${selectedContainer}?tail=200`, {
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
                    // Split by newline and filter empty
                    const lines = chunk.split('\n');
                    setLogs((prev) => {
                        // Keep last 1000 lines max
                        const newLogs = [...prev, ...lines].slice(-1000);
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
    }, [selectedContainer, token]);

    // Auto-scroll
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    return (
        <div className="flex h-screen flex-col bg-zinc-950 text-green-500 font-mono overflow-hidden">
            {/* Header */}
            <header className="flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4">
                <div className="flex items-center gap-3">
                    <Terminal className="h-5 w-5 text-indigo-500" />
                    <span className="font-bold text-zinc-100 tracking-wider">SYSTEM_LOGS_V1</span>
                </div>
                <div className="flex items-center gap-4 text-xs font-bold">
                    {error ? (
                        <span className="flex items-center gap-2 text-red-500 animate-pulse">
                            <AlertCircle className="w-4 h-4" /> CONNECTION_LOST: {error}
                        </span>
                    ) : isConnected ? (
                        <span className="flex items-center gap-2 text-emerald-500">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> LIVE_STREAM
                        </span>
                    ) : (
                        <span className="text-zinc-500">CONNECTING...</span>
                    )}
                </div>
            </header>

            <div className="flex flex-1 overflow-hidden">
                {/* Sidebar */}
                <aside className="w-48 border-r border-zinc-800 bg-zinc-900/50 flex flex-col p-2 space-y-1">
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
                        <div className="space-y-1 text-xs md:text-sm">
                            {logs.map((line, i) => (
                                <div key={i} className="whitespace-pre-wrap break-all border-l-2 border-transparent hover:border-zinc-800 hover:bg-zinc-900/30 px-2 py-0.5 leading-relaxed">
                                    {line || <span className="h-4 block" />}
                                </div>
                            ))}
                            <div ref={logsEndRef} />
                        </div>
                    )}

                    {/* Scanlines Effect Overlay (Subtle) */}
                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] opacity-20" />
                </main>
            </div>
        </div>
    );
}
