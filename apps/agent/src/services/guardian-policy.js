/**
 * Guardian policy: the settings and the always-ask list.
 *
 * `approvals.mode` picks who decides the calls the safety rules pause:
 * - `manual`: the owner, every time (the behaviour before the guardian);
 * - `smart` (default): the guardian (services/guardian-service.js) allows,
 *   denies or sends the call to the owner;
 * - `off`: nobody asks. Not recommended.
 *
 * The always-ask list holds categories and tool globs. The FLOOR is fixed in
 * code: money, deleting user data, cancelling a booking, committing or
 * publishing, and reading the browser's saved sessions or credentials. The
 * owner cannot remove it, in any mode. A paused call in a
 * floor category goes to the owner; the guardian may deny it, never allow it.
 * The owner's own additions (`approvals.always_ask`) work the same way, and
 * also make a matching call ask when no other rule would pause it.
 */
const { globToRegExp, stableJson } = require('../confirmation-manager');

const MODES = Object.freeze(['manual', 'smart', 'off']);
const DEFAULT_MODE = 'smart';
const MAX_POLICY_CHARS = 4000;
const MAX_ALWAYS_ASK = 100;
const MAX_ENTRY_CHARS = 300;

// Arguments that name what a call acts on (a button label, a service, an
// API method). Message bodies and typed text are left out: "in order to"
// in a message is not a purchase.
const LABEL_KEYS = new Set(['element', 'label', 'button', 'action', 'service', 'method', 'resource', 'selector', 'name', 'toolname', 'tool', 'domain', 'ref', 'key']);

