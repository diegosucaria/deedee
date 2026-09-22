'use client';

import { useState, useEffect } from 'react';
import { Search, Loader2, UserPlus, Globe } from 'lucide-react';
import { getWhatsAppContacts, createPersonFromContact } from '../app/actions';

const MIN_QUERY = 2;

const digitsOf = (value = '') => String(value).replace(/@.*$/, '').replace(/\D/g, '');

const rank = (a, b) =>
    (Number(!!b.is_pinned) - Number(!!a.is_pinned))
    || (Number(!!b.has_style) - Number(!!a.has_style))
    || (a.name || '').localeCompare(b.name || '');

// Picks whose writing style to edit: the global baseline, a person, or a
// WhatsApp contact that isn't in People yet. A contact's style lives on its
// person record, so picking such a contact adds it to People first.
export default function ContactStylePicker({ people = [], selectedId, onSelect, onPeopleChanged }) {
    const [query, setQuery] = useState('');
    const [contacts, setContacts] = useState([]);
    const [searching, setSearching] = useState(false);
    const [adding, setAdding] = useState(null);
    const [error, setError] = useState(null);

    const trimmed = query.trim().toLowerCase();
    const digits = trimmed.replace(/\D/g, '');
    const selected = people.find((p) => p.id === selectedId);

    // Debounced contact search; state only changes in the async callback.
    useEffect(() => {
        if (trimmed.length < MIN_QUERY) return;
        let active = true;
        const timer = setTimeout(async () => {
            const data = await getWhatsAppContacts('user', trimmed);
            if (!active) return;
            setContacts(Array.isArray(data) ? data : []);
            setSearching(false);
        }, 400);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [trimmed]);

    const matchedPeople = (trimmed
        ? people.filter((p) => (p.name || '').toLowerCase().includes(trimmed) || (digits.length >= 3 && digitsOf(p.phone).includes(digits)))
        : people
    ).slice().sort(rank).slice(0, trimmed ? 8 : 6);

    // WhatsApp contacts no person covers; a phone contact and its WhatsApp
    // ID collapse into one entry.
    const covered = new Set(people.map((p) => digitsOf(p.phone)).filter(Boolean));
    const linkedLids = new Set(contacts.map((c) => c?.lid).filter(Boolean));
    const newContacts = trimmed.length >= MIN_QUERY
        ? contacts
            .filter((c) => c?.id && !covered.has(digitsOf(c.id)) && !(c.lid && covered.has(digitsOf(c.lid))))
            .filter((c) => !(String(c.id).endsWith('@lid') && linkedLids.has(c.id)))
            .slice(0, 6)
        : [];

    const onQueryChange = (e) => {
        setQuery(e.target.value);
        setSearching(e.target.value.trim().length >= MIN_QUERY);
    };

    const choose = (id) => {
        setQuery('');
        setContacts([]);
        setSearching(false);
        onSelect(id);
    };

    const addAndChoose = async (c) => {
        setAdding(c.id);
        setError(null);
        const isLid = String(c.id).endsWith('@lid');
        const res = await createPersonFromContact({
            name: c.name || c.notify || c.phone,
            phone: isLid ? '' : c.phone,
            lid: isLid ? c.id : c.lid,
        });
        setAdding(null);
        if (!res?.success || !res.id) {
            setError(res?.error || 'Could not add this contact to People.');
            return;
        }
        if (onPeopleChanged) await onPeopleChanged();
        choose(res.id);
    };

    return (
        <div className="w-full sm:w-80">
            <div className="text-xs text-zinc-500 mb-1">
                Editing: <span className="text-zinc-300">{selectedId === 'global' ? 'Global (baseline)' : selected?.name || 'Contact'}</span>
            </div>
            <div className="relative">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                    type="text"
                    value={query}
                    onChange={onQueryChange}
                    placeholder="Search people or WhatsApp contacts"
                    className="w-full bg-zinc-950 border border-zinc-700 text-zinc-300 text-sm rounded-lg pl-9 pr-9 py-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                />
                {searching && <Loader2 className="w-4 h-4 text-zinc-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
            </div>
            <ul className="mt-2 border border-zinc-800 rounded-lg divide-y divide-zinc-800 overflow-hidden max-h-80 overflow-y-auto">
                {!trimmed && (
                    <li>
                        <button type="button" onClick={() => choose('global')} className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60">
                            <Globe className="w-4 h-4 text-zinc-500" /> Global (baseline)
                        </button>
                    </li>
                )}
                {matchedPeople.map((p) => (
                    <li key={p.id}>
                        <button type="button" onClick={() => choose(p.id)} className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60">
                            {p.is_pinned ? '📌 ' : ''}{p.has_style ? '★ ' : ''}{p.name}
                        </button>
                    </li>
                ))}
                {newContacts.length > 0 && (
                    <li className="px-3 py-1 text-[11px] uppercase tracking-wide text-zinc-500 bg-zinc-900/60">Not in People yet</li>
                )}
                {newContacts.map((c) => (
                    <li key={c.id}>
                        <button
                            type="button"
                            disabled={adding === c.id}
                            onClick={() => addAndChoose(c)}
                            className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-50"
                        >
                            {adding === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4 text-zinc-500" />}
                            <span>{c.name || c.notify || c.phone}</span>
                            <span className="ml-auto text-[11px] text-zinc-500">add to People</span>
                        </button>
                    </li>
                ))}
                {trimmed && !searching && matchedPeople.length === 0 && newContacts.length === 0 && (
                    <li className="px-3 py-2 text-xs text-zinc-500">No people or contacts match.</li>
                )}
            </ul>
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
    );
}
