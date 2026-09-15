'use client';

import React, { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';

const WATCH_INTERVAL_MS = 10_000;   // browser:watch ping while the widget shows
const HIDE_AFTER_MS = 30_000;       // hide this long after the last frame or browser signal

/**
 * Small live view at the bottom of a chat. It wakes up when the agent calls a
 * browser_ tool (or when frames arrive), pings browser:watch so the agent
 * streams frames, and links to the full /browser page.
 */
export default function LiveBrowserWidget() {
    const { socket } = useSocket();
    const [frame, setFrame] = useState(null);
    const [active, setActive] = useState(false);
    const [agentBusy, setAgentBusy] = useState(false);
    const hideRef = useRef(null);

    useEffect(() => {
        if (!socket) return;

        const wake = () => {
            setActive(true);
            if (hideRef.current) clearTimeout(hideRef.current);
            hideRef.current = setTimeout(() => {
                setActive(false);
                setFrame(null);
            }, HIDE_AFTER_MS);
        };

        const handleFrame = (data) => {
            // data: { data: base64, w, h, url }
            if (data && data.data) {
                setFrame(`data:image/jpeg;base64,${data.data}`);
                wake();
            }
        };
        const handleStatus = (s) => {
            if (!s) return;
            setAgentBusy(!!s.agentBusy);
            if (s.agentBusy) wake();
        };
        const handleToolCall = (data) => {
            if (typeof data?.name === 'string' && data.name.startsWith('browser_')) {
                wake();
                socket.emit('browser:watch');
            }
        };

        socket.on('browser:frame', handleFrame);
        socket.on('browser:status', handleStatus);
        socket.on('agent:tool_call', handleToolCall);

        return () => {
            socket.off('browser:frame', handleFrame);
            socket.off('browser:status', handleStatus);
            socket.off('agent:tool_call', handleToolCall);
            if (hideRef.current) clearTimeout(hideRef.current);
        };
    }, [socket]);

    // Keep the screencast alive while the widget shows.
    useEffect(() => {
        if (!socket || !active) return;
        const ping = () => socket.emit('browser:watch');
        ping();
        const timer = setInterval(ping, WATCH_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [socket, active]);

    if (!active) return null;

    return (
        <div className="mb-4 rounded-lg overflow-hidden border border-gray-700 bg-gray-900 shadow-lg relative">
            <div className="bg-gray-800 px-3 py-1 flex items-center justify-between border-b border-gray-700">
                <span className="text-xs font-mono text-blue-400 flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                        {agentBusy && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>}
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                    LIVE BROWSER
                </span>
                <Link href="/browser" className="text-xs text-zinc-400 hover:text-white flex items-center gap-1" title="Open the full browser view">
                    Open <ExternalLink className="w-3 h-3" />
                </Link>
            </div>
            <Link href="/browser" className="relative aspect-video bg-black flex items-center justify-center">
                {frame ? (
                    <img src={frame} alt="Live Browser Stream" className="w-full h-full object-contain" />
                ) : (
                    <span className="text-gray-500 text-sm">Waiting for a frame</span>
                )}
            </Link>
        </div>
    );
}
