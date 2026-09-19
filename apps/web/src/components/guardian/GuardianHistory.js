'use client';

import { Fragment, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw, ChevronDown, ChevronRight, ChevronLeft, ExternalLink, ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { getGuardianHistory, getGuardianDecision, setGuardianFeedback } from '@/app/actions';
import { useSocket } from '@/hooks/useSocket';
import {
    OUTCOMES, RISKS, SOURCE_KINDS, outcomeLabel, outcomeTone, canGiveFeedback, rowLink, sourceLabel, formatMs,
} from '@/lib/guardian';

const PAGE_SIZE = 50;
const INPUT_CLASS = 'bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50';
const RISK_TONE = { low: 'text-zinc-400', medium: 'text-amber-300', high: 'text-red-300' };

function when(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function FeedbackButtons({ row, onChange, compact = false }) {
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    if (!canGiveFeedback(row)) return null;

    const send = async (value) => {
        const next = row.feedback === value ? null : value;
        setBusy(value);
        setError(null);
        try {
            const res = await setGuardianFeedback(row.id, next);
            if (res.success) onChange?.(res.row || { ...row, feedback: next });
            else setError(res.error || 'Could not save');
        } finally {
            setBusy(null);
        }
    };

    const btn = (value, Icon, label) => (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); send(value); }}
            disabled={!!busy}
            title={label}
            aria-pressed={row.feedback === value}
            className={clsx(
                'inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-50',
                row.feedback === value
                    ? (value === 'should_allow' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-red-500/40 bg-red-500/15 text-red-300')
                    : 'border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
            )}
        >
            {busy === value ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
            {!compact && label}
        </button>
    );

    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            {btn('should_allow', ThumbsUp, 'Should have been allowed')}
            {btn('should_deny', ThumbsDown, 'Should have been denied')}
            {error && <span className="text-[11px] text-red-400">{error}</span>}
        </span>
    );
}

function RowDetail({ row, onFeedback }) {
    const [detail, setDetail] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        getGuardianDecision(row.id).then(res => {
            if (!alive) return;
            if (res.success) setDetail(res.row);
            else setError(res.error);
        });
        return () => { alive = false; };
    }, [row.id]);

    const link = rowLink(row);
    const full = detail ? { ...detail, outcome: row.outcome, decided_by: row.decided_by, feedback: row.feedback } : row;
    return (
        <div className="space-y-3 p-4 bg-zinc-950/60">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                    <div><span className="text-zinc-500">Decided by: </span><span className="text-zinc-300">{full.decided_by || '-'}</span></div>
                    <div><span className="text-zinc-500">Mode: </span><span className="text-zinc-300">{full.mode || '-'}</span></div>
                    <div><span className="text-zinc-500">Guardian said: </span><span className="text-zinc-300">{full.model_verdict || '-'}</span>
                        {full.verdict && full.model_verdict && full.verdict !== full.model_verdict && (
                            <span className="text-zinc-500"> (applied as {full.verdict})</span>
                        )}
                    </div>
                    {full.floor?.length > 0 && <div><span className="text-zinc-500">Floor hit: </span><span className="text-zinc-300">{full.floor.join(', ')}</span></div>}
                    {full.always_ask?.length > 0 && <div><span className="text-zinc-500">Your always-ask hit: </span><span className="text-zinc-300 font-mono">{full.always_ask.join(', ')}</span></div>}
                    {full.breaker_tripped && <div className="text-orange-300">This call tripped the breaker.</div>}
                </div>
                <div className="space-y-1">
                    <div><span className="text-zinc-500">Taint: </span><span className="text-zinc-300">{full.taint_sources?.length ? full.taint_sources.join('; ') : 'none'}</span></div>
                    <div><span className="text-zinc-500">Tokens: </span><span className="text-zinc-300 font-mono">{full.tokens ?? '-'}</span>
                        <span className="text-zinc-500"> · Cost: </span><span className="text-zinc-300 font-mono">{full.cost != null ? `$${Number(full.cost).toFixed(5)}` : '-'}</span></div>
                    {full.feedback && <div><span className="text-zinc-500">Your feedback: </span><span className="text-zinc-300">{full.feedback === 'should_allow' ? 'should have been allowed' : 'should have been denied'}</span></div>}
                    {link && (
                        <Link href={link.href} className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            <ExternalLink className="h-3 w-3" /> {link.label}
                        </Link>
                    )}
                </div>
            </div>
            {full.reason && <p className="text-xs text-zinc-300 whitespace-pre-wrap"><span className="text-zinc-500">Reason: </span>{full.reason}</p>}
            <div>
                <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Exact input the guardian saw</p>
                {error && <p className="text-xs text-red-400">{error}</p>}
                {!detail && !error && <p className="text-xs text-zinc-500">Loading…</p>}
                {detail && (detail.guardian_input
                    ? <pre className="max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-black p-3 text-[11px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words">{JSON.stringify(detail.guardian_input, null, 2)}</pre>
                    : <p className="text-xs text-zinc-500">The guardian was not called for this row (deny-list, a command the shell blocks, breaker, manual or off mode).</p>)}
            </div>
            <FeedbackButtons row={full} onChange={onFeedback} />
        </div>
    );
}

