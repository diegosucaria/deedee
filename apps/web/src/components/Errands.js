'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ClipboardList, Loader2, AlertTriangle, RefreshCw, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { getErrands, getErrand, cancelErrand } from '../app/actions';
import { useSocket } from '@/hooks/useSocket';
import { timeAgo } from '@/lib/models';
import { stateLabel, stateTone, goalLabel, slotRows, countsText, isOpen, splitErrands, eventLine } from '@/lib/errands';

const RECENT_CLOSED = 10;
// A step often writes several events at once; one reload covers them all.
const RELOAD_DELAY_MS = 400;
const ANY = '*'; // an update that names no errand
const EXAMPLE = 'book me a haircut on Thursday';

const loadList = () => getErrands({ all: true }).catch((e) => ({ ok: false, error: e?.message || 'Could not load.' }));
const loadOne = (id) => getErrand(id).catch((e) => ({ ok: false, error: e?.message || 'Could not load.' }));

const localTime = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString();
};

const EVENT_TONES = {
    sent: 'text-zinc-100',
    received: 'text-sky-300',
    booked: 'text-emerald-300',
    asked: 'text-amber-300',
    paused: 'text-violet-300',
    refused: 'text-amber-400',
    error: 'text-red-400',
};
const eventTone = (kind) => (Object.prototype.hasOwnProperty.call(EVENT_TONES, kind) ? EVENT_TONES[kind] : 'text-zinc-300');

function Steps({ errand, detail, now, limits }) {
    if (!detail || detail.loading) {
        return (
            <div id={`errand-${errand.id}-steps`} className="border-t border-zinc-800 px-4 py-3 text-sm text-zinc-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading steps...
            </div>
        );
    }
    const facts = [
        `Model calls: ${errand.modelCalls ?? 0}${limits?.modelCalls ? ` of ${limits.modelCalls}` : ''}`,
        errand.nextCheckAt ? `Next step after ${localTime(errand.nextCheckAt)}` : null,
        isOpen(errand) && errand.expiresAt ? `Ends ${localTime(errand.expiresAt)}` : null,
        errand.closedAt ? `Closed ${localTime(errand.closedAt)}${errand.closeReason ? `: ${errand.closeReason}` : ''}` : null,
    ].filter(Boolean);
    return (
        <div id={`errand-${errand.id}-steps`} className="border-t border-zinc-800 px-4 py-3">
            {detail.error && (
                <p className="text-xs text-red-400 mb-2">Couldn&apos;t load the steps: {detail.error}</p>
            )}
            {detail.events.length === 0 && !detail.error && <p className="text-sm text-zinc-500">No steps yet.</p>}
            {detail.events.length > 0 && (
                <ol className="space-y-2">
                    {detail.events.map((ev) => (
                        <li key={ev.id} className="flex gap-3 text-sm">
                            <time dateTime={ev.at} title={localTime(ev.at)} className="w-16 shrink-0 text-xs text-zinc-500 pt-0.5">
                                {timeAgo(ev.at, now)}
                            </time>
                            <span className={clsx('min-w-0 break-words', eventTone(ev.kind))}>{eventLine(ev)}</span>
                        </li>
                    ))}
                </ol>
            )}
            <p className="text-xs text-zinc-500 mt-3">{facts.join(' · ')}</p>
        </div>
    );
}

