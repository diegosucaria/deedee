'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Heart, Search, Loader2, AlertTriangle } from 'lucide-react';
import { getPeople, getWhatsAppContacts } from '../app/actions';

const MIN_QUERY = 2;

const digitsOf = (value = '') => String(value).replace(/@.*$/, '').replace(/\D/g, '');

const describe = (id = '') => (id.endsWith('@lid') ? 'WhatsApp ID (no phone number shared)' : id.split('@')[0]);

// The address to greet a person on: their WhatsApp ID when linked (the chat
// history is filed under it), otherwise their phone number.
const personAddress = (p) => (p.identifiers?.whatsapp_lid ? `${p.identifiers.whatsapp_lid}@lid` : digitsOf(p.phone));

// People first (one entry per person, both addresses linked), then WhatsApp
// contacts that no person in People already covers.
async function searchTargets(query) {
    const [peopleRes, contacts] = await Promise.all([
        getPeople({ search: query, limit: 8 }),
        getWhatsAppContacts('user', query),
    ]);
    const people = (Array.isArray(peopleRes) ? peopleRes : peopleRes?.people || []).filter((p) => personAddress(p));
    const covered = new Set();
    for (const p of people) {
        [p.phone, p.identifiers?.whatsapp, p.identifiers?.whatsapp_lid].forEach((v) => v && covered.add(digitsOf(v)));
    }
    const fromPeople = people.map((p) => ({
        key: `person:${p.id}`,
        contact: personAddress(p),
        label: p.name,
        detail: [p.phone ? digitsOf(p.phone) : null, p.identifiers?.whatsapp_lid ? 'WhatsApp ID linked' : null].filter(Boolean).join(' · '),
    }));
    const fromContacts = (Array.isArray(contacts) ? contacts : [])
        .filter((c) => c?.id && !covered.has(digitsOf(c.id)))
        .map((c) => ({
            key: `contact:${c.id}`,
            contact: c.id,
            label: c.name || c.notify || c.phone || c.id,
            detail: `${describe(c.id)} · not in People`,
        }));
    return [...fromPeople, ...fromContacts].slice(0, 8);
}

// Who the partner_good_morning / partner_good_night jobs write to, as the owner.
// Saved as the partner_greeting agent setting: { contact, name, dryRun }.
export default function PartnerGreetingSettings({ value, onSave }) {
    const saved = value && typeof value === 'object' && value.contact ? value : null;
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);

    const trimmed = query.trim();
    const showResults = trimmed.length >= MIN_QUERY;

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

    const onQueryChange = (e) => {
        setQuery(e.target.value);
        setSearching(e.target.value.trim().length >= MIN_QUERY);
    };

    const pick = (target) => {
        // A new target starts in dry run, so the first drafts only reach the owner.
        onSave({ contact: target.contact, name: target.label, dryRun: saved ? saved.dryRun === true : true });
        setQuery('');
        setResults([]);
        setSearching(false);
    };

    const saveName = (next) => {
        const clean = next.trim();
        if (!saved || clean === (saved.name || '')) return;
        onSave({ ...saved, name: clean });
    };

    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
                <Heart className="w-5 h-5 text-pink-400" />
                Partner Greetings
            </h2>
            <p className="text-sm text-zinc-400 mb-6">
                Good-morning and good-night messages sent from your own WhatsApp, in your style.
                The jobs start turned off; switch them on in <Link href="/tasks" className="text-indigo-400 hover:underline">Tasks</Link>
                {' '}(<code className="text-zinc-300">partner_good_morning</code>, <code className="text-zinc-300">partner_good_night</code>).
            </p>

            <div className="space-y-6">
                {/* Current target */}
                <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-1">Send to</label>
                    {saved ? (
                        <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-2">
                            <div className="text-white">{saved.name || 'Unnamed contact'}</div>
                            <div className="text-xs text-zinc-500">{describe(saved.contact)}</div>
                        </div>
                    ) : (
                        <p className="text-sm text-zinc-500">Nobody yet. Search your people and contacts below.</p>
                    )}
                </div>

                {/* People / contact search */}
                <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-1">
                        {saved ? 'Change contact' : 'Find contact'}
                    </label>
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
                                    <button
                                        type="button"
                                        onClick={() => pick(t)}
                                        className="w-full text-left px-4 py-2 hover:bg-zinc-800/60 transition-colors"
                                    >
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
                    <>
                        {/* Name used in the notes sent to the owner */}
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
                                Only used in the message Deedee sends you (&ldquo;Sent good morning to &hellip;&rdquo;). Never sent to them.
                            </p>
                        </div>

                        {/* Greeting-only dry run */}
                        <div className="border-t border-zinc-800/50 pt-6 flex items-center justify-between">
                            <div>
                                <h3 className="text-white font-medium">Dry Run (greetings only)</h3>
                                <p className="text-sm text-zinc-400 mt-1 max-w-md">
                                    Draft each greeting and send it to you instead. Nothing reaches your partner.
                                    Other messages are not affected.
                                </p>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={saved.dryRun === true}
                                    onChange={(e) => onSave({ ...saved, dryRun: e.target.checked })}
                                    className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-500/50 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                            </label>
                        </div>

                        {saved.dryRun === true && (
                            <div className="flex items-center gap-2 text-yellow-500/90 text-sm bg-yellow-500/10 p-3 rounded-lg border border-yellow-500/20">
                                <AlertTriangle className="w-4 h-4" />
                                <span>Greetings are in dry run. You get the drafts; your partner gets nothing.</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