/** History: one row per gated call, newest first, with filters and a detail view. */
export default function GuardianHistory() {
    const [filters, setFilters] = useState({ outcome: '', tool: '', risk: '', sourceKind: '', from: '', to: '' });
    const [toolInput, setToolInput] = useState('');
    const [page, setPage] = useState(0);
    const [data, setData] = useState({ rows: [], total: 0 });
    const [loading, setLoading] = useState(true);
    const [openId, setOpenId] = useState(null);
    const { socket } = useSocket();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await getGuardianHistory({ ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
            setData(res);
        } finally {
            setLoading(false);
        }
    }, [filters, page]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        const t = setTimeout(() => {
            setFilters(f => (f.tool === toolInput.trim() ? f : { ...f, tool: toolInput.trim() }));
            setPage(0);
        }, 300);
        return () => clearTimeout(t);
    }, [toolInput]);

    // An escalated row settles when the owner answers anywhere.
    useEffect(() => {
        if (!socket) return;
        const handler = () => load();
        socket.on('agent:approval', handler);
        return () => socket.off('agent:approval', handler);
    }, [socket, load]);

    const setFilter = (key, value) => { setFilters(f => ({ ...f, [key]: value })); setPage(0); };
    const updateRow = (row) => setData(d => ({ ...d, rows: d.rows.map(r => (r.id === row.id ? { ...r, ...row, guardian_input: undefined } : r)) }));
    const pages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

    return (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-zinc-200">History</h2>
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                        <span>{data.total || 0} rows</span>
                        <button onClick={load} className="p-1.5 hover:text-white" title="Refresh">
                            <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
                        </button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <select value={filters.outcome} onChange={e => setFilter('outcome', e.target.value)} className={INPUT_CLASS} aria-label="Outcome">
                        <option value="">All outcomes</option>
                        {OUTCOMES.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <input value={toolInput} onChange={e => setToolInput(e.target.value)} placeholder="Tool (browser_* works)" className={clsx(INPUT_CLASS, 'min-w-0 flex-1 sm:flex-none')} aria-label="Tool" />
                    <select value={filters.risk} onChange={e => setFilter('risk', e.target.value)} className={INPUT_CLASS} aria-label="Risk">
                        <option value="">Any risk</option>
                        {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <select value={filters.sourceKind} onChange={e => setFilter('sourceKind', e.target.value)} className={INPUT_CLASS} aria-label="Source">
                        <option value="">Any source</option>
                        {SOURCE_KINDS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                    <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)} className={INPUT_CLASS} aria-label="From" />
                    <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)} className={INPUT_CLASS} aria-label="To" />
                </div>
                {data.error && <p className="text-xs text-red-400">{data.error}</p>}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[900px]">
                    <thead className="bg-zinc-950 text-zinc-500 uppercase text-[11px] border-b border-zinc-800">
                        <tr>
                            <th className="px-3 py-2 w-6" />
                            <th className="px-3 py-2">Time</th>
                            <th className="px-3 py-2">Run</th>
                            <th className="px-3 py-2">Tool</th>
                            <th className="px-3 py-2">Target</th>
                            <th className="px-3 py-2">Taint</th>
                            <th className="px-3 py-2">Outcome</th>
                            <th className="px-3 py-2">By</th>
                            <th className="px-3 py-2">Risk</th>
                            <th className="px-3 py-2 text-right">Latency</th>
                            <th className="px-3 py-2">Feedback</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows?.length === 0 && !loading && (
                            <tr><td colSpan={11} className="px-4 py-10 text-center text-zinc-500">No gated calls match.</td></tr>
                        )}
                        {(data.rows || []).map(row => {
                            const open = openId === row.id;
                            const link = rowLink(row);
                            return (
                                <Fragment key={row.id}>
                                    <tr
                                        onClick={() => setOpenId(open ? null : row.id)}
                                        className={clsx('border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-800/30 align-top', open && 'bg-zinc-800/30')}
                                    >
                                        <td className="px-3 py-2 text-zinc-500">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                                        <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap">{when(row.created_at)}</td>
                                        <td className="px-3 py-2 text-xs text-zinc-300 max-w-[160px]">
                                            {link
                                                ? <Link href={link.href} onClick={e => e.stopPropagation()} className="hover:text-indigo-300 truncate block">{sourceLabel(row)}</Link>
                                                : <span className="truncate block">{sourceLabel(row)}</span>}
                                        </td>
                                        <td className="px-3 py-2 font-mono text-xs text-zinc-200">{row.tool_name}</td>
                                        <td className="px-3 py-2 text-xs text-zinc-400 max-w-[160px] truncate" title={row.target || ''}>{row.target || '-'}</td>
                                        <td className="px-3 py-2 text-xs text-zinc-400 max-w-[160px] truncate" title={(row.taint_sources || []).join('; ')}>{row.taint_sources?.length ? row.taint_sources[0] + (row.taint_sources.length > 1 ? ` +${row.taint_sources.length - 1}` : '') : '-'}</td>
                                        <td className="px-3 py-2">
                                            <span className={clsx('inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px]', outcomeTone(row.outcome))}>{outcomeLabel(row.outcome)}</span>
                                            {row.reason && <p className="mt-1 text-[11px] text-zinc-500 line-clamp-2 max-w-[260px]">{row.reason}</p>}
                                        </td>
                                        <td className="px-3 py-2 text-xs text-zinc-400">{row.decided_by || '-'}</td>
                                        <td className={clsx('px-3 py-2 text-xs', RISK_TONE[row.risk] || 'text-zinc-500')}>{row.risk || '-'}</td>
                                        <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">{formatMs(row.latency_ms)}</td>
                                        <td className="px-3 py-2"><FeedbackButtons row={row} onChange={updateRow} compact /></td>
                                    </tr>
                                    {open && (
                                        <tr className="border-b border-zinc-800">
                                            <td colSpan={11} className="p-0"><RowDetail row={row} onFeedback={updateRow} /></td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {pages > 1 && (
                <div className="flex items-center justify-end gap-3 p-3 border-t border-zinc-800 text-xs text-zinc-500">
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="p-1 disabled:opacity-30 hover:text-white" title="Newer"><ChevronLeft className="h-4 w-4" /></button>
                    <span>Page {page + 1} of {pages}</span>
                    <button disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)} className="p-1 disabled:opacity-30 hover:text-white" title="Older"><ChevronRight className="h-4 w-4" /></button>
                </div>
            )}
        </div>
    );
}
