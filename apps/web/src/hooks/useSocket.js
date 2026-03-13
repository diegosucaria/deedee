import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

// Resolve socket URL once.
// NEXT_PUBLIC_SOCKET_URL points to the API gateway (port 3001) which proxies
// socket.io to the Interfaces service with full WebSocket support.
// This bypasses Next.js rewrites (can't upgrade WS) and Traefik forward-auth
// (generates CSRF cookies on every HTTP poll).
// Auth: interfaces validates the browser Origin header against an allowlist.
export function getSocketUrl() {
    if (process.env.NEXT_PUBLIC_SOCKET_URL) {
        return process.env.NEXT_PUBLIC_SOCKET_URL;
    }
    // Fallback: derive from current origin, swapping to API port
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
