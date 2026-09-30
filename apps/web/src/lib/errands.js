// Pure helpers for Autopilot → Errands (specs/050-errands.md). No React and
// no server calls, so tests can reach them. The shapes come from the agent:
// the errand view in apps/agent/src/routes/autopilot.js, and its steps as
// { id, errand_id, at, kind, detail }.

const STATES = {
    waiting_contact: { label: 'Waiting for them', tone: 'bg-sky-500/10 text-sky-300 border-sky-500/20', open: true },
    waiting_owner: { label: 'Waiting for you', tone: 'bg-amber-500/10 text-amber-300 border-amber-500/20', open: true },
    paused: { label: 'Paused', tone: 'bg-violet-500/10 text-violet-300 border-violet-500/20', open: true },
    done: { label: 'Done', tone: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', open: false },
    cancelled: { label: 'Cancelled', tone: 'bg-zinc-800 text-zinc-400 border-zinc-700', open: false },
    expired: { label: 'Expired', tone: 'bg-zinc-800 text-zinc-500 border-zinc-700', open: false },
    failed: { label: 'Failed', tone: 'bg-red-500/10 text-red-400 border-red-500/20', open: false },
};
const OTHER_TONE = 'bg-zinc-800 text-zinc-400 border-zinc-700';

const GOALS = { book: 'Book a slot', ask: 'Ask', tell: 'Pass on a message' };

const own = (map, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);

/** Squash white space and cut to `max` characters. */
export function clip(text, max = 120) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function stateLabel(state) {
    return own(STATES, state)?.label || (state ? String(state) : 'Unknown');
}

/** Tailwind classes for the state badge: background, text and border. */
export function stateTone(state) {
    return own(STATES, state)?.tone || OTHER_TONE;
}

export function goalLabel(goal) {
    return own(GOALS, goal) || (goal ? String(goal) : 'Errand');
}

/**
 * An errand is open until the agent closes it (closedAt). A row in a closed
 * state counts as closed too, even if closedAt is missing.
 */
export function isOpen(errand) {
    if (!errand || errand.closedAt) return false;
    return own(STATES, errand.state)?.open !== false;
}

/** "2026-10-08" -> "Thu 08/10". The weekday comes from the date alone, whatever the browser's time zone. */
function dayText(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = new Date(Date.UTC(y, mo - 1, d));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
    return `${at.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${m[3]}/${m[2]}`;
}

/** "9:05" -> "09:05"; anything else -> null. */
function timeText(time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

const isSlot = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && ('date' in v || 'time' in v);

/** { date: '2026-10-08', time: '10:00' } -> "Thu 08/10 10:00". A slot with no time gives the day only. */
export function slotText(slot) {
    if (!isSlot(slot)) return '';
    const day = slot.date ? (dayText(slot.date) || clip(slot.date, 20)) : '';
    const time = slot.time ? (timeText(slot.time) || clip(slot.time, 10)) : '';
    return [day, time].filter(Boolean).join(' ');
}

/** A window, "2026-10-08T09:00" to "2026-10-08T12:00" -> "Thu 08/10 09:00-12:00". */
export function windowText(start, end) {
    const split = (v) => {
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})/.exec(String(v ?? ''));
        return m ? { date: m[1], time: m[2] } : null;
    };
    const a = split(start);
    const b = split(end);
    if (!a || !b) return clip([start, end].filter(Boolean).join(' to '), 60);
    if (a.date === b.date) return `${slotText(a)}-${timeText(b.time) || b.time}`;
    return `${slotText(a)} to ${slotText(b)}`;
}

/**
 * The slots worth showing on a card, as { label, text }: what he asked for
 * (or his window), what the contact offered, what was agreed.
 */
export function slotRows(errand) {
    if (!errand) return [];
    const rows = [];
    if (errand.windowStart && errand.windowEnd) rows.push({ label: 'Window', text: windowText(errand.windowStart, errand.windowEnd) });
    else if (isSlot(errand.slot) && slotText(errand.slot)) rows.push({ label: 'Asked for', text: slotText(errand.slot) });
    if (isSlot(errand.offer) && slotText(errand.offer)) rows.push({ label: 'Their offer', text: slotText(errand.offer) });
    if (isSlot(errand.agreed) && slotText(errand.agreed)) rows.push({ label: errand.eventId ? 'Booked' : 'Agreed', text: slotText(errand.agreed) });
    return rows;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 messages sent, 1 on its own". */
export function countsText(errand) {
    const sent = Number(errand?.sentCount) || 0;
    const auto = Number(errand?.autoCount) || 0;
    if (sent === 0) return 'No messages sent';
    return `${plural(sent, 'message', 'messages')} sent, ${auto} on its own`;
}

/**
 * Open errands first, then closed ones. Among open ones, those waiting for
 * him come first. Newest first otherwise.
 */
export function splitErrands(errands) {
    const list = (Array.isArray(errands) ? errands : []).filter((e) => e && e.id !== undefined && e.id !== null);
    const newest = (a, b) => (Number(b.id) || 0) - (Number(a.id) || 0);
    const open = list.filter(isOpen).sort((a, b) => (
        (a.state === 'waiting_owner' ? 0 : 1) - (b.state === 'waiting_owner' ? 0 : 1) || newest(a, b)
    ));
    const closed = list.filter((e) => !isOpen(e)).sort(newest);
    return { open, closed };
}

function shortValue(v) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'string') return clip(v, 60);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
        if (v.length === 0) return 'none';
        if (v.every(isSlot)) return clip(v.map(slotText).join(', '), 60);
        if (v.every((x) => x === null || typeof x !== 'object')) return clip(v.join(', '), 60);
        return plural(v.length, 'item', 'items');
    }
    if (isSlot(v)) return slotText(v) || '-';
    return '…';
}