function ErrandCard({ errand, now, limits, enabled, detail, cancelling, onToggle, onCancel }) {
    const open = isOpen(errand);
    const expanded = !!detail;
    const rows = slotRows(errand);
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
        <div className={clsx('bg-zinc-900 border rounded-xl transition-colors', expanded ? 'border-zinc-700' : 'border-zinc-800 hover:border-zinc-700')}>
            <div className="flex items-start gap-3 p-4">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    aria-controls={`errand-${errand.id}-steps`}
                    className="flex-1 min-w-0 flex items-start gap-2 text-left"
                >
                    <Chevron className="w-4 h-4 mt-1 shrink-0 text-zinc-500" />
                    <span className="block min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-white break-words">{errand.contactName || 'Unknown contact'}</span>
                            <span className="text-xs text-zinc-500">{goalLabel(errand.goal)}</span>
                            <span className={clsx('text-xs px-2 py-0.5 rounded-full border', stateTone(errand.state))}>{stateLabel(errand.state)}</span>
                        </span>
                        {errand.request && (
                            <span className="block text-sm text-zinc-300 mt-1 break-words">&ldquo;{errand.request}&rdquo;</span>
                        )}
                        {rows.length > 0 && (
                            <span className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
                                {rows.map((r) => (
                                    <span key={r.label}>
                                        <span className="text-zinc-500">{r.label}:</span> <span className="text-zinc-200">{r.text}</span>
                                    </span>
                                ))}
                            </span>
                        )}
                        <span className="block text-xs text-zinc-500 mt-2">
                            {countsText(errand)} · started <span title={localTime(errand.createdAt)}>{timeAgo(errand.createdAt, now)}</span>
                        </span>
                    </span>
                </button>
                {open && enabled && (
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={cancelling}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:text-red-300 hover:border-red-500/40 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                        {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                        Cancel
                    </button>
                )}
            </div>
            {open && errand.state === 'waiting_owner' && errand.waitingCard && (
                <p className="px-4 pb-3 -mt-1 text-xs text-amber-300/90">
                    A card waits for your answer in your chat or in <Link href="/approvals" className="underline hover:text-amber-200">Approvals</Link>.
                </p>
            )}
            {expanded && <Steps errand={errand} detail={detail} now={now} limits={limits} />}
        </div>
    );
}

