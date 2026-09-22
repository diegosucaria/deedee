'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Heart, Search, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { getPartnerGreetingState, updateAgentConfig, getPeople, getWhatsAppContacts, toggleTask } from '../app/actions';
import { modeOf, describeContact, greetingTargets, pickTarget, pauseValue } from '../lib/greetings';

const MIN_QUERY = 2;

const JOBS = [
    { name: 'partner_good_morning', label: 'Good morning', when: '07:00, plus up to 75 minutes' },
    { name: 'partner_good_night', label: 'Good night', when: '22:30, plus up to 45 minutes' },
];

const MODES = [
    { id: 'send', label: 'Send', help: 'Deedee sends it from your WhatsApp and tells you what it sent.' },
    { id: 'review', label: 'Review first', help: 'Deedee sends you the draft on WhatsApp and puts it in Drafts. Approve it there to send. A morning draft expires after 3 hours, a night draft after 2.' },
    { id: 'dry_run', label: 'Dry run', help: 'Deedee sends you the draft on WhatsApp. Nothing reaches your partner.' },
];

const todayLocal = () => new Date().toLocaleDateString('en-CA');

async function searchTargets(query) {
    const [peopleRes, contacts] = await Promise.all([
        getPeople({ search: query, limit: 8 }),
        getWhatsAppContacts('user', query),
    ]);
    return greetingTargets(Array.isArray(peopleRes) ? peopleRes : peopleRes?.people || [], contacts);
}

const loadState = () => getPartnerGreetingState().catch((e) => ({ ok: false, error: e?.message || 'Could not load.' }));

