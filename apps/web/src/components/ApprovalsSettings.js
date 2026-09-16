'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, RefreshCw, Check, X, Loader2, Save } from 'lucide-react';
import { clsx } from 'clsx';
import { getApprovals, decideApproval } from '../app/actions';

const STATUS_STYLE = {
    pending: 'text-amber-300 bg-amber-400/10 border-amber-400/20',
    approved: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20',
    denied: 'text-red-300 bg-red-400/10 border-red-400/20',
    expired: 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40',
};

const DEFAULTS = { ttlInteractiveMin: 30, ttlDeferredHours: 6, deny: [] };

function when(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

function originOf(row) {
    const meta = row.origin_meta || {};
    if (meta.jobName) return `job "${meta.jobName}"`;
    if (row.mode === 'deferred') return `${row.origin_source || 'internal'} run`;
    return `${row.origin_source || 'chat'} chat`;
}

/**
 * Approvals card: tool calls that wait for the owner, the two expiry times
 * and the deny-list. Saved as the `approvals` agent setting.
 */
export default function ApprovalsSettings({ value, onSave }) {
    const saved = value && typeof value === 'object' ? value : DEFAULTS;
    const [view, setView] = useState({ pending: [], recent: [], counts: {} });
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null);
    const [showRecent, setShowRecent] = useState(false);
    const [ttlInteractive, setTtlInteractive] = useState(String(saved.ttlInteractiveMin ?? DEFAULTS.ttlInteractiveMin));
    const [ttlDeferred, setTtlDeferred] = useState(String(saved.ttlDeferredHours ?? DEFAULTS.ttlDeferredHours));
    const [deny, setDeny] = useState(Array.isArray(saved.deny) ? saved.deny.join('\n') : String(saved.deny || ''));
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setTtlInteractive(String(saved.ttlInteractiveMin ?? DEFAULTS.ttlInteractiveMin));
        setTtlDeferred(String(saved.ttlDeferredHours ?? DEFAULTS.ttlDeferredHours));
        setDeny(Array.isArray(saved.deny) ? saved.deny.join('\n') : String(saved.deny || ''));
    }, [saved.ttlInteractiveMin, saved.ttlDeferredHours, Array.isArray(saved.deny) ? saved.deny.join('\n') : saved.deny]);

    const refresh = useCallback(async () => {
        setBusy('refresh');
        try {
            const data = await getApprovals(50);
            setView({ pending: data.pending || [], recent: data.recent || [], counts: data.counts || {} });
            setMessage(data.error || null);
        } finally {
            setBusy(null);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const decide = async (id, decision) => {
        setBusy(id);
        try {
            const res = await decideApproval(id, decision);
            if (!res.success) setMessage(res.error || 'The decision failed.');
            else setMessage(decision === 'approve' ? `Approved ${id}: the call ran and the result went to the owner.` : `Denied ${id}.`);
            await refresh();
        } finally {
            setBusy(null);
        }
    };

    const save = async () => {
        setSaving(true);
        try {
            const res = await onSave({
                ttlInteractiveMin: Number(ttlInteractive),
                ttlDeferredHours: Number(ttlDeferred),
                deny: deny.split('\n').map(s => s.trim()).filter(Boolean),
            });
            if (res && res.success === false) setMessage(res.error || 'Save failed.');
            else setMessage('Approval settings saved.');
        } finally {
            setSaving(false);
        }
    };

    const pendingCount = view.pending.length;

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-6 border-b border-zinc-800">
                <div>
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-indigo-400" />
                        Approvals
                        {pendingCount > 0 && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                {pendingCount} pending
                            </span>
                        )}
                    </h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        Tool calls the safety rules paused. Jobs and watchers ask on your notification channel;
                        chats ask in place. Reply yes/no there, or decide here.
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={busy === 'refresh'}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 rounded-lg border border-indigo-500/20 transition-colors disabled:opacity-50 self-start"
                >
                    <RefreshCw className={clsx('w-3.5 h-3.5', busy === 'refresh' && 'animate-spin')} />
                    Refresh
                </button>
            </div>

            {message && (
                <div className="px-6 py-2 text-xs text-zinc-300 border-b border-zinc-800 bg-zinc-900/60">{message}</div>
            )}

            <div className="border-b border-zinc-800">
                {pendingCount === 0 ? (
                    <div className="px-6 py-5 text-xs text-zinc-500">Nothing waits for you.</div>
                ) : (
                    <ul className="divide-y divide-zinc-800">
                        {view.pending.map(row => (
                            <li key={row.id} className="flex flex-col sm:flex-row sm:items-start gap-3 px-6 py-4">
                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-xs text-white">{row.id}</span>
                                        <span className="text-xs text-indigo-300">{row.tool_name}</span>
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">{originOf(row)}</span>
                                    </div>
                                    <p className="text-xs text-zinc-300 mt-2 break-words font-mono">{row.summary}</p>
                                    <p className="text-[11px] text-zinc-500 mt-1">{row.reason}</p>
                                    <p className="text-[10px] text-zinc-600 mt-1">asked {when(row.created_at)} · expires {when(row.expires_at)}</p>
                                </div>
                                <div className="flex gap-2 shrink-0">
                                    <button
                                        onClick={() => decide(row.id, 'approve')}
                                        disabled={busy === row.id}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50"
                                    >
                                        {busy === row.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                        Approve
                                    </button>
                                    <button
                                        onClick={() => decide(row.id, 'deny')}
                                        disabled={busy === row.id}
                                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-200 bg-zinc-800 hover:bg-red-600/80 rounded-lg border border-zinc-700 transition-colors disabled:opacity-50"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                        Deny
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="px-6 pb-3">
                    <button onClick={() => setShowRecent(v => !v)} className="text-[11px] text-zinc-500 hover:text-zinc-300">
                        {showRecent ? 'Hide recent decisions' : `Show recent decisions (approved ${view.counts.approved || 0} · denied ${view.counts.denied || 0} · expired ${view.counts.expired || 0})`}
                    </button>
                    {showRecent && (
                        <ul className="mt-2 space-y-1">
                            {view.recent.filter(r => r.status !== 'pending').slice(0, 20).map(row => (
                                <li key={row.id} className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                                    <span className={clsx('px-2 py-0.5 rounded-full border capitalize text-[10px]', STATUS_STYLE[row.status] || STATUS_STYLE.expired)}>{row.status}</span>
                                    <span className="font-mono">{row.id}</span>
                                    <span className="text-zinc-300">{row.tool_name}</span>
                                    <span className="text-zinc-600">{when(row.decided_at || row.created_at)}{row.decided_via ? ` via ${row.decided_via}` : ''}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            <div className="p-6 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="block">
                        <span className="block text-sm font-medium text-zinc-300">Chat approvals expire after (minutes)</span>
                        <input
                            type="number" min="1" max="1440" value={ttlInteractive}
                            onChange={(e) => setTtlInteractive(e.target.value)}
                            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                        />
                    </label>
                    <label className="block">
                        <span className="block text-sm font-medium text-zinc-300">Job and watcher approvals expire after (hours)</span>
                        <input
                            type="number" min="0.1" max="168" step="0.5" value={ttlDeferred}
                            onChange={(e) => setTtlDeferred(e.target.value)}
                            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                        />
                    </label>
                </div>
                <label className="block">
                    <span className="block text-sm font-medium text-zinc-300">Deny-list</span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                        One glob per line over <code>toolName:argsJson</code>; a line without a colon matches the tool name.
                        Denied calls fail at once in every mode, jobs included. Example: <code>runShellCommand:*rm -rf*</code>
                    </span>
                    <textarea
                        value={deny}
                        onChange={(e) => setDeny(e.target.value)}
                        rows={4}
                        spellCheck={false}
                        className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                        placeholder={'commitAndPush\nsendMessage:*"session":"user"*'}
                    />
                </label>
                <div className="flex justify-end">
                    <button
                        onClick={save}
                        disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
