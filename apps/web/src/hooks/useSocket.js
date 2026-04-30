import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

// Resolve socket URL once.
// Auth model:
//   - Browser holds a httpOnly session cookie (set by /api/auth/login or
//     the passkey verify route). For two-subdomain deploys, COOKIE_DOMAIN
//     is set so the cookie rides across to the api host.
//   - The api service verifies that JWT cookie on the WS upgrade and
//     proxies to interfaces with DEEDEE_API_TOKEN injected server-side.
//   - websocket-only transport keeps polling-induced cookie spam off.
export function getSocketUrl() {
    // 1. Runtime config injected by layout.js (reads server-side env at render
    //    time). Primary path for Balena/Docker where env vars are set at
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
                transports: ['websocket'],
                path: '/socket.io',
                // Required so the session cookie is sent cross-origin when
                // web and api live on different subdomains. Same-origin
                // setups also accept this; it's a no-op there.
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
