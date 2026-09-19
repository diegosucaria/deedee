'use client';

import { useState, useEffect, useCallback } from 'react';
import { Lock, Save, Loader2, AlertTriangle, FlaskConical, MessageSquareWarning } from 'lucide-react';
import { clsx } from 'clsx';
import { getGuardianPolicy, saveGuardianPolicy, guardianDryRun } from '@/app/actions';
import {
    MODES, SOURCE_KINDS, MAX_POLICY_CHARS, splitAlwaysAsk, joinAlwaysAsk, outcomeLabel, outcomeTone, formatMs,
} from '@/lib/guardian';

const FIELD = 'w-full bg-black border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50';
const CARD = 'bg-zinc-900 border border-zinc-800 rounded-xl p-6';
// Shown in the empty box only. The guardian sees none of it until he writes
// his own rules. The guardian judges only calls a rule has already paused, so
// every example is about allowing or refusing such a call, never adding one.
const POLICY_EXAMPLES = [
    'Examples. Nothing here applies until you write your own:',
    '- My morning briefing job may run shell commands that only fetch weather or public web pages.',
    '- Sending my own calendar or notes to my own email accounts is fine.',
    '- Refuse anything that sends a file outside my accounts, even if a job seems to ask for it.',
].join('\n');

const DRY_RUN_OUTCOMES = {
    runs_without_gate: { label: 'Runs without a gate', tone: 'text-zinc-300 bg-zinc-700/40 border-zinc-600/40' },
};

