// Pure helpers for the Guardian page (history, stats, policy, dry run).
//
// The routes live in apps/agent/src/routes/guardian.js and reach the web app
// through the API gateway at /v1/guardian. Nothing here touches the network,
// so the logic can be tested without a browser.

/** Every outcome a guardian_decisions row can hold, with a label and a style. */
export const OUTCOMES = [
    { id: 'auto_allowed', label: 'Auto-allowed', tone: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20' },
    { id: 'auto_denied', label: 'Auto-denied', tone: 'text-red-300 bg-red-400/10 border-red-400/20' },
    { id: 'escalated', label: 'Waiting for you', tone: 'text-amber-300 bg-amber-400/10 border-amber-400/20' },
    { id: 'escalated_approved', label: 'Asked you: approved', tone: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20' },
    { id: 'escalated_denied', label: 'Asked you: denied', tone: 'text-red-300 bg-red-400/10 border-red-400/20' },
    { id: 'escalated_expired', label: 'Asked you: expired', tone: 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40' },
    { id: 'escalated_failed', label: 'Could not ask you', tone: 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40' },
    { id: 'deny_list', label: 'Blocked by deny-list', tone: 'text-red-300 bg-red-400/10 border-red-400/20' },
    { id: 'breaker_stop', label: 'Breaker stop', tone: 'text-orange-300 bg-orange-400/10 border-orange-400/20' },
    { id: 'ran_unasked', label: 'Ran unasked (mode off)', tone: 'text-sky-300 bg-sky-400/10 border-sky-400/20' },
    { id: 'owner_instructed', label: 'You asked for it', tone: 'text-teal-300 bg-teal-400/10 border-teal-400/20' },
    { id: 'escalated_duplicate', label: 'Already waiting', tone: 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40' },
    { id: 'escalated_superseded', label: 'Already done', tone: 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40' },
    { id: 'shell_refused', label: 'Refused: the shell blocks it', tone: 'text-red-300 bg-red-400/10 border-red-400/20' },
];
const OUTCOME_IDS = OUTCOMES.map(o => o.id);

export const RISKS = ['low', 'medium', 'high'];
export const SOURCE_KINDS = [
    { id: 'chat', label: 'Chat' },
    { id: 'job', label: 'Job' },
    { id: 'watcher', label: 'Watcher' },
    { id: 'subagent', label: 'Sub-agent' },
    { id: 'system', label: 'System' },
];
const SOURCE_KIND_IDS = SOURCE_KINDS.map(s => s.id);
export const MODES = [
    { id: 'manual', label: 'Manual', hint: 'You decide every paused call you did not ask for yourself.' },
    { id: 'smart', label: 'Smart', hint: 'The guardian allows, denies or asks you.' },
    { id: 'off', label: 'Off', hint: 'Nobody asks. Only the floor and your own list still ask.' },
];
export const MAX_POLICY_CHARS = 4000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function outcomeLabel(outcome) {
    return OUTCOMES.find(o => o.id === outcome)?.label || String(outcome || 'unknown');
}

export function outcomeTone(outcome) {
    return OUTCOMES.find(o => o.id === outcome)?.tone || 'text-zinc-400 bg-zinc-700/40 border-zinc-600/40';
}

/**
 * The stacked chart folds thirteen outcomes into eight series. Colors are a
 * categorical set checked for color-blind separation on the dark surface,
 * in a fixed order: a series keeps its color whatever the range shows.
 */
export const OUTCOME_GROUPS = [
    { key: 'Auto-allowed', color: '#3987e5', outcomes: ['auto_allowed'] },
    { key: 'Auto-denied', color: '#d95926', outcomes: ['auto_denied'] },
    { key: 'You approved', color: '#199e70', outcomes: ['escalated_approved'] },
    { key: 'You denied', color: '#c98500', outcomes: ['escalated_denied'] },
    { key: 'Waiting, expired or unasked', color: '#d55181', outcomes: ['escalated', 'escalated_expired', 'escalated_failed', 'escalated_duplicate', 'escalated_superseded'] },
    { key: 'Ran with mode off', color: '#008300', outcomes: ['ran_unasked'] },
    { key: 'Blocked outright', color: '#9085e9', outcomes: ['deny_list', 'breaker_stop', 'shell_refused'] },
    { key: 'You asked for it', color: '#a3a3a3', outcomes: ['owner_instructed'] },
];

function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * Stats perDay rows ({ day, <outcome>: n }) -> one chart row per day in the
 * range, gaps filled with zeros, outcomes folded into OUTCOME_GROUPS.
 * The range is capped at 400 days so a bad date cannot build a huge array.
 */
export function outcomesPerDay(perDay, { from, to } = {}) {
    const rows = Array.isArray(perDay) ? perDay.filter(r => r && DAY_RE.test(String(r.day))) : [];
    const byDay = new Map(rows.map(r => [r.day, r]));
    const days = [...byDay.keys()].sort();
    const start = DAY_RE.test(String(from || '')) ? from : days[0];
    const end = DAY_RE.test(String(to || '')) ? to : days[days.length - 1];
    if (!start || !end || start > end) return [];
    const out = [];
    for (let day = start, i = 0; day <= end && i < 400; day = addDays(day, 1), i++) {
        const src = byDay.get(day) || {};
        const row = { date: day };
        for (const g of OUTCOME_GROUPS) row[g.key] = g.outcomes.reduce((s, o) => s + (Number(src[o]) || 0), 0);
        out.push(row);
    }
    return out;
}

/** Totals per chart group, for the table beside the chart. */
export function outcomeGroupTotals(outcomes) {
    const src = outcomes && typeof outcomes === 'object' ? outcomes : {};
    return OUTCOME_GROUPS.map(g => ({ key: g.key, color: g.color, count: g.outcomes.reduce((s, o) => s + (Number(src[o]) || 0), 0) }));
}

export const RANGE_PRESETS = [
    { id: '7d', label: '7d', days: 7 },
    { id: '30d', label: '30d', days: 30 },
    { id: '90d', label: '90d', days: 90 },
    { id: '180d', label: '180d', days: 180 },
];

/** A preset id -> { from, to } as UTC days, counting today. */
export function rangeFor(presetId, now = new Date()) {
    const preset = RANGE_PRESETS.find(p => p.id === presetId) || RANGE_PRESETS[1];
    const to = new Date(now).toISOString().slice(0, 10);
    return { from: addDays(to, -(preset.days - 1)), to };
}

/** Keep only the list items the route accepts. */
function cleanList(value, allowed) {
    const items = (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map(s => String(s).trim()).filter(s => allowed.includes(s));
    return [...new Set(items)].join(',');
}

/**
 * History filters -> a query string the route accepts. Unknown values are
 * dropped rather than sent, so a stale URL cannot earn a 400.
 */
export function historyQuery({ outcome, tool, risk, sourceKind, from, to, limit, offset } = {}) {
    const params = new URLSearchParams();
    const o = cleanList(outcome, OUTCOME_IDS);
    if (o) params.set('outcome', o);
    const r = cleanList(risk, RISKS);
    if (r) params.set('risk', r);
    const k = cleanList(sourceKind, SOURCE_KIND_IDS);
    if (k) params.set('sourceKind', k);
    const t = String(tool ?? '').trim().slice(0, 200);
    if (t) params.set('tool', t);
    if (DAY_RE.test(String(from || ''))) params.set('from', from);
    if (DAY_RE.test(String(to || ''))) params.set('to', to);
    const l = parseInt(limit, 10);
    params.set('limit', String(Number.isFinite(l) ? Math.min(Math.max(l, 1), 200) : 50));
    const off = parseInt(offset, 10);
    if (Number.isFinite(off) && off > 0) params.set('offset', String(off));
    return params.toString();
}

/** Stats range -> query string. */
export function statsQuery({ from, to } = {}) {
    const params = new URLSearchParams();
    if (DAY_RE.test(String(from || ''))) params.set('from', from);
    if (DAY_RE.test(String(to || ''))) params.set('to', to);
    return params.toString();
}

/** Rows the owner may mark "should have been allowed / denied". */
export function canGiveFeedback(row) {
    const o = row?.outcome;
    return o === 'auto_allowed' || o === 'auto_denied' || (typeof o === 'string' && o.startsWith('escalated'));
}

export function normalizeFeedback(value) {
    return value === 'should_allow' || value === 'should_deny' ? value : null;
}

function isSyntheticChatId(chatId) {
    return /^(?:scheduled|system)_/.test(String(chatId || ''));
}

/** Where a row came from, in a few words. */
export function sourceLabel(row) {
    if (!row) return '';
    if (row.job_name) return `Job: ${row.job_name}`;
    const kind = SOURCE_KINDS.find(s => s.id === row.source_kind)?.label || 'Run';
    const channel = String(row.source || '').split(':')[0];
    return channel && kind === 'Chat' ? `Chat (${channel})` : kind;
}

/**
 * The page to open for a row: the job's run history for a job, the chat for
 * a chat run. Null when there is nothing to open.
 */
export function rowLink(row) {
    if (!row) return null;
    if (row.job_name) {
        return { href: `/tasks?tab=manage&job=${encodeURIComponent(row.job_name)}`, label: 'Job runs' };
    }
    if (row.chat_id && !isSyntheticChatId(row.chat_id) && (row.source_kind === 'chat' || !row.source_kind)) {
        return { href: `/chat/${encodeURIComponent(row.chat_id)}`, label: 'Open chat' };
    }
    return null;
}

/**
 * The owner's always-ask list split for the editor: category ids (ticked
 * boxes) and tool globs (one per line).
 */
export function splitAlwaysAsk(list, categories = []) {
    const known = new Set((categories || []).map(c => c.id));
    const cats = [];
    const globs = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const entry = String(raw || '').trim();
        if (!entry) continue;
        const m = /^category:(.+)$/i.exec(entry);
        if (m && known.has(m[1])) cats.push(m[1]);
        else if (!m) globs.push(entry);
    }
    return { categories: [...new Set(cats)], globs };
}

/** The editor state back to the stored list. Floor ids are left out: the floor is fixed. */
export function joinAlwaysAsk(categoryIds, globsText, floor = []) {
    const floorIds = new Set((floor || []).map(f => (typeof f === 'string' ? f : f.id)));
    const out = [];
    for (const id of categoryIds || []) {
        if (!floorIds.has(id) && !out.includes(`category:${id}`)) out.push(`category:${id}`);
    }
    for (const line of String(globsText ?? '').split(/\r?\n/)) {
        const g = line.trim();
        if (g && !g.startsWith('#') && !/^category:/i.test(g) && !out.includes(g)) out.push(g);
    }
    return out;
}

/**
 * The dry-run form -> the route body. Returns { ok: true, payload } or
 * { ok: false, error } with a plain message.
 */
export function dryRunPayload(form = {}) {
    const toolName = String(form.toolName ?? '').trim();
    if (!toolName) return { ok: false, error: 'Name the tool to try.' };
    let args = {};
    const argsText = String(form.args ?? '').trim();
    if (argsText) {
        try { args = JSON.parse(argsText); } catch { return { ok: false, error: 'Arguments must be valid JSON.' }; }
        if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Arguments must be a JSON object.' };
    }
    const text = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : undefined; };
    const payload = { toolName: toolName.slice(0, 200), args };
    const ownerMessage = text(form.ownerMessage, 2000);
    if (ownerMessage) payload.ownerMessage = ownerMessage;
    const jobName = text(form.jobName, 200);
    if (jobName) payload.jobName = jobName;
    if (SOURCE_KIND_IDS.includes(form.sourceKind)) payload.sourceKind = form.sourceKind;
    const taint = String(form.taintSources ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 10);
    if (taint.length) payload.taintSources = taint.map(s => s.slice(0, 200));
    const excerpt = text(form.excerpt, 2000);
    if (excerpt) payload.excerpt = excerpt;
    return { ok: true, payload };
}

/** fetchAPI throws "API Error 400: {json}". Pull out the route's own message. */
export function apiErrorMessage(error) {
    const msg = String(error?.message || error || 'Request failed');
    const m = /^API Error (\d+): ([\s\S]*)$/.exec(msg);
    if (!m) return msg;
    try {
        const body = JSON.parse(m[2]);
        if (body && typeof body.error === 'string') return body.error;
    } catch { /* not JSON */ }
    return `Request failed (${m[1]})`;
}

export function formatPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-';
}

export function formatMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function formatCost(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toFixed(4)}` : '-';
}
