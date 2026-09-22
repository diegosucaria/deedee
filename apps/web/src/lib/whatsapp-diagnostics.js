// Turns the interfaces service's diagnose report into lines the settings card
// can print. The report is `runDiagnostics()` in apps/interfaces/src/whatsapp.js:
// { session, status, timestamp, error?, probes: { presence, blocklist }, store }.

const PROBE_LABELS = { presence: 'Presence probe', blocklist: 'Blocklist probe' };

/** Bytes as a short string. 0 stays "0 B". */
export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || bytes === '') return '-';
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * @param {object} report
 * @returns {Array<{label: string, ok: boolean, detail: string}>}
 */
export function diagnosticLines(report) {
    if (!report || typeof report !== 'object') return [];
    const lines = [{ label: 'State', ok: report.status === 'connected', detail: report.status || 'unknown' }];
    if (report.error) lines.push({ label: 'Socket', ok: false, detail: report.error });

    for (const [name, probe] of Object.entries(report.probes || {})) {
        const bits = [];
        if (probe && probe.success) {
            if (Number.isFinite(probe.count)) bits.push(`${probe.count} entries`);
            if (Number.isFinite(probe.latency)) bits.push(`${probe.latency} ms`);
        } else if (probe && probe.error) {
            bits.push(probe.error);
        }
        lines.push({
            label: PROBE_LABELS[name] || name,
            ok: !!(probe && probe.success),
            detail: bits.join(', ') || (probe && probe.success ? 'ok' : 'failed')
        });
    }

    const store = report.store || {};
    if (store.error) {
        lines.push({ label: 'Store', ok: false, detail: store.error });
    } else if (Number.isFinite(store.messages) || Number.isFinite(store.contacts)) {
        lines.push({
            label: 'Store',
            ok: true,
            detail: `${store.contacts ?? 0} contacts, ${store.messages ?? 0} messages, ${formatBytes(store.sizeBytes)}`
        });
    }
    return lines;
}