// Whole words, accents included: `\b` does not see "á" as a letter, so
// "pagá" needs the Unicode lookarounds.
// Keep it a superset of the money labels in utils/browser-gate.js CONSEQUENCE_RE.
const MONEY_RE = /(?<![\p{L}\p{N}_])(?:pay|pays|paying|payment|payments|purchase|buy|buying|checkout|check out|place order|order now|orders?|transfer|transfers|wire|withdraw|donate|donation|subscribe|subscription|bid|bids|bidding|upgrade|upgrades|donar|donaci[oó]n|suscripci[oó]n|ofertar|pujar|pagar|pag[aá]|pago|pagos|pague|comprar|compr[aá]|compras|transferir|transferencia|transfer[ií]|suscrib\p{L}*|abon[aá]r?|pedido|pedidos)(?![\p{L}\p{N}_])/iu;
const DELETE_RE = /(?:^|[^a-z])(?:delete|remove|trash|purge|wipe|erase|destroy|drop|batchdelete|emptytrash|eliminar|borrar)/i;
const CANCEL_BOOKING_RE = /cancel\w*[\s_.:-]*(?:\w+[\s_.:-]+)?(?:appointment|turn|turno|booking|reservation|reserva|flight|vuelo|ticket)|(?:appointment|turn|turno|booking|reservation|reserva)\w*[\s_.:-]*cancel/i;
const PUBLISH_RE = /\b(?:publish|publicar|deploy|release)\b|(?:^|_)publish|commitAndPush/i;
// git may carry global options before the verb: "git -C /app push", "git -c k=v commit".
const SHELL_PUBLISH_RE = /\bgit\b(?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+|\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:commit|push)\b|\bnpm\s+publish\b|\bgh\s+(?:pr\s+(?:create|merge)|release\s+create)\b|\bgh\s+api\b.*\/merges?\b/i;
// Any rm (with or without flags), rmdir, unlink, find -delete, truncate, shred, SQL deletes.
const SHELL_DELETE_RE = /(?:^|[\s;&|(`$])(?:sudo\s+)?(?:rm|rmdir|unlink|shred|truncate)(?:\s|$)|\s-delete\b|\bsqlite3?\b.*\b(?:delete|drop)\b/i;

// Browser tools whose arguments are code or a page-defined action: no label
// to read, so the whole argument text is searched.
const BROWSER_CODE_TOOLS = new Set(['browser_evaluate', 'browser_run_code_unsafe', 'browser_webmcp_call']);
const CODE_DELETE_RE = /(?<![\p{L}\p{N}_])(?:delete|remove|eliminar|borrar)(?![\p{L}\p{N}_])/iu;
/** Every string value in the arguments, parsed JSON strings included. */
function allStrings(value, depth = 0) {
    if (depth > 6 || value == null) return '';
    if (typeof value === 'string') {
        const t = value.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
            try { return `${value} ${allStrings(JSON.parse(t), depth + 1)}`; } catch { /* plain text */ }
        }
        return value;
    }
    if (typeof value !== 'object') return String(value);
    return Object.entries(value).map(([k, v]) => `${k} ${allStrings(v, depth + 1)}`).join(' ');
}
/** camelCase and snake_case split into words: "placeOrder" reads "place Order". */
function splitWords(text) {
    return String(text).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
/** The quoted strings in code: labels and names, not the code's own identifiers. */
function codeStrings(text) {
    return (String(text).match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) || []).join(' ');
}

// Rules that guard the browser's saved sessions and credentials.
const SECRET_RULES = new Set(['shell-credentials', 'shell-cdp', 'file-browser-profile']);

// Everyday removals the safety rules also let run (docs/security.md).
const EVERYDAY_REMOVALS = new Set(['ha_remove_todo_item', 'remove_from_wardrobe_trip_capsule', 'dismiss_shopping_item', 'cancelJob', 'playlist_remove_from', 'collection_remove_from']);

function asText(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
}

/** The label-like argument values of a call, flattened (JSON strings included). */
function labelText(args, depth = 0) {
    if (depth > 5 || args == null) return '';
    if (typeof args === 'string') {
        const t = args.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
            try { return labelText(JSON.parse(t), depth + 1); } catch { return ''; }
        }
        return '';
    }
    if (typeof args !== 'object') return '';
    const out = [];
    for (const [k, v] of Object.entries(args)) {
        if (LABEL_KEYS.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) out.push(String(v));
        else if (v && typeof v === 'object') out.push(labelText(v, depth + 1));
        else if (typeof v === 'string' && (k === 'params' || k === 'data')) out.push(labelText(v, depth + 1));
    }
    return out.filter(Boolean).join(' ');
}

/**
 * The gate reason with the generic lists taken out, so "(pay, buy, send,
 * delete or book)" on every browser click does not read as a payment. The
 * phrase "a web form that pays" stays: the gate saw payment fields there.
 */
function reasonText(reason) {
    return String(reason || '')
        .replace(/\(pay, buy, send, delete or book\)/gi, '')
        .replace(/that pays, orders, sends or deletes/gi, 'that pays or deletes');
}

/**
 * Categories. `floor: true` entries are the fixed always-ask floor. The rest
 * are names the owner may add to `approvals.always_ask`.
 * match(toolName, args, { reason, serverName, rule }) -> boolean
 */
const CATEGORIES = Object.freeze({
    money: {
        label: 'Pay, buy, order or transfer money',
        floor: true,
        match: (name, args, ctx) => {
            if (MONEY_RE.test(name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'))) return true;
            if (MONEY_RE.test(labelText(args))) return true;
            if (BROWSER_CODE_TOOLS.has(name) && MONEY_RE.test(splitWords(allStrings(args)))) return true;
            return MONEY_RE.test(reasonText(ctx.reason).replace(/\b(?:send|sends|delete|deletes|book)\b/gi, ''));
        }
    },
    delete_data: {
        label: 'Delete user data',
        floor: true,
        match: (name, args, ctx) => {
            if (EVERYDAY_REMOVALS.has(name)) return false;
            if (ctx.rule === 'delete-or-remove' || ctx.rule === 'shell-system-damage') return true;
            if (/^(?:media|playlist|collection)_delete$/.test(name)) return true;
            if (name === 'runShellCommand') return SHELL_DELETE_RE.test(asText(args?.command));
            if (DELETE_RE.test(name.replace(/([a-z])([A-Z])/g, '$1_$2'))) return true;
            if (String(ctx.serverName || '').startsWith('gws_')) {
                const method = String(args?.method || '').split('.').pop();
                if (/^(?:delete|trash|batchDelete|emptyTrash|clear)$/i.test(method)) return true;
            }
            const label = labelText(args);
            if (String(name).startsWith('browser_') && /\b(?:delete|remove|eliminar|borrar)\b/i.test(label)) return true;
            if (name === 'browser_webmcp_call' && CODE_DELETE_RE.test(splitWords(allStrings(args)))) return true;
            if (BROWSER_CODE_TOOLS.has(name) && CODE_DELETE_RE.test(codeStrings(allStrings(args)))) return true;
            return /"(?:delete|remove|eliminar|borrar)[^"]*"/i.test(String(ctx.reason || ''));
        }
    },
    cancel_booking: {
        label: 'Cancel a booking',
        floor: true,
        match: (name, args, ctx) => {
            if (/(?:^|_)cancel_(?:appointment|turn)$/i.test(name)) return true;
            if ((ctx.serverName === 'pilotfy' || ctx.serverName === 'allende') && /cancel/i.test(name)) return true;
            return CANCEL_BOOKING_RE.test(`${name} ${labelText(args)} ${reasonText(ctx.reason)}`);
        }
    },
    publish: {
        label: 'Commit or publish',
        floor: true,
        match: (name, args, ctx) => {
            if (name === 'commitAndPush') return true;
            if (name === 'runShellCommand') return SHELL_PUBLISH_RE.test(asText(args?.command));
            return PUBLISH_RE.test(name) || (String(name).startsWith('browser_') && /\b(?:publish|publicar)\b/i.test(labelText(args)));
        }
    },
    secrets: {
        label: 'Read browser sessions, cookies or credentials',
        floor: true,
        match: (name, args, ctx) => SECRET_RULES.has(ctx.rule)
    },
    send_message: {
        label: 'Message a contact (WhatsApp, Telegram, Slack)',
        match: (name) => name === 'sendMessage' || name === 'sendSlackMessage'
    },
    send_email: {
        label: 'Send an email',
        match: (name, args, ctx) => ctx.rule === 'email-send' || /send_?e?mail|messages\.send|drafts\.send/i.test(`${name} ${labelText(args)}`)
    },
    book: {
        label: 'Book an appointment or a reservation',
        match: (name, args, ctx) => /(?:^|_)book_|reserve|booking/i.test(name) || ((ctx.serverName === 'pilotfy' || ctx.serverName === 'allende') && /book|reserve|confirm/i.test(name))
    },
    home_security: {
        label: 'Locks, the alarm, garage doors, every device at once',
        match: (name, args, ctx) => ctx.rule === 'ha-critical' || ctx.rule === 'ha-bulk'
    },
    shell: {
        label: 'Any shell command',
        match: (name) => name === 'runShellCommand'
    },
    browser_submit: {
        label: 'Any consequential browser action (submit, upload, code)',
        match: (name) => /^browser_(?:click|press_key|type|fill_form|file_upload|run_code_unsafe|webmcp_call|handle_dialog|select_option)$/.test(name)
    },
    files: {
        label: 'Write files or change the code',
        match: (name) => ['writeFile', 'commitAndPush', 'pullLatestChanges', 'rollbackLastChange'].includes(name)
    },
});

const FLOOR = Object.freeze(Object.keys(CATEGORIES).filter(k => CATEGORIES[k].floor));

/** The floor as the policy route returns it. */
function floorView() {
    return FLOOR.map(id => ({ id, label: CATEGORIES[id].label, readOnly: true }));
}

/** Categories the owner may add. */
function categoryView() {
    return Object.keys(CATEGORIES).filter(id => !CATEGORIES[id].floor).map(id => ({ id, label: CATEGORIES[id].label }));
}

/**
 * One always-ask entry as stored: "category:<id>" for a known category, a
 * tool glob otherwise ("mcp_*", "runShellCommand:*curl*"). A bare category
 * id is accepted too. Floor categories are dropped: they are always on.
 */
function normalizeAlwaysAsk(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|;/);
    const out = [];
    for (const raw of list) {
        let entry = String(raw ?? '').trim().slice(0, MAX_ENTRY_CHARS);
        if (!entry || entry.startsWith('#')) continue;
        const bare = entry.replace(/^category:/i, '');
        if (Object.prototype.hasOwnProperty.call(CATEGORIES, bare)) {
            if (CATEGORIES[bare].floor) continue;
            entry = `category:${bare}`;
        } else if (/^category:/i.test(entry)) {
            continue; // unknown category
        }
        if (!out.includes(entry)) out.push(entry);
        if (out.length >= MAX_ALWAYS_ASK) break;
    }
    return out;
}

function normalizeMode(value) {
    const m = String(value ?? '').trim().toLowerCase();
    return MODES.includes(m) ? m : DEFAULT_MODE;
}

function normalizePolicyText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').slice(0, MAX_POLICY_CHARS).trim();
}

/** A tool glob over the name, or over "name:argsJson" when it holds ':'. */
function globHit(pattern, name, args) {
    try {
        const re = globToRegExp(pattern);
        if (!pattern.includes(':')) return re.test(name);
        let json;
        try { json = stableJson(args ?? {}); } catch { json = '{}'; }
        return re.test(`${name}:${json}`);
    } catch {
        return false;
    }
}

/**
 * Which always-ask entries a call hits.
 * @param {string} toolName
 * @param {object} args
 * @param {{ alwaysAsk?: string[], reason?: string, rule?: string, serverName?: string|null }} [ctx]
 * @returns {{ floor: string[], additions: string[] }} floor category ids and matching owner entries
 */
function matchAlwaysAsk(toolName, args, { alwaysAsk = [], reason = '', rule = '', serverName = null } = {}) {
    const name = String(toolName || '');
    const a = args && typeof args === 'object' ? args : {};
    const ctx = { reason, rule, serverName };
    const hit = (id) => {
        try { return !!CATEGORIES[id].match(name, a, ctx); } catch { return true; } // a crash asks
    };
    const floor = FLOOR.filter(hit);
    const additions = [];
    for (const entry of Array.isArray(alwaysAsk) ? alwaysAsk : []) {
        const m = /^category:(.+)$/i.exec(entry);
        if (m) {
            if (CATEGORIES[m[1]] && hit(m[1])) additions.push(entry);
        } else if (globHit(entry, name, a)) {
            additions.push(entry);
        }
    }
    return { floor, additions };
}

module.exports = {
    MODES, DEFAULT_MODE, MAX_POLICY_CHARS, CATEGORIES, FLOOR,
    floorView, categoryView, normalizeAlwaysAsk, normalizeMode, normalizePolicyText, matchAlwaysAsk, labelText
};
