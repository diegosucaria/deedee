'use client';

import { useState, useMemo } from 'react';
import { ChevronRight, Wrench, CheckCircle2, XCircle, Loader2, Sparkles, Brain, PauseCircle } from 'lucide-react';
import clsx from 'clsx';

/**
 * Renders a stream (live or persisted) of agent reasoning activity:
 * tool calls, tool results, and thought summaries.
 *
 * `entries` is an ordered array of:
 *   { kind: 'tool', id, name, args, status: 'pending'|'ok'|'error'|'paused', result?, durationMs? }
 *   { kind: 'thought', id, text }
 *
 * `live=true` shows a spinner header and auto-expands so the user can watch progress.
 * `live=false` is the persisted-history mode — collapsed by default.
 */
export default function ThinkingPanel({ entries, live = false, statusText = '' }) {
    const [expanded, setExpanded] = useState(live);

    const summary = useMemo(() => {
        const tools = entries.filter(e => e.kind === 'tool');
        const thoughts = entries.filter(e => e.kind === 'thought');
        const pending = tools.filter(t => t.status === 'pending').length;
        const errors = tools.filter(t => t.status === 'error').length;
        const paused = tools.filter(t => t.status === 'paused').length;
        const ok = tools.filter(t => t.status === 'ok').length;
        return { toolCount: tools.length, thoughtCount: thoughts.length, pending, errors, paused, ok };
    }, [entries]);

    if (entries.length === 0 && !live && !statusText) return null;

    const headerLine = (() => {
        if (live) {
            if (statusText) return statusText;
            const lastTool = [...entries].reverse().find(e => e.kind === 'tool');
            if (lastTool) {
                if (lastTool.status === 'pending') return `Calling ${lastTool.name}…`;
                if (lastTool.status === 'paused') return `Awaiting confirmation: ${lastTool.name}`;
                return `Used ${lastTool.name}`;
            }
            const lastThought = [...entries].reverse().find(e => e.kind === 'thought');
            if (lastThought) return 'Thinking…';
            return 'Working…';
        }
        const parts = [];
        if (summary.toolCount > 0) parts.push(`${summary.toolCount} tool${summary.toolCount === 1 ? '' : 's'}`);
        if (summary.thoughtCount > 0) parts.push('reasoning');
        if (parts.length === 0) parts.push('activity');
        const tail = [];
        if (summary.errors > 0) tail.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
        if (summary.paused > 0) tail.push(`${summary.paused} paused`);
        const detail = tail.length > 0 ? ` · ${tail.join(', ')}` : '';
        return parts.join(' + ') + detail;
    })();

    return (
        <div
            className={clsx(
                'rounded-xl border text-xs transition-colors',
                live
                    ? 'border-indigo-500/40 bg-indigo-500/5'
                    : 'border-zinc-700/70 bg-zinc-800/40 hover:border-zinc-600',
                'max-w-[90%] md:max-w-[70%]'
            )}
        >
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
                {live ? (
                    summary.pending > 0 ? (
                        <Loader2 className="h-3.5 w-3.5 text-indigo-400 animate-spin shrink-0" />
                    ) : (
                        <Sparkles className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                    )
                ) : summary.errors > 0 ? (
                    <XCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                ) : summary.paused > 0 ? (
                    <PauseCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                ) : (
                    <Brain className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                )}
                <span className={clsx('flex-1 truncate', live ? 'text-indigo-100' : 'text-zinc-300')}>
                    {headerLine}
                </span>
                <ChevronRight
                    className={clsx(
                        'h-3.5 w-3.5 text-zinc-500 transition-transform shrink-0',
                        expanded && 'rotate-90'
                    )}
                />
            </button>

            {expanded && (
                <div className="px-3 pb-3 pt-0 space-y-2 border-t border-zinc-700/40">
                    {entries.map((entry, idx) => (
                        <ActivityEntry key={entry.id || idx} entry={entry} />
                    ))}
                    {entries.length === 0 && live && (
                        <div className="text-zinc-500 italic py-1">Waiting for the model…</div>
                    )}
                </div>
            )}
        </div>
    );
}

function ActivityEntry({ entry }) {
    const [open, setOpen] = useState(false);

    if (entry.kind === 'thought') {
        return (
            <div className="pt-2 flex gap-2">
                <Sparkles className="h-3 w-3 text-indigo-400/70 shrink-0 mt-0.5" />
                <div className="text-zinc-400 italic leading-relaxed whitespace-pre-wrap break-words">
                    {entry.text}
                </div>
            </div>
        );
    }

    // Tool entry
    const statusIcon = entry.status === 'pending' ? (
        <Loader2 className="h-3 w-3 text-indigo-400 animate-spin shrink-0" />
    ) : entry.status === 'error' ? (
        <XCircle className="h-3 w-3 text-rose-400 shrink-0" />
    ) : entry.status === 'paused' ? (
        <PauseCircle className="h-3 w-3 text-amber-400 shrink-0" />
    ) : (
        <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
    );

    const displayName = (entry.name || '').replace(/^default_api:/, '');
    const argsStr = formatPreview(entry.args);
    const resultStr = formatPreview(entry.result);
    const hasDetail = !!(argsStr || resultStr);

    return (
        <div className="pt-2">
            <button
                type="button"
                onClick={() => hasDetail && setOpen(v => !v)}
                className={clsx(
                    'w-full flex items-center gap-2 text-left',
                    hasDetail && 'cursor-pointer hover:text-white'
                )}
            >
                {statusIcon}
                <Wrench className="h-3 w-3 text-zinc-500 shrink-0" />
                <span className="font-mono text-zinc-200 truncate">{displayName}</span>
                {entry.durationMs != null && (
                    <span className="text-[10px] text-zinc-500 shrink-0">{formatMs(entry.durationMs)}</span>
                )}
                {hasDetail && (
                    <ChevronRight
                        className={clsx(
                            'h-3 w-3 text-zinc-500 transition-transform ml-auto shrink-0',
                            open && 'rotate-90'
                        )}
                    />
                )}
            </button>
            {open && hasDetail && (
                <div className="mt-1.5 ml-5 space-y-1.5">
                    {argsStr && (
                        <DetailBlock label="args" body={argsStr} tone="indigo" />
                    )}
                    {resultStr && (
                        <DetailBlock
                            label={
                                entry.status === 'error' ? 'error'
                                    : entry.status === 'paused' ? 'paused'
                                        : 'result'
                            }
                            body={resultStr}
                            tone={
                                entry.status === 'error' ? 'rose'
                                    : entry.status === 'paused' ? 'amber'
                                        : 'emerald'
                            }
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function DetailBlock({ label, body, tone }) {
    const toneClass = {
        indigo: 'text-indigo-300',
        emerald: 'text-emerald-300',
        rose: 'text-rose-300',
        amber: 'text-amber-300',
    }[tone] || 'text-zinc-300';

    return (
        <div>
            <div className={clsx('text-[10px] uppercase tracking-wide', toneClass)}>{label}</div>
            <pre className="mt-0.5 bg-black/30 rounded p-2 text-[11px] text-zinc-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
                {body}
            </pre>
        </div>
    );
}

function formatPreview(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') {
        // Try to pretty-print JSON if it parses
        try {
            const parsed = JSON.parse(value);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return value;
        }
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function formatMs(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
