'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useSocket } from '../hooks/useSocket';

export default function LiveBrowserWidget() {
    const { socket } = useSocket();
    const [frame, setFrame] = useState(null);
    const [active, setActive] = useState(false);
    const timeoutRef = useRef(null);

    useEffect(() => {
        if (!socket) return;

        // Listen for frames
        const handleFrame = (data) => {
            // data: { data: base64, timestamp: number }
            if (data && data.data) {
                setFrame(`data:image/jpeg;base64,${data.data}`);
                setActive(true);

                // Reset inactivity timeout
                if (timeoutRef.current) clearTimeout(timeoutRef.current);

                // Hide after 5 seconds of no frames
                timeoutRef.current = setTimeout(() => {
                    setActive(false);
                    setFrame(null);
                }, 5000);
            }
        };

        socket.on('browser:frame', handleFrame);

        return () => {
            socket.off('browser:frame', handleFrame);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, [socket]);

    if (!active) return null;

    return (
        <div className="mb-4 rounded-lg overflow-hidden border border-gray-700 bg-gray-900 shadow-lg relative">
            <div className="bg-gray-800 px-3 py-1 flex items-center justify-between border-b border-gray-700">
                <span className="text-xs font-mono text-blue-400 flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                    LIVE BROWSER
                </span>
            </div>
            <div className="relative aspect-video bg-black flex items-center justify-center">
                {frame ? (
                    <img src={frame} alt="Live Browser Stream" className="w-full h-full object-contain" />
                ) : (
                    <span className="text-gray-500 text-sm">Connecting to agent...</span>
                )}
            </div>
        </div>
    );
}
