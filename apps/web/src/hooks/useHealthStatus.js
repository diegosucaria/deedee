'use client';

import { useState, useEffect, useCallback } from 'react';
import { getHealthStatus } from '@/app/health/actions';

const POLL_INTERVAL = 30_000; // 30 seconds

/**
 * Hook that polls backend health status every 30 seconds.
 * Returns a map of service statuses for: agent, api, supervisor, interfaces.
 *
 * Each entry: { status: 'ok'|'degraded'|'error'|'unknown', detail?: string }
 */
export function useHealthStatus() {
    const [health, setHealth] = useState({
        agent: { status: 'unknown' },
        api: { status: 'unknown' },
        supervisor: { status: 'unknown' },
        interfaces: { status: 'unknown' },
        lastCheck: null,
    });

    const refresh = useCallback(async () => {
        try {
            const result = await getHealthStatus();
            setHealth(result);
        } catch {
            // If the server action itself fails, everything is likely down
            setHealth({
                agent: { status: 'unknown' },
                api: { status: 'unknown' },
                supervisor: { status: 'unknown' },
                interfaces: { status: 'unknown' },
                lastCheck: new Date().toISOString(),
            });
        }
    }, []);

    useEffect(() => {
        refresh();
        const interval = setInterval(refresh, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [refresh]);

    return health;
}
