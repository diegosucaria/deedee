// Pure helpers for Autopilot → Greetings and the Style picker. No React and
// no server calls, so tests can reach them.

export const digitsOf = (value = '') => String(value ?? '').replace(/@.*$/, '').replace(/\D/g, '');

export const modeOf = (value) => (value?.mode ? value.mode : (value?.dryRun ? 'dry_run' : 'send'));

// How a saved address reads in the tab. A WhatsApp ID hides the phone number.
export const describeContact = (id = '') => (String(id).endsWith('@lid') ? 'WhatsApp ID' : String(id).split('@')[0]);

// The address to greet a person on: their WhatsApp ID when linked (the chat
// history is filed under it), otherwise their phone number.
export const personAddress = (p) => (p?.identifiers?.whatsapp_lid ? `${p.identifiers.whatsapp_lid}@lid` : digitsOf(p?.phone));

// WhatsApp contacts that no person covers. A person covers a contact by phone
// number or by WhatsApp ID. A phone contact and its WhatsApp ID row are one
// contact: the WhatsApp ID row drops out when its phone row is in the list.
function uncovered(contacts, covered) {
    const list = Array.isArray(contacts) ? contacts.filter((c) => c?.id) : [];
    const linkedLids = new Set(list.map((c) => c.lid).filter(Boolean));
    return list
        .filter((c) => !covered.has(digitsOf(c.id)) && !(c.lid && covered.has(digitsOf(c.lid))))
        .filter((c) => !(String(c.id).endsWith('@lid') && linkedLids.has(c.id)));
}

// Greetings picker: people first (one entry per person), then contacts not in
// People. `people` come from getPeople (with identifiers).
export function greetingTargets(people, contacts, limit = 8) {
    const found = (Array.isArray(people) ? people : []).filter((p) => personAddress(p));
    const covered = new Set();
    for (const p of found) {
        [p.phone, p.identifiers?.whatsapp, p.identifiers?.whatsapp_lid].forEach((v) => v && covered.add(digitsOf(v)));
    }
    const fromPeople = found.map((p) => ({
        key: `person:${p.id}`,
        contact: personAddress(p),
        label: p.name,
        detail: [p.phone ? digitsOf(p.phone) : null, p.identifiers?.whatsapp_lid ? 'WhatsApp ID linked' : null].filter(Boolean).join(' · '),
    }));
    const fromContacts = uncovered(contacts, covered).map((c) => ({
        key: `contact:${c.id}`,
        contact: c.lid || c.id,
        label: c.name || c.notify || c.phone || c.id,
        detail: `${c.lid ? `${digitsOf(c.id)} · WhatsApp ID linked` : describeContact(c.id)} · not in People`,
    }));
    return [...fromPeople, ...fromContacts].slice(0, limit);
}

// Style picker: contacts to offer under "Not in People yet". `people` are the
// Autopilot settings rows, which carry `phone` and `whatsapp_lid`.
export function newContactsFor(people, contacts, limit = 6) {
    const covered = new Set();
    for (const p of Array.isArray(people) ? people : []) {
        [p.phone, p.whatsapp_lid].forEach((v) => v && covered.add(digitsOf(v)));
    }
    covered.delete('');
    return uncovered(contacts, covered).slice(0, limit);
}

// People that a contact search found under another name (a push name, a
// number): the person each matching contact belongs to.
export function peopleBehindContacts(people, contacts) {
    const byDigits = new Map();
    for (const p of Array.isArray(people) ? people : []) {
        [p.phone, p.whatsapp_lid].forEach((v) => digitsOf(v) && byDigits.set(digitsOf(v), p));
    }
    const found = new Map();
    for (const c of Array.isArray(contacts) ? contacts : []) {
        for (const v of [c?.id, c?.lid]) {
            const p = v ? byDigits.get(digitsOf(v)) : null;
            if (p) found.set(p.id, p);
        }
    }
    return [...found.values()];
}

// The setting after picking someone. A different person starts in dry run, so
// a wrong click can't send as the owner; picking the same person again keeps
// the mode. The older dryRun flag gives way to mode.
export function pickTarget(saved, target) {
    const same = !!saved?.contact && saved.contact === target.contact;
    const next = { ...(saved || {}), contact: target.contact, name: target.label, mode: same ? modeOf(saved) : 'dry_run' };
    delete next.dryRun;
    return next;
}

// The "Together until" value to save: null clears it, undefined means "not
// yet". Typing a year sends 0002-…, 0020-… first, and a past day pauses nothing.
export function pauseValue(input, today) {
    if (!input) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || input < today) return undefined;
    return input;
}