/** Any detail as one short "key: value, key: value" line. Never the raw JSON. */
export function compactDetail(detail, max = 160) {
    if (detail === null || detail === undefined) return '';
    if (Array.isArray(detail)) return shortValue(detail);
    if (typeof detail !== 'object') return clip(detail, max);
    const keys = Object.keys(detail);
    const shown = keys.slice(0, 6).map((k) => `${k}: ${shortValue(detail[k])}`);
    if (keys.length > 6) shown.push(`${keys.length - 6} more`);
    return clip(shown.join(', '), max);
}

const quote = (text, max = 200) => `"${clip(text, max)}"`;

const localTime = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? String(iso) : t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

const CLOSED_WHY = { owner: 'by you', 'owner wrote': 'you wrote to them yourself' };

const CARD_STATUS = {
    denied: 'You said no on the card',
    expired: 'The card expired with no answer',
    missing: 'The card is gone',
};

/**
 * One short line for a step. `opts.time` formats a timestamp (tests pass a
 * fixed one; the tab uses the browser's local time).
 */
export function eventLine(event, opts = {}) {
    const fmt = typeof opts.time === 'function' ? opts.time : localTime;
    const kind = String(event?.kind || 'note');
    const raw = event?.detail;
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const other = () => {
        const rest = compactDetail(raw);
        return rest ? `${kind}: ${rest}` : kind;
    };
    const slots = (list) => (Array.isArray(list) ? list.map(slotText).filter(Boolean).join(', ') : '');

    switch (kind) {
    case 'started': {
        const what = d.goal ? goalLabel(d.goal) : '';
        const when = Array.isArray(d.window) && d.window.length === 2
            ? `any time ${windowText(d.window[0], d.window[1])}`
            : slotText(d.slot);
        return ['Started', [what, when].filter(Boolean).join(', ')].filter(Boolean).join(': ');
    }
    case 'sent': {
        const parts = Array.isArray(d.parts) ? d.parts.map((p) => (typeof p === 'string' ? p : p?.text)).filter(Boolean) : [];
        if (parts.length === 0) return other();
        return `Sent: ${quote(parts.join(' / '), 240)}${d.auto ? ' (on its own)' : ''}`;
    }
    case 'received': {
        const text = d.excerpt || d.text || '';
        if (!text) return d.unreadable ? 'They sent a voice note Deedee could not read' : 'They wrote';
        return `They wrote: ${quote(text, 300)}${d.unreadable ? ', and a voice note Deedee could not read' : ''}`;
    }
    case 'read': {
        if (d.failed) return 'Could not read their reply';
        if (!d.kind) return other();
        return `Read as: ${[clip(d.kind, 20), slots(d.slots)].filter(Boolean).join(', ')}`;
    }
    case 'decided': {
        if (!d.action) return other();
        const line = [`Decided: ${clip(d.action, 20)}`, slotText(d.slot)].filter(Boolean).join(' ');
        const waits = d.waitsUntil ? `, sends after ${fmt(d.waitsUntil)}` : '';
        return `${line}${waits}${d.auto ? ' (on its own)' : ''}`;
    }
    case 'asked': {
        if (d.offer) {
            const all = slots(d.slots);
            const best = slotText(d.offer);
            return `Asked you about ${best}${all && all !== best ? ` (they offered ${all})` : ''}`;
        }
        if (d.note) return 'Asked you in your chat';
        if (d.why) return `Asked you with a card: ${clip(d.why, 120)}`;
        return 'Asked you';
    }
    case 'booked': {
        const when = slotText(d.slot);
        return `${d.existing ? 'Already on the calendar' : 'Added to the calendar'}${when ? `: ${when}` : ''}`;
    }
    case 'closed': {
        const why = d.why ? ` (${own(CLOSED_WHY, d.why) || clip(d.why, 80)})` : '';
        return `Closed: ${clip(d.state || 'closed', 20)}${why}`;
    }
    case 'paused':
        return d.why ? `Paused: ${clip(d.why, 160)}` : 'Paused';
    case 'refused': {
        if (d.dryRun) return d.text ? `Dry run, not sent: ${quote(d.text, 200)}` : 'Dry run, not sent';
        const problems = Array.isArray(d.problems) ? d.problems.filter((p) => typeof p === 'string') : [];
        return problems.length ? `Held back a message: ${clip(problems.join('; '), 160)}` : 'Held back a message';
    }
    case 'error': {
        const where = d.step ? ` (${clip(d.step, 20)})` : '';
        if (d.error) return `Error${where}: ${clip(d.error, 160)}`;
        if (Number.isFinite(d.sent) && Number.isFinite(d.of)) return `Error${where}: WhatsApp took ${d.sent} of ${d.of} parts`;
        return `Error${where}`;
    }
    case 'note':
        return d.noReply ? 'Told you they have not answered yet' : other();
    case 'owner':
        return own(CARD_STATUS, d.status) || (d.status ? `Card: ${clip(d.status, 20)}` : other());
    default:
        return other();
    }
}
