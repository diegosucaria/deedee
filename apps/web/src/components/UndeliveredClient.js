'use client';

import { useState, useCallback } from 'react';
import { RefreshCw, Send, Inbox, ChevronDown, ChevronUp } from 'lucide-react';
import { getNotificationOutbox, retryOutboxDelivery } from '@/app/actions';
import { clsx } from 'clsx';

const STATUS_STYLE = {
    pending: 'text-amber-300 bg-amber-400/10 border-amber-400/20',
    failed: 'text-orange-300 bg-orange-400/10 border-orange-400/20',
    dead: 'text-red-300 bg-red-400/10 border-red-400/20',
    sent: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20',
};

function when(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

function preview(row) {
    const p = row.payload || {};
    if (p.type && p.type !== 'text') return `[${p.type}] ${p.caption || ''}`.trim();
    const text = String(p.content || '');
    return text.length > 160 ? text.slice(0, 160) + '...' : text;
}

/**
 * Delivery ledger view: notifications the agent could not push to the owner
 * yet (pending, failed) or gave up on (dead), each with a Retry button.
 */
export default function UndeliveredClient({ initialRows = [], initialCounts = {} }) {
    const [rows, setRows] = useState(initialRows);
    const [counts, setCounts] = useState(initialCounts);
    const [busy, setBusy] = useState(null);
    const [showSent, setShowSent] = useState(false);
    const [message, setMessage] = useState(null);

    const refresh = useCallback(async () => {
        setBusy('refresh');
        try {
            const data = await getNotificationOutbox(50);
            setRows(data.rows || []);
            setCounts(data.counts || {});
            setMessage(data.error || null);
        } finally {
            setBusy(null);
        }
    }, []);

    const handleRetry = async (id) => {
        setBusy(id);
        try {
            const result = await retryOutboxDelivery(id);
            if (!result.success) {
                setMessage(result.error || 'Retry failed');
            } else {
                setMessage(result.delivered ? `Delivered via ${result.via || result.row?.channel}.` : `Still not delivered (${result.status}); the worker keeps trying.`);
                if (result.row) setRows(prev => prev.map(r => r.id === id ? result.row : r));
            }
            const data = await getNotificationOutbox(50);
            setRows(data.rows || []);
            setCounts(data.counts || {});
        } finally {
            setBusy(null);
        }
    };

    const undelivered = rows.filter(r => r.status !== 'sent');
    const visible = showSent ? rows : undelivered;
    const openCount = (counts.pending || 0) + (counts.failed || 0) + (counts.dead || 0);

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-b border-zinc-800">
                <div>
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Inbox className="w-4 h-4 text-indigo-400" />
                        Undelivered
                        {openCount > 0 && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 border border-red-500/30">
                                {openCount}
                            </span>
                        )}
                    </h2>
                    <p className="text-xs text-zinc-500 mt-1">
                        Owner notifications the agent could not push yet. Retries run every minute with backoff;
                        after two failures the other channel gets one try.
                        {' '}Pending {counts.pending || 0} · Failed {counts.failed || 0} · Dead {counts.dead || 0} · Sent {counts.sent || 0}
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowSent(v => !v)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg border border-zinc-700 transition-colors"
                    >
                        {showSent ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        {showSent ? 'Hide sent' : 'Show sent'}
                    </button>
                    <button
                        onClick={refresh}
                        disabled={busy === 'refresh'}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 rounded-lg border border-indigo-500/20 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={clsx('w-3.5 h-3.5', busy === 'refresh' && 'animate-spin')} />
                        Refresh
                    </button>
                </div>
            </div>

            {message && (
                <div className="px-4 py-2 text-xs text-zinc-300 border-b border-zinc-800 bg-zinc-900/60">{message}</div>
            )}

            {visible.length === 0 ? (
                <div className="px-4 py-6 text-xs text-zinc-500 text-center">
                    {showSent ? 'The ledger is empty.' : 'Nothing waiting. Every recent notification reached you.'}
                </div>
            ) : (
                <ul className="divide-y divide-zinc-800">
                    {visible.map(row => (
                        <li key={row.id} className="flex flex-col sm:flex-row sm:items-start gap-3 p-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={clsx('text-[10px] px-2 py-0.5 rounded-full border capitalize', STATUS_STYLE[row.status] || STATUS_STYLE.pending)}>
                                        {row.status}
                                    </span>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                                        {row.kind}
                                    </span>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                                        {row.channel}{row.delivered_via && row.delivered_via !== row.channel ? ` → ${row.delivered_via}` : ''}
                                    </span>
                                    <span className="text-[10px] text-zinc-600">
                                        {row.attempts} attempt{row.attempts === 1 ? '' : 's'} · created {when(row.created_at)}
                                    </span>
                                </div>
                                <p className="text-xs text-zinc-300 mt-2 leading-relaxed break-words">{preview(row)}</p>
                                <div className="text-[10px] text-zinc-500 mt-1 space-x-2">
                                    {row.origin && <span>origin: {row.origin}</span>}
                                    {row.next_attempt_at && row.status !== 'sent' && <span>next try: {when(row.next_attempt_at)}</span>}
                                    {row.fallback_status && <span>fallback {row.fallback_channel}: {row.fallback_status}</span>}
                                    {row.last_error && <span className="text-zinc-400">{row.last_error}</span>}
                                </div>
                            </div>
                            {row.status !== 'sent' && (
                                <button
                                    onClick={() => handleRetry(row.id)}
                                    disabled={busy === row.id}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                                >
                                    <Send className="w-3.5 h-3.5" />
                                    {busy === row.id ? 'Sending…' : 'Retry'}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