// Autopilot → Greetings: who the partner_good_morning / partner_good_night
// jobs write to (as the owner), how the greeting is delivered, a pause for
// days together, and the two job switches. Stored in the partner_greeting
// agent setting: { contact, name, mode, pausedUntil }.
export default function PartnerGreetings() {
    const [value, setValue] = useState(null);
    const [jobs, setJobs] = useState([]);
    const [globalDryRun, setGlobalDryRun] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [pauseDraft, setPauseDraft] = useState(null);

    const saved = value && typeof value === 'object' && value.contact ? value : null;
    const mode = modeOf(saved);
    const trimmed = query.trim();
    const showResults = trimmed.length >= MIN_QUERY;
    const pauseActive = !!saved?.pausedUntil && saved.pausedUntil >= todayLocal();

    const apply = (state) => {
        if (!state?.ok) {
            setLoadError(state?.error || 'Could not load.');
        } else {
            setLoadError(null);
            setValue(state.value);
            setJobs(state.jobs);
            setGlobalDryRun(state.globalDryRun);
        }
        setLoaded(true);
    };

    useEffect(() => {
        let active = true;
        (async () => {
            const state = await loadState();
            if (active) apply(state);
        })();
        return () => {
            active = false;
        };
    }, []);

    // Debounced search; state only changes in the async callback.
    useEffect(() => {
        if (trimmed.length < MIN_QUERY) return;
        let active = true;
        const timer = setTimeout(async () => {
            const found = await searchTargets(trimmed).catch(() => []);
            if (!active) return;
            setResults(found);
            setSearching(false);
        }, 400);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [trimmed]);

    const retry = async () => {
        setLoaded(false);
        apply(await loadState());
    };

    const save = async (next) => {
        setValue(next);
        setError(null);
        const res = await updateAgentConfig('partner_greeting', next);
        if (!res?.success) {
            setError(res?.error || 'Could not save.');
            apply(await loadState());
        }
    };

    const onQueryChange = (e) => {
        setQuery(e.target.value);
        setSearching(e.target.value.trim().length >= MIN_QUERY);
    };

    const pick = (target) => {
        const next = pickTarget(saved, target);
        setNotice(saved && next.mode !== mode ? `Delivery is set to Dry run for ${next.name}. Choose Send or Review first below when you're ready.` : null);
        save(next);
        setQuery('');
        setResults([]);
        setSearching(false);
    };

    const update = (patch) => {
        if (!saved) return;
        const next = { ...saved, mode, ...patch };
        delete next.dryRun;
        setNotice(null);
        save(next);
    };

    const saveName = (next) => {
        const clean = next.trim();
        if (!saved || clean === (saved.name || '')) return;
        update({ name: clean });
    };

    const onPauseChange = (input) => {
        setPauseDraft(input);
        const next = pauseValue(input, todayLocal());
        if (next !== undefined) update({ pausedUntil: next });
    };

    const flipJob = async (job) => {
        setError(null);
        const res = await toggleTask(job.name, !job.enabled);
        if (!res?.success) {
            setError(res?.error || `Could not switch ${job.name}.`);
            return;
        }
        setJobs((prev) => prev.map((j) => (j.name === job.name ? { ...j, enabled: !job.enabled } : j)));
        // Reload for the next run time the agent just worked out.
        const state = await loadState();
        if (state.ok) setJobs(state.jobs);
    };

    if (!loaded) {
        return <div className="text-center text-zinc-500 mt-10"><Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />Loading...</div>;
    }

    if (loadError) {
        return (
            <div className="max-w-3xl bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <div className="flex items-center gap-2 text-red-400 text-sm">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Couldn&apos;t load the greeting settings: {loadError}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-2">Nothing was changed. The agent may be restarting after a deploy.</p>
                <button type="button" onClick={retry} className="mt-4 inline-flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300">
                    <RefreshCw className="w-4 h-4" /> Try again
                </button>
            </div>
        );
    }

    return (
        <div className="max-w-3xl space-y-6">
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
                    <Heart className="w-5 h-5 text-pink-400" />
                    Partner Greetings
                </h2>
                <p className="text-sm text-zinc-400">
                    Good-morning and good-night messages from your own WhatsApp, in your style. Deedee tells you on WhatsApp
                    about every greeting it writes or holds back. Days together, and days you already wrote, pass without a note.
                    If this person has a saved style in the Style tab, the greetings follow it.
                </p>
                {globalDryRun && (
                    <div className="mt-4 flex items-center gap-2 text-amber-300 text-sm bg-amber-500/10 p-3 rounded-lg border border-amber-500/20">
                        <AlertTriangle className="w-4 h-4" />
                        <span>
                            Dry run is on for all messages (<Link href="/settings?tab=communication" className="underline">Settings → Communication</Link>),
                            so greetings only reach you, whatever you pick here.
                        </span>
                    </div>
                )}
                {error && (
                    <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-500/10 p-3 rounded-lg border border-red-500/20">
                        <AlertTriangle className="w-4 h-4" />
                        <span>{error}</span>
                    </div>
                )}
            </div>

            {/* Who */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 space-y-6">
                <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-1">Send to</label>
                    {saved ? (
                        <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2">
                            <div className="text-white">{saved.name || 'Unnamed contact'}</div>
                            <div className="text-xs text-zinc-500">{describeContact(saved.contact)}</div>
                        </div>
                    ) : (
                        <p className="text-sm text-zinc-500">Nobody yet. Search your people and contacts below.</p>
                    )}
                    {notice && <p className="text-xs text-amber-400/90 mt-2">{notice}</p>}
                </div>

                <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-1">{saved ? 'Change contact' : 'Find contact'}</label>
                    <div className="relative">
                        <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={query}
                            onChange={onQueryChange}
                            placeholder="Search by name or number"
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-9 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        />
                        {searching && <Loader2 className="w-4 h-4 text-zinc-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
                    </div>
                    {showResults && results.length > 0 && (
                        <ul className="mt-2 border border-zinc-800 rounded-lg divide-y divide-zinc-800 overflow-hidden">
                            {results.map((t) => (
                                <li key={t.key}>
                                    <button type="button" onClick={() => pick(t)} className="w-full text-left px-4 py-2 hover:bg-zinc-800/60 transition-colors">
                                        <div className="text-white text-sm">{t.label}</div>
                                        <div className="text-xs text-zinc-500">{t.detail}</div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {showResults && !searching && results.length === 0 && (
                        <p className="text-xs text-zinc-500 mt-2">No people or contacts match.</p>
                    )}
                </div>

                {saved && (
                    <div className="border-t border-zinc-800/50 pt-6">
                        <label className="block text-sm font-medium text-zinc-400 mb-1">Name in notes to you</label>
                        <input
                            key={`${saved.contact}:${saved.name || ''}`}
                            type="text"
                            defaultValue={saved.name || ''}
                            onBlur={(e) => saveName(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        />
                        <p className="text-xs text-zinc-500 mt-1">
                            Only used in the messages Deedee sends you (&ldquo;Sent good morning to &hellip;&rdquo;). Never sent to them.
                        </p>
                    </div>
                )}
            </div>

            {saved && (
                <>
                    {/* How */}
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                        <h3 className="text-white font-medium mb-3">Delivery</h3>
                        <div className="space-y-2">
                            {MODES.map((m) => (
                                <label
                                    key={m.id}
                                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${mode === m.id ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-zinc-800 hover:border-zinc-700'}`}
                                >
                                    <input
                                        type="radio"
                                        name="greeting-mode"
                                        value={m.id}
                                        checked={mode === m.id}
                                        onChange={() => update({ mode: m.id })}
                                        className="mt-1"
                                    />
                                    <span>
                                        <span className="block text-sm text-white">{m.label}</span>
                                        <span className="block text-xs text-zinc-400">{m.help}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Days together */}
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                        <h3 className="text-white font-medium mb-1">Together until</h3>
                        <p className="text-sm text-zinc-400 mb-3">
                            On days you are together, no greetings go out. Pick the last day; greetings start again the morning after.
                        </p>
                        <div className="flex items-center gap-3">
                            <input
                                type="date"
                                value={pauseDraft ?? saved.pausedUntil ?? ''}
                                min={todayLocal()}
                                onChange={(e) => onPauseChange(e.target.value)}
                                onBlur={() => setPauseDraft(null)}
                                className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-indigo-500/50 outline-none"
                            />
                            {saved.pausedUntil && (
                                <button type="button" onClick={() => { setPauseDraft(null); update({ pausedUntil: null }); }} className="text-sm text-zinc-400 hover:text-white">
                                    Clear
                                </button>
                            )}
                        </div>
                        {pauseActive && (
                            <p className="text-xs text-amber-400/90 mt-2">Paused through {saved.pausedUntil}.</p>
                        )}
                    </div>
                </>
            )}

            {/* The jobs */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <h3 className="text-white font-medium mb-3">Schedule</h3>
                <div className="space-y-3">
                    {JOBS.map((def) => {
                        const job = jobs.find((j) => j.name === def.name);
                        return (
                            <div key={def.name} className="flex items-center justify-between">
                                <div>
                                    <div className="text-sm text-white">{def.label}</div>
                                    <div className="text-xs text-zinc-500">
                                        {def.when}
                                        {job?.enabled && job?.nextInvocation ? ` · next ${new Date(job.nextInvocation).toLocaleString()}` : ''}
                                        {!job ? ' · job not found; restart the agent' : ''}
                                    </div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={!!job?.enabled}
                                        disabled={!job}
                                        onChange={() => job && flipJob(job)}
                                        className="sr-only peer"
                                        aria-label={`${def.label} greeting`}
                                    />
                                    <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                </label>
                            </div>
                        );
                    })}
                </div>
                <p className="text-xs text-zinc-500 mt-3">
                    The same switches live in <Link href="/tasks" className="text-indigo-400 hover:underline">Tasks</Link>.
                </p>
            </div>
        </div>
    );
}
