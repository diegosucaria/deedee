import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socket;

export function useSocket() {
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        // Initialize socket singleton if not exists
        if (!socket) {
            // Determine Socket URL
            // Default to localhost:5000 for dev.
            // In production (Balena), we might need to target the same host but port 5000 
            // OR use a relative path if proxied.
            // Given docker-compose exposes 5000, we try that.
            const url = typeof window !== 'undefined'
                ? `${window.location.protocol}//${window.location.hostname}:5000`
                : 'http://localhost:5000';

            socket = io(url, {
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1000,
                transports: ['polling'], // Force polling first to avoid websocket issues initially
                path: '/socket.io'
            });
        }

        const onConnect = () => setIsConnected(true);
        const onDisconnect = () => setIsConnected(false);

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);

        // Set initial state
        if (socket.connected) {
            setIsConnected(true);
        }

        return () => {
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
        };
    }, []);

    return { socket, isConnected };
}
