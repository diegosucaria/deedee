import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

// Resolve socket URL once.
// SOCKET_URL points to the API gateway. Traefik's google-auth middleware
// gates the /socket.io path on that domain; the API then injects
// DEEDEE_API_TOKEN into the upstream handshake. The browser never holds
// the API token — auth is the _forward_auth cookie (parent-domain scoped,
// so it's sent cross-origin to the API host).
// We force websocket-only transport: a single WS upgrade per connection
// means forward-auth runs once, no polling = no CSRF cookie spam.
export function getSocketUrl() {
    // 1. Runtime config injected by layout.js (reads server-side env at render
    //    time).  Primary path for Balena/Docker where env vars are set at
    //    container start, not at build time.
    if (typeof window !== 'undefined' && window.__DEEDEE_CONFIG__?.socketUrl) {
        return window.__DEEDEE_CONFIG__.socketUrl;
    }
    // 2. Fallback: derive from current origin. 
    // If we're on a standard port (80/443), assume we're through a proxy/tunnel that routes /socket.io.
    // Otherwise, swap to the default API port (local dev).
    if (typeof window !== 'undefined') {
        const { protocol, hostname, port } = window.location;
        if (!port || port === '80' || port === '443') {
            return `${protocol}//${hostname}`;
        }
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
                transports: ['websocket'],
                path: '/socket.io',
                withCredentials: true,
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
