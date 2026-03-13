import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

// Resolve socket URL once.
// SOCKET_URL points to the API gateway which proxies socket.io to the
// Interfaces service with full WebSocket support.  This bypasses Next.js
// rewrites (can't upgrade WS) and Traefik forward-auth (generates CSRF
// cookies on every HTTP poll).
// Auth: interfaces validates the browser Origin header against an allowlist.
export function getSocketUrl() {
    // 1. Runtime config injected by layout.js (reads server-side env at render
    //    time).  Primary path for Balena/Docker where env vars are set at
    //    container start, not at build time.
    if (typeof window !== 'undefined' && window.__DEEDEE_CONFIG__?.socketUrl) {
        return window.__DEEDEE_CONFIG__.socketUrl;
    }
    // 2. Fallback: derive from current origin, swapping to API port (local dev)
    if (typeof window !== 'undefined') {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:3001`;
    }
    return undefined;
}

export function useSocket() {
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        if (!socket) {
            const url = getSocketUrl();
            socket = io(url, {
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                transports: ['websocket', 'polling'],
                path: '/socket.io',
            });
        }

        const onConnect = () => setIsConnected(true);
        const onDisconnect = () => setIsConnected(false);

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);

        if (socket.connected) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsConnected(true);
        }

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
        };
    }, []);

    return { socket, isConnected };
}
