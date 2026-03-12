'use server';

const API_URL = process.env.API_URL || 'http://api:3001';
const SUPERVISOR_URL = process.env.SUPERVISOR_URL || 'http://supervisor:4000';

/**
 * Fetch health status from all backend services.
 * Called by the client-side useHealthStatus hook via polling.
 *
 * Returns: { agent, api, supervisor, interfaces, lastCheck }
 * Each service has: { status: 'ok'|'degraded'|'error'|'unknown', detail?: string }
 */
export async function getHealthStatus() {
    const result = {
        agent: { status: 'unknown' },
        api: { status: 'unknown' },
        supervisor: { status: 'unknown' },
        interfaces: { status: 'unknown' },
        lastCheck: new Date().toISOString(),
    };

    // 1. Check API (also checks agent reachability)
    try {
        const apiRes = await fetch(`${API_URL}/health`, {
            signal: AbortSignal.timeout(3000),
            cache: 'no-store',
        });
        if (apiRes.ok) {
            const data = await apiRes.json();
            result.api = { status: data.status || 'ok' };
            // API's health endpoint also checks agent
            if (data.checks?.agent === 'ok') {
                result.agent = { status: 'ok' };
            } else if (data.checks?.agent === 'unreachable') {
                result.agent = { status: 'error', detail: 'Unreachable from API' };
            }
        } else {
            result.api = { status: 'error', detail: `HTTP ${apiRes.status}` };
        }
    } catch (e) {
        result.api = { status: 'error', detail: e.message };
    }

    // 2. Check Supervisor (has the comprehensive HealthMonitor)
    try {
        const supRes = await fetch(`${SUPERVISOR_URL}/health`, {
            signal: AbortSignal.timeout(3000),
            cache: 'no-store',
        });
        if (supRes.ok) {
            const data = await supRes.json();
            result.supervisor = { status: data.status || 'ok' };

            // Supervisor's HealthMonitor checks agent, api, and interfaces
            const monitor = data.monitor;
            if (monitor?.services) {
                // Enrich agent status from supervisor's monitor if we don't already have it
                if (monitor.services.agent) {
                    const agentFromSup = monitor.services.agent;
                    // Prefer the more detailed supervisor check
                    if (agentFromSup.status === 'ok') {
                        result.agent = { status: 'ok' };
                    } else if (agentFromSup.status === 'error') {
                        result.agent = { status: 'error', detail: agentFromSup.error || 'Down' };
                    } else {
                        result.agent = { status: agentFromSup.status, detail: agentFromSup.error };
                    }
                }
                // Interfaces status from supervisor monitor
                if (monitor.services.interfaces) {
                    const iface = monitor.services.interfaces;
                    result.interfaces = {
                        status: iface.status === 'ok' ? 'ok' : iface.status === 'error' ? 'error' : iface.status,
                        detail: iface.error,
                    };
                }
            }
        } else {
            result.supervisor = { status: 'error', detail: `HTTP ${supRes.status}` };
        }
    } catch (e) {
        result.supervisor = { status: 'error', detail: e.message };
    }

    return result;
}