// Autopilot → Errands: what Deedee is doing for the owner with one contact
// at a time (specs/050-errands.md). Open errands first, recent closed ones
// below; a card opens its steps. Live over the socket (errands:update).
export default function Errands() {
    const [view, setView] = useState({ loaded: false, error: null, enabled: true, limits: null, errands: null });
    const [now, setNow] = useState(0);
    const [detail, setDetail] = useState(null); // { id, loading, error, events } for the open card
    const [cancelling, setCancelling] = useState(null);
    const [showAll, setShowAll] = useState(false);
    const seq = useRef(0);
    const stepsSeq = useRef(0);
    const openRef = useRef(null);
    const { socket } = useSocket();

    // Only the newest load lands: a slow answer cannot overwrite a newer one.
    const applyList = useCallback((mine, res) => {
        if (mine !== seq.current) return;
        setView((prev) => (res?.ok
            ? { loaded: true, error: null, enabled: res.enabled !== false, limits: res.limits || null, errands: res.errands || [] }
            : { ...prev, loaded: true, error: res?.error || 'Could not load.' }));
        setNow(Date.now());
    }, []);

    // The open card's steps. The same guard: only the newest load lands.
    const loadSteps = useCallback(async (id) => {
        const mine = ++stepsSeq.current;
        const res = await loadOne(id);
        if (mine !== stepsSeq.current) return;
        setDetail((prev) => {
            if (!prev || prev.id !== id) return prev; // closed, or another card opened meanwhile
            return res?.ok
                ? { id, loading: false, error: null, events: res.events || [] }
                : { ...prev, loading: false, error: res?.error || 'Could not load.' };
        });
        setNow(Date.now());
    }, []);

    const reload = useCallback(async ({ withSteps = false } = {}) => {
        const mine = ++seq.current;
        const id = openRef.current;
        const [list] = await Promise.all([loadList(), withSteps && id !== null ? loadSteps(id) : null]);
        applyList(mine, list);
    }, [applyList, loadSteps]);

    useEffect(() => {
        let active = true;
        (async () => {
            const mine = ++seq.current;
            const res = await loadList();
            if (active) applyList(mine, res);
        })();
        return () => {
            active = false;
        };
    }, [applyList]);

    // Keeps "5m ago" true while the tab sits open.
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!socket) return;
        let active = true;
        let timer = null;
        let changed = new Set();
        const flush = async () => {
            timer = null;
            const ids = changed;
            changed = new Set();
            const mine = ++seq.current;
            const id = openRef.current;
            const stepsChanged = id !== null && (ids.has(String(id)) || ids.has(ANY));
            const [list] = await Promise.all([loadList(), stepsChanged ? loadSteps(id) : null]);
            if (active) applyList(mine, list);
        };
        const onUpdate = (data) => {
            changed.add(data?.id === undefined || data?.id === null ? ANY : String(data.id));
            if (!timer) timer = setTimeout(flush, RELOAD_DELAY_MS);
        };
        socket.on('errands:update', onUpdate);
        return () => {
            active = false;
            socket.off('errands:update', onUpdate);
            if (timer) clearTimeout(timer);
        };
    }, [socket, applyList, loadSteps]);

    const toggle = async (id) => {
        if (openRef.current === id) {
            openRef.current = null;
            setDetail(null);
            return;
        }
        openRef.current = id;
        setDetail({ id, loading: true, error: null, events: [] });
        await loadSteps(id);
    };

    const cancel = async (errand) => {
        const who = errand.contactName || 'this contact';
        if (!confirm(`Cancel errand #${errand.id} with ${who}? Deedee stops and sends nothing more.`)) return;
        setCancelling(errand.id);
        const res = await cancelErrand(errand.id).catch((e) => ({ success: false, error: e?.message || 'Could not cancel.' }));
        setCancelling(null);
        if (!res?.success) alert('Failed to cancel: ' + (res?.error || 'unknown error'));
        await reload({ withSteps: true });
    };

    const retry = async () => {
        setView((prev) => ({ ...prev, loaded: false }));
        await reload({ withSteps: true });
    };

    if (!view.loaded) {
        return <div className="text-center text-zinc-500 mt-10"><Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Loading...</div>;
    }

    if (view.error && view.errands === null) {
        return (
            <div className="max-w-3xl bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <div className="flex items-center gap-2 text-red-400 text-sm">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Couldn&apos;t load the errands: {view.error}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-2">The agent may be restarting after a deploy.</p>
                <button type="button" onClick={retry} className="mt-4 inline-flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300">
                    <RefreshCw className="w-4 h-4" /> Try again
                </button>
            </div>
        );
    }

    const { open, closed } = splitErrands(view.errands);
    const shownClosed = showAll ? closed : closed.slice(0, RECENT_CLOSED);
    const card = (errand) => (
        <ErrandCard
            key={errand.id}
            errand={errand}
            now={now}
            limits={view.limits}
            enabled={view.enabled}
            detail={detail && detail.id === errand.id ? detail : null}
            cancelling={cancelling === errand.id}
            onToggle={() => toggle(errand.id)}
            onCancel={() => cancel(errand)}
        />
    );

    return (
        <div className="max-w-3xl space-y-6">
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
                    <ClipboardList className="w-5 h-5 text-indigo-400" />
                    Errands
                </h2>
                <p className="text-sm text-zinc-400">
                    Deedee writes to one person from your WhatsApp to get one thing done: book a slot, ask a question or
                    pass on a message. When a choice is yours, Deedee asks you first. Click an errand to see its steps.
                </p>
                {!view.enabled && (
                    <div className="mt-4 flex items-center gap-2 text-amber-300 text-sm bg-amber-500/10 p-3 rounded-lg border border-amber-500/20">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Errands are turned off (ERRANDS=0). Deedee starts none, and open ones wait until they are on again.</span>
                    </div>
                )}
                {view.error && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-red-400 text-sm bg-red-500/10 p-3 rounded-lg border border-red-500/20">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span className="flex-1 min-w-0">Couldn&apos;t refresh the errands: {view.error}</span>
                        <button type="button" onClick={() => reload({ withSteps: true })} className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
                            <RefreshCw className="w-4 h-4" /> Try again
                        </button>
                    </div>
                )}
            </div>

            {open.length === 0 && closed.length === 0 ? (
                <div className="text-center text-zinc-500 p-10 border border-zinc-900 rounded-xl bg-zinc-900/20">
                    <ClipboardList className="w-12 h-12 mx-auto mb-4 text-zinc-700" />
                    <h3 className="text-lg font-medium text-zinc-300">No errands yet</h3>
                    <p className="text-sm mt-1">
                        Deedee has no errands yet. To start one, ask Deedee in your chat, for example: &ldquo;{EXAMPLE}&rdquo;.
                    </p>
                </div>
            ) : (
                <>
                    <section className="space-y-3">
                        <h3 className="text-sm font-medium text-zinc-400">Open ({open.length})</h3>
                        {open.length === 0 && (
                            <p className="text-sm text-zinc-500">
                                Nothing open. To start an errand, ask Deedee in your chat, for example: &ldquo;{EXAMPLE}&rdquo;.
                            </p>
                        )}
                        {open.map(card)}
                    </section>
                    {closed.length > 0 && (
                        <section className="space-y-3">
                            <h3 className="text-sm font-medium text-zinc-400">Recent</h3>
                            {shownClosed.map(card)}
                            {closed.length > shownClosed.length && (
                                <button type="button" onClick={() => setShowAll(true)} className="text-sm text-indigo-400 hover:text-indigo-300">
                                    Show {closed.length - shownClosed.length} more
                                </button>
                            )}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