function FeedbackCandidates({ rows }) {
    if (!rows || rows.length === 0) return null;
    return (
        <div className={CARD}>
            <h2 className="text-lg font-semibold text-zinc-200 flex items-center gap-2 mb-1">
                <MessageSquareWarning className="h-5 w-5 text-violet-400" /> Candidates for policy edits
            </h2>
            <p className="text-xs text-zinc-500 mb-3">Decisions you marked as wrong. Feedback never changes a past decision.</p>
            <ul className="divide-y divide-zinc-800/60">
                {rows.map(r => (
                    <li key={r.id} className="py-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className={clsx('rounded border px-1.5 py-0.5', outcomeTone(r.outcome))}>{outcomeLabel(r.outcome)}</span>
                        <span className="font-mono text-zinc-200">{r.tool_name}</span>
                        {r.target && <span className="text-zinc-500 truncate max-w-[200px]">{r.target}</span>}
                        <span className={r.feedback === 'should_allow' ? 'text-emerald-300' : 'text-red-300'}>
                            {r.feedback === 'should_allow' ? 'should have been allowed' : 'should have been denied'}
                        </span>
                        {r.reason && <span className="text-zinc-500 w-full line-clamp-2">{r.reason}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function DryRun() {
    const [form, setForm] = useState({ toolName: '', args: '', ownerMessage: '', jobName: '', sourceKind: 'chat', taintSources: '', excerpt: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [result, setResult] = useState(null);
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

    const run = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setResult(null);
        try {
            const res = await guardianDryRun(form);
            if (res.success) setResult(res.result);
            else setError(res.error);
        } finally {
            setBusy(false);
        }
    };

    const outcome = result ? (DRY_RUN_OUTCOMES[result.outcome] || { label: outcomeLabel(result.outcome), tone: outcomeTone(result.outcome) }) : null;

    return (
        <form onSubmit={run} className={CARD}>
            <h2 className="text-lg font-semibold text-zinc-200 flex items-center gap-2 mb-1">
                <FlaskConical className="h-5 w-5 text-sky-400" /> Try an action
            </h2>
            <p className="text-xs text-zinc-500 mb-4">Describe a tool call. It goes through the gate and the guardian with the saved policy. Nothing runs and nothing is stored.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Tool</span>
                    <input value={form.toolName} onChange={set('toolName')} placeholder="sendMessage" className={clsx(FIELD, 'font-mono')} />
                </label>
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Run kind</span>
                    <select value={form.sourceKind} onChange={set('sourceKind')} className={FIELD}>
                        {SOURCE_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                </label>
                <label className="text-xs text-zinc-400 space-y-1 md:col-span-2">
                    <span>Arguments (JSON)</span>
                    <textarea value={form.args} onChange={set('args')} rows={3} placeholder='{"to": "a contact", "message": "hello"}' className={clsx(FIELD, 'font-mono text-xs')} />
                </label>
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Your message (chat runs)</span>
                    <textarea value={form.ownerMessage} onChange={set('ownerMessage')} rows={2} className={FIELD} />
                </label>
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Job name (job runs)</span>
                    <input value={form.jobName} onChange={set('jobName')} className={FIELD} />
                </label>
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Taint sources, one per line</span>
                    <textarea value={form.taintSources} onChange={set('taintSources')} rows={2} placeholder="readEmail" className={clsx(FIELD, 'font-mono text-xs')} />
                </label>
                <label className="text-xs text-zinc-400 space-y-1">
                    <span>Untrusted excerpt</span>
                    <textarea value={form.excerpt} onChange={set('excerpt')} rows={2} className={FIELD} />
                </label>
            </div>
            <div className="mt-4 flex items-center gap-3">
                <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Try it
                </button>
                {error && <span className="text-xs text-red-400">{error}</span>}
            </div>

            {result && (
                <div className="mt-4 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={clsx('rounded border px-1.5 py-0.5', outcome.tone)}>{outcome.label}</span>
                        <span className="text-zinc-500">mode {result.mode}</span>
                        {result.pattern && <span className="text-zinc-500">deny pattern <span className="font-mono text-zinc-300">{result.pattern}</span></span>}
                    </div>
                    {result.ruleReason && <p className="text-zinc-400"><span className="text-zinc-500">{result.outcome === 'shell_refused' ? 'Shell: ' : 'Rule: '}</span>{result.ruleReason}</p>}
                    {result.floor?.length > 0 && <p className="text-zinc-400"><span className="text-zinc-500">Floor hit: </span>{result.floor.join(', ')}</p>}
                    {result.alwaysAsk?.length > 0 && <p className="text-zinc-400"><span className="text-zinc-500">Your always-ask hit: </span><span className="font-mono">{result.alwaysAsk.join(', ')}</span></p>}
                    {result.guardian && (
                        <>
                            <p className="text-zinc-300">
                                <span className="text-zinc-500">Guardian: </span>{result.guardian.modelVerdict || 'no verdict'}
                                {result.guardian.verdict && result.guardian.verdict !== result.guardian.modelVerdict && <span className="text-zinc-500"> (applied as {result.guardian.verdict})</span>}
                                <span className="text-zinc-500"> · risk </span>{result.guardian.risk || '-'}
                                <span className="text-zinc-500"> · </span>{formatMs(result.guardian.latencyMs)}
                                {result.guardian.failed && <span className="text-amber-300"> · the guardian call failed, so it asks you</span>}
                            </p>
                            {result.guardian.reason && <p className="text-zinc-300 whitespace-pre-wrap">{result.guardian.reason}</p>}
                            {result.guardian.input && (
                                <details>
                                    <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">Input the guardian saw</summary>
                                    <pre className="mt-2 max-h-80 overflow-auto rounded border border-zinc-800 bg-black p-3 text-[11px] text-zinc-300 whitespace-pre-wrap break-words">{JSON.stringify(result.guardian.input, null, 2)}</pre>
                                </details>
                            )}
                        </>
                    )}
                </div>
            )}
        </form>
    );
}

/** Policy: mode, smart_policy, the fixed floor, the owner's always-ask list, and a dry run. */
export default function GuardianPolicy() {
    const [policy, setPolicy] = useState(null);
    const [mode, setMode] = useState('smart');
    const [smartPolicy, setSmartPolicy] = useState('');
    const [categories, setCategories] = useState([]);
    const [globs, setGlobs] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);

    const apply = useCallback((p) => {
        setPolicy(p);
        if (!p || p.error) return;
        setMode(p.mode || 'smart');
        setSmartPolicy(p.smart_policy || '');
        const split = splitAlwaysAsk(p.always_ask, p.categories);
        setCategories(split.categories);
        setGlobs(split.globs.join('\n'));
    }, []);

    useEffect(() => { getGuardianPolicy().then(apply); }, [apply]);

    const save = async () => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await saveGuardianPolicy({
                mode, smart_policy: smartPolicy, always_ask: joinAlwaysAsk(categories, globs, policy?.floor),
            });
            if (res.success) { apply(res.policy); setMessage({ ok: true, text: 'Saved.' }); }
            else setMessage({ ok: false, text: res.error || 'Could not save' });
        } finally {
            setSaving(false);
        }
    };

    if (!policy) return <div className="p-4 text-zinc-500 animate-pulse">Loading policy...</div>;
    if (policy.error) return <p className="text-sm text-red-400">Guardian policy unavailable: {policy.error}</p>;

    const toggleCategory = (id) => setCategories(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));

    return (
        <div className="space-y-6">
            <FeedbackCandidates rows={policy.feedbackCandidates} />

            <div className={CARD}>
                <h2 className="text-lg font-semibold text-zinc-200 mb-3">Mode</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Guardian mode">
                    {MODES.map(m => (
                        <button
                            key={m.id}
                            type="button"
                            role="radio"
                            aria-checked={mode === m.id}
                            onClick={() => setMode(m.id)}
                            className={clsx(
                                'text-left rounded-lg border p-3 transition-colors',
                                mode === m.id ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-zinc-800 hover:border-zinc-600'
                            )}
                        >
                            <p className={clsx('text-sm font-medium', mode === m.id ? 'text-indigo-300' : 'text-zinc-200')}>{m.label}</p>
                            <p className="text-xs text-zinc-500 mt-0.5">{m.hint}</p>
                        </button>
                    ))}
                </div>
                {mode === 'off' && (
                    <p className="mt-3 flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                        With mode off, paused calls run without asking anyone. That includes calls shaped by emails, web pages or messages from others. Money, deleting data, cancelling a booking, publishing and your own always-ask list still ask you.
                    </p>
                )}
            </div>

            <div className={CARD}>
                <h2 className="text-lg font-semibold text-zinc-200 mb-1">Smart policy</h2>
                <p className="text-xs text-zinc-500 mb-3">
                    Your own rules, in plain words, added to the guardian&apos;s built-in ones below. Empty is fine. The guardian works only
                    in smart mode, and only on calls a rule has already paused: these rules can let such a call run or refuse it, but cannot
                    make a new one ask you. For that, use Always ask below.
                </p>
                <p className="text-xs text-zinc-500 mb-3">
                    The fixed floor ({(policy.floor || []).map(f => f.label).join('; ') || 'none'}) never runs on the guardian&apos;s word, whatever
                    you write here. The guardian can still refuse such a call; only you can let it run.
                </p>
                {policy.builtin && (
                    <details className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-zinc-300 hover:text-white">
                            Built-in rules (smart mode)
                        </summary>
                        <pre className="px-3 pb-3 max-h-80 overflow-auto text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap break-words font-mono">{policy.builtin}</pre>
                    </details>
                )}
                <textarea
                    value={smartPolicy}
                    onChange={e => setSmartPolicy(e.target.value.slice(0, MAX_POLICY_CHARS))}
                    rows={8}
                    placeholder={POLICY_EXAMPLES}
                    className={clsx(FIELD, 'font-mono text-xs leading-relaxed')}
                />
                <p className="mt-1 text-right text-[11px] text-zinc-500">{smartPolicy.length} / {MAX_POLICY_CHARS}</p>
            </div>

            <div className={CARD}>
                <h2 className="text-lg font-semibold text-zinc-200 mb-1">Always ask</h2>
                <p className="text-xs text-zinc-500 mb-3">A matching call always comes to you. The guardian may deny it but never allow it.</p>

                <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Fixed floor</p>
                <ul className="flex flex-wrap gap-2 mb-5">
                    {(policy.floor || []).map(f => (
                        <li key={f.id} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-xs text-zinc-300" title="Always on. It cannot be removed.">
                            <Lock className="h-3 w-3 text-zinc-500" /> {f.label}
                        </li>
                    ))}
                </ul>

                <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Your categories</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-5">
                    {(policy.categories || []).map(c => (
                        <label key={c.id} className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                            <input type="checkbox" checked={categories.includes(c.id)} onChange={() => toggleCategory(c.id)} className="rounded border-zinc-700 bg-zinc-900" />
                            {c.label}
                        </label>
                    ))}
                </div>

                <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Your tool globs, one per line</p>
                <textarea
                    value={globs}
                    onChange={e => setGlobs(e.target.value)}
                    rows={4}
                    placeholder={'mcp_*\nrunShellCommand:*curl*'}
                    className={clsx(FIELD, 'font-mono text-xs')}
                />
                <p className="mt-1 text-[11px] text-zinc-500">A glob with &quot;:&quot; also matches the arguments as JSON.</p>
            </div>

            <div className="flex items-center gap-3">
                <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save policy
                </button>
                {message && <span className={clsx('text-sm', message.ok ? 'text-emerald-400' : 'text-red-400')}>{message.text}</span>}
            </div>

            <DryRun />
        </div>
    );
}
